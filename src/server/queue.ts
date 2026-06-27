import type { Disposition, Item, LabelAction } from "./domain.js";
import { items, labels } from "./repo.js";

// あなたの「今日なに見る?」ビュー (REQUIREMENTS §4). 火の海ではなく
// エスカレーションだけの短いキュー。自動分は畳む。ただし監査サンプルは
// 見分けのつかない形で混ぜる (§4-3)。止まった項目(実行失敗/保留)の再浮上を最優先。

export type TopReason = "期日" | "高ステークス" | "優先度" | "確信度低" | null;

export interface QueueItem extends Item {
  isAudit: boolean;
  topReason: TopReason;
  // 寄生表示の薄い区画判定。'in_progress'=「あなたが着手中」レーン、'queue'=通常キュー。
  lane: "queue" | "in_progress";
  // キュー一行理由 (blocked語義の種別判別を含む)。
  surfaceReason: string;
  // stale 検知 (in_progress のみ非null・STALE_DAYS 以上の粗い経年)。
  staleDays: number | null;
  // proposed/classified の滞留経過 (日数)。
  ageDays: number | null;
  // 直近1手の逆適用情報 (処分=ラベルの Undo)。無ければ null。UI はこの有無だけ見て
  // インライン『取り消し』を出す (逆適用の整合性はサーバ責務)。
  undoableLabel: {
    action: LabelAction;
    fromDisposition: Disposition | null;
    toDisposition: Disposition | null;
  } | null;
}

// Undo で戻せる(逆適用が定義されている)アクションだけを undoableLabel として出す。
const UNDOABLE: ReadonlySet<LabelAction> = new Set<LabelAction>([
  "do",
  "reject",
  "reclassify",
  "override",
  "mute_category",
]);

const PRIO: Record<string, number> = { urgent: 1.5, high: 0.9, normal: 0, low: -0.4 };
// 手動 orderIndex を「弱く」混ぜるための係数 (DECISIONS: 手動並びは弱いタイブレーク)。
// 大きいと期日/ステークスを手動並びが上書きして横断キューの主役性が崩れるので小さく保つ。
const ORDER_COEF = 0.02;
const STALE_DAYS = 3;
// 引き取り待ちを最優先固定する日数。これを超えると handoffC を逓減させ前面固定を解く (§3.5/§4)。
const HANDOFF_FRESH_DAYS = 3;
const DAY_MS = 86_400_000;

function dueBoost(x: Item): number {
  if (x.dueDate == null) return 0;
  const days = (x.dueDate - Date.now()) / DAY_MS;
  if (days < 0) return 1.2; // 期限超過
  if (days < 2) return 0.6; // 間近
  if (days < 7) return 0.2;
  return 0;
}

/**
 * 並びの一本化: キューと案件flowビューが共有できる純関数。寄与の内訳から最大寄与カテゴリを
 * topReason(期日/高ステークス/優先度/確信度低)として一語で返す。手動 orderIndex は弱係数で
 * 混入(タイブレーク)で、表示理由(topReason)には出さない。
 */
