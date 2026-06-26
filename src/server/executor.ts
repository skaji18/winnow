import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDriver } from "./ai/index.js";
import { executePrompt } from "./ai/prompts.js";
import { parseJson } from "./ai/tmux-driver.js";
import { PATHS } from "./config.js";
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
  // 再浮上した failed 項目の再実行 (Batch5 のワンタップ / 起動時 reconcile が failed に倒した
  // 項目) はここを通って再着火する。
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

/**
 * ExecuteOut を解釈して item を更新し、必要ならレビュータスクを戻す共通ヘルパ。
 * runExecution の成功パスと起動時 reconcile の done sentinel 取り込みパスの両方から
 * 呼ぶ(挙動一致・重複排除)。Batch4 はこのヘルパ内に新カラム(executionSummary/
 * Output/rollbackPlan/declaredReversible/artifacts)の書き込みを足す前提。
 *
 * blocked語義整理: 失敗(out.status==='failed')は status を blocked にせず in_progress に
 * 保ち、再浮上は executionStatus==='failed' で表す(queue の visible が拾う)。
 */
function applyExecuteResult(itemId: string, out: Partial<ExecuteOut>): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  const succeeded = out.status === "succeeded";
  const updated = items.update(itemId, {
    executionStatus: out.status === "needs_human" ? "proposed" : succeeded ? "succeeded" : "failed",
    // succeeded→done。それ以外(needs_human/failed)は in_progress のまま(blocked にしない)。
    status: succeeded ? "done" : "in_progress",
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

/** 実際に worker セッションへ投げて実行する。 */
export async function runExecution(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;

  items.update(itemId, { executionStatus: "running", status: "in_progress" });
  const driver = await ensureDriver();
  // dispatch の req.id を相関IDとして先に確保し、jobs に永続化する。これで起動時
  // reconcile が done sentinel (PATHS.ipc/${ipcId}.done) と res.json を決定論で特定できる。
  const ipcId = randomUUID();
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
    ipcId,
  });

  const res = await driver.dispatch({
    id: ipcId,
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
    // blocked語義整理: 実行失敗は status を blocked にせず in_progress に保つ。
    // 可視性は queue の executionStatus==='failed' フィルタが担保する。
    return items.update(itemId, {
      executionStatus: "failed",
      status: "in_progress",
      executionResult: `実行失敗: ${res.error ?? "unknown"}`,
    });
  }

  return applyExecuteResult(itemId, res.data as Partial<ExecuteOut>);
}

/**
 * WIP/worker 天井のための in-flight 集計。DB から決定論で算出する(状態の二重持ちを
 * 避けるため runtime-state には保持しない)。routes の掃き出しループと /api/state が使う。
 *   running  = 実行中 N
 *   proposed = 承認待ち M
 */
export function inFlightCount(): { running: number; proposed: number } {
  let running = 0;
  let proposed = 0;
  for (const it of items.all()) {
    if (it.executionStatus === "running") running++;
    else if (it.executionStatus === "proposed") proposed++;
  }
  return { running, proposed };
}

/**
 * 起動時 reconcile(index.ts が db 初期化直後・listen 前に一度だけ呼ぶ)。
 * 前回プロセスで running のまま中断した execute ジョブを、jobs.ipcId 経由で done
 * sentinel を探して決定論で決着させる:
 *   - done sentinel + res.json があれば取り込み(applyExecuteResult)→ recovered++
 *   - 無い / ipcId=null / parse 失敗 → executionStatus='failed'・status='in_progress'
 *     (blocked にしない)に倒し executionResult に痕跡 → 再浮上経路(queue)が拾う → failedOver++
 * AI は一切起動しない(driver.init() を呼ばず、IPC sentinel と DB のみ参照する read-only
 * 痕跡処理)。同期(better-sqlite3 同期API + fs 同期API)。一度きり・冪等
 * (決着済み job は status を running から外すので二度と拾わない)。
 */
export function reconcileOnBoot(): { recovered: number; failedOver: number } {
  let recovered = 0;
  let failedOver = 0;
  const stranded = jobs.runningExecuteJobs();
  for (const job of stranded) {
    const item = items.get(job.itemId);
    // item が無い / 既に running 以外で決着済みなら job だけ決着させて skip。
    if (!item || item.executionStatus !== "running") {
      jobs.update(job.id, { status: "failed", finishedAt: Date.now() });
      continue;
    }

    let takenIn = false;
    if (job.ipcId) {
      const donePath = path.join(PATHS.ipc, `${job.ipcId}.done`);
      const resPath = path.join(PATHS.ipc, `${job.ipcId}.res.json`);
      if (fs.existsSync(donePath)) {
        try {
          const raw = fs.existsSync(resPath) ? fs.readFileSync(resPath, "utf8") : "";
          const out = parseJson(raw) as Partial<ExecuteOut>;
          applyExecuteResult(job.itemId, out);
          jobs.update(job.id, {
            status: out.status === "failed" ? "failed" : "succeeded",
            finishedAt: Date.now(),
            output: raw,
          });
          recovered++;
          takenIn = true;
        } catch {
          /* parse 失敗 → 下の failed フォールバックへ倒す */
        }
      }
    }

    if (!takenIn) {
      items.update(job.itemId, {
        executionStatus: "failed",
        status: "in_progress",
        executionResult:
          "前回セッション中に中断(再起動時 reconcile)。再実行/エスカレ/却下できます。",
      });
      jobs.update(job.id, { status: "failed", finishedAt: Date.now() });
      failedOver++;
    }
  }
  return { recovered, failedOver };
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
