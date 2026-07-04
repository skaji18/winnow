# MCP / REST 統合リファレンス

外部ツール（別の Claude セッション、エディタ、スクリプト等）から winnow にタスクを捕獲するための連携リファレンス。日常的な使い方は [`USER_GUIDE.md`](./USER_GUIDE.md) を参照。運用・公開時の制約は [`OPERATOR_GUIDE.md`](./OPERATOR_GUIDE.md) を参照。

---

## 設計思想：MCP は「口」であって「目」でも「手」でもない

winnow の MCP サーバが公開するツールは **`winnow_capture` ただ1個**だけ。これは意図的な設計。

- **口（capture）はある** — どこからでもタスクを放り込める。
- **目（キュー読取）はない** — MCP からキューやアイテム一覧を閲覧する手段は提供しない。
- **手（書戻し）はない** — MCP から処分・分類・実行などの決定を書き戻す手段は提供しない。

`buildMcpServer()` は `winnow_capture` 1個のみを `registerTool` する。リソースもプロンプトも他のツールも登録しない。判断のさばきは winnow の UI（[`USER_GUIDE.md`](./USER_GUIDE.md)）に閉じる、という方針を MCP の表面で強制している。

### エンドポイントとトランスポート

| 項目 | 値 |
|---|---|
| パス | `POST /mcp` |
| トランスポート | MCP Streamable-HTTP（`StreamableHTTPServerTransport`） |
| セッション | ステートレス（`sessionIdGenerator: undefined`） |
| レスポンス形式 | プレーン JSON（`enableJsonResponse: true`、SSE ではない） |
| ライフサイクル | リクエストごとに `McpServer` + transport を新規生成し、接続クローズで破棄 |

**`POST` のみが機能する。** `GET /mcp` と `DELETE /mcp` は HTTP 405 を返す：

```json
{
  "jsonrpc": "2.0",
  "error": { "code": -32000, "message": "Method not allowed (stateless MCP server)" },
  "id": null
}
```

---

## 登録

ローカルで winnow サーバが起動している前提（既定 `http://127.0.0.1:8787`）で、Claude Code CLI に HTTP トランスポートの MCP サーバとして登録する：

```sh
claude mcp add --transport http winnow http://127.0.0.1:8787/mcp --scope user
```

`--scope user` でユーザー全体のスコープに登録すると、どのプロジェクトからでも `winnow_capture` を呼べる。ポートを変更している場合は URL を読み替えること（[`CONFIG.md`](./CONFIG.md) の `WINNOW_PORT` 参照）。

---

## `winnow_capture` 引数

すべての引数は `inputSchema` 上は**任意**。ただしハンドラ側で「`title` か `body` の少なくとも一方が非空（trim 後）」が必須として検証される。

| 引数 | 型 | 必須 | 既定 | 説明 |
|---|---|---|---|---|
| `title` | string | 条件付き | 省略時は `body` の先頭行から導出 | タイトル。 |
| `body` | string | 条件付き | `""` | **最重要**。本文・会話・メモ。リッチなほど分類精度が上がる。 |
| `kind` | enum `node` \| `leaf` | 任意 | `"node"` | ヒントのみ。親（分解可能）か実行可能リーフか。 |
| `domain` | enum `software` \| `general` | 任意 | `"general"` | 領域。 |
| `projectDir` | string | 任意 | `null` | 作業ディレクトリ（絶対パス）。 |
| `priority` | enum `low` \| `normal` \| `high` \| `urgent` | 任意 | `"normal"` | 優先度。 |
| `dueDate` | number（epoch ms） | 任意 | `null` | 期日。 |
| `parentId` | string | 任意 | `null` | 親アイテム ID。 |
| `classify` | boolean | 任意 | `true` | `false` を渡さない限り、捕獲後すぐに分類が走る。 |
| `externalKey` | string | 任意 | `null` | 外部ソース由来の冪等キー。重複取り込み防止用（下記）。 |
| `sourceUrl` | string（URL） | 任意 | `null` | 原典（課題 / PR / ドキュメント等）へ戻る URL。read-only の痕跡として保存するだけで、winnow は外部送出しない。 |

**必須ルール（クロスフィールド）：** `title` / `body` のうち最低 1 つが非空文字列であること。両方空だと拒否される。

### `externalKey` による冪等な再取り込み

`externalKey` を渡すと、同じキーでの再 `capture` は**重複アイテムを作らない**。既存アイテムがあれば：

- `body` が来ていれば、既存アイテムの本文末尾に `\n\n---\n` 区切りで追記して既存アイテムを返す。
- `body` が無ければ既存アイテムをそのまま返す（no-op 同然）。

いずれの場合も**再分類は発火しない**。取り込み cron / バッチ投入を繰り返しても分類器を溢れさせないための設計。

