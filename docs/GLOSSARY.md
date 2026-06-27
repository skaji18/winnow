# 用語集（Glossary）

> 全ドキュメント共通の定義先。Winnow の表示ラベル（日本語）と、コード／DB／API 上の内部キーは
> しばしば異なる（内部キーは不変のまま、表示だけ Agile/Jira 語彙へ寄せている）。
> このページは「日本語ラベル ↔ 内部キー」の対応を一箇所に集める。
>
> 関連: [`REQUIREMENTS.md`](../REQUIREMENTS.md) / [`docs/USER_GUIDE.md`](USER_GUIDE.md) /
> [`docs/CONFIG.md`](CONFIG.md) / [`docs/DECISIONS.md`](DECISIONS.md)

---

## 1. アイテムの種別と粒度

| 日本語 | 英語 / コード上の語 | 定義 |
|---|---|---|
| ノード（親・まとめ） | `node`（`kind: "node"`） | 問い／意図。さらに割れる（分解できる）が、直接は実行できない。バックログ・ツリーでは `◆` 字。 |
| リーフ（タスク） | `leaf`（`kind: "leaf"`） | 実行可能なタスク。割れない（葉）が、実行できる。ツリーでは `▸` 字。 |
| 種別 | `kind` | アイテムが `node` か `leaf` かのフラグ。木構造を作る基本軸。 |
| 親 | `parentId` | 親アイテムの ID。ノードは子（ノード/リーフ）を持ち、`parentId` で木を構成。 |

### ラダー高度（粒度）

抽象度のはしご。**内部キー（`rung`）は不変**で、表示ラベルだけ Agile/Jira 語彙へ差し替えている
（`RUNG_LABEL`, `web/src/types.ts`）。大きい順:

| 表示ラベル | 内部キー（`rung`） | 定義 |
|---|---|---|
| テーマ | `fog` | 方向性が全く不明（霧を照らす段）。最上段・最も不可逆。 |
| イニシアチブ | `strategy` | 戦略。 |
| エピック | `tactic` | 戦術。 |
| ストーリー | `means` | 具体手段。 |
| タスク | `execution` | 実行段＝リーフ。最下段・量が爆発し、基準照合でチェック可能。 |

> 非対称: 上段ほど量は少なく不可逆性が高く判断が人間的、下段ほど量が多く可逆で基準照合できる。
> よって人間の注意は上段へ、量は下段へ流す（[`REQUIREMENTS.md`](../REQUIREMENTS.md) §2.2）。

---

## 2. 仕分け（disposition）

AI が各アイテムをどう扱おうとしているかの三値。**内部キーは英語、表示は日本語**
（`DISPOSITION_LABEL`）。

| 表示ラベル | 内部キー（`disposition`） | 定義 |
|---|---|---|
| 自動 | `auto` | 低リスク・可逆・高確信。人間に上げず自動処理（可逆リーフは自動着火）。 |
| 要確認 | `escalate` | キューに上げて人間の確認を求める。分類失敗時の安全側デフォルトもこれ。 |
| 要判断 | `human` | 人間の判断が要る。 |

> 分類器は二値ではなく三値で「分からない」を表現できる。分類に失敗した場合は安全側＝`escalate`
> に倒す（[`docs/DECISIONS.md`](DECISIONS.md)）。

### 仕分けの根拠スコア

| 表示ラベル | 内部キー | 定義 | 値域 |
|---|---|---|---|
| ステークス | `stakes` | 影響の大きさ。高いほど慎重に扱う。 | 0..1 |
| 可逆性 | `reversibility` | 取り消しやすさ。高いほど安く巻き戻せる。 | 0..1 |
| 確信度 | `confidence` | その仕分けへの AI の自信。低いほど「念のため上げた」寄り。UI では確信度バー＋%。 | 0..1 |

実行ゲートで使われる主な閾値（`executor.ts`）:

- 可逆判定: `reversibility >= 0.6`（`REVERSIBLE_THRESHOLD = 0.6`）。
- 高ステークス判定: `stakes > 0.7`。
- **不可逆 または 高ステークス → 自動着火せず「承認待ち」（`executionStatus: "proposed"`）。**
- 可逆・低ステークス・横断衝突なし → 自動着火。

実行完了後の引き取り（handoff）:

