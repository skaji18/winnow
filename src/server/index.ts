import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ensureDirs, SERVER_HOST, SERVER_PORT } from "./config.js";
import "./db.js"; // initialize schema (quick_check 失敗時はここで throw して listen 前に落ちる)
import { registerRoutes } from "./api/routes.js";
import { registerMcp } from "./mcp/transport.js";
import { getDriver } from "./ai/index.js";
import { reconcileOnBoot, inFlightCount } from "./executor.js";
import { recoverStuckDecomposes } from "./decomposer.js";
import { preflightCheck } from "./ai/preflight.js";
import { CURRENT_VERSION } from "./updater.js";
import { getRuntimeState, setReconcile, setPreflight } from "./runtime-state.js";
import {
  registerSecurityHook,
  LOCAL_SECRET,
  originAllowed,
  BIND_IS_LOOPBACK,
  REMOTE_EXPOSED,
} from "./security.js";

ensureDirs();

// 起動時 reconcile/preflight は db 初期化直後・listen 前に一度だけ。reconcile は AI を
// 起動せず DB と IPC sentinel のみ参照する決定論処理(背骨§1.3, winnow は read-only 痕跡のみ)。
// reconcile/preflight の例外は握り潰してサーバ起動を止めない(db quick_check 失敗のみ起動停止)。
try {
  const r = reconcileOnBoot();
  setReconcile({ ranAt: Date.now(), recovered: r.recovered, failedOver: r.failedOver });
  // running のまま中断した decompose を failed に倒す (late 回収不可なので即決着)。
  recoverStuckDecomposes();
} catch (e) {
  console.error("[winnow] reconcile failed:", e);
}
try {
  // tmux -V / claude --version の軽い1回チェックのみ。AI セッションは起動しない。
  const pf = await preflightCheck();
  setPreflight(pf);
} catch (e) {
  console.error("[winnow] preflight failed:", e);
}

const app = Fastify({ logger: { level: "warn" } });

// zod の検証エラー (範囲外キー/型不一致) は 500 でなく 400 で返す (入力不正はクライアント起因)。
// patchSchema 等の .strict() に弾かれた範囲外キーがここで 400 になる。それ以外は既定処理。
app.setErrorHandler((err, _req, reply) => {
  const e = err as { name?: string; statusCode?: number; issues?: unknown };
  if (e.name === "ZodError" || Array.isArray(e.issues)) {
    reply.code(400).send({ error: "invalid request", issues: e.issues });
    return;
  }
  reply.send(err);
});

await app.register(fastifyWebsocket);
// 全ルート登録前に Origin/Host 許可リスト + ローカルシークレットの onRequest フックを張る
// (DNS rebinding / 他オリジン誘導の防御。認証ではなく同一オリジン保証)。/healthz・/ws・
// 静的配信は対象外。dev (Vite:5174) は security.ts 側で許容+シークレット免除される。
registerSecurityHook(app);
await registerRoutes(app);
// Claude 等の MCP クライアントが作業中に直接アイテムを捕獲できる口 (§8 「MCPで寄生」)。
await registerMcp(app);

// 機械向け最小ヘルスチェック (人間向けUIなし)。ready/busy/直近の reconcile failed数。
// Batch5 は security フック対象外パスとして扱う(秘密不要で叩ける)。
app.get("/healthz", async () => {
  const rt = getRuntimeState();
  const { running } = inFlightCount();
  return {
    ready: true,
    busy: running > 0,
    recentFailedOver: rt.reconcile.failedOver,
    preflightOk: rt.preflight.tmuxOk && rt.preflight.claudeOk,
    // 自己更新後の外形確認用 (再起動を跨いで新版が上がったかを機械的に見られる)。
    version: CURRENT_VERSION,
  };
});

