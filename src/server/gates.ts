// 実行点火ゲートの述語・閾値・文言の単一真実源 (REQUIREMENTS §3.4/§3.6-3)。
// executor (write 時: ゲート発動の痕跡を executionResult に残す) と queue (read 時:
// 承認待ちの一行理由を「今この瞬間の構造」から導出する) の両方がここを import する。
// 依存は domain(型) と paths のみ — repo/ai/executor/queue を import しない (循環ゼロ・軽量)。
// ガードは全て決定論 (構造シグナル)。推論でゲートしない (docs/INVARIANTS.md 実行ゲート)。
//
// 【登録規律】proposed に倒す新ゲートを executor に足すときは、必ずここへ述語・GateKind・
// 文言を同時登録すること。登録漏れは read 時導出 (deriveProposedGate) が 'clear'
// (解消済み) を誤表示する。

import type { Item } from "./domain.js";
import { validateProjectDir } from "./paths.js";

export const REVERSIBLE_THRESHOLD = 0.6;
// 高ステークス閾値。requestExecution の proposed ゲートと handoffRequired (§3.5) が共有する
// (片方だけ変えると「ゲートは通るのに handoff 判定は高ステークス」の不整合が生まれる)。
export const HIGH_STAKES_THRESHOLD = 0.7;

/** 不可逆/高ステークス → 自動着火せず提案止まり (§3.4)。 */
export function isIrreversibleOrHighStakes(item: Item): boolean {
  return (
    (item.reversibility ?? 0) < REVERSIBLE_THRESHOLD ||
    (item.stakes ?? 0) > HIGH_STAKES_THRESHOLD
  );
}

// --- ゲート文言 (write 時の痕跡と read 時導出の両方が使う。ドリフト防止で定数化) ---
export const GATE_TEXT_IRREVERSIBLE = "不可逆/高ステークスのため、承認待ち(ワンタップで実行)。";
export const GATE_TEXT_PAUSE_AUTO =
  "自動実行を一時停止中です(承認待ち。再開するか、そのままワンタップで実行)。";
export const GATE_TEXT_CROSS_REPO =
  "同一案件で複数リポジトリにまたがる自動実行が並んでいます。横断変更の暴発(契約不整合・順序破綻)を防ぐため承認待ち(独立した変更なら、そのままワンタップで実行)。";
export const GATE_TEXT_CLEAR =
  "着火時のゲートは解消済みです。そのままワンタップで実行できます。";
export function gateTextBadProjectDir(reason: string): string {
  return `作業ディレクトリが不正のため実行を保留しました(${reason})。`;
}

/**
 * ゲート判定の読み取りスナップショット。requestExecution / queue() が呼び出しごとに
 * 1回だけ構築し、述語が items.all()/items.children を何度も呼び直すのを避ける
 * (/api/state は 3秒ポーリングのホットパス)。
 */
export interface GateSnapshot {
  byId: Map<string, Item>;
  childrenOf: Map<string, Item[]>; // orderIndex ASC (repo items.children と同じ並び)
  all: Item[];
  // validateProjectDir は fs realpath を含むため、同一 projectDir はスナップショット内で
  // 1回だけ検証する (値は escalate 理由。null=OK)。
  projectDirEscalates: Map<string, string | null>;
}

export function buildGateSnapshot(all: Item[]): GateSnapshot {
  const byId = new Map(all.map((i) => [i.id, i] as const));
  const childrenOf = new Map<string, Item[]>();
  for (const it of all) {
    if (!it.parentId) continue;
    const arr = childrenOf.get(it.parentId) ?? [];
    arr.push(it);
    childrenOf.set(it.parentId, arr);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.orderIndex - b.orderIndex);
  return { byId, childrenOf, all, projectDirEscalates: new Map() };
}

function projectDirEscalateReason(dir: string, snap: GateSnapshot): string | null {
  if (!snap.projectDirEscalates.has(dir)) {
    const v = validateProjectDir(dir);
    snap.projectDirEscalates.set(dir, v.escalate ? (v.reason ?? "検証失敗") : null);
  }
  return snap.projectDirEscalates.get(dir) ?? null;
}

