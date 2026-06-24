// AI driver abstraction (REQUIREMENTS §6: model tiering, subscription seat).
// The rest of the system talks to this interface, so we can swap the tmux
// implementation for headless / API later without touching callers.

export type AiRole = "control" | "worker";

export interface AiRequest {
  /** Correlates request/response/done files on disk. */
  id: string;
  role: AiRole;
  /** A short, human-readable label shown in the session theater. */
  label: string;
  /** Full instruction the session reads from the request file. */
  prompt: string;
  /** Worker-only: where the session should run (project dir). */
  cwd?: string;
  /** If true, the session must return a single JSON object (machine I/O). */
  expectJson: boolean;
  timeoutMs?: number;
}

export interface AiResult {
  ok: boolean;
  /** Parsed JSON when expectJson, else raw text. */
  data: unknown;
  raw: string;
  sessionName: string | null;
  error?: string;
  durationMs: number;
}

export interface SessionInfo {
  name: string; // tmux target, e.g. "winnow:control"
  role: AiRole;
  busy: boolean;
  currentLabel: string | null;
  startedAt: number;
}

export interface AiDriver {
  init(): Promise<void>;
  dispatch(req: AiRequest): Promise<AiResult>;
  listSessions(): SessionInfo[];
  /** Live theater snapshot for the GUI terminal pane (§4 "ワンクリックで端末"). */
  capture(sessionName: string): Promise<string>;
  /** Command a human can run to attach a real terminal to a session. */
  attachCommand(sessionName: string): string;
  shutdown(): Promise<void>;
}
