// 遅着 sentinel 取り込みの終端保護 (docs/DECISIONS.md「人間実施の結果の下流受け渡し」/
// docs/INVARIANTS.md「人間の処分（rejected / done）を sweep / reconcile が上書きしない」)。
// timed_out を人間が手で done+resolution にした後、遅れて届いた worker 応答が
// applyExecuteResult で status/成果列を全面上書きすると「結果は書いてあるのに承認待ち」の
// 矛盾レコードになる — rejected と同様に item への反映だけを skip し、job は決着のみ。
// done を解けば sentinel は残っているので従来どおり回収される (成果は失われない)。
import "./testing/tmp-home.js"; // ← 必ず先頭: executor → repo → db が WINNOW_HOME を読む
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";
import { sweepLateExecutions, reconcileOnBoot } from "./executor.js";
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

test("reconcileOnBoot: running のまま跨いだ item を人間が done にしていたら job だけ決着させ item は触らない", () => {
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

  reconcileOnBoot();
  const cur = items.get(it.id)!;
  assert.equal(cur.status, "done", "人間の完了を上書きしない (rejected と対称)");
  assert.equal(cur.executionStatus, "running", "item には反映しない");
  assert.equal(cur.resolution, "外で対応済み");
  assert.equal(cur.executionSummary, null, "sentinel の成果を取り込まない");
  const curJob = jobs.latestExecuteForItem(it.id)!;
  assert.equal(curJob.id, job.id);
  assert.equal(curJob.status, "failed", "job は決着させる (running のまま残さない=二度と拾わない)");
});
