// README デモGIF の収録(GUIフロー)。Playwright で実アプリ(本番ビルド)を操作し、
// 各フローを webm 動画として書き出す。変換(webp化)は demo/convert.mjs。
//
// 決定性のため: 固定ビューポート、reducedMotion、シードDB+フェイクAI(WINNOW_FAKE_AI=1)前提。
// セレクタは製品の安定した日本語ラベル/role を基準にする(文言変更時はここだけ直せばよい)。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const VW = 1280;
const VH = 800;

// 事前インストール済みの Chromium を使う(playwright のバージョンとブラウザ revision がずれても動くよう
// executablePath を明示解決する。env の PLAYWRIGHT_BROWSERS_PATH 下の chromium-*/chrome を拾う)。
function resolveChromium() {
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
    /* fall through to bundled */
  }
  return undefined; // playwright 既定にフォールバック
}

// 疑似マウスカーソル(Playwright の動画には OS カーソルが映らないため自前で描く)。
async function installCursor(page) {
  await page.addInitScript(() => {
    const ensure = () => {
      if (document.getElementById("__democursor")) return;
      const c = document.createElement("div");
      c.id = "__democursor";
      c.style.cssText =
        "position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(120,180,255,.45);border:2px solid #7ab8ff;pointer-events:none;transition:transform .08s ease;left:-50px;top:-50px;box-shadow:0 0 8px rgba(122,184,255,.7)";
      (document.body || document.documentElement).appendChild(c);
      document.addEventListener("mousemove", (e) => {
        c.style.left = e.clientX + "px";
        c.style.top = e.clientY + "px";
      });
      document.addEventListener("mousedown", () => (c.style.transform = "scale(.6)"));
      document.addEventListener("mouseup", () => (c.style.transform = "scale(1)"));
    };
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", ensure);
    else ensure();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 要素中心へカーソルを滑らかに動かしてからクリック(使用感が伝わる)。
async function moveTo(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("no bounding box for " + (await locator.toString?.()));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await sleep(250);
}
async function click(page, locator) {
  await moveTo(page, locator);
  await locator.click();
  await sleep(400);
}

// 実行結果ペイン(details)を開く。着地時の再描画で閉じた状態に戻るため、開きたい場面ごとに呼ぶ。
// ラベル文言はここ1箇所に集約(文言変更時の直し漏れを防ぐ)。
async function openResultPane(page, card) {
  await click(page, card.getByText(/実行結果 \/ メモを見る/).first());
}

// --- 各フロー --------------------------------------------------------------

async function flowCaptureToQueue(page) {
  await page.goto(base("/"));
  await page.getByRole("tab", { name: /キュー/ }).waitFor();
  await sleep(900);
  const ta = page.getByPlaceholder(/雑に貼る/);
  await moveTo(page, ta);
  await ta.click();
  await ta.type("取引先に請求書PDFをメールで送る", { delay: 70 });
  await sleep(500);
  await click(page, page.getByRole("button", { name: "登録して分類" }));
  // 分類されてキューに『要確認』で着地するのを待つ(フェイクAIが ~1.2s で返す+ポーリング)。
  const card = page.locator(".card", { hasText: "取引先に請求書PDF" });
  await card.waitFor({ timeout: 20000 });
  await card.scrollIntoViewIfNeeded();
  await sleep(2600);
}

async function flowQueueAndLenses(page) {
  await page.goto(base("/"));
  await page.locator(".card").first().waitFor();
  await sleep(1200);
  // 「自動で畳んだ N 件」バンド → 要確認だけの短いキューをざっと見せる。
  // 降りた分だけ正確に戻す(ずれるとレンズ切替時に補正ジャンプが映る)。
  let scrolled = 0;
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 70);
    scrolled += 70;
    await sleep(200);
  }
  await sleep(600);
  await page.mouse.wheel(0, -scrolled);
  await sleep(800);
  // 俯瞰レンズ: 同じキューを「案件」レーン → 「見通し」(rung×due) に掛け替える。
  const lens = page.getByRole("group", { name: "俯瞰レンズ" });
  await click(page, lens.getByRole("button", { name: "案件" }));
  await page.locator(".lane-section").first().waitFor();
  await sleep(2200);
  await click(page, lens.getByRole("button", { name: "見通し" }));
  await page.locator(".horizon").waitFor();
  await sleep(2600);
  await click(page, lens.getByRole("button", { name: "まとめない" }));
  await sleep(1200);
}

async function flowDispositionAndUndo(page) {
  await page.goto(base("/"));
  const card = page.locator(".card", { hasText: "顧客Aへの再提案" });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await sleep(1000);
  // 「分類し直す…」で要確認→要判断へ(普段の一手＝教師信号)。
  // auto に倒すとカード自体がキューから畳まれ、undo の手がかりも一緒に消えるため、
  // カードが残る human 方向で「覆す→戻す」の両方を1カード上で見せる。
  // 自前 Select (Radix) はネイティブ selectOption が効かない: トリガーを開いて option をクリック。
  const select = card.getByLabel("分類し直す");
  await moveTo(page, select);
  await select.click();
  await page.getByRole("option", { name: "要判断に変更" }).click();
  // バッジが「要判断」に変わるのを待ってから見せる。
  await card.locator(".badge", { hasText: "要判断" }).waitFor({ timeout: 8000 });
  await sleep(1800);
  // 直前のさばきを取り消せる(『さばきを戻す』)。必ず同じカード内のリンクを押す
  // (ページ先頭の .first() は、シード由来の undo リンクを持つ別カードに化ける)。
  // undo リンクはバッジと同じ再描画で現れるので追加の waitFor は不要(click が可視を待つ)。
  await click(page, card.getByRole("button", { name: /さばきを戻す/ }));
  await card.locator(".badge", { hasText: "要確認" }).waitFor({ timeout: 8000 });
  await sleep(2000);
}

async function flowApproveRunHandoff(page) {
  await page.goto(base("/"));
  const card = page.locator(".card", { hasText: "本番DBスキーマ" });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await sleep(900);
  // 計画プレビュー(実行されたら何が起きるか)を開く。
  const preview = card.getByText(/計画プレビュー/);
  if (await preview.count()) {
    await click(page, preview.first());
    await sleep(1400);
  }
  // ワンタップ承認 → 実行中 → 高ステークスなので done に沈まず「引き取り待ち」で戻る。
  await click(page, card.getByRole("button", { name: "承認して実行" }));
  const receive = card.getByRole("button", { name: /確認して完了/ });
  await receive.waitFor({ timeout: 10000 }); // フェイク実行(~1.6s)+ポーリング反映
  await card.scrollIntoViewIfNeeded();
  await sleep(800);
  // markdown の結果(表・巻き戻し手順)を開いて見せる。台本(fake-driver)の label 分岐が
  // 外れて既定台本に落ちると別タスクの結果が映る=無言で誤った画になるので、内容まで検証する。
  // ペインは再マウント時だけ閉じて戻るので「閉じていたら開く」(開いたままなら二度押しで閉じない)。
  const resultText = card.getByText(/マイグレーションを適用しました/).first();
  await resultText.waitFor({ state: "attached", timeout: 5000 });
  if (!(await resultText.isVisible())) await openResultPane(page, card);
  await resultText.waitFor({ timeout: 5000 });
  await sleep(3200);
  // 人間が受け取って畳む=成功の終端。採用(本番反映の判断)は人間の側に残る。
  await click(page, receive);
  await sleep(2200);
}

async function flowHandoffFixLoop(page) {
  await page.goto(base("/"));
  const card = page.locator(".card", { hasText: "依存パッケージ更新PR" });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await sleep(1000);
  // 引き取り待ちの成果物(PR リンク)と実行結果を開いて見せる。
  await openResultPane(page, card);
  await sleep(1800);
  // レビュー指摘が付いた想定で、一行指示 → 同じ実行をやり直させる(最頻ループ)。
  const input = card.getByLabel("直す方向を一行で指示");
  await click(page, input);
  await input.type("レビュー指摘: lockfileの差分を小さくして再push", { delay: 55 });
  await sleep(500);
  await click(page, card.getByRole("button", { name: "この指示でやり直す" }));
  // 再走中はカードがキューからいったん消え、完了すると「引き取り待ち」で再提示される。
  // 完了の合図は「新しい結果テキストが DOM に載ること」で待つ(attached)。閉じた details 内は
  // visible にならず、消滅→再出現の2段待ちはポーリング間隔と競合しうるため、これが最も確実。
  const newText = card.getByText(/PR #482 を更新しました/).first();
  await newText.waitFor({ state: "attached", timeout: 15000 });
  await card.scrollIntoViewIfNeeded();
  await sleep(800);
  // 指摘対応済みの新しい結果(markdown)を見せる。ペインが閉じていたら開く(04 と同じ理由)。
  if (!(await newText.isVisible())) await openResultPane(page, card);
  await newText.waitFor({ timeout: 5000 });
  await sleep(3400);
}

async function flowTerminalTheater(page) {
  await page.goto(base("/"));
  await click(page, page.getByRole("tab", { name: /セッション/ }));
  await sleep(900);
  // worker セッションを選ぶ(claude が作業中の様子)。
  const worker = page.getByRole("button", { name: /worker-0/ });
  await worker.waitFor();
  await click(page, worker);
  // 端末出力が1行ずつ流れるのをしばらく見せる。
  await page.locator(".term").waitFor();
  await sleep(13000);
}

const FLOWS = [
  ["01-capture-to-queue", flowCaptureToQueue],
  ["02-queue-and-lenses", flowQueueAndLenses],
  ["03-disposition-and-undo", flowDispositionAndUndo],
  ["04-approve-run-handoff", flowApproveRunHandoff],
  ["05-handoff-fix-loop", flowHandoffFixLoop],
  ["06-terminal-theater", flowTerminalTheater],
];

let BASE = "http://127.0.0.1:8799";
const base = (p) => BASE + p;

export async function recordAll(baseURL, recDir, only) {
  BASE = baseURL;
  fs.mkdirSync(recDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ["--no-sandbox"],
  });
  try {
    for (const [name, fn] of FLOWS) {
      if (only && !only.includes(name)) continue;
      const ctx = await browser.newContext({
        viewport: { width: VW, height: VH },
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
        recordVideo: { dir: recDir, size: { width: VW, height: VH } },
      });
      const page = await ctx.newPage();
      await installCursor(page);
      console.log(`  ▸ recording ${name} …`);
      try {
        await fn(page);
      } catch (e) {
        console.error(`    ! ${name} failed:`, e.message);
      }
      const video = page.video();
      await ctx.close(); // ここで webm が確定する
      if (video) {
        const src = await video.path();
        const dest = path.join(recDir, `${name}.webm`);
        fs.renameSync(src, dest);
        console.log(`    ✓ ${dest}`);
      }
    }
  } finally {
    await browser.close();
  }
}

// 単体実行: node demo/record.mjs [baseURL]
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2] || BASE;
  await recordAll(url, path.join(process.cwd(), "demo", ".rec"));
}
