# 運用ガイド（OPERATOR_GUIDE）

Winnow を立てる・運用する・守る・止めるための運用者向け手順書。設定値の詳細は [docs/CONFIG.md](./CONFIG.md)、障害対応は [docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) を参照すること。MCP/REST の連携面は [docs/MCP.md](./MCP.md) にまとめてある。

> 重要な前提: Winnow は **既定で `127.0.0.1` バインド・認証なし**で動く単一ユーザ向けローカルツールである。認証は持たないが、`/api`・`/mcp` には**同一オリジン保証層**（Origin/Host 許可リスト＋起動時生成のローカルシークレット）が掛かっている。loopback の外へ出す（レンサバ/VPS からスマホで使う等）場合は、**必ず認証付きリバースプロキシを前段に置き**、本書「信頼境界」の公開手順に従うこと。

---

## 1. 前提条件

立てる前に以下をすべて満たすこと。

- **Node.js 20+** — `package.json` に `engines` 制約は無いため強制はされない。実行系は ESM（`"type": "module"`）。
- **tmux** — TmuxDriver（既定モード）の必須依存。`tmux -V` が通ること。無い場合 `init()` が例外を投げる（macOS なら `brew install tmux`）。
- **ログイン済みの `claude` CLI** — Winnow は tmux 内に常駐させた `claude` セッションへ仕事を投げる。`claude` がサブスク座席にログイン済みで、コマンド単体で対話起動できる状態にしておくこと。
- **`better-sqlite3` のネイティブビルド** — ネイティブアドオン依存。`npm install` 時にビルドツールチェーン（C/C++ コンパイラ等）が必要。DB は `~/.winnow/winnow.db`（SQLite）。

---

## 2. インストール・ビルド・起動

### 手順

```bash
npm install        # 依存導入（better-sqlite3 のネイティブビルドを含む）
npm run build      # フロントエンド（web/dist）をビルド
npm start          # 本番起動（NODE_ENV=production tsx src/server/index.ts）
```

起動後、ブラウザで `http://127.0.0.1:8787` を開く（ポートは `WINNOW_PORT` で変更可。詳細は [docs/CONFIG.md](./CONFIG.md)）。

開発用に動かす場合は `npm run dev`（server + vite を並行起動）。

### 運用上のはまりどころ（必読）

- **`npm install --production` は `npm start` を壊す。** `start` は `tsx` でサーバを起動するが、`tsx` は **devDependency** に置かれている。本番フラグで devDependency を除外すると `tsx` が入らず起動できない。本番ホストでも通常の `npm install` を使うこと。
- **`npm run build` を忘れると UI が 404 になる。** サーバは `web/dist` がディスク上に存在するときだけ、ビルド済みフロントエンドを静的配信し SPA フォールバックを登録する。この判定は `NODE_ENV` ではなく **`web/dist` の有無**で決まる。ビルドしていないと API は動くが画面が出ない。
- **`NODE_ENV` は配信の有無には影響しない**が、`security.ts` は読んでいる。配信の有無を決めるのは前述の `web/dist` の存在だけだが、`security.ts` は `NODE_ENV` を読み、`!== 'production'` を dev とみなして Vite origin 許容＋状態変更系シークレット免除に分岐する（→「5. 信頼境界」の dev モード）。本番ではシークレットを効かせるため、`npm start` 同様に **`NODE_ENV=production` を設定すること**。設定し忘れると本番ホストでも dev 扱いになり、ローカルシークレットが免除される。

---

## 3. tmux セッションモデル

Winnow は AI 実行を tmux 常駐の `claude` セッションに委ねる。バックエンドは**画面をスクレイプしない** — 機械的な入出力はすべてファイル（`~/.winnow/ipc/` 配下のリクエスト/レスポンス/done ファイル）経由で行う。tmux ペインは人間が「眺める」ためだけに残されている。

### 構成

