// 「雑に貼る」入口の小道具。本文(会話ログ/メモ)の先頭から暫定タイトルを機械生成する。
// クライアント(AddItem)とサーバ(routes/classifier)で同一ロジックを使い、
// 「このタイトルは暫定か?」の判定がドリフトしないようにする。web 側にも同じ関数を置く。

/** 本文の先頭の非空行を trim して 60 字に切る。空なら空文字。AI不要・決定論的。 */
export function provisionalTitle(text: string): string {
  const line = (text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return (line ?? "").slice(0, 60);
}

/** タイトルが本文先頭からの機械切り出し(=暫定)に一致するか。AI要約での上書き可否に使う。 */
export function isProvisionalTitle(title: string, body: string): boolean {
  const b = (body ?? "").trim();
  if (!b) return false; // 本文なし(=一行タスク)は暫定でない。タイトルを尊重する。
  return (title ?? "").trim() === provisionalTitle(b);
}

/**
 * カテゴリ名の機械的な表記揺れを吸収する正規化 (揺れ補正の軽量層)。
 * 完全一致SQL (rules/category_stats) でバケットが割れるのを防ぐ。AI不要・決定論的。
 * ここがやるのは「機械的な揺れ」だけ — 意味の寄せ込み(同義語の統合)はしない。
 * それは分類プロンプトに既存カテゴリ一覧を見せて再利用させる側(案A)の仕事。
 * - Unicode NFKC: 全角英数/記号・互換文字を統一 (「ＡＰＩ」→「API」)。
 * - 連続空白を1つに畳み、前後を trim。
 * - 前後の引用符・括弧の装飾を剥がす (AIが時々付けてくる「…」や"…")。
 * 大文字小文字は畳まない(英字頭字語の表示を壊さない/意味の寄せ込みは案A側)。
 */
/**
 * confidence をビン(0..4)へ写す (§3.6 ビン較正のキー)。floor(clamp01(conf)*5) を 0..4 に
 * clamp。null/未定義は中央ビンへ寄せず、呼び出し側で rawConfidence ?? confidence を渡す前提。
 * AI不要・決定論的。
 */
export function confBinOf(conf: number | null | undefined): number {
  const c = typeof conf === "number" && isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;
  return Math.max(0, Math.min(4, Math.floor(c * 5)));
}

export function normalizeCategory(raw: string): string {
  return (raw ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`「『（(\[]+/, "")
    .replace(/["'`」』）)\]]+$/, "")
    .trim();
}
