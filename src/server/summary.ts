import { db } from "./db.js";
import { jobs, rules } from "./repo.js";

// ループを閉じて見せる (REQUIREMENTS §4-5). 週次で一行。訂正が複利で効いているのが
// 見えないと、人は監査税を払い続けない。
//
// 背骨: done件数/処理量メトリクスは出さない。winnow は処理量を増やす道具ではない。
// 見せるのは「自動/上げ/覆し/締緩方向/監査/自動事故/塩漬け監査/失敗」=注意の落とし所の健康指標。

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklySummary {
  auto: number;
  escalated: number;
  overridden: number;
  audited: number;
  tippedCategories: string[];
  // 先週比 (締緩のトレンドを見る)。
  autoPrev: number;
  escalatedPrev: number;
  // 方向別: 締め(escalate/human へ)/緩め(auto へ)の件数。
  tightenedCount: number;
  loosenedCount: number;
  // 自動事故の検出件数 (audit_bad)。0 なら「検出なし」を明示。
  auditBad: number;
  // 問いに戻した件数 (send_back §2.1)。auto/leaf と賭けた項目が実は問いだった逆流。
  // 着手後増=分類器の executableReady 過信 / 着手前増=人間が分類器を信頼していない or 早すぎる着火。
  sentBack: number;
  // 塩漬け監査: 監査サンプルされたのに未消化のまま長期滞留している件数 (払っていない監査税)。
  stale: number;
  // 環境不全由来 escalate + 失敗ジョブ件数。
  failed: number;
  // 要棚卸し: updatedAt 14日以上前 × in_progress/blocked、または子なし node(放置された問い)。
  needsReview: number;
  // 引き取り待ち (§3.5): 実行完了・人間の受領/採用待ちの現在件数 (放置PR等の可視化)。
  awaitingHandoff: number;
  line: string;
}

