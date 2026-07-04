// groupByProject の決定論テスト: Inbox 末尾・案件名順・レーン内はサーバ順保存・滞留一行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByProject, INBOX_KEY } from "./project-lanes.js";
import type { Disposition } from "../types.js";

function mk(
  id: string,
  projectId: string | null,
  disposition: Disposition | null = null,
  ageDays: number | null = null,
) {
  return { id, projectId, disposition, ageDays };
}

const projects = [
  { id: "p-b", name: "べーた" },
  { id: "p-a", name: "あるふぁ" },
];

test("Inbox は末尾、それ以外は案件名順。レーン内はサーバ順(入力順)を保つ", () => {
  const cards = [mk("1", null), mk("2", "p-b"), mk("3", "p-a"), mk("4", "p-b")];
  const lanes = groupByProject(cards, projects);
  assert.deepEqual(
    lanes.map((l) => l.name),
    ["あるふぁ", "べーた", "未所属（Inbox）"],
  );
  assert.equal(lanes[2]?.key, INBOX_KEY);
  // レーン内はサーバ score 順(cards 配列順)のまま。
  assert.deepEqual(lanes[1]?.cards.map((c) => c.id), ["2", "4"]);
});

test("不明な案件 id は『（不明な案件）』で出る", () => {
  const lanes = groupByProject([mk("1", "ghost")], projects);
  assert.equal(lanes[0]?.name, "（不明な案件）");
});

test("滞留一行: escalate なしは空文字、ありは本数、ageDays>0 で最長日数を添える", () => {
  // escalate なし。
  assert.equal(groupByProject([mk("1", "p-a")], projects)[0]?.stagnation, "");
  // escalate あり・ageDays 0/null → 本数のみ。
  assert.equal(
    groupByProject([mk("1", "p-a", "escalate", null)], projects)[0]?.stagnation,
    "エスカレ 1件",
  );
  // 最長 ageDays は四捨五入して添える。
  assert.equal(
    groupByProject(
      [mk("1", "p-a", "escalate", 1.4), mk("2", "p-a", "escalate", 3.6), mk("3", "p-a")],
      projects,
    )[0]?.stagnation,
    "エスカレ 2件・最長 4日 滞留",
  );
});