/**
 * cross-repo 協調ガード (§3.6-3 締めるのは速く / §2.2). 同一案件で projectDir の異なる
 * leaf が他にも auto/実行中で並んでいるなら、repoをまたぐアトミック変更の暴発(契約の
 * 受け渡し不整合・順序破綻)を疑い、自動着火を止めて人間のワンタップ承認に回す。
 * cross-repo性はテキストから構造的に観測できない (§3.2) ので、推論ではなく
 * 「同一案件×異projectDir×auto/実行中」という決定論的な代理シグナルで安全側に倒す。
 * 独立な多repoタスクも巻き込みうるが、過剰エスカレーションは安く速く可逆 (§3.6-3) なので
 * その側に倒す。承認(approveExecution)はこのガードを通らず実行できる=ワンタップの逃げ道。
 */
function isCrossRepoPendingSibling(item: Item, o: Item): boolean {
  return (
    o.id !== item.id &&
    o.projectId === item.projectId &&
    o.kind === "leaf" &&
    o.projectDir != null &&
    o.projectDir !== item.projectDir &&
    // まだ片付いていない auto/実行中の兄弟だけを対象に。完了/取消済みは外す
    // (古い成功が延々とガードを引かないように)。proposed(auto)同士は互いに
    // マッチし続けるので、同時バーストは両方そろって承認待ちに倒れ対称性が保たれる。
    // awaiting_handoff は実行成功済み(人間の引き取り待ち)なので「完了側」に数え、下流を塞がない。
    o.executionStatus !== "succeeded" &&
    o.executionStatus !== "cancelled" &&
    o.executionStatus !== "awaiting_handoff" &&
    (o.disposition === "auto" || o.executionStatus === "running" || o.executionStatus === "queued")
  );
}

export function crossRepoSiblingPending(item: Item, snap: GateSnapshot): boolean {
  if (!item.projectId || !item.projectDir) return false;
  return snap.all.some((o) => isCrossRepoPendingSibling(item, o));
}

/** cross-repo ガードを引いている相手 (待ち先チップ用)。無ければ null。 */
function crossRepoBlockerOf(item: Item, snap: GateSnapshot): Item | null {
  if (!item.projectId || !item.projectDir) return null;
  return snap.all.find((o) => isCrossRepoPendingSibling(item, o)) ?? null;
}

/**
 * 「未完の上流兄弟」判定 (uncertainNodeOrUpstreamPending (c) と uncertainGateReason の
 * 単一の真実源=両者のドリフト防止)。レビュー leaf (reviewOfId 非null) は観察タスクであって
 * 下流の前提物ではないので「上流」と数えない — 未処分のレビューが後続兄弟の自動着火を
 * 黙って塞ぐ穴を閉じる (§3.5 レビューは継ぎ目に乗るがパイプラインを堰き止めない)。
 */
export function isPendingUpstreamSibling(item: Item, o: Item): boolean {
  return (
    o.id !== item.id &&
    o.reviewOfId == null &&
    o.orderIndex < item.orderIndex &&
    o.status !== "done" &&
    o.status !== "rejected" &&
    o.executionStatus !== "succeeded" &&
    o.executionStatus !== "cancelled" &&
    // awaiting_handoff は実行成功済み(引き取り待ち)=上流として完了扱い。下流の点火を塞がない。
    o.executionStatus !== "awaiting_handoff"
  );
}

/**
 * 「resolution を下流へ注入すべき完了済み上流兄弟」判定 (context.buildHumanZone の
 * 「完了済み上流の結果」節と queue の read 時導出が共有する単一の真実源 —
 * DECISIONS.md「人間実施の結果の下流受け渡し」)。isPendingUpstreamSibling と対をなすが
 * 否定の流用 (!isPending) はしない: pending の否定≠完了 — awaiting_handoff は人間未受領で
 * 取消されうる「[完了]」詐称になり、reject が executionStatus を残す仕様上
 * rejected×succeeded も拾ってしまう。**status='done' のみ**を完了と数えることで却下済みは
 * 定義から外れ、done を解いて in_progress に戻せば注入も自動で止まる＝撤回が状態機械と
 * 自己整合する (resolution は残るが status≠done の間は注入されない)。レビュー leaf
 * (reviewOfId 非null) は観察タスクであって下流の前提物ではないので除外
 * (isPendingUpstreamSibling と同じ線)。
 */
