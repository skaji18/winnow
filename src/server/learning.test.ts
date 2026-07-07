// 学び (memory AIゾーン) の減衰と veto の決定論テスト。
// SettingsView の「却下は戻せる」約束を減衰の物理削除が黙って破らない事を固定する:
// - pruneDecayed は veto 済みを対象外にする (veto で touch が止まり lastSeenAt が凍結しても
//   減衰期間経過で行ごと消えない=「戻す」機会が失われない)。
// - setVetoed(false) (復帰) は lastSeenAt をいまに置き直す (凍結値のままだと減衰期間を跨いだ
//   復帰が「注入候補に戻らない+次の sweep で即削除」になり、復帰が実質機能しない)。
import "./testing/tmp-home.js"; // ← 必ず先頭: repo.js → db.js が WINNOW_HOME を読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { learnings } from "./repo.js";
import { db } from "./db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** lastSeenAt を過去へ倒す (veto 中は touch が走らず凍結する状況の再現)。 */
function backdate(id: string, ms: number): void {
  db.prepare("UPDATE learnings SET lastSeenAt = ? WHERE id = ?").run(Date.now() - ms, id);
}

test("pruneDecayed: veto 済み AI 学びは減衰期間を過ぎても物理削除しない(「戻せる」を守る)", () => {
  const vetoed = learnings.record({ text: "却下された学び(残る)", origin: "ai" });
  const stale = learnings.record({ text: "未使用の学び(消える)", origin: "ai" });
  const pinned = learnings.record({ text: "固定された学び(残る)", origin: "ai", pinned: true });
  learnings.setVetoed(vetoed.id, true);
  for (const l of [vetoed, stale, pinned]) backdate(l.id, 90 * DAY_MS);

  const removed = learnings.pruneDecayed(Date.now() - 30 * DAY_MS);

  assert.equal(removed, 1, "未使用・未pin・未veto の1件だけが減衰削除されるはず");
  const remaining = new Set(learnings.all().map((l) => l.id));
  assert.ok(remaining.has(vetoed.id), "veto 済みが物理削除された(「却下は戻せる」が黙って破れる)");
  assert.ok(remaining.has(pinned.id), "pinned が物理削除された(減衰停止の約束が破れた)");
  assert.ok(!remaining.has(stale.id), "未使用の AI 学びが減衰削除されていない");
});

test("setVetoed(false): 復帰は lastSeenAt を洗い直し、減衰期間を跨いでも注入候補と生存に戻る", () => {
  const l = learnings.record({ text: "復帰テストの学び", category: null, origin: "ai" });
  learnings.setVetoed(l.id, true);
  backdate(l.id, 90 * DAY_MS); // veto 中の凍結を再現 (減衰 cutoff 既定30日より十分過去)。
  const frozen = learnings.all().find((x) => x.id === l.id)!.lastSeenAt;

  learnings.setVetoed(l.id, false); // 「却下中（戻す）」
  const restored = learnings.all().find((x) => x.id === l.id);
  assert.ok(restored && !restored.vetoed, "veto が解除されていない");
  assert.ok(restored.lastSeenAt > frozen, "復帰で lastSeenAt が洗われていない(凍結のまま)");
  // 復帰直後の sweep で即削除されない (=復帰が実質機能する)。
  learnings.pruneDecayed(Date.now() - 30 * DAY_MS);
  assert.ok(
    learnings.all().some((x) => x.id === l.id),
    "復帰直後の減衰 sweep で削除された(「戻す」が機能していない)",
  );
});

test("setVetoed(true): 却下は lastSeenAt を洗わない(却下操作で減衰を延命しない)", () => {
  const l = learnings.record({ text: "却下側テストの学び", origin: "ai" });
  backdate(l.id, 10 * DAY_MS);
  const before = learnings.all().find((x) => x.id === l.id)!.lastSeenAt;
  learnings.setVetoed(l.id, true);
  assert.equal(
    learnings.all().find((x) => x.id === l.id)!.lastSeenAt,
    before,
    "却下操作が lastSeenAt を更新した(生存信号の意味論が崩れる)",
  );
});
