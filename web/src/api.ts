import type { AppState, Disposition, Item, Priority, Project, Settings, Sprint } from "./types.js";

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
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
  }) => j<Item>("/api/items", { method: "POST", body: JSON.stringify(input) }),

  updateItem: (id: string, patch: Partial<Item>) =>
    j<Item>(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

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
  approve: (id: string) => j(`/api/items/${id}/approve`, { method: "POST" }),
  cancel: (id: string) => j<Item>(`/api/items/${id}/cancel`, { method: "POST" }),

  action: (id: string, action: string, to?: Disposition) =>
    j<Item>(`/api/items/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ action, to }),
    }),

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
  children: { title: string; kind: "node" | "leaf"; rung: Item["rung"]; spec: string }[];
}
