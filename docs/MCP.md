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

**必須ルール（クロスフィールド）：** `title` / `body` のうち最低 1 つが非空文字列であること。両方空だと拒否される。

> **精度のヒント：** `body` は分類器に渡る一次情報。会話ログ・背景・制約をそのまま貼るほど、確信度・ステークス・可逆性の見積もりが正確になる。タイトルだけより、雑でも本文をリッチに入れるほうが良い。

### MCP では渡せない引数

`projectId` と `sprintId` は **MCP の `inputSchema` に含まれない**。MCP 経由では設定できず、黙って無視される（実際には欠落扱い＝`null`）。これらを設定したい場合は後述の REST `POST /api/items` を使う。

---

## loopback 制約

サーバは `host: "127.0.0.1"` にバインドする。バインドホストはハードコードで、環境変数や設定では変更できない。

- **リモートの Claude / 別マシンからは `127.0.0.1` に届かない。** MCP も REST も同一マシンのローカルプロセスからのみ到達可能。
- リモートツールから捕獲したい場合は、**トンネリング＋認証を自前で用意する必要がある**。winnow 自体には認証が一切ない（下記）ため、トンネルの外側で必ず認証をかけること。具体的な公開手順とリスクは [`OPERATOR_GUIDE.md`](./OPERATOR_GUIDE.md) を参照。

### 認証は無い

REST・MCP のどちらにも認証は存在しない（トークン・API キー・セッション・認証フックいずれも無し）。唯一のアクセス制御は loopback バインドのみ。つまり **同一マシン上の任意のローカルプロセス／ユーザーが、無認証で全エンドポイント（MCP 含む）を呼べる**。

---

## REST API の要点

MCP と同じ捕獲は REST でも可能（`POST /api/items`、`captureItem` 経由・同一パス）。MCP と違い `projectId` / `sprintId` も設定できる。主要ルート（`src/server/api/routes.ts`）：

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
| `GET /api/sessions/:name/capture` | ペインテキストの取得。 |
| `GET /api/sessions/:name/attach` | アタッチコマンドの取得。 |
| `POST /api/ai/init` | ドライバを起動しセッション一覧を返す。 |

### 設定・サマリ

| メソッド・パス | 説明 |
|---|---|
| `PATCH /api/settings` | チューニング・起動コマンド設定の更新（[`CONFIG.md`](./CONFIG.md) 参照）。 |
| `GET /api/summary` | 週次サマリ。 |

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

### `patchSchema` が除外するフィールド

`PATCH /api/items/:id` は `.strict()`（未知キーを拒否）。さらに以下のフィールドは**意図的に除外**され、PATCH では変更できない。これらは専用の action / audit / execute / cancel ルート経由でのみ動く（記帳・来歴の整合性のため）：

```
auditSampled, humanOverrode, autoExecuted,
executionStatus, executionResult,
createdAt, updatedAt, id
```

PATCH で許可されるフィールド：`title, body, kind, rung, parentId, orderIndex, status, disposition, confidence, reason, stakes, reversibility, category, process, domain, projectDir, projectId, sprintId, dueDate, priority`。

---

## 関連ドキュメント

- 設定・環境変数・起動コマンドのチューニング → [`CONFIG.md`](./CONFIG.md)
- 公開・トンネリング・運用 → [`OPERATOR_GUIDE.md`](./OPERATOR_GUIDE.md)
- 日常の使い方 → [`USER_GUIDE.md`](./USER_GUIDE.md)
- 用語 → [`GLOSSARY.md`](./GLOSSARY.md)
