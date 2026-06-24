import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

// Thin wrapper around the tmux CLI. We keep claude sessions resident in tmux so
// they run on the interactive subscription seat (REQUIREMENTS §6) and can be
// watched by a human ("ワンクリックで端末を開く", §4).

export const SESSION = "winnow";

export async function tmuxAvailable(): Promise<boolean> {
  try {
    await pexec("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

export async function hasSession(): Promise<boolean> {
  try {
    await pexec("tmux", ["has-session", "-t", SESSION]);
    return true;
  } catch {
    return false;
  }
}

/** Create the tmux session with a first window. `cmd` is run inside the pane. */
export async function newSession(windowName: string, cwd: string, cmd: string): Promise<void> {
  await pexec("tmux", [
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-n",
    windowName,
    "-c",
    cwd,
    cmd,
  ]);
}

export async function newWindow(windowName: string, cwd: string, cmd: string): Promise<void> {
  await pexec("tmux", ["new-window", "-d", "-t", SESSION, "-n", windowName, "-c", cwd, cmd]);
}

export function target(windowName: string): string {
  return `${SESSION}:${windowName}`;
}

/** Send literal text (no key interpretation), then optionally Enter. */
export async function sendText(windowName: string, text: string): Promise<void> {
  await pexec("tmux", ["send-keys", "-t", target(windowName), "-l", text]);
}

export async function sendEnter(windowName: string): Promise<void> {
  await pexec("tmux", ["send-keys", "-t", target(windowName), "Enter"]);
}

/** Capture the visible pane content (the human-facing theater). */
export async function capturePane(windowName: string): Promise<string> {
  try {
    const { stdout } = await pexec("tmux", [
      "capture-pane",
      "-p",
      "-t",
      target(windowName),
      "-S",
      "-200", // include some scrollback
    ]);
    return stdout;
  } catch (e) {
    return `(capture failed: ${(e as Error).message})`;
  }
}

export async function killSession(): Promise<void> {
  try {
    await pexec("tmux", ["kill-session", "-t", SESSION]);
  } catch {
    /* not running */
  }
}