> **精度のヒント：** `body` は分類器に渡る一次情報。会話ログ・背景・制約をそのまま貼るほど、確信度・ステークス・可逆性の見積もりが正確になる。タイトルだけより、雑でも本文をリッチに入れるほうが良い。

### MCP では渡せない引数

`projectId` と `sprintId` は **MCP の `inputSchema` に含まれない**。MCP 経由では設定できず、黙って無視される（実際には欠落扱い＝`null`）。これらを設定したい場合は後述の REST `POST /api/items` を使う。

---

## loopback 制約

サーバは `host: "127.0.0.1"` にバインドする。バインドホストはハードコードで、環境変数や設定では変更できない。

- **リモートの Claude / 別マシンからは `127.0.0.1` に届かない。** MCP も REST も同一マシンのローカルプロセスからのみ到達可能。
- リモートツールから捕獲したい場合は、**トンネリング＋認証を自前で用意する必要がある**。winnow 自体には認証が一切ない（下記）ため、トンネルの外側で必ず認証をかけること。具体的な公開手順とリスクは [`OPERATOR_GUIDE.md`](./OPERATOR_GUIDE.md) を参照。

### 認証は無い（が、同一オリジン保証はある）

REST・MCP のどちらにも**認証は存在しない**（トークン・API キー・セッション・ユーザー識別子いずれも無し。設計判断は [`DECISIONS.md`](./DECISIONS.md) 「認証は作らない」）。同一マシン上のローカルプロセスが全エンドポイントに到達できる点は loopback バインドのままで変わらない。

ただし `src/server/security.ts` が `/api`・`/mcp` 全体に **同一オリジン保証**の `onRequest` フックを 1 本張る。これは認証ではなく、ブラウザ経由の他オリジン誘導 / DNS rebinding を弾くための層：

- **Origin / Host 許可リスト検証** — Host のホスト名が `127.0.0.1` / `localhost` / `::1` 集合に無ければ 403 `{error:"origin not allowed"}`。Origin / Referer があればそのホスト名も同様に検証。これは `/api`・`/mcp` の両方に課される。
- **ローカルシークレット** — 起動時に `randomBytes(24)` で生成したシークレットを `index.html` の `window.__WINNOW_SECRET__` に注入し、ブラウザは `X-Winnow-Secret` ヘッダで送る。`/api` の**状態変更系（非 GET）**のみがこれを要求し、欠落すると 403 `{error:"missing local secret"}`。`GET /api/state` などの読取り系は不要。

**`/mcp` はシークレットを免除される。** ローカルの `claude`（同一マシンの正規経路で、同一オリジンのシークレットを持てない）から到達するため、Host = `127.0.0.1` / `localhost` 検証で DNS rebinding を防げば十分という判断。`/mcp` には Origin/Host 検証のみが課される。

> dev フロントエンド（Vite :5174、`NODE_ENV` 非 production）では Vite origin を許容しシークレットも免除される。

---

## REST API の要点

MCP と同じ捕獲は REST でも可能（`POST /api/items`、`captureItem` 経由・同一パス）。MCP と違い `projectId` / `sprintId` も設定できる。`externalKey` / `sourceUrl` は MCP・REST のどちらでも渡せる。主要ルート（`src/server/api/routes.ts`）：

### 状態スナップショット

| メソッド・パス | 説明 |
|---|---|
| `GET /api/state` | UI 全体を駆動する一括スナップショット（items / queue / settings / sessions / summary / rules / recentJobs / projects / sprints）。適格な auto-leaf の自動着火も行う。 |

### アイテム CRUD

| メソッド・パス | 説明 |
|---|---|
| `POST /api/items` | 捕獲（MCP と同一の `captureItem`）。 |
| `PATCH /api/items/:id` | 汎用更新（`patchSchema`、`.strict()`）。 |
| `DELETE /api/items/:id` | 削除。 |
| `GET /api/items/:id/labels` | アイテムのラベル取得。 |
| `POST /api/items/:id/to-project` | アイテムと部分木を新規案件へ昇格し、適格ノードを再分類。 |

### AI 操作・処分

| メソッド・パス | 説明 |
|---|---|
| `POST /api/items/:id/classify` | 分類器を実行。 |
| `POST /api/items/:id/decompose` | 分解オプションを提案。 |
| `POST /api/items/:id/decompose/apply` | 選んだ分解オプションを適用。 |
| `POST /api/items/:id/promote` | 昇格ジャッジ。 |
| `POST /api/items/:id/execute` | バックグラウンド実行。 |
| `POST /api/items/:id/approve` | バックグラウンド承認。 |
| `POST /api/items/:id/cancel` | 実行キャンセル。 |
| `POST /api/items/:id/action` | 処分アクション：`do` \| `demote` \| `reclassify` \| `mute_category` \| `reject`。 |
| `POST /api/items/:id/audit` | 監査確認 `{ ok: boolean }`。 |