export function scoreItem(x: Item): { score: number; topReason: TopReason } {
  const stakesC = x.stakes ?? 0.5;
  const confC = 1 - (x.confidence ?? 0.5);
  const prioC = PRIO[x.priority] ?? 0;
  const dueC = dueBoost(x);
  const orderC = -x.orderIndex * ORDER_COEF;
  // 引き取り待ち(実行完了・人間の受領/採用が必要)は前面に出す (§3.5)。止まった項目と同格で浮上。
  // ただし永久最優先固定で『短いキュー』を埋めないよう、滞留が HANDOFF_FRESH_DAYS を超えたら寄与を
  // 逓減させ天井を設ける(古い handoff を黙って消すのではなく前面固定だけ解く §4 アテンション配給)。
  const handoffC =
    x.executionStatus === "awaiting_handoff"
      ? Math.max(
          0.2,
          1.0 - 0.2 * Math.max(0, (Date.now() - x.updatedAt) / DAY_MS - HANDOFF_FRESH_DAYS),
        )
      : 0;
  // auto-done general を僅かに前出し: 監査サンプル抽出が summary を glance しやすいよう
  // 取消ハンドルを上位に寄せる (Batch2 サンプラ優先抽出の土台。topReason には出さない)。
  const auditGlanceC =
    x.domain === "general" &&
    x.autoExecuted &&
    x.executionStatus === "succeeded" &&
    x.auditSampled
      ? 0.3
      : 0;
  const score = stakesC + confC + prioC + dueC + orderC + auditGlanceC + handoffC;

  // 最大寄与カテゴリを決定論で選ぶ(添字アクセスを避け reduce で max を取る)。
  const contribs: { label: Exclude<TopReason, null>; value: number }[] = [
    { label: "期日", value: dueC },
    { label: "高ステークス", value: stakesC },
    { label: "優先度", value: prioC },
    { label: "確信度低", value: confC },
  ];
  let best = contribs[0]!;
  for (const c of contribs) if (c.value > best.value) best = c;
  const topReason: TopReason = best.value > 0.0001 ? best.label : null;
  return { score, topReason };
}

/** キュー一行理由。blocked が「実行失敗」か「人手保留」かを見分けられるようにする。 */
function surfaceReasonOf(it: Item, ageDays: number | null): string {
  let base: string;
  if (it.executionStatus === "awaiting_handoff") {
    // 引き取り待ち: なぜ handoff かで文言を出し分ける (handoffRequired の3条件に対応)。
    // winnow は CI を見ない/採用(マージ)を実行しないので『即マージ』は促さず『確認のうえ採用は外で』に倒す。
    const hasArt = !!(it.artifacts && it.artifacts.trim() && it.artifacts.trim() !== "[]");
    if (hasArt) {
      base = "引き取り待ち: PR/成果物を作成済み。CI等を確認してから採用(マージ等)はあなたが外で行ってください";
    } else if (it.declaredReversible === false) {
      base = "引き取り待ち: 不可逆な操作の可能性。実行結果を確認のうえ受領してください";
    } else {
      base = "引き取り待ち: 高ステークスの実行結果を確認のうえ受領してください";
    }
  } else if (it.executionStatus === "failed") {
    const trace = (it.executionResult ?? "").trim().slice(0, 60);
    base = `実行失敗(再実行/エスカレ/却下)${trace ? `（${trace}）` : ""}`;
  } else if (it.status === "blocked") {
    base = `保留中${it.reason ? `: ${it.reason}` : ""}`;
  } else if (it.executionStatus === "proposed") {
    base = (it.executionResult ?? "").trim() || "承認待ち";
  } else {
    base = it.reason ?? "";
  }
  // 滞留経過: proposed は「承認待ち」、classified(escalate/human) は「滞留」として
  // 2日以上で末尾に付す。
  if (ageDays != null && ageDays >= 2) {
    if (it.executionStatus === "proposed") base += `（${ageDays}日承認待ち）`;
    else if (it.executionStatus === "awaiting_handoff") base += `（${ageDays}日引き取り待ち）`;
    else if (it.status === "classified") base += `（${ageDays}日滞留）`;
  }
  return base;
}

