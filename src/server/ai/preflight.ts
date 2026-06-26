import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { settings } from "../repo.js";
import * as tmux from "./tmux.js";

const pexec = promisify(execFile);

// 起動時 preflight: tmux -V / claude 解決可否の軽い1回チェック。AI セッションは
// 起動しない(driver.init() を呼ばない・端末描画も解析しない)。結果は runtime-state
// 経由で /api/state に出すだけ(UI表示は Batch6)。例外は握り潰してサーバ起動を止めない
// (背骨: quick_check 失敗のみ起動停止)。

export interface PreflightResult {
  tmuxOk: boolean;
  claudeOk: boolean;
  checkedAt: number;
  note: string | null;
}

/** 起動コマンド文字列の先頭トークン(実体バイナリ名)を取り出す。 */
function binOf(cmd: string): string | null {
  const tok = cmd.trim().split(/\s+/)[0];
  return tok && tok.length > 0 ? tok : null;
}

export async function preflightCheck(): Promise<PreflightResult> {
  const cfg = settings.get();

  // tmux: headless モードなら tmux は不要なので skip(tmuxOk:true 固定)。
  let tmuxOk = true;
  if (!cfg.useHeadless) {
    try {
      tmuxOk = await tmux.tmuxAvailable();
    } catch {
      tmuxOk = false;
    }
  }

  // claude 解決可否: 起動コマンドの先頭トークンを軽く `--version` で叩く(短い timeout)。
  // AI セッションは起動しない。プロンプトで固まらないよう timeout を短く(5s)し、
  // 失敗は claudeOk:false に倒すだけ。
  let claudeOk = true;
  const bin = binOf(cfg.claudeWorkerCmd) ?? binOf(cfg.claudeControlCmd);
  if (bin) {
    try {
      await pexec(bin, ["--version"], { timeout: 5_000 });
      claudeOk = true;
    } catch {
      claudeOk = false;
    }
  } else {
    claudeOk = false;
  }

  const notes: string[] = [];
  if (!tmuxOk) notes.push("tmux 未検出");
  if (!claudeOk) notes.push("claude 未解決");
  const note = notes.length > 0 ? notes.join(" / ") : null;

  return { tmuxOk, claudeOk, checkedAt: Date.now(), note };
}
