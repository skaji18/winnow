// deriveHeaderCounts の決定論テスト: inFlight 優先 / items フォールバック / over / 最長経過秒。
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveHeaderCounts, type HeaderCountsInput } from "./header-counts.js";

function mkItem(
  executionStatus: HeaderCountsInput["items"][number]["executionStatus"],
  updatedAt = 0,
): HeaderCountsInput["items"][number] {
  return { executionStatus, updatedAt };
}

test("inFlight があればサーバ集計を優先する(items は数えない)", () => {
  const state: HeaderCountsInput = {
    inFlight: { running: 2, proposed: 3, awaitingHandoff: 1 },
    items: [mkItem("running", 5_000)],
    settings: { maxWorkers: 4 },
  };
  // now に 1000 で割り切れない端数を含める: 経過 5500ms → 5 秒 (切り捨て方向を固定。
  // round/ceil なら 6 になりこのテストが割れる)。
  const r = deriveHeaderCounts(state, 10_500);
  assert.equal(r.running, 2);
  assert.equal(r.proposed, 3);
  assert.equal(r.handoff, 1);
  assert.equal(r.over, false);
  // 最長経過秒は items の running から計算 (updatedAt≒着火時刻の近似)。
  assert.equal(r.longestSec, 5);
});

test("inFlight 未提供なら items から数える。maxWorkers 超過で over", () => {
  const state: HeaderCountsInput = {
    items: [
      mkItem("running", 0),
      mkItem("running", 2_000),
      mkItem("proposed"),
      mkItem("awaiting_handoff"),
      mkItem("succeeded"),
    ],
    settings: { maxWorkers: 1 },
  };
  const r = deriveHeaderCounts(state, 10_000);
  assert.equal(r.running, 2);
  assert.equal(r.proposed, 1);
  assert.equal(r.handoff, 1);
  assert.equal(r.over, true); // 2 > 1
  assert.equal(r.longestSec, 10);
});

test("running=0 なら longestSec=0、running==maxWorkers は over でない", () => {
  const r = deriveHeaderCounts(
    { items: [mkItem("proposed")], settings: { maxWorkers: 0 } },
    1_000,
  );
  assert.equal(r.running, 0);
  assert.equal(r.longestSec, 0);
  assert.equal(r.over, false); // 0 > 0 は偽 (境界は超過のみ色付け)
});
