import { groupByProject } from "../lib/project-lanes.js";
import type { AppState, QueueItem } from "../types.js";

// 案件レーン: キュー(エスカレ)を案件でまとめる。レーン分け・滞留一行の導出は lib/project-lanes.ts。
export function ProjectLanes({
  cards,
  state,
  renderCard,
}: {
  cards: QueueItem[];
  state: AppState;
  // null = 束ね描画で対象カード側に吸収済み(スキップ)。
  renderCard: (q: QueueItem) => JSX.Element | null;
}) {
  return (
    <>
      {groupByProject(cards, state.projects).map(({ key, name, cards: lane, stagnation }) => (
        <details className="lane-section" key={key} open>
          <summary className="lane-head">
            <b>{name}</b>
            {stagnation && <span className="muted"> （{stagnation}）</span>}
          </summary>
          {lane.map(renderCard)}
        </details>
      ))}
    </>
  );
}
