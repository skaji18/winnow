import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { ensureDirs, SERVER_PORT } from "./config.js";
import "./db.js"; // initialize schema
import { registerRoutes } from "./api/routes.js";
import { registerMcp } from "./mcp/transport.js";
import { getDriver } from "./ai/index.js";

ensureDirs();

const app = Fastify({ logger: { level: "warn" } });

await app.register(fastifyWebsocket);
await registerRoutes(app);
// Claude 等の MCP クライアントが作業中に直接アイテムを捕獲できる口 (§8 「MCPで寄生」)。
await registerMcp(app);

// Live terminal theater (§4 "ワンクリックで端末を開いて結果も出し切る").
// Streams `tmux capture-pane` for a session over WebSocket.
app.get("/ws/terminal", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  const session = url.searchParams.get("session");
  if (!session) {
    socket.close();
    return;
  }
  let alive = true;
  const tick = async () => {
    if (!alive) return;
    try {
      const text = await getDriver().capture(session);
      if (socket.readyState === socket.OPEN) socket.send(text);
    } catch {
      /* ignore transient capture errors */
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
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (
      req.url.startsWith("/api") ||
      req.url.startsWith("/ws") ||
      req.url.startsWith("/mcp")
    ) {
      reply.code(404).send({ error: "not found" });
    } else {
      reply.sendFile("index.html");
    }
  });
}

await app.listen({ port: SERVER_PORT, host: "127.0.0.1" });
console.log(`\n  Winnow server → http://localhost:${SERVER_PORT}`);
console.log(`  (dev frontend: http://localhost:5174)\n`);