export function weekly(): WeeklySummary {
  const now = Date.now();
  const since = now - WEEK_MS;
  const prevSince = since - WEEK_MS;

  const count = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { c: number }).c;

  // --- auto 件数: イベント基準 (ExecutionJob.finishedAt の成功 execute) ---
  // updatedAt スナップショットは再分類等で動くので、実際に自動実行が完走したイベントを数える。
  // 後方互換: ジョブ基準が 0(古いDB/未実行)でも極端に減らないよう、件数が出ない場合のみ
  // disposition+updatedAt を補助に使う。
  const autoJobs = jobs.succeededExecuteItemsSince(since);
  const autoSnapshot = count(
    "SELECT COUNT(*) AS c FROM items WHERE disposition='auto' AND updatedAt>=?",
    since,
  );
  const auto = autoJobs > 0 ? autoJobs : autoSnapshot;
  // 先週窓 [prevSince, since) を直接 DISTINCT で数える(包含窓の差分だと両窓に跨る itemId が
  // 相殺され過小になる罠を回避)。escalatedPrev と同じ直接窓方式に揃える。
  const autoPrevAdj = jobs.succeededExecuteItemsBetween(prevSince, since);

  // --- escalate 件数: classifier は分類時に LabelEvent を出さないので、件数は
  // items の disposition='escalate' AND classified を当面維持 (イベント基準は方向別で取る)。
  const escalated = count(
    "SELECT COUNT(*) AS c FROM items WHERE disposition='escalate' AND updatedAt>=?",
    since,
  );
  const escalatedPrev = count(
    "SELECT COUNT(*) AS c FROM items WHERE disposition='escalate' AND updatedAt>=? AND updatedAt<?",
    prevSince,
    since,
  );

  // escalate_category は旧来 action='override'(toDisposition=escalate) で記録していた経緯があり、
  // 専用 action へ分離後もメトリクスを不変に保つため override と同列に算入する。
  const overridden = count(
    "SELECT COUNT(*) AS c FROM label_events WHERE action IN ('override','escalate_category') AND createdAt>=?",
    since,
  );
  const audited = count(
    "SELECT COUNT(*) AS c FROM label_events WHERE action IN ('audit_ok','audit_bad') AND createdAt>=?",
    since,
  );
  const auditBad = count(
    "SELECT COUNT(*) AS c FROM label_events WHERE action='audit_bad' AND createdAt>=?",
    since,
  );
  // 問いに戻した件数 (leaf→node 降格。kind誤りの是正)。tightened とは別建てで濁らせない。
  const sentBack = count(
    "SELECT COUNT(*) AS c FROM label_events WHERE action='send_back' AND createdAt>=?",
    since,
  );

  // --- 方向別 締め/緩め (Rule.forcedDisposition + LabelEvent の to で振分) ---
  const learnedSince = rules
    .all()
    .filter((r) => r.source === "learned" && r.active && r.createdAt >= since);
  const tippedCategories = learnedSince.map((r) => `${r.category}→${r.forcedDisposition}`);
  let tightenedCount = learnedSince.filter((r) => r.forcedDisposition !== "auto").length;
  let loosenedCount = learnedSince.filter((r) => r.forcedDisposition === "auto").length;
  // LabelEvent の override/reclassify/escalate_category を to で締め(escalate/human)/緩め(auto)に積む。
  // escalate_category は分離前 override として締めに算入されていたため同列に維持(メトリクス不変)。
  tightenedCount += count(
    "SELECT COUNT(*) AS c FROM label_events WHERE action IN ('override','reclassify','escalate_category') AND toDisposition IN ('escalate','human') AND createdAt>=?",
    since,
  );
  loosenedCount += count(
    "SELECT COUNT(*) AS c FROM label_events WHERE action IN ('override','reclassify') AND toDisposition='auto' AND createdAt>=?",
    since,
  );

  // --- 塩漬け監査: 監査サンプルされた auto が classified のまま long-tail に滞留 (未消化の監査税)。
  const stale = count(
    "SELECT COUNT(*) AS c FROM items WHERE disposition='auto' AND auditSampled=1 AND status='classified' AND createdAt < ?",
    since,
  );

  // --- 失敗: classify/execute の失敗ジョブ + 環境不全由来 escalate (DISTINCT で別建て集計) ---
  const failedJobs = jobs.failedSince(since);
  const envEsc = count(
    "SELECT COUNT(*) AS c FROM items WHERE envEscalated=1 AND updatedAt>=?",
    since,
  );
  const failed = failedJobs + envEsc;

  // --- 要棚卸し (GTD 棚卸し): updatedAt 14日以上前 × in_progress/blocked、または
  // 子なし node(放置された問い)。決定論カウント。子なし node の NOT IN サブクエリは
  // NULL 混入で全件 false になる SQLite の罠を避けるため parentId IS NOT NULL で絞る。
  const reviewCutoff = now - 14 * 24 * 60 * 60 * 1000;
  const needsReview = count(
    `SELECT COUNT(*) AS c FROM items
       WHERE (updatedAt < ? AND status IN ('in_progress','blocked'))
          OR (kind='node' AND id NOT IN (SELECT parentId FROM items WHERE parentId IS NOT NULL))`,
    reviewCutoff,
  );

  // --- 引き取り待ち: 実行完了・人間の受領/採用待ちの現在件数 (§3.5 ループ可視化)。
  // status='review' なので塩漬け監査(classified)・要棚卸し(in_progress/blocked)のどちらにも乗らない。
  const awaitingHandoff = count(
    "SELECT COUNT(*) AS c FROM items WHERE executionStatus='awaiting_handoff'",
  );

  const tip = tippedCategories.length > 0 ? ` / 自動較正: ${tippedCategories.join(", ")}` : "";
  const delta = (() => {
    const d = auto - autoPrevAdj;
    if (d === 0) return "±0";
    return d > 0 ? `+${d}` : `${d}`;
  })();
  const accident = auditBad > 0 ? `事故${auditBad}` : "事故0(今週は自動事故の検出なし)";
  const review = needsReview > 0 ? ` / 要棚卸し${needsReview}件` : "";
  const handoff = awaitingHandoff > 0 ? ` / 引き取り待ち${awaitingHandoff}件` : "";
  const sent = sentBack > 0 ? ` / 送り返し${sentBack}件` : "";
  const line =
    `今週: 自動${auto}(先週比${delta}) / 上げ${escalated} / 覆し${overridden} / ` +
    `締め${tightenedCount}・緩め${loosenedCount} / 監査${audited} / ${accident} / ` +
    `塩漬け${stale} / 失敗${failed}${review}${handoff}${sent}${tip}`;

  return {
    auto,
    escalated,
    overridden,
    audited,
    tippedCategories,
    autoPrev: autoPrevAdj,
    escalatedPrev,
    tightenedCount,
    loosenedCount,
    auditBad,
    sentBack,
    stale,
    failed,
    needsReview,
    awaitingHandoff,
    line,
  };
}
