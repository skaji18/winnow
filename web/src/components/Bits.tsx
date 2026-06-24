import type { Item, Project, Sprint } from "../types.js";
import { PRIORITY_LABEL } from "../types.js";

// カード/ビュー共通の小物バッジ。期日・優先度・案件をグランス可能に出す。

export function PriorityBadge({ priority }: { priority: Item["priority"] }) {
  if (priority === "normal") return null;
  return <span className={`badge prio-${priority}`}>優先度: {PRIORITY_LABEL[priority]}</span>;
}

export function DueBadge({ due }: { due: number | null }) {
  if (due == null) return null;
  const days = Math.ceil((due - Date.now()) / 86_400_000);
  const label =
    days < 0 ? `期限超過 ${-days}日` : days === 0 ? "今日締切" : `あと${days}日`;
  const cls = days < 0 ? "due-over" : days <= 2 ? "due-soon" : "";
  return (
    <span className={`badge ${cls}`} title={new Date(due).toLocaleDateString("ja-JP")}>
      {label}
    </span>
  );
}

export function ProjectChip({
  projectId,
  projects,
  sprints,
  sprintId,
}: {
  projectId: string | null;
  projects: Project[];
  sprints?: Sprint[];
  sprintId?: string | null;
}) {
  if (!projectId) return null;
  const p = projects.find((x) => x.id === projectId);
  if (!p) return null;
  const sp = sprintId && sprints ? sprints.find((s) => s.id === sprintId) : null;
  return (
    <span className="badge proj" title="案件 / スプリント">
      {p.name}
      {sp ? ` · ${sp.name}` : ""}
    </span>
  );
}

/** 期日入力(date)をepoch msに。空なら null。 */
export function parseDate(v: string): number | null {
  if (!v) return null;
  const t = new Date(v + "T00:00:00").getTime();
  return isNaN(t) ? null : t;
}
export function toDateInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
