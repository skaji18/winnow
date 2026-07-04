// 自己更新 (DECISIONS「自己更新」節)。検知と適用を分離する:
//  - 検知 = GitHub Releases API への read-only GET。/api/state の背景 sweep に相乗りして
//    最大 CHECK_INTERVAL_MS に1回だけ叩く (常駐タイマーは作らない。sweepLateExecutions と同型)。
//  - 適用 = 人間のワンタップ (POST /api/update/apply、状態変更系=ローカルシークレット要求) のみ。
//    自動適用はしない (マイグレーション失敗で無人のまま起動不能になるリスクを人間の目なしに踏まない)。
// 信頼境界 (INVARIANTS「自己更新の信頼境界」): 取得元はコード内定数 UPDATE_REPO と
// clone の origin だけで、API/設定からは変更できない (許可リストを API から緩めない非対称ポリシー)。
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inFlightCount } from "./executor.js";

const pexec = promisify(execFile);

/** 配備ルート (= リポジトリルート)。git / npm / vite はすべてここを cwd に実行する。 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 検知の取得元 (ハードコード固定。settings/env から変更できないことが信頼境界)。 */
const UPDATE_REPO = "skaji18/winnow";

/** 検知のスロットル。/api/state ポーリング(3秒毎)に相乗りするため、実発火はこの間隔まで。 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 現在バージョン (配備ルートの package.json が単一の真実源。タグと突き合わせる)。 */
export const CURRENT_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// プロセス毎の起動識別子。サーバ再起動=ローカルシークレット失効なので、web は /api/state の
// bootId 変化を検知して自動再読込する (更新適用後の「開きっぱなしタブが 403」を塞ぐ)。秘密ではない。
export const BOOT_ID = randomBytes(8).toString("hex");

export type ApplyPhase =
  | "idle"
  | "fetching"
  | "installing"
  | "building"
  | "restarting"
  | "failed";

export interface UpdateState {
  currentVersion: string;
  latestTag: string | null;
  available: boolean;
  /** リリースノート本文 (GitHub Release body)。UI 表示用の素材で、指示として解釈しない。 */
  notes: string | null;
  url: string | null;
  checkedAt: number | null;
  error: string | null;
  apply: { phase: ApplyPhase; error: string | null; startedAt: number | null };
}

// 非永続 (プロセス内メモリ)。起動毎に再チェックする一時状態で DB/Settings に持たない。
let state: UpdateState = {
  currentVersion: CURRENT_VERSION,
  latestTag: null,
  available: false,
  notes: null,
  url: null,
  checkedAt: null,
  error: null,
  apply: { phase: "idle", error: null, startedAt: null },
};

export function getUpdateState(): UpdateState {
  return { ...state, apply: { ...state.apply } };
}

