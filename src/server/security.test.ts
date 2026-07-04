// security.ts の同一オリジン保証まわりのテスト (INVARIANTS「リモートアクセスの信頼境界」)。
// 前提: デフォルト構成 (loopback バインド・WINNOW_ALLOWED_HOSTS/PORTS 無し) かつ
// NODE_ENV !== "production" (dev)。module ロード時に env を読むため、env を書き換えて
// 再 import するトリックは使わない (production 側の checkSecret 分岐は本ファイルでは検証不能)。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { SERVER_PORT, EXTRA_ALLOWED_HOSTS } from "./config.js";
import {
  BIND_IS_LOOPBACK,
  LOCAL_SECRET,
  REMOTE_EXPOSED,
  checkSecret,
  isMutation,
  originAllowed,
  validateClaudeCmd,
} from "./security.js";

// --- 前提の固定 (ここが崩れると以降のテストの意味が変わるので先に落とす) ---

test("前提: dev (NODE_ENV !== production) かつデフォルト構成 (loopback・追加許可なし)", () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.equal(process.env.WINNOW_ALLOWED_HOSTS ?? "", "");
  assert.deepEqual(EXTRA_ALLOWED_HOSTS, []);
  // INVARIANTS: 既定は loopback バインド = 公開構成でない。
  assert.equal(BIND_IS_LOOPBACK, true);
  assert.equal(REMOTE_EXPOSED, false);
});

// --- originAllowed: 最小限の FastifyRequest 風モック (実装は headers しか読まない) ---

function reqOf(
  headers: Record<string, string | string[] | undefined>,
): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const SELF_HOST = `127.0.0.1:${SERVER_PORT}`;
const SELF_ORIGIN = `http://${SELF_HOST}`;

test("originAllowed: Host 欠落は deny (Host を省ける細工クライアント対策)", () => {
  assert.equal(originAllowed(reqOf({})), false);
  assert.equal(originAllowed(reqOf({ host: "" })), false);
});

test("originAllowed: loopback Host は許可 (127.0.0.1 / localhost / IPv6)", () => {
  assert.equal(originAllowed(reqOf({ host: SELF_HOST })), true);
  assert.equal(originAllowed(reqOf({ host: `localhost:${SERVER_PORT}` })), true);
  assert.equal(originAllowed(reqOf({ host: `[::1]:${SERVER_PORT}` })), true);
  // ポート無し Host はポート不問 (空="" が許可集合に入っている)。
  assert.equal(originAllowed(reqOf({ host: "localhost" })), true);
});

test("originAllowed: 攻撃者ドメインの Host は deny (DNS rebinding)", () => {
  assert.equal(originAllowed(reqOf({ host: "evil.example.com" })), false);
  assert.equal(originAllowed(reqOf({ host: `evil.example.com:${SERVER_PORT}` })), false);
  // loopback を prefix に含むだけの別ホストも deny。
  assert.equal(originAllowed(reqOf({ host: "127.0.0.1.evil.example.com" })), false);
});

test("originAllowed: 許可ホストでも未許可ポートは deny", () => {
  assert.equal(originAllowed(reqOf({ host: "127.0.0.1:1" })), false);
});

test("originAllowed: dev では Vite (:5174) を許容", () => {
  assert.equal(originAllowed(reqOf({ host: "localhost:5174" })), true);
  assert.equal(
    originAllowed(reqOf({ host: SELF_HOST, origin: "http://localhost:5174" })),
    true,
  );
});

test("originAllowed: 他オリジンの Origin は deny・同一オリジンは許可", () => {
  assert.equal(
    originAllowed(reqOf({ host: SELF_HOST, origin: SELF_ORIGIN })),
    true,
  );
  assert.equal(
    originAllowed(reqOf({ host: SELF_HOST, origin: "http://evil.example.com" })),
    false,
  );
  // https でポートが乗らない Origin はポート不問で判定される。
  assert.equal(
    originAllowed(reqOf({ host: SELF_HOST, origin: "https://localhost" })),
    true,
  );
});

test('originAllowed: Origin "null" と Origin 無しは許容 (curl / MCP クライアント)', () => {
  assert.equal(originAllowed(reqOf({ host: SELF_HOST, origin: "null" })), true);
  assert.equal(originAllowed(reqOf({ host: SELF_HOST })), true);
});

