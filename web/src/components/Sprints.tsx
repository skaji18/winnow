import { useState } from "react";
import { api } from "../api.js";
import type { AppState, Item, Sprint } from "../types.js";
import { RUNG_LABEL, STATUS_LABEL } from "../types.js";
import { DueBadge, PriorityBadge, ProjectChip } from "./Bits.js";

// スプリント = グローバルな時間箱。カンバンは「その期間の全タスク」を案件横断で
// 表示する (案件ごとではない)。各カードに所属案件チップを出す。

const COLUMNS: { key: string; label: string; statuses: string[] }[] = [
  { key: "todo", label: "未着手", statuses: ["inbox", "classified"] },
  { key: "doing", label: "進行中", statuses: ["in_progress"] },
  { key: "review", label: "レビュー", statuses: ["review", "blocked"] },
  { key: "done", label: "完了", statuses: ["done"] },
];
const STATUSES = ["inbox", "classified", "in_progress", "review", "done", "blocked"];

export function SprintsView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [sel, setSel] = useState<string | null>(
    state.sprints.find((s) => s.status === "active")?.id ?? state.sprints[0]?.id ?? null,
  );
  const [newName, setNewName] = useState("");

  const createSprint = async () => {
    if (!newName.trim()) return;
    const s = await api.createSprint({ name: newName.trim() });
    setNewName("");
    setSel(s.id);
    await onChange();
  };

  const sprint = state.sprints.find((s) => s.id === sel) ?? null;
  const inSprint = state.items.filter((i) => i.sprintId === sel);
  // スプリント未割当（横断バックログ。完了/却下は除く）。
  const backlog = state.items.filter(
    (i) => !i.sprintId && i.status !== "done" && i.status !== "rejected",
  );

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={sel ?? ""} onChange={(e) => setSel(e.target.value || null)}>
          <option value="">— スプリント期間を選択 —</option>
          {state.sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({STATUS_LABEL[s.status] ?? s.status})
            </option>
          ))}
        </select>
        {sprint && <SprintControls sprint={sprint} onChange={onChange} />}
        <span className="spacer" style={{ flex: 1 }} />
        <input
          type="text"
          placeholder="新規スプリント名"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createSprint()}
        />
        <button onClick={createSprint}>スプリント追加</button>
      </div>

      {!sprint ? (
        <div className="empty">スプリント期間を選ぶと、その期間の横断カンバンが出ます。</div>
      ) : (
        <>
          <div className="board">
            {COLUMNS.map((col) => {
              const cards = inSprint.filter((i) => col.statuses.includes(i.status));
              return (
                <div className="board-col" key={col.key}>
                  <div className="board-col-head">
                    {col.label} <span className="muted">{cards.length}</span>
                  </div>
                  {cards.map((it) => (
                    <SprintCard key={it.id} item={it} state={state} onChange={onChange} />
                  ))}
                </div>
              );
            })}
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <h3>このスプリントに引き込む（未割当 {backlog.length}・案件横断）</h3>
            {backlog.length === 0 ? (
              <p className="muted">未割当タスクはありません。</p>
            ) : (
              backlog.map((it) => (
                <div className="tree-row" key={it.id}>
                  <span style={{ flex: 1 }}>
                    {it.title} <span className="badge kind">{RUNG_LABEL[it.rung]}</span>
                  </span>
                  <ProjectChip projectId={it.projectId} projects={state.projects} />
                  <button onClick={() => api.updateItem(it.id, { sprintId: sel }).then(onChange)}>
                    引き込む
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SprintControls({ sprint, onChange }: { sprint: Sprint; onChange: () => void }) {
  return (
    <>
      <select
        value={sprint.status}
        title="スプリント状態"
        onChange={(e) => api.updateSprint(sprint.id, { status: e.target.value as Sprint["status"] }).then(onChange)}
      >
        <option value="planned">計画中</option>
        <option value="active">進行中</option>
        <option value="completed">完了</option>
      </select>
      <button
        className="danger"
        onClick={() => {
          if (confirm("スプリントを削除? (タスクは残り、割当だけ外れます)"))
            api.deleteSprint(sprint.id).then(onChange);
        }}
      >
        削除
      </button>
    </>
  );
}

function SprintCard({
  item,
  state,
  onChange,
}: {
  item: Item;
  state: AppState;
  onChange: () => void;
}) {
  return (
    <div className="board-card">
      <div className="board-card-title">{item.title}</div>
      <div className="badges" style={{ marginBottom: 6 }}>
        <ProjectChip projectId={item.projectId} projects={state.projects} />
        {item.disposition && <span className={`badge disp-${item.disposition}`}>●</span>}
        <PriorityBadge priority={item.priority} />
        <DueBadge due={item.dueDate} />
      </div>
      <div className="row" style={{ gap: 6 }}>
        <select
          value={item.status}
          onChange={(e) => api.updateItem(item.id, { status: e.target.value }).then(onChange)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s] ?? s}
            </option>
          ))}
        </select>
        <select
          value={item.sprintId ?? ""}
          title="スプリント移動"
          onChange={(e) => api.updateItem(item.id, { sprintId: e.target.value || null }).then(onChange)}
        >
          <option value="">外す</option>
          {state.sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