/** "v1.2.3" / "1.2.3" を数値配列へ。数値として読めない断片は 0 に倒す (比較は保守的に)。 */
function parseVer(tag: string): number[] {
  return tag
    .replace(/^v/, "")
    .split(".")
    .map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

function semverGt(a: string, b: string): boolean {
  const va = parseVer(a);
  const vb = parseVer(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const x = va[i] ?? 0;
    const y = vb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

let checking = false;

/**
 * GitHub Releases の最新版を1回チェックする (read-only GET のみ・書き込みなし)。
 * force=false は CHECK_INTERVAL_MS のスロットルに従う (/api/state sweep 相乗り用)。
 * 失敗しても throw しない (state.error に痕跡を残すだけ。直前の成功結果は保持する=
 * 一度見えた新版の案内を一時的なネットワーク断で引っ込めない)。
 */
export async function checkForUpdate(force: boolean): Promise<void> {
  if (checking) return;
  if (!force && state.checkedAt != null && Date.now() - state.checkedAt < CHECK_INTERVAL_MS) {
    return;
  }
  checking = true;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: {
        accept: "application/vnd.github+json",
        // GitHub API は User-Agent 必須。
        "user-agent": `winnow-updater/${CURRENT_VERSION}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      // Release が1件も無い (初回リリース前)。エラーではない。
      state = { ...state, checkedAt: Date.now(), error: null };
      return;
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const rel = (await res.json()) as {
      tag_name?: string;
      body?: string | null;
      html_url?: string;
    };
    const tag = rel.tag_name ?? "";
    state = {
      ...state,
      latestTag: tag || null,
      available: tag !== "" && semverGt(tag, CURRENT_VERSION),
      notes: rel.body ?? null,
      url: rel.html_url ?? null,
      checkedAt: Date.now(),
      error: null,
    };
  } catch (e) {
    state = { ...state, checkedAt: Date.now(), error: (e as Error).message };
  } finally {
    checking = false;
  }
}

/** /api/state の背景 sweep から呼ぶ薄い入口 (fire-and-forget・throw しない)。 */
export function sweepUpdateCheck(): void {
  void checkForUpdate(false);
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd: APP_ROOT, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** npm ci / vite build。NODE_ENV=production でも devDependencies (tsx/vite) を落とさない。 */
async function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  await pexec(bin, args, {
    cwd: APP_ROOT,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

let applying = false;

/**
 * 適用を開始する (進行は非同期、状態は getUpdateState().apply で追う)。
 * 手順: git fetch --tags → tag を detached checkout → npm ci → vite build →
 * 非0 exit (再起動は supervisor=systemd 等に委ねる。自前 re-exec はしない)。
 * ガードで弾いた場合は started:false + reason (decompose と同じ「点火するだけ」応答型)。
 * 失敗時は元 commit へのベストエフォート巻き戻し (checkout + npm ci + vite build) を試み、
 * apply.error に痕跡を残す。恒久復旧の手順は OPERATOR_GUIDE §7。
 */
export async function startApplyUpdate(): Promise<{ started: boolean; reason?: string }> {
  // 単一飛行ガードは同期で先に立てる (並行 POST の二重適用を塞ぐ)。
  if (applying) return { started: false, reason: "更新の適用が進行中です" };
  applying = true;
  try {
    // dev で適用すると tsx watch / vite dev と git 操作が衝突する。手動 git 運用に倒す。
    if (process.env.NODE_ENV !== "production") {
      return { started: false, reason: "自己更新は production 起動時のみです (dev は git で手動更新)" };
    }
    const tag = state.available ? state.latestTag : null;
    if (!tag) {
      return { started: false, reason: "適用できる新しいバージョンがありません (先に更新チェック)" };
    }
    // タグは固定リポジトリの Release 由来だが、git 引数に流す前に形を検証する (多層防御)。
    if (!/^[A-Za-z0-9._-]+$/.test(tag)) {
      return { started: false, reason: `タグ名が不正です: ${tag}` };
    }
    const { running } = inFlightCount();
    if (running > 0) {
      return {
        started: false,
        reason: `実行中のジョブが ${running} 件あります。完了/決着を待ってから更新してください`,
      };
    }
    try {
      await git(["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return { started: false, reason: "git 配備ではないため自己更新できません (OPERATOR_GUIDE §2)" };
    }
    // 手元変更があると checkout が上書き/失敗する。人間の作業を黙って踏まない。
    const dirty = await git(["status", "--porcelain"]);
    if (dirty !== "") {
      return { started: false, reason: "作業ツリーに未コミットの変更があります。退避してから更新してください" };
    }

    state = { ...state, apply: { phase: "fetching", error: null, startedAt: Date.now() } };
    void runApply(tag); // 以降は非同期 (進行は /api/state ポーリングで見える)。
    return { started: true };
  } finally {
    // started:true の場合は runApply 完了 (exit or failed) までロックを保持する。
    if (state.apply.phase === "idle" || state.apply.phase === "failed") applying = false;
  }
}

async function runApply(tag: string): Promise<void> {
  const setPhase = (phase: ApplyPhase, error: string | null = null) => {
    state = { ...state, apply: { ...state.apply, phase, error } };
  };
  let prevRef: string | null = null;
  let checkedOut = false;
  try {
    prevRef = await git(["rev-parse", "HEAD"]);
    await git(["fetch", "--tags", "--force", "origin"]);
    await git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
    await git(["-c", "advice.detachedHead=false", "checkout", "--detach", `refs/tags/${tag}`]);
    checkedOut = true;
    setPhase("installing");
    // --include=dev 必須: NODE_ENV=production の npm ci は devDependencies を落とし、
    // tsx (起動) と vite (ビルド) が消えて次回起動が死ぬ (OPERATOR_GUIDE §2 のはまりどころと同根)。
    await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], 15 * 60_000);
    setPhase("building");
    await run("npx", ["vite", "build"], 10 * 60_000);
    setPhase("restarting");
    console.log(`[winnow] update applied: ${state.currentVersion} -> ${tag}. exiting for restart.`);
    // 非0 exit: systemd の Restart=on-failure / always どちらでも上がり直す。
    // 応答中のリクエストを流し切る猶予だけ置く (更新の完了報告は再起動後の新プロセスが担う)。
    setTimeout(() => process.exit(75), 1000);
  } catch (e) {
    let msg = (e as Error).message.slice(0, 2000);
    // ベストエフォート巻き戻し: checkout 済みなら元 commit へ戻し、依存とビルドも作り直して
    // 「ソース旧・node_modules 新」の食い違いで走り続ける状態を避ける。失敗は痕跡に併記して手動へ。
    if (checkedOut && prevRef) {
      try {
        await git(["checkout", "--detach", prevRef]);
        await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], 15 * 60_000);
        await run("npx", ["vite", "build"], 10 * 60_000);
        msg += ` (元のバージョン ${prevRef.slice(0, 12)} へ巻き戻し済み)`;
      } catch (re) {
        msg += ` / 巻き戻しにも失敗: ${(re as Error).message.slice(0, 500)}。手動復旧が必要です (TROUBLESHOOTING)`;
      }
    }
    console.error(`[winnow] update apply failed: ${msg}`);
    setPhase("failed", msg);
    applying = false;
  }
}
