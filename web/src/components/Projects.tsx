import { useState } from "react";
import { api } from "../api.js";
import type { AppState, Item, Project } from "../types.js";
import { RUNG_LABEL, STATUS_LABEL } from "../types.js";
import { DueBadge, PriorityBadge } from "./Bits.js";

// 案件(プロジェクト)ビュー = 案件ごとの状態確認。見せ方は案件ごとに切替:
// board=状態カンバン / flow=優先度・期日順リスト。スプリント(期間)は別タブ(横断)。

const COLUMNS: { key: string; label: string; statuses: string[] }[] = [
  { key: "todo", label: "未着手", statuses: ["inbox", "classified"] },
  { key: "doing", label: "進行中", statuses: ["in_progress"] },
  { key: "review", label: "レビュー", statuses: ["review", "blocked"] },
  { key: "done", label: "完了", statuses: ["done"] },
];
const STATUSES = ["inbox", "classified", "in_progress", "review", "done", "blocked"];

export function ProjectsView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [sel, setSel] = useState<string | null>(state.projects[0]?.id ?? null);
  const project = state.projects.find((p) => p.id === sel) ?? null;

  return (
    <div className="proj-layout">
      <div className="proj-side">
        <NewProject onChange={onChange} onCreated={setSel} />
        {state.projects.map((p) => (
          <button
            key={p.id}
            className={`proj-pick ${sel === p.id ? "sel" : ""}`}
            onClick={() => setSel(p.id)}
          >
            <b>{p.name}</b>
            <span className="muted" style={{ fontSize: 11 }}>
              {p.mode === "board" ? "ボード" : "フロー"} ·{" "}
              {state.items.filter((i) => i.projectId === p.id).length}件
            </span>
          </button>
        ))}
        {state.projects.length === 0 && <p className="muted">案件がありません。</p>}
      </div>

      <div className="proj-main">
        {!project ? (
          <div className="empty">案件を選ぶか、新規作成してください。</div>
        ) : (
          <ProjectDetail key={project.id} project={project} state={state} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function NewProject({
  onChange,
  onCreated,
}: {
  onChange: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"board" | "flow">("board");
  const submit = async () => {
    if (!name.trim()) return;
    const p = await api.createProject({ name: name.trim(), mode });
    setName("");
    onCreated(p.id);
    await onChange();
  };
  return (
    <div className="new-proj">
      <input
        type="text"
        placeholder="新規案件名"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <div className="row" style={{ gap: 6 }}>
        <select value={mode} onChange={(e) => setMode(e.target.value as "board" | "flow")}>
          <option value="board">ボード</option>
          <option value="flow">フロー</option>
        </select>
        <button className="primary" onClick={submit}>
          作成
        </button>
      </div>
    </div>
  );
}

function ProjectDetail({
  project,
  state,
  onChange,
}: {
  project: Project;
  state: AppState;
  onChange: () => void;
}) {
  const projectItems = state.items.filter((i) => i.projectId === project.id);
  const setMode = (mode: "board" | "flow") =>
    api.updateProject(project.id, { mode }).then(onChange);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{project.name}</h3>
        <select value={project.mode} onChange={(e) => setMode(e.target.value as "board" | "flow")}>
          <option value="board">ボード表示</option>
          <option value="flow">フロー表示</option>
        </select>
        <button
          className="danger"
          onClick={() => {
            if (confirm("案件を削除? (タスクは残り、案件参照だけ外れます)"))
              api.deleteProject(project.id).then(onChange);
          }}
        >
          案件を削除
        </button>
      </div>

      {project.mode === "board" ? (
        <ProjectBoard items={projectItems} state={state} onChange={onChange} />
      ) : (
        <FlowList items={projectItems} onChange={onChange} />
      )}
    </div>
  );
}

// 案件の状態カンバン (全タスクを status で。スプリント横断)。
function ProjectBoard({
  items,
  state,
  onChange,
}: {
  items: Item[];
  state: AppState;
  onChange: () => void;
}) {
  if (items.length === 0) return <p className="muted">この案件のタスクはまだありません。</p>;
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const cards = items.filter((i) => col.statuses.includes(i.status));
        return (
          <div className="board-col" key={col.key}>
            <div className="board-col-head">
              {col.label} <span className="muted">{cards.length}</span>
            </div>
            {cards.map((it) => (
              <div className="board-card" key={it.id}>
                <div className="board-card-title">{it.title}</div>
                <div className="badges" style={{ marginBottom: 6 }}>
                  <span className="badge kind">{RUNG_LABEL[it.rung]}</span>
                  {it.sprintId && (
                    <span className="badge proj">
                      {state.sprints.find((s) => s.id === it.sprintId)?.name ?? "SP"}
                    </span>
                  )}
                  <PriorityBadge priority={it.priority} />
                  <DueBadge due={it.dueDate} />
                </div>
                <select
                  value={it.status}
                  onChange={(e) => api.updateItem(it.id, { status: e.target.value }).then(onChange)}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s] ?? s}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// 継続フロー (優先度・期日順)。
function FlowList({ items, onChange }: { items: Item[]; onChange: () => void }) {
  const PRIO: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
  const sorted = [...items]
    .filter((i) => i.status !== "rejected")
    .sort((a, b) => {
      const d = (PRIO[b.priority] ?? 1) - (PRIO[a.priority] ?? 1);
      if (d !== 0) return d;
      return (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity);
    });
  return (
    <div>
      <h3>継続フロー（優先度・期日順 {sorted.length}）</h3>
      {sorted.length === 0 ? (
        <p className="muted">この案件のタスクはまだありません。</p>
      ) : (
        sorted.map((it) => (
          <div className="tree-row" key={it.id}>
            <span style={{ flex: 1 }}>
              {it.title} <span className="badge kind">{RUNG_LABEL[it.rung]}</span>
            </span>
            <PriorityBadge priority={it.priority} />
            <DueBadge due={it.dueDate} />
            <select
              value={it.priority}
              title="優先度"
              onChange={(e) => api.updateItem(it.id, { priority: e.target.value as Item["priority"] }).then(onChange)}
            >
              <option value="urgent">緊急</option>
              <option value="high">高</option>
              <option value="normal">中</option>
              <option value="low">低</option>
            </select>
            <select
              value={it.status}
              onChange={(e) => api.updateItem(it.id, { status: e.target.value }).then(onChange)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s] ?? s}
                </option>
              ))}
            </select>
          </div>
        ))
      )}
    </div>
  );
}
