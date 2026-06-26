# トラブルシューティング

ユーザ操作・運用の両面でつまずきやすい点を「症状 / 原因 / 対処」で横断的にまとめます。
設定値の詳細は [CONFIG.md](./CONFIG.md)、起動・常駐などの運用全般は [OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md)、画面操作は [USER_GUIDE.md](./USER_GUIDE.md) を参照してください。

---

## 操作でつまずいたら（ユーザ向け）

- **キューが全然減らない** → 序盤は正常です（Jカーブ）。さばき続けてください。
- **これは確認したくない、というものが何度も上がる** → そのカードで「もう上げるな」、または `再調律・設定` の「締め具合」を少し下げる。
- **逆に、自動に任せたくないものが勝手に処理される** → 「分類し直す→要確認/要判断」で倒し、「締め具合」を上げる。締め具合は内部で必要確信度を `min(0.98, 0.5 + 0.4 × escalationTightness + calibBump)`（範囲 0.5〜0.98）に変換します。`calibBump` はビン較正による締め下駄で、カテゴリが申告より実際に外している証拠があるとき締め側にだけ上乗せされます。
- **大きすぎて手がつかないアイテム** → 「分解する」で実行可能なタスク（leaf）まで割る。
- **AIの実行結果が不安** → カードの「実行結果 / メモを見る」で中身を確認、必要なら「取り消す」。ただし副作用は自動では巻き戻されません。

---

## tmux セッションが立たない / `tmux -V` が無い

**症状**
- `セッション` タブで「セッションを起動 / 再確認」を押しても起動しない。
- バックエンドのドライバ初期化（`init()`）がエラーで失敗する。

**原因**
- 既定ドライバ（`TmuxDriver`）は tmux に常駐する `claude` を使います。起動時にまず `tmux -V` で可用性を確認し、tmux が無ければ日本語のエラーメッセージとともに `init()` が例外を投げます。

**対処**
- tmux をインストールする（メッセージは `brew install tmux` を案内）。
- tmux を入れられない環境では、`PATCH /api/settings` または設定画面の「headless(claude -p)で動かす」で `useHeadless = true` に切り替える。headless モードは `claude -p`（print モード）で動作し tmux を必要としません。ただし billing 上のリスクがあるため恒久利用は非推奨です（[OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md) 参照）。
- セッション名は固定で `winnow`、ウィンドウは `control` と `worker-0`, `worker-1`, ... です。手動確認は `tmux has-session -t winnow` で行えます。

---

## 許可・信頼プロンプトで停止 → タイムアウト

**症状**
- ジョブが進まず、dispatch がタイムアウトする。
- エラーメッセージに「セッションが許可プロンプトで止まっている可能性」という趣旨の案内が出る。

**原因**
- ペイン内の `claude` が許可・信頼プロンプトで停止すると、バックエンドの file-IO プロトコル（リクエスト/レスポンス/done ファイル）が進まず、done ファイルの検知待ちがタイムアウトします。
- 既定の起動コマンドは `claude --permission-mode acceptEdits` です。file-IO プロトコルは Write ツールしか使わないため通常は無人運転できますが、環境によってはプロンプトで詰まることがあります。

**対処**
- 設定画面の「control 起動コマンド」「worker 起動コマンド」（`claudeControlCmd` / `claudeWorkerCmd`）を `claude --dangerously-skip-permissions` に切り替える。これはコード内コメントとエラーメッセージでも、プロンプトで詰まる場合の回避策として案内されています。
- 既存セッションは再起動では再構成されないため、設定変更後は `tmux kill-session -t winnow` で一度落としてから起動し直す（次項も参照）。
- タイムアウト値の意味は [CONFIG.md](./CONFIG.md) を参照（control 既定 90s / worker 既定 300s / 実行 dispatch 600s / セッション獲得 120s）。

---

## `maxWorkers` を増やして再起動しても worker-N へ dispatch できない

**症状**
- `worker 並列数`（`maxWorkers`）を増やしたのに、新しい `worker-N` ウィンドウに dispatch が届かない／失敗する。

**原因**
- 起動時にライブな `winnow` セッションが存在すると、それを再利用します。このとき in-memory のセッション一覧は再構築されますが、新しいウィンドウは spawn されません。つまり `maxWorkers` を増やしてアプリを再起動しても、既存セッションの window 構成は据え置きのままです。