export function isResolvedUpstreamSibling(item: Item, o: Item): boolean {
  return (
    item.parentId != null &&
    o.parentId === item.parentId &&
    o.id !== item.id &&
    o.reviewOfId == null &&
    o.orderIndex < item.orderIndex &&
    o.status === "done" &&
    (o.resolution ?? "").trim() !== ""
  );
}

/**
 * 「何がこの item を塞いでいるか」の構造化導出 — 点火ゲート判定 (uncertainNodeOrUpstreamPending)・
 * 発動時文言 (uncertainGateReason)・read 時導出 (deriveProposedGate) の三者が共有する
 * 単一の真実源。why の判定順は点火ゲート (a)(b)(c) と同一:
 *  parent_unresolved: 親が未確定 (parent.uncertaintyResolved===false)。
 *  parent_blocked: 親を人間が保留 (parent.status==='blocked')。
 *  sibling: 同一親×上流 (orderIndex が前) の兄弟が未完 (orderIndex 最小の該当兄弟を返す)。
 * parentId が null / 親不在 / どれにも該当しなければ { blocker: null, why: null }。
 */
export function upstreamBlockerOf(
  item: Item,
  snap: GateSnapshot,
): {
  blocker: Item | null;
  why: "parent_unresolved" | "parent_blocked" | "sibling" | null;
} {
  if (!item.parentId) return { blocker: null, why: null };
  const parent = snap.byId.get(item.parentId);
  if (!parent) return { blocker: null, why: null };
  if (parent.uncertaintyResolved === false) return { blocker: parent, why: "parent_unresolved" };
  if (parent.status === "blocked") return { blocker: parent, why: "parent_blocked" };
  const sib = (snap.childrenOf.get(item.parentId) ?? []).find((o) =>
    isPendingUpstreamSibling(item, o),
  );
  if (sib) return { blocker: sib, why: "sibling" };
  return { blocker: null, why: null };
}

/**
 * 未確定ノード配下リーフの点火ゲート (§3.4/§3.6-3 締めるのは速く)。crossRepoSiblingPending と
 * 同型の決定論ガード(推論なし・安全側に倒す)。(a)親未確定 / (b)親blocked / (c)上流兄弟未完 の
 * OR が真なら auto 着火せず proposed に倒す。DAG/依存自動推論/blockedBy 新スキーマは作らず、
 * 既存 parentId/orderIndex/status のみで判定。承認(approveExecution)はこのガードを通らない
 * =ワンタップの逃げ道 (crossRepo と対称)。
 */
export function uncertainNodeOrUpstreamPending(item: Item, snap: GateSnapshot): boolean {
  return upstreamBlockerOf(item, snap).why !== null;
}

function upstreamGateText(
  why: "parent_unresolved" | "parent_blocked" | "sibling",
  blocker: Item,
): string {
  if (why === "parent_unresolved")
    return "親ノードの不確実性が未解消です。先に方向を確定してから(確定済みなら、そのままワンタップで実行)。＝親確定待ち";
  if (why === "parent_blocked") return "親が保留(blocked)中です。＝親解除待ち";
  return `上流「${blocker.title.slice(0, 40)}」が未完です。＝上流完了待ち(独立なら、そのままワンタップで実行)`;
}

/**
 * 点火ゲートが立った理由を判定して一行で返す(ゲート発動時に executionResult へ書く痕跡)。
 * 上流完了待ちは「どの兄弟が塞いでいるか」を実名で出す (§4-2 理由はグランス可能に)。
 * 表示の真実は read 時導出 (deriveProposedGate) 側 — この保存文言は発動時点の痕跡であり、
 * 上流完了後は陳腐化しうる (queue が read 時に上書き表示する)。
 */
