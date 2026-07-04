// splitExecutionResult の決定論テスト: executionSummary/Output 優先と `\n\n` 分割の規則。
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitExecutionResult } from "./execution-text.js";

function mk(over: {
  executionResult?: string | null;
  executionSummary?: string | null;
  executionOutput?: string | null;
}) {
  return { executionResult: null, ...over };
}

test("executionSummary/Output が両方あればそれを優先(executionResult は無視)", () => {
  assert.deepEqual(
    splitExecutionResult(
      mk({ executionSummary: "S", executionOutput: "O", executionResult: "a\n\nb" }),
    ),
    ["S", "O"],
  );
});

test("null 混在: 片方だけ非 null でも分離フィールド優先(欠けは空文字)", () => {
  assert.deepEqual(
    splitExecutionResult(mk({ executionSummary: "S", executionOutput: null, executionResult: "x\n\ny" })),
    ["S", ""],
  );
  assert.deepEqual(
    splitExecutionResult(mk({ executionSummary: null, executionOutput: "O", executionResult: "x\n\ny" })),
    ["", "O"],
  );
});

test("分離フィールドが共に null/undefined なら executionResult を \\n\\n で分割", () => {
  // 0回: 全文が summary、output は空。
  assert.deepEqual(splitExecutionResult(mk({ executionResult: "only" })), ["only", ""]);
  // 1回: 先頭が summary、残りが output。
  assert.deepEqual(splitExecutionResult(mk({ executionResult: "sum\n\nout" })), ["sum", "out"]);
  // 複数回: 2区切り目以降は output 側で \n\n を保ったまま再連結。
  assert.deepEqual(
    splitExecutionResult(mk({ executionResult: "sum\n\no1\n\no2" })),
    ["sum", "o1\n\no2"],
  );
});

test("空文字・null の executionResult は両方空文字", () => {
  assert.deepEqual(splitExecutionResult(mk({ executionResult: "" })), ["", ""]);
  assert.deepEqual(splitExecutionResult(mk({ executionResult: null })), ["", ""]);
});