| 要素 | 値 |
|---|---|
| セッション名 | `winnow`（固定） |
| control ウィンドウ | `control` 1枚（cwd = `~/.winnow/control-cwd`） |
| worker ウィンドウ | `worker-0` 〜 `worker-(N-1)`（cwd = `~/.winnow/workspaces`） |
| worker 数 N | `max(1, maxWorkers)`。`maxWorkers` 既定 2 |
| tmux ターゲット例 | `winnow:control`, `winnow:worker-0` |

### 起動と存続

- 起動時、`winnow` セッションが**既に生きていれば再利用**される（アプリ再起動を跨いで存続。新しい window は作らず、メモリ上のセッション一覧だけ再構築する）。
- 生きたセッションが無ければ、`control` を `claudeControlCmd` で、各 worker を `claudeWorkerCmd` で新規起動する。
- 各 window は起動直後に固定 sleep ではなく**プロンプト到達のハンドシェイク**で待つ（再利用 10 秒・新規起動 30 秒のタイムアウト）。

### 確認・接続・停止

```bash
tmux has-session -t winnow        # セッション存在確認
tmux attach -t winnow             # control 含むセッションに接続
tmux attach -t winnow:worker-0    # 特定 worker のペインを覗く
tmux kill-session -t winnow       # セッションごと停止
```

- アプリの `shutdown()` は **意図的に no-op** で、終了してもセッションは生かしたまま。プロセスを止めても `claude` 常駐は残る。完全に止めるには上記 `tmux kill-session -t winnow` を実行すること。
- `maxWorkers` を増やしてアプリを再起動しても、既存セッションは再利用されるため **window は再構成されない**。worker 数を増やしたいときは一度 `tmux kill-session -t winnow` してから起動し直す。

---

## 4. 許可モードとセキュリティ

### 既定の許可モード

control/worker いずれも既定の起動コマンドは:

```
claude --permission-mode auto
```

`auto`（automode）を使うのは、許可プロンプトなしで無人実行しつつ、claude 側の分類器が各アクションを事前審査して危険操作（`curl|bash`、`main` への force push、`git reset --hard`、機微データ送信、本番デプロイ等）をブロックする**安全網付きの全自動**だから。tmux 常駐セッションがプロンプト待ちで詰まる事故を避けつつ、`--dangerously-skip-permissions`（全バイパス）の危険を負わずに済む。**既定では `--dangerously-skip-permissions` は使われていない。** コードのどこからも自動でこのフラグが付くことはない。

`auto` は Claude Code v2.1.83+ かつ Opus 4.6+ / Sonnet 4.6+ / Opus 4.7-4.8 等が要件（Sonnet 4.5・Haiku は非対応）。要件を満たさない環境では、許可確認を残す `claude --permission-mode acceptEdits`（ファイルI/Oプロトコルは Write ツールしか使わないため概ね無人運用が成立）に変更する。

### 起動コマンドの許可リスト（RCE 面の封鎖）

`claudeControlCmd` / `claudeWorkerCmd` は任意コマンド注入（ローカル RCE）面になりうるため、**許可リストで封鎖されている**（`validateClaudeCmd`）。

- 先頭トークンは **`claude` 固定**、以降の各トークンは `settings.claudeAllowedFlags` 集合に含まれること。
- 既定の `claudeAllowedFlags`: `--permission-mode` / `auto` / `acceptEdits` / `--dangerously-skip-permissions` / `-p` / `--output-format` / `json` / `--model` / `sonnet` / `opus` / `haiku` / `plan` / `default`。
- 範囲外トークンを含む `PATCH /api/settings` は `400 {error:"disallowed command tokens in <key>"}` で拒否される。`POST /api/import` 経路でも同じ検証が掛かり、不正なら `DEFAULT_SETTINGS` へ落とす（許可リストを import で迂回する穴を塞ぐ）。
- `claudeAllowedFlags` 自体は `PATCH /api/settings` の対象に含まれない（許可リストを緩める穴を作らない）。緩めたい場合はコード/DB を直接編集する。