- **引き取り待ち**（`executionStatus: "awaiting_handoff"`、`status: "review"`）: 実行は成功したが成果物に人間の責任（レビュー／採用）が残るとき、`done` に沈めずキュー前面に出す状態。人間が**受け取る**（`POST /api/items/:id/accept` → label `receive`）と `succeeded`/`done` に進む。「やって終わり」（純ローカル・低ステークス・可逆・外部成果物なし）は従来どおり即 `done`。
- 引き取り要否は新しい申告軸を立てず、外部成果物 `artifacts` の有無／`reversible===false`／高ステークス／外部送信の許可（`externalApproved`）から導出する（`handoffRequired`）。
- **承認＝外部送信のゴーサイン**: `allowExternalSend`（既定 OFF）が ON のとき、承認すると worker に「このアイテムに限り push/PR 作成を実行してよい。マージ・本番デプロイ・削除はしない」を伝える。PR作成＝可逆な提示／マージ＝不可逆な採用の非対称（採用は人間が外で）。

分類側ゲート（`classifier.ts`）: `confidence` が必要バー
`requiredConf = min(0.98, 0.5 + 0.4 * escalationTightness + calibBump)`（= 0.5..0.98。
`calibBump` はビン較正の締め下駄）を下回る、または `stakes > 0.7 && reversibility < 0.5`
のとき、`auto` を `escalate` に降格。

### 較正母数の生提案（raw*）

最終ゲート（tightness 締め・leaf 実行可能性ゲート）は `disposition`/`confidence` を
書き換えるが、較正母数（`category_stats`）を汚さないよう「書き換え前の生提案」を別に保持する。

| 表示ラベル | 内部キー | 定義 |
|---|---|---|
| 生の仕分け | `rawDisposition` | ルール・基準率補正・tightness/ゲートで上書きされる前の生の `disposition`。`null` = 未分類/レガシー。較正は `disposition` ではなくこれを真実源にする。 |
| 生の確信度 | `rawConfidence` | clamp01 後・tightness 前の `confidence`。confidence ビン（`confBin`）の決定に使う。 |
| 環境不全エスカレ | `envEscalated` | classify 失敗/JSON 解析失敗/タイムアウト/dispatch 不可で安全側 `escalate` に倒した痕跡。較正母数に積まず、週次の「失敗」集計に使う。 |

### プロセス軸

ラダーと直交する「どう降りるか」の軸（`process`）。

| 表示ラベル | 内部キー | 定義 |
|---|---|---|
| 反復 | `iterative` | 短サイクルで情報を買う割り方。不確実な段向き。 |
| 一括 | `waterfall` | 再計画不要な段をバッチで束ねる割り方。道が見えた実行段向き。 |

---

## 3. 較正・学習の概念

| 用語 | 英語 / コード上の語 | 定義 |
|---|---|---|
| Jカーブ | J-curve | コールドスタートの体感曲線。使い始めはキューが短くならない（AIが境界線を学習中）。さばき続けるほど自動に倒せる分が増え、やがてキューはエスカレーションだけの短いリストになる。 |
| 基準率補正 | base-rate correction | 学習の中身の大半。カテゴリ別のカウントで境界を倒す（例: あるカテゴリで `escalate` が十分なサンプルで一貫却下されたら、learned rule で自動に倒す）。ゼロから方策は学ばず、明示ルールの残差だけを学ぶ。 |
| confidence ビン | `confBin` | 確信度を 5 段（`floor(clamp01(rawConfidence ?? confidence)*5)` を 0..4 に clamp、`null`/未定義は中央ビン 2 扱い）に区切るビン。`category_stats` の PK は `(category, aiDisposition, confBin)`。既存集計は全ビン SUM で後方互換。 |
| Wilson スコア下限 | `wilsonLowerBound` | 緩め側（learned auto rule 生成）の判定を点推定から置換した区間下限（決定論・z=1.96、`total<1` は 0 を返す＝緩めない安全側）。`escalate→auto` 覆し率の Wilson 下限が `OVERTURN_TO_AUTO`(=0.8) 以上のときだけ自動に倒す。小標本で偶然高い却下率に釣られないため（旧 `MIN_SAMPLES` を置換・撤廃）。 |
| 監査サンプリング | audit sampling | 自動バケットの一定割合を、わざと人間レビューに混ぜてバイアスのない教師信号を取る仕組み。サンプルされた項目は同じキューに塩漬けで混入し、控えめな「確認(自動処理)」チップだけが付く。learned auto rule のカテゴリは `learnedAuditFloor` まで監査率を底上げし、tip 直後は `tipProbationMs` の間 `tipProbationRate` へ一時引き上げ（probation）。 |
| 監査チップ | `isAudit` / `chip-audit`（`確認(自動処理)`） | 監査サンプルとして抜き取られたカードに付く控えめなチップ。アクションは通常項目と同一。 |
| 明示ルール / 学習した境界 | learned rule / `rules` | `category → disposition` の明示的な境界。学習由来（学習）か手動かを持ち、設定画面で「解除」できる。 |
| 当面は上げて（即締め） | `escalateCategory`（`POST /api/items/:id/escalate-category`） | 「この種類は当面上げて」。`muteCategory`（もう上げるな＝自動に倒す）の対称で、`escalate` 固定の手動ルールを upsert し当該カテゴリの在庫へ即再適用する締め方向の正規路。 |
| 問いに戻す（送り返し） | `send_back` / `sendBack`（`POST /api/items/:id/action` action=`send_back`） | AIが「やるだけ（auto/leaf）」と仕分けた項目を、人間が「実は要件検討が要る**問い**だ」と倒して `kind=node` へ降格し再分解の俎上に戻す。`reclassify`（disposition 軸の覆し）に対称な **kind 軸のリカバリ**。`disposition` を `escalate` に倒して可視化＋着火停止し、`uncertaintyResolved=false` で将来の子の点火ゲートを締める。着手後（succeeded/awaiting_handoff）は先に取り消し（巻き戻し提示）を通してから降格する。締め方向（安全側）の操作で、教師信号は過小エスカレーションとして既存 `overturned` に積む（即締めはせず Wilson 母数へ）。 |
| 可逆性過大評価 | — | software の auto succeeded を取り消したとき、worker が可逆（`declaredReversible===true`）と自己申告したのに `rollbackPlan` が空＝自己申告と実態が乖離した状態。該当 category を即 `escalate` に締める（締め方向のみ）。 |
| 信号の非対称 | — | 過剰エスカレーションは安く速く気づけ、過小エスカレーションは高く遅れて危険に現れる。ゆえに「**締めるのは速く、緩めるのは慎重に**」。 |

