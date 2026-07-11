// 実行フィードバック・リデザインの smoke (docs/DECISIONS.md「実行フィードバックの終端と構造」)。
// migration v4 / receive 終端 / reject 終端 / レビュー束の受領 / undo の逆適用 を
// AI 非起動(repo/queue/actions/executor の決定論部分のみ)で検証する。
// 実行: WINNOW_HOME=$(mktemp -d) npx tsx scripts-smoke-feedback.ts
import assert from "node:assert/strict";
import { db, SCHEMA_VERSION } from "./src/server/db.js";
import { items, labels } from "./src/server/repo.js";
import { queue, UNDOABLE } from "./src/server/queue.js";
import * as actions from "./src/server/actions.js";
import * as executor from "./src/server/executor.js";

const inQueue = (id: string) => queue().some((q) => q.id === id);

// --- 1) migration: コードの期待版 + 新列 -----------------------------------
// 版番号は db.ts の単一真実源に追随する(版繰り上げのたびに smoke が偽陽性で落ちない)。
assert.equal(
  Number(db.pragma("user_version", { simple: true })),
  SCHEMA_VERSION,
  `user_version=${SCHEMA_VERSION}`,
);
const itemCols = (db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map(
  (c) => c.name,
);
assert.ok(itemCols.includes("receivedAt"), "items.receivedAt");
assert.ok(itemCols.includes("reviewOfId"), "items.reviewOfId");
assert.ok(itemCols.includes("resolution"), "items.resolution (v5)");
const jobCols = (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map(
  (c) => c.name,
);
assert.ok(jobCols.includes("externalApproved"), "jobs.externalApproved");
assert.ok(UNDOABLE.has("receive"), "receive は UNDOABLE");

// --- 2) autoDone: 受領で畳む → undo で戻る ---------------------------------
const a = items.create({ title: "smoke:autoDone", kind: "leaf", status: "done" });
items.update(a.id, { autoExecuted: true, executionStatus: "succeeded", category: "smoke" });
assert.ok(inQueue(a.id), "autoDone 未受領は取消ハンドルとしてキューに出る");
await actions.acceptHandoff(a.id);
assert.ok(!inQueue(a.id), "受領(確認して畳む)で畳まれる");
assert.ok(items.get(a.id)!.receivedAt != null, "receivedAt が立つ");
actions.undoLastLabel(a.id);
assert.ok(inQueue(a.id), "undo で再可視化");
assert.equal(items.get(a.id)!.receivedAt, null, "undo で receivedAt が下りる");

// --- 3) handoff: 受領で done → 再浮上しない → undo で引き取り待ちへ復元 -----
const h = items.create({ title: "smoke:handoff", kind: "leaf" });
items.update(h.id, { autoExecuted: true, executionStatus: "awaiting_handoff", status: "review" });
assert.ok(inQueue(h.id), "引き取り待ちはキューに出る");
await actions.acceptHandoff(h.id);
const h2 = items.get(h.id)!;
assert.equal(h2.status, "done");
assert.equal(h2.executionStatus, "succeeded");
assert.ok(h2.receivedAt != null);
assert.ok(!inQueue(h.id), "受領済み handoff は autoDone カードとして再浮上しない");
actions.undoLastLabel(h.id);
const h3 = items.get(h.id)!;
assert.equal(h3.executionStatus, "awaiting_handoff", "undo で引き取り待ちへ復元");
assert.equal(h3.status, "review");
assert.equal(h3.receivedAt, null);

// --- 4) failed の却下が終端 → undo で再浮上 --------------------------------
const f = items.create({ title: "smoke:failed", kind: "leaf" });
items.update(f.id, { status: "in_progress", executionStatus: "failed" });
assert.ok(inQueue(f.id), "failed は再浮上する");
actions.reject(f.id);
assert.ok(!inQueue(f.id), "却下で畳まれる(rejected が failed 再浮上に勝つ)");
actions.undoLastLabel(f.id);
assert.ok(inQueue(f.id), "undo で failed として再浮上");

// --- 5) 未実行 proposed の cancel は reject 経路(undo 可能)。cancelled にしない ---
const p = items.create({ title: "smoke:proposed", kind: "leaf" });
items.update(p.id, {
  status: "classified",
  disposition: "auto",
  confidence: 0.9,
  executionStatus: "proposed",
});
await executor.cancelExecution(p.id);
const p2 = items.get(p.id)!;
assert.equal(p2.status, "rejected", "提案の取り消し=却下");
assert.equal(p2.executionStatus, "none", "cancelled に倒さない(実行済みの取り消し専用に純化)");
assert.equal(labels.lastForItem(p.id)!.action, "reject");
actions.undoLastLabel(p.id);
assert.equal(items.get(p.id)!.status, "classified", "undo で復元(デッドエンドでない)");

// --- 6) レビュー束の受領: レビューと対象を1タップ2畳み ----------------------
const src = items.create({ title: "smoke:src", kind: "leaf", status: "done" });
items.update(src.id, { autoExecuted: true, executionStatus: "succeeded" });
const rev = items.create({
  title: "レビュー: smoke",
  kind: "leaf",
  status: "classified",
  disposition: "escalate",
  reviewOfId: src.id,
});
assert.ok(inQueue(src.id) && inQueue(rev.id), "対象とレビューが両方キューに出る");
await actions.acceptHandoff(rev.id);
assert.ok(!inQueue(rev.id), "レビューが畳まれる");
assert.ok(!inQueue(src.id), "対象も束で畳まれる");
assert.equal(items.get(rev.id)!.status, "done");
assert.ok(items.get(src.id)!.receivedAt != null, "対象に receivedAt が立つ");
assert.equal(labels.lastForItem(src.id)!.action, "receive", "対象側にも receive ラベル");

// --- 7) undo 非対象 action は label を消さない -----------------------------
const u = items.create({ title: "smoke:undo-guard", kind: "leaf", status: "classified" });
items.update(u.id, { disposition: "escalate" });
labels.record({ itemId: u.id, action: "approve" });
actions.undoLastLabel(u.id);
assert.equal(labels.forItem(u.id).length, 1, "非対象(approve)の label は削除されない");

// --- 8) send_back(着手後) の undo は succeeded/done に復元(自動再実行しない) ---
const sb = items.create({ title: "smoke:sendback", kind: "leaf", status: "done" });
items.update(sb.id, {
  autoExecuted: true,
  executionStatus: "succeeded",
  disposition: "auto",
  confidence: 0.9,
  reversibility: 0.9,
  stakes: 0.1,
  domain: "general",
  category: "smoke",
});
await actions.sendBack(sb.id);
assert.equal(items.get(sb.id)!.kind, "node", "send_back で node へ降格");
actions.undoLastLabel(sb.id);
const sb2 = items.get(sb.id)!;
assert.equal(sb2.executionStatus, "succeeded", "undo で succeeded に復元(none に戻さない)");
assert.equal(sb2.status, "done");
assert.equal(sb2.autoExecuted, true, "掃き出しループの自動再実行対象に落ちない");

console.log("smoke OK: migration v4 / receive 終端 / reject 終端 / レビュー束 / undo 逆適用");