### `--dangerously-skip-permissions` の扱い

このフラグは、セッションが許可プロンプトで詰まったときの**ユーザ手動オーバーライド候補**としてコメント/エラーメッセージ内にのみ登場する。採用する場合の警告:

- これは許可確認を完全にスキップするため、`claude` が **サンドボックスなしで、Winnow を動かしている OS ユーザの権限でシェル実行**することを意味する。実害範囲はそのユーザができることすべて。
- 採用は最後の手段とし、信頼できる隔離環境でのみ行うこと。

### 作業ディレクトリ隔離の実態

worker のプロジェクト隔離は OS レベルで強制されていない点に注意:

- TmuxDriver では、ペインで動いているのは `claude` でありシェルではない。よって `cd` キー入力は効かない。タスクの作業ディレクトリ固定は**プロンプト文言による指示**（「この絶対パスに留まれ・他ディレクトリに触るな」）で行われており、OS による強制ではない。
- 多層防御として実行プロンプト本文にも対象 `projectDir` の絶対パスを注入するが、これも指示に過ぎない。
- 例外として **HeadlessDriver は実 OS の cwd を子プロセスに設定する**（`useHeadless: true` のとき）。tmux モードはプロンプト指示頼み、という違いを把握しておくこと。

### `projectDir` の検証（機微パス拒否）

タスクに紐づく `projectDir` は実行前に `validateProjectDir` で検証される。**絶対パス必須**・realpath 化（best-effort、未存在パスは親まで遡って正規化）の上で、以下の機微パス配下を拒否する。

- `~/.winnow`（DB/IPC/秘密）、`/etc` `/var` `/usr` `/bin` `/sbin` `/boot` `/root`
- `~/.ssh` `~/.aws` `~/.config` `~/.gnupg`、およびホーム直下のドットディレクトリ全般（`~/.foo`）

検証失敗時の扱いは経路で非対称:

- **捕獲**（capture）: 拒否せず `projectDir=null` に倒し、body 末尾へ escalate 注記を付けて後段分類を escalate 寄りにする。
- **分解**（decompose）: 子の `projectDir` は検証せず trim/親継承するだけ（インライン検証も escalate 材料化もしない）。不正は実行直前（`runExecution` の最終ゲート）で捕捉され、実行せず `proposed` に倒し『作業ディレクトリが不正のため実行を保留しました』を記録する。この最終ゲートは捕獲・分解いずれ由来のタスクにも効く。
- **人間の直接編集**（`PATCH /api/items/:id`）: その場で即時 `400 {error:<reason>}` で気づかせる。
- HeadlessDriver も dispatch の `req.cwd` を検証し、不正なら既定にフォールバックして警告ログを出す。

---

## 5. 信頼境界

### 現状

- サーバは **既定で `host: "127.0.0.1"` にバインド**される（`WINNOW_HOST` で変更可だが、後述の通りリバースプロキシ構成では変更不要）。
- **REST API・MCP ともに「認証」は無い**（トークン・APIキー・ログイン UI のいずれも無い）。代わりに `/api`・`/mcp` には**同一オリジン保証層**（`src/server/security.ts`）が `onRequest` フックで掛かる。これは認証ではない（ユーザ識別子を持たない）が、loopback 前提を確実に成立させる最小防御。

### 同一オリジン保証層（security.ts）

`/api/*` と `/mcp` に対し、以下を `onRequest` フックで強制する（`/healthz`・`/ws`・静的アセットは対象外）。

