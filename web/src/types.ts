// Mirror of the server domain (subset the UI needs).
export type Kind = "node" | "leaf";
export type Rung = "fog" | "strategy" | "tactic" | "means" | "execution";
export type Disposition = "auto" | "escalate" | "human";
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
  process: "waterfall" | "iterative" | null;
  uncertaintyResolved: boolean;
  autoExecuted: boolean;
  humanOverrode: boolean;
  auditSampled: boolean;
  executionStatus: ExecutionStatus;
  executionResult: string | null;
  domain: "software" | "general";
  projectDir: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface QueueItem extends Item {
  isAudit: boolean;
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
}

export interface WeeklySummary {
  auto: number;
  escalated: number;
  overridden: number;
  audited: number;
  tippedCategories: string[];
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
}

export const RUNG_LABEL: Record<Rung, string> = {
  fog: "霧",
  strategy: "戦略",
  tactic: "戦術",
  means: "手段",
  execution: "実行",
};

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  auto: "自動",
  escalate: "上げる",
  human: "人間",
};