**対処**
- 既存セッションを明示的に落としてからフレッシュ起動する：`tmux kill-session -t winnow` を実行し、その後アプリを起動し直す。フレッシュ起動時は `Math.max(1, maxWorkers)` 個の worker ウィンドウが新規作成されます。
- `shutdown()` はアプリ再起動をまたいでセッションを生かす設計（意図的な no-op）なので、自動では再構成されない点に注意してください。

---

## JSON パース失敗でジョブが failed / `.done` 検知タイムアウト

**症状**
- ジョブが `failed` になる、または完了を待ち続けてタイムアウトする。

**原因**
- バックエンドは画面を解析しません。機械的な入出力は IPC ディレクトリ（`~/.winnow/ipc`）配下のファイルで行います。
  - リクエスト：`<id>.req.md`
  - レスポンス：`<id>.res.json`（claude が結果 JSON だけを Write）
  - 完了合図：`<id>.done`（最後に `"ok"` を Write）
- 完了は `<id>.done` の存在を 1 秒間隔でポーリングして検知し、その後 `<id>.res.json` を読みます。
- `claude` が done を書けない（プロンプトで停止・前項のタイムアウト等）と done 検知がタイムアウトし、res の中身が期待した JSON でないとパース／検証に失敗してジョブが failed になります。

**対処**
- まず許可プロンプト停止の有無を確認（前々項）。done が出ないケースの多くはこれが原因です。
- dispatch は最大 2 回まで試行されます（＝再試行は 1 回まで。done が無く、ペインが idle に戻っている場合のみ）。それでも失敗する場合は `セッション` タブの live ビューや `tmux capture-pane` でペインの状態を目視確認してください（目視は readiness 検知のためで、結果スクレイピングには使いません）。
- 取りこぼした IPC ファイルが残ることがあります（後述の「ipc/ の堆積」）。

---

## `npm run build` 忘れで UI が 404 / `--production` で tsx 欠落

**症状**
- ブラウザでアプリを開くと UI が表示されず 404 になる。
- 本番系の起動で `tsx` が見つからず起動できない。

**原因**
- フロントエンドの静的配信は環境変数ではなく **ファイルの存在**で決まります。`web/dist` がディスク上に存在する場合のみ、ビルド済みフロントを静的配信し SPA の not-found ハンドラを登録します。`web/dist` が無いと UI ルートに何も応答せず 404 になります（`NODE_ENV` による分岐はありません）。
- 開発時の TypeScript 実行に使う `tsx` は devDependency です。`--production` でインストールすると devDependencies が落ち、`tsx` 起点の起動ができなくなります。

**対処**
- フロントをビルドしてから起動する（`web/dist` を生成する）。ビルド手順は [OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md) を参照。
- 本番系では `tsx` に依存しない起動経路を使うか、必要な依存が含まれるインストール手順を用いる（詳細は [OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md)）。

---

## リモートから MCP が届かない / claude のログイン切れ

**症状**
- 別マシンや LAN 越しに `POST /mcp` や REST API を叩いても到達しない。
- `GET /mcp` や `DELETE /mcp` が HTTP 405 を返す。
- セッションは起動しているのにジョブが認証絡みで失敗する。

**原因**
- サーバの bind は `127.0.0.1` にハードコードされており、設定や環境変数では変更できません。ポートは `WINNOW_PORT`（既定 `8787`）で変えられますが、ホストは常にループバックです。したがってリモートからは到達しません。
- MCP は `POST /mcp` のみ機能します。`GET` / `DELETE` は仕様上 405（`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed (stateless MCP server)"},"id":null}`）です。
- ペイン内の `claude` がログイン切れ・未認証だと、dispatch しても結果が返らずジョブが失敗します。

**対処**
- リモートアクセスは設計上想定外です。SSH ポートフォワード等でループバックへトンネルする（直接 bind を外向きにする手段はコード上ありません）。
- MCP クライアントは必ず `POST /mcp` を使う。405 が返る場合はメソッドを見直す。
- `claude` のログイン状態を確認する。`セッション` タブの live ビューや `tmux capture-pane` でログインプロンプトが出ていないか目視する。
- ログイン UI 付きの認証は依然ありません（ユーザ識別子を持たない）が、同一オリジン保証層が新設されました。全 `/api`・`/mcp` に Origin/Host 許可リスト検証が掛かり、状態変更系（`/api` の非 GET）は起動毎に生成されるローカルシークレットを要求します。詳細・切り分けは下記「`403 origin not allowed` / `403 missing local secret`」を参照。共有マシンでの取り扱いは [OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md) を参照。

---

## `ipc/` ファイルの堆積（手動クリーンアップ）

