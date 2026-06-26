import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PATHS } from "../config.js";
import { validateProjectDir } from "../paths.js";
import { settings } from "../repo.js";
import type { AiDriver, AiRequest, AiResult, SessionInfo } from "./driver.js";
import { parseJson } from "./tmux-driver.js";

const pexec = promisify(execFile);

/**
 * Dev/fallback driver using `claude -p` (headless). Clean stdout, easy to test,
 * but uses the print path the user wants to avoid long-term (§6 billing risk).
 * Kept behind a setting so the system can be exercised without tmux.
 */
export class HeadlessDriver implements AiDriver {
  async init(): Promise<void> {}

  async dispatch(req: AiRequest): Promise<AiResult> {
    const started = Date.now();
    const cfg = settings.get();
    const baseCmd = (req.role === "worker" ? cfg.claudeWorkerCmd : cfg.claudeControlCmd)
      // strip interactive-only permission flags that also work in print mode
      .split(/\s+/)
      .slice(1); // drop the leading "claude"
    // req.cwd を無検証で execFile cwd にする穴を塞ぐ(最終ゲート)。不正なら既定にフォールバック。
    const fallback = req.role === "worker" ? PATHS.workspaces : PATHS.controlCwd;
    let cwd = fallback;
    if (req.cwd != null) {
      const v = validateProjectDir(req.cwd);
      if (v.escalate || v.dir == null) {
        console.warn(`[winnow] headless dispatch: invalid cwd rejected (${v.reason ?? req.cwd}), using fallback`);
      } else {
        cwd = v.dir;
      }
    }
    try {
      const { stdout } = await pexec(
        "claude",
        ["-p", req.prompt, "--output-format", "json", ...baseCmd],
        { cwd, maxBuffer: 64 * 1024 * 1024, timeout: req.timeoutMs ?? 300_000 },
      );
      let text = stdout;
      try {
        const envelope = JSON.parse(stdout) as { result?: string };
        if (typeof envelope.result === "string") text = envelope.result;
      } catch {
        /* not an envelope; use raw */
      }
      const data = req.expectJson ? parseJson(text) : text;
      return { ok: true, data, raw: text, sessionName: null, durationMs: Date.now() - started };
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
  }

  listSessions(): SessionInfo[] {
    return [];
  }
  async capture(): Promise<string> {
    return "(headless モードでは端末ビューはありません)";
  }
  attachCommand(): string {
    return "(headless: no tmux session)";
  }
  async shutdown(): Promise<void> {}
}
