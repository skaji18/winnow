import { randomUUID } from "node:crypto";
import { ensureDriver } from "./ai/index.js";
import { classifyPrompt } from "./ai/prompts.js";
import { applyRulesAndCalibration, calibrateRequiredConf } from "./calibration.js";
import { buildContextBlock } from "./context.js";
import { extractLearning } from "./learning.js";
import type { Disposition, Item, Process, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import * as executor from "./executor.js";
import { categories, items, jobs, rules, settings } from "./repo.js";
import { isProvisionalTitle, normalizeCategory } from "./text.js";
import { classifyJobError } from "./errors.js";

// 締めた escalate(rawDisposition=auto なのに tightness で escalate に倒した)に混ぜる監査の割合。
// 通常 auto より低率で、緩めた境界の検証を継続するための簿記。
const TIGHTENED_AUDIT_FRACTION = 0.5;

/**
 * 監査サンプリング判定 (§3.6-2, §4-3). auto 処分のみ N% を抽出。
 * auto に倒す全経路が同一基準でサンプルできるよう共通化し actions.ts からも再利用する。
 *
 * 拡張 (Batch2): tightness が締めた escalate(rawDisposition==='auto' かつ最終 escalate)にも
 * 小率で監査を混ぜ、緩めた境界を継続監視する。learned auto rule カテゴリは
 * max(auditRate, learnedAuditFloor)、tip 直後 probation 期間中は tipProbationRate を採る。
 * 既存呼び出し(rollAudit('auto'))は opts 省略で従来挙動。
 */
export function rollAudit(
  disposition: Disposition,
  opts: { category?: string | null; rawDisposition?: Disposition | null } = {},
): boolean {
  const cfg = settings.get();
  // カテゴリの learned auto rule 有無と tip probation で監査率を決める。
  let rate = cfg.auditRate;
  if (opts.category) {
    const rule = rules.forCategory(opts.category);
    if (rule && rule.source === "learned" && rule.forcedDisposition === "auto") {
      const inProbation = Date.now() - rule.createdAt < cfg.tipProbationMs;
      rate = inProbation
        ? Math.max(rate, cfg.tipProbationRate)
        : Math.max(rate, cfg.learnedAuditFloor);
    }
  }
  if (disposition === "auto") {
    return Math.random() < rate;
  }
  // tightness が締めた escalate: 生提案 auto だったものを小率で監査に混ぜる。
  if (disposition === "escalate" && opts.rawDisposition === "auto") {
    return Math.random() < rate * TIGHTENED_AUDIT_FRACTION;
  }
  return false;
}

interface ClassifyOut {
  title: string;
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
  // 任意: AI が分類中に気づいた再利用可能な学び (memory AIゾーンへ自動蓄積)。tighten-only。
  learning?: string;
}

const clamp01 = (n: unknown): number =>
  typeof n === "number" && isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;

// classify() の共有 in-flight ガード。capture 起点(capture.ts)と /api/state の sweep
// (routes.ts)の双方がこの同一 Set を通るため、継ぎ目での二重発火を確実に防ぐ。
const inFlight = new Set<string>();

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

  // 共有 in-flight ガード: 既に classify 中なら現状を返して二重発火を防ぐ(capture×sweep の継ぎ目)。
  if (inFlight.has(itemId)) return items.get(itemId);
  inFlight.add(itemId);
  try {
    return await classifyInner(itemId, item);
  } finally {
    inFlight.delete(itemId);
  }
}

