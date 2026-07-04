// 同一オリジン保証 (REQUIREMENTS §1.3 単一ユーザ前提 / DECISIONS 「認証は作らない」).
// localhost 単一ユーザ前提を「同一オリジン保証」として確実に成立させるための最小防御:
//  (a) Origin/Host 許可リスト = DNS rebinding / 他オリジン誘導 (ブラウザ経由) を弾く。
//  (b) 状態変更系に起動時生成のローカルシークレットを要求 = index.html へ自動配布され、
//      同一オリジンの window からしか読めない。これは認証ではない(ユーザ識別子を持たない)。
// 注: dev frontend (Vite :5174) を壊さないため NODE_ENV 非 production では Vite origin を許容し
// 状態変更系のシークレットを免除する (security.ts に dev 分岐を閉じ込める)。
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EXTRA_ALLOWED_HOSTS, EXTRA_ALLOWED_PORTS, SERVER_HOST, SERVER_PORT } from "./config.js";

/** 起動時に1回だけ生成するエフェメラルなローカルシークレット (プロセス内メモリのみ・DBに置かない)。 */
export const LOCAL_SECRET = randomBytes(24).toString("hex");

// プロセス毎の起動識別子 (非秘密)。LOCAL_SECRET と同じ寿命を持ち、web は /api/state の
// bootId 変化=再起動 (シークレット失効) を検知して自動再読込する。自己更新の適用後に限らず、
// クラッシュ再起動・手動再起動でも同じ経路で古いタブが回復する。
export const BOOT_ID = randomBytes(8).toString("hex");

/** 本番(webDist 配信)以外は dev とみなし、Vite origin 許容＋シークレット免除。 */
const IS_DEV = process.env.NODE_ENV !== "production";

/** DNS rebinding 対策: 許可するホスト名集合。dev は Vite (:5174) も含める。 */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** 許可するポート (空=ポート不問)。本サーバと dev Vite。 */
const ALLOWED_PORTS = new Set<string>([String(SERVER_PORT), ""]);
if (IS_DEV) ALLOWED_PORTS.add("5174");
// リバースプロキシ公開 (DECISIONS「リモートアクセス」節): 追加許可は起動時 env のみ。
// URL parse は hostname を小文字化して返すため、比較は小文字で揃える(config.ts 側で正規化済み)。
for (const h of EXTRA_ALLOWED_HOSTS) ALLOWED_HOSTS.add(h);
for (const p of EXTRA_ALLOWED_PORTS) ALLOWED_PORTS.add(p);

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** "host:port" / URL から hostname を取り出す。失敗時は raw を返す(後段で弾かれる)。 */
function hostnameOf(raw: string): { host: string; port: string } {
  // Origin/Referer は scheme 付き、Host は scheme 無し。両対応で URL parse する。
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return { host: u.hostname, port: u.port };
  } catch {
    return { host: raw, port: "" };
  }
}

function hostPortAllowed(raw: string): boolean {
  const { host, port } = hostnameOf(raw);
  if (!ALLOWED_HOSTS.has(host)) return false;
  // ポートが付いていれば許可集合に含まれること(空=不問)。
  if (port && !ALLOWED_PORTS.has(port)) return false;
  return true;
}

/**
 * Origin/Host 検証。
 *  (a) Host ヘッダのホスト名が許可集合か (攻撃者ドメインで来た Host を弾く=DNS rebinding)。
 *  (b) Origin/Referer があればそのホスト名も許可集合か (ブラウザ経由の他オリジン誘導を弾く)。
 * Origin 無し (同一オリジン GET / curl / MCP クライアント) は許容。
 */
export function originAllowed(req: FastifyRequest): boolean {
  // Host 必須: 欠落を deny に倒す(localhost 単一ユーザ前提なので支障なし)。
  // Host を省ける細工クライアントに Origin/Host ゲートが効かない穴を塞ぐ。dev(:5174)許可は維持。
  const host = firstHeader(req.headers.host);
  if (!host || !hostPortAllowed(host)) return false;

  const origin = firstHeader(req.headers.origin);
  if (origin && origin !== "null" && !hostPortAllowed(origin)) return false;

  // Origin が無いリクエストでも Referer があれば検証する(ブラウザのナビゲーション fetch)。
  if (!origin) {
    const referer = firstHeader(req.headers.referer);
    if (referer && !hostPortAllowed(referer)) return false;
  }
  return true;
}

