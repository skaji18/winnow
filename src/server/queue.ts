import type { Item } from "./domain.js";
import { items } from "./repo.js";

// あなたの「今日なに見る?」ビュー (REQUIREMENTS §4). 火の海ではなく
// エスカレーションだけの短いキュー。自動分は畳む。ただし監査サンプルは
// 見分けのつかない形で混ぜる (§4-3)。

export interface QueueItem extends Item {
  isAudit: boolean;
}

export function queue(): QueueItem[] {
  const all = items.all();
  const visible = all.filter((it) => {
    // 自動実行が成功した分は §4-4「安く取り消せる」ための取消ハンドルとして
    // キューに残す (done でも畳まない)。cancelled は再浮上させない。
    if (it.autoExecuted && it.executionStatus === "succeeded") return true;
    if (it.status === "done" || it.status === "rejected") return false;
    // 提案待ち(不可逆実行のワンタップ承認)は必ず出す
    if (it.executionStatus === "proposed") return true;
    if (it.status !== "classified") return false;
    // エスカレーション/人間案件は出す
    if (it.disposition === "escalate" || it.disposition === "human") return true;
    // 自動だが監査サンプルされたものは「見分けつかない形」で混ぜる (§4-3)
    if (it.disposition === "auto" && it.auditSampled) return true;
    return false;
  });

  // 並び: 人間の注意を寄せる (§2.2)。ステークス高・確信度低を基本に、
  // 優先度と期日(超過/間近)を加点する。
  const PRIO: Record<string, number> = { urgent: 1.5, high: 0.9, normal: 0, low: -0.4 };
  const dueBoost = (x: Item): number => {
    if (x.dueDate == null) return 0;
    const days = (x.dueDate - Date.now()) / 86_400_000;
    if (days < 0) return 1.2; // 期限超過
    if (days < 2) return 0.6; // 間近
    if (days < 7) return 0.2;
    return 0;
  };
  visible.sort((a, b) => {
    const score = (x: Item) =>
      (x.stakes ?? 0.5) + (1 - (x.confidence ?? 0.5)) + (PRIO[x.priority] ?? 0) + dueBoost(x);
    return score(b) - score(a);
  });

  return visible.map((it) => ({ ...it, isAudit: it.disposition === "auto" && it.auditSampled }));
}

/** 自動で畳まれた(キューに出ない)アイテム数。コールドスタート期待値管理に使う。 */
export function autoFoldedCount(): number {
  return items
    .all()
    .filter((it) => it.disposition === "auto" && !it.auditSampled && it.status === "classified")
    .length;
}
