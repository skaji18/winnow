import { categoryStats, rules } from "./repo.js";
import type { Disposition } from "./domain.js";

// 自己較正=地味な簿記 (REQUIREMENTS §3.6). ゼロから方策を学ばない。明示ルールが先、
// 残差だけをカテゴリ別の基準率補正(カウント)で倒す。浅くて頑健。

const MIN_SAMPLES = 5;
const OVERTURN_TO_AUTO = 0.8; // 「カテゴリXでescalateを8割却下→自動に倒す」(§3.6-1)

/**
 * 人間のさばき結果を記録する。AIの提案と人間の最終判断が一致したか/覆ったか。
 * 信号の非対称 (§3.6-3): 過小エスカレーション(auto事故)は高く遅れて危険に出る。
 * よって audit_bad は即座に締め(learned rule で escalate 固定)。
 */
export function recordOutcome(
  category: string | null,
  aiDisposition: Disposition | null,
  humanFinal: Disposition,
  opts: { auditBad?: boolean } = {},
): void {
  if (!category || !aiDisposition) return;
  if (aiDisposition === humanFinal) {
    categoryStats.bump(category, aiDisposition, "agreed");
  } else {
    categoryStats.bump(category, aiDisposition, "overturned");
  }

  // 締めるのは速く: 自動が事故ったら、そのカテゴリは即 escalate 固定の learned rule。
  if (opts.auditBad) {
    rules.upsert({
      category,
      forcedDisposition: "escalate",
      source: "learned",
      note: "監査で自動処理の誤りを検出→安全側に締め",
    });
    return;
  }

  // 緩めるのは慎重に: 十分なサンプルで escalate が一貫して却下(=autoで足りた)なら自動に倒す。
  const stats = categoryStats.forCategory(category);
  const esc = stats.find((s) => s.aiDisposition === "escalate");
  if (esc) {
    const total = esc.agreed + esc.overturned;
    if (total >= MIN_SAMPLES && esc.overturned / total >= OVERTURN_TO_AUTO) {
      const existing = rules.forCategory(category);
      if (!existing) {
        rules.upsert({
          category,
          forcedDisposition: "auto",
          source: "learned",
          note: `escalateの${Math.round((esc.overturned / total) * 100)}%が却下(n=${total})→自動に倒す`,
        });
      }
    }
  }
}

/** AIの提案を、明示ルール→基準率補正の順で最終決定に変換する (§3.6-1). */
export function applyRulesAndCalibration(
  category: string | null,
  proposed: Disposition,
): { disposition: Disposition; note: string | null } {
  if (!category) return { disposition: proposed, note: null };

  // 1. 明示ルールが最優先 (manual/learned 問わず active なもの)。
  const rule = rules.forCategory(category);
  if (rule) {
    return {
      disposition: rule.forcedDisposition,
      note: `ルール(${rule.source}): ${rule.note ?? category}`,
    };
  }
  return { disposition: proposed, note: null };
}