async function classifyInner(itemId: string, item: Item): Promise<Item | null> {
  const cfg = settings.get();

  // ensureDriver/dispatch が throw する経路(driver 初期化失敗・preflight NG 等)を受け、
  // 通常の失敗パスと同形に倒して inbox から外す(無限再試行を止める)。
  let res: Awaited<ReturnType<Awaited<ReturnType<typeof ensureDriver>>["dispatch"]>>;
  let job: ReturnType<typeof jobs.create> | null = null;
  try {
    const driver = await ensureDriver();
    job = jobs.create({
      itemId,
      role: "control",
      kindOfWork: "classify",
      sessionName: null,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      output: null,
      error: null,
      ipcId: null,
    });

    res = await driver.dispatch({
      id: randomUUID(),
      role: "control",
      label: `分類: ${item.title.slice(0, 30)}`,
      prompt: classifyPrompt(item, buildContextBlock(item), categories.knownWithRecency()),
      expectJson: true,
      timeoutMs: cfg.classifyTimeoutMs || 90_000,
    });
  } catch (e) {
    // 環境不全由来の throw。job が立っていれば failed に閉じ、item を envEscalated で classified へ。
    if (job) {
      jobs.update(job.id, {
        status: "failed",
        finishedAt: Date.now(),
        error: classifyJobError(String(e)),
      });
    }
    return items.update(itemId, {
      status: "classified",
      disposition: "escalate",
      confidence: 0,
      reason: `[env] 分類起動失敗: ${e}`,
      category: "unclassified",
      rawDisposition: null,
      rawConfidence: 0,
      envEscalated: true,
    });
  }

  jobs.update(job.id, {
    sessionName: res.sessionName,
    status: res.ok ? "succeeded" : "failed",
    finishedAt: Date.now(),
    output: res.raw,
    // クォータ/レート起因の失敗は "quota: ..." 接頭辞付けで種別を残す(/healthz・デバッグ用)。
    error: classifyJobError(res.error),
  });

  if (!res.ok) {
    // 分類できないときは安全側=escalate (§5 誤仕分け前提・保守デフォルト).
    // 環境不全由来 (acquire timeout/タイムアウト/JSON解析失敗/dispatch不可) を判別できるよう
    // envEscalated=1 を立て、reason に痕跡を残す。raw* は生提案が無いので null/0(較正母数に積まない)。
    return items.update(itemId, {
      status: "classified",
      disposition: "escalate",
      confidence: 0,
      reason: `[env] 環境不全由来: 自動分類に失敗(${res.error ?? "unknown"})→安全側にエスカレート`,
      category: "unclassified",
      rawDisposition: null,
      rawConfidence: 0,
      envEscalated: true,
    });
  }

  const out = normalize(res.data as Partial<ClassifyOut>);

  // 較正母数汚染除去の本質: 生提案 (tightness/ゲート前の AI 出力) を raw* に確保し不変に保つ。
  // 以下のゲートは「最終ゲート」であって disposition/confidence を書き換えても raw* は触らない。
  const rawDisposition: Disposition = out.disposition;
  const rawConfidence: number = out.confidence;

  // 明示ルール → 基準率補正
  const ruled = applyRulesAndCalibration(out.category, out.disposition);
  let disposition = ruled.disposition;
  let reason = ruled.note ? `${out.reason}（${ruled.note}）` : out.reason;

  // 再調律スライダー: 締めるのは速く (§3.6-3). auto に倒すバーを tightness で上げる。
  // 【最終ゲート】ここで disposition を escalate に書き換えても raw* は不変(母数に混ぜない)。
  if (disposition === "auto") {
    // ビン較正の締め下駄: カテゴリが申告より実際に外している証拠があれば requiredConf を上げる。
    // 締め側にだけ倒す(非対称)。緩める方向には決して使わない。
    const calibBump = calibrateRequiredConf(out.category) ?? 0;
    const requiredConf = Math.min(0.98, 0.5 + 0.4 * cfg.escalationTightness + calibBump); // 0.5..0.98
    const highStakesIrreversible = out.stakes > 0.7 && out.reversibility < 0.5;
    if (out.confidence < requiredConf || highStakesIrreversible) {
      disposition = "escalate";
      reason = `${reason}（tightnessにより自動を保留）`;
    }
  }

  // リーフ実行可能性ゲート: 受け入れ基準が曖昧なまま自動実行すると外す (§2.2).
  // 詳細不足の leaf は自動着火させず「要詳細化」でキューに残す (締めるのは速く §3.6-3)。
  // 【最終ゲート】これも raw* を変えない。
  if (out.kind === "leaf" && !out.executableReady && disposition === "auto") {
    disposition = "escalate";
    reason = `${reason}（要詳細化: 受け入れ基準が曖昧。分解か詳細追記を）`;
  }

  // 監査サンプリング: 自動処理分の N% を、見分けのつかない形でキューへ (§4-3).
  // tightness が締めた escalate(rawDisposition=auto)にも小率で混ぜ、緩めた境界を継続監視。
  const auditSampled = rollAudit(disposition, { category: out.category, rawDisposition });

  // 「雑に貼る」入口: 登録時タイトルが本文先頭の機械切り出し(暫定)なら、AI要約見出しで
  // 上書きする。これは同一 dispatch のJSONに相乗りしており追加往復ゼロ (§6)。
  // 暫定でない(=ユーザが書いた一行タスク/明示タイトル)なら尊重して触らない。
  const titlePatch =
    out.title && isProvisionalTitle(item.title, item.body) ? { title: out.title } : {};

  const updated = items.update(itemId, {
    ...titlePatch,
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
    rawDisposition,
    rawConfidence,
    envEscalated: false,
  });

  // 学びの自動蓄積 (memory AIゾーン)。tighten-only=item は書き換えない・較正母数に積まない。
  if (updated) extractLearning(updated, out.learning);

  // 即時着火 (§0「回し」, routes.ts のキューopen掃き出しに次ぐ副次トリガ).
  // 新たに分類された auto leaf を /api/state ポーリングを待たず発火させる。
  // 掃き出しとの二重着火は requestExecution 冒頭の executionStatus ガードが吸収するため調整不要。
  if (updated && updated.disposition === "auto" && updated.kind === "leaf") {
    // 握り潰さずログだけは残す(背骨: エラーを黙って捨てない)。
    void executor
      .requestExecution(updated.id)
      .catch((e) => console.error("[winnow] auto-ignite after classify failed:", e));
  }

  return updated;
}

function normalize(d: Partial<ClassifyOut>): ClassifyOut {
  const disp: Disposition =
    d.disposition === "auto" || d.disposition === "human" ? d.disposition : "escalate";
  const rung: Rung = RUNGS.includes(d.rung as Rung) ? (d.rung as Rung) : "tactic";
  return {
    title: typeof d.title === "string" ? d.title.trim() : "",
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
    // 機械的な表記揺れを正規化(案B)。空に潰れたら uncategorized へ。書き込み口はここに
    // 一本化されているので、下流(rules/category_stats)のキーは常に正規化済みになる。
    category:
      (typeof d.category === "string" ? normalizeCategory(d.category) : "") || "uncategorized",
    learning: typeof d.learning === "string" ? d.learning : undefined,
  };
}
