// 自己更新 (DECISIONS「自己更新」節)。検知と適用を分離する:
//  - 検知 = GitHub Releases API への read-only GET。/api/state の背景 sweep に相乗りして
//    スロットル付きで叩く (常駐タイマーは作らない。sweepLateExecutions と同型)。
//  - 適用 = 人間のワンタップ (POST /api/update/apply、状態変更系=ローカルシークレット要求) のみ。
//    自動適用はしない (マイグレーション失敗で無人のまま起動不能になるリスクを人間の目なしに踏まない)。
// 信頼境界 (INVARIANTS「自己更新の信頼境界」): 取得元はコード内定数 UPDATE_REPO と
// clone の origin だけで、API/設定からは変更できない (許可リストを API から緩めない非対称ポリシー)。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT } from "./config.js";
import { inFlightCount } from "./executor.js";

const pexec = promisify(execFile);

/** 検知の取得元 (ハードコード固定。settings/env から変更できないことが信頼境界)。 */
const UPDATE_REPO = "skaji18/winnow";

// 検知のスロットル。/api/state ポーリング(3秒毎)に相乗りするため、実発火はこの間隔まで。
// 失敗時は短い間隔で再試行する (一過性のネットワーク断が6時間の空白にならないように)。
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_RETRY_MS = 15 * 60 * 1000;

/** 現在バージョン (配備ルートの package.json が単一の真実源。Release タグと突き合わせる)。 */
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

export type ApplyPhase =
  | "idle"
  | "fetching"
  | "installing"
  | "building"
  | "restarting"
  | "failed";

export interface UpdateState {
  latestTag: string | null;
  available: boolean;
  url: string | null;
  checkedAt: number | null;
  error: string | null;
  apply: { phase: ApplyPhase; error: string | null; startedAt: number | null };
}

// 非永続 (プロセス内メモリ)。起動毎に再チェックする一時状態で DB/Settings に持たない。
// リリースノート本文は保持しない (UI が使わない KB 級テキストを 3 秒毎の /api/state に
// 乗せない。人間は url のリンク先で読む)。
let state: UpdateState = {
  latestTag: null,
  available: false,
  url: null,
  checkedAt: null,
  error: null,
  apply: { phase: "idle", error: null, startedAt: null },
};

export function getUpdateState(): UpdateState {
  return { ...state, apply: { ...state.apply } };
}

/**
 * "v1.2.3(-suffix)" を { 数値配列, prerelease か } へ。数値として読めない断片は 0 に倒す。
 * prerelease は同一本体バージョンの正式版より古い (semver 順序。-rc を「より新しい」と
 * 誤判定して正式版からプレリリースへ「更新」を案内しない)。
 */
function parseVer(tag: string): { nums: number[]; pre: boolean } {
  const bare = tag.replace(/^v/, "");
  const [main, ...rest] = bare.split("-");
  const nums = (main ?? "").split(".").map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return { nums, pre: rest.length > 0 };
}

function semverGt(a: string, b: string): boolean {
  const va = parseVer(a);
  const vb = parseVer(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = va.nums[i] ?? 0;
    const y = vb.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  // 本体が同一: prerelease < 正式版。
  if (va.pre !== vb.pre) return vb.pre;
  return false;
}

let inflightCheck: Promise<void> | null = null;
let nextCheckAt = 0; // スロットルの内部時計 (checkedAt は表示用に最終試行時刻を持つ)。

/**
 * GitHub Releases の最新版を1回チェックする (read-only GET のみ・書き込みなし)。
 * force=false はスロットルに従う (/api/state sweep 相乗り用)。チェックが進行中なら
 * force でもそれに相乗りして完了を待つ (「更新を確認」ボタンが空振りして古い状態を
 * 返さないように)。失敗しても throw しない (state.error に痕跡を残すだけ。直前の
 * 成功結果は保持する=一度見えた新版の案内を一時的なネットワーク断で引っ込めない)。
 */
export function checkForUpdate(force: boolean): Promise<void> {
  // フェイクAI環境 (デモ録画・検証。demo/run.mjs) では外部 GitHub API を叩かない
  // (録画を hermetic に保つ + 新版バナーがスクリーンショットに混入しない)。
  if (process.env.WINNOW_FAKE_AI === "1") return Promise.resolve();
  if (inflightCheck) return inflightCheck;
  if (!force && Date.now() < nextCheckAt) return Promise.resolve();
  inflightCheck = doCheck().finally(() => {
    inflightCheck = null;
  });
  return inflightCheck;
}

async function doCheck(): Promise<void> {
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
      nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
      return;
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    const tag = rel.tag_name ?? "";
    state = {
      ...state,
      latestTag: tag || null,
      available: tag !== "" && semverGt(tag, CURRENT_VERSION),
      url: rel.html_url ?? null,
      checkedAt: Date.now(),
      error: null,
    };
    nextCheckAt = Date.now() + CHECK_INTERVAL_MS;
  } catch (e) {
    state = { ...state, checkedAt: Date.now(), error: (e as Error).message };
    nextCheckAt = Date.now() + CHECK_RETRY_MS;
  }
}

/** /api/state の背景 sweep から呼ぶ薄い入口 (fire-and-forget・throw しない)。 */
export function sweepUpdateCheck(): void {
  void checkForUpdate(false);
}

