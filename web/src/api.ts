import type {
  AppState,
  ContextPreview,
  Disposition,
  Item,
  Priority,
  Project,
  Settings,
  Sprint,
  UpdateState,
} from "./types.js";

// 同一オリジン保証: サーバが index.html に注入したローカルシークレットを window から読み、
// 状態変更系リクエストに x-winnow-secret として乗せる(他オリジンの fetch はこれを読めない)。
// dev (Vite:5174) では未注入だが、サーバ側 security.ts が dev はシークレット免除する。
const LOCAL_SECRET: string | undefined = (
  globalThis as unknown as { __WINNOW_SECRET__?: string }
).__WINNOW_SECRET__;

async function j<T>(url: string, opts?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs, ...init } = opts ?? {};
  // ボディ無し POST に Content-Type: application/json を付けると Fastify が空ボディを
  // FST_ERR_CTP_EMPTY_JSON_BODY で弾く(分解する/classify/execute 等)。ボディがあるときだけ付ける。
  const headers: Record<string, string> = {};
  if (init.body != null) headers["Content-Type"] = "application/json";
  if (LOCAL_SECRET) headers["x-winnow-secret"] = LOCAL_SECRET;
  // モバイル回線の電波断・切替でリクエストが無期限ハングすると busy なボタンが固まったままになる。
  // タイムアウトは通常エラーとして投げ、呼び出し側の catch → aria-live 表示に乗せる。
  // 既定20秒。同期でAI/tmuxを待つ長時間API(classify/ai/init/decompose/apply)は呼び出し側が
  // timeoutMs で延長する(短く切るとサーバ側処理は続くのに偽の失敗を表示し、再タップ=二重実行を誘う)。
  // タイマーはボディ読取完了まで生かす(ヘッダ受信後の電波断でも abort が効くように)。
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: init.signal ?? timeout.signal,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      // 楽観ロック競合(409)は専用接頭辞で投げ、UI が『他所で更新された→再取得』へ分岐できるように。
      const text = await res.text();
      if (res.status === 409) throw new Error(`CONFLICT ${text}`);
      // サーバ再起動でローカルシークレットが再生成された場合の 403。原因が分かりにくいので案内する。
      if (res.status === 403 && text.includes("missing local secret")) {
        throw new Error("サーバが再起動されたため操作を送れませんでした。ページを再読込してください");
      }
      throw new Error(`${res.status} ${text}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      throw new Error("サーバの応答がありません（タイムアウト）。接続を確認して再試行してください");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
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

  // 同期AI呼び出し(サーバ既定 classifyTimeoutMs=90秒)。既定20秒で切ると偽タイムアウトになる。
  classify: (id: string) =>
    j<Item>(`/api/items/${id}/classify`, { method: "POST", timeoutMs: 120_000 }),

  toProject: (id: string) =>
    j<{ project: Project; assigned: number }>(`/api/items/${id}/to-project`, { method: "POST" }),

  // 背景ジョブを点火するだけ(即返し)。結果は /api/state ポーリングの
  // item.decomposeStatus / decomposeOptions で受け取る。
  decompose: (id: string) =>
    j<{ started: boolean }>(`/api/items/${id}/decompose`, { method: "POST" }),

  // 子を直列に classify する同期API (子1件あたり最大90秒)。子数に応じて余裕を取る。
  applyDecompose: (id: string, option: DecomposeOption) =>
    j<{ created: Item[] }>(`/api/items/${id}/decompose/apply`, {
      method: "POST",
      body: JSON.stringify({ option }),
      timeoutMs: 60_000 + option.children.length * 100_000,
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

  // AIに渡る文脈のプレビュー (read-only。サーバ側で learnings.touch の副作用は発火しない)。
  contextPreview: (id: string) => j<ContextPreview>(`/api/items/${id}/context-preview`),

  // 学び (memory AIゾーン) の veto/pin。応答は {ok:true} のみで learning 本体は返らないため、
  // 反映は onChange(refresh) 経由の /api/state 再取得に委ねる (deactivateRule と同じ挙動)。
  updateLearning: (id: string, patch: { vetoed?: boolean; pinned?: boolean }) =>
    j<{ ok: true }>(`/api/learnings/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  attachCommand: (name: string) =>
    j<{ command: string }>(`/api/sessions/${encodeURIComponent(name)}/attach`),

  // 初回は tmux セッション生成 + claude プロンプト待ち(最大30秒)を同期で待つ。
  initAi: () => j<{ sessions: unknown[] }>("/api/ai/init", { method: "POST", timeoutMs: 60_000 }),

  // 自己更新: 手動チェック(GitHub API を同期で待つ)と適用の点火(即返し。進行は /api/state)。
  checkUpdate: () => j<UpdateState>("/api/update/check", { method: "POST", timeoutMs: 30_000 }),
  applyUpdate: () =>
    j<{ started: boolean; reason?: string }>("/api/update/apply", { method: "POST" }),

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
