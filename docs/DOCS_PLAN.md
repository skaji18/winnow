<!--
このファイルはドキュメント整備の「計画書」です。実ドキュメント本体ではありません。
読者別に必要なドキュメントを洗い出し、既存4ファイルの再編方針をまとめたものです。
着手が終わった項目は本ファイルを更新するか、完了後に削除してください。
-->

# Winnow ドキュメント整備計画

4つの分析ブリーフを踏まえ、現状（`README.md` / `REQUIREMENTS.md` / `docs/USER_GUIDE.md` / `docs/DECISIONS.md` の4ファイルのみ）から、読者別に整理された実用的な構成へ再編する計画を提案します。

---

## 1. 読者（オーディエンス）の整理

| 読者 | 何を知りたいか | 現状の充足度 |
|---|---|---|
| **新規来訪者・評価者** | これは何のツールか、3分で把握したい。「タスク消化ツールではなく判断アテンションを配給する道具」というコンセプトと、スクショ、各ドキュメントへの入口 | △ READMEが全部入りで「3分把握」に不向き |
| **サーバ管理者・運用者** | 立てる・止める・守る・直す。Node 20+/tmux/`claude`ログイン要件、`WINNOW_HOME`・`~/.winnow/`、`WINNOW_PORT`(8787・127.0.0.1固定)、tmux常駐(`winnow`セッション)、許可モード、バックアップ、セキュリティ境界 | ✕ 専用ドキュメントなし。README＋USER_GUIDE §8に散在し、重大な運用リスク(後述)が未文書 |
| **タスクツール利用者（トリアージ担当）** | キューのさばき方、各ボタンの意味、自動/要確認/要判断、Jカーブ、案件/スプリント/バックログ、設定スライダー | ◎ USER_GUIDEが良質。ただしコンセプト再掲と運用設定が混在 |
| **コントリビューター・開発者** | `src/server`/`web/src`構成、`npm run dev/build/start/typecheck/seed`、`AiDriver`抽象(tmux/headless)、ローカル起動、貢献手順 | ✕ 専用ドキュメントなし。DECISIONSは「なぜ」のみで「どう貢献するか」が無い |
| **MCP/API統合者** | `winnow_capture`の全引数、`POST /mcp`登録、REST API、loopback信頼境界 | △ README §MCP連携が唯一の情報源。引数の網羅・REST APIは未文書 |
| **設計に興味がある人 / 仕様の正典** | 設計哲学(confidence×stakes×reversibility、三値分類、基準率補正、監査、Jカーブ、非収束)、実装上の決定の根拠 | ◎ REQUIREMENTS(背骨)とDECISIONS(ADR)が担う。現状維持でよい |

---

## 2. 推奨ドキュメント構成（ファイルツリー）

```
README.md                      # 簡潔な入口＋リンク集（大幅スリム化）
REQUIREMENTS.md                # 設計の背骨（現状維持）
docs/
├── USER_GUIDE.md              # 純・エンドユーザ向け（スリム化）
├── OPERATOR_GUIDE.md          # 新規：運用者向け
├── CONFIG.md                  # 新規：設定・環境変数リファレンス
├── MCP.md                     # 新規：MCP/API連携リファレンス
├── CONTRIBUTING.md            # 新規：開発者向け
├── TROUBLESHOOTING.md         # 新規：横断トラブルシューティング
├── GLOSSARY.md                # 新規：用語集
└── DECISIONS.md               # 実装上の決定/ADR（現状維持）
```

### README.md（スリム化）
- **目的**: 3分で「何のツールか」を把握させ、各ドキュメントへ振り分ける。
- **対象読者**: 新規来訪者・評価者。
- **含める内容**:
  - 一行コンセプト「判断アテンションを配給する道具」＋3〜4文の要約
  - スクリーンショット（キュー画面）
  - 最小クイックスタート（`npm install` → `npm run build` → `npm start` → `http://127.0.0.1:8787`、前提: Node 20+ / tmux / ログイン済み`claude`）
  - 「あなたは誰？」リンク集（利用者→USER_GUIDE、運用者→OPERATOR_GUIDE、開発者→CONTRIBUTING、統合→MCP、設計→REQUIREMENTS/DECISIONS）
- **流用元**: 現READMEの冒頭コンセプトと前提・最小手順のみ残す。AI連携詳細・利用フロー・MCP登録・非目標は各専用docへ移動。

