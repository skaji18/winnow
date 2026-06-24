import { randomUUID } from "node:crypto";
import { ensureDriver } from "./ai/index.js";
import { classify } from "./classifier.js";
import { promotePrompt } from "./ai/prompts.js";
import type { Item, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import { items, jobs } from "./repo.js";

// 昇格判定 (REQUIREMENTS §3.3-3). 出てきた子に「まだ問いか/もう実行可能か」を
// 付け直す。これが無いと子が無限に問いのまま降りてこない。

export async function judge(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  const driver = await ensureDriver();
  const job = jobs.create({
    itemId,
    role: "control",
    kindOfWork: "promote",
    sessionName: null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    output: null,
    error: null,
  });

  const res = await driver.dispatch({
    id: randomUUID(),
    role: "control",
    label: `昇格判定: ${item.title.slice(0, 30)}`,
    prompt: promotePrompt(item),
    expectJson: true,
    timeoutMs: 90_000,
  });

  jobs.update(job.id, {
    sessionName: res.sessionName,
    status: res.ok ? "succeeded" : "failed",
    finishedAt: Date.now(),
    output: res.raw,
    error: res.error ?? null,
  });

  if (!res.ok) return item;
  const d = res.data as { kind?: string; rung?: string; executable?: boolean };
  const rung: Rung = RUNGS.includes(d.rung as Rung) ? (d.rung as Rung) : item.rung;
  const kind = d.executable || d.kind === "leaf" ? "leaf" : "node";
  // 葉に降りてきたら三値を葉の文脈で付け直す (§3.3 '割る→実行可能?を付け直す').
  // 放置すると node 時代の古いスコアが残り executor.requestExecution がそれで門番してしまう。
  // decomposer.applyOption が子を再分類するのと同じ挙動を promote のみの経路にも揃える。
  const updated = items.update(itemId, { kind, rung });
  if (kind === "leaf" && (item.kind !== "leaf" || updated?.reversibility == null || updated?.stakes == null))
    return await classify(updated!.id);
  return updated;
}