/** GET/HEAD/OPTIONS 以外 = 状態変更系。 */
export function isMutation(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/** 状態変更系に要求するローカルシークレットの照合。 */
export function checkSecret(req: FastifyRequest): boolean {
  if (IS_DEV) return true; // dev は同一オリジン保証(Origin/Host)のみで免除。
  const got = firstHeader(req.headers["x-winnow-secret"]);
  return typeof got === "string" && got === LOCAL_SECRET;
}

/**
 * claudeControlCmd/WorkerCmd の許可リスト検証。先頭トークンが claude 固定 + 以降の
 * 各トークンが allowedFlags 集合に含まれること。RCE 面(任意コマンド注入)を閉じる。
 */
export function validateClaudeCmd(cmd: string, allowedFlags: string[]): boolean {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens[0] !== "claude") return false;
  const allowed = new Set(allowedFlags);
  for (let i = 1; i < tokens.length; i++) {
    if (!allowed.has(tokens[i]!)) return false;
  }
  return true;
}

/**
 * 全 /api・/mcp に Origin/Host 許可リスト検証の onRequest フックを1本張る。
 * registerRoutes より前に呼ぶこと (全ルート登録前にフックを張る)。
 *  - /api/* と /mcp は Origin/Host 検証。false なら 403。
 *  - 状態変更系(/api の非GET)はローカルシークレットを要求。/api/state・/api/export は GET なので不要。
 *  - /mcp はローカル claude(同一マシン・同一オリジンでシークレットを持てない)からの正規経路なので
 *    Origin/Host 検証のみ課しシークレットは免除する(Host=127.0.0.1/localhost 検証で DNS rebinding は防げる)。
 *    ただしリモート公開構成(REMOTE_EXPOSED=非 loopback バインド または WINNOW_ALLOWED_HOSTS
 *    設定時)では、シークレット免除の根拠(同一マシン前提)が崩れるため /mcp は loopback Host
 *    からのみ許可する(プロキシの /mcp 遮断ミスでも外から書き込めない多層防御。ローカル claude は
 *    直結なので影響なし)。注: この判定は Host ヘッダに依存するため、リバースプロキシは
 *    クライアントの Host を透過すること(nginx は proxy_set_header Host $host が必須。
 *    書き換え構成では外部リクエストの Host が loopback になり、この層は素通りする)。
 *  - /healthz・/ws・静的アセットは対象外。
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** バインドが loopback か。起動時の警告/拒否ゲート(index.ts)と共有する単一真実源。 */
export const BIND_IS_LOOPBACK = LOOPBACK_HOSTS.has(SERVER_HOST);
/** リモート公開構成 (非 loopback バインド または 追加許可ホストあり)。 */
export const REMOTE_EXPOSED = !BIND_IS_LOOPBACK || EXTRA_ALLOWED_HOSTS.length > 0;

export function registerSecurityHook(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0] ?? req.url;
    const isApi = url.startsWith("/api");
    const isMcp = url === "/mcp" || url.startsWith("/mcp/");
    if (!isApi && !isMcp) return; // /healthz・/ws・静的配信は対象外。

    if (!originAllowed(req)) {
      reply.code(403).send({ error: "origin not allowed" });
      return reply;
    }
    if (isMcp && REMOTE_EXPOSED) {
      // Host ヘッダ(プロキシ遮断ミス対策。Host 透過構成が前提) と 接続元アドレス
      // (直バインド時の Host 偽装対策。非ブラウザクライアントは Host を自由に詐称できる) の両方で判定。
      const { host } = hostnameOf(firstHeader(req.headers.host) ?? "");
      const peer = req.socket.remoteAddress ?? "";
      const peerLoopback =
        peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      if (!LOOPBACK_HOSTS.has(host) || !peerLoopback) {
        reply.code(403).send({ error: "mcp is loopback-only" });
        return reply;
      }
    }
    // /mcp はローカル claude の正規経路なのでシークレット免除 (Origin/Host 検証のみ)。
    if (isApi && isMutation(req.method) && !checkSecret(req)) {
      reply.code(403).send({ error: "missing local secret" });
      return reply;
    }
  });
}