- **(a) Origin/Host 許可リスト検証**: 許可ホストは `127.0.0.1` / `localhost` / `[::1]` / `::1`、許可ポートは本サーバの `SERVER_PORT`（空ポート=不問）。`Host` ヘッダ欠落は deny。不許可なら `403 {error:"origin not allowed"}`。DNS rebinding/他オリジン誘導を弾く。
- **(b) ローカルシークレット**: 状態変更系（`GET`/`HEAD`/`OPTIONS` 以外の `/api`）は `X-Winnow-Secret` ヘッダを要求し、欠落/不一致なら `403 {error:"missing local secret"}`。シークレットはサーバ起動毎に `randomBytes(24)` で1回生成され（プロセス内メモリのみ・DBに置かない）、本番では `index.html` の `</head>` 直前に `window.__WINNOW_SECRET__` として注入される。同一オリジンの window からしか読めない。
- `GET` の `/api/state`・`/api/export` はシークレット不要。
- **`/mcp`** はローカル `claude`（同一マシンの正規経路・シークレットを持てない）なので Origin/Host 検証のみ課し、シークレットは免除する。
- **dev モード**（`NODE_ENV!=='production'` = `web/dist` 非配信）では Vite origin（`:5174`）を許容し、状態変更系のシークレットを免除する。本番ビルドでのみシークレットが効く。
- WebSocket `/ws/terminal` も Origin/Host 検証で守られ（不許可なら close）、capture 対象 session は既知 window 集合に存在するもののみに限定される。

### ローカル RCE 面（封鎖済み）

- `claudeControlCmd` / `claudeWorkerCmd` の書き換えは**許可リストで封鎖されている**（「4. 許可モードとセキュリティ」の「起動コマンドの許可リスト」を参照）。範囲外トークンを含む `PATCH /api/settings` は `400` で拒否され、`POST /api/import` 経路でも同じ検証が掛かる。
- tmux セッションの capture/attach REST（`GET /api/sessions/:name/capture`, `/attach`）は既知 session のみ許可し、未知なら `404 {error:"unknown session"}`。
- それでも、同一オリジン保証を満たすローカルプロセス（同一マシンの正規ブラウザ等）からは広く操作できる前提は変わらない。ローカルに信頼できないプロセス/ユーザが居る環境では引き続き警戒すること。

### loopback の外へ出す場合（レンサバ/VPS からスマホで使う）

Winnow 自身は誰でも全権限で操作できる前提なので、**境界は必ず前段で担保する**。公開が必要なら、**外部に認証付きリバースプロキシ**を立てるか、**Tailscale ACL 等のネットワーク層アクセス制御**で限定すること。プロキシ認証なしで到達可能な構成は、`GET /api/export`（DB 全量ダンプ・シークレット不要）と `GET /`（ローカルシークレット配布）が誰にでも開くことを意味する — **認証の除外パスを作らないこと**（`/ws/` にも必ず掛ける。tmux 画面＝作業内容が read-only で流出する面）。

推奨構成（リバースプロキシ同居）:

1. バインドは既定の `127.0.0.1:8787` のまま（`WINNOW_HOST` は触らない）。
2. 前段に Caddy（自動 HTTPS + `basic_auth`。WebSocket 透過・Host 透過は自動）または nginx（HTTPS + `auth_basic` + **`proxy_set_header Host $host;` を必須で設定** + `/ws/` に `proxy_http_version 1.1` と `Upgrade`/`Connection` ヘッダ）を置き、`127.0.0.1:8787` へ転送する。nginx は既定で Host を転送先（`127.0.0.1:8787`）に書き換えるため、`proxy_set_header Host $host` が無いと手順5の winnow 側 `/mcp` 多層防御が機能しない（外部リクエストの Host が loopback に見えてしまう）。
3. `WINNOW_ALLOWED_HOSTS=<公開ホスト名>` を設定して起動する（例: `WINNOW_ALLOWED_HOSTS=winnow.example.com`）。これで Host/Origin/Referer 検証と WebSocket の Origin 検証が公開ホスト名を通す。HTTPS 標準ポート（443）は Origin にポートが乗らないため `WINNOW_ALLOWED_PORTS` は不要（非標準ポート公開時のみカンマ区切りで追加）。
4. **`NODE_ENV=production` は必須**。公開向け env（`WINNOW_HOST` 非 loopback / `WINNOW_ALLOWED_HOSTS`）が設定されているのに `NODE_ENV` が production でない場合、dev のシークレット免除と衝突するため**サーバは起動を拒否する**（`npm start` は設定済み）。あわせて `npm run build` を忘れると UI が出ない（§2）。
5. **`/mcp` はプロキシで外部公開しない**（nginx: `location /mcp { deny all; }` / Caddy: `respond /mcp* 403`）。公開構成（非 loopback バインド または `WINNOW_ALLOWED_HOSTS` 設定）では winnow 側でも `/mcp` は loopback Host 以外を 403 で弾く（多層防御）。ただしこの層は **プロキシがクライアントの Host を透過していること**（手順2の `proxy_set_header Host $host`）が前提。ローカルの MCP クライアント（claude 等）はプロキシを経由せず `http://localhost:8787/mcp` に直結する。

