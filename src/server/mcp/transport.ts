// MCP Streamable-HTTP エンドポイントを既存 Fastify サーバに生やす。
// stateless 運用: リクエスト毎に server+transport を使い捨て、セッション管理をしない
// (捕獲は本質的にステートレスなので、セッションマップ由来のバグ群をまるごと回避)。
// enableJsonResponse=true で SSE ストリームでなく素の JSON を返す(単純な要求/応答向け)。
//
// Fastify v4 固有の勘所:
//  - transport は Node 生の req/res に書くので request.raw / reply.raw を渡す。
//  - reply.hijack() で Fastify に「応答はこちらが持つ」と伝え二重送信を防ぐ。
//  - body は Fastify が既にパース済みなので 3 引数目に渡す(ストリーム二重読みを防ぐ)。
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildMcpServer } from "./server.js";

export async function registerMcp(app: FastifyInstance): Promise<void> {
  app.post("/mcp", async (request: FastifyRequest, reply: FastifyReply) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    // 応答が閉じたら使い捨てリソースを片付ける。
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack(); // Fastify には応答させない
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // stateless モードでは GET(サーバ→クライアント SSE)/DELETE(セッション終了)は使わない。
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless MCP server)" },
      id: null,
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
