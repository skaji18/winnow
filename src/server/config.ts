import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// 配備ルート (= リポジトリルート)。web/dist 配信 (index.ts) と自己更新の git/npm 実行
// (updater.ts) が共有する単一真実源 (配備レイアウト変更時にここだけ直せば揃う)。
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

// リモートアクセス (DECISIONS「リモートアクセス」節): 既定は loopback のまま。
// 公開はリバースプロキシ(認証+TLS を前段で担保)が正で、緩めは起動時 env のみ
// (PATCH /api/settings からは緩められない=許可リストを API から緩めない非対称ポリシー)。
export const SERVER_HOST = process.env.WINNOW_HOST ?? "127.0.0.1";

/** カンマ区切りの追加許可ホスト名 (例: "winnow.example.com")。Origin/Host 検証に合流する。 */
export const EXTRA_ALLOWED_HOSTS = (process.env.WINNOW_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** カンマ区切りの追加許可ポート。HTTPS(443) は Origin にポートが乗らないため通常不要。 */
export const EXTRA_ALLOWED_PORTS = (process.env.WINNOW_ALLOWED_PORTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
