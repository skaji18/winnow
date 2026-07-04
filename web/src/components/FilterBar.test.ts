// FilterBar の純関数 (emptyFilter / filterIsEmpty / applyFilter) の決定論テスト。
// DOM 非依存 (コンポーネント本体の結合は demo smoke が担う)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilter, emptyFilter, filterIsEmpty, type FilterState } from "./FilterBar.js";
import type { Item } from "../types.js";

/** テスト用 Item。必須フィールドを既定で埋め、上書きだけ渡す。 */
function mkItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: `title-${id}`,
    body: "",
    kind: "leaf",
    rung: "execution",
    parentId: null,
    orderIndex: 0,
    status: "captured",
    disposition: null,
    confidence: null,
    reason: null,
    stakes: null,
    reversibility: null,
    category: null,
    process: null,
    uncertaintyResolved: false,
    autoExecuted: false,
    humanOverrode: false,
    auditSampled: false,
    executionStatus: "none",
    executionResult: null,
    domain: "general",
    projectDir: null,
    projectId: null,
    sprintId: null,
    dueDate: null,
    priority: "normal",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const ids = (items: Item[]) => items.map((it) => it.id);

// --- emptyFilter / filterIsEmpty ---

test("emptyFilter は空判定を満たし、毎回独立したインスタンスを返す", () => {
  const f = emptyFilter();
  assert.equal(filterIsEmpty(f), true);
  // Set を共有していない(片方への追加が他方に漏れない)。
  const g = emptyFilter();
  f.categories.add("x");
  assert.equal(g.categories.size, 0);
});

test("filterIsEmpty: 空白のみのテキストは空扱い、各条件は1つで非空", () => {
  assert.equal(filterIsEmpty({ ...emptyFilter(), text: "   " }), true);
  assert.equal(filterIsEmpty({ ...emptyFilter(), text: "a" }), false);
  assert.equal(filterIsEmpty({ ...emptyFilter(), dispositions: new Set(["auto"]) }), false);
  assert.equal(filterIsEmpty({ ...emptyFilter(), priorities: new Set(["high"]) }), false);
  assert.equal(filterIsEmpty({ ...emptyFilter(), due: "over" }), false);
  assert.equal(filterIsEmpty({ ...emptyFilter(), categories: new Set(["経理"]) }), false);
  assert.equal(filterIsEmpty({ ...emptyFilter(), projectIds: new Set(["p1"]) }), false);
});

// --- applyFilter: テキスト検索 ---

test("applyFilter: title/body/reason を大文字小文字無視で部分一致", () => {
  const items = [
    mkItem("a", { title: "Deploy 手順" }),
    mkItem("b", { body: "本文に deploy を含む" }),
    mkItem("c", { reason: "理由が DEPLOY" }),
    mkItem("d", { title: "無関係" }),
  ];
  const f: FilterState = { ...emptyFilter(), text: "deploy" };
  assert.deepEqual(ids(applyFilter(items, f)), ["a", "b", "c"]);
});

// --- applyFilter: チップの AND 絞り込み ---

test("applyFilter: disposition 集合。null disposition は非該当", () => {
  const items = [
    mkItem("a", { disposition: "auto" }),
    mkItem("b", { disposition: "human" }),
    mkItem("c", { disposition: null }),
  ];
  const f: FilterState = { ...emptyFilter(), dispositions: new Set(["auto", "human"]) };
  assert.deepEqual(ids(applyFilter(items, f)), ["a", "b"]);
});

test("applyFilter: due=over は期日超過のみ、soon は0〜2日先のみ (期日なしは常に非該当)", () => {
  const now = Date.now();
  const DAY = 86_400_000;
  const items = [
    mkItem("over", { dueDate: now - DAY }),
    mkItem("soon", { dueDate: now + DAY }),
    mkItem("far", { dueDate: now + 10 * DAY }),
    mkItem("none", { dueDate: null }),
  ];
  assert.deepEqual(ids(applyFilter(items, { ...emptyFilter(), due: "over" })), ["over"]);
  assert.deepEqual(ids(applyFilter(items, { ...emptyFilter(), due: "soon" })), ["soon"]);
});

test("applyFilter: 複数条件は AND", () => {
  const items = [
    mkItem("a", { disposition: "auto", priority: "high", category: "経理" }),
    mkItem("b", { disposition: "auto", priority: "low", category: "経理" }),
    mkItem("c", { disposition: "human", priority: "high", category: "経理" }),
    mkItem("d", { disposition: "auto", priority: "high", category: null }),
  ];
  const f: FilterState = {
    ...emptyFilter(),
    dispositions: new Set(["auto"]),
    priorities: new Set(["high"]),
    categories: new Set(["経理"]),
  };
  assert.deepEqual(ids(applyFilter(items, f)), ["a"]);
});

test("applyFilter: projectIds は複数トグル(いずれかに属せば通る)。projectId なしは非該当", () => {
  const items = [
    mkItem("a", { projectId: "p1" }),
    mkItem("b", { projectId: "p2" }),
    mkItem("c", { projectId: "p3" }),
    mkItem("d", { projectId: null }),
  ];
  const f: FilterState = { ...emptyFilter(), projectIds: new Set(["p1", "p3"]) };
  assert.deepEqual(ids(applyFilter(items, f)), ["a", "c"]);
});

// --- 不変条件: applyFilter は入力順を保存する (client は並べ替えない) ---

test("applyFilter: 空フィルタは全件をそのままの順で返す", () => {
  const items = [mkItem("c"), mkItem("a"), mkItem("b")];
  const out = applyFilter(items, emptyFilter());
  assert.deepEqual(ids(out), ["c", "a", "b"]);
  // 要素は同一参照 (複製・加工しない)。
  assert.equal(out[0], items[0]);
});

test("applyFilter: 絞り込み後も入力順を保存する (優先度等で並べ替えない)", () => {
  // わざと優先度・期日・id の自然順と食い違う順で並べる。
  const now = Date.now();
  const items = [
    mkItem("z", { priority: "low", dueDate: now + 86_400_000, category: "対象" }),
    mkItem("m", { priority: "urgent", dueDate: now - 86_400_000, category: "対象" }),
    mkItem("x", { priority: "normal", dueDate: null, category: "他" }),
    mkItem("a", { priority: "high", dueDate: null, category: "対象" }),
  ];
  const f: FilterState = { ...emptyFilter(), categories: new Set(["対象"]) };
  // 表示集合だけが絞られ、相対順は入力 (z → m → a) のまま。
  assert.deepEqual(ids(applyFilter(items, f)), ["z", "m", "a"]);
});
