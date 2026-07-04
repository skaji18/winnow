// gates.ts(実行点火ゲートの単一真実源)のテスト (docs/INVARIANTS.md「実行ゲート」)。
// ガードは全て決定論(構造シグナル)なので、Item フィクスチャ+スナップショットだけで
// 全分岐を機械的に固定できる。needs_human 素通し時の一行理由(先頭行選択+80字上限)は
// queue.surfaceReasonOf 側の挙動なので、queue() 経由で DB を使って検証する。
import "./testing/tmp-home.js"; // ← 必ず先頭 (queue→repo→db が WINNOW_HOME を module 評価時に読む)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Item } from "./domain.js";
import {
  REVERSIBLE_THRESHOLD,
  HIGH_STAKES_THRESHOLD,
  GATE_TEXT_IRREVERSIBLE,
  GATE_TEXT_PAUSE_AUTO,
  GATE_TEXT_CROSS_REPO,
  GATE_TEXT_CLEAR,
  gateTextBadProjectDir,
  isIrreversibleOrHighStakes,
  hasWorkerOutcome,
  isNeedsHumanProposed,
  isEscalateTerminated,
  buildGateSnapshot,
  deriveProposedGate,
  type GateDerivation,
} from "./gates.js";
import { items } from "./repo.js";
import { queue } from "./queue.js";

// --- フィクスチャ -----------------------------------------------------------

let seq = 0;

/**
 * 最小 Item フィクスチャ。既定値は「どのゲートも引かない」側に倒す
 * (leaf/classified/可逆1.0/ステークス0/親なし/uncertaintyResolved=true)。
 * 各テストは見たい分岐だけを override する。
 */
function makeItem(over: Partial<Item> = {}): Item {
  seq += 1;
  return {
    id: over.id ?? `it-${seq}`,
    title: `タスク${seq}`,
    body: "",
    kind: "leaf",
    rung: "execution",
    parentId: null,
    orderIndex: seq,
    status: "classified",
    disposition: null,
    confidence: null,
    reason: null,
    stakes: 0,
    reversibility: 1,
    category: null,
    rawDisposition: null,
    rawConfidence: null,
    envEscalated: false,
    process: null,
    uncertaintyResolved: true,
    autoExecuted: false,
    humanOverrode: false,
    auditSampled: false,
    executionStatus: "none",
    executionResult: null,
    receivedAt: null,
    reviewOfId: null,
    decomposeStatus: "none",
    decomposeOptions: null,
    executionSummary: null,
    executionOutput: null,
    rollbackPlan: null,
    declaredReversible: null,
    artifacts: null,
    sourceUrl: null,
    externalKey: null,
    domain: "software",
    projectDir: null,
    projectId: null,
    sprintId: null,
    context: null,
    dueDate: null,
    priority: "normal",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** null でないことを固定してから返す (strict の narrowing 用)。 */
function mustGate(g: GateDerivation | null): GateDerivation {
  assert.ok(g, "GateDerivation が null (導出されるべきケース)");
  return g;
}

// 実在ディレクトリ (validateProjectDir が realpath を見るため実体を用意する)。
const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "winnow-gates-")));

// --- isIrreversibleOrHighStakes: 閾値境界 (§3.4) ----------------------------

test("isIrreversibleOrHighStakes: reversibility は閾値ちょうどで可逆扱い(< 判定)", () => {
  // ちょうど REVERSIBLE_THRESHOLD → 0.6 < 0.6 は偽 = ゲートしない。
  assert.equal(isIrreversibleOrHighStakes(makeItem({ reversibility: REVERSIBLE_THRESHOLD })), false);
  // 直上 → ゲートしない。
  assert.equal(isIrreversibleOrHighStakes(makeItem({ reversibility: 0.61 })), false);
  // 直下 → 不可逆側 = ゲート。
  assert.equal(isIrreversibleOrHighStakes(makeItem({ reversibility: 0.59 })), true);
});

test("isIrreversibleOrHighStakes: stakes は閾値ちょうどで低ステークス扱い(> 判定)", () => {
  // ちょうど HIGH_STAKES_THRESHOLD → 0.7 > 0.7 は偽 = ゲートしない。
  assert.equal(isIrreversibleOrHighStakes(makeItem({ stakes: HIGH_STAKES_THRESHOLD })), false);
  // 直上 → 高ステークス = ゲート。
  assert.equal(isIrreversibleOrHighStakes(makeItem({ stakes: 0.71 })), true);
  // 直下 → ゲートしない。
  assert.equal(isIrreversibleOrHighStakes(makeItem({ stakes: 0.69 })), false);
});

