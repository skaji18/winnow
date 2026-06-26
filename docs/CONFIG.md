# 設定リファレンス（CONFIG）

Winnow サーバーが実際に読み取る環境変数、設定（settings）パラメータ、実行ゲート・タイムアウトの各定数を一覧する。値はすべてソースコードで確認したもののみを記載する。

関連: [運用ガイド](./OPERATOR_GUIDE.md) / [MCP・REST API](./MCP.md) / [トラブルシューティング](./TROUBLESHOOTING.md) / [用語集](./GLOSSARY.md)

---

## 1. 環境変数

`src/server` 内で `process.env` から読み取られるのは次の 3 つだけ（`NODE_ENV` は同一オリジン保証層のみが読む。後述）。

| 変数 | 既定値 | 制御内容 | 出典 |
|---|---|---|---|
| `WINNOW_HOME` | `~/.winnow`（`path.join(os.homedir(), ".winnow")`） | 永続・実行時状態すべてのルートディレクトリ | `config.ts:7-8` |
| `WINNOW_PORT` | `8787`（`Number(process.env.WINNOW_PORT ?? 8787)`） | HTTP サーバーの待ち受けポート | `config.ts:21` |
| `NODE_ENV` | （未設定=dev 扱い） | `production` 以外で dev 分岐（Vite origin 許可＋シークレット免除） | `security.ts:16` |

### 上書きできないもの

