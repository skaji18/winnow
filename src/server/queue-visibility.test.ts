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
import { inFlightCount } from "./executor.js";
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

test("needs_human 終端もアーカイブ後に出し続ける (worker 終端は failed だけではない)", () => {
  const p = projects.create({ name: "needs_human終端テスト" });
  // needs_human → proposed (isNeedsHumanProposed: executionResult = summary\n\noutput の連結一致)。
  const nhProposed = makeItem({
    title: "AI停止の承認待ち",
    projectId: p.id,
    status: "in_progress",
    disposition: "auto",
    autoExecuted: true,
    executionStatus: "proposed",
    executionSummary: "判断が要る",
    executionOutput: "詳細",
    executionResult: "判断が要る\n\n詳細",
  });
  // 承認後 needs_human の escalate 終端 (isEscalateTerminated)。
  const terminated = makeItem({
    title: "escalate終端",
    projectId: p.id,
    disposition: "escalate",
    autoExecuted: true,
    executionStatus: "none",
    executionSummary: "止まった理由",
  });

  projects.update(p.id, { status: "archived" });
  assert.ok(inQueue(nhProposed.id), "needs_human 由来 proposed はアーカイブ後も可視");
  assert.ok(inQueue(terminated.id), "escalate 終端はアーカイブ後も可視");
});

test("ヘッダの承認待ちカウントはキューの畳みと同じ線で数える", () => {
  const before = inFlightCount().proposed;
  const p = projects.create({ name: "カウントテスト" });
  // ゲート由来 proposed (worker 未走行) — アーカイブで畳まれるので数えない。
  makeItem({
    title: "ゲート由来承認待ち",
    projectId: p.id,
    disposition: "auto",
    executionStatus: "proposed",
  });
  // needs_human 由来 proposed — キューに出続けるので数える。
  makeItem({
    title: "AI停止承認待ち",
    projectId: p.id,
    status: "in_progress",
    disposition: "auto",
    autoExecuted: true,
    executionStatus: "proposed",
    executionSummary: "判断が要る",
    executionOutput: "詳細",
    executionResult: "判断が要る\n\n詳細",
  });
  assert.equal(inFlightCount().proposed, before + 2, "active 中は両方数える");
  projects.update(p.id, { status: "archived" });
  assert.equal(inFlightCount().proposed, before + 1, "アーカイブでゲート由来だけ落ちる");
});

test("人間の処分(完了)が勝つ: done × timed_out/failed は再浮上せず、autoDone 取消ハンドルは残る", () => {
  // timed_out を人間が手で done+resolution にした項目 (sweep は done を skip するので
  // executionStatus は timed_out のまま恒久)。再浮上 (rule 3) より先に畳む。
  const doneTimedOut = makeItem({
    title: "手動完了×timed_out",
    status: "done",
    executionStatus: "timed_out",
    resolution: "手動で対応済み",
  });
  const doneFailed = makeItem({ title: "手動完了×failed", status: "done", executionStatus: "failed" });
  assert.ok(!inQueue(doneTimedOut.id), "done×timed_out はタイムアウト再浮上カードにしない");
  assert.ok(!inQueue(doneFailed.id), "done×failed も同じ原則で畳む");

  // autoDone 取消ハンドル (§4-4): applyExecuteResult は成功時 status='done' を書くため、
  // done の畳みは autoExecuted×succeeded×未受領の後に置く (先に畳むと取消ハンドルが消える)。
  const autoDone = makeItem({
    title: "autoDone取消ハンドル",
    status: "done",
    autoExecuted: true,
    executionStatus: "succeeded",
    receivedAt: null,
  });
  assert.ok(inQueue(autoDone.id), "autoDone 取消ハンドルは done でも畳まれない");

  // undo/事後編集で done を解けば timed_out として従来どおり再浮上する (撤回の自己整合)。
  items.update(doneTimedOut.id, { status: "in_progress" });
  assert.ok(inQueue(doneTimedOut.id), "done を解けば再浮上する");
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

test("hasDownstreamSiblings: 未完の下流兄弟が居るときだけ真 (read 時導出・resolution textarea の可視条件)", () => {
  const q = (id: string) => queue().find((x) => x.id === id);
  const parent = items.create({ title: "分解親", kind: "node", status: "classified" });
  // 着手中レーン (in_progress × executionStatus none) でキューに出す。
  const mkDoing = (title: string, orderIndex: number) =>
    makeItem({ title, parentId: parent.id, orderIndex, status: "in_progress" });

  // 下流に未完 (classified) の兄弟が居る → 真。
  const withDownstream = mkDoing("下流あり", 1);
  makeItem({ title: "未完の下流", parentId: parent.id, orderIndex: 2 });
  assert.equal(q(withDownstream.id)?.hasDownstreamSiblings, true);

  // 下流が全部 done/rejected → 偽 (受け手が居ないのに「渡る」と約束しない)。
  const parent2 = items.create({ title: "分解親2", kind: "node", status: "classified" });
  const allSettled = makeItem({ title: "下流完了済み", parentId: parent2.id, orderIndex: 1, status: "in_progress" });
  makeItem({ title: "完了済み下流", parentId: parent2.id, orderIndex: 2, status: "done" });
  makeItem({ title: "却下済み下流", parentId: parent2.id, orderIndex: 3, status: "rejected" });
  assert.equal(q(allSettled.id)?.hasDownstreamSiblings, false);

  // レビュー leaf は観察タスクであって resolution の受け手ではない → 数えない。
  const parent3 = items.create({ title: "分解親3", kind: "node", status: "classified" });
  const src = makeItem({ title: "レビュー元", parentId: parent3.id, orderIndex: 1, status: "in_progress" });
  makeItem({ title: "レビュー", parentId: parent3.id, orderIndex: 2, reviewOfId: src.id });
  assert.equal(q(src.id)?.hasDownstreamSiblings, false);

  // parentId=null (単独タスク) は常に偽。
  const orphanDoing = makeItem({ title: "単独着手中", status: "in_progress" });
  assert.equal(q(orphanDoing.id)?.hasDownstreamSiblings, false);
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