test("isIrreversibleOrHighStakes: null は 0 扱い = reversibility 欠落は安全側(ゲート)、stakes 欠落は非ゲート", () => {
  // reversibility null → 0 < 0.6 = 不可逆扱い(未分類は安全側に倒れる)。
  assert.equal(isIrreversibleOrHighStakes(makeItem({ reversibility: null, stakes: 0 })), true);
  // stakes null → 0 > 0.7 は偽。reversibility が可逆ならゲートしない。
  assert.equal(isIrreversibleOrHighStakes(makeItem({ reversibility: 1, stakes: null })), false);
});

// --- hasWorkerOutcome: worker 成果の実在 -------------------------------------

test("hasWorkerOutcome: autoExecuted × (summary or output) の AND", () => {
  assert.equal(hasWorkerOutcome(makeItem({ autoExecuted: true, executionSummary: "要約" })), true);
  assert.equal(hasWorkerOutcome(makeItem({ autoExecuted: true, executionOutput: "本文" })), true);
  // 成果2列とも null → 実在しない。
  assert.equal(hasWorkerOutcome(makeItem({ autoExecuted: true })), false);
  // autoExecuted=false なら成果があっても偽 (人手編集の残骸を worker 成果と混同しない)。
  assert.equal(
    hasWorkerOutcome(makeItem({ autoExecuted: false, executionSummary: "要約", executionOutput: "本文" })),
    false,
  );
});

// --- isNeedsHumanProposed: needs_human 起源の判別 (連結一致) ------------------

test("isNeedsHumanProposed: proposed + 成果実在 + executionResult 連結一致 → 真", () => {
  const it = makeItem({
    executionStatus: "proposed",
    autoExecuted: true,
    executionSummary: "人間の判断が必要です",
    executionOutput: "詳細な調査結果",
    // applyExecuteResult の書き込み構造: summary\n\noutput の連結。
    executionResult: "人間の判断が必要です\n\n詳細な調査結果",
  });
  assert.equal(isNeedsHumanProposed(it), true);
});

test("isNeedsHumanProposed: summary のみ(output null)でも trim 後の連結一致で真", () => {
  const it = makeItem({
    executionStatus: "proposed",
    autoExecuted: true,
    executionSummary: "停止理由のみ",
    executionOutput: null,
    executionResult: "停止理由のみ",
  });
  assert.equal(isNeedsHumanProposed(it), true);
});

test("isNeedsHumanProposed: 連結不一致(ゲート文言が入った executionResult)は偽 = ゲート起源", () => {
  // failed/succeeded の残骸(成果あり)を持つ item がゲートで proposed に落ちたケース:
  // executionResult はゲート文言なので連結と一致しない → needs_human と誤判別しない。
  const it = makeItem({
    executionStatus: "proposed",
    autoExecuted: true,
    executionSummary: "過去の実行の要約",
    executionOutput: "過去の実行の本文",
    executionResult: GATE_TEXT_IRREVERSIBLE,
  });
  assert.equal(isNeedsHumanProposed(it), false);
});

test("isNeedsHumanProposed: 非 proposed / 成果なしは偽", () => {
  assert.equal(
    isNeedsHumanProposed(
      makeItem({ executionStatus: "none", autoExecuted: true, executionSummary: "s", executionResult: "s" }),
    ),
    false,
  );
  assert.equal(
    isNeedsHumanProposed(makeItem({ executionStatus: "proposed", autoExecuted: false, executionResult: "" })),
    false,
  );
});

// --- isEscalateTerminated: escalate 終端の状態組 ------------------------------

test("isEscalateTerminated: classified × leaf × executionStatus none × worker 成果実在", () => {
  const base = {
    status: "classified",
    kind: "leaf",
    executionStatus: "none",
    autoExecuted: true,
    executionSummary: "AIが停止した理由",
  } as const;
  assert.equal(isEscalateTerminated(makeItem({ ...base })), true);
  // 4条件のどれか1つでも欠けたら偽。
  assert.equal(isEscalateTerminated(makeItem({ ...base, status: "in_progress" })), false);
  assert.equal(isEscalateTerminated(makeItem({ ...base, kind: "node" })), false);
  assert.equal(isEscalateTerminated(makeItem({ ...base, executionStatus: "proposed" })), false);
  assert.equal(
    isEscalateTerminated(makeItem({ ...base, autoExecuted: false })), // 成果非実在
    false,
  );
});