### docs/USER_GUIDE.md（スリム化・純化）
- **目的**: 日々のトリアージ操作マニュアル。
- **対象読者**: タスクツール利用者（非技術者）。トーンは「です・ます」。
- **含める内容（既存目次を維持しつつ調整）**:
  - 最初に知っておいてほしいこと（処分＝ラベル、Jカーブ）
  - 画面の全体像（6タブ＋常設の「雑に貼る入口」AddItem）
  - キューのさばき方（やる/実行する/分解する/案件に昇格/粒度を下げる/分類し直す/もう上げるな/却下、承認待ち・auto-doneの3状態、監査チップ「確認(自動処理)」）
  - 案件 / スプリント / バックログ / 設定スライダー（締め具合・監査サンプル率）
  - **追加**: MCP `winnow_capture` への短いポインタ（→docs/MCP.md）
  - **追加**: 「収束は完了しない・fog領域は自動化されない」正直ノート（キューがゼロにはならない期待値調整）
  - 一日の回し方 / つまずいたら（→運用系はTROUBLESHOOTINGへリンク）
- **流用元**: 現USER_GUIDEをほぼ温存。§8の運用設定(maxWorkers・起動コマンド・headless)はOPERATOR_GUIDE/CONFIGへ移動し、ユーザ向けスライダーのみ残す。冒頭の「Winnowは何をするか」重複部はREADME参照に圧縮。

### docs/OPERATOR_GUIDE.md（新規）
- **目的**: 立てる・運用する・守る・止める。
- **対象読者**: サーバ管理者・運用者。トーンは手順命令形。
- **含める内容**:
  - 前提（Node 20+ ※`engines`未強制、tmux、ログイン済み`claude`サブスク座席、`better-sqlite3`のネイティブビルド要件）
  - インストール/ビルド/起動（`npm install`→`build`→`start`、**`tsx`はdevDependencyなので`npm install --production`は`npm start`を壊す**点、`build`忘れはUIが404になる点）
  - tmuxセッションモデル（`winnow`セッション、`control`＋`worker-0..N-1`、再起動を跨いで存続、停止は`tmux kill-session -t winnow`、`tmux attach -t winnow:worker-0`）
  - 許可モードとセキュリティ（`acceptEdits`既定、`--dangerously-skip-permissions`は**無サンドボックスでOSユーザ権限のシェル実行**＝作業ディレクトリ隔離はプロンプト文言のみで強制でない）
  - 信頼境界（127.0.0.1固定・**認証なし**、off-loopback公開は外部の認証付きプロキシ/Tailscale ACL必須）
  - バックアップ（WALモードのため`winnow.db`単体コピーは不可、`-wal`/`-shm`同梱かオンラインバックアップ）
  - アップグレード方針（前方のみ・バージョンスタンプ無し・ダウングレード不可）
  - 監視・ヘルス（ログは`warn`のみ、`/healthz`無し、`GET /api/sessions`が代替確認）
  - 起動後検証（ドライバは遅延初期化＝tmux/claude不備は初回AI操作で顕在化するので`GET /api/sessions`で確認）
- **流用元**: README「AI連携の仕組み」「セットアップ」、USER_GUIDE §8の運用部分。**加えて運用ブリーフが洗い出した未文書リスクを正式に文書化**。

### docs/CONFIG.md（新規）
- **目的**: 設定・パラメータの一覧リファレンス。
- **対象読者**: 運用者・上級ユーザ。
- **含める内容**:
  - 環境変数表: `WINNOW_HOME`(既定`~/.winnow`)、`WINNOW_PORT`(既定8787、※bind hostは`127.0.0.1`ハードコードで上書き不可)、`NODE_ENV`(`npm start`が`production`を設定、ここでは静的配信有無のみ)
  - `~/.winnow/`レイアウト（`winnow.db`/`ipc/`/`control-cwd/`/`workspaces/`）
  - 設定(settings)パラメータ表: `maxWorkers`(既定2・上限8)、`escalationTightness`(既定0.7)、`auditRate`(既定0.15)、`useHeadless`、`claudeControlCmd`/`claudeWorkerCmd`、`productContext`。**`PATCH /api/settings`が未認証で起動コマンドを変更可＝ローカルRCE面**であることを明記
  - 実行ゲートの定数（reversibility≥0.6/stakes>0.7、タイムアウト: acquire 120s・control 90s・worker 300s・execution 600s、`MAX_CONTEXT_CHARS=16000`）
- **流用元**: 新規。実体は`src/server/config.ts`・`src/server/domain.ts`(DEFAULT_SETTINGS)・`executor.ts`。

