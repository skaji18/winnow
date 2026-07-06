// アーカイブ案件の read 時導出畳み (docs/DECISIONS.md「案件クローズ・バッチ」/
// docs/INVARIANTS.md「キュー可視性の原則」)。
// - 人間の注意・承認要求 (classified escalate/human・監査混入・blocked・proposed・着手中レーン)
//   はアーカイブで畳む。アイテムは変異しない=復元 (active 戻し) だけで再浮上する。
// - 実行系の終端 (awaiting_handoff / failed / timed_out / autoDone 未受領の取消ハンドル) は
//   案件の生死と無関係に出し続ける (§4-4 轢き逃げ防止)。
// - horizon も同じ導出で畳む。projects.remove は projectId だけ外し sprintId に触れない。
import "./testing/tmp-home.js"; // ← 必ず先頭: queue.ts → repo.js → db.js が WINNOW_HOME を読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { queue } from "./queue.js";
import { horizonView } from "./horizon.js";
import { items, projects, sprints } from "./repo.js";
import type { Item } from "./domain.js";

const inQueue = (id: string): boolean => queue().some((q) => q.id === id);

function makeItem(over: Partial<Item> & { title: string; projectId?: string | null }): Item {
  return items.create({
    kind: "leaf",
    rung: "execution",
    status: "classified",
    ...over,
  });
}

test("アーカイブで注意・承認要求は畳まれ、復元で再浮上する (アイテム非変異)", () => {
  const p = projects.create({ name: "畳みテスト" });
  const escalate = makeItem({ title: "エスカレ", projectId: p.id, disposition: "escalate" });
  const human = makeItem({ title: "人間案件", projectId: p.id, disposition: "human" });
  const audit = makeItem({
    title: "監査混入",
    projectId: p.id,
    disposition: "auto",
    auditSampled: true,
  });
  const blocked = makeItem({ title: "保留", projectId: p.id, status: "blocked" });
  const proposed = makeItem({
    title: "承認待ち",
    projectId: p.id,
    disposition: "escalate",
    executionStatus: "proposed",
  });
  const doing = makeItem({ title: "着手中", projectId: p.id, status: "in_progress" });
  const folded = [escalate, human, audit, blocked, proposed, doing];

  for (const it of folded) assert.ok(inQueue(it.id), `active 案件では可視: ${it.title}`);

  projects.update(p.id, { status: "archived" });
  for (const it of folded) assert.ok(!inQueue(it.id), `アーカイブで畳む: ${it.title}`);
  // 畳みは read 時導出 — アイテム行は変異していない。
  for (const it of folded) {
    const cur = items.get(it.id)!;
    assert.equal(cur.status, it.status, `status 非変異: ${it.title}`);
    assert.equal(cur.updatedAt, it.updatedAt, `updatedAt 非変異: ${it.title}`);
  }

  projects.update(p.id, { status: "active" });
  for (const it of folded) assert.ok(inQueue(it.id), `復元で再浮上: ${it.title}`);
});

test("実行系の終端はアーカイブ後も出し続ける (§4-4 轢き逃げ防止)", () => {
  const p = projects.create({ name: "終端テスト" });
  const failed = makeItem({
    title: "実行失敗",
    projectId: p.id,
    disposition: "auto",
    executionStatus: "failed",
  });
  const timedOut = makeItem({
    title: "タイムアウト",
    projectId: p.id,
    disposition: "auto",
    executionStatus: "timed_out",
  });
  const handoff = makeItem({
    title: "引き取り待ち",
    projectId: p.id,
    status: "review",
    executionStatus: "awaiting_handoff",
  });
  const autoDone = makeItem({
    title: "自動完了の取消ハンドル",
    projectId: p.id,
    status: "done",
    disposition: "auto",
    autoExecuted: true,
    executionStatus: "succeeded",
    receivedAt: null,
  });

  projects.update(p.id, { status: "archived" });
  for (const it of [failed, timedOut, handoff, autoDone])
    assert.ok(inQueue(it.id), `アーカイブ後も可視: ${it.title}`);
});

test("案件に属さないアイテムはアーカイブ畳みの影響を受けない", () => {
  const orphan = makeItem({ title: "未所属エスカレ", disposition: "escalate" });
  assert.ok(inQueue(orphan.id));
});

test("horizon もアーカイブ案件配下を畳む (復元で戻る)", () => {
  const p = projects.create({ name: "horizonテスト" });
  const it = makeItem({ title: "horizon項目", projectId: p.id, disposition: "human" });
  const inHorizon = () =>
    horizonView().some((cell) => cell.entries.some((e) => e.id === it.id));

  assert.ok(inHorizon(), "active 案件では horizon に出る");
  projects.update(p.id, { status: "archived" });
  assert.ok(!inHorizon(), "アーカイブで horizon から畳む");
  projects.update(p.id, { status: "active" });
  assert.ok(inHorizon(), "復元で horizon に戻る");
});

test("projects.remove は projectId だけ外し sprintId に触れない", () => {
  const p = projects.create({ name: "削除テスト" });
  const s = sprints.create({ name: "SP" });
  const it = makeItem({ title: "繰越候補", projectId: p.id, sprintId: s.id });

  projects.remove(p.id);
  const cur = items.get(it.id)!;
  assert.equal(cur.projectId, null, "案件参照は外れる (タスクは残る)");
  assert.equal(cur.sprintId, s.id, "時間箱への割当は案件に従属しない");
});