// --- deriveProposedGate: 発火条件と判定順 -------------------------------------

test("deriveProposedGate: 非 proposed / node は導出しない(null)", () => {
  const snap = buildGateSnapshot([]);
  assert.equal(deriveProposedGate(makeItem({ executionStatus: "none" }), snap, { pauseAuto: false }), null);
  assert.equal(
    deriveProposedGate(makeItem({ executionStatus: "proposed", kind: "node" }), snap, { pauseAuto: false }),
    null,
  );
});

test("deriveProposedGate: bad_project_dir — 相対パスは escalate 理由つきで保留", () => {
  const it = makeItem({ executionStatus: "proposed", projectDir: "relative/dir" });
  const snap = buildGateSnapshot([it]);
  const g = mustGate(deriveProposedGate(it, snap, { pauseAuto: false }));
  assert.equal(g.kind, "bad_project_dir");
  assert.equal(g.blockerId, null);
  // 文言は gateTextBadProjectDir(理由) の形 (作業ディレクトリが不正のため…)。
  assert.match(g.reason, /^作業ディレクトリが不正のため実行を保留しました\(/);
  // 検証結果はスナップショット内でメモ化される (同一 projectDir を fs で二度見ない)。
  assert.equal(snap.projectDirEscalates.has("relative/dir"), true);
});

test("deriveProposedGate: bad_project_dir — 機微パス(/etc 配下)も保留", () => {
  const it = makeItem({ executionStatus: "proposed", projectDir: "/etc/winnow-gates-test" });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([it]), { pauseAuto: false }));
  assert.equal(g.kind, "bad_project_dir");
  assert.equal(g.reason, gateTextBadProjectDir("projectDir が機微パス(/etc)配下です。安全側にエスカレートします"));
});

test("deriveProposedGate: 実在ディレクトリと未作成(これから clone)の絶対パスはゲートしない", () => {
  const ok = makeItem({ executionStatus: "proposed", projectDir: realDir });
  assert.equal(mustGate(deriveProposedGate(ok, buildGateSnapshot([ok]), { pauseAuto: false })).kind, "clear");
  // 存在しない絶対パスは best-effort realpath で通る (escalate しない)。
  const future = makeItem({ executionStatus: "proposed", projectDir: path.join(realDir, "not-yet-cloned") });
  assert.equal(
    mustGate(deriveProposedGate(future, buildGateSnapshot([future]), { pauseAuto: false })).kind,
    "clear",
  );
});

test("deriveProposedGate: bad_project_dir は needs_human 素通しより【先】に評価される", () => {
  // needs_human 起源 (成果実在+連結一致) かつ projectDir が不正 → 素通し(null)ではなく
  // bad_project_dir を出す (承認→即バウンスの原因を worker 文言の裏に隠さない)。
  const it = makeItem({
    executionStatus: "proposed",
    projectDir: "relative/dir",
    autoExecuted: true,
    executionSummary: "人間の判断が必要",
    executionOutput: "詳細",
    executionResult: "人間の判断が必要\n\n詳細",
  });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([it]), { pauseAuto: false }));
  assert.equal(g.kind, "bad_project_dir");
});

test("deriveProposedGate: needs_human 起源は素通し(null) — 不可逆でも worker 成果を上書きしない", () => {
  const it = makeItem({
    executionStatus: "proposed",
    reversibility: 0, // 不可逆条件も同時に満たすが、needs_human 素通しが先。
    autoExecuted: true,
    executionSummary: "判断を仰ぎたい",
    executionOutput: "根拠",
    executionResult: "判断を仰ぎたい\n\n根拠",
  });
  assert.equal(deriveProposedGate(it, buildGateSnapshot([it]), { pauseAuto: false }), null);
});

test("deriveProposedGate: irreversible — 構造ゲートより先に不可逆/高ステークス警告", () => {
  // 上流未完も同時に立てるが、判定順は irreversible が先 (誤承認防止を一般文言で覆わない)。
  const parent = makeItem({ id: "p-irr", kind: "node" });
  const sib = makeItem({ parentId: "p-irr", orderIndex: 1 });
  const it = makeItem({
    parentId: "p-irr",
    orderIndex: 2,
    executionStatus: "proposed",
    stakes: 0.9,
  });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([parent, sib, it]), { pauseAuto: false }));
  assert.equal(g.kind, "irreversible");
  assert.equal(g.blockerId, null);
  assert.equal(g.reason, GATE_TEXT_IRREVERSIBLE);
});

