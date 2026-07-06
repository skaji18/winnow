import { clip } from "./context.js";
import type { Disposition, Item, LabelAction } from "./domain.js";
import { items, labels, projects, settings } from "./repo.js";
import {
  buildGateSnapshot,
  deriveProposedGate,
  isEscalateTerminated,
  isNeedsHumanProposed,
  type GateDerivation,
  type GateKind,
} from "./gates.js";

// あなたの「今日なに見る?」ビュー (REQUIREMENTS §4). 火の海ではなく
// エスカレーションだけの短いキュー。自動分は畳む。ただし監査サンプルは
// 見分けのつかない形で混ぜる (§4-3)。止まった項目(実行失敗/保留)の再浮上を最優先。

export type TopReason = "期日" | "高ステークス" | "優先度" | "確信度低" | null;

export interface QueueItem extends Item {
  isAudit: boolean;
  topReason: TopReason;
  // 寄生表示の薄い区画判定。'in_progress'=「あなたが着手中」レーン、'queue'=通常キュー。
  lane: "queue" | "in_progress";
  // キュー一行理由 (blocked語義の種別判別を含む)。proposed は read 時に構造から導出した
  // live な理由 (保存 executionResult は発動時点の痕跡で、表示の真実にしない)。
  surfaceReason: string;
  // ゲート由来 proposed の read 時導出 (gates.deriveProposedGate)。null = ゲート表示なし
  // (非 proposed / needs_human 由来)。DB 列ではない計算フィールド。
  gateKind: GateKind | null;
  // 塞いでいる実体 (待ち先チップのジャンプ先)。上流未完=該当兄弟 / 親ゲート=親 / 他は null。
  blockerId: string | null;
  // needs_human 由来 proposed (worker が「人間の判断が要る」と返した承認待ち)。判別式は
  // gates.isNeedsHumanProposed の単一真実源をサーバで計算して届ける(クライアントに複製しない)。
  // UI はこれと settings.allowExternalSend で「押した先」を正直に出し分ける。
  needsHuman: boolean;
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
// actions.ts undoLastLabel と単一の真実源 (非対象 action は label を消さず no-op)。
export const UNDOABLE: ReadonlySet<LabelAction> = new Set<LabelAction>([
  "do",
  "reject",
  "send_back",
  "reclassify",
  "override",
  "mute_category",
  // receive(受領/確認して畳む)の逆適用 = receivedAt を下ろして再可視化 (§4-4)。
  "receive",
]);

const PRIO: Record<string, number> = { urgent: 1.5, high: 0.9, normal: 0, low: -0.4 };
// 手動 orderIndex を「弱く」混ぜるための係数 (DECISIONS: 手動並びは弱いタイブレーク)。
// 大きいと期日/ステークスを手動並びが上書きして横断キューの主役性が崩れるので小さく保つ。
const ORDER_COEF = 0.02;
const STALE_DAYS = 3;
// 引き取り待ちを最優先固定する日数。これを超えると handoffC を逓減させ前面固定を解く (§3.5/§4)。
const HANDOFF_FRESH_DAYS = 3;
export const DAY_MS = 86_400_000;
// 期日バケットの境界 (日数)。horizon.ts と単一の真実源にし、両者のドリフトを防ぐ。
export const DUE_SOON_DAYS = 2; // これ未満=間近
export const DUE_WEEK_DAYS = 7; // これ未満=今週

function dueBoost(x: Item): number {
  if (x.dueDate == null) return 0;
  const days = (x.dueDate - Date.now()) / DAY_MS;
  if (days < 0) return 1.2; // 期限超過
  if (days < DUE_SOON_DAYS) return 0.6; // 間近
  if (days < DUE_WEEK_DAYS) return 0.2;
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

/**
 * キュー一行理由。blocked が「実行失敗」か「人手保留」かを見分けられるようにする。
 * proposed は gate (read 時導出) があればそれを表示の真実にする — 保存 executionResult は
 * ゲート発動時点の痕跡で、上流完了後も「上流Xが未完です」と表示され続ける陳腐化があった。
 */
/** worker 語の列選択用: 先頭の非空行 (グランス可能な一行理由に切り出す)。 */
function firstLine(text: string | null | undefined): string {
  return (text ?? "").trim().split("\n")[0]?.trim() ?? "";
}

function surfaceReasonOf(it: Item, ageDays: number | null, gate: GateDerivation | null): string {
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
  } else if (it.executionStatus === "timed_out") {
    // work timeout 超過: 失敗確定ではなく「継続中かもしれない／完了すれば自動取り込み」。
    const trace = (it.executionResult ?? "").trim().slice(0, 80);
    base = `実行がタイムアウト上限を超過(継続中の可能性・完了すれば自動取り込み／待たず再実行も可)${trace ? `（${trace}）` : ""}`;
  } else if (it.executionStatus === "failed") {
    const trace = (it.executionResult ?? "").trim().slice(0, 60);
    base = `実行失敗(再実行/エスカレ/却下)${trace ? `（${trace}）` : ""}`;
  } else if (it.status === "blocked") {
    base = `保留中${it.reason ? `: ${it.reason}` : ""}`;
  } else if (it.executionStatus === "proposed") {
    // needs_human 由来 (gate==null): worker の停止理由をグランス可能に = executionSummary の
    // 先頭行を優先する(worker 語の【列選択】であり導出上書きではない)。summary 欠落時も
    // executionResult 全文を素通しせず先頭行+80字上限に丸める(一行理由が長文に埋もれる/
    // INVARIANTS「先頭行の列選択まで」の線を守る。timed_out/failed の trace 切り詰めと対称)。
    // 80字上限は clip(番兵つき・サロゲートペア非分断)で丸める(生 slice は絵文字等の
    // ペアを分断し U+FFFD 化しうる。priorPlan 切り詰めと同じ共有ヘルパ)。
    base = gate
      ? gate.reason
      : clip(firstLine(it.executionSummary) || firstLine(it.executionResult) || "承認待ち", 80, "…");
  } else if (isEscalateTerminated(it)) {
    // 承認後 needs_human の escalate 終端 (executor.applyExecuteResult の repeat 遷移。
    // 述語は gates.isEscalateTerminated が単一真実源=write 側の遷移とドリフトさせない)。
    // worker の停止理由(最新の needs_human 文面)を一行で前面に出す。この状態組には
    // 他経路(reject→undo 復帰等)でも到達しうるため、回数(「2回」)は断定しない。
    base = `AI停止(人間の対応待ち): ${clip(
      firstLine(it.executionSummary) || firstLine(it.executionResult) || "詳細は実行結果を参照",
      80,
      "…",
    )}`;
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
  // ゲート read 時導出の共有スナップショット (all を1回だけ走査。/api/state 3秒ポーリングの
  // ホットパスなので items.all()/children を per-item で呼び直さない)。
  const gateSnap = buildGateSnapshot(all);
  const pauseAuto = settings.get().pauseAuto;
  // アーカイブ案件の read 時導出畳み (docs/DECISIONS.md「案件クローズ・バッチ」)。
  // アイテムは変異させない=復元すれば自動で再浮上する。
  const archivedProjects = new Set(
    projects.all().filter((p) => p.status === "archived").map((p) => p.id),
  );
  const inArchivedProject = (it: Item): boolean =>
    it.projectId != null && archivedProjects.has(it.projectId);
  const visible = all.filter((it) => {
    // 1) cancelled は常に再浮上させない(cancelExecution は status='rejected' にもするが
    //    executionStatus でも二重に保険)。
    if (it.executionStatus === "cancelled") return false;
    // 1.2) 人間の処分(却下)が勝つ: rejected は failed/timed_out の再浮上・autoDone の
    //      取消ハンドルより先に畳む。旧実装は 3) が先に発火し「却下してもカードが消えない」
    //      デッドエンドだった。undo(さばきを戻す→classified)すれば従来どおり再浮上する。
    if (it.status === "rejected") return false;
    // 1.5) 【最優先】引き取り待ち(実行完了・人間の受領/採用が必要)は必ず前面に出す (§3.5)。
    //      status='review' なので下の classified/done フィルタには拾われない。明示で出す。
    if (it.executionStatus === "awaiting_handoff") return true;
    // 2) 自動実行が成功した分は §4-4「安く取り消せる」取消ハンドルとしてキューに残す。
    //    ただし人間が受領(確認して畳む/監査OK/handoff受領)したら畳む=成功の終端遷移。
    //    取消ハンドル自体はバックログ/ツリーから引き続き届く(可視の場所が変わるだけ)。
    if (it.autoExecuted && it.executionStatus === "succeeded" && it.receivedAt == null)
      return true;
    // 3) 【最優先】止まった項目の再浮上: 実行失敗・タイムアウト超過・人手保留は必ず出す
    //    (cancelled は 1) で除外済み)。timed_out は失敗確定ではないが、人間が待たず再実行/却下
    //    できるよう前面に出す(自動取り込みされれば succeeded 等に遷移して下の畳みに入る)。
    if (it.executionStatus === "failed") return true;
    if (it.executionStatus === "timed_out") return true;
    // 3.5) アーカイブ案件配下は畳む。ここより上の実行系終端 (awaiting_handoff/succeeded
    //      未受領/failed/timed_out) は案件の生死と無関係に出し続ける (§4-4。締めモーダルは
    //      running を stop 不可にするため archive 後に走り切る実行が必ずあり、終端を黙らせると
    //      轢き逃げになる)。ここより下の人間の注意・承認要求 (blocked/proposed/着手中レーン/
    //      escalate/human/監査混入) は、締めモーダルで未完を列挙した上での明示アーカイブで
    //      成立しなくなったとみなして畳む (黙る時限消去ではない)。
    if (inArchivedProject(it)) return false;
    if (it.status === "blocked") return true;
    // 4) done を畳む(3) の後なので失敗/blocked が優先。rejected は 1.2) で先に畳み済み)。
    if (it.status === "done") return false;
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
    // ゲート由来 proposed の live 導出 (needs_human 由来と非 proposed は null)。
    const gate = deriveProposedGate(it, gateSnap, { pauseAuto });
    return {
      ...it,
      isAudit: (it.disposition === "auto" || it.rawDisposition === "auto") && it.auditSampled,
      topReason: scoreItem(it).topReason,
      lane,
      surfaceReason: surfaceReasonOf(it, ageDays, gate),
      gateKind: gate?.kind ?? null,
      blockerId: gate?.blockerId ?? null,
      // 起源判別(isNeedsHumanProposed)を使う: 成果の実在だけだと、実行済み item がゲート経由で
      // proposed に落ちた場合まで「AI停止」と誤ラベルし、送信OFF警告も誤発火する。
      needsHuman: gate == null && isNeedsHumanProposed(it),
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
