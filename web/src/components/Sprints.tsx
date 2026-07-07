import { useState } from "react";
import { api } from "../api.js";
import { useLive } from "../live.js";
import type { AppState, Item, Sprint } from "../types.js";
import { RUNG_LABEL, STATUS_LABEL } from "../types.js";
import { DispositionDot, DueBadge, parseDate, PriorityBadge, ProjectChip, toDateInput } from "./Bits.js";
import { useConfirm } from "./ConfirmDialog.js";
import { Kanban } from "./Kanban.js";
import { Select } from "./Select.js";

// スプリント = グローバルな時間箱。カンバンは「その期間の全タスク」を案件横断で
// 表示する (案件ごとではない)。各カードに所属案件チップを出す。ドラッグで status 変更。

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
  // スプリント未割当（横断バックログ。完了/却下とアーカイブ案件配下は除く=閉じた案件の
  // 未完を引き込み候補に出さない。read 時導出・アイテム非変異）。
  const archivedIds = new Set(
    state.projects.filter((p) => p.status === "archived").map((p) => p.id),
  );
  const backlog = state.items.filter(
    (i) =>
      !i.sprintId &&
      i.status !== "done" &&
      i.status !== "rejected" &&
      !(i.projectId && archivedIds.has(i.projectId)),
  );

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <Select
          value={sel ?? ""}
          onChange={(v) => setSel(v || null)}
          ariaLabel="スプリント期間を選択"
          options={[
            { value: "", label: "— スプリント期間を選択 —" },
            ...state.sprints.map((s) => ({
              value: s.id,
              label: `${s.name} (${STATUS_LABEL[s.status] ?? s.status})`,
            })),
          ]}
        />
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
          <SprintStats sprint={sprint} inSprint={inSprint} />
          <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
            カードをドラッグ、または各カードのステータス選択で列(状態)を移動できます。
          </p>
          <Kanban
            items={inSprint}
            onMove={(id, status) => {
              // 楽観ロック: 現在の updatedAt を渡し、CONFLICT(他所更新)なら再取得へ。
              const cur = inSprint.find((i) => i.id === id);
              api
                .updateItem(id, { status }, cur?.updatedAt)
                .then(onChange)
                .catch((e) => {
                  if (String(e.message).startsWith("CONFLICT")) onChange();
                });
            }}
            onStatusSelect={(id, status) => {
              const cur = inSprint.find((i) => i.id === id);
              api
                .updateItem(id, { status }, cur?.updatedAt)
                .then(onChange)
                .catch((e) => {
                  if (String(e.message).startsWith("CONFLICT")) onChange();
                });
            }}
            renderCard={(it) => <SprintCard item={it} state={state} onChange={onChange} />}
          />

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
  const live = useLive();
  const confirmDialog = useConfirm();
  return (
    <>
      <Select
        value={sprint.status}
        title="スプリント状態"
        ariaLabel="スプリント状態"
        onChange={(v) => api.updateSprint(sprint.id, { status: v as Sprint["status"] }).then(onChange)}
        options={[
          { value: "planned", label: "計画中" },
          { value: "active", label: "進行中" },
          { value: "completed", label: "完了" },
        ]}
      />
      {/* 期間配線 (サーバ updateSprint は startDate/endDate/goal 対応済み=配線漏れだった)。 */}
      <input
        type="date"
        title="開始日"
        aria-label="スプリント開始日"
        defaultValue={toDateInput(sprint.startDate)}
        onChange={(e) => api.updateSprint(sprint.id, { startDate: parseDate(e.target.value) }).then(onChange)}
      />
      <input
        type="date"
        title="終了日"
        aria-label="スプリント終了日"
        defaultValue={toDateInput(sprint.endDate)}
        onChange={(e) => api.updateSprint(sprint.id, { endDate: parseDate(e.target.value) }).then(onChange)}
      />
      <input
        type="text"
        placeholder="ゴール(一行)"
        aria-label="スプリントのゴール"
        defaultValue={sprint.goal}
        onBlur={(e) => api.updateSprint(sprint.id, { goal: e.target.value }).then(onChange)}
        style={{ width: 160 }}
      />
      <button
        className="danger"
        onClick={async () => {
          const ok = await confirmDialog({
            title: "スプリントを削除",
            body: "タスクは残り、割当だけ外れます。",
            okLabel: "削除する",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteSprint(sprint.id);
            await onChange();
          } catch (e) {
            // 失敗を黙って捨てない: 無反応に見える「死んだボタン」を作らない。
            live(`削除に失敗しました: ${(e as Error).message}`);
          }
        }}
      >
        削除
      </button>
    </>
  );
}

// スプリント集計(最小・厳格): 残りN日 / 未完M件 / 期日超過K件 のみ。
// velocity/burndown は出さない(背骨: 処理量メトリクス禁止)。ヘッダ枠(muted 一行)へ間借り。
function SprintStats({ sprint, inSprint }: { sprint: Sprint; inSprint: Item[] }) {
  const now = Date.now();
  const remain =
    sprint.endDate == null ? "—" : `${Math.ceil((sprint.endDate - now) / 86_400_000)}日`;
  const incomplete = inSprint.filter((i) => i.status !== "done" && i.status !== "rejected").length;
  const overdue = inSprint.filter(
    (i) => i.dueDate != null && i.dueDate < now && i.status !== "done",
  ).length;
  return (
    <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px" }}>
      残り {remain} / 未完 {incomplete}件 / 期日超過 {overdue}件
      {sprint.goal ? ` ・ ゴール: ${sprint.goal}` : ""}
    </p>
  );
}

// Kanban が board-card でラップ＆ドラッグを担うので、ここは中身だけ描画する。
// status はドラッグで変える。スプリント移動(別の軸)だけ select を残す。
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
    <>
      <div className="board-card-title">{item.title}</div>
      <div className="badges" style={{ marginBottom: 6 }}>
        <ProjectChip projectId={item.projectId} projects={state.projects} />
        <DispositionDot disposition={item.disposition} />
        <PriorityBadge priority={item.priority} />
        <DueBadge due={item.dueDate} />
      </div>
      <Select
        value={item.sprintId ?? ""}
        title="スプリント移動"
        ariaLabel="スプリント移動"
        onChange={(v) => api.updateItem(item.id, { sprintId: v || null }).then(onChange)}
        options={[
          { value: "", label: "スプリントから外す" },
          ...state.sprints.map((s) => ({ value: s.id, label: s.name })),
        ]}
      />
    </>
  );
}
