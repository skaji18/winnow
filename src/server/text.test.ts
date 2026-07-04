// text.ts の決定論ヘルパのテスト。純関数のみ(DB 非依存なので tmp-home 不要)。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confBinOf,
  isProvisionalTitle,
  normalizeCategory,
  provisionalTitle,
} from "./text.js";

// --- confBinOf: §3.6 ビン較正のキー。floor(clamp01(conf)*5) を 0..4 に clamp ---

test("confBinOf: null/undefined/非有限は中央ビン(2)へ", () => {
  assert.equal(confBinOf(null), 2);
  assert.equal(confBinOf(undefined), 2);
  assert.equal(confBinOf(Number.NaN), 2);
  assert.equal(confBinOf(Number.POSITIVE_INFINITY), 2);
  assert.equal(confBinOf(Number.NEGATIVE_INFINITY), 2);
});

test("confBinOf: 0 近傍と範囲外下側は 0 に clamp", () => {
  assert.equal(confBinOf(0), 0);
  assert.equal(confBinOf(0.19), 0);
  assert.equal(confBinOf(-1), 0);
});

test("confBinOf: 1 近傍と範囲外上側は 4 に clamp (floor(1*5)=5 を 4 へ)", () => {
  assert.equal(confBinOf(1), 4);
  assert.equal(confBinOf(0.999), 4);
  assert.equal(confBinOf(2), 4);
});

test("confBinOf: ビン境界 (0.2/0.4/0.6/0.8 は上のビンに入る)", () => {
  assert.equal(confBinOf(0.2), 1);
  assert.equal(confBinOf(0.4), 2);
  assert.equal(confBinOf(0.6), 3);
  assert.equal(confBinOf(0.8), 4);
  assert.equal(confBinOf(0.5), 2);
});

// --- provisionalTitle / isProvisionalTitle ---

test("provisionalTitle: 先頭の非空行を trim して返す", () => {
  assert.equal(provisionalTitle("見出し行\n本文つづき"), "見出し行");
  assert.equal(provisionalTitle("\n\n  空行のあと  \n次"), "空行のあと");
  assert.equal(provisionalTitle("\r\nCRLF行\r\n次"), "CRLF行");
});

test("provisionalTitle: 空・空白のみは空文字", () => {
  assert.equal(provisionalTitle(""), "");
  assert.equal(provisionalTitle("   \n\t\n"), "");
});

test("provisionalTitle: 60 字に切る", () => {
  const long = "あ".repeat(100);
  assert.equal(provisionalTitle(long), "あ".repeat(60));
  assert.equal(provisionalTitle(long).length, 60);
});

test("isProvisionalTitle: 本文先頭からの機械切り出しと一致すれば暫定", () => {
  const body = "会議メモ: 次回までにレビュー\n詳細...";
  assert.equal(isProvisionalTitle(provisionalTitle(body), body), true);
  assert.equal(isProvisionalTitle("人間が付けたタイトル", body), false);
});

test("isProvisionalTitle: 本文なし(一行タスク)は暫定でない=タイトルを尊重", () => {
  assert.equal(isProvisionalTitle("買い物に行く", ""), false);
  assert.equal(isProvisionalTitle("買い物に行く", "   \n"), false);
});

// --- normalizeCategory: 機械的な表記揺れの吸収のみ(意味の寄せ込みはしない) ---

test("normalizeCategory: NFKC で全角英数を統一", () => {
  assert.equal(normalizeCategory("ＡＰＩ"), "API");
});

test("normalizeCategory: 連続空白を1つに畳み前後 trim", () => {
  assert.equal(normalizeCategory("  開発   環境  "), "開発 環境");
});

test("normalizeCategory: 前後の引用符・括弧の装飾を剥がす", () => {
  assert.equal(normalizeCategory("「経理」"), "経理");
  assert.equal(normalizeCategory("『調査』"), "調査");
  assert.equal(normalizeCategory('"infra"'), "infra");
  assert.equal(normalizeCategory("（保守）"), "保守");
});

test("normalizeCategory: 大文字小文字は畳まない(頭字語の表示を壊さない)", () => {
  assert.equal(normalizeCategory("API"), "API");
  assert.equal(normalizeCategory("api"), "api");
});
