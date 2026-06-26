// projectDir 検証 (REQUIREMENTS §3.4 / 背骨: headless-driver が req.cwd を無検証 cwd にする穴を塞ぐ)。
// 絶対パス必須・realpath 化(best-effort)・~/.winnow 等の機微パス拒否。検証失敗は『escalate に倒す』
// 方針なので、呼び出し側は拒否でなく projectDir=null + escalate 材料として扱う(capture/decompose)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "./config.js";

export interface ProjectDirResult {
  dir: string | null;
  escalate?: boolean;
  reason?: string;
}

// 機微パス: winnow 自身の home (DB/IPC/設定) と OS の機微ディレクトリ。
const HOME = os.homedir();
const SENSITIVE_PREFIXES = [
  PATHS.home, // ~/.winnow (DB/IPC/秘密)
  "/etc",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/root",
  path.join(HOME, ".ssh"),
  path.join(HOME, ".aws"),
  path.join(HOME, ".config"),
  path.join(HOME, ".gnupg"),
];

function isUnderPrefix(target: string, prefix: string): boolean {
  const t = target.endsWith(path.sep) ? target : target + path.sep;
  const p = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
  return t === p || t.startsWith(p) || target === prefix;
}

/** best-effort realpath: 存在しないパスは親まで遡って正規化し basename を継ぎ足す。 */
function bestEffortRealpath(abs: string): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    // 存在しない(これから clone する repo 等)→ 既存の親まで realpath して継ぎ足す。
    let cur = abs;
    const tail: string[] = [];
    // ルートに到達するまで親を遡る。
    for (let i = 0; i < 64; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) break; // ルート。
      tail.unshift(path.basename(cur));
      cur = parent;
      try {
        const real = fs.realpathSync(cur);
        return path.join(real, ...tail);
      } catch {
        /* keep walking up */
      }
    }
    return path.normalize(abs);
  }
}

/**
 * projectDir を検証して正規化する。
 *  - 未指定/null → {dir:null} (現状維持)。
 *  - 絶対パスでない → escalate 材料 (相対 cwd の無検証注入を防ぐ)。
 *  - realpath 化後、機微パス配下 → escalate 材料。
 *  - OK → {dir: realpath}。
 */
export function validateProjectDir(raw: string | null | undefined): ProjectDirResult {
  if (raw == null || raw.trim() === "") return { dir: null };
  const candidate = raw.trim();
  if (!path.isAbsolute(candidate)) {
    return { dir: null, escalate: true, reason: "projectDir は絶対パス必須です(相対パス不可)" };
  }
  const real = bestEffortRealpath(candidate);
  for (const prefix of SENSITIVE_PREFIXES) {
    if (isUnderPrefix(real, prefix)) {
      return {
        dir: null,
        escalate: true,
        reason: `projectDir が機微パス(${prefix})配下です。安全側にエスカレートします`,
      };
    }
  }
  // ホーム直下のドットファイル/ドットディレクトリ全般も拒否 (~/.foo)。
  const rel = path.relative(HOME, real);
  if (rel && !rel.startsWith("..") && rel.startsWith(".")) {
    return {
      dir: null,
      escalate: true,
      reason: "projectDir がホーム直下の機微パス(ドットディレクトリ)配下です",
    };
  }
  return { dir: real };
}
