import { useEffect, useState } from "react";
import { deriveHeaderCounts } from "../lib/header-counts.js";
import type { AppState } from "../types.js";

// ヘッダ集計: 実行中N/承認待ちM/引き取り待ちK(ブラウザを開けば必ず目に入るよう常時表示)。
// 導出は lib/header-counts.ts。ここは1秒 tick で再描画して最長経過秒を進めるだけ。
export function HeaderCounts({ state }: { state: AppState }) {
  const { running, proposed, handoff, over, longestSec } = deriveHeaderCounts(state, Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (running <= 0) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  return (
    <span
      className={`header-counts${over ? " over" : ""}`}
      title={over ? "実行中が worker 上限を超えています(止めはしません)" : "実行中 / 承認待ち / 引き取り待ち"}
    >
      実行中 {running}
      {running > 0 ? `（最長 ${longestSec}s）` : ""} / 承認待ち {proposed} / 引き取り待ち {handoff}
    </span>
  );
}
