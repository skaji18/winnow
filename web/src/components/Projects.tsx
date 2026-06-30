import { useState } from "react";
import { api } from "../api.js";
import type { AppState, Item, Project } from "../types.js";
import { RUNG_LABEL, STATUS_LABEL } from "../types.js";
import { DueBadge, PriorityBadge } from "./Bits.js";
import { Kanban } from "./Kanban.js";

// 案件(プロジェクト)ビュー = 案件ごとの状態確認。見せ方は案件ごとに切替:
// board=状態カンバン(ドラッグで移動) / flow=優先度・期日順リスト。スプリント(期間)は別タブ(横断)。

const STATUSES = ["inbox", "classified", "in_progress", "review", "done", "blocked"];

export function ProjectsView({ state, onChange }: { state: AppState; onChange: () => void }) {
  const [sel, setSel] = useState<string | null>(state.projects[0]?.id ?? null);
  const [showArchived, setShowArchived] = useState(false);
  const project = state.projects.find((p) => p.id === sel) ?? null;
  // アーカイブを既定で畳む。sel が archived 化されても detail は参照表示できる。
  const visible = state.projects.filter((p) => showArchived || p.status !== "archived");

  return (
    <div className="proj-layout">
      <div className="proj-side">
        <NewProject onChange={onChange} onCreated={setSel} />
        <label className="row muted" style={{ gap: 6, fontSize: 11.5, padding: "2px 0" }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          アーカイブを表示
        </label>
        {visible.map((p) => (
          <button
            key={p.id}
            className={`proj-pick ${sel === p.id ? "sel" : ""}`}
            onClick={() => setSel(p.id)}
          >
            <b>
              {p.name}
              {p.status === "archived" && <span className="muted">（アーカイブ）</span>}
            </b>
            <span className="muted" style={{ fontSize: 11 }}>
              {p.mode === "board" ? "ボード" : "フロー"} ·{" "}
              {state.items.filter((i) => i.projectId === p.id).length}件
            </span>
          </button>
        ))}
        {visible.length === 0 && <p className="muted">案件がありません。</p>}
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
  const [goal, setGoal] = useState("");
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<"board" | "flow">("board");
  const submit = async () => {
    if (!name.trim()) return;
    const p = await api.createProject({
      name: name.trim(),
      mode,
      description: goal.trim() || undefined,
    });
    // 「新しい案件＋最初の問い」を1ステップで (任意)。問いはAIが分類する。
    if (question.trim()) await api.createItem({ title: question.trim(), projectId: p.id });
    setName("");
    setGoal("");
    setQuestion("");
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
      <input
        type="text"
        placeholder="ゴール・状況 (任意・人間用)"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <input
        type="text"
        placeholder="最初の問い (任意)"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
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
  const [closing, setClosing] = useState(false);
  // 締めの対象=未完(done/rejected 以外)。0件なら即アーカイブ、1件以上は締めモーダルを開く。
  const openItems = projectItems.filter((i) => i.status !== "done" && i.status !== "rejected");

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{project.name}</h3>
        <select value={project.mode} onChange={(e) => setMode(e.target.value as "board" | "flow")}>
          <option value="board">ボード表示</option>
          <option value="flow">フロー表示</option>
        </select>
        {project.status === "archived" ? (
          <button onClick={() => api.updateProject(project.id, { status: "active" }).then(onChange)}>
            復元
          </button>
        ) : (
          <button
            title="アーカイブして締める(未完は繰越/止める/問いに戻すで締めます)"
            onClick={() => {
              if (openItems.length === 0) {
                api.updateProject(project.id, { status: "archived" }).then(onChange);
              } else {
                setClosing(true);
              }
            }}
          >
            アーカイブ
          </button>
        )}
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

      {/* ゴール・状況: 人間が読む欄。AI には注入されない (context とは役割が違う)。 */}
      <details style={{ marginBottom: 10 }} open={Boolean(project.description)}>
        <summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>
          案件のゴール・状況（人間用・AI には注入されない）
        </summary>
        <textarea
          rows={3}
          style={{ width: "100%", marginTop: 8 }}
          placeholder="この案件で達成したいこと・今どこにいるか。俯瞰で読むための覚書。"
          defaultValue={project.description}
          onBlur={(e) =>
            api.updateProject(project.id, { description: e.target.value }).then(onChange)
          }
        />
      </details>

      <details style={{ marginBottom: 14 }}>
        <summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>
          案件の前提・文脈（AI に効く: 分類/分解/実行に注入される）
        </summary>
        <textarea
          rows={6}
          style={{ width: "100%", marginTop: 8 }}
          placeholder={
            "この案件固有の前提。書いた内容が分類/分解/実行のプロンプトに注入されます。見出しは目安(自由文でも可):\n" +
            "## 決定・方針\n## 用語\n## 制約\n## 参照・repo（clone先のパスなど。詳細はそのrepoのdocsへ）\n## やらないこと"
          }
          defaultValue={project.context}
          onBlur={(e) => api.updateProject(project.id, { context: e.target.value }).then(onChange)}
        />
      </details>

      {closing && (
        <ArchiveCloseModal
          project={project}
          openItems={openItems}
          state={state}
          onClose={() => setClosing(false)}
          onChange={onChange}
        />
      )}

      {project.mode === "board" ? (
        <ProjectBoard items={projectItems} state={state} onChange={onChange} />
      ) : (
        <FlowList items={projectItems} onChange={onChange} />
      )}
    </div>
  );
}

// 案件の状態カンバン (全タスクを status で。スプリント横断)。ドラッグで status 変更。
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
    <>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
        カードをドラッグして列(状態)を移動できます。
      </p>
      <Kanban
        items={items}
        onMove={(id, status) => {
          // 楽観ロック: 現在の updatedAt を渡し、CONFLICT(他所更新)なら再取得へ。
          const cur = items.find((i) => i.id === id);
          api
            .updateItem(id, { status }, cur?.updatedAt)
            .then(onChange)
            .catch((e) => {
              if (String(e.message).startsWith("CONFLICT")) onChange();
            });
        }}
        onStatusSelect={(id, status) => {
          const cur = items.find((i) => i.id === id);
          api
            .updateItem(id, { status }, cur?.updatedAt)
            .then(onChange)
            .catch((e) => {
              if (String(e.message).startsWith("CONFLICT")) onChange();
            });
        }}
        renderCard={(it) => (
          <>
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
              value={it.sprintId ?? ""}
              title="スプリントへ割当"
              onChange={(e) => api.updateItem(it.id, { sprintId: e.target.value || null }).then(onChange)}
            >
              <option value="">スプリント未割当</option>
              {state.sprints.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </>
        )}
      />
    </>
  );
}

// 案件 archive 時の締めモーダル (確定2決定 b)。未完を放置せず disposition で締める。
// 既存の正規路 (reject/send_back=actions.ts label+recordOutcome+undo / 繰越=updateItem) のみで
// 自己完結。残数/消化率/達成% は出さない (出すのは判断対象の列挙のみ=処理量メトリクス禁止)。
type CloseChoice = "keep" | "stop" | "send_back" | "carry";

function ArchiveCloseModal({
  project,
  openItems,
  state,
  onClose,
  onChange,
}: {
  project: Project;
  openItems: Item[];
  state: AppState;
  onClose: () => void;
  onChange: () => void;
}) {
  // 既定=keep(締めない・教師信号なしの安全初期値。締めは速く緩めは慎重に)。
  const [choices, setChoices] = useState<Record<string, { kind: CloseChoice; to?: string }>>({});
  const [busy, setBusy] = useState(false);
  const targets = state.projects.filter((p) => p.status === "active" && p.id !== project.id);

  const choiceOf = (id: string) => choices[id] ?? { kind: "keep" as CloseChoice };
  const setChoice = (id: string, c: { kind: CloseChoice; to?: string }) =>
    setChoices((prev) => ({ ...prev, [id]: c }));

  const apply = async () => {
    setBusy(true);
    try {
      for (const it of openItems) {
        const c = choiceOf(it.id);
        if (c.kind === "stop") await api.action(it.id, "reject");
        else if (c.kind === "send_back") await api.action(it.id, "send_back");
        else if (c.kind === "carry" && c.to)
          await api.updateItem(it.id, { projectId: c.to }, it.updatedAt);
        // keep は何もしない (item を温存)。
      }
      await api.updateProject(project.id, { status: "archived" });
      await onChange();
      onClose();
    } catch (e) {
      // CONFLICT 等は締めを中断し再取得 (ProjectBoard と同じ流儀)。
      if (String((e as Error).message).startsWith("CONFLICT")) await onChange();
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>「{project.name}」を締める</h3>
        <p className="muted" style={{ fontSize: 12.5 }}>
          未完 {openItems.length}件をどう締めるか決めてください。繰越は別案件へ移すだけ（教師信号を出さない）、
          止める/問いに戻すはそのまま教師信号になります。何もしなければ「そのまま」で残ります。
        </p>
        <div style={{ maxHeight: 340, overflowY: "auto", margin: "10px 0" }}>
          {openItems.map((it) => {
            const c = choiceOf(it.id);
            const running = it.executionStatus === "running";
            return (
              <div className="tree-row" key={it.id} style={{ alignItems: "center" }}>
                <span style={{ flex: 1 }}>
                  {it.title} <span className="badge kind">{RUNG_LABEL[it.rung]}</span>{" "}
                  <span className="muted" style={{ fontSize: 11 }}>
                    {STATUS_LABEL[it.status] ?? it.status}
                  </span>
                </span>
                <select
                  value={c.kind}
                  title="締め方"
                  onChange={(e) =>
                    setChoice(it.id, { kind: e.target.value as CloseChoice, to: c.to })
                  }
                >
                  <option value="keep">そのまま</option>
                  <option value="stop" disabled={running}>
                    止める
                  </option>
                  <option value="send_back" disabled={running}>
                    問いに戻す
                  </option>
                  <option value="carry" disabled={targets.length === 0}>
                    繰越
                  </option>
                </select>
                {c.kind === "carry" && (
                  <select
                    value={c.to ?? ""}
                    title="繰越先の案件"
                    onChange={(e) => setChoice(it.id, { kind: "carry", to: e.target.value })}
                  >
                    <option value="">— 繰越先 —</option>
                    {targets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
        {targets.length === 0 && (
          <p className="muted" style={{ fontSize: 11 }}>
            繰越先になる別の active 案件がありません（繰越は選べません）。
          </p>
        )}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={busy}>
            やめる
          </button>
          <button
            className="primary"
            disabled={busy || openItems.some((it) => choiceOf(it.id).kind === "carry" && !choiceOf(it.id).to)}
            onClick={apply}
          >
            この内容で締めてアーカイブ
          </button>
        </div>
      </div>
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
              onChange={(e) =>
                api
                  .updateItem(it.id, { status: e.target.value }, it.updatedAt)
                  .then(onChange)
                  .catch((err) => {
                    if (String(err.message).startsWith("CONFLICT")) onChange();
                  })
              }
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
