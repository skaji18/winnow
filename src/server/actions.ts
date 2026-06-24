import { recordOutcome } from "./calibration.js";
import type { Disposition, Item, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import * as executor from "./executor.js";
import { items, labels, rules } from "./repo.js";

// 処分=ラベル (REQUIREMENTS §4-1). 各項目の操作はそのまま教師信号になる。
// 「やる / 下段へ降ろす / 分類し直す / この種類はもう上げるな」。追加労力ゼロ。

/** やる: 人間が引き取って着手。AIの仕分けを是認したことになる。 */
export function doIt(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  labels.record({
    itemId,
    action: "do",
    fromDisposition: item.disposition,
    toDisposition: "human",
    category: item.category,
  });
  recordOutcome(item.category, item.disposition, item.disposition); // 是認=agreed
  return items.update(itemId, { status: "in_progress" });
}

/** 下段へ降ろす: 抽象度を一段下げる (§2.2 量は下段へ流す)。 */
export function demote(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  const idx = RUNGS.indexOf(item.rung);
  const next: Rung = RUNGS[Math.min(idx + 1, RUNGS.length - 1)]!;
  labels.record({ itemId, action: "demote", category: item.category });
  return items.update(itemId, { rung: next });
}

/** 分類し直す: 人間が disposition を覆す。境界線への明示ナッジ＝教師信号。 */
export function reclassify(itemId: string, to: Disposition): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  const from = item.disposition;
  labels.record({
    itemId,
    action: from === to ? "reclassify" : "override",
    fromDisposition: from,
    toDisposition: to,
    category: item.category,
  });
  recordOutcome(item.category, from, to); // 覆し=overturned (一致なら agreed)
  return items.update(itemId, { disposition: to, humanOverrode: from !== to });
}

/** この種類はもう上げるな: カテゴリを自動に倒す明示ルール (§4-1, §3.6-1)。 */
export function muteCategory(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item || !item.category) return item ?? null;
  rules.upsert({
    category: item.category,
    forcedDisposition: "auto",
    source: "manual",
    note: "この種類はもう上げるな(手動)",
  });
  labels.record({
    itemId,
    action: "mute_category",
    fromDisposition: item.disposition,
    toDisposition: "auto",
    category: item.category,
  });
  return items.update(itemId, { disposition: "auto" });
}

export function reject(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  labels.record({ itemId, action: "reject", fromDisposition: item.disposition, category: item.category });
  return items.update(itemId, { status: "rejected" });
}

export async function approve(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  labels.record({ itemId, action: "approve", category: item.category });
  return executor.approveExecution(itemId);
}

/**
 * 監査の確認 (§3.6-2, §4-3). 自動処理が妥当だったか/誤りだったか。
 * 過小エスカレーション(自動の誤り)は高く遅れて危険に出るので、見つけたら即締める。
 */
export function auditConfirm(itemId: string, ok: boolean): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  if (ok) {
    labels.record({ itemId, action: "audit_ok", fromDisposition: "auto", category: item.category });
    recordOutcome(item.category, "auto", "auto");
    return items.update(itemId, { auditSampled: false });
  }
  labels.record({
    itemId,
    action: "audit_bad",
    fromDisposition: "auto",
    toDisposition: "escalate",
    category: item.category,
  });
  recordOutcome(item.category, "auto", "escalate", { auditBad: true });
  return items.update(itemId, {
    auditSampled: false,
    disposition: "escalate",
    humanOverrode: true,
  });
}
