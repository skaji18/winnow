import { useState } from "react";
import { api } from "../api.js";
import { DueBadge, PriorityBadge } from "./Bits.js";
import type { AppState, Item } from "../types.js";
import { DISPOSITION_LABEL, RUNG_LABEL, STATUS_LABEL } from "../types.js";

// ---------------------------------------------------------------------------
export function TreeView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [projFilter, setProjFilter] = useState("");
  const scope = projFilter
    ? state.items.filter((i) => i.projectId === projFilter)
    : state.items;
  const scopeIds = new Set(scope.map((i) => i.id));
  // フィルタ時は、その案件のアイテムのうち親がスコープ外なものをルート扱いにする。
  const roots = scope.filter((i) => !i.parentId || !scopeIds.has(i.parentId));
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>バックログ（粒度つき）</h3>
        <label className="muted">
          案件:{" "}
          <select value={projFilter} onChange={(e) => setProjFilter(e.target.value)}>
            <option value="">すべて</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {roots.length === 0 ? (
        <p className="muted">アイテムがありません。</p>
      ) : (
        roots.map((r) => <TreeNode key={r.id} item={r} all={state.items} onChange={onChange} />)
      )}
    </div>
  );
}

function TreeNode({ item, all, onChange }: { item: Item; all: Item[]; onChange: () => void }) {
  const children = all.filter((i) => i.parentId === item.id);
  return (
    <div>
      <div className="tree-row">
        <span>{item.kind === "leaf" ? "▸" : "◆"}</span>
        <span className="tree-title">
          {item.title}{" "}
          <span className="muted" style={{ fontSize: 11 }}>
            [{RUNG_LABEL[item.rung]}]
          </span>
        </span>
        <PriorityBadge priority={item.priority} />
        <DueBadge due={item.dueDate} />
        {item.disposition && (
          <span className={`badge disp-${item.disposition}`}>
            {DISPOSITION_LABEL[item.disposition]}
          </span>
        )}
        <span className="badge">{STATUS_LABEL[item.status] ?? item.status}</span>
        {item.kind === "node" && !item.parentId && !item.projectId && (
          <button
            title="この問いを案件に格上げ"
            onClick={async () => {
              await api.toProject(item.id);
              await onChange();
            }}
          >
            案件に昇格
          </button>
        )}
        <button
          className="danger"
          onClick={async () => {
            // 折り返しの多い狭幅レイアウトでの誤タップが即削除にならないよう確認を挟む
            // (削除は UNDOABLE 外の不可逆操作)。
            if (!window.confirm(`「${item.title}」を削除しますか？`)) return;
            await api.deleteItem(item.id);
            await onChange();
          }}
        >
          削除
        </button>
      </div>
      {children.length > 0 && (
        <div className="tree-node">
          {children.map((c) => (
            <TreeNode key={c.id} item={c} all={all} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}
