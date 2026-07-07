// 実ブラウザの web smoke (demo/run.mjs / demo/record.mjs の流儀を流用した重い任意ゲート)。
//   本番ビルド → 使い捨て WINNOW_HOME + フェイクAI(WINNOW_FAKE_AI=1) + 空きポートでサーバ起動 →
//   シード投入 → Playwright(chromium headless) で以下を検証する:
//     1) キューにカードが描画される (escalate 2件 / autoDone 取消ハンドル / レビュー束のネスト描画)
//     2) 「検索 / 絞り込み」トグルが開閉し、テキスト絞り込みが表示集合を絞る
//     3) 主要な処分ボタン「却下」を1回押すとカードがキューから消える (処分=ラベルの終端)
//     4) バックログの削除が自前確認ダイアログ(alertdialog)経由で完了する
//        (ネイティブ confirm 非依存の検証。抑制環境で「無反応」にならない置換の回帰ゲート)
//     5) ページの console error / pageerror が 0 件
// シードは API (POST /api/items → フェイク分類が escalate で着地) を正とし、API では作れない形
// (autoDone の取消ハンドル・reviewOfId のレビュー束) だけサーバ起動前に repo 直書きで用意する
// (scripts-seed-demo.ts と同じ流儀)。決定論のため待ちはすべて条件+タイムアウト(固定 sleep 非依存)。
// 実行: npm run smoke:web
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// タイトルは互いに部分文字列にならないようにする (locator の一意性を保つ)。
const TITLE_REJECT = "経費精算の督促メールを送る(却下スモーク)";
const TITLE_KEEP = "週次レポートの下書きを作る(確認スモーク)";
const TITLE_AUTODONE = "依存パッケージの棚卸し(自動実行済みスモーク)";
const TITLE_REVIEW = "レビュー: 棚卸し結果の確認(レビュー束スモーク)";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function runSync(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${String(r.status)}`);
}

/** OS に空きポートを1つ選ばせる (固定ポートの残骸サーバと衝突しない)。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("空きポートを確保できませんでした")));
      }
    });
  });
}

// 事前インストール済み Chromium の解決 (demo/record.mjs と同じ流儀)。
// PLAYWRIGHT_BROWSERS_PATH 下の chromium-*/chrome-linux/chrome を拾い、無ければ playwright 既定。
function resolveChromium(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    const dir = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .pop();
    if (dir) {
      const p = path.join(root, dir, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* playwright 既定にフォールバック */
  }
  return undefined;
}

/** /healthz を条件待ち (demo/run.mjs の waitForHealth の流儀。自サーバ死亡時は即中断)。 */
async function waitForHealth(base: string, died: () => Error | null, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const err = died();
    if (err) throw err;
    try {
      const r = await fetch(base + "/healthz");
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error("サーバが時間内に healthy になりませんでした");
}

/** 条件+タイムアウトのポーリング待ち (固定 sleep 依存にしないための共通ヘルパ)。 */
async function waitUntil(cond: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(250);
  }
  throw new Error(`条件待ちがタイムアウトしました: ${what}`);
}

/** SIGTERM → 猶予内に exit しなければ SIGKILL (終了処理を確実に)。 */
function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/** 本番 index.html に注入されるローカルシークレットを読む (状態変更系 API のシードに必要)。 */
async function fetchSecret(base: string): Promise<string> {
  const html = await (await fetch(base + "/")).text();
  const m = html.match(/window\.__WINNOW_SECRET__="([0-9a-f]+)"/);
  if (!m?.[1]) throw new Error("index.html からローカルシークレットを取得できませんでした");
  return m[1];
}

async function main(): Promise<void> {
  console.log("• 本番ビルド(web/dist)");
  runSync("npx", ["vite", "build"]);

  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "winnow-smoke-web-"));
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  let server: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    // --- シード(1/2): API では作れない形だけサーバ起動前に repo 直書き --------------------
    // repo/db は import 時に WINNOW_HOME を読む (config.ts) ため、動的 import の前に環境を固定する。
    console.log("• シード投入(repo 直書き: autoDone 取消ハンドル + レビュー束)");
    process.env.WINNOW_HOME = HOME;
    const { items, settings } = await import("./src/server/repo.js");
    // 監査サンプルの乱数チラつきを消して決定論に (scripts-seed-demo.ts と同じ配慮)。
    settings.update({ auditRate: 0 });
    const src = items.create({ title: TITLE_AUTODONE, kind: "leaf", status: "done" });
    items.update(src.id, {
      autoExecuted: true,
      executionStatus: "succeeded",
      executionResult: "依存パッケージ3件の棚卸し結果をまとめました(スモーク用ダミー)。",
    });
    // レビュー leaf: 対象カードと同時にキューへ出て「└ この実行結果のレビュー」で束ね描画される。
    items.create({
      title: TITLE_REVIEW,
      kind: "leaf",
      status: "classified",
      disposition: "escalate",
      reason: "自動実行の成果物を確認してください。",
      reviewOfId: src.id,
    });

    // --- サーバ起動 (フェイクAI・本番配信・使い捨てホーム) ------------------------------
    console.log(`• サーバ起動(フェイクAI, port=${PORT})`);
    // npx ラッパー経由にしない: npx は SIGTERM を子へ転送せず自分だけ死ぬため、
    // stopServer がラッパーしか殺せず実サーバがオーファン化する (stdout を握り続け
    // パイプ実行もハングする)。ローカルの tsx bin は SIGTERM を子 node へ転送する。
    server = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), ["src/server/index.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        WINNOW_HOME: HOME,
        WINNOW_FAKE_AI: "1",
        WINNOW_PORT: String(PORT),
        NODE_ENV: "production",
      },
      stdio: "inherit",
    });
    let serverDied: Error | null = null;
    // exit は (code, signal) 両対応にする: シグナル死は code=null で来る。
    // spawn 自体の失敗 (ENOENT 等) は exit ではなく error で来る上、リスナーが無いと
    // unhandled 'error' で finally (ブラウザ/一時ディレクトリの後始末) ごと即死する。
    server.on("exit", (code, signal) => {
      if (code || signal) {
        serverDied = new Error(
          `server exited early (code=${String(code)}, signal=${String(signal)})`,
        );
      }
    });
    server.on("error", (e) => {
      serverDied = new Error(`server spawn failed: ${String(e)}`);
    });
    await waitForHealth(BASE, () => serverDied);

    // --- シード(2/2): API 捕獲 → フェイク分類が escalate で着地しキューに出るまで条件待ち ---
    console.log("• シード投入(API 捕獲 → escalate 着地待ち)");
    const secret = await fetchSecret(BASE);
    const post = async (p: string, body: unknown): Promise<{ id: string }> => {
      const r = await fetch(BASE + p, {
        method: "POST",
        headers: { "content-type": "application/json", "x-winnow-secret": secret },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`POST ${p} -> ${r.status} ${await r.text()}`);
      return (await r.json()) as { id: string };
    };
    const a = await post("/api/items", { title: TITLE_REJECT });
    const b = await post("/api/items", { title: TITLE_KEEP });
    const queueIds = async (): Promise<Set<string>> => {
      const r = await fetch(BASE + "/api/state");
      if (!r.ok) throw new Error(`GET /api/state -> ${r.status}`);
      const st = (await r.json()) as { queue: { id: string }[] };
      return new Set(st.queue.map((q) => q.id));
    };
    await waitUntil(async () => {
      const ids = await queueIds();
      return ids.has(a.id) && ids.has(b.id);
    }, "API シード2件がフェイク分類(escalate)でキューに出る");

    // --- 実ブラウザ検証 (chromium headless) ---------------------------------------------
    console.log("• ブラウザ検証(Playwright chromium headless)");
    browser = await chromium.launch({
      executablePath: resolveChromium(),
      args: ["--no-sandbox"],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });
    const page: Page = await ctx.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /キュー/ }).waitFor({ timeout: 20_000 });

    // カードはタイトル(.card-title)で特定する: レビューカードの「レビュー対象:」チップに
    // 対象タイトルが含まれるため、カード全文一致 (hasText) では二重マッチする。
    const cardByTitle = (t: string): Locator =>
      page.locator(".card").filter({ has: page.locator(".card-title", { hasText: t }) });

    // 1) キュー描画: 4枚(却下対象/残留/autoDone/レビュー) + レビュー束のネスト描画。
    for (const t of [TITLE_REJECT, TITLE_KEEP, TITLE_AUTODONE, TITLE_REVIEW]) {
      await cardByTitle(t).waitFor({ timeout: 20_000 });
    }
    await page.getByText("この実行結果のレビュー").waitFor({ timeout: 20_000 });
    assert.equal(await page.locator(".card").count(), 4, "キューのカードは4枚");
    // autoDone は受領(確認して畳む)ボタン、レビューは束で畳むボタンを持つ (処分導線の描画確認)。
    await cardByTitle(TITLE_AUTODONE)
      .getByRole("button", { name: "確認して畳む" })
      .waitFor({ timeout: 20_000 });
    await cardByTitle(TITLE_REVIEW)
      .getByRole("button", { name: "問題なし（束で畳む）" })
      .waitFor({ timeout: 20_000 });

    // 2) 検索・絞り込みトグルの開閉 + テキスト絞り込みが効く。
    await page.getByRole("button", { name: "検索 / 絞り込み" }).click();
    await page.locator(".filter-bar").waitFor({ timeout: 20_000 });
    await page.getByLabel("テキスト検索").fill("却下スモーク");
    await waitUntil(
      async () => (await page.locator(".card").count()) === 1,
      "テキスト絞り込みで表示が1枚になる",
    );
    await page.getByRole("button", { name: "検索を閉じる" }).click();
    await page.locator(".filter-bar").waitFor({ state: "detached", timeout: 20_000 });
    await waitUntil(
      async () => (await page.locator(".card").count()) === 4,
      "絞り込み解除で表示が4枚に戻る",
    );

    // 3) 主要処分「却下」を1回: カードがキューから消える (queue.ts: rejected は畳む)。
    await cardByTitle(TITLE_REJECT).getByRole("button", { name: "却下", exact: true }).click();
    await cardByTitle(TITLE_REJECT).waitFor({ state: "detached", timeout: 20_000 });
    await waitUntil(
      async () => (await page.locator(".card").count()) === 3,
      "却下後はカードが3枚になる",
    );

    // 4) バックログの削除: 自前確認ダイアログ経由で実削除まで通す (ネイティブ confirm 非依存)。
    //    「やめる」でキャンセルできること(残存)も先に確認する。
    await page.getByRole("tab", { name: "バックログ" }).click();
    const rowKeep = page.locator(".tree-row").filter({ hasText: TITLE_KEEP });
    await rowKeep.waitFor({ timeout: 20_000 });
    await rowKeep.getByRole("button", { name: "削除" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "やめる" }).click();
    await dialog.waitFor({ state: "detached", timeout: 20_000 });
    assert.equal(await rowKeep.count(), 1, "キャンセル後もアイテムは残る");
    await rowKeep.getByRole("button", { name: "削除" }).click();
    await dialog.waitFor({ timeout: 20_000 });
    await dialog.getByRole("button", { name: "削除する" }).click();
    await rowKeep.waitFor({ state: "detached", timeout: 20_000 });

    // 5) console error 0件 (pageerror 含む)。
    assert.equal(
      consoleErrors.length,
      0,
      `console error は0件のはず: ${consoleErrors.join(" | ")}`,
    );

    console.log(
      "smoke:web OK: キュー描画 / 絞り込みトグル / 却下の処分 / ダイアログ経由の削除 / console error 0件",
    );
  } finally {
    // 終了処理は demo/run.mjs に倣い確実に: ブラウザ → サーバ → 使い捨てホームの順で畳む。
    if (browser) await browser.close().catch(() => {});
    if (server) await stopServer(server);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