test("deriveProposedGate: parent_unresolved — 親未確定は親を blocker に", () => {
  const parent = makeItem({ id: "p-unres", kind: "node", uncertaintyResolved: false });
  const it = makeItem({ parentId: "p-unres", executionStatus: "proposed" });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([parent, it]), { pauseAuto: false }));
  assert.equal(g.kind, "parent_unresolved");
  assert.equal(g.blockerId, "p-unres");
  assert.match(g.reason, /親ノードの不確実性が未解消/);
});

test("deriveProposedGate: parent_blocked — 親保留は親を blocker に", () => {
  const parent = makeItem({ id: "p-blk", kind: "node", status: "blocked" });
  const it = makeItem({ parentId: "p-blk", executionStatus: "proposed" });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([parent, it]), { pauseAuto: false }));
  assert.equal(g.kind, "parent_blocked");
  assert.equal(g.blockerId, "p-blk");
  assert.match(g.reason, /親が保留\(blocked\)中/);
});

test("deriveProposedGate: upstream — orderIndex 最小の未完兄弟を実名(40字上限)で返す", () => {
  const parent = makeItem({ id: "p-up", kind: "node" });
  const longTitle = "上".repeat(50); // 50字 → 文言には先頭40字だけ
  const sibFirst = makeItem({ id: "sib-1", parentId: "p-up", orderIndex: 1, title: longTitle });
  const sibSecond = makeItem({ id: "sib-2", parentId: "p-up", orderIndex: 2 });
  const it = makeItem({ parentId: "p-up", orderIndex: 3, executionStatus: "proposed" });
  // スナップショットへは orderIndex 順と逆に渡す → childrenOf のソートで最小が選ばれる事を固定。
  const g = mustGate(
    deriveProposedGate(it, buildGateSnapshot([parent, it, sibSecond, sibFirst]), { pauseAuto: false }),
  );
  assert.equal(g.kind, "upstream");
  assert.equal(g.blockerId, "sib-1");
  assert.ok(g.reason.includes("上".repeat(40)));
  assert.ok(!g.reason.includes("上".repeat(41))); // 40字で切れている
});

test("deriveProposedGate: レビュー leaf / 完了系の兄弟は上流に数えない → clear", () => {
  const parent = makeItem({ id: "p-skip", kind: "node" });
  // reviewOfId 非null = 観察タスク (パイプラインを堰き止めない)。
  const review = makeItem({ parentId: "p-skip", orderIndex: 1, reviewOfId: "someone" });
  // awaiting_handoff = 実行成功済み(引き取り待ち) = 上流として完了扱い。
  const handoff = makeItem({ parentId: "p-skip", orderIndex: 2, status: "review", executionStatus: "awaiting_handoff" });
  const done = makeItem({ parentId: "p-skip", orderIndex: 3, status: "done" });
  const it = makeItem({ parentId: "p-skip", orderIndex: 4, executionStatus: "proposed" });
  const g = mustGate(
    deriveProposedGate(it, buildGateSnapshot([parent, review, handoff, done, it]), { pauseAuto: false }),
  );
  assert.equal(g.kind, "clear");
});

test("deriveProposedGate: cross_repo — 同一案件×異 projectDir×auto/実行中の兄弟が blocker", () => {
  const other = makeItem({
    id: "x-auto",
    projectId: "prj",
    projectDir: "/somewhere/else",
    disposition: "auto",
  });
  const it = makeItem({ executionStatus: "proposed", projectId: "prj", projectDir: realDir });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([other, it]), { pauseAuto: false }));
  assert.equal(g.kind, "cross_repo");
  assert.equal(g.blockerId, "x-auto");
  assert.equal(g.reason, GATE_TEXT_CROSS_REPO);
});

test("deriveProposedGate: cross_repo — 実行中(running)なら disposition human でも引く", () => {
  const other = makeItem({
    id: "x-run",
    projectId: "prj2",
    projectDir: "/somewhere/else",
    disposition: "human",
    executionStatus: "running",
  });
  const it = makeItem({ executionStatus: "proposed", projectId: "prj2", projectDir: realDir });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([other, it]), { pauseAuto: false }));
  assert.equal(g.kind, "cross_repo");
});

