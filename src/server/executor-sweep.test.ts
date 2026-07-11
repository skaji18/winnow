// worker 応答の終端保護 (docs/DECISIONS.md「人間実施の結果の下流受け渡し」/
// docs/INVARIANTS.md「人間の処分（rejected / done）を worker 応答の item 反映が上書きしない」)。
// timed_out を人間が手で done+resolution にした後、遅れて届いた worker 応答が
// applyExecuteResult で status/成果列を全面上書きすると「結果は書いてあるのに承認待ち」の
// 矛盾レコードになる — rejected と同様に status/resolution/成果列への反映を skip し、job は
// 決着させる。executionStatus='running' だけは timed_out へ降ろす (残すと inFlightCount の
// 幽霊 in-flight が点火予算/自己更新/healthz を恒久的に汚し、回収経路も無い)。
// done を解けば sentinel は残っているので従来どおり回収される (成果は失われない)。
import "./testing/tmp-home.js"; // ← 必ず先頭: executor → repo → db が WINNOW_HOME を読む
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";
import {
  applyExecuteResult,
  inFlightCount,
  sweepLateExecutions,
  reconcileOnBoot,
} from "./executor.js";
import { items, jobs } from "./repo.js";

/** 遅着 done sentinel を IPC ディレクトリへ書く (worker が後から完了したふり)。 */
function writeSentinel(ipcId: string, res: { status: string; summary: string; output: string }): void {
  fs.mkdirSync(PATHS.ipc, { recursive: true });
  fs.writeFileSync(path.join(PATHS.ipc, `${ipcId}.done`), "");
  fs.writeFileSync(path.join(PATHS.ipc, `${ipcId}.res.json`), JSON.stringify(res));
}

test("sweep: timed_out→人間が done にした item は遅着 sentinel で上書きしない (job は決着済みのまま)", () => {
  // timed_out に倒れた後、人間が手で完了+resolution を書いたレコード。
  const it = items.create({
    title: "人間が引き取って完了",
    kind: "leaf",
    status: "done",
    executionStatus: "timed_out",
    resolution: "方式Bで手動対応した",
    executionResult: "実行がタイムアウト上限を超過",
  });
  // timed_out 時点で runExecution が failed で閉じた execute ジョブ (ipcId あり)。
  const job = jobs.create({
    itemId: it.id,
    role: "worker",
    kindOfWork: "execute",
    sessionName: null,
    status: "failed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    output: null,
    error: null,
    ipcId: "late-done-1",
  });
  writeSentinel("late-done-1", { status: "succeeded", summary: "遅着サマリ", output: "遅着本文" });

  const swept = sweepLateExecutions();
  assert.equal(swept.recovered, 0, "done は回収対象にしない");
  const cur = items.get(it.id)!;
  assert.equal(cur.status, "done", "人間の完了を上書きしない");
  assert.equal(cur.executionStatus, "timed_out", "executionStatus も遅着応答で動かさない");
  assert.equal(cur.resolution, "方式Bで手動対応した", "人間の記録 (resolution) が残る");
  assert.equal(cur.executionSummary, null, "worker 成果列を書き込まない");
  assert.equal(jobs.latestExecuteForItem(it.id)!.id, job.id);
  assert.equal(jobs.latestExecuteForItem(it.id)!.status, "failed", "job は決着済みのまま (再オープンしない)");

  // done を解けば timed_out として再び対象になり、sentinel から回収される (成果は失われない)。
  items.update(it.id, { status: "in_progress" });
  const reswept = sweepLateExecutions();
  assert.equal(reswept.recovered, 1, "done を解けば従来どおり回収される");
  const recovered = items.get(it.id)!;
  assert.equal(recovered.executionStatus, "succeeded");
  assert.equal(recovered.executionSummary, "遅着サマリ", "worker 成果が取り込まれる");
  assert.equal(jobs.latestExecuteForItem(it.id)!.status, "succeeded", "job も sentinel で決着し直す");
});

test("sweep: rejected の skip は従来どおり (done 追加で挙動が変わらないことの対称確認)", () => {
  const it = items.create({
    title: "人間が却下",
    kind: "leaf",
    status: "rejected",
    executionStatus: "timed_out",
  });
  jobs.create({
    itemId: it.id,
    role: "worker",
    kindOfWork: "execute",
    sessionName: null,
    status: "failed",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    output: null,
    error: null,
    ipcId: "late-rej-1",
  });
  writeSentinel("late-rej-1", { status: "succeeded", summary: "遅着", output: "遅着" });

  sweepLateExecutions();
  const cur = items.get(it.id)!;
  assert.equal(cur.status, "rejected", "人間の却下を上書きしない");
  assert.equal(cur.executionStatus, "timed_out");
});

