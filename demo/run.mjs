// README デモGIF をワンコマンドで再生成する。
//   使い捨てDB作成 → シード → 本番ビルド → フェイクAIでサーバ起動 → 収録 → webp変換 → 後片付け
// 機能改修で見た目が変わったら `npm run demo` を流し直すだけで撮り直せる(docs/DEMO_GIF_PLAN)。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordAll } from "./record.mjs";
import { convertAll } from "./convert.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = path.join(ROOT, "demo", ".home"); // 使い捨ての WINNOW_HOME(gitignore 済み)
const REC = path.join(ROOT, "demo", ".rec"); // 中間 webm(gitignore 済み)
const ASSETS = path.join(ROOT, "docs", "assets");
const PORT = process.env.WINNOW_PORT || "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const only = process.argv.slice(2); // 例: npm run demo -- 06-terminal-theater

const env = { ...process.env, WINNOW_HOME: HOME, WINNOW_FAKE_AI: "1", WINNOW_PORT: PORT };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, env, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

async function waitForHealth(url, died = () => null, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const err = died();
    if (err) throw err; // 自分のサーバが落ちた → 残骸に当てに行かず中断
    try {
      const r = await fetch(url + "/healthz");
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("server did not become healthy in time");
}

async function main() {
  console.log("• クリーン: 使い捨てDB/中間物を削除");
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(REC, { recursive: true, force: true });

  console.log("• シード投入(デモ状態)");
  run("npx", ["tsx", "scripts-seed-demo.ts"]);

  console.log("• 本番ビルド(web/dist)");
  run("npm", ["run", "build"]);

  // 残骸サーバが同じポートを掴んでいると、古いデータに対して録画してしまう。先に解放する。
  spawnSync("bash", ["-c", `fuser -k ${PORT}/tcp 2>/dev/null; sleep 1`], { stdio: "ignore" });

  console.log("• サーバ起動(フェイクAI)");
  // detached: プロセスグループを分け、終了時に npx→tsx→node の木ごと畳めるようにする。
  const server = spawn("npx", ["tsx", "src/server/index.ts"], {
    cwd: ROOT,
    env: { ...env, NODE_ENV: "production" },
    stdio: "inherit",
    detached: true,
  });
  // 自分のサーバが起動前に落ちたら(EADDRINUSE 等)即中断する。古いサーバに対して録画しないため。
  let serverDied = null;
  server.on("exit", (code) => {
    if (code) serverDied = new Error(`server exited early with code ${code}`);
  });
  try {
    await waitForHealth(BASE, () => serverDied);
    console.log("• 収録(Playwright)");
    await recordAll(BASE, REC, only.length ? only : null);
  } finally {
    // SIGTERM を直接の子(npx ラッパー)だけに送ると孫の server 本体が生き残り、
    // spawn ハンドルがイベントループを掴んで npm run demo が永久に終わらない。
    // detached で分けたプロセスグループごと畳む(取りこぼしは SIGKILL で保険)。
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  }

  console.log("• 変換(webm → webp)");
  convertAll(REC, ASSETS);

  console.log("\n完了: docs/assets/*.webp を更新しました。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
