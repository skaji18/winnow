import { useState } from "react";
import { api } from "../api.js";
import type { AppState, Item, Project, Sprint } from "../types.js";
import { RUNG_LABEL, STATUS_LABEL } from "../types.js";
import { DueBadge, PriorityBadge } from "./Bits.js";

// 案件(プロジェクト)ビュー。案件ごとに進め方を切替: sprint=カンバンボード /
// flow=継続フロー(優先度・期日順のリスト)。横断キューはここには出さない。

const BOARD_COLUMNS: { key: string; label: string; statuses: string[] }[] = [
  { key: "todo", label: "未着手", statuses: ["inbox", "classified"] },
  { key: "doing", label: "進行中", statuses: ["in_progress"] },
  { key: "review", label: "レビュー", statuses: ["review", "blocked"] },
  { key: "done", label: "完了", statuses: ["done"] },
];

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
              {p.mode === "sprint" ? "スプリント" : "継続フロー"} ·{" "}
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
  const [mode, setMode] = useState<"sprint" | "flow">("flow");
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
        <select value={mode} onChange={(e) => setMode(e.target.value as "sprint" | "flow")}>
          <option value="flow">継続フロー</option>
          <option value="sprint">スプリント</option>
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
  const setMode = (mode: "sprint" | "flow") =>
    api.updateProject(project.id, { mode }).then(onChange);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{project.name}</h3>
        <select value={project.mode} onChange={(e) => setMode(e.target.value as "sprint" | "flow")}>
          <option value="flow">継続フロー</option>
          <option value="sprint">スプリント</option>
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

      {project.mode === "sprint" ? (
        <SprintBoard project={project} items={projectItems} state={state} onChange={onChange} />
      ) : (
        <FlowList items={projectItems} state={state} onChange={onChange} />
      )}
    </div>
  );
}

// --- スプリント + カンバンボード -------------------------------------------
function SprintBoard({
  project,
  items,
  state,
  onChange,
}: {
  project: Project;
  items: Item[];
  state: AppState;
  onChange: () => void;
}) {
  const sprints = state.sprints.filter((s) => s.projectId === project.id);
  const [selSprint, setSelSprint] = useState<string | null>(sprints[0]?.id ?? null);
  const [newSprint, setNewSprint] = useState("");

  const createSprint = async () => {
    if (!newSprint.trim()) return;
    const s = await api.createSprint({ projectId: project.id, name: newSprint.trim() });
    setNewSprint("");
    setSelSprint(s.id);
    await onChange();
  };

  const sprintItems = items.filter((i) => i.sprintId === selSprint);
  const backlog = items.filter((i) => !i.sprintId);

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={selSprint ?? ""} onChange={(e) => setSelSprint(e.target.value || null)}>
          <option value="">— スプリントを選択 —</option>
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({STATUS_LABEL[s.status] ?? s.status})
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="新規スプリント名"
          value={newSprint}
          onChange={(e) => setNewSprint(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createSprint()}
        />
        <button onClick={createSprint}>スプリント追加</button>
      </div>

      {!selSprint ? (
        <p className="muted">スプリントを選ぶとカンバンが出ます。</p>
      ) : (
        <div className="board">
          {BOARD_COLUMNS.map((col) => {
            const cards = sprintItems.filter((i) => col.statuses.includes(i.status));
            return (
              <div className="board-col" key={col.key}>
                <div className="board-col-head">
                  {col.label} <span className="muted">{cards.length}</span>
                </div>
                {cards.map((it) => (
                  <BoardCard key={it.id} item={it} sprints={sprints} onChange={onChange} />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {backlog.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>この案件のバックログ（スプリント未割当 {backlog.length}）</h3>
          {backlog.map((it) => (
            <div className="tree-row" key={it.id}>
              <span style={{ flex: 1 }}>
                {it.title} <span className="badge kind">{RUNG_LABEL[it.rung]}</span>
              </span>
              <select
                value=""
                onChange={(e) => api.updateItem(it.id, { sprintId: e.target.value }).then(onChange)}
              >
                <option value="">スプリントへ割当…</option>
                {sprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function BoardCard({
  item,
  sprints,
  onChange,
}: {
  item: Item;
  sprints: Sprint[];
  onChange: () => void;
}) {
  return (
    <div className="board-card">
      <div className="board-card-title">{item.title}</div>
      <div className="badges" style={{ marginBottom: 6 }}>
        <span className="badge kind">{RUNG_LABEL[item.rung]}</span>
        {item.disposition && <span className={`badge disp-${item.disposition}`}>●</span>}
        <PriorityBadge priority={item.priority} />
        <DueBadge due={item.dueDate} />
      </div>
      <div className="row" style={{ gap: 6 }}>
        <select
          value={item.status}
          onChange={(e) => api.updateItem(item.id, { status: e.target.value }).then(onChange)}
        >
          {["inbox", "classified", "in_progress", "review", "done", "blocked"].map((s) => (
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
          <option value="">未割当</option>
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// --- 継続フロー -------------------------------------------------------------
function FlowList({
  items,
  state,
  onChange,
}: {
  items: Item[];
  state: AppState;
  onChange: () => void;
}) {
  const PRIO: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
  const sorted = [...items]
    .filter((i) => i.status !== "rejected")
    .sort((a, b) => {
      const d = (PRIO[b.priority] ?? 1) - (PRIO[a.priority] ?? 1);
      if (d !== 0) return d;
      return (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity);
    });
  void state;
  return (
    <div className="panel">
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
              {["inbox", "classified", "in_progress", "review", "done", "blocked"].map((s) => (
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
