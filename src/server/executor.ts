import { randomUUID } from "node:crypto";
import { ensureDriver } from "./ai/index.js";
import { executePrompt } from "./ai/prompts.js";
import type { Item } from "./domain.js";
import { items, jobs } from "./repo.js";

// 実行とトリガー (REQUIREMENTS §3.4). 自動実行は可逆性で段を分ける:
//  可逆な実行 → 自動着火 / 不可逆・高ステークス → 提案して人間ワンタップ承認。
// 自動は全部、安く取り消せる＆痕跡が残る (§4-4)。

const REVERSIBLE_THRESHOLD = 0.6;

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
  });

  const res = await driver.dispatch({
    id: randomUUID(),
    role: "worker",
    label: `実行: ${item.title.slice(0, 30)}`,
    prompt: executePrompt(item),
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
