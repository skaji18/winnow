// AI op 失敗のエラー種別分類 (REQUIREMENTS §6 経済・クォータ天井)。
// クォータ/レート起因の失敗を job.error に接頭辞付けで残し、/healthz recentFails や
// デバッグで「環境不全(クォータ)」と「他の失敗」を区別できるようにする。
// 残量計は作らない(有料ゾーン手前)。痕跡を残すだけ。

const QUOTA_RE = /quota|rate.?limit|usage limit|overloaded|too many requests|\b429\b|\b529\b/i;

/**
 * 失敗メッセージがクォータ/レート起因なら "quota: ..." 接頭辞付きで返す。
 * それ以外はそのまま返す。null/undefined はそのまま。
 */
export function classifyJobError(raw?: string | null): string | null {
  if (raw == null) return raw ?? null;
  if (QUOTA_RE.test(raw)) return `quota: ${raw}`;
  return raw;
}