**症状**
- `~/.winnow/ipc/` 配下に `*.req.md` / `*.res.json` / `*.done` が溜まっていく。

**原因**
- dispatch は IPC ファイルでやり取りします。dispatch 前に古い `res` / `done` は削除されますが、`req` を含め完了後のファイルが残ることがあります（特に失敗・タイムアウトしたジョブ）。

**対処**
- アプリ停止中に `~/.winnow/ipc/` 配下の不要ファイルを手動削除する。ディレクトリ自体は起動時の `ensureDirs()` で再作成されます。
- パスは `WINNOW_HOME`（既定 `~/.winnow`）配下。場所の詳細は [CONFIG.md](./CONFIG.md) を参照。

---

## 起動時に DB 整合チェック／ダウングレード／マイグレーションで落ちる

**症状**
- サーバが listen する前に例外で停止し、`winnow:` で始まる stderr メッセージを残す。

**原因**
- DB スキーマは `PRAGMA user_version` を単一の真実源とする版管理（コード期待版 `CODE_SCHEMA_VERSION = 1`）になりました。起動時（`src/server/db.ts` のトップレベル＝`index.ts` が `db.js` を import した時点）に次の3つを順に行い、いずれも NG なら throw して listen させません。
  - **整合チェック失敗**: SQLite `quick_check` の結果が単一行の `"ok"` でなければ停止。メッセージ: `winnow: SQLite quick_check FAILED for <dbパス>: <詳細JSON>`。DB ファイル破損時の新しい起動失敗モードです。
  - **ダウングレード拒否**: DB の `user_version` がコード版より新しい場合に停止。メッセージ: `winnow: DB schema v<current> is newer than code v<CODE_SCHEMA_VERSION> (downgrade). Refusing to start.`。新しいバージョンで作成した DB を古いコードで起動した場合に出ます。
  - **マイグレーションの外部キー違反**: 版0→版1 マイグレーション適用後の `foreign_key_check` で違反が検出されると ROLLBACK して停止。メッセージ: `winnow: migration v<n> foreign_key_check failed: <違反JSON>`。

**対処**
- `quick_check FAILED` は DB ファイル破損です。健全なバックアップから復元するか、空 DB から作り直す（場所は [CONFIG.md](./CONFIG.md) 参照）。
- ダウングレード拒否は、新しいコードで作った DB を古いコードで開いています。コードを元のバージョンに戻すか、その DB に合うバージョンで起動してください。
- マイグレーションの FK 違反は、版0→版1 で `label_events.itemId` の孤児（旧 remove が単純 DELETE で掃除しなかった分）が NULL 化される過程で起きえます。再実行で解消しない場合は DB の素性を確認してください（[OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md) 参照）。
- なお `reconcile` / `preflight` の例外は握り潰してサーバ起動を止めません。起動を恒久的にブロックするのは上記 DB 系チェックのみです。

---

## トップに「AI 未接続」の赤バナーが出る（preflight）

**症状**
- 画面トップに `AI 未接続: <理由> → [セッション起動]` の赤バナーが出る。

**原因**
- 起動時（listen 前に一度だけ）に preflight チェックが走り、`/api/state` の `preflight` に結果が乗ります。`preflight.ok` が `false` のときバナーを表示します（`preflight` 未提供＝`undefined` のときは何も出しません）。
- preflight は AI セッションを起動しない軽い1回チェックです。`useHeadless = false` のとき `tmux -V` の可否（tmux 未検出なら note に「tmux 未検出」）と、起動コマンド先頭トークンを `<bin> --version`（timeout 5秒）で叩いた可否（解決できなければ「claude 未解決」）を見ます。`useHeadless = true` のとき tmux は skip されます。

**対処**
- 「tmux 未検出」は本ドキュメント「tmux セッションが立たない」の対処（tmux 導入 or `useHeadless = true`）に従う。
- 「claude 未解決」は `claudeControlCmd` / `claudeWorkerCmd` の先頭バイナリが PATH 上で解決できるか確認する。
- バナーの `[セッション起動]` ボタンは `api.initAi()` を呼びます。

---

## `403 origin not allowed` / `403 missing local secret`

**症状**
- ブラウザや API クライアントから `/api`・`/mcp` を叩くと 403 が返る。本文は `{"error":"origin not allowed"}` または `{"error":"missing local secret"}`。

