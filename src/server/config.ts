import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// All persistent + runtime state lives under a single home dir so the tool is
// "externalized to a DB, free and deterministic" (REQUIREMENTS §1.3, §6).
export const WINNOW_HOME =
  process.env.WINNOW_HOME ?? path.join(os.homedir(), ".winnow");

export const PATHS = {
  home: WINNOW_HOME,
  db: path.join(WINNOW_HOME, "winnow.db"),
  // IPC channel between the backend and the tmux-resident claude sessions.
  ipc: path.join(WINNOW_HOME, "ipc"),
  // Scratch working dir for the control session (reasoning only, no project).
  controlCwd: path.join(WINNOW_HOME, "control-cwd"),
  // Worker sessions run tasks here unless an item pins a project dir.
  workspaces: path.join(WINNOW_HOME, "workspaces"),
};

export const SERVER_PORT = Number(process.env.WINNOW_PORT ?? 8787);

export function ensureDirs(): void {
  for (const p of [
    PATHS.home,
    PATHS.ipc,
    PATHS.controlCwd,
    PATHS.workspaces,
  ]) {
    fs.mkdirSync(p, { recursive: true });
  }
}
