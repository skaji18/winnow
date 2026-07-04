// undoLabelText の全 action 分岐の文言テスト (UI 文言のドリフト検知)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { undoLabelText } from "./undo-label.js";

test("全 action 分岐の文言", () => {
  assert.equal(undoLabelText("do"), "着手");
  assert.equal(undoLabelText("reject"), "却下");
  assert.equal(undoLabelText("send_back"), "問いに戻す");
  assert.equal(undoLabelText("reclassify"), "分類し直し");
  assert.equal(undoLabelText("override"), "分類し直し");
  assert.equal(undoLabelText("mute_category"), "この種類を自動化");
  assert.equal(undoLabelText("receive"), "受領・畳み");
});

test("未知 action はそのまま返す(サーバの語彙追加で壊れない)", () => {
  assert.equal(undoLabelText("approve"), "approve");
  assert.equal(undoLabelText(""), "");
});
