// 案件レーン分け (ProjectLanes から抽出した純ロジック)。未所属は Inbox レーン。
// 見出しには件数進捗でなく「滞留」(escalate の本数と最長 ageDays)だけを添える
// (背骨: 処理量メトリクスを出さない)。
import type { Project, QueueItem } from "../types.js";

/** 未所属レーンの内部キー。 */
export const INBOX_KEY = "__inbox__";

export interface ProjectLane<T> {
  key: string;
  name: string;
  cards: T[];
  /** 滞留の一行 (エスカレなしなら空文字=非表示)。 */
  stagnation: string;
}

/**
 * カード列(サーバ score 順)を案件レーンへ分ける。
 * Inbox を末尾、それ以外は案件名順。各レーン内はサーバ score 順(cards 配列順)を保つ。
 */
export function groupByProject<T extends Pick<QueueItem, "projectId" | "disposition" | "ageDays">>(
  cards: T[],
  projects: Pick<Project, "id" | "name">[],
): ProjectLane<T>[] {
  const groups = new Map<string, T[]>();
  for (const q of cards) {
    const key = q.projectId ?? INBOX_KEY;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(q);
  }
  const nameOf = (key: string): string =>
    key === INBOX_KEY
      ? "未所属（Inbox）"
      : (projects.find((p) => p.id === key)?.name ?? "（不明な案件）");
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === INBOX_KEY) return 1;
    if (b === INBOX_KEY) return -1;
    return nameOf(a).localeCompare(nameOf(b), "ja");
  });
  return keys.map((key) => {
    const lane = groups.get(key)!;
    const escal = lane.filter((q) => q.disposition === "escalate");
    const maxAge = escal.reduce((m, q) => Math.max(m, q.ageDays ?? 0), 0);
    const stagnation =
      escal.length > 0
        ? `エスカレ ${escal.length}件${maxAge > 0 ? `・最長 ${Math.round(maxAge)}日 滞留` : ""}`
        : "";
    return { key, name: nameOf(key), cards: lane, stagnation };
  });
}
