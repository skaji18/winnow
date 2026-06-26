# 運用ガイド（OPERATOR_GUIDE）

Winnow を立てる・運用する・守る・止めるための運用者向け手順書。設定値の詳細は [docs/CONFIG.md](./CONFIG.md)、障害対応は [docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) を参照すること。MCP/REST の連携面は [docs/MCP.md](./MCP.md) にまとめてある。

> 重要な前提: Winnow は **`127.0.0.1` 固定・認証なし**で動く単一ユーザ向けローカルツールである。loopback の外へ出す場合は本書「信頼境界」を必ず読むこと。

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
- `NODE_ENV` 自体はコードのどこからも読まれていない（`production` 分岐は存在しない）。`start` が設定しているが、配信の有無を決めるのは前述の `web/dist` の存在だけ。

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
claude --permission-mode acceptEdits
```

`acceptEdits` を使うのは、ファイルI/Oプロトコルが Write ツールしか使わないため、これで無人運用が成立するという設計判断による。**既定では `--dangerously-skip-permissions` は使われていない。** コードのどこからも自動でこのフラグが付くことはない。

### `--dangerously-skip-permissions` の扱い

このフラグは、セッションが許可プロンプトで詰まったときの**ユーザ手動オーバーライド候補**としてコメント/エラーメッセージ内にのみ登場する。採用する場合の警告:

- これは許可確認を完全にスキップするため、`claude` が **サンドボックスなしで、Winnow を動かしている OS ユーザの権限でシェル実行**することを意味する。実害範囲はそのユーザができることすべて。
- 採用は最後の手段とし、信頼できる隔離環境でのみ行うこと。

### 作業ディレクトリ隔離の実態

worker のプロジェクト隔離は OS レベルで強制されていない点に注意:

- TmuxDriver では、ペインで動いているのは `claude` でありシェルではない。よって `cd` キー入力は効かない。タスクの作業ディレクトリ固定は**プロンプト文言による指示**（「この絶対パスに留まれ・他ディレクトリに触るな」）で行われており、OS による強制ではない。
- 多層防御として実行プロンプト本文にも対象 `projectDir` の絶対パスを注入するが、これも指示に過ぎない。
- 例外として **HeadlessDriver は実 OS の cwd を子プロセスに設定する**（`useHeadless: true` のとき）。tmux モードはプロンプト指示頼み、という違いを把握しておくこと。

---

## 5. 信頼境界

### 現状

- サーバは **`host: "127.0.0.1"` にハードコードでバインド**される。バインドホストを変える env var も設定も存在しない。
- **REST API・MCP ともに認証が一切ない。** トークン・APIキー・セッション・認証フックのいずれも無く、全ルートが無条件に実行される。
- したがって唯一のアクセス制御は loopback バインドのみ。**同一マシンのローカルプロセス/ローカルユーザは、MCP を含む全エンドポイントを無資格で叩ける。**

### ローカル RCE 面（要警戒）

- `PATCH /api/settings` は無認証で `claudeControlCmd` / `claudeWorkerCmd` を書き換えられる（`z.string()` のみで内容検証なし）。
- これらの文字列は `claude` セッションの起動コマンドとして使われる。つまり**ローカルの任意プロセスが起動コマンドを書き換えられる＝ローカルのコマンド実行面**になりうる。ローカルに信頼できないプロセス/ユーザが居る環境では特に警戒すること。

### loopback の外へ出す場合

- そのまま 0.0.0.0 等に晒す手段は無く、晒すべきでもない。
- 公開が必要なら、**外部に認証付きリバースプロキシ**を立てるか、**Tailscale ACL 等のネットワーク層アクセス制御**で限定すること。Winnow 自身は誰でも全権限で操作できる前提なので、境界は必ず前段で担保する。

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

- マイグレーションは冪等な前方適用のみ（`PRAGMA table_info(...)` で不足カラムを足す方式）。**ダウングレード経路は無い。**
- アップグレード前に必ず「6. バックアップ」を実施すること（WAL 同梱でのコピー or オンラインバックアップ）。
- 設定は `settings` テーブルに単一 JSON 行として保持され、初回のみ既定値で seed される。

---

## 8. 監視・ヘルス確認

- 専用のヘルスエンドポイント（`/healthz` 相当）は無い。代替として以下で状態確認する。

```bash
curl http://127.0.0.1:8787/api/sessions          # tmux セッション一覧
curl http://127.0.0.1:8787/api/sessions/<name>/capture   # ペインのテキスト取得
```

- `POST /api/ai/init` でドライバを確実に初期化しつつセッション一覧を取得できる（UI の「セッションを起動 / 再確認」ボタン相当）。
- 全 API の一覧は [docs/MCP.md](./MCP.md) を参照。

---

## 9. 起動後検証（遅延初期化に注意）

AI ドライバは**遅延初期化される singleton**である。サーバ起動時には tmux/`claude` の状態は検証されず、**最初の AI 操作で初めて顕在化する**。起動直後に「動いているか」を確認するには:

1. `GET /api/sessions`（または UI のセッションタブで「セッションを起動 / 再確認」）を叩き、ドライバ初期化を促す。
2. `winnow`・`control`・`worker-0..N-1` のセッション/window が見えることを確認する。
3. 見えない、または例外になる場合は tmux 不在・`claude` 未ログイン・許可プロンプト停止などが疑われる。[docs/TROUBLESHOOTING.md](./TROUBLESHOOTING.md) を参照。

なお `useHeadless` を切り替えると `resetDriver()` が走り、次回操作でドライバが選び直される。タイムアウト等の具体的な値は [docs/CONFIG.md](./CONFIG.md) を参照すること。
