import { db } from "./db.js";
import { rules } from "./repo.js";

// ループを閉じて見せる (REQUIREMENTS §4-5). 週次で一行:
// 「今週: 自動X / 上げY / あなたが覆したZ / カテゴリKを自動に倒した」。
// 訂正が複利で効いているのが見えないと、人は監査税を払い続けない。

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklySummary {
  auto: number;
  escalated: number;
  overridden: number;
  audited: number;
  tippedCategories: string[];
  line: string;
}

export function weekly(): WeeklySummary {
  const since = Date.now() - WEEK_MS;

  const count = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { c: number }).c;

  const auto = count(
    "SELECT COUNT(*) AS c FROM items WHERE disposition='auto' AND updatedAt>=?",
    since,
  );
  const escalated = count(
    "SELECT COUNT(*) AS c FROM items WHERE disposition='escalate' AND updatedAt>=?",
    since,
  );
  const overridden = count(
    "SELECT COUNT(*) AS c FROM label_events WHERE action = 'override' AND createdAt>=?",
    since,
  );
  const audited = count(
    "SELECT COUNT(*) AS c FROM label_events WHERE action IN ('audit_ok','audit_bad') AND createdAt>=?",
    since,
  );

  const tippedCategories = rules
    .all()
    .filter((r) => r.source === "learned" && r.active && r.createdAt >= since)
    .map((r) => `${r.category}→${r.forcedDisposition}`);

  const tip =
    tippedCategories.length > 0 ? ` / 自動較正: ${tippedCategories.join(", ")}` : "";
  const line = `今週: 自動${auto} / 上げ${escalated} / あなたが覆した${overridden} / 監査${audited}${tip}`;

  return { auto, escalated, overridden, audited, tippedCategories, line };
}
