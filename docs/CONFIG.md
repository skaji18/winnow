# 設定リファレンス（CONFIG）

Winnow サーバーが実際に読み取る環境変数、設定（settings）パラメータ、実行ゲート・タイムアウトの各定数を一覧する。値はすべてソースコードで確認したもののみを記載する。

関連: [運用ガイド](./OPERATOR_GUIDE.md) / [MCP・REST API](./MCP.md) / [トラブルシューティング](./TROUBLESHOOTING.md) / [用語集](./GLOSSARY.md)

---

## 1. 環境変数

`src/server` 内で `process.env` から読み取られるのは次の 2 つだけ。

| 変数 | 既定値 | 制御内容 | 出典 |
|---|---|---|---|
| `WINNOW_HOME` | `~/.winnow`（`path.join(os.homedir(), ".winnow")`） | 永続・実行時状態すべてのルートディレクトリ | `config.ts:7-8` |
| `WINNOW_PORT` | `8787`（`Number(process.env.WINNOW_PORT ?? 8787)`） | HTTP サーバーの待ち受けポート | `config.ts:21` |

### 上書きできないもの

- **バインドホストは `127.0.0.1` にハードコードされており、設定不可。** `app.listen({ port: SERVER_PORT, host: "127.0.0.1" })`（`index.ts:66`）。ホストを変える環境変数・設定は存在しない。loopback バインドが唯一のアクセス制御となる（[認証なしの注意](#5-認証なしと-patch-apisettings-の-rce-面)を参照）。
- **`NODE_ENV` はどこでも読まれない。** `src` 内に `NODE_ENV` 参照は存在しない（コメント 1 件のみ、`index.ts:48`）。本番/開発の分岐は環境変数ではなく、`web/dist` がディスク上に存在するか（`fs.existsSync(webDist)`, `index.ts:51`）でビルド済みフロントエンドを配信するかどうかが決まる、というファイル存在ベースの挙動のみ。

---

## 2. `~/.winnow`（WINNOW_HOME）のディスクレイアウト

`PATHS`（`config.ts:10-19`）で定義。ディレクトリは `ensureDirs()`（`config.ts:23-32`）が `fs.mkdirSync(..., { recursive: true })` で作成する。`ensureDirs()` は `db.ts:5`（import 時）と `index.ts:13` の両方から呼ばれる。

| パス | 種別 | 用途 |
|---|---|---|
| `~/.winnow/` | ディレクトリ（作成） | ホームルート |
| `~/.winnow/winnow.db` | ファイル | SQLite DB ファイル（パスのみ定義。実体は better-sqlite3 が open 時に作成, `db.ts:7`） |
| `~/.winnow/ipc/` | ディレクトリ（作成） | バックエンドと tmux 常駐 claude セッション間の IPC チャネル |
| `~/.winnow/control-cwd/` | ディレクトリ（作成） | control セッションのスクラッチ作業ディレクトリ（推論のみ・プロジェクトなし） |
| `~/.winnow/workspaces/` | ディレクトリ（作成） | worker セッションのタスク作業場所（item がプロジェクトディレクトリを固定しない限り） |

### SQLite（`db.ts`）

- **WAL モード有効:** `db.pragma("journal_mode = WAL")`（`db.ts:8`）。
- `db.pragma("foreign_keys = ON")`（`db.ts:9`）。
- 設定はテーブル `settings` の単一 JSON 行（id CHECK = 1）として保存。存在しなければ `DEFAULT_SETTINGS` で一度だけシードされる（`db.ts:147-154`）。

---

## 3. 設定（settings）パラメータ

既定値は `DEFAULT_SETTINGS`（`domain.ts:207-215`）。最小・最大のクランプは `PATCH /api/settings` の Zod スキーマ（`routes.ts:251-259`）で強制され、ドメイン側の既定値定義には含まれない。PATCH スキーマでは全 7 キーが `.optional()`（部分更新可）。

| 設定キー | 既定値 | PATCH バリデーション（クランプ） |
|---|---|---|
| `auditRate` | `0.15` | `z.number().min(0).max(1)` |
| `escalationTightness` | `0.7` | `z.number().min(0).max(1)` |
| `maxWorkers` | `2` | `z.number().int().min(1).max(8)` |
| `claudeControlCmd` | `"claude --permission-mode acceptEdits"` | `z.string()`（長さ・内容制限なし） |
| `claudeWorkerCmd` | `"claude --permission-mode acceptEdits"` | `z.string()`（長さ・内容制限なし） |
| `useHeadless` | `false` | `z.boolean()`（変更すると `resetDriver()` が走る, `routes.ts:263`） |
| `productContext` | `""` | `z.string()` |

### 名称に関する注記

- 実際のキーは **`escalationTightness`**。`Settings` インターフェースのコメントが "tightness" と呼んでいるが、`tightness` という別フィールドは存在しない。

### 実行時の使われ方

- `maxWorkers` は実行時に下限 1 で丸められる: `Math.max(1, cfg.maxWorkers)`（`tmux-driver.ts:47`）。
- `auditRate` は確率として使用: `disposition === "auto" && Math.random() < settings.get().auditRate` のとき監査をサンプリング（`classifier.ts:17`）。
- `escalationTightness` は必要確信度のしきい値を引き上げる: `requiredConf = 0.5 + 0.4 * cfg.escalationTightness` → 範囲 **0.5〜0.9**（`classifier.ts:100`）。
- `useHeadless` がドライバ選択を決める: `true` で `HeadlessDriver`、`false` で `TmuxDriver`。詳細は [MCP・AI レイヤ](./MCP.md) を参照。

---

## 4. 実行ゲート＆タイムアウト定数

### 実行ゲート（`executor.ts`）

定数 `REVERSIBLE_THRESHOLD = 0.6`（`executor.ts:12`）。`requestExecution`（`executor.ts:64-83`）の判定:

| 条件 | 値 | 結果 |
|---|---|---|
| `reversible = (item.reversibility ?? 0) >= 0.6` | 閾値 0.6 | — |
| `highStakes = (item.stakes ?? 0) > 0.7` | 閾値 0.7 | — |
| `!reversible \|\| highStakes` | — | `executionStatus: "proposed"`（人間のワンタップ承認待ち, `executor.ts:67-73`） |
| クロスリポ兄弟ガード `crossRepoSiblingPending(item)` | — | `"proposed"`（`executor.ts:74-81`） |
| 可逆・低ステークス・競合なし | — | `runExecution(itemId)` で自動発火（`executor.ts:83`） |

- 再発火ガード: `executionStatus` がセット済みで `"none"` でも `"failed"` でもない場合は早期 return（`none`/`failed` のみ進行, `executor.ts:57`）。
- `approveExecution` はゲートをバイパス: `executionStatus === "proposed"` のみ要求し `runExecution` を直接呼ぶ（`executor.ts:155-159`）。
- 分類器側ゲート（関連, `classifier.ts:101-102`）: `auto` 判定は `out.confidence < requiredConf` または（`out.stakes > 0.7 && out.reversibility < 0.5`）のとき `escalate` に降格される。

### タイムアウト・MAX 定数

| 定数 / 呼び出し | 値 | 場所 | 意味 |
|---|---|---|---|
| `MAX_CONTEXT_CHARS` | `16000` | `context.ts:15` | コンテキストブロックの本文テキスト切り詰め上限 |
| `ACQUIRE_TIMEOUT_MS` | `120_000`（120s） | `tmux-driver.ts:27` | 既定のセッション取得タイムアウト |
| worker/control ディスパッチ既定 | `req.timeoutMs ?? (req.role === "worker" ? 300_000 : 90_000)` | `tmux-driver.ts:198` | worker 300s / control 90s（呼び出し側が `timeoutMs` を省略した場合） |
| headless ディスパッチ既定 | `req.timeoutMs ?? 300_000` | `headless-driver.ts:30` | headless 実行タイムアウト。`maxBuffer: 64 * 1024 * 1024`（64 MiB） |
| execution ディスパッチ | `timeoutMs: 600_000`（600s / 10 分） | `executor.ts:112` | `runExecution` の worker ディスパッチ |
| classify ディスパッチ | `timeoutMs: 90_000` | `classifier.ts:69` | — |
| decompose ディスパッチ | `timeoutMs: 120_000` | `decomposer.ts:52` | — |
| promote ディスパッチ | `timeoutMs: 90_000` | `promotion.ts:35` | — |

> 注: `runExecution` は `timeoutMs: 600_000` を渡すため、その経路では tmux-driver の worker 既定 300_000 を上書きする。

---

## 5. 認証なしと `PATCH /api/settings` の RCE 面

- **REST にも MCP にも認証は一切ない。** トークン・API キー・セッションチェック・認証ミドルウェアは存在しない。アクセス制御は loopback バインド（`127.0.0.1`）のみ。
- `PATCH /api/settings` は `claudeControlCmd` / `claudeWorkerCmd` を `z.string()` で受け付けて `settings.update(patch)` で書き込む（認証なし, `routes.ts:260-265`）。これらの文字列は claude セッションの起動コマンドとして使われる（[MCP・AI レイヤ](./MCP.md) 参照）。
- **したがって、ローカルの任意プロセスが認証なしで control/worker の起動コマンドを書き換え可能。** これは実質的にローカルの任意コマンド実行（RCE）面となる。詳細は [トラブルシューティング](./TROUBLESHOOTING.md) と [設計判断](./DECISIONS.md) を参照。
