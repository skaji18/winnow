import type { AppState, Disposition, Item, Settings } from "./types.js";

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
  }) => j<Item>("/api/items", { method: "POST", body: JSON.stringify(input) }),

  updateItem: (id: string, patch: Partial<Item>) =>
    j<Item>(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  deleteItem: (id: string) => j(`/api/items/${id}`, { method: "DELETE" }),

  classify: (id: string) => j<Item>(`/api/items/${id}/classify`, { method: "POST" }),

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
};

export interface DecomposeOption {
  label: string;
  rationale: string;
  process: "waterfall" | "iterative";
  children: { title: string; kind: "node" | "leaf"; rung: Item["rung"] }[];
}