### docs/MCP.md（新規。必要に応じてREST部を将来`API.md`へ分割）
- **目的**: 外部ツールからの捕獲・統合リファレンス。
- **対象読者**: MCP/API統合者、Claude Codeも使う利用者。
- **含める内容**:
  - 設計思想「MCPは口であって目でも手でもない」（`winnow_capture`一本のみ、キュー読取・書戻し無し、GET/DELETEは405）
  - 登録: `claude mcp add --transport http winnow http://127.0.0.1:8787/mcp`（`--scope user`）
  - `winnow_capture`引数全表: `title?` / `body`(リッチほど分類精度↑) / `kind?`(node\|leaf) / `domain?` / `projectDir?` / `projectId?` / `sprintId?` / `priority?` / `dueDate?` / `parentId?` / `classify?`(既定true)
  - loopback制約（リモートClaudeは127.0.0.1に届かない、トンネル＋認証必須）
  - REST APIの要点（`GET /api/state`スナップショット、item CRUD、AIオペ、`POST /api/items/:id/to-project`等。`patchSchema`は監査/来歴フィールドを意図的に除外）
- **流用元**: README §MCP連携。実体は`src/server/capture.ts`・`mcp/server.ts`・`api/routes.ts`。

### docs/CONTRIBUTING.md（新規）
- **目的**: 開発参加と改造の入口。
- **対象読者**: コントリビューター・開発者。
- **含める内容**:
  - スタック（Node+TS ESM、Fastify 4、better-sqlite3 11、MCP SDK 1.29、zod 3／React 18+Vite 5）
  - リポジトリ構成（`src/server/*`＝cognitionモジュール群、`web/src/*`）
  - スクリプト（`dev`=server8787+vite5174、`build`、`start`、`typecheck`が唯一の静的ゲート、`seed`）。**test runner/lintは未設定**である旨
  - `AiDriver`抽象（interface、`tmux-driver`(主)/`headless-driver`(代替)、ファイルI/Oプロトコル、`/clear`によるwarm-but-stateless）
  - データフロー概観（capture→classify→calibration→queue→execute→summary）＝詳細はREQUIREMENTS/DECISIONSへリンク
- **流用元**: 新規。アーキテクチャ・ブリーフ＋DECISIONSの該当節。

### docs/TROUBLESHOOTING.md（新規）
- **目的**: ユーザ操作と運用障害を横断的に集約。
- **対象読者**: 全員（運用者中心）。
- **含める内容**:
  - tmuxセッションが立たない / `tmux -V`が無い
  - 許可・信頼プロンプトで停止 → タイムアウト（`--dangerously-skip-permissions`への切替）
  - `maxWorkers`を増やして再起動しても既存セッションのwindowが再構成されず`worker-N`へのdispatchが失敗
  - JSONパース失敗でジョブfailed / `.done`検知タイムアウト
  - `build`忘れでUIが404 / `--production`で`tsx`欠落
  - リモートからMCPが届かない / `claude`ログイン切れ
  - `ipc/`ファイルが無制限に堆積（手動クリーンアップ）
- **流用元**: USER_GUIDE「つまずいたら」（ユーザ操作）＋README断片＋運用ブリーフの失敗モード一覧。

### docs/GLOSSARY.md（新規）
- **目的**: 各docに散在する用語の共通定義先。
- **対象読者**: 全員。
- **含める内容**: ノード/リーフ、ラダー高度（テーマ→イニシアチブ→エピック→ストーリー→タスク／内部rung: fog/strategy/tactic/means/execution）、disposition（自動=auto / 要確認=escalate / 要判断=human）、stakes/reversibility/confidence、Jカーブ、基準率補正、監査サンプリング、control/worker、案件(project)/スプリント、tightness/auditRate。**和英対応表を含める**（コード・バッジ・REQUIREMENTSを読む人向け）。
- **流用元**: USER_GUIDEバッジ節＋DECISIONS用語節を集約し、各docはここを参照。

---

## 3. 既存ドキュメントの扱い

### README.md → **分割・大幅スリム化**
今は「リポジトリ紹介＋管理者セットアップ＋利用フロー＋AI連携＋MCP登録＋非目標」を1ファイルに抱え、来訪者・運用者・利用者・統合者・設計者を同じ長文に閉じ込めている。
- **残す**: 一行コンセプト、3〜4文要約、最小クイックスタート、リンク集。
- **移動**: AI連携の仕組み→OPERATOR_GUIDE＋CONTRIBUTING、セットアップ詳細→OPERATOR_GUIDE、使い方の流れ→USER_GUIDE（重複削除）、MCP登録→MCP.md、非目標→REQUIREMENTS参照に圧縮。