---

## 4. 実行系・セッション

| 表示ラベル | 英語 / コード上の語 | 定義 |
|---|---|---|
| control | control session | 分類・分解・昇格判定を担う薄い常駐セッション（×1）。tmux 上の `winnow:control` ウィンドウ。作業ディレクトリは `~/.winnow/control-cwd`。 |
| worker | worker session | 実行を担うセッション（`winnow:worker-0`, `worker-1`, …）。並列数は `maxWorkers`（既定 2）。作業ディレクトリは `~/.winnow/workspaces`（リーフが `projectDir` を持つ場合はそこへ instruction で固定）。 |
| 分解器 | Decomposer | ノードに効く。子（ノード/リーフ）と「割り方」の選択肢を提案する。 |
| 実行器 | Executor | リーフに効く。具体実行を回す。可逆性で自動着火／提案を分ける。 |
| 昇格判定 | Promotion Judge | 出てきた子に「まだ問いか／もう実行可能か」を付け直す。 |
| 案件に昇格 | to-project（`POST /api/items/:id/to-project`） | ノードをプロジェクト（入れ物）に格上げし、サブツリーごと紐付ける。 |
| 承認待ち | `executionStatus: "proposed"` | 不可逆・高ステークス、未確定ノード配下/上流未完リーフ、または横断衝突ガードにかかった項目。人間のワンタップ承認を待つ状態。 |

### 実行成果物・痕跡

`executionResult` は後方互換のため連結文字列を維持しつつ、監査／取り消し提示のため以下を分離保持する。

| 表示ラベル | 内部キー | 定義 |
|---|---|---|
| 実行サマリ | `executionSummary` | general 成果物の要約（`ExecuteOut.summary`）。 |
| 実行本体 | `executionOutput` | general 成果物本体（`ExecuteOut.output`）。下書き提案の中身。 |
| 巻き戻し手順 | `rollbackPlan` | software 実行の巻き戻し手順（worker 自己申告）。取り消し時に提示。 |
| 可逆性自己申告 | `declaredReversible` | worker が可逆と申告したか。`null` = 未申告（三値）。可逆と申告したのに `rollbackPlan` が空なら「可逆性過大評価」として締める。 |
| 外部成果物 | `artifacts` | 外部副作用の自由文/URL 配列を JSON 文字列で持つ read-only 痕跡。winnow は能動操作しない。 |

> 実行失敗（`executionStatus: "failed"`）は `status` を `blocked` にせず `in_progress` に保ち、
> キューの再浮上フィルタで拾う。

> AI 連携の詳細（tmux／ファイルI/Oプロトコル／ヘッドレス）は [`docs/MCP.md`](MCP.md) と
> [`docs/CONFIG.md`](CONFIG.md) を参照。

---

## 5. タスク管理の器

