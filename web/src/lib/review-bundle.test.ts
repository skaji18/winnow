// bundleReviews の決定論テスト。並びの唯一の真実はサーバ score 順の入力配列であり、
// 束ねは描画グルーピングのみ(並べ替え・挿入をしない)事を検証する (docs/INVARIANTS.md)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleReviews, type BundleCard } from "./review-bundle.js";

function mk(id: string, reviewOfId?: string | null): BundleCard {
  return { id, reviewOfId };
}

/**
 * QueueView renderCard と同じ規則で描画順を再現する:
 * 入力順に走査し、束ねられたレビューはスキップ、対象カードの直後にそのレビュー群を出す。
 */
function drawOrder(cards: BundleCard[]): string[] {
  const { reviewsOf, bundledIds } = bundleReviews(cards);
  const out: string[] = [];
  for (const q of cards) {
    if (bundledIds.has(q.id)) continue;
    out.push(q.id);
    for (const r of reviewsOf.get(q.id) ?? []) out.push(r.id);
  }
  return out;
}

test("入力順(=サーバ score 順)が描画順で保存される(束ねなし)", () => {
  const cards = [mk("c"), mk("a"), mk("b")];
  const { reviewsOf, bundledIds } = bundleReviews(cards);
  assert.equal(reviewsOf.size, 0);
  assert.equal(bundledIds.size, 0);
  // 入力配列自体も不変(並べ替え・挿入をしない)。
  assert.deepEqual(cards.map((q) => q.id), ["c", "a", "b"]);
  assert.deepEqual(drawOrder(cards), ["c", "a", "b"]);
});

test("対象カードが可視のとき、レビューは束ねられ bundledIds に入る", () => {
  const cards = [mk("x"), mk("t"), mk("r", "t"), mk("y")];
  const { reviewsOf, bundledIds } = bundleReviews(cards);
  assert.deepEqual([...bundledIds], ["r"]);
  assert.deepEqual(reviewsOf.get("t")?.map((q) => q.id), ["r"]);
  // 束の位置=対象カードの位置。他カードの相対順は不変。
  assert.deepEqual(drawOrder(cards), ["x", "t", "r", "y"]);
});

test("対象がキューに居ない(不可視)レビューは束ねられず単独カードで素通し", () => {
  const cards = [mk("a"), mk("r", "gone")];
  const { reviewsOf, bundledIds } = bundleReviews(cards);
  assert.equal(reviewsOf.size, 0);
  assert.equal(bundledIds.has("r"), false);
  assert.deepEqual(drawOrder(cards), ["a", "r"]);
});

test("同一対象への複数レビューは入力順のまま同じ束に入る", () => {
  const cards = [mk("r1", "t"), mk("t"), mk("r2", "t")];
  const { reviewsOf, bundledIds } = bundleReviews(cards);
  assert.deepEqual(reviewsOf.get("t")?.map((q) => q.id), ["r1", "r2"]);
  assert.deepEqual([...bundledIds].sort(), ["r1", "r2"]);
  assert.deepEqual(drawOrder(cards), ["t", "r1", "r2"]);
});

test("reviewOfId なし(undefined/null)は素通し", () => {
  const cards = [mk("a", null), mk("b", undefined), mk("c")];
  const { reviewsOf, bundledIds } = bundleReviews(cards);
  assert.equal(reviewsOf.size, 0);
  assert.equal(bundledIds.size, 0);
  assert.deepEqual(drawOrder(cards), ["a", "b", "c"]);
});