運用ノート:

- ローカルシークレットは**サーバ起動毎に再生成**される。サーバを再起動すると、スマホ等で開きっぱなしのタブは状態変更系が `403 missing local secret` になる — **ページを再読込すれば回復する**（UI もその旨を案内する）。
- `WINNOW_HOST=0.0.0.0` 等の直バインドは**非推奨**（認証・TLS なしで全データとシークレットが露出する）。設定した場合は起動時に警告が出る。Tailscale 等の閉域網内で完結する場合のみ検討すること。

---

## 6. バックアップ

DB は `~/.winnow/winnow.db`。**SQLite は WAL モードが有効**（`journal_mode = WAL`）。このため:

- **`winnow.db` 単体のコピーは不可。** WAL モードでは未チェックポイントの変更が `winnow.db-wal` に存在しうるため、`.db` だけコピーすると不整合・データ欠落になる。
- 安全なバックアップは次のいずれか:
  1. アプリ/セッションを止めた状態で `winnow.db` と `winnow.db-wal` / `winnow.db-shm` を**まとめてコピー**する。
  2. SQLite のオンラインバックアップ機構（`VACUUM INTO` 等の一貫スナップショット）を使う。

`~/.winnow/` 配下の他ディレクトリ（`ipc/`, `control-cwd/`, `workspaces/`）は実行時スクラッチであり、永続データは `winnow.db` に集約される。

---

## 7. アップグレード方針

### セルフアップデート（UI からの更新）

git clone で配備してあれば（→「2. インストール・ビルド・起動」）、UI からワンタップで最新リリースへ更新できる（`src/server/updater.ts`。設計判断は [DECISIONS.md](./DECISIONS.md)「自己更新」節）。

- **検知**: GitHub Releases の最新版を最大6時間に1回チェックし（`/api/state` ポーリングに相乗り。取得元リポジトリはコード内定数で固定・変更不可。チェック失敗時は15分後に再試行）、新しければ画面トップにバナーが出る。設定タブの「バージョン・更新」から手動チェック（`POST /api/update/check`）もできる。
- **適用**: バナーの「更新して再起動」（`POST /api/update/apply`）。サーバが `git fetch --tags` → 該当タグを checkout → `npm ci --include=dev` → `npm run update:build`（`web/dist-next` にビルドしてから瞬時に入れ替える。配信中の UI を数分壊さない）を実行し、完了すると**非0 exit する**。適用中は新規の自動着火を点火しない。再起動は supervisor に委ねるため、**systemd 等での常駐運用が前提**（`Restart=on-failure` または `always`）。フォアグラウンド起動中に適用するとプロセスは終了するだけなので、手で `npm start` し直すこと。適用後はページが自動で再読込される（プロセス毎の `bootId` の変化で再起動を検知する。再起動でローカルシークレットが変わるため）。
- **ガード**: 実行中ジョブあり / 未コミットの手元変更（dirty tree。未追跡ファイルは対象外）/ 適用進行中 / dev 起動（`NODE_ENV !== production`）/ `npm` がサーバプロセスの PATH から解決できない場合は、適用を開始せず理由を返す。
- **失敗時**: 元の commit へ checkout + `npm ci` + `vite build` のベストエフォート巻き戻しを試み、エラーは `/api/state` の `update.apply.error` とサーバログに残る。手動復旧は [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)「セルフアップデートが失敗する」を参照。
- **更新前のバックアップ**は従来どおり推奨（→「6. バックアップ」。特に DB マイグレーションを含むリリースは、失敗＝起動不能が最悪ケース）。

