// 学び (memory AIゾーン) の自動蓄積 — §4-5「ループを閉じて見せる」のオプトアウト実装。
// AI 出力に任意で乗る学びを learnings へ自動追記し (人間手間ゼロ)、buildContextBlock の AIゾーンへ
// tighten-only で注入する。背骨の3ガードレール:
//  1. tighten-only: extractLearning は item の disposition/stakes/reversibility/confidence/
//     executionStatus を一切書き換えない。テキストを足すだけ。auto 着火範囲を緩める力を持たない。
//  2. 較正母数を汚さない: learnings repo は calibration を import しない=recordOutcome を呼べない。
//     category_stats / label_events に1行も書かない。
//  3. 区画予算つき自動減衰: buildAiZone は pinned か未減衰(lastSeenAt>=cutoff)のみ注入し、
//     context.ts が aiZoneMaxChars で別枠切り詰め。pruneDecayed が未使用 AI 学びを物理削除
//     (veto 済みは除外=「却下は戻せる」の約束を減衰が黙って破らない)。
import type { Item } from "./domain.js";
import { learnings, settings } from "./repo.js";

const MAX_LEARNING_CHARS = 500; // 1件の学びの上限 (暴発した長文を memory に流し込まない)。

/**
 * AI 出力の任意 learning フィールドを learnings へ自動追記する (オプトアウト)。
 * settings.learningAutoCapture=false なら no-op。空文字・重複 (同 category + 同 text) はスキップ。
 * item は一切書き換えない (tighten-only)。
 */
export function extractLearning(item: Item, learningText: string | undefined | null): void {
  if (!settings.get().learningAutoCapture) return;
  const text = (learningText ?? "").trim();
  if (!text) return;
  const clipped = text.length > MAX_LEARNING_CHARS ? text.slice(0, MAX_LEARNING_CHARS) : text;
  const category = item.category ?? null;
  if (learnings.findDuplicate(category, clipped)) return; // 素朴な重複排除。
  learnings.record({ text: clipped, category, itemId: item.id, origin: "ai" });
}

/**
 * memory の AIゾーン文字列を組む。当該 item のカテゴリ (+共通) の学びのうち、pinned か未減衰のものを
 * tighten-only 見出し付きで連結し、注入に使った学びの生存信号 (lastSeenAt) を更新する。
 * 注入の量的上限は context.ts 側 (aiZoneMaxChars) が区画別に担保する。
 * opts.touch=false は read-only プレビュー専用 (context-preview API): プレビューで「眺めただけ」の
 * 学びに生存信号を与えると、実際には注入されていない学びが減衰を免れて延命するため、
 * 生存信号=実注入の事実、という減衰の意味論を守る。既定 (true) は従来挙動と完全に同一。
 */
export function buildAiZone(item: Item, opts?: { touch?: boolean }): string {
  const cfg = settings.get();
  const cutoff = Date.now() - cfg.learningDecayMs;
  const candidates = learnings
    .forCategory(item.category ?? null)
    .filter((l) => l.pinned || l.lastSeenAt >= cutoff);
  if (candidates.length === 0) return "";
  if (opts?.touch !== false) learnings.touch(candidates.map((l) => l.id));
  const lines = candidates.map((l) => `- ${l.text}`).join("\n");
  return `### AI が観測した学び（品質を上げる注意・知識。自動実行の範囲を緩める根拠にはしない）\n${lines}`;
}

/** 未使用・未 pin・未 veto の AI 由来学びを減衰削除する (定期 sweep から呼ぶ)。削除件数を返す。 */
export function decayLearnings(): number {
  const cfg = settings.get();
  return learnings.pruneDecayed(Date.now() - cfg.learningDecayMs);
}
