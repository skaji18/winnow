// scoreItem の純度テスト (docs/INVARIANTS.md「scoreItem の純度」)。
// - 処理量項を足さない / sprintId 非参照 / receivedAt はスコアに混ぜない。
// - dueBoost の境界 (DUE_SOON_DAYS / DUE_WEEK_DAYS) は horizon.ts と単一の真実源
//   (horizon.ts は queue.ts から import しており定数の同一性はコンパイル時に保証される。
//   本テストは runtime 挙動として「同じ due で dueBoost の段差点と horizonView の
//   バケット境界が一致する」ことを固定する)。
// - stakes/priority/確信度低(confidence 逆相関)の単調性と topReason の選択。
import "./testing/tmp-home.js"; // ← 必ず先頭: queue.ts → repo.js → db.js が WINNOW_HOME を読む
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { DAY_MS, DUE_SOON_DAYS, DUE_WEEK_DAYS, scoreItem } from "./queue.js";
import { horizonView, type DueBucket } from "./horizon.js";
import { items } from "./repo.js";
import type { Item } from "./domain.js";

// dueBoost/handoffC は Date.now() を直接読む(引数注入不可)ため、Date.now を固定値に
// 差し替えて境界を厳密に踏む。restore は after で必ず行う。
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const realNow = Date.now;
before(() => {
  Date.now = () => NOW;
});
after(() => {
  Date.now = realNow;
});