Linux + systemd での常駐例（ユーザサービス。パスや env は環境に合わせる）:

```ini
# ~/.config/systemd/user/winnow.service
[Unit]
Description=winnow server
After=network-online.target

[Service]
WorkingDirectory=%h/winnow
# 公開構成なら WINNOW_ALLOWED_HOSTS 等をここで (→「5. 信頼境界」)
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now winnow` で起動し、ログアウト後も残すなら `loginctl enable-linger <user>` を設定する。node/npm をバージョンマネージャ経由で入れている場合は `ExecStart` や `Environment=PATH=...` でそのバイナリが解決できるようにすること（`claude` / `tmux` もサーバプロセスの PATH から見える必要がある →「1. 前提条件」）。

### リリースの作り方（開発側）

1. `package.json` の `version` を上げてコミットする。
2. `v<version>` タグを push する（例 `git tag v0.2.0 && git push origin v0.2.0`）。
3. GitHub Actions（`.github/workflows/release.yml`）がビルドゲート（server tsc / web build / smoke）を通してから Release を自動作成する（`--generate-notes`）。タグと `package.json` の version が食い違うと fail する（配備側の semver 比較を壊さないための防波堤）。

### DB スキーマとマイグレーション

- DB スキーマ版は **`PRAGMA user_version` を単一の真実源**として管理される（Settings JSON ではない）。コードが期待する版は定数 `CODE_SCHEMA_VERSION`（現在 `1`）。
- 起動時に DB の `user_version` が `CODE_SCHEMA_VERSION` より小さければ、`MIGRATIONS` の `up` を版数順に適用する。版0→版1 の単一マイグレーションが items に多数の新カラム（`rawDisposition` / `rawConfidence` / `envEscalated` / `executionSummary` / `executionOutput` / `rollbackPlan` / `declaredReversible` / `artifacts` / `sourceUrl` / `externalKey` 等）、jobs に `ipcId`、projects に `context`、category_stats に `confBin`（PK に追加）を加え、label_events.itemId を FK `ON DELETE SET NULL` 化（NOT NULL 解除）、sprints から `projectId` 列を除去する。
- 破壊的 table-rebuild（label_events の FK 化 / sprints の死列除去 / category_stats の PK 再構築）は `foreign_keys=OFF` を要するため、マイグレーションは `db.transaction` を使わず手動 `BEGIN`/`COMMIT` で原子化し、最後に `foreign_key_check` で整合確認する（NG なら `ROLLBACK` して起動停止）。table-rebuild は旧スキーマ検出時のみ一度きり走る。
- **ダウングレードは拒否される（起動停止）。** DB の `user_version` がコードの `CODE_SCHEMA_VERSION` より新しい場合、stderr に `winnow: DB schema v<current> is newer than code v<CODE_SCHEMA_VERSION> (downgrade). Refusing to start.` を出して `throw`（listen しない）。新しい版で作った DB を古いコードで起動した場合の失敗モード。
- 起動時には `PRAGMA quick_check` による整合チェックも走り、NG なら起動停止する（→「8. 監視・ヘルス確認」「9. 起動後検証」も参照）。
- アップグレード前に必ず「6. バックアップ」を実施すること（WAL 同梱でのコピー or オンラインバックアップ）。
- 設定は `settings` テーブルに単一 JSON 行として保持され、初回のみ既定値で seed される。新しい設定キーは Settings JSON 経由で `DEFAULT_SETTINGS` から補完されるため、設定追加では DDL 変更は不要。

