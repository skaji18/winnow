// buildDonePatch の縮退規則テスト: 空入力は resolution キー自体を送らない
// (従来の完了経路と一字一句同一)・非空のみ楽観ロックを有効化する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDonePatch } from "./resolution-patch.js";

test("非空(trim後)なら status+resolution+expectedUpdatedAt の単一 PATCH", () => {
  const p = buildDonePatch("  ベンダAで契約した。\n予算は据え置き。 ", 1234);
  assert.deepEqual(p, {
    patch: { status: "done", resolution: "ベンダAで契約した。\n予算は据え置き。" },
    expectedUpdatedAt: 1234,
  });
});

test("空/空白のみなら resolution キー自体を送らない (完全縮退・楽観ロックも付けない)", () => {
  for (const draft of ["", "   ", "\n\t"]) {
    const p = buildDonePatch(draft, 1234);
    assert.deepEqual(p.patch, { status: "done" });
    assert.ok(!("resolution" in p.patch), "空入力で resolution キーが混入している");
    assert.equal(p.expectedUpdatedAt, undefined);
  }
});