export function queue(): QueueItem[] {
  const all = items.all();
  const visible = all.filter((it) => {
    // 1) cancelled は常に再浮上させない(cancelExecution は status='rejected' にもするが
    //    executionStatus でも二重に保険)。
    if (it.executionStatus === "cancelled") return false;
    // 1.5) 【最優先】引き取り待ち(実行完了・人間の受領/採用が必要)は必ず前面に出す (§3.5)。
    //      status='review' なので下の classified/done フィルタには拾われない。明示で出す。
    if (it.executionStatus === "awaiting_handoff") return true;
    // 2) 自動実行が成功した分は §4-4「安く取り消せる」取消ハンドルとしてキューに残す。
    if (it.autoExecuted && it.executionStatus === "succeeded") return true;
    // 3) 【最優先】止まった項目の再浮上: 実行失敗・人手保留は必ず出す(cancelled は 1) で除外済み)。
    if (it.executionStatus === "failed") return true;
    if (it.status === "blocked") return true;
    // 4) done/rejected を畳む(3) の後なので失敗/blocked が優先)。
    if (it.status === "done" || it.status === "rejected") return false;
    // 5) 提案待ち(不可逆実行のワンタップ承認)は必ず出す。
    if (it.executionStatus === "proposed") return true;
    // 6) 【寄生表示】人手で着手中(doIt)はキュー内『着手中』レーンに薄く出す。判別子は
    //    executionStatus==='none'(=AIが一度も触っていない=人間が引き取った)。disposition で
    //    縛ると escalate を「自分でやる」した項目が human にならず消える穴があったため修正。
    //    AI実行中(running)は溢れさせない/AI失敗(failed)は step3 で別途再浮上させる(ここでは扱わない)。
    if (it.status === "in_progress" && it.executionStatus === "none") return true;
    if (it.status !== "classified") return false;
    // 7) エスカレーション/人間案件は常に出す(main の挙動=現状維持)。tightness が締めた
    //    escalate も含まれ監査される。背骨『締めは速く緩めは慎重』に従い、人間が一度も見ていない
    //    attention 要求を黙って引っ込める defer-until(緩め操作)は導入しない。
    if (it.disposition === "escalate" || it.disposition === "human") return true;
    // 自動だが監査サンプルされたものは「見分けつかない形」で混ぜる (§4-3)。
    if (it.disposition === "auto" && it.auditSampled) return true;
    return false;
  });

  // 並び: scoreItem に一本化。score 降順。
  visible.sort((a, b) => scoreItem(b).score - scoreItem(a).score);

  // 寄生表示(着手中レーン)はソート後に末尾へ回す: 通常キューを先頭、in_progress を末尾。
  const laneOf = (it: Item): "queue" | "in_progress" =>
    it.status === "in_progress" && it.executionStatus === "none" ? "in_progress" : "queue";
  visible.sort((a, b) => {
    const la = laneOf(a) === "in_progress" ? 1 : 0;
    const lb = laneOf(b) === "in_progress" ? 1 : 0;
    return la - lb;
  });

  return visible.map((it) => {
    const lane = laneOf(it);
    // 滞留経過 ageDays: proposed と classified(escalate/human) のみ。
    const ageDays =
      it.executionStatus === "proposed" ||
      it.executionStatus === "awaiting_handoff" ||
      (it.status === "classified" && (it.disposition === "escalate" || it.disposition === "human"))
        ? Math.floor((Date.now() - it.updatedAt) / DAY_MS)
        : null;
    // stale 検知: in_progress のみ。STALE_DAYS 以上で非null(専用 startedAt 列なし)。
    const inProgressAge =
      it.status === "in_progress" ? Math.floor((Date.now() - it.updatedAt) / DAY_MS) : null;
    const staleDays = inProgressAge != null && inProgressAge >= STALE_DAYS ? inProgressAge : null;
    const last = labels.lastForItem(it.id);
    const undoableLabel =
      last && UNDOABLE.has(last.action)
        ? {
            action: last.action,
            fromDisposition: last.fromDisposition,
            toDisposition: last.toDisposition,
          }
        : null;
    return {
      ...it,
      isAudit: (it.disposition === "auto" || it.rawDisposition === "auto") && it.auditSampled,
      topReason: scoreItem(it).topReason,
      lane,
      surfaceReason: surfaceReasonOf(it, ageDays),
      staleDays,
      ageDays,
      undoableLabel,
    };
  });
}

/** 自動で畳まれた(キューに出ない)アイテム数。コールドスタート期待値管理に使う。 */
export function autoFoldedCount(): number {
  return items
    .all()
    .filter((it) => it.disposition === "auto" && !it.auditSampled && it.status === "classified")
    .length;
}