export function uncertainGateReason(item: Item, snap: GateSnapshot): string {
  const up = upstreamBlockerOf(item, snap);
  if (up.why && up.blocker) return upstreamGateText(up.why, up.blocker);
  return "同一まとまり内の上流タスク(orderIndex が前)が未完です。＝上流完了待ち(独立なら、そのままワンタップで実行)";
}

/**
 * 「worker 成果の実在」= needs_human 由来 proposed / 実行済み item の単一判別式
 * (executor の escalate 終端と queue/deriveProposedGate の read 時判別が共有する。
 * write と read が別々のインライン式を持つとドリフトするため export で一本化)。
 * ゲート書き込み (requestExecution / runExecution の proposed 倒し) は executionResult のみ
 * 書き、executionSummary/executionOutput には触れない — needs_human は applyExecuteResult が
 * この2列を書くので、成果の実在がそのまま「worker が一度は走った」の決定論シグナルになる。
 */
export function hasWorkerOutcome(item: Item): boolean {
  return item.autoExecuted && (item.executionSummary != null || item.executionOutput != null);
}

/**
 * 「この proposed は needs_human 起源か」の単一判別式。hasWorkerOutcome(成果の実在)だけでは
 * 「過去の任意の実行の残骸」と「今回の承認サイクルの needs_human」を区別できない —
 * failed/succeeded の残骸を持つ item が再ゲートで proposed に落ちると、承認の初回から
 * 前回計画が誤注入され escalate 終端が1タップで誤発火し、live なゲート警告も隠れる。
 * 起源は書き込みの構造差で決定論に判別する: needs_human の書き込み(applyExecuteResult)は
 * executionResult を summary\n\noutput の連結で同時に書く。ゲート書き込みは executionResult に
 * ゲート文言を書き summary/output に触れない。従って連結の再計算一致 = needs_human 起源
 * (推論なし・新しい状態カラムなし)。
 */
export function isNeedsHumanProposed(item: Item): boolean {
  if (item.executionStatus !== "proposed" || !hasWorkerOutcome(item)) return false;
  const workerTrace = `${item.executionSummary ?? ""}\n\n${item.executionOutput ?? ""}`.trim();
  return (item.executionResult ?? "").trim() === workerTrace;
}

/**
 * 承認後 needs_human の escalate 終端(executor.applyExecuteResult の repeat 遷移が書く状態組)の
 * read 側判別。queue(一行理由「AI停止」)と actions.doIt(引き取り時の較正簿記スキップ)が共有する
 * (write と read が別々のインライン式を持つとドリフトする)。同じ状態組には他経路
 * (reject→undo 復帰等)でも到達しうるため「終端の事実」ではなく「AIが止まり人間へ渡った
 * 実行済み項目」の判別として使う。
 */
export function isEscalateTerminated(item: Item): boolean {
  return (
    item.status === "classified" &&
    item.kind === "leaf" &&
    item.executionStatus === "none" &&
    hasWorkerOutcome(item)
  );
}

// --- read 時導出 (queue.ts が /api/state ごとに呼ぶ) ---

export type GateKind =
  | "bad_project_dir"
  | "irreversible"
  | "parent_unresolved"
  | "parent_blocked"
  | "upstream"
  | "cross_repo"
  | "pause_auto"
  | "clear";

export interface GateDerivation {
  kind: GateKind;
  // 塞いでいる実体 (待ち先チップのジャンプ先)。親ゲートは親、上流/横断は該当兄弟。
  // 実体が特定できないゲート (不可逆/pause 等) は null。
  blockerId: string | null;
  reason: string; // live な一行理由 (保存 executionResult を表示の真実にしない)
}