### セッション（端末の劇場）

| メソッド・パス | 説明 |
|---|---|
| `GET /api/sessions` | セッション一覧。 |
| `GET /api/sessions/:name/capture` | ペインテキストの取得。**既知 session のみ**（`listSessions` の集合）。未知なら 404 `{error:"unknown session"}`。 |
| `GET /api/sessions/:name/attach` | アタッチコマンドの取得。同上の既知 session 照合（未知は 404）。 |
| `POST /api/ai/init` | ドライバを起動しセッション一覧を返す。 |

### 設定・サマリ

| メソッド・パス | 説明 |
|---|---|
| `PATCH /api/settings` | チューニング・起動コマンド設定の更新（[`CONFIG.md`](./CONFIG.md) 参照）。 |
| `GET /api/summary` | 週次サマリ。 |
| `GET /api/export` | 全テーブルを版数付き JSON で書き出す（read-only。秘密は伏字化され、winnow は外部送出しない）。 |
| `POST /api/import` | 版数付き JSON の復元。**空 DB 限定**（items / projects 件数 0）。版数不一致または非空 DB は 409。 |

### 自己更新（`updater.ts`）

| メソッド・パス | 説明 |
|---|---|
| `POST /api/update/check` | GitHub Releases の最新版を手動チェック（スロットル無視）。取得元リポジトリはコード内定数で固定。 |
| `POST /api/update/apply` | 更新の適用を点火（即返し `{started, reason?}`）。進行は `/api/state` の `update.apply`。完了するとサーバは非0 exit し supervisor が再起動する。詳細は [`OPERATOR_GUIDE.md`](./OPERATOR_GUIDE.md) §7。 |

### 案件 / スプリント / ルール

| メソッド・パス | 説明 |
|---|---|
| `POST /api/projects` ・ `PATCH /api/projects/:id` ・ `DELETE /api/projects/:id` | 案件の作成・更新（`.strict()`）・削除。 |
| `POST /api/sprints` ・ `PATCH /api/sprints/:id` ・ `DELETE /api/sprints/:id` | スプリントの作成・更新（`.strict()`）・削除。 |
| `GET /api/rules` ・ `POST /api/rules/:id/deactivate` | ルール一覧・無効化。 |

### その他（`index.ts` で登録）

| パス | 説明 |
|---|---|
| `GET /ws/terminal` | `tmux capture-pane` をストリームする WebSocket。 |
| 静的配信 + SPA フォールバック | `web/dist` が存在する場合のみ。 |

### `patchSchema` が許可 / 除外するフィールド

`PATCH /api/items/:id` は `.strict()`（未知キーは 400）。**人間が手で編集してよいのは編集系フィールドのみ。**

PATCH で許可されるフィールド：`title, body, kind, rung, parentId, orderIndex, status, process, domain, projectDir, projectId, sprintId, dueDate, priority`、および楽観ロック用の `expectedUpdatedAt`。

以下のフィールドは**意図的に除外**され、PATCH では変更できない。専用の action / audit / execute / cancel ルート経由でのみ動く：

- **分類器 / 較正フィールド** — `disposition, confidence, reason, stakes, reversibility, category, rawDisposition, rawConfidence`。背骨「口はバカ・分類器が賢い」の機械的強制（人間が `disposition=auto` を直書きして監査をバイパスし auto-leaf を注入する穴を塞ぐ）。`disposition` の人間変更は `POST /api/items/:id/action`（`reclassify`）に一本化されている（`label_event` を出す唯一の正規路）。
- **監査 / 自動化 / 来歴** — `auditSampled, humanOverrode, autoExecuted, executionStatus, executionResult, createdAt, updatedAt, id`、および execute が書き戻す実行痕跡（`executionSummary, executionOutput, rollbackPlan, declaredReversible, artifacts` 等）。

#### 楽観ロック（409 stale）

`expectedUpdatedAt` を渡すと、その値が現在の `updatedAt` と一致しない場合に 409 `{error:"stale", current:<item>}` で弾く（全列上書きによる黙った巻き戻りの防止）。未指定ならチェックしない（後方互換）。

#### `projectDir` 検証

PATCH の `projectDir` は**絶対パス必須・realpath 化・機微パス拒否**で検証され、不正なら即時 400 `{error:<理由>}`。捕獲（capture / decompose）は不正でも拒否せず無効化 + escalate 注記に倒すが、ここは人間の直接編集なので即座に気づかせる。

---

## 関連ドキュメント

- 設定・環境変数・起動コマンドのチューニング → [`CONFIG.md`](./CONFIG.md)
- 公開・トンネリング・運用 → [`OPERATOR_GUIDE.md`](./OPERATOR_GUIDE.md)
- 日常の使い方 → [`USER_GUIDE.md`](./USER_GUIDE.md)
- 用語 → [`GLOSSARY.md`](./GLOSSARY.md)