test("reconcileOnBoot: running のまま跨いだ item を人間が done にしていたら job を決着させ、item は executionStatus だけ timed_out へ降ろす", () => {
  // 前回プロセスが running のまま死に、その間に人間が PATCH で完了した (executionStatus は
  // running のまま残る) レコード。
  const it = items.create({
    title: "再起動またぎで人間が完了",
    kind: "leaf",
    status: "done",
    executionStatus: "running",
    resolution: "外で対応済み",
  });
  const job = jobs.create({
    itemId: it.id,
    role: "worker",
    kindOfWork: "execute",
    sessionName: null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    output: null,
    error: null,
    ipcId: "boot-done-1",
  });
  writeSentinel("boot-done-1", { status: "succeeded", summary: "遅着サマリ", output: "遅着本文" });

  const runningBefore = inFlightCount().running;
  reconcileOnBoot();
  const cur = items.get(it.id)!;
  assert.equal(cur.status, "done", "人間の完了を上書きしない (rejected と対称)");
  assert.equal(
    cur.executionStatus,
    "timed_out",
    "実行軸だけ timed_out へ降ろす (running 残留=幽霊 in-flight にしない)",
  );
  assert.equal(cur.resolution, "外で対応済み");
  assert.equal(cur.executionSummary, null, "sentinel の成果を取り込まない");
  assert.equal(
    inFlightCount().running,
    runningBefore - 1,
    "点火予算 (maxWorkers - running) を恒久消費しない",
  );
  const curJob = jobs.latestExecuteForItem(it.id)!;
  assert.equal(curJob.id, job.id);
  assert.equal(curJob.status, "failed", "job は決着させる (running のまま残さない=二度と拾わない)");

  // done を解けば timed_out として sweep の対象になり、sentinel から従来どおり回収される
  // (「done を解けば回収される」が reconcile 経路でも成立する)。
  items.update(it.id, { status: "in_progress" });
  const swept = sweepLateExecutions();
  assert.equal(swept.recovered, 1, "undo 後は sentinel から回収される");
  assert.equal(items.get(it.id)!.executionSummary, "遅着サマリ", "worker 成果が取り込まれる");
});

test("reconcileOnBoot: rejected × running も同型に executionStatus だけ timed_out へ降ろす (対称)", () => {
  const it = items.create({
    title: "再起動またぎで人間が却下",
    kind: "leaf",
    status: "rejected",
    executionStatus: "running",
  });
  jobs.create({
    itemId: it.id,
    role: "worker",
    kindOfWork: "execute",
    sessionName: null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    output: null,
    error: null,
    ipcId: "boot-rej-1",
  });

  reconcileOnBoot();
  const cur = items.get(it.id)!;
  assert.equal(cur.status, "rejected", "人間の却下を上書きしない");
  assert.equal(cur.executionStatus, "timed_out", "running を残さない");
});

test("applyExecuteResult: 通常完了経路でも人間の done+resolution を上書きしない (実行軸のみ決着)", () => {
  // worker 実行中 (最長 executeTimeoutMs) に人間が TreeView で resolution を書き
  // board で done にした後、worker が正常完了して応答が届いたケース (再起動なし)。
  const it = items.create({
    title: "実行中に人間が完了",
    kind: "leaf",
    status: "done",
    executionStatus: "running",
    resolution: "人間の決定",
  });
  const out = applyExecuteResult(it.id, {
    status: "succeeded",
    summary: "worker サマリ",
    output: "worker 本文",
    artifacts: ["https://example.com/pr/1"], // handoffRequired を満たす=旧実装なら review×awaiting_handoff に上書きされた
  });
  assert.ok(out);
  const cur = items.get(it.id)!;
  assert.equal(cur.status, "done", "status='review'(引き取り待ち) へ巻き戻さない");
  assert.equal(cur.resolution, "人間の決定", "resolution 注入の前提 (status=done) が消えない");
  assert.equal(cur.executionSummary, null, "worker 成果列を書かない");
  assert.equal(cur.executionStatus, "timed_out", "実行軸のみ running から決着値へ降ろす");
  // 既に決着済み (running でない) の人間処分項目は一切触らない。
  const settled = items.create({
    title: "却下済み×失敗残骸",
    kind: "leaf",
    status: "rejected",
    executionStatus: "failed",
  });
  applyExecuteResult(settled.id, { status: "succeeded", summary: "s", output: "o" });
  const cur2 = items.get(settled.id)!;
  assert.equal(cur2.status, "rejected");
  assert.equal(cur2.executionStatus, "failed", "決着済みの実行軸を timed_out へ巻き戻さない");
});
