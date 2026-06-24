import { randomUUID } from "node:crypto";
import { ensureDriver } from "./ai/index.js";
import { classifyPrompt } from "./ai/prompts.js";
import { applyRulesAndCalibration } from "./calibration.js";
import type { Disposition, Item, Process, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import { items, jobs, settings } from "./repo.js";

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
    prompt: classifyPrompt(item),
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

  // 監査サンプリング: 自動処理分の N% を、見分けのつかない形でキューへ (§4-3).
  let auditSampled = false;
  if (disposition === "auto" && Math.random() < cfg.auditRate) {
    auditSampled = true;
  }

  return items.update(itemId, {
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
    category: typeof d.category === "string" && d.category ? d.category.trim() : "uncategorized",
  };
}