// 子プロセスは必ず timeout / maxBuffer 付きで起動する (単一のラッパー経由。
// 無タイムアウトの git fetch が固まると applying ロックが永久に残るため)。
async function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await pexec(bin, args, {
    cwd: APP_ROOT,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

const GIT_TIMEOUT_MS = 5 * 60_000;
const git = (args: string[]) => run("git", args, GIT_TIMEOUT_MS);

/**
 * npm ci + フロントエンドビルド。適用の前進と巻き戻しで共有する (片方だけの修正ドリフト防止)。
 * onPhase は前進時のみ渡す (巻き戻し中は failed への遷移を上書きしない)。
 */
async function installAndBuild(onPhase?: (p: ApplyPhase) => void): Promise<void> {
  onPhase?.("installing");
  // --include=dev 必須: NODE_ENV=production の npm ci は devDependencies を落とし、
  // tsx (起動) と vite (ビルド) が消えて次回起動が死ぬ (OPERATOR_GUIDE §2 のはまりどころと同根)。
  await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], 15 * 60_000);
  onPhase?.("building");
  // ビルドレシピは checkout 済みツリーの package.json (update:build) が持つ。適用器 (旧版の
  // このコード) に新版のビルド手順を焼き込まない=将来ビルド手順が変わっても旧配備から適用できる。
  // web/dist を直接上書きしない: 配信中の dist を空にすると再読込が数分間 404/500 になるため、
  // dist-next に出してから瞬時に入れ替える。
  await run("npm", ["run", "update:build"], 10 * 60_000);
  const dist = path.join(APP_ROOT, "web", "dist");
  const next = path.join(APP_ROOT, "web", "dist-next");
  fs.rmSync(dist, { recursive: true, force: true });
  fs.renameSync(next, dist);
}

// systemd の Restart=on-failure / always どちらでも上がり直すよう非0で exit する。
// 75 = EX_TEMPFAIL (一時的な終了=再起動で続行、の意図に最も近い慣用値)。
const EXIT_CODE_RESTART = 75;

let applying = false;

/** 適用進行中か (routes が自動着火の点火を止めるのに使う。点火→即 exit の轢き逃げ防止)。 */
export function isApplyInProgress(): boolean {
  return applying;
}

/**
 * 適用を開始する (進行は非同期、状態は getUpdateState().apply で追う)。
 * 手順: git fetch --tags → tag を detached checkout → installAndBuild → 非0 exit
 * (再起動は supervisor=systemd 等に委ねる。自前 re-exec はしない)。
 * ガードで弾いた場合は started:false + reason (decompose と同じ「点火するだけ」応答型)。
 * 失敗時は元 commit へのベストエフォート巻き戻しを試み、apply.error に痕跡を残す。
 * 恒久復旧の手順は OPERATOR_GUIDE §7 / TROUBLESHOOTING。
 */
export async function startApplyUpdate(): Promise<{ started: boolean; reason?: string }> {
  // 単一飛行ガードは同期で先に立てる (並行 POST の二重適用を塞ぐ)。
  if (applying) return { started: false, reason: "更新の適用が進行中です" };
  applying = true;
  let ignited = false;
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
    // npm がサーバプロセスの PATH から解決できるかを checkout 前に確かめる (checkout 後に
    // ENOENT で倒れると巻き戻しの npm も同様に失敗し、復旧の手数が増える)。
    try {
      await run("npm", ["--version"], 30_000);
    } catch {
      return {
        started: false,
        reason: "npm がサーバプロセスの PATH から解決できません (supervisor の PATH 設定を確認)",
      };
    }
    // 追跡ファイルの手元変更があると checkout が上書き/失敗する。人間の作業を黙って踏まない
    // (未追跡ファイルは checkout を妨げないので対象外 = -uno)。
    const dirty = await git(["status", "--porcelain", "-uno"]);
    if (dirty !== "") {
      return { started: false, reason: "作業ツリーに未コミットの変更があります。退避してから更新してください" };
    }

    state = { ...state, apply: { phase: "fetching", error: null, startedAt: Date.now() } };
    ignited = true;
    void runApply(tag); // 以降は非同期 (進行は /api/state ポーリングで見える)。
    return { started: true };
  } finally {
    // 点火できなかった場合のみここで解放する (点火後の解放は runApply の失敗経路が担う。
    // 成功経路はプロセスごと exit するので解放不要)。
    if (!ignited) applying = false;
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
    await installAndBuild(setPhase);
    setPhase("restarting");
    console.log(`[winnow] update applied: v${CURRENT_VERSION} -> ${tag}. exiting for restart.`);
    // 応答中のリクエストを流し切る猶予だけ置く (更新の完了報告は再起動後の新プロセスが担う)。
    setTimeout(() => process.exit(EXIT_CODE_RESTART), 1000);
  } catch (e) {
    let msg = (e as Error).message.slice(0, 2000);
    // 失敗時に dist-next が残ると次回適用のゴミになるので掃除する (dist は無傷のまま)。
    fs.rmSync(path.join(APP_ROOT, "web", "dist-next"), { recursive: true, force: true });
    // ベストエフォート巻き戻し: checkout 済みなら元 commit へ戻し、依存とビルドも作り直して
    // 「ソース旧・node_modules 新」の食い違いで走り続ける状態を避ける。失敗は痕跡に併記して手動へ。
    if (checkedOut && prevRef) {
      try {
        await git(["checkout", "--detach", prevRef]);
        await installAndBuild();
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