test("originAllowed: Origin 無しでも Referer があれば検証する", () => {
  assert.equal(
    originAllowed(reqOf({ host: SELF_HOST, referer: `${SELF_ORIGIN}/index.html` })),
    true,
  );
  assert.equal(
    originAllowed(reqOf({ host: SELF_HOST, referer: "http://evil.example.com/x" })),
    false,
  );
});

test("originAllowed: 配列ヘッダは先頭要素で判定する", () => {
  assert.equal(originAllowed(reqOf({ host: [SELF_HOST, "evil.example.com"] })), true);
  assert.equal(originAllowed(reqOf({ host: ["evil.example.com", SELF_HOST] })), false);
});

test("originAllowed: URL parse 不能な Origin は deny に倒れる", () => {
  assert.equal(
    originAllowed(reqOf({ host: SELF_HOST, origin: "http://[not-a-url" })),
    false,
  );
});

// --- isMutation: GET/HEAD/OPTIONS 以外 = 状態変更系 ---

test("isMutation: 読み取り系 3 メソッドのみ false (大文字小文字不問)", () => {
  for (const m of ["GET", "HEAD", "OPTIONS", "get", "head", "options"]) {
    assert.equal(isMutation(m), false, m);
  }
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "patch"]) {
    assert.equal(isMutation(m), true, m);
  }
});

// --- validateClaudeCmd: 先頭トークン claude 固定 + 許可フラグのみ (RCE 面を閉じる) ---

const FLAGS = ["--dangerously-skip-permissions", "-p", "--model"];

test("validateClaudeCmd: claude 単体と許可フラグのみの組合せは通る", () => {
  assert.equal(validateClaudeCmd("claude", FLAGS), true);
  assert.equal(validateClaudeCmd("claude -p", FLAGS), true);
  assert.equal(
    validateClaudeCmd("claude --dangerously-skip-permissions -p --model", FLAGS),
    true,
  );
  // 前後空白・連続空白は許容 (split(/\s+/) + filter)。
  assert.equal(validateClaudeCmd("  claude   -p  ", FLAGS), true);
});

test("validateClaudeCmd: 未許可フラグ・許可リスト空は拒否", () => {
  assert.equal(validateClaudeCmd("claude --resume", FLAGS), false);
  assert.equal(validateClaudeCmd("claude -p", []), false);
  // フラグは完全一致 (値付き "--model=x" は別トークン扱いで拒否)。
  assert.equal(validateClaudeCmd("claude --model=opus", FLAGS), false);
});

test("validateClaudeCmd: 別コマンド・空文字は拒否", () => {
  assert.equal(validateClaudeCmd("", FLAGS), false);
  assert.equal(validateClaudeCmd("   ", FLAGS), false);
  assert.equal(validateClaudeCmd("bash -p", FLAGS), false);
  assert.equal(validateClaudeCmd("claudex -p", FLAGS), false);
  assert.equal(validateClaudeCmd("/usr/bin/claude -p", FLAGS), false);
  assert.equal(validateClaudeCmd("Claude -p", FLAGS), false); // 大文字は別物。
});

test("validateClaudeCmd: シェルメタ文字を含む注入は拒否", () => {
  assert.equal(validateClaudeCmd("claude; rm -rf /", FLAGS), false);
  assert.equal(validateClaudeCmd("claude && curl evil", FLAGS), false);
  assert.equal(validateClaudeCmd("claude -p | sh", FLAGS), false);
  assert.equal(validateClaudeCmd("claude $(whoami)", FLAGS), false);
  assert.equal(validateClaudeCmd("claude `id`", FLAGS), false);
  assert.equal(validateClaudeCmd("claude -p > /etc/passwd", FLAGS), false);
});

// --- checkSecret / LOCAL_SECRET ---

test("LOCAL_SECRET: 24 バイト hex のエフェメラルシークレット", () => {
  assert.match(LOCAL_SECRET, /^[0-9a-f]{48}$/);
});

test("checkSecret: dev では免除 (ヘッダ無し/不一致でも true)", () => {
  // production 分岐 (LOCAL_SECRET との完全一致要求) は module ロード時の env 依存のため
  // ここでは検証しない (再 import トリック禁止)。dev 免除の不変条件のみ固定する。
  assert.equal(checkSecret(reqOf({})), true);
  assert.equal(checkSecret(reqOf({ "x-winnow-secret": "wrong" })), true);
  assert.equal(checkSecret(reqOf({ "x-winnow-secret": LOCAL_SECRET })), true);
});