**原因**
- 同一オリジン保証層（認証ではない）が `/api`・`/mcp` 全体に onRequest フックで掛かります。`/healthz`・`/ws`・静的アセットは対象外です。
  - **`origin not allowed`**: Host ヘッダ（および Origin/Referer があればそのホスト名）が許可集合外。許可ホストは `127.0.0.1` / `localhost` / `[::1]` / `::1`、許可ポートは本サーバポート（と空＝ポート不問。dev では `5174` も）。DNS rebinding / 他オリジン誘導を弾くためのものです。
  - **`missing local secret`**: 状態変更系（`/api` の GET/HEAD/OPTIONS 以外）でローカルシークレットが欠落／不一致。シークレットはサーバ起動毎に1回生成され（プロセス内メモリのみ・DB に置かない）、本番ビルドでは `index.html` の `</head>` 直前に `window.__WINNOW_SECRET__` として注入され、ブラウザは `X-Winnow-Secret` ヘッダで送ります。`GET /api/state`・`GET /api/export` はシークレット不要、`/mcp` はローカル claude の正規経路としてシークレット免除（Origin/Host 検証のみ）です。

**対処**
- ブラウザは本サーバが配信した `index.html` から開く（注入済みシークレットを使うため）。古いタブや別オリジンからの操作は 403 になります。リロードで解消することがあります。
- dev モード（`NODE_ENV !== production`＝`web/dist` 非配信）では Vite origin（`:5174`）を許容し、状態変更系のシークレットも免除されます（`checkSecret` が dev で常に true）。本番ビルドでのみシークレットが効くため、403 の切り分けに使えます。
- 自作の API クライアントから状態変更系を叩く場合は、本番では `X-Winnow-Secret` ヘッダを付ける必要があります。

---

## `PATCH /api/settings` が `400 disallowed command tokens` を返す

**症状**
- `claudeControlCmd` / `claudeWorkerCmd` を `PATCH /api/settings` で書き換えると 400 が返る。本文は `{"error":"disallowed command tokens in claudeControlCmd"}`（または `...in claudeWorkerCmd`）。

**原因**
- 起動コマンドは許可リスト（`claudeAllowedFlags`）外のトークンを含むと弾かれます（RCE 面を閉じるため）。先頭トークンは `claude` 固定、以降は許可集合内のトークンのみが受理されます。

**対処**
- 先頭を `claude` にし、フラグは `claudeAllowedFlags` の範囲内に収める。許可フラグの一覧は [CONFIG.md](./CONFIG.md) を参照。

---

## 再起動後に『前回セッション中に中断』のカードが浮上する（reconcile）

**症状**
- 再起動後、キューに『前回セッション中に中断(再起動時 reconcile)。再実行/エスカレ/却下できます。』の説明が付いたカードが最優先で再浮上する。

**原因**
- 起動時 reconcile（listen 前に一度だけ）が、前回プロセスで `running` のまま中断した実行ジョブを、AI を起動しない read-only 処理で決着させます。`~/.winnow` の IPC done sentinel（`<ipcId>.done` と `<ipcId>.res.json`）が見つかれば取り込み（recovered）、無い／parse 失敗なら `executionStatus = 'failed'`・`status = 'in_progress'`（blocked にはしない）に倒し（failedOver）、その分を queue の failed 再浮上経路が拾います。

**対処**
- カードから「再実行」「エスカレ」「却下」のいずれかで決着させる。中断は前回プロセスの異常終了を意味するので、必要なら原因（落ちた理由）も併せて確認してください。
- reconcile は決定論処理で、例外が出てもサーバ起動は止まりません。

---

## 実行失敗のエラーに `quota:` 接頭辞が付く

**症状**
- `/healthz` の集計やデバッグで、ジョブの `error` が `quota: ...` で始まっている。

**原因**
- AI op の失敗メッセージがクォータ/レート起因（`quota` / `rate limit` / `usage limit` / `overloaded` / `too many requests` / `429` / `529` 等にマッチ）の場合、`classifyJobError` が `quota: ` 接頭辞を付けて種別を残します。残量計は作らず、痕跡を残すだけです。

**対処**
- `quota:` 付きは環境不全（クォータ/レート）であり、設定や入力の不備とは区別できます。時間をおいて再実行するか、利用上限を確認してください。

---

## それでも直らないとき

- 一度クリーンに落とす：`tmux kill-session -t winnow` → アプリ再起動（フレッシュ起動で window が再構成されます）。
- 状態の置き場所（DB・IPC・作業ディレクトリ）は [CONFIG.md](./CONFIG.md)、常駐・バックアップなど運用は [OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md) を参照してください。
