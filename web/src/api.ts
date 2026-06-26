import type { AppState, Disposition, Item, Priority, Project, Settings, Sprint } from "./types.js";

// 同一オリジン保証: サーバが index.html に注入したローカルシークレットを window から読み、
// 状態変更系リクエストに x-winnow-secret として乗せる(他オリジンの fetch はこれを読めない)。
// dev (Vite:5174) では未注入だが、サーバ側 security.ts が dev はシークレット免除する。
const LOCAL_SECRET: string | undefined = (
  globalThis as unknown as { __WINNOW_SECRET__?: string }
).__WINNOW_SECRET__;

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (LOCAL_SECRET) headers["x-winnow-secret"] = LOCAL_SECRET;
  const res = await fetch(url, {
    ...opts,
    headers: { ...headers, ...(opts?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    // 楽観ロック競合(409)は専用接頭辞で投げ、UI が『他所で更新された→再取得』へ分岐できるように。
    const text = await res.text();
    if (res.status === 409) throw new Error(`CONFLICT ${text}`);
    throw new Error(`${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  state: () => j<AppState>("/api/state"),

  createItem: (input: {
    title: string;
    body?: string;
    parentId?: string | null;
    domain?: "software" | "general";
    projectDir?: string | null;
    projectId?: string | null;
    sprintId?: string | null;
    priority?: Priority;
    dueDate?: number | null;
    sourceUrl?: string | null;
  }) => j<Item>("/api/items", { method: "POST", body: JSON.stringify(input) }),

  // expectedUpdatedAt を渡すと楽観ロックが有効化される(サーバが現在の updatedAt と
  // 不一致なら 409 CONFLICT)。未指定=チェックなし=後方互換。
  updateItem: (id: string, patch: Partial<Item>, expectedUpdatedAt?: number) =>
    j<Item>(`/api/items/${id}`, {
      method: "PATCH",
      body: JSON.stringify(
        expectedUpdatedAt != null ? { ...patch, expectedUpdatedAt } : patch,
      ),
    }),

  deleteItem: (id: string) => j(`/api/items/${id}`, { method: "DELETE" }),

  classify: (id: string) => j<Item>(`/api/items/${id}/classify`, { method: "POST" }),

  toProject: (id: string) =>
    j<{ project: Project; assigned: number }>(`/api/items/${id}/to-project`, { method: "POST" }),

  decompose: (id: string) =>
    j<{ options: DecomposeOption[] }>(`/api/items/${id}/decompose`, { method: "POST" }),

  applyDecompose: (id: string, option: DecomposeOption) =>
    j<{ created: Item[] }>(`/api/items/${id}/decompose/apply`, {
      method: "POST",
      body: JSON.stringify({ option }),
    }),

  execute: (id: string) => j(`/api/items/${id}/execute`, { method: "POST" }),
  // general成果物『この方向で直す』: 一行指示を渡して同じ execute を再走させる。
  reExecute: (id: string, instruction: string) =>
    j(`/api/items/${id}/execute`, { method: "POST", body: JSON.stringify({ instruction }) }),
  approve: (id: string) => j(`/api/items/${id}/approve`, { method: "POST" }),
  cancel: (id: string) => j<Item>(`/api/items/${id}/cancel`, { method: "POST" }),
  // 引き取り(handoff)の受領: awaiting_handoff の成果物を確認/採用して完了へ。
  accept: (id: string) => j<Item>(`/api/items/${id}/accept`, { method: "POST" }),

  action: (id: string, action: string, to?: Disposition) =>
    j<Item>(`/api/items/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action, to }),
    }),

  // 処分=ラベルの Undo (直近1手の逆適用)。
  undoLabel: (id: string) => j<Item>(`/api/items/${id}/undo-label`, { method: "POST" }),
  // 即締め: muteCategory の対称『この種類は当面上げて』(escalate 固定 rule)。
  escalateCategory: (id: string) =>
    j<Item>(`/api/items/${id}/escalate-category`, { method: "POST" }),

  audit: (id: string, ok: boolean) =>
    j<Item>(`/api/items/${id}/audit`, { method: "POST", body: JSON.stringify({ ok }) }),

  attachCommand: (name: string) =>
    j<{ command: string }>(`/api/sessions/${encodeURIComponent(name)}/attach`),

  initAi: () => j<{ sessions: unknown[] }>("/api/ai/init", { method: "POST" }),

  updateSettings: (patch: Partial<Settings>) =>
    j<Settings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  deactivateRule: (id: string) => j(`/api/rules/${id}/deactivate`, { method: "POST" }),

  createProject: (input: { name: string; description?: string; mode?: "board" | "flow" }) =>
    j<Project>("/api/projects", { method: "POST", body: JSON.stringify(input) }),
  updateProject: (id: string, patch: Partial<Project>) =>
    j<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteProject: (id: string) => j(`/api/projects/${id}`, { method: "DELETE" }),

  createSprint: (input: {
    name: string;
    goal?: string;
    startDate?: number | null;
    endDate?: number | null;
  }) => j<Sprint>("/api/sprints", { method: "POST", body: JSON.stringify(input) }),
  updateSprint: (id: string, patch: Partial<Sprint>) =>
    j<Sprint>(`/api/sprints/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSprint: (id: string) => j(`/api/sprints/${id}`, { method: "DELETE" }),
};

export interface DecomposeOption {
  label: string;
  rationale: string;
  process: "waterfall" | "iterative";
  children: {
    title: string;
    kind: "node" | "leaf";
    rung: Item["rung"];
    spec: string;
    projectDir?: string; // polyrepo: 別repoの子だけ。省略=親継承。
  }[];
}