| 表示ラベル | 英語 / コード上の語 | 定義 |
|---|---|---|
| 案件（プロジェクト） | project | 最上位の束ね。アイテムは1案件に属せる。`mode` で見せ方を切替（`board`=状態カンバン / `flow`=優先度・期日順リスト）。`status` で `active` / `archived`（アーカイブ。ピッカーは既定で畳む）を切替。削除してもタスクは残り、紐付けだけ外れる。 |
| 案件の前提・文脈 | `Project.context` | 案件固有の自由文。分解・実行のプロンプトに注入される。 |
| スプリント | sprint | 案件に属さない**グローバルな時間箱（期間）**。スプリントタブはその期間の全タスクを案件横断でカンバン表示。削除してもタスクは残り、割当だけ外れる。 |
| 状態 | `status` | 受信(inbox) / 未着手(classified) / 進行中(in_progress) / レビュー(review) / 完了(done) / 却下(rejected) / 停滞(blocked)。 |
| 優先度 | `priority` | 緊急(urgent) / 高(high) / 中(normal) / 低(low)。既定 `normal`。キューの並びに加点。 |
| 期日 | `dueDate` | 期限（epoch ms）。超過・間近はキューで前に出る。 |
| 原典リンク | `sourceUrl` | 取り込み元 URL/参照（課題/PR/ドキュメントへ戻る）。read-only 痕跡で winnow は外部送出しない。`null` = 手入力。 |
| 外部冪等キー | `externalKey` | 外部ソース由来の重複取り込み防止キー。同一 `externalKey` の再 capture は重複作成せず既存 Item に追記して返す（再分類は発火しない）。非 NULL のみ一意（部分ユニーク索引）。 |

---

## 6. 設定のつまみ

| 表示ラベル | 内部キー | 定義 | 既定 / 値域 |
|---|---|---|---|
| 締め具合 | `escalationTightness` | 高いほどエスカレ寄り（安全側）。必要確信度バーを `min(0.98, 0.5 + 0.4 * tightness + calibBump)`（= 0.5..0.98。`calibBump` はビン較正の締め下駄）に上げる。 | 既定 0.7 / 0–1 |
| 監査サンプル率 | `auditRate` | 自動処理の何%を監査としてキューに混ぜるか（`auto` かつ乱数 < auditRate でサンプル）。 | 既定 0.15 / 0–1（UI スライダーは 0–0.5） |
| worker 並列数 | `maxWorkers` | worker セッション数。実行時に `max(1, …)` で 1 を下限に丸め。 | 既定 2 / 1–8（UI スライダーは 0–6） |
| プロダクトの前提 | `productContext` | プロダクト全体の前提・方針。仕分け・分解・実行すべてに注入。 | 既定 `""` |
| headless で動かす | `useHeadless` | tmux 常駐ではなく `claude -p`（ヘッドレス）で動かす切替。 | 既定 `false` |
| control 起動コマンド | `claudeControlCmd` | control セッションの起動コマンド。 | 既定 `claude --permission-mode auto` |
| worker 起動コマンド | `claudeWorkerCmd` | worker セッションの起動コマンド。 | 既定 `claude --permission-mode auto` |
| 自動実行の一時停止 | `pauseAuto` | true で自動経路（キュー掃き出し・classify 末尾の即時着火・capture sweep）を抑止。手動承認は通す。 | 既定 `false` |
| learned 監査下限 | `learnedAuditFloor` | learned auto rule カテゴリに恒常維持する最低監査率。`rollAudit` が `max(auditRate, learnedAuditFloor)` を採る。 | 既定 0.25 / 0–1 |
| tip probation 期間 | `tipProbationMs` | learned auto rule の tip 直後に監査を一時引き上げる期間。 | 既定 604800000ms（1週間） |
| tip probation 監査率 | `tipProbationRate` | probation 期間中の引き上げ監査率。 | 既定 0.5 / 0–1 |
| ビン較正の最小サンプル | `binCalibrationMinSamples` | confidence ビン較正を発火させる最小サンプル数（ビン単位）。未満は補正しない。 | 既定 8（整数） |
| ビン乖離閾値 | `binOverturnGap` | ビン実 overturn 率が申告を上回る乖離の閾値。超過で当該カテゴリの `requiredConf` を締め側に補正。 | 既定 0.25 / 0–1 |
| claude 許可フラグ | `claudeAllowedFlags` | `claudeControlCmd`/`claudeWorkerCmd` を PATCH/import で書き換える際に許可するトークン集合（RCE 面を封鎖）。 | 既定: `--permission-mode` `auto` `acceptEdits` `--dangerously-skip-permissions` `-p` `--output-format` `json` `--model` `sonnet` `opus` `haiku` `plan` `default` |
| 取り込み保留閾値 | `captureInboxHoldThreshold` | 過負荷時に capture を即 classify せず inbox 保留にする保留中件数の閾値。0 で無効。 | 既定 24 |

> 各値のクランプ・更新 API は [`docs/CONFIG.md`](CONFIG.md) を参照。
> 注: コード上のコメントでは「tightness」と呼ぶ箇所があるが、実キーは `escalationTightness`。
