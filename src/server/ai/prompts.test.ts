// executePrompt の instruction(人間の追加指示・複数行可)の文言分岐テスト。
// executePrompt は純関数(DB 非接触)なので tmp-home は不要。既定値は gates.test.ts の
// makeItem と同じ「どのゲートも引かない」側に倒し、見たい分岐だけ override する。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../domain.js";
import { executePrompt } from "./prompts.js";

let seq = 0;

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
    domain: "general",
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

const HEADING_REVIEW_PREMISE = "## レビューにあたっての人間からの前提・観点";
const HEADING_REDIRECT = "## 追加の方向修正(人間の指示)";

test("instruction なし: 追加指示の見出しは一切出ない(後方互換)", () => {
  const p = executePrompt(makeItem());
  assert.ok(!p.includes(HEADING_REVIEW_PREMISE));
  assert.ok(!p.includes(HEADING_REDIRECT));
});

test("instruction が空白のみ: 見出しは出ない", () => {
  const p = executePrompt(makeItem(), "", "  \n  ");
  assert.ok(!p.includes(HEADING_REVIEW_PREMISE));
  assert.ok(!p.includes(HEADING_REDIRECT));
});

test("レビュー leaf(reviewMaterial 非空)+instruction: 前提・観点として注入し『前回の成果物』とは言わない", () => {
  const p = executePrompt(
    makeItem({ reviewOfId: "src-1" }),
    "",
    "仕様は◯◯が正。\n△△は今回対象外。",
    false,
    "レビュー対象タスク: 元タスク\n実行サマリ: 何かをした",
  );
  assert.ok(p.includes(HEADING_REVIEW_PREMISE));
  assert.ok(p.includes("仕様は◯◯が正。\n△△は今回対象外。"), "複数行がそのまま入る");
  assert.ok(!p.includes(HEADING_REDIRECT));
  assert.ok(!p.includes("前回の成果物を踏まえ"), "未実行レビューに存在しない前提を注入しない");
});

test("reviewMaterial なし+instruction: 従来の方向修正の見出しで注入する", () => {
  const p = executePrompt(makeItem(), "", "もっと簡潔に\n表形式で");
  assert.ok(p.includes(HEADING_REDIRECT));
  assert.ok(p.includes("もっと簡潔に\n表形式で"));
  assert.ok(!p.includes(HEADING_REVIEW_PREMISE));
});

test("reviewMaterial は instruction なしでも従来どおり注入される(既存挙動の固定)", () => {
  const p = executePrompt(makeItem({ reviewOfId: "src-1" }), "", "", false, "実行サマリ: 何かをした");
  assert.ok(p.includes("## レビュー対象の実行結果"));
  assert.ok(!p.includes(HEADING_REVIEW_PREMISE));
});