/** 浮動小数の寄与合成があるため厳密等値でなく 1e-9 の近似で比較する。 */
function approx(actual: number, expected: number, msg?: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${msg ?? ""} expected ${actual} ≈ ${expected}`,
  );
}

/** DB を通さない in-memory の Item (scoreItem は純関数なので永続化不要)。 */
function base(over: Partial<Item> = {}): Item {
  return {
    id: "test-item",
    title: "t",
    body: "",
    kind: "leaf",
    rung: "execution",
    parentId: null,
    orderIndex: 0,
    status: "classified",
    disposition: null,
    confidence: 0.5,
    reason: null,
    stakes: 0.5,
    reversibility: null,
    category: null,
    rawDisposition: null,
    rawConfidence: null,
    envEscalated: false,
    process: null,
    uncertaintyResolved: false,
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
    domain: "general",
    projectDir: null,
    projectId: null,
    sprintId: null,
    context: null,
    resolution: null,
    dueDate: null,
    priority: "normal",
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    ...over,
  };
}

/** dueDate の寄与だけを取り出す (他の寄与は base で固定)。 */
function boostOf(dueDate: number | null): number {
  return scoreItem(base({ dueDate })).score - scoreItem(base({ dueDate: null })).score;
}

// ---------------------------------------------------------------------------
// 純度: score に混ぜてはいけない列 (退行検知)
// ---------------------------------------------------------------------------

test("純度: receivedAt を変えても score/topReason が不変", () => {
  const a = scoreItem(base({ receivedAt: null }));
  const b = scoreItem(base({ receivedAt: NOW - 5 * DAY_MS }));
  const c = scoreItem(base({ receivedAt: NOW }));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test("純度: sprintId / projectId を変えても score/topReason が不変", () => {
  const a = scoreItem(base({ sprintId: null, projectId: null }));
  const b = scoreItem(base({ sprintId: "sprint-1", projectId: "proj-1" }));
  const c = scoreItem(base({ sprintId: "sprint-2", projectId: "proj-2" }));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test("純度: 処理量項なし — createdAt/updatedAt を変えても不変 (通常状態)", () => {
  // 時刻列がスコアに効くのは awaiting_handoff の前面固定逓減 (handoffC) だけ。
  // executionStatus='none' では経年を混ぜない (滞留は ageDays 表示の責務)。
  const a = scoreItem(base({}));
  const b = scoreItem(base({ createdAt: NOW - 30 * DAY_MS, updatedAt: NOW - 30 * DAY_MS }));
  const c = scoreItem(base({ createdAt: NOW, updatedAt: NOW }));
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

// ---------------------------------------------------------------------------
// dueBoost の境界 = horizon.ts のバケット境界 (単一の真実源のドリフト検知)
// ---------------------------------------------------------------------------

test("dueBoost の段差点が horizonView のバケット境界と一致する", () => {
  assert.ok(0 < DUE_SOON_DAYS && DUE_SOON_DAYS < DUE_WEEK_DAYS, "境界定数の順序");
  const pts: { due: number | null; bucket: DueBucket; boost: number }[] = [
    { due: NOW - 1, bucket: "over", boost: 1.2 }, // 期限超過 (days < 0)
    { due: NOW, bucket: "soon", boost: 0.6 }, // ちょうど今 (days = 0) は「間近」側
    { due: NOW + DUE_SOON_DAYS * DAY_MS - 1, bucket: "soon", boost: 0.6 }, // 間近の内側
    { due: NOW + DUE_SOON_DAYS * DAY_MS, bucket: "week", boost: 0.2 }, // 境界ちょうどは今週側
    { due: NOW + DUE_WEEK_DAYS * DAY_MS - 1, bucket: "week", boost: 0.2 }, // 今週の内側
    { due: NOW + DUE_WEEK_DAYS * DAY_MS, bucket: "later", boost: 0 }, // 境界ちょうどは later
    { due: null, bucket: "unknown", boost: 0 }, // 期日なしは押し上げなし
  ];
  // horizonView 側: 同じ due の open な実行 leaf がどのバケットに入るかを実 DB で確認。
  const created = pts.map((p, i) => ({
    ...p,
    id: items.create({
      title: `horizon-boundary-${i}`,
      kind: "leaf",
      rung: "execution",
      status: "classified",
      dueDate: p.due ?? undefined,
    }).id,
  }));
  const cells = horizonView();
  for (const p of created) {
    approx(boostOf(p.due), p.boost, `dueBoost(due=${p.due})`);
    const cell = cells.find((c) => c.entries.some((e) => e.id === p.id));
    assert.ok(cell, `due=${p.due} の item がどのセルにも現れない`);
    assert.equal(cell.dueBucket, p.bucket, `horizon bucket(due=${p.due})`);
  }
});

// ---------------------------------------------------------------------------
// 単調性
// ---------------------------------------------------------------------------

test("stakes は単調増加 (null は 0.5 と同値)", () => {
  const scores = [0, 0.25, 0.5, 0.75, 1].map((v) => scoreItem(base({ stakes: v })).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i]! > scores[i - 1]!, `stakes 単調性 (${i})`);
  }
  approx(scoreItem(base({ stakes: null })).score, scoreItem(base({ stakes: 0.5 })).score);
});

test("confidence は低いほど score が上がる (null は 0.5 と同値)", () => {
  const scores = [0, 0.25, 0.5, 0.75, 1].map((v) => scoreItem(base({ confidence: v })).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i]! < scores[i - 1]!, `confidence 逆相関 (${i})`);
  }
  approx(scoreItem(base({ confidence: null })).score, scoreItem(base({ confidence: 0.5 })).score);
});

test("priority は low < normal < high < urgent の単調増加", () => {
  const scores = (["low", "normal", "high", "urgent"] as const).map(
    (p) => scoreItem(base({ priority: p })).score,
  );
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i]! > scores[i - 1]!, `priority 単調性 (${i})`);
  }
});

test("orderIndex は弱いタイブレーク: score を微減させるが topReason に出ない", () => {
  const at0 = scoreItem(base({ stakes: 1, orderIndex: 0 }));
  const at1 = scoreItem(base({ stakes: 1, orderIndex: 1 }));
  const far = scoreItem(base({ stakes: 1, orderIndex: 1000 }));
  assert.ok(at1.score < at0.score, "orderIndex 増で score 減");
  assert.ok(far.score < at1.score);
  // 弱係数: 隣接1段の差は due の最小段差(0.2)より十分小さい (手動並びが期日を上書きしない)。
  assert.ok(at0.score - at1.score < 0.2, "手動並びは弱い混入に留まる");
  // 手動並びは表示理由に出さない。
  assert.equal(far.topReason, "高ステークス");
});

// ---------------------------------------------------------------------------
// topReason の選択 (最大寄与カテゴリ・一語)
// ---------------------------------------------------------------------------

test("topReason: 期限超過の寄与が最大なら『期日』", () => {
  // dueC=1.2 > stakesC=0.5 = confC=0.5, prioC=0
  const r = scoreItem(base({ dueDate: NOW - DAY_MS }));
  assert.equal(r.topReason, "期日");
});

test("topReason: stakes 最大なら『高ステークス』", () => {
  // stakesC=1.0 > confC=0.5, dueC=0, prioC=0
  assert.equal(scoreItem(base({ stakes: 1 })).topReason, "高ステークス");
});

test("topReason: urgent の寄与が最大なら『優先度』", () => {
  // prioC=1.5 > stakesC=0.2, confC=0.1, dueC=0
  const r = scoreItem(base({ priority: "urgent", stakes: 0.2, confidence: 0.9 }));
  assert.equal(r.topReason, "優先度");
});

test("topReason: confidence 最低なら『確信度低』", () => {
  // confC=1.0 > stakesC=0.2, prioC=0, dueC=0
  const r = scoreItem(base({ confidence: 0, stakes: 0.2 }));
  assert.equal(r.topReason, "確信度低");
});

test("topReason: 全寄与ゼロなら null (理由バッジを出さない)", () => {
  const r = scoreItem(base({ stakes: 0, confidence: 1, priority: "normal", dueDate: null }));
  assert.equal(r.topReason, null);
});

test("topReason: 同値タイは列挙順の先頭 (期日) に決定論で倒れる", () => {
  // dueC=0.6 (間近) と stakesC=0.6 の同値タイ。厳密不等号 (>) の走査なので先頭の期日が勝つ。
  const r = scoreItem(base({ dueDate: NOW, stakes: 0.6, confidence: 1, priority: "normal" }));
  assert.equal(r.topReason, "期日");
});