/**
 * proposed の一行理由を「今この瞬間の構造」から導出する (§4-2 理由はグランス可能に)。
 * ゲート発動時に保存された executionResult は発動時点の痕跡で、上流完了後も
 * 「上流Xが未完です」と表示され続ける陳腐化があった — read 時導出が表示の真実になる。
 *
 * null を返す=導出しない(呼び出し側は従来どおり保存 executionResult を表示):
 *  - 非 proposed / node。
 *  - needs_human 由来 (worker が「人間の判断が要る」と返した proposed)。executionResult には
 *    worker 成果テキストが入っており上書きしてはならない。判別は isNeedsHumanProposed
 *    (worker 成果の実在 + executionResult 連結一致=起源判別) —
 *    ゲート書き込みは summary/output に触れないため、undo/PATCH で status が変わっても
 *    判別が外れない。実行済み(成果あり)の item の再実行がゲートに落ちた場合は連結が
 *    一致せず通常のゲート導出に落ち、fresh なゲート理由が出る(旧判別の「保存ゲート文言の
 *    まま表示される」残穴は起源判別で解消)。
 *
 * 判定順は fire 順 (requestExecution) の鏡写しではなく安全優先:
 *  1) bad_project_dir — approve でも解除されない唯一のゲート (runExecution 最終ゲート)。
 *     人間が直すべき原因を他ゲート文言で隠すと「承認→即バウンス」の原因不明ループになる。
 *  2) irreversible — 不可逆/高ステークス警告を pause 等の一般文言で覆わない (誤承認防止)。
 *  3) 構造ゲート (親確定待ち/親保留/上流未完/横断) — 塞いでいる相手を実名+ID で。
 *  4) pause_auto — 上のどれでもなく、一時停止だけが理由のとき。
 *  5) clear — 全ゲート解消済み。ワンタップを促す (自動再点火はしない=緩めない)。
 */
export function deriveProposedGate(
  item: Item,
  snap: GateSnapshot,
  opts: { pauseAuto: boolean },
): GateDerivation | null {
  if (item.executionStatus !== "proposed" || item.kind !== "leaf") return null;
  // bad_project_dir は needs_human 素通しより【先】に評価する(素通しの明示例外)。
  // 成果あり item の projectDir が不正化すると、素通し優先では gateKind=null になり
  // UI の bad_project_dir 出し分けが不発 → 承認が AI 非起動で即バウンスする原因が
  // worker 文言の裏に隠れる(「承認→即バウンス」の原因不明ループ)。live 構造導出で
  // 保存文言に依存しないため、worker 成果を上書きせず両立する。
  if (item.projectDir != null) {
    const esc = projectDirEscalateReason(item.projectDir, snap);
    if (esc)
      return { kind: "bad_project_dir", blockerId: null, reason: gateTextBadProjectDir(esc) };
  }
  // needs_human 由来 (isNeedsHumanProposed: 成果の実在+executionResult 連結一致で起源まで判別)。
  // 旧判別(hasWorkerOutcome のみ)は「実行済み item の再実行がゲートに落ちた」場合まで素通しし、
  // live なゲート警告(不可逆等)が古い worker サマリの裏に隠れる残穴があった — 連結一致の
  // 起源判別でその穴を閉じる(ゲート起源なら通常のゲート導出に落ち、fresh な理由が出る)。
  if (isNeedsHumanProposed(item)) return null;
  if (isIrreversibleOrHighStakes(item))
    return { kind: "irreversible", blockerId: null, reason: GATE_TEXT_IRREVERSIBLE };
  const up = upstreamBlockerOf(item, snap);
  if (up.why && up.blocker) {
    const kind: GateKind =
      up.why === "sibling"
        ? "upstream"
        : up.why === "parent_unresolved"
          ? "parent_unresolved"
          : "parent_blocked";
    return { kind, blockerId: up.blocker.id, reason: upstreamGateText(up.why, up.blocker) };
  }
  const cross = crossRepoBlockerOf(item, snap);
  if (cross) return { kind: "cross_repo", blockerId: cross.id, reason: GATE_TEXT_CROSS_REPO };
  if (opts.pauseAuto && item.disposition === "auto")
    return { kind: "pause_auto", blockerId: null, reason: GATE_TEXT_PAUSE_AUTO };
  return { kind: "clear", blockerId: null, reason: GATE_TEXT_CLEAR };
}