// Live terminal theater (§4 "ワンクリックで端末を開いて結果も出し切る").
// Streams `tmux capture-pane` for a session over WebSocket.
app.get("/ws/terminal", { websocket: true }, (socket, req) => {
  // (a) Origin/Host 検証: ブラウザ経由の他オリジン誘導を弾く(WS は onRequest フック対象外なのでここで)。
  if (!originAllowed(req)) {
    socket.close();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const session = url.searchParams.get("session");
  if (!session) {
    socket.close();
    return;
  }
  // (b) session 許可リスト照合: listSessions の既知 window 集合にあるものだけ capture する
  //     (任意 tmux ターゲットの capture 注入を塞ぐ。端末描画は解析しない=read-only のまま)。
  const known = new Set(getDriver().listSessions().map((s) => s.name));
  if (!known.has(session)) {
    socket.close();
    return;
  }
  let alive = true;
  const tick = async () => {
    if (!alive) return;
    try {
      const text = await getDriver().capture(session);
      if (socket.readyState === socket.OPEN) socket.send(text);
    } catch (e) {
      // 握り潰さずログだけは残す (背骨: エラーを黙って捨てない)。
      app.log.warn({ err: e }, "terminal capture tick failed");
    }
    if (alive) setTimeout(tick, 1000);
  };
  tick();
  socket.on("close", () => {
    alive = false;
  });
});

// Serve the built frontend in production.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  // index 配信は自前(シークレット注入)、static は CSS/JS 等のアセット配信に限定。
  await app.register(fastifyStatic, { root: webDist, index: false });

  // index.html を読み、</head> 直前にローカルシークレットを注入して返す。
  // 同一オリジンに限り window.__WINNOW_SECRET__ に乗る=他オリジンの fetch はシークレットを読めない。
  // (これは認証ではなく同一オリジン保証。ログイン UI は無い。)
  const sendIndexWithSecret = (reply: import("fastify").FastifyReply): void => {
    const html = fs.readFileSync(path.join(webDist, "index.html"), "utf8");
    const inject = `<script>window.__WINNOW_SECRET__=${JSON.stringify(LOCAL_SECRET)}</script>`;
    const out = html.includes("</head>")
      ? html.replace("</head>", `${inject}</head>`)
      : inject + html;
    reply.type("text/html").send(out);
  };

  app.get("/", async (_req, reply) => sendIndexWithSecret(reply));
  app.setNotFoundHandler((req, reply) => {
    if (
      req.url.startsWith("/api") ||
      req.url.startsWith("/ws") ||
      req.url.startsWith("/mcp")
    ) {
      reply.code(404).send({ error: "not found" });
    } else {
      // SPA フォールバック: 未知パスは index.html(シークレット注入版)を返す。
      sendIndexWithSecret(reply);
    }
  });
}

// リモート公開の安全ゲート (DECISIONS「リモートアクセス」節):
// dev (NODE_ENV!==production) は状態変更系のシークレットが免除されるため、公開向け緩め
// (非 loopback バインド / 追加許可ホスト) と併用すると保護層が消える。組合せ自体を起動拒否する。
// 公開構成の判定 (REMOTE_EXPOSED) は security.ts の /mcp loopback 限定と単一真実源。
if (REMOTE_EXPOSED && process.env.NODE_ENV !== "production") {
  console.error(
    "winnow: WINNOW_HOST/WINNOW_ALLOWED_HOSTS を使う公開構成では NODE_ENV=production が必須です " +
      "(dev はローカルシークレット免除のため公開すると変更系が無防備になる)。起動を中止します。",
  );
  process.exit(1);
}
if (!BIND_IS_LOOPBACK) {
  console.warn(
    `winnow: ${SERVER_HOST} にバインドします。winnow 自身は認証も TLS も持たないため、` +
      "必ず前段のリバースプロキシ等で認証・TLS・/mcp 遮断を担保してください (OPERATOR_GUIDE §5)。",
  );
}

await app.listen({ port: SERVER_PORT, host: SERVER_HOST });
console.log(`\n  Winnow server → http://localhost:${SERVER_PORT}`);
console.log(`  (dev frontend: http://localhost:5174)\n`);
