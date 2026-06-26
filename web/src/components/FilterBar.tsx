import { useEffect, useRef } from "react";
import type { Disposition, Item, Priority, Project } from "../types.js";
import { DISPOSITION_LABEL, PRIORITY_LABEL } from "../types.js";

// 検索/絞り込み (§4 "理由はグランス可能"の延長)。常設バーでなく親が『/』でトグルして出す
// 控えめなもの。テキストは title/body/reason のインクリメンタル一致、チップは
// disposition/priority/期日/category の AND 絞り込み。案件チップは複数トグル(表示集合のみ絞る・
// 並び順は不変)。純フロント(サーバ無依存)。

export interface FilterState {
  text: string;
  dispositions: Set<Disposition>;
  priorities: Set<Priority>;
  due: "any" | "over" | "soon";
  categories: Set<string>;
  projectIds: Set<string>;
}

export const emptyFilter = (): FilterState => ({
  text: "",
  dispositions: new Set(),
  priorities: new Set(),
  due: "any",
  categories: new Set(),
  projectIds: new Set(),
});

export function filterIsEmpty(f: FilterState): boolean {
  return (
    !f.text.trim() &&
    f.dispositions.size === 0 &&
    f.priorities.size === 0 &&
    f.due === "any" &&
    f.categories.size === 0 &&
    f.projectIds.size === 0
  );
}

const DAY_MS = 86_400_000;

/** 純関数: 表示集合に絞る。空集合=絞らない。並び順は変えない。 */
export function applyFilter<T extends Item>(itemsIn: T[], f: FilterState): T[] {
  const q = f.text.trim().toLowerCase();
  return itemsIn.filter((it) => {
    if (q) {
      const hay = `${it.title}\n${it.body}\n${it.reason ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.dispositions.size > 0 && (!it.disposition || !f.dispositions.has(it.disposition)))
      return false;
    if (f.priorities.size > 0 && !f.priorities.has(it.priority)) return false;
    if (f.due !== "any") {
      if (it.dueDate == null) return false;
      const days = (it.dueDate - Date.now()) / DAY_MS;
      if (f.due === "over" && days >= 0) return false;
      if (f.due === "soon" && (days < 0 || days > 2)) return false;
    }
    if (f.categories.size > 0 && (!it.category || !f.categories.has(it.category))) return false;
    if (f.projectIds.size > 0 && (!it.projectId || !f.projectIds.has(it.projectId))) return false;
    return true;
  });
}

function toggle<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

export function FilterBar({
  items,
  projects,
  filter,
  setFilter,
  onClose,
}: {
  items: Item[];
  projects: Project[];
  filter: FilterState;
  setFilter: (f: FilterState) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 表示集合に現れる category 語彙を集める(出現順・重複排除)。
  const categories: string[] = [];
  for (const it of items) {
    if (it.category && !categories.includes(it.category)) categories.push(it.category);
  }

  const disps: Disposition[] = ["auto", "escalate", "human"];
  const prios: Priority[] = ["urgent", "high", "normal", "low"];

  return (
    <div
      className="filter-bar"
      role="search"
      aria-label="検索・絞り込み"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="row">
        <input
          ref={inputRef}
          type="text"
          placeholder="本文・理由をインクリメンタル検索（Escで閉じる）"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
          style={{ flex: 1 }}
          aria-label="テキスト検索"
        />
        <button onClick={onClose} aria-label="検索を閉じる">
          閉じる
        </button>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        {disps.map((d) => (
          <button
            key={d}
            className="filter-chip"
            aria-pressed={filter.dispositions.has(d)}
            onClick={() => setFilter({ ...filter, dispositions: toggle(filter.dispositions, d) })}
          >
            {DISPOSITION_LABEL[d]}
          </button>
        ))}
        <span className="spacer" style={{ width: 8 }} />
        {prios.map((p) => (
          <button
            key={p}
            className="filter-chip"
            aria-pressed={filter.priorities.has(p)}
            onClick={() => setFilter({ ...filter, priorities: toggle(filter.priorities, p) })}
          >
            {PRIORITY_LABEL[p]}
          </button>
        ))}
        <span className="spacer" style={{ width: 8 }} />
        {(["over", "soon"] as const).map((d) => (
          <button
            key={d}
            className="filter-chip"
            aria-pressed={filter.due === d}
            onClick={() => setFilter({ ...filter, due: filter.due === d ? "any" : d })}
          >
            {d === "over" ? "期日超過" : "期日間近"}
          </button>
        ))}
      </div>
      {(categories.length > 0 || projects.length > 0) && (
        <div className="row" style={{ marginTop: 6 }}>
          {categories.map((c) => (
            <button
              key={c}
              className="filter-chip"
              aria-pressed={filter.categories.has(c)}
              onClick={() => setFilter({ ...filter, categories: toggle(filter.categories, c) })}
            >
              区分: {c}
            </button>
          ))}
          {projects.map((p) => (
            <button
              key={p.id}
              className="filter-chip"
              aria-pressed={filter.projectIds.has(p.id)}
              onClick={() => setFilter({ ...filter, projectIds: toggle(filter.projectIds, p.id) })}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
