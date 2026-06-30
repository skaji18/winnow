// 中長期 horizon (§2.3) — rung × due の読み取り専用ビュー。Gantt(確定日付コミット)ではなく、
// 上段(霧/戦略)ほど due をぼかし、下段 leaf のみ鋭い due を出す。完了線/残数/消化率/burndown は
// 一切持たない (背骨: 処理量メトリクス禁止)。較正母数(recordOutcome/labels/category_stats)に触れない。
import { items } from "./repo.js";
import type { Item, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import { DAY_MS, DUE_SOON_DAYS, DUE_WEEK_DAYS } from "./queue.js";

export type DueBucket = "over" | "soon" | "week" | "later" | "unknown";

export interface HorizonEntry {
  id: string;
  title: string;
  rung: Rung;
  dueDate: number | null; // 自前の生 due (leaf 実行段のみ鋭い日付として表示する)
  effectiveDue: number | null; // node は子 leaf の due を巻き上げた値 (表示層のみ)
  sharp: boolean; // true=鋭い日付を出してよい(leaf 実行段) / false=上段はバケットラベルのみ
}

export interface HorizonCell {
  rung: Rung;
  dueBucket: DueBucket;
  entries: HorizonEntry[];
  // ※ 件数進捗 (count/remaining/percentDone/burndown) を絶対に持たせない。
}

function bucketOf(effectiveDue: number | null): DueBucket {
  if (effectiveDue == null) return "unknown";
  const days = (effectiveDue - Date.now()) / DAY_MS;
  if (days < 0) return "over";
  if (days < DUE_SOON_DAYS) return "soon";
  if (days < DUE_WEEK_DAYS) return "week";
  return "later";
}

// 鋭い日付を出してよいのは下段の実行 leaf のみ。上段(node / execution 以外)はぼかす。
function isSharp(it: Item): boolean {
  return it.kind === "leaf" && it.rung === "execution";
}

const isOpen = (it: Item): boolean => it.status !== "done" && it.status !== "rejected";

/**
 * 子 leaf の due を親 node へ巻き上げる (context.ts の親チェーン走法の鏡像=子→親)。
 * 返すのは「その項目以下のサブツリーで最も早い due」。item.dueDate には書き戻さない
 * (effectiveDue は表示層のみ。scoreItem の dueBoost 挙動を汚さない)。
 */
function rollupDue(
  id: string,
  childrenOf: Map<string, Item[]>,
  ownDue: Map<string, number | null>,
  memo: Map<string, number | null>,
  seen: Set<string>,
): number | null {
  if (memo.has(id)) return memo.get(id)!;
  if (seen.has(id)) return null; // 循環ガード
  seen.add(id);
  let min: number | null = ownDue.get(id) ?? null;
  for (const c of childrenOf.get(id) ?? []) {
    const childDue = rollupDue(c.id, childrenOf, ownDue, memo, seen);
    if (childDue != null && (min == null || childDue < min)) min = childDue;
  }
  seen.delete(id);
  memo.set(id, min);
  return min;
}

export function horizonView(): HorizonCell[] {
  const all = items.all();
  const childrenOf = new Map<string, Item[]>();
  const ownDue = new Map<string, number | null>();
  for (const it of all) {
    ownDue.set(it.id, it.dueDate ?? null);
    if (it.parentId) {
      const arr = childrenOf.get(it.parentId) ?? [];
      arr.push(it);
      childrenOf.set(it.parentId, arr);
    }
  }
  const memo = new Map<string, number | null>();

  // セルを (rung, dueBucket) でバケット化。open な項目のみ。
  const cells = new Map<string, HorizonCell>();
  for (const it of all) {
    if (!isOpen(it)) continue;
    const effectiveDue = it.dueDate ?? rollupDue(it.id, childrenOf, ownDue, memo, new Set());
    const bucket = bucketOf(effectiveDue);
    const key = `${it.rung}|${bucket}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { rung: it.rung, dueBucket: bucket, entries: [] };
      cells.set(key, cell);
    }
    const sharp = isSharp(it);
    cell.entries.push({
      id: it.id,
      title: it.title,
      rung: it.rung,
      dueDate: sharp ? (it.dueDate ?? null) : null, // 上段は鋭い日付を出さない
      effectiveDue,
      sharp,
    });
  }

  // rung 上段→下段、bucket 近い→遠い の決定論順で返す。
  const bucketOrder: DueBucket[] = ["over", "soon", "week", "later", "unknown"];
  return [...cells.values()].sort((a, b) => {
    const r = RUNGS.indexOf(a.rung) - RUNGS.indexOf(b.rung);
    if (r !== 0) return r;
    return bucketOrder.indexOf(a.dueBucket) - bucketOrder.indexOf(b.dueBucket);
  });
}