### REQUIREMENTS.md → **現状維持（設計の正典）**
背骨として価値が高い。冒頭コンセプト一行がREADMEと重複するが、正典側を真とし、READMEはそれを要約する関係に整理。非目標・限界はここを参照先にする。

### docs/USER_GUIDE.md → **スリム化（純エンドユーザ化）**
質は高いので骨格は温存。
- **剥がす**: §8の運用設定（maxWorkers・起動コマンド・headless）→OPERATOR_GUIDE/CONFIG。冒頭「Winnowは何をするか」「Jカーブ」のコンセプト再掲→READMEへの圧縮参照。
- **足す**: MCP `winnow_capture`ポインタ、非収束の正直ノート、低確信度escalationは`分類し直す`が最も効く旨。
- **用語整合**: README/REQUIREMENTSの「降ろす」とUIの「粒度を下げる」を統一し、GLOSSARYで相互参照。

### docs/DECISIONS.md → **現状維持（ADR）。一部スピンアウト可**
ADRログとして維持。ただしAI連携アーキの記述がREADMEと二重なので、手順はOPERATOR_GUIDE、根拠はDECISIONSと役割分担。用語マッピング（Agile/Jira）はGLOSSARYへ集約し、DECISIONSはそこを参照。仕様レベルの記述（polyrepoガード挙動・文脈伝播）はREQUIREMENTS寄りなので必要なら移送。

---

## 4. 不足している重要ドキュメント（ギャップ）

| 新規doc | 一行の根拠 |
|---|---|
| **OPERATOR_GUIDE.md** | tmux常駐・許可モード・認証なし境界・バックアップが3ファイルに散在し、重大な運用リスクが未文書のため。 |
| **CONFIG.md** | 環境変数(`WINNOW_HOME`/`WINNOW_PORT`)・設定パラメータ・タイムアウト定数の一覧表が存在せず、`config.ts`/`domain.ts`を読むしかないため。 |
| **MCP.md** | `winnow_capture`の全引数とloopback制約・REST APIがREADMEの1節にしか無く、統合者の独立リファレンスが必要なため。 |
| **CONTRIBUTING.md** | `npm`スクリプト・`AiDriver`抽象・リポジトリ構成・「test/lint未設定」が未文書で、開発参加の入口が無いため。 |
| **TROUBLESHOOTING.md** | 運用系障害（tmux不起動、許可プロンプト停止、worker再構成漏れ、MCP到達不可）が体系化されておらず断片的なため。 |
| **GLOSSARY.md** | ノード/リーフ・三値分類・Jカーブ・基準率補正等の定義が各docに散在し、和英対応も無いため。 |

---

## 5. 優先順位

1. **OPERATOR_GUIDE.md（新規）** — 最大のギャップかつ安全に関わる（認証なし、`--dangerously-skip-permissions`の無サンドボックス、`PATCH /api/settings`によるRCE面、WALバックアップ）。運用者がいないとそもそも誰も使えない。
2. **README.md（スリム化＋リンク集）** — 入口が全部入りで機能不全。各docへの振り分けハブを先に整えると以降の整備が並行しやすい。
3. **CONFIG.md（新規）** — OPERATOR_GUIDEから参照する設定表。`WINNOW_PORT`未文書・bind host上書き不可など事実の明文化を早期に。
4. **GLOSSARY.md（新規）** — 以降の全docが参照する共通基盤。用語ドリフト（降ろす/粒度を下げる、和英）の統一を先に固定。
5. **USER_GUIDE.md（スリム化）** — 既に良質なので、運用設定の剥離とコンセプト重複の圧縮、MCP/非収束ノート追加の微調整。
6. **MCP.md / TROUBLESHOOTING.md（新規）** — 統合者向けと横断障害集約。既存断片の集約が主体なので後半で。
7. **CONTRIBUTING.md（新規）** — 単一ユーザ業務ツールという前提上、優先度は最後。ただし将来の保守性のため作成は推奨。

なお全ドキュメントは**日本語を維持**し、読者別にトーンを揃える（エンドユーザ＝です・ます／設計・ADR＝である調／運用＝手順命令形）。英語版は現状の単一ユーザ前提では不要。

参照した実体ファイル（絶対パス）: `/home/user/winnow/README.md`, `/home/user/winnow/REQUIREMENTS.md`, `/home/user/winnow/docs/USER_GUIDE.md`, `/home/user/winnow/docs/DECISIONS.md`, `/home/user/winnow/src/server/config.ts`, `/home/user/winnow/src/server/domain.ts`, `/home/user/winnow/src/server/capture.ts`, `/home/user/winnow/src/server/api/routes.ts`, `/home/user/winnow/src/server/executor.ts`。