- **バインドホストは `127.0.0.1` にハードコードされており、設定不可。** `app.listen({ port: SERVER_PORT, host: "127.0.0.1" })`（`index.ts:144`）。ホストを変える環境変数・設定は存在しない。loopback バインドに加え、同一オリジン保証層（Origin/Host 許可リスト＋ローカルシークレット）がアクセス制御を担う（[同一オリジン保証と RCE 面](#5-同一オリジン保証ローカルシークレットと-claude-コマンド許可リスト)を参照）。

### `NODE_ENV`（同一オリジン保証層のみが読む）

- **`NODE_ENV` を読むのは `security.ts` の 1 箇所だけ。** `const IS_DEV = process.env.NODE_ENV !== "production"`（`security.ts:16`）。`production` 以外を dev とみなし、dev では Vite origin（`:5174`）を許可ホスト・ポートに加え、状態変更系のローカルシークレット要求を免除する（[§5](#5-同一オリジン保証ローカルシークレットと-claude-コマンド許可リスト)）。
- ビルド済みフロントエンドを配信するかどうかは `NODE_ENV` ではなく、`web/dist` がディスク上に存在するか（`fs.existsSync(webDist)`, `index.ts:113`）で決まる、というファイル存在ベースの挙動のまま。

---

## 2. `~/.winnow`（WINNOW_HOME）のディスクレイアウト

`PATHS`（`config.ts:10-19`）で定義。ディレクトリは `ensureDirs()`（`config.ts:23-32`）が `fs.mkdirSync(..., { recursive: true })` で作成する。`ensureDirs()` は `db.ts:5`（import 時）と `index.ts:17` の両方から呼ばれる。

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
- **スキーマ版管理（`PRAGMA user_version` が単一の真実源）:** コードが期待する版は定数 `CODE_SCHEMA_VERSION = 1`（`db.ts:16`、`SCHEMA_VERSION` として再公開）。Settings JSON ではなく `user_version` が版数の真実源。
  - 起動時に DB の `user_version` がコード版より新しければ**ダウングレード拒否で起動停止**: `winnow: DB schema v<n> is newer than code v1 (downgrade). Refusing to start.`（`db.ts:45-46`）。
  - 版 0→1 の単一マイグレーションを適用後、`settings` 行をシードする。`pauseAuto` 等の新キーは `settings` テーブルの DDL を変えずに Settings JSON 経由で `DEFAULT_SETTINGS` から補完されるため、`settings` 行のシードは版適用後に行う（`db.ts:372-381`）。
- 設定はテーブル `settings` の単一 JSON 行（id = 1）として保存。存在しなければ `DEFAULT_SETTINGS` で一度だけシードされる（`db.ts:377-381`）。

---

## 3. 設定（settings）パラメータ

既定値は `DEFAULT_SETTINGS`（`domain.ts:253-282`）。`Settings` インターフェースは 16 キーを持つ（`domain.ts:212-251`）。

**PATCH で更新できるのは 8 キーだけ。** `PATCH /api/settings` の Zod スキーマ（`routes.ts:345-356`）は `.strict()`（未知キーは拒否）かつ全フィールド `.optional()`（部分更新可）で、許可するのは下表「PATCH 可」のキーのみ。較正・セキュリティ系の残り 8 キーはスキーマに含まれず、API からは緩められない（許可リストを API から緩める穴を作らない非対称ポリシー。変えたい時はコード／DB 直編集）。

| 設定キー | 既定値 | PATCH 可 | PATCH バリデーション（クランプ） |
|---|---|---|---|
| `auditRate` | `0.15` | ✅ | `z.number().min(0).max(1)` |
| `escalationTightness` | `0.7` | ✅ | `z.number().min(0).max(1)` |
| `maxWorkers` | `2` | ✅ | `z.number().int().min(1).max(8)` |
| `claudeControlCmd` | `"claude --permission-mode auto"` | ✅ | `z.string()`（さらに `claudeAllowedFlags` 許可リスト検証, 後述） |
| `claudeWorkerCmd` | `"claude --permission-mode auto"` | ✅ | `z.string()`（さらに `claudeAllowedFlags` 許可リスト検証, 後述） |
| `useHeadless` | `false` | ✅ | `z.boolean()`（変更すると `resetDriver()` が走る, `routes.ts:369`） |
| `productContext` | `""` | ✅ | `z.string()` |
| `pauseAuto` | `false` | ✅ | `z.boolean()`（自動実行の一時停止スイッチ。後述） |
| `allowExternalSend` | `false` | ✅ | `z.boolean()`（外部送信(push/PR作成)の解禁スイッチ。後述） |
| `learnedAuditFloor` | `0.25` | ❌ | （範囲 0..1） |
| `tipProbationMs` | `604_800_000`（1 週間, ms） | ❌ | — |
| `tipProbationRate` | `0.5` | ❌ | （範囲 0..1） |
| `binCalibrationMinSamples` | `8` | ❌ | （int） |
| `binOverturnGap` | `0.25` | ❌ | （範囲 0..1） |
| `claudeAllowedFlags` | （下記の文字列配列） | ❌ | — |
| `captureInboxHoldThreshold` | `24` | ❌ | （int） |

`claudeAllowedFlags` の既定値（`domain.ts:267-280`）:

```
["--permission-mode", "auto", "acceptEdits", "--dangerously-skip-permissions",
 "-p", "--output-format", "json", "--model",
 "sonnet", "opus", "haiku", "plan", "default"]
```

### 名称に関する注記

- 実際のキーは **`escalationTightness`**。`Settings` インターフェースのコメントが "tightness" と呼んでいるが、`tightness` という別フィールドは存在しない。

### 実行時の使われ方

- `maxWorkers` は実行時に下限 1 で丸められる: `Math.max(1, cfg.maxWorkers)`（`tmux-driver.ts:47`）。
- `auditRate` は `rollAudit()` の基準監査率として使用され、auto 処分時に `Math.random() < rate`（rate の起点が `auditRate`）で監査をサンプリングする（`classifier.ts:42-43`）。learned auto rule カテゴリや tip probation 期間では rate が `learnedAuditFloor` / `tipProbationRate` で引き上げられる（`classifier.ts:33-40`）。
- `escalationTightness` は必要確信度のしきい値を引き上げる: `requiredConf = Math.min(0.98, 0.5 + 0.4 * cfg.escalationTightness + calibBump)` → 範囲 **0.5〜0.98**（`classifier.ts:188-189`）。レンジが従来の 0.5〜0.9 から拡張されたのは、ビン較正の締め下駄 `calibBump`（`calibrateRequiredConf`）を上乗せし、上限を `0.98` で clamp するため。`calibBump` は締め側（正）にだけ効き、緩める方向には決して使わない。
- `useHeadless` がドライバ選択を決める: `true` で `HeadlessDriver`、`false` で `TmuxDriver`。詳細は [MCP・AI レイヤ](./MCP.md) を参照。
- `pauseAuto` は自動実行の一時停止スイッチ（`true` で自動経路＝キュー掃き出し・classify 末尾の即時着火・在庫再適用・capture sweep を抑止）。人間のワンタップ実行（`manual:true`）と `approveExecution` はガードをスキップする（手動アクションを止めない＝非対称）。詳細は [§4](#4-実行ゲートタイムアウト定数)。
- `allowExternalSend` は外部送信（push／PR作成）の解禁スイッチ（既定 `false`）。`false` の間は、人間がワンタップ承認しても worker に外部送信のゴーサイン（`externalApproved`）を渡さない＝従来どおり push/PR は実行されない（worker は外部送信を `needs_human` で拒否し続ける）。`true` にすると `approveExecution` 経由の承認時のみ「このアイテムに限り push/PR 作成を実行してよい。マージ・本番デプロイ・データ削除はしない」を worker プロンプトへ伝える（`executePrompt` の `externalApproved` 分岐）。緩め方向（外部副作用解禁）なので既定 OFF・明示オプトイン（§3.6-3 緩めは慎重）。winnow 本体は git 操作コードを持たず実行主体は worker セッション。**PR作成までで、マージ＝採用は人間が外で行う**（成果物は `awaiting_handoff`＝引き取り待ちとしてキュー前面に出る）。worker の ambient 権限の技術的制約（credential 分離・per-repo スコープ・protected ブランチ直 push 禁止・CD 連動検出）は別レイヤの課題で本フラグの範囲外。
- 較正系（`learnedAuditFloor` / `tipProbationMs` / `tipProbationRate` / `binCalibrationMinSamples` / `binOverturnGap`）は監査率算定とビン較正で使われる:
  - `learnedAuditFloor`: learned auto rule カテゴリに恒常維持する最低監査率。`rollAudit` が `max(auditRate, learnedAuditFloor)` を採る（`classifier.ts:39`）。
  - `tipProbationMs` / `tipProbationRate`: learned auto rule tip 直後（rule.createdAt から `tipProbationMs` 以内）の probation 期間に監査率を `max(auditRate, tipProbationRate)` に引き上げる（`classifier.ts:36-38`）。
  - `binCalibrationMinSamples` / `binOverturnGap`: confidence ビン較正の発火条件。auto 生提案ビンで `total >= binCalibrationMinSamples` かつ（実 overturn 率 − 申告 overturn 率）`> binOverturnGap` のとき、そのビンの gap を上記 `calibBump` として加算（`calibration.ts:120-138`）。
- `captureInboxHoldThreshold`: 未さばき件数（disposition=null かつ status が inbox/classified）がこの閾値以上だと、capture 時に classify を即発火せず inbox 保留にする過負荷バックプレッシャ（`0` で無効＝現状維持）。保留分は開封時（`/api/state` 取得）の sweep でドレインされる。reject/escalate ではなくバックプレッシャである点に注意（`capture.ts:88-103`、`domain.ts:249-250,281`）。
- `claudeAllowedFlags`: `claudeControlCmd` / `claudeWorkerCmd` を PATCH で書き換える際に許可するトークン集合（[§5](#5-同一オリジン保証ローカルシークレットと-claude-コマンド許可リスト)）。

---

## 4. 実行ゲート＆タイムアウト定数

### 実行ゲート（`executor.ts`）

定数 `REVERSIBLE_THRESHOLD = 0.6`（`executor.ts:19`）。`requestExecution`（`executor.ts:104-188`）は次の順で判定し、いずれかのゲートに引っかかれば自動着火せず `proposed`（人間のワンタップ承認待ち）に倒す:

| 順 | ゲート | 結果 |
|---|---|---|
| 1 | 再発火ガード: `executionStatus` がセット済みで `"none"`/`"failed"` 以外（例外: succeeded かつ instruction 非空の「この方向で直す」再走） | 早期 return（`executor.ts:121-131`） |
| 2 | `pauseAuto` ガード: `!manual && settings.get().pauseAuto` | `"proposed"`、`executionResult` に「自動実行を一時停止中です(承認待ち…)」（`executor.ts:137-142`） |
| 3 | auto 出所検証: `disposition === "auto"` なのに `confidence == null`（分類器を経ていない疑い） | `escalate` に降格（`executor.ts:148-154`） |
| 4 | `reversible = (item.reversibility ?? 0) >= 0.6` / `highStakes = (item.stakes ?? 0) > 0.7` で `!reversible \|\| highStakes` | `"proposed"`（`executor.ts:161-170`） |
| 5 | 未確定ノード配下/上流未完ガード `uncertainNodeOrUpstreamPending(item)`（親未確定 / 親 blocked / 同一親×上流の兄弟が未完） | `"proposed"`（`executor.ts:171-177`） |
| 6 | クロスリポ兄弟ガード `crossRepoSiblingPending(item)` | `"proposed"`（`executor.ts:178-185`） |
| 7 | 可逆・低ステークス・競合なし | `runExecution(itemId, instruction)` で自動発火（`executor.ts:187`） |

- `manual:true`（人間のワンタップ `POST /api/items/:id/execute`）は §2 の `pauseAuto` ガードをスキップする（手動アクションは止めない＝非対称）。
- `approveExecution` は §4〜§6 のゲートをバイパス: `executionStatus === "proposed"` のみ要求し `runExecution` を直接呼ぶ。
- `projectDir` 検証（`validateProjectDir`, `paths.ts`）: 実行直前（`runExecution`）に `projectDir` が不正（escalate）なら実行せず `proposed` に倒し「作業ディレクトリが不正のため実行を保留しました」を記録（`executor.ts:243-247`）。絶対パス必須・realpath 化・機微パス配下拒否は [§5](#5-同一オリジン保証ローカルシークレットと-claude-コマンド許可リスト) を参照。
- 実行失敗時のステータス: `out.status === "failed"` は `status` を `blocked` にせず `in_progress` に保ち、再浮上は `executionStatus === "failed"` で表す（`executor.ts:202-206`）。
- 分類器側ゲート（関連, `classifier.ts:190-194`）: `auto` 判定は `out.confidence < requiredConf` または（`out.stakes > 0.7 && out.reversibility < 0.5`）のとき `escalate` に降格される。

### タイムアウト・MAX 定数

| 定数 / 呼び出し | 値 | 場所 | 意味 |
|---|---|---|---|
| `MAX_CONTEXT_CHARS` | `16000` | `context.ts:15` | コンテキストブロックの本文テキスト切り詰め上限 |
| `ACQUIRE_TIMEOUT_MS` | `120_000`（120s） | `tmux-driver.ts:27` | 既定のセッション取得タイムアウト |
| worker/control ディスパッチ既定 | `req.timeoutMs ?? (req.role === "worker" ? 300_000 : 90_000)` | `tmux-driver.ts:198` | worker 300s / control 90s（呼び出し側が `timeoutMs` を省略した場合） |
| headless ディスパッチ既定 | `req.timeoutMs ?? 300_000` | `headless-driver.ts:41` | headless 実行タイムアウト。`maxBuffer: 64 * 1024 * 1024`（64 MiB） |
| execution ディスパッチ | `timeoutMs: 600_000`（600s / 10 分） | `executor.ts:277` | `runExecution` の worker ディスパッチ |
| classify ディスパッチ | `timeoutMs: 90_000` | `classifier.ts:123` | — |
| decompose ディスパッチ | `timeoutMs: 120_000` | `decomposer.ts:53` | — |
| promote ディスパッチ | `timeoutMs: 90_000` | `promotion.ts:36` | — |

> 注: `runExecution` は `timeoutMs: 600_000` を渡すため、その経路では tmux-driver の worker 既定 300_000 を上書きする。

---

## 5. 同一オリジン保証（ローカルシークレット）と claude コマンド許可リスト

- **REST にも MCP にも認証は作らない（ユーザ識別子を持たない）。** トークン・API キー・セッションチェックは存在しない。代わりに `src/server/security.ts` の**同一オリジン保証層**が、loopback バインドに加えて次を `/api`・`/mcp` 全体に `onRequest` フック（`registerSecurityHook`, `index.ts:53`）で掛ける。
  - **(a) Origin/Host 許可リスト**（DNS rebinding / 他オリジン誘導の遮断）。許可ホストは `127.0.0.1` / `localhost` / `[::1]` / `::1`（`security.ts:19`）。許可ポートは本サーバの `SERVER_PORT`（空ポート=不問）、dev（`NODE_ENV !== "production"`）では Vite の `5174` も追加（`security.ts:21-22`）。**Host ヘッダ欠落は deny に倒す。** 不許可なら `403 {error:"origin not allowed"}`（`security.ts:115-118`）。
  - **(b) ローカルシークレット**: サーバ起動毎に `randomBytes(24).toString("hex")` で生成（`LOCAL_SECRET`, `security.ts:13`）し `index.html` の `window.__WINNOW_SECRET__` に注入。ブラウザは `X-Winnow-Secret` ヘッダで送る。**状態変更系（`/api` の非 GET）はこのシークレットを要求**し、欠落・不一致なら `403 {error:"missing local secret"}`（`security.ts:120-123`）。dev（`IS_DEV`）ではシークレットを免除（`security.ts:79`）。`/mcp` はローカル claude の正規経路なのでシークレット免除（Origin/Host 検証のみ）。`/healthz`・`/ws`・静的アセットは対象外（`security.ts:113`）。
- **claude 起動コマンドの RCE 面は許可リストで封鎖。** `PATCH /api/settings` で `claudeControlCmd` / `claudeWorkerCmd` を更新する際、`validateClaudeCmd`（`security.ts:88-97`）が cmd を空白分割し、先頭トークン=`claude` 固定 + 以降の各トークンが `settings.claudeAllowedFlags` 集合に含まれることを要求する。範囲外トークンを含む更新は `400 {error:"disallowed command tokens in <key>"}`（`routes.ts:359-367`）。
- **`claudeAllowedFlags` は PATCH の対象に含めない**（許可リストを API から緩める穴を作らない非対称ポリシー。緩めたい時はコード／DB 直編集）。既定値は [§3](#3-設定settingsパラメータ) を参照。
- 詳細は [トラブルシューティング](./TROUBLESHOOTING.md) と [設計判断](./DECISIONS.md) を参照。
