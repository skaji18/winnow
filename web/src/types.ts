// Mirror of the server domain (subset the UI needs).
export type Kind = "node" | "leaf";
export type Rung = "fog" | "strategy" | "tactic" | "means" | "execution";
export type Disposition = "auto" | "escalate" | "human";
export type Priority = "low" | "normal" | "high" | "urgent";
export type ExecutionStatus =
  | "none"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "proposed"
  | "approved"
  | "cancelled";

export interface Item {
  id: string;
  title: string;
  body: string;
  kind: Kind;
  rung: Rung;
  parentId: string | null;
  orderIndex: number;
  status: string;
  disposition: Disposition | null;
  confidence: number | null;
  reason: string | null;
  stakes: number | null;
  reversibility: number | null;
  category: string | null;
  // tightness/ゲート前の AI 生提案 (較正母数の源)。読み取り専用。サーバ未提供時 undefined=現状維持。
  rawDisposition?: Disposition | null;
  rawConfidence?: number | null;
  envEscalated?: boolean;
  process: "waterfall" | "iterative" | null;
  uncertaintyResolved: boolean;
  autoExecuted: boolean;
  humanOverrode: boolean;
  auditSampled: boolean;
  executionStatus: ExecutionStatus;
  executionResult: string | null;
  // 実行成果物の分離保持 (§3.4)。サーバ未提供時 undefined=現状維持。UI 実装は Batch6。
  executionSummary?: string | null;
  executionOutput?: string | null;
  rollbackPlan?: string | null; // software 巻き戻し手順 (取り消し時に提示)
  declaredReversible?: boolean | null; // 可逆性自己申告 (null=未申告の三値)
  artifacts?: string | null; // 外部副作用 artifacts (JSON 文字列。UI で JSON.parse)
  // 外部取り込み痕跡 (read-only)。サーバ未提供時 undefined=チップ非表示=現状維持。
  sourceUrl?: string | null;
  externalKey?: string | null;
  domain: "software" | "general";
  projectDir: string | null;
  projectId: string | null;
  sprintId: string | null;
  dueDate: number | null;
  priority: Priority;
  createdAt: number;
  updatedAt: number;
}

// 人間のさばき=ラベル (server domain.ts LabelAction のミラー。ドリフト禁止)。
export type LabelAction =
  | "do"
  | "demote"
  | "reclassify"
  | "mute_category"
  | "approve"
  | "reject"
  | "override"
  | "audit_ok"
  | "audit_bad";

// server queue.ts TopReason のミラー。
export type TopReason = "期日" | "高ステークス" | "優先度" | "確信度低" | null;

export interface QueueItem extends Item {
  isAudit: boolean;
  topReason: TopReason;
  lane: "queue" | "in_progress";
  surfaceReason: string;
  staleDays: number | null;
  ageDays: number | null;
  // 直近1手の逆適用情報 (処分=ラベルの Undo)。無ければ null。サーバ未提供時 undefined=非表示。
  undoableLabel?: {
    action: LabelAction;
    fromDisposition: Disposition | null;
    toDisposition: Disposition | null;
  } | null;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  mode: "board" | "flow"; // 案件ビューの見せ方
  status: "active" | "archived";
  context: string;
  createdAt: number;
  updatedAt: number;
}

/** グローバルな時間箱（案件に属さない）。 */
export interface Sprint {
  id: string;
  name: string;
  goal: string;
  startDate: number | null;
  endDate: number | null;
  status: "planned" | "active" | "completed";
  createdAt: number;
}

export interface SessionInfo {
  name: string;
  role: "control" | "worker";
  busy: boolean;
  currentLabel: string | null;
  startedAt: number;
}

export interface Rule {
  id: string;
  category: string;
  forcedDisposition: Disposition;
  source: "manual" | "learned";
  active: boolean;
  note: string | null;
  createdAt: number;
}

export interface Settings {
  auditRate: number;
  escalationTightness: number;
  maxWorkers: number;
  claudeControlCmd: string;
  claudeWorkerCmd: string;
  useHeadless: boolean;
  productContext: string;
  // 自動実行の一時停止スイッチ (server domain.ts と整合。ヘッダトグルが消費)。
  pauseAuto: boolean;
}

export interface WeeklySummary {
  auto: number;
  escalated: number;
  overridden: number;
  audited: number;
  tippedCategories: string[];
  autoPrev: number;
  escalatedPrev: number;
  tightenedCount: number;
  loosenedCount: number;
  auditBad: number;
  stale: number;
  failed: number;
  // 要棚卸し件数 (server summary.ts と整合)。
  needsReview: number;
  line: string;
}

// 起動時 runtime state のミラー (server runtime-state.ts)。
export interface RuntimeState {
  preflight: {
    tmuxOk: boolean;
    claudeOk: boolean;
    checkedAt: number | null;
    note: string | null;
  };
  reconcile: {
    ranAt: number | null;
    recovered: number;
    failedOver: number;
  };
}

export interface Job {
  id: string;
  itemId: string;
  role: string;
  kindOfWork: string;
  sessionName: string | null;
  status: string;
  output: string | null;
  error: string | null;
  createdAt: number;
}

export interface AppState {
  items: Item[];
  queue: QueueItem[];
  autoFolded: number;
  settings: Settings;
  sessions: SessionInfo[];
  summary: WeeklySummary;
  rules: Rule[];
  recentJobs: Job[];
  projects: Project[];
  sprints: Sprint[];
  // 起動時 preflight/reconcile 痕跡 + in-flight 集計 (server /api/state)。
  runtime?: RuntimeState;
  inFlight?: { running: number; proposed: number };
  // AI 未接続→トップバナー用。ok=false のとき reason を出す。サーバ未提供時 undefined=非表示。
  preflight?: { ok: boolean; reason: string | null };
  // 全期間 LabelEvent 総数 (cold-banner 初日=実績ゼロ判定)。
  totalLabels?: number;
  // 設定『直近の捕獲』表示用。
  captureStats?: { count: number; lastAt: number | null };
  // MCP 接続スニペット用 (例 http://localhost:8787/mcp)。
  mcpEndpoint?: string;
}

// Agile/Jira 文脈の語彙 (内部キーは不変)。
export const RUNG_LABEL: Record<Rung, string> = {
  fog: "テーマ",
  strategy: "イニシアチブ",
  tactic: "エピック",
  means: "ストーリー",
  execution: "タスク",
};

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  auto: "自動",
  escalate: "要確認",
  human: "要判断",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "緊急",
  high: "高",
  normal: "中",
  low: "低",
};

export const STATUS_LABEL: Record<string, string> = {
  inbox: "受信",
  classified: "未着手",
  in_progress: "進行中",
  review: "レビュー",
  done: "完了",
  rejected: "却下",
  blocked: "停滞",
  archived: "アーカイブ",
};

// stakes/reversibility を色だけに頼らず高/中/低の語で併記する (a11y: 色以外の手がかり §4-2)。
export function STAKES_LABEL(v: number | null): string {
  if (v == null) return "–";
  return v >= 0.66 ? "高" : v >= 0.33 ? "中" : "低";
}
export function REVERSIBILITY_LABEL(v: number | null): string {
  if (v == null) return "–";
  return v >= 0.66 ? "高" : v >= 0.33 ? "中" : "低";
}
