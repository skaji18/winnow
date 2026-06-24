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

/**
 * Drives interactive `claude` sessions resident in tmux. Machine I/O goes
 * through files (request → response → done sentinel), NOT by scraping the TUI:
 * the rendered pane is reserved for the human to watch (§4). This keeps the
 * channel robust while still running on the subscription seat (§6).
 */
export class TmuxDriver implements AiDriver {
  private sessions: Session[] = [];
  private waiters: Record<AiRole, Array<() => void>> = { control: [], worker: [] };
  private ready = false;

  async init(): Promise<void> {
    if (!(await tmux.tmuxAvailable())) {
      throw new Error("tmux が見つかりません。`brew install tmux` 等で導入してください。");
    }
    const cfg = settings.get();

    // Reuse a live session across app restarts ("立ち上げっぱなし") if present.
    if (await tmux.hasSession()) {
      this.sessions = [
        { window: "control", role: "control", busy: false, currentLabel: null, startedAt: Date.now() },
        ...Array.from({ length: cfg.maxWorkers }, (_, i) => ({
          window: `worker-${i}`,
          role: "worker" as AiRole,
          busy: false,
          currentLabel: null,
          startedAt: Date.now(),
        })),
      ];
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
    for (let i = 0; i < cfg.maxWorkers; i++) {
      await tmux.newWindow(`worker-${i}`, PATHS.workspaces, cfg.claudeWorkerCmd);
      this.sessions.push({
        window: `worker-${i}`,
        role: "worker",
        busy: false,
        currentLabel: null,
        startedAt: Date.now(),
      });
    }

    // Give claude a moment to boot before the first dispatch.
    await sleep(4000);
    this.ready = true;
  }

  private acquire(role: AiRole): Promise<Session> {
    const free = this.sessions.find((s) => s.role === role && !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => {
      this.waiters[role].push(() => {
        const s = this.sessions.find((x) => x.role === role && !x.busy)!;
        s.busy = true;
        resolve(s);
      });
    });
  }

  private release(s: Session): void {
    s.busy = false;
    s.currentLabel = null;
    const next = this.waiters[s.role].shift();
    if (next) next();
  }

  async dispatch(req: AiRequest): Promise<AiResult> {
    if (!this.ready) await this.init();
    const started = Date.now();
    const s = await this.acquire(req.role);
    s.currentLabel = req.label;

    const reqPath = path.join(PATHS.ipc, `${req.id}.req.md`);
    const resPath = path.join(PATHS.ipc, `${req.id}.res.json`);
    const donePath = path.join(PATHS.ipc, `${req.id}.done`);
    for (const p of [resPath, donePath]) if (fs.existsSync(p)) fs.rmSync(p);
    fs.writeFileSync(reqPath, req.prompt, "utf8");

    try {
      // Reset context so the session is warm but stateless (§1.3), then dispatch.
      await tmux.sendText(s.window, "/clear");
      await tmux.sendEnter(s.window);
      await sleep(1200);

      const instruction =
        `【Winnow依頼】次の依頼ファイルを読んで指示どおり処理し、` +
        `結果(指定のJSONオブジェクトのみ)をWriteツールで「${resPath}」に書き、` +
        `最後にWriteツールで「${donePath}」へ "ok" と書け。依頼ファイル: ${reqPath}`;
      await tmux.sendText(s.window, instruction);
      await tmux.sendEnter(s.window);

      const timeoutMs = req.timeoutMs ?? (req.role === "worker" ? 300_000 : 90_000);
      const ok = await this.waitForDone(donePath, timeoutMs);
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