---

## 8. 監視・ヘルス確認

- **機械向けヘルスチェック `GET /healthz`** がある（人間向け UI なし、security フック対象外でシークレット不要）。返却は `{ready, busy(実行中>0), recentFailedOver(起動時 reconcile の failedOver 数), preflightOk(tmuxOk && claudeOk), version(現在バージョン)}`。`version` はセルフアップデート後に新版が上がったかの外形確認に使える。

```bash
curl http://127.0.0.1:8787/healthz                # ready/busy/recentFailedOver/preflightOk
curl http://127.0.0.1:8787/api/state              # 全状態スナップショット(preflight 結果含む)
curl http://127.0.0.1:8787/api/sessions           # tmux セッション一覧
curl "http://127.0.0.1:8787/api/sessions/<name>/capture"   # ペインのテキスト取得(既知 session のみ)
```

- `/api/state` には起動時 preflight（`tmuxOk` / `claudeOk` / `checkedAt` / `note`）と reconcile 痕跡が含まれる。これらは非永続のプロセス内メモリ（`runtime-state.ts`）で保持され、起動毎に再算出される（Settings JSON とは分離）。
- `POST /api/ai/init` でドライバを確実に初期化しつつセッション一覧を取得できる（UI の「セッションを起動 / 再確認」ボタン相当）。
- 全 API の一覧は [docs/MCP.md](./MCP.md) を参照。

---

## 9. 起動後検証（遅延初期化に注意）

AI ドライバは**遅延初期化される singleton**である（実セッションの起動は最初の AI 操作で初めて起きる）。ただし起動時に **AI を起動しない軽いチェックが2つ走る**（どちらも db 初期化直後・listen 前に1回、例外は握り潰してサーバ起動を止めない。起動を止めるのは `quick_check` 失敗とダウングレード検出のみ）。

- **preflight**（`preflightCheck`）: `useHeadless=false` のとき `tmux -V` の解決可否と、起動コマンド先頭トークンを `<bin> --version`（timeout 5秒）で叩いて `claude` 解決可否をチェックする。`useHeadless=true` のとき tmux は不要なので skip（`tmuxOk:true` 固定）。結果は `/api/state`・`/healthz` に出るだけで AI セッションは起動しない。`note` は失敗時『tmux 未検出』『claude 未解決』を ` / ` で連結。
- **reconcile**（`reconcileOnBoot`）: 前回プロセスで `running` のまま中断した execute ジョブを、`jobs.ipcId` 経由で done sentinel（`~/.winnow/ipc` の `${ipcId}.done` と `${ipcId}.res.json`）を探して決定論で決着させる。sentinel が揃えば取り込み（`recovered++`）、無い/parse 失敗なら `executionStatus='failed'`・`status='in_progress'` に倒し『前回セッション中に中断(再起動時 reconcile)。再実行/エスカレ/却下できます。』を記録（`failedOver++`）。AI セッションは一切起動しない read-only 処理で、failedOver 分は queue の failed 再浮上経路が拾う。

起動直後に「実セッションが動くか」を確認するには:

1. `GET /healthz` で `preflightOk`（`tmuxOk && claudeOk`）を確認する。false なら `/api/state` の preflight `note` で原因を見る。
2. `GET /api/sessions`（または UI のセッションタブで「セッションを起動 / 再確認」）を叩き、ドライバ初期化を促す。
3. `winnow`・`control`・`worker-0..N-1` のセッション/window が見えることを確認する。
4. 見えない、または例外になる場合は tmux 不在・`claude` 未ログイン・許可プロンプト停止などが疑われる。[docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) を参照。

なお `useHeadless` を切り替えると `resetDriver()` が走り、次回操作でドライバが選び直される。タイムアウト等の具体的な値は [docs/CONFIG.md](./CONFIG.md) を参照すること。
