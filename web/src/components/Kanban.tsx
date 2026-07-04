import { useState, type ReactNode } from "react";
import type { Item } from "../types.js";

// 共通カンバン。ネイティブ HTML5 DnD でカードを列間ドラッグ→status変更。
// スプリント板・案件板の両方で使う。カード中身は renderCard で差し替える。

export const COLUMNS: { key: string; label: string; statuses: string[]; drop: string }[] = [
  { key: "todo", label: "未着手", statuses: ["inbox", "classified"], drop: "classified" },
  { key: "doing", label: "進行中", statuses: ["in_progress"], drop: "in_progress" },
  { key: "review", label: "レビュー", statuses: ["review", "blocked"], drop: "review" },
  { key: "done", label: "完了", statuses: ["done"], drop: "done" },
];

export function Kanban({
  items,
  onMove,
  renderCard,
  onStatusSelect,
}: {
  items: Item[];
  onMove: (id: string, status: string) => void;
  renderCard: (it: Item) => ReactNode;
  // a11y: DnD に加えキーボード/SR でも到達できる status 変更 select を各カードに出す。
  // 未指定なら現状維持(DnD のみ)。Projects/Sprints は onStatusSelect={onMove} を渡す。
  onStatusSelect?: (id: string, status: string) => void;
}) {
  const [over, setOver] = useState<string | null>(null);

  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const cards = items.filter((i) => col.statuses.includes(i.status));
        return (
          <div
            key={col.key}
            className={`board-col${over === col.key ? " drag-over" : ""}`}
            role="group"
            aria-label={col.label}
            onDragOver={(e) => {
              e.preventDefault();
              if (over !== col.key) setOver(col.key);
            }}
            onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData("text/plain");
              const it = items.find((x) => x.id === id);
              // 同じ列に落としたら何もしない (status は列の代表値に倒す)。
              if (id && it && !col.statuses.includes(it.status)) onMove(id, col.drop);
            }}
          >
            <div className="board-col-head">
              {col.label} <span className="muted">{cards.length}</span>
            </div>
            {cards.map((it) => (
              <div
                key={it.id}
                className="board-card"
                tabIndex={0}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", it.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
              >
                {renderCard(it)}
                {onStatusSelect && (
                  <select
                    value={col.drop}
                    aria-label="ステータス変更"
                    title="ステータス変更(ドラッグの代わりにも使えます)"
                    onChange={(e) => onStatusSelect(it.id, e.target.value)}
                  >
                    {COLUMNS.map((c) => (
                      <option key={c.key} value={c.drop}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
            {/* タッチでは DnD が使えないため「ドロップ」だけの案内にしない
                (移動はカードのステータス選択でも可能)。 */}
            {cards.length === 0 && (
              <div className="board-empty muted">（空）ドロップまたはステータス選択で移動</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
