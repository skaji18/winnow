// ヘッダ集計の導出 (HeaderCounts から抽出した純ロジック)。
// 実行中N/承認待ちM/引き取り待ちK。inFlight(サーバ集計)を優先し、未提供なら items から数える。
import type { AppState, Item } from "../types.js";

/** deriveHeaderCounts が参照する最小形 (AppState の部分集合)。 */
export interface HeaderCountsInput {
  inFlight?: AppState["inFlight"];
  items: Pick<Item, "executionStatus" | "updatedAt">[];
  settings: { maxWorkers: number };
}

export interface HeaderCounts {
  running: number;
  proposed: number;
  /** 引き取り待ち K (§3.5): 実行完了・人間の受領/採用待ち。 */
  handoff: number;
  /** N>maxWorkers のとき薄く色付け(機械ブロックはしない=ナッジ §4)。 */
  over: boolean;
  /**
   * proposal 6: 実行中の最長経過秒。auto 実行はキューに溢れさせない設計なので、ヘッダの
   * この数字が「動いている」唯一の正直な信号になる(running 中は updatedAt≒着火時刻で
   * 固定=近似に使える)。running=0 のときは 0。
   */
  longestSec: number;
}

export function deriveHeaderCounts(state: HeaderCountsInput, now: number): HeaderCounts {
  const running =
    state.inFlight?.running ?? state.items.filter((i) => i.executionStatus === "running").length;
  const proposed =
    state.inFlight?.proposed ?? state.items.filter((i) => i.executionStatus === "proposed").length;
  const handoff =
    state.inFlight?.awaitingHandoff ??
    state.items.filter((i) => i.executionStatus === "awaiting_handoff").length;
  const over = running > state.settings.maxWorkers;
  const longestSec =
    running > 0
      ? Math.floor(
          state.items
            .filter((i) => i.executionStatus === "running")
            .reduce((mx, i) => Math.max(mx, now - i.updatedAt), 0) / 1000,
        )
      : 0;
  return { running, proposed, handoff, over, longestSec };
}
