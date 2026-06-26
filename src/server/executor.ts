import { randomUUID } from "node:crypto";
import { ensureDriver } from "./ai/index.js";
import { executePrompt } from "./ai/prompts.js";
import { buildContextBlock } from "./context.js";
import type { Item } from "./domain.js";
import { items, jobs } from "./repo.js";

// 実行とトリガー (REQUIREMENTS §3.4). 自動実行は可逆性で段を分ける:
//  可逆な実行 → 自動着火 / 不可逆・高ステークス → 提案して人間ワンタップ承認。
// 自動は全部、安く取り消せる＆痕跡が残る (§4-4)。

const REVERSIBLE_THRESHOLD = 0.6;

/**
 * cross-repo 協調ガード (§3.6-3 締めるのは速く / §2.2). 同一案件で projectDir の異なる
 * leaf が他にも auto/実行中で並んでいるなら、repoをまたぐアトミック変更の暴発(契約の
 * 受け渡し不整合・順序破綻)を疑い、自動着火を止めて人間のワンタップ承認に回す。
 * cross-repo性はテキストから構造的に観測できない (§3.2) ので、推論ではなく
 * 「同一案件×異projectDir×auto/実行中」という決定論的な代理シグナルで安全側に倒す。
 * 独立な多repoタスクも巻き込みうるが、過剰エスカレーションは安く速く可逆 (§3.6-3) なので
 * その側に倒す。承認(approveExecution)はこのガードを通らず実行できる=ワンタップの逃げ道。
 */
function crossRepoSiblingPending(item: Item): boolean {
  if (!item.projectId || !item.projectDir) return false;
  return items.all().some(
    (o) =>
      o.id !== item.id &&
      o.projectId === item.projectId &&
      o.kind === "leaf" &&
      o.projectDir != null &&
      o.projectDir !== item.projectDir &&
      // まだ片付いていない auto/実行中の兄弟だけを対象に。完了/取消済みは外す
      // (古い成功が延々とガードを引かないように)。proposed(auto)同士は互いに
      // マッチし続けるので、同時バーストは両方そろって承認待ちに倒れ対称性が保たれる。
      o.executionStatus !== "succeeded" &&
      o.executionStatus !== "cancelled" &&
      (o.disposition === "auto" ||
        o.executionStatus === "running" ||
        o.executionStatus === "queued"),
  );
}

interface ExecuteOut {
  status: "succeeded" | "failed" | "needs_human";
  summary: string;
  output: string;
  reviewTask?: string;
}

/** リーフをどう実行するか決める。可逆なら着火、不可逆/高ステークスなら提案止まり。 */
export async function requestExecution(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  // 二重着火ガード: classify 時の経路とキューopenの掃き出しが同一itemに発火するのを防ぐ。
  // executionStatus は "none" 既定で null にならない (db.ts DEFAULT 'none')。
  // failed のみ再試行を許し、running/proposed/succeeded/approved/cancelled は早期return。
  if (item.executionStatus && item.executionStatus !== "none" && item.executionStatus !== "failed") return item;
  if (item.kind !== "leaf") {
    return items.update(itemId, {
      executionResult: "ノードは直接実行できません。先に分解してください。",
    });
  }

  const reversible = (item.reversibility ?? 0) >= REVERSIBLE_THRESHOLD;
  const highStakes = (item.stakes ?? 0) > 0.7;

  if (!reversible || highStakes) {
    // 不可逆/高ステークス: 提案して人間のワンタップ承認待ち (§3.4)。
    return items.update(itemId, {
      executionStatus: "proposed",
      executionResult: "不可逆/高ステークスのため、承認待ち(ワンタップで実行)。",
    });
  }
  if (crossRepoSiblingPending(item)) {
    // 同一案件で複数repoの自動実行が並んでいる: 横断変更の暴発を防ぎ承認待ちに回す。
    return items.update(itemId, {
      executionStatus: "proposed",
      executionResult:
        "同一案件で複数リポジトリにまたがる自動実行が並んでいます。横断変更の暴発(契約不整合・順序破綻)を防ぐため承認待ち(独立した変更なら、そのままワンタップで実行)。",
    });
  }
  // 可逆: 自動着火。
  return runExecution(itemId);
}

/** 実際に worker セッションへ投げて実行する。 */
export async function runExecution(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;

  items.update(itemId, { executionStatus: "running", status: "in_progress" });
  const driver = await ensureDriver();
  const job = jobs.create({
    itemId,
    role: "worker",
    kindOfWork: "execute",
    sessionName: null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    output: null,
    error: null,
    // Batch3 が dispatch の req.id を相関IDとして渡す。本バッチは後方互換の null。
    ipcId: null,
  });

  const res = await driver.dispatch({
    id: randomUUID(),
    role: "worker",
    label: `実行: ${item.title.slice(0, 30)}`,
    prompt: executePrompt(item, buildContextBlock(item)),
    cwd: item.projectDir ?? undefined,
    expectJson: true,
    timeoutMs: 600_000,
  });

  jobs.update(job.id, {
    sessionName: res.sessionName,
    status: res.ok ? "succeeded" : "failed",
    finishedAt: Date.now(),
    output: res.raw,
    error: res.error ?? null,
  });

  if (!res.ok) {
    return items.update(itemId, {
      executionStatus: "failed",
      status: "blocked",
      executionResult: `実行失敗: ${res.error ?? "unknown"}`,
    });
  }

  const out = res.data as Partial<ExecuteOut>;
  const succeeded = out.status === "succeeded";
  const updated = items.update(itemId, {
    executionStatus: out.status === "needs_human" ? "proposed" : succeeded ? "succeeded" : "failed",
    status: succeeded ? "done" : "blocked",
    autoExecuted: true,
    executionResult: `${out.summary ?? ""}\n\n${out.output ?? ""}`.trim(),
  });

  // レビューをパイプラインに戻す (§3.5). 継ぎ目=チェックポイントが実装ポイント。
  if (out.reviewTask && out.reviewTask.trim()) {
    items.create({
      title: `レビュー: ${out.reviewTask.trim()}`,
      body: `自動実行「${item.title}」の結果レビュー。`,
      kind: "leaf",
      rung: "execution",
      parentId: item.parentId,
      domain: item.domain,
      projectDir: item.projectDir,
    });
  }
  return updated;
}

export async function approveExecution(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  if (item.executionStatus !== "proposed") return item;
  return runExecution(itemId);
}

/** 自動実行を安く取り消す (§4-4 fire-and-forgetにしない・可逆&可視)。 */
export async function cancelExecution(itemId: string): Promise<Item | null> {
  return items.update(itemId, {
    executionStatus: "cancelled",
    status: "rejected",
    executionResult: "取り消されました(痕跡は履歴に残ります)。",
  });
}
