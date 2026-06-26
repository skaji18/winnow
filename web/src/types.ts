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
  domain: "software" | "general";
  projectDir: string | null;
  projectId: string | null;
  sprintId: string | null;
  dueDate: number | null;
  priority: Priority;
  createdAt: number;
  updatedAt: number;
}

export interface QueueItem extends Item {
  isAudit: boolean;
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
  line: string;
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
};
