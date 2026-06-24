import { randomUUID } from "node:crypto";
import { ensureDriver } from "./ai/index.js";
import { classifyPrompt } from "./ai/prompts.js";
import { applyRulesAndCalibration } from "./calibration.js";
import { buildContextBlock } from "./context.js";
import type { Disposition, Item, Process, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import * as executor from "./executor.js";
import { items, jobs, settings } from "./repo.js";

/**
 * 監査サンプリング判定 (§3.6-2, §4-3). auto 処分のみ N% を抽出。
 * auto に倒す全経路が同一基準でサンプルできるよう共通化し actions.ts からも再利用する。
 */
export function rollAudit(disposition: Disposition): boolean {
  return disposition === "auto" && Math.random() < settings.get().auditRate;
}

interface ClassifyOut {
  disposition: Disposition;
  confidence: number;
  reason: string;
  stakes: number;
  reversibility: number;
  kind: "node" | "leaf";
  rung: Rung;
  process: Process;
  uncertaintyResolved: boolean;
  executableReady: boolean;
  category: string;
}

const clamp01 = (n: unknown): number =>
  typeof n === "number" && isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;

/**
 * 分類器 (REQUIREMENTS §3.2). 流れ:
 *  AI が三値+確信度+スコア+カテゴリを提案
 *   → 明示ルール/基準率補正で最終決定 (§3.6-1)
 *   → 再調律スライダー(tightness)で安全側に締める (§3.6-3)
 *   → 監査サンプリング(N%)を仕込む (§3.6-2, §4-3)
 */
export async function classify(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;

  const cfg = settings.get();
  const driver = await ensureDriver();
  const job = jobs.create({
    itemId,
    role: "control",
    kindOfWork: "classify",
    sessionName: null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    output: null,
    error: null,
  });

  const res = await driver.dispatch({
    id: randomUUID(),
    role: "control",
    label: `分類: ${item.title.slice(0, 30)}`,
    prompt: classifyPrompt(item, buildContextBlock(item)),
    expectJson: true,
    timeoutMs: 90_000,
  });

  jobs.update(job.id, {
    sessionName: res.sessionName,
    status: res.ok ? "succeeded" : "failed",
    finishedAt: Date.now(),
    output: res.raw,
    error: res.error ?? null,
  });

  if (!res.ok) {
    // 分類できないときは安全側=escalate (§5 誤仕分け前提・保守デフォルト).
    return items.update(itemId, {
      status: "classified",
      disposition: "escalate",
      confidence: 0,
      reason: `自動分類に失敗(${res.error ?? "unknown"})→安全側にエスカレート`,
      category: "unclassified",
    });
  }

  const out = normalize(res.data as Partial<ClassifyOut>);

  // 明示ルール → 基準率補正
  const ruled = applyRulesAndCalibration(out.category, out.disposition);
  let disposition = ruled.disposition;
  let reason = ruled.note ? `${out.reason}（${ruled.note}）` : out.reason;

  // 再調律スライダー: 締めるのは速く (§3.6-3). auto に倒すバーを tightness で上げる。
  if (disposition === "auto") {
    const requiredConf = 0.5 + 0.4 * cfg.escalationTightness; // 0.5..0.9
    const highStakesIrreversible = out.stakes > 0.7 && out.reversibility < 0.5;
    if (out.confidence < requiredConf || highStakesIrreversible) {
      disposition = "escalate";
      reason = `${reason}（tightnessにより自動を保留）`;
    }
  }

  // リーフ実行可能性ゲート: 受け入れ基準が曖昧なまま自動実行すると外す (§2.2).
  // 詳細不足の leaf は自動着火させず「要詳細化」でキューに残す (締めるのは速く §3.6-3)。
  if (out.kind === "leaf" && !out.executableReady && disposition === "auto") {
    disposition = "escalate";
    reason = `${reason}（要詳細化: 受け入れ基準が曖昧。分解か詳細追記を）`;
  }

  // 監査サンプリング: 自動処理分の N% を、見分けのつかない形でキューへ (§4-3).
  const auditSampled = rollAudit(disposition);

  const updated = items.update(itemId, {
    status: "classified",
    disposition,
    confidence: out.confidence,
    reason,
    stakes: out.stakes,
    reversibility: out.reversibility,
    kind: out.kind,
    rung: out.rung,
    process: out.process,
    uncertaintyResolved: out.uncertaintyResolved,
    category: out.category,
    auditSampled,
  });

  // 即時着火 (§0「回し」, routes.ts のキューopen掃き出しに次ぐ副次トリガ).
  // 新たに分類された auto leaf を /api/state ポーリングを待たず発火させる。
  // 掃き出しとの二重着火は requestExecution 冒頭の executionStatus ガードが吸収するため調整不要。
  if (updated && updated.disposition === "auto" && updated.kind === "leaf") {
    void executor.requestExecution(updated.id).catch(() => {});
  }

  return updated;
}

function normalize(d: Partial<ClassifyOut>): ClassifyOut {
  const disp: Disposition =
    d.disposition === "auto" || d.disposition === "human" ? d.disposition : "escalate";
  const rung: Rung = RUNGS.includes(d.rung as Rung) ? (d.rung as Rung) : "tactic";
  return {
    disposition: disp,
    confidence: clamp01(d.confidence),
    reason: typeof d.reason === "string" && d.reason ? d.reason : "(理由なし)",
    stakes: clamp01(d.stakes),
    reversibility: clamp01(d.reversibility),
    kind: d.kind === "leaf" ? "leaf" : "node",
    rung,
    process: d.process === "waterfall" ? "waterfall" : "iterative",
    uncertaintyResolved: Boolean(d.uncertaintyResolved),
    // 未指定は安全側=ready扱い(既存のauto動線を壊さない)。明示falseのときだけゲートする。
    executableReady: d.executableReady !== false,
    category: typeof d.category === "string" && d.category ? d.category.trim() : "uncategorized",
  };
}
