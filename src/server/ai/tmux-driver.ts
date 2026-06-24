import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config.js";
import { settings } from "../repo.js";
import type { AiDriver, AiRequest, AiResult, AiRole, SessionInfo } from "./driver.js";
import * as tmux from "./tmux.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
  window: string; // tmux window name, e.g. "control" / "worker-0"
  role: AiRole;
  busy: boolean;
  currentLabel: string | null;
  startedAt: number;
}

/** A queued acquire request: fired when a session frees, cancelled on timeout. */
interface Waiter {
  fire: () => void;
  cancel: () => void;
}

// Default upper bound for how long dispatch will wait for a free worker before
// declaring failure. Keeps the request queue from hanging forever when every
// session is busy or wedged on a permission prompt (deadlock fix #2).
const ACQUIRE_TIMEOUT_MS = 120_000;

/**
 * Drives interactive `claude` sessions resident in tmux. Machine I/O goes
 * through files (request → response → done sentinel), NOT by scraping the TUI:
 * the rendered pane is reserved for the human to watch (§4). This keeps the
 * channel robust while still running on the subscription seat (§6).
 */
export class TmuxDriver implements AiDriver {
  private sessions: Session[] = [];
  private waiters: Record<AiRole, Waiter[]> = { control: [], worker: [] };
  private ready = false;

  async init(): Promise<void> {
    if (!(await tmux.tmuxAvailable())) {
      throw new Error("tmux が見つかりません。`brew install tmux` 等で導入してください。");
    }
    const cfg = settings.get();
    // Floor the worker count at 1 even if config slips below the schema min(1),
    // so there is always at least one worker session to dispatch to.
    const workerCount = Math.max(1, cfg.maxWorkers);

    // Reuse a live session across app restarts ("立ち上げっぱなし") if present.
    if (await tmux.hasSession()) {
      this.sessions = [
        { window: "control", role: "control", busy: false, currentLabel: null, startedAt: Date.now() },
        ...Array.from({ length: workerCount }, (_, i) => ({
          window: `worker-${i}`,
          role: "worker" as AiRole,
          busy: false,
          currentLabel: null,
          startedAt: Date.now(),
        })),
      ];
      // A reused session may still be mid-boot (or wedged); wait for an idle
      // prompt rather than assuming readiness (readiness handshake).
      await this.waitForPrompt("control", 10_000);
      this.ready = true;
      return;
    }

    // Fresh start: one control window + N worker windows, each running claude.
    await tmux.newSession("control", PATHS.controlCwd, cfg.claudeControlCmd);
    this.sessions.push({
      window: "control",
      role: "control",
      busy: false,
      currentLabel: null,
      startedAt: Date.now(),
    });
    for (let i = 0; i < workerCount; i++) {
      await tmux.newWindow(`worker-${i}`, PATHS.workspaces, cfg.claudeWorkerCmd);
      this.sessions.push({
        window: `worker-${i}`,
        role: "worker",
        busy: false,
        currentLabel: null,
        startedAt: Date.now(),
      });
    }

    // Wait for claude to reach an idle input prompt before the first dispatch,
    // instead of a blind fixed sleep (readiness handshake).
    await this.waitForPrompt("control", 30_000);
    this.ready = true;
  }