test("deriveProposedGate: cross_repo — 完了側(succeeded/cancelled/awaiting_handoff)や非autoの兄弟は引かない", () => {
  const mk = (id: string, over: Partial<Item>) =>
    makeItem({ id, projectId: "prj3", projectDir: "/somewhere/else", disposition: "auto", ...over });
  const others = [
    mk("x-succ", { executionStatus: "succeeded" }),
    mk("x-canc", { executionStatus: "cancelled" }),
    mk("x-hand", { executionStatus: "awaiting_handoff" }),
    mk("x-human", { disposition: "human", executionStatus: "none" }), // auto でも実行中でもない
    mk("x-samedir", { projectDir: realDir }), // 同一 projectDir は横断ではない
  ];
  const it = makeItem({ executionStatus: "proposed", projectId: "prj3", projectDir: realDir });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([...others, it]), { pauseAuto: false }));
  assert.equal(g.kind, "clear");
});

test("deriveProposedGate: pause_auto — 一時停止×disposition auto のみで発火(他ゲート無し)", () => {
  const auto = makeItem({ executionStatus: "proposed", disposition: "auto" });
  const g = mustGate(deriveProposedGate(auto, buildGateSnapshot([auto]), { pauseAuto: true }));
  assert.equal(g.kind, "pause_auto");
  assert.equal(g.reason, GATE_TEXT_PAUSE_AUTO);
  // 非 auto は pause 中でも pause_auto を出さない → clear。
  const esc = makeItem({ executionStatus: "proposed", disposition: "escalate" });
  assert.equal(mustGate(deriveProposedGate(esc, buildGateSnapshot([esc]), { pauseAuto: true })).kind, "clear");
});

test("deriveProposedGate: clear — 全ゲート解消済みはワンタップを促す", () => {
  const it = makeItem({ executionStatus: "proposed" });
  const g = mustGate(deriveProposedGate(it, buildGateSnapshot([it]), { pauseAuto: false }));
  assert.equal(g.kind, "clear");
  assert.equal(g.blockerId, null);
  assert.equal(g.reason, GATE_TEXT_CLEAR);
});

// --- queue() 経由: needs_human 素通し時の一行理由 (先頭行選択+80字上限) --------

test("queue: needs_human 素通しは executionSummary の先頭行を 80字+番兵で丸める", () => {
  const firstLine100 = "あ".repeat(100);
  const summary = `${firstLine100}\n2行目は理由に出さない`;
  const created = items.create({
    title: "needs_human 長文サマリ",
    kind: "leaf",
    status: "classified",
    executionStatus: "proposed",
    autoExecuted: true,
    executionSummary: summary,
    executionOutput: "詳細出力",
    executionResult: `${summary}\n\n詳細出力`, // applyExecuteResult と同じ連結 = needs_human 起源
  });
  const q = queue().find((x) => x.id === created.id);
  assert.ok(q, "proposed はキューに必ず出る");
  assert.equal(q.gateKind, null); // 素通し = ゲート表示なし
  assert.equal(q.needsHuman, true);
  // 先頭行の【列選択】+ 80字上限 (worker 語の導出上書きはしない)。
  assert.equal(q.surfaceReason, "あ".repeat(80) + "…");
});

test("queue: summary 欠落時は executionResult の先頭行に落ちる(80字以内はそのまま)", () => {
  const created = items.create({
    title: "needs_human summary欠落",
    kind: "leaf",
    status: "classified",
    executionStatus: "proposed",
    autoExecuted: true,
    executionSummary: null,
    executionOutput: "一行目の停止理由\n二行目の詳細",
    executionResult: "一行目の停止理由\n二行目の詳細", // `${""}\n\noutput`.trim() と一致
  });
  const q = queue().find((x) => x.id === created.id);
  assert.ok(q);
  assert.equal(q.gateKind, null);
  assert.equal(q.needsHuman, true);
  assert.equal(q.surfaceReason, "一行目の停止理由");
});

test("queue: ゲート由来 proposed は保存 executionResult でなく read 時導出が表示の真実", () => {
  const created = items.create({
    title: "ゲート由来 proposed",
    kind: "leaf",
    status: "classified",
    executionStatus: "proposed",
    reversibility: 0.2, // 不可逆ゲート
    executionResult: "陳腐化した発動時の痕跡文言",
  });
  const q = queue().find((x) => x.id === created.id);
  assert.ok(q);
  assert.equal(q.gateKind, "irreversible");
  assert.equal(q.needsHuman, false);
  assert.equal(q.surfaceReason, GATE_TEXT_IRREVERSIBLE); // 保存文言は表示しない
});