  /**
   * Poll the pane (~300ms) until claude shows an idle input prompt and is not
   * in a /clear confirmation dialog or actively running. We only read the pane
   * to detect readiness here — never to scrape results (§4 machine I/O stays on
   * the file protocol). Returns false on timeout so callers can proceed best-
   * effort rather than hang.
   */
  private async waitForPrompt(window: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = await tmux.capturePane(window);
      if (isIdlePrompt(pane)) return true;
      await sleep(300);
    }
    return false;
  }

  private acquire(role: AiRole, timeoutMs = ACQUIRE_TIMEOUT_MS): Promise<Session> {
    const free = this.sessions.find((s) => s.role === role && !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    // No free session and none exist for this role at all → fail fast rather
    // than queue a waiter that can never fire (deadlock fix #2).
    if (!this.sessions.some((s) => s.role === role)) {
      return Promise.reject(new Error(`no worker available (role=${role})`));
    }
    // Otherwise queue a waiter, but bound the wait so a busy/wedged pool cannot
    // hang dispatch forever. The waiter callback and the timeout are mutually
    // exclusive: whichever fires first removes the other so a timed-out waiter
    // never later grabs and leaks a freed session.
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        fire: () => {
          clearTimeout(timer);
          const s = this.sessions.find((x) => x.role === role && !x.busy)!;
          s.busy = true;
          resolve(s);
        },
        cancel: () => reject(new Error(`acquire timeout (role=${role}, ${timeoutMs}ms)`)),
      };
      const timer = setTimeout(() => {
        const i = this.waiters[role].indexOf(waiter);
        if (i >= 0) this.waiters[role].splice(i, 1);
        waiter.cancel();
      }, timeoutMs);
      this.waiters[role].push(waiter);
    });
  }

  private release(s: Session): void {
    s.busy = false;
    s.currentLabel = null;
    const next = this.waiters[s.role].shift();
    if (next) next.fire();
  }

  async dispatch(req: AiRequest): Promise<AiResult> {
    if (!this.ready) await this.init();
    const started = Date.now();

    // Acquire is OUTSIDE the try: a session we never acquired must never be
    // released. A rejection here (no worker / acquire timeout) is a normal
    // failure path — surface it as a result so jobs.update marks failure
    // rather than throwing through awaiting callers (deadlock fix #2).
    let s: Session;
    try {
      s = await this.acquire(req.role, req.timeoutMs);
    } catch (e) {
      return {
        ok: false,
        data: null,
        raw: "",
        sessionName: null,
        error: (e as Error).message,
        durationMs: Date.now() - started,
      };
    }

    try {
      // Everything from here on is inside the try so the finally release runs
      // even if a pre-dispatch fs call throws (deadlock fix #1).
      s.currentLabel = req.label;

      const reqPath = path.join(PATHS.ipc, `${req.id}.req.md`);
      const resPath = path.join(PATHS.ipc, `${req.id}.res.json`);
      const donePath = path.join(PATHS.ipc, `${req.id}.done`);
      for (const p of [resPath, donePath]) if (fs.existsSync(p)) fs.rmSync(p);
      fs.writeFileSync(reqPath, req.prompt, "utf8");

      // Project isolation (§ project isolation): the pane runs claude, not a
      // shell, so `cd` keystrokes are inert. Pin the worker to its project dir
      // by instruction instead. General tasks (no cwd) keep prior behavior.
      const cwdNote =
        req.role === "worker" && req.cwd
          ? `作業ディレクトリは ${req.cwd} です。すべてのファイル読み書き・コマンド実行はこの絶対パス配下でのみ行い、他ディレクトリへは触れないこと。`
          : "";
      const instruction =
        cwdNote +
        `【Winnow依頼】次の依頼ファイルを読んで指示どおり処理し、` +
        `結果(指定のJSONオブジェクトのみ)をWriteツールで「${resPath}」に書き、` +
        `最後にWriteツールで「${donePath}」へ "ok" と書け。依頼ファイル: ${reqPath}`;

      const timeoutMs = req.timeoutMs ?? (req.role === "worker" ? 300_000 : 90_000);

      // Send /clear + instruction; retry once if claude returns to an idle
      // prompt without producing the done sentinel. Re-asking is safe because
      // the request file still exists (idempotent-retryable).
      const maxAttempts = 2;
      let ok = false;
      for (let attempt = 1; attempt <= maxAttempts && !ok; attempt++) {
        await this.sendDispatch(s.window, instruction);
        ok = await this.waitForDone(donePath, timeoutMs);
        if (ok) break;
        // Only retry if the pane is back at an idle prompt and no done file
        // appeared — otherwise it is genuinely stuck/working, so stop.
        if (attempt < maxAttempts && !fs.existsSync(donePath) && (await this.waitForPrompt(s.window, 2_000))) {
          continue;
        }
        break;
      }
      const durationMs = Date.now() - started;

      if (!ok) {
        return {
          ok: false,
          data: null,
          raw: "",
          sessionName: tmux.target(s.window),
          error: `タイムアウト(${timeoutMs}ms)。セッションが許可プロンプトで止まっている可能性。`,
          durationMs,
        };
      }

      const raw = fs.existsSync(resPath) ? fs.readFileSync(resPath, "utf8") : "";
      let data: unknown = raw;
      if (req.expectJson) {
        try {
          data = parseJson(raw);
        } catch (e) {
          return {
            ok: false,
            data: null,
            raw,
            sessionName: tmux.target(s.window),
            error: `JSON解析失敗: ${(e as Error).message}`,
            durationMs,
          };
        }
      }
      return { ok: true, data, raw, sessionName: tmux.target(s.window), durationMs };
    } finally {
      this.release(s);
    }
  }

  /**
   * Reset context (so the session is warm but stateless, §1.3) and send the
   * instruction. Uses the readiness handshake instead of fixed sleeps: wait for
   * the pane to settle after /clear, confirm the /clear dialog if it appears,
   * then send the instruction and briefly confirm it registered (re-send once).
   */
  private async sendDispatch(window: string, instruction: string): Promise<void> {
    await tmux.sendText(window, "/clear");
    await tmux.sendEnter(window);
    // /clear may pop a confirmation dialog; confirm it, then wait for idle.
    const cleared = await this.waitForPrompt(window, 8_000);
    if (!cleared) {
      const pane = await tmux.capturePane(window);
      if (hasClearConfirm(pane)) {
        await tmux.sendEnter(window); // confirm the dialog
        await this.waitForPrompt(window, 8_000);
      }
    }

    await tmux.sendText(window, instruction);
    await tmux.sendEnter(window);
    // Confirm the instruction registered (pane left the idle prompt / started
    // working). If it still looks idle, re-send the Enter once.
    await sleep(500);
    const pane = await tmux.capturePane(window);
    if (isIdlePrompt(pane)) {
      await tmux.sendEnter(window);
    }
  }

  private async waitForDone(donePath: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(donePath)) return true;
      await sleep(1000);
    }
    return false;
  }

  listSessions(): SessionInfo[] {
    return this.sessions.map((s) => ({
      name: tmux.target(s.window),
      role: s.role,
      busy: s.busy,
      currentLabel: s.currentLabel,
      startedAt: s.startedAt,
    }));
  }

  async capture(sessionName: string): Promise<string> {
    const window = sessionName.includes(":") ? sessionName.split(":")[1]! : sessionName;
    return tmux.capturePane(window);
  }

  attachCommand(sessionName: string): string {
    return `tmux attach -t ${sessionName}`;
  }

  async shutdown(): Promise<void> {
    // Intentionally leave the tmux session alive so workers persist across
    // app restarts. Use `tmux kill-session -t winnow` to fully stop.
  }
}

/** True while claude is mid-run (spinner / interrupt hint) — i.e. not idle. */
function isRunning(pane: string): boolean {
  return /esc to interrupt/i.test(pane) || /\besc\b.*interrupt/i.test(pane);
}

/** Detects the /clear (or similar) confirmation dialog awaiting a keypress. */
export function hasClearConfirm(pane: string): boolean {
  return /clear|conversation|❯\s*1\.\s*Yes|Do you want to/i.test(pane) && /\b1\.\s|❯/.test(pane);
}

/**
 * Heuristic for "claude is at an idle input prompt": the input box is present
 * and the session is neither running nor showing a confirmation dialog. We only
 * use this to detect readiness, never to read results (§4 — machine I/O stays on
 * the file protocol).
 */
export function isIdlePrompt(pane: string): boolean {
  if (isRunning(pane)) return false;
  if (hasClearConfirm(pane)) return false;
  // The interactive prompt renders a boxed input line with a leading "> ".
  return /\n\s*[│|]?\s*>\s/.test(pane) || /\n>\s/.test(pane);
}

/** Extract a JSON object from text that may include code fences or prose. */
export function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to fenced/embedded extraction */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return JSON.parse(fence[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("no JSON object found");
}
