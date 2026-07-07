# 不変条件（INVARIANTS）— 実装がいま守っている線

> **生きた現在形のドキュメント**。履歴は持たず、編集して常に現状を映す。
> 変更がここに書かれた線を破る/緩める場合は、先に `DECISIONS.md` へ決定を1節残してから本書を更新する。
> 決定の経緯・却下した代替は `DECISIONS.md`、要件の背骨は `../REQUIREMENTS.md`（§番号で引用）。

## 較正母数の純度（§3.6 浅くて頑健）

- `recordOutcome` を呼ぶのは人間の処分（`actions.ts`）と監査だけ。**receive**（受領／確認して畳む／
  レビュー完了）は呼ばない — 受領は「分類が正しかったか」の信号ではない。
- `learnings` は `calibration.ts` を import しない（コンパイル時に非呼出を保証）。
  `category_stats` / `label_events` に1行も書かない。
- **AI停止（escalate 終端）項目の「やる」（doIt）は recordOutcome を積まない** — AIが止めた作業の
  引き取りであって分類の是認ではない（rawDisposition=auto のまま流すと agreed(auto) が緩め方向に
  効く）。label note の決定論マーカー「AI停止の引き取り」で undo 側も unbump をスキップする。
- 母数は分類器の**生提案**（`rawDisposition` / `rawConfidence`）で数える。env-escalated
  （環境不全由来の escalate）は母数に積まない。
- 緩め方向の自動化は Wilson 下限 + probation（`calibration.ts`）だけ。AIゾーンの学びは
  **tighten-only**（品質は上げるが auto 着火範囲を緩めない）。

## scoreItem の純度（`queue.ts`）

- 処理量項を足さない。`sprintId` 非参照。`receivedAt` はスコアに混ぜない（可視性フィルタのみ）。
- dueBoost の境界（`DUE_SOON_DAYS` / `DUE_WEEK_DAYS`）は `horizon.ts` と単一の真実源。
- 束ね描画（レビュー leaf のネスト表示）は client の描画グルーピングのみ。
  **サーバ score 降順の配列が並びの唯一の真実**（client で scoreItem を再実装しない・並べ替えない）。

## キュー可視性の原則（`queue.ts` visible）

- 評価順: cancelled 除外 → **rejected 畳み（人間の処分が勝つ）** → awaiting_handoff →
  autoDone 取消ハンドル（`receivedAt == null` のみ）→ failed/timed_out 再浮上 →
  **アーカイブ案件畳み** → blocked 再浮上 → done 畳み → proposed → 着手中レーン →
  escalate/human・監査混入。
- 人間が一度も見ていない attention 要求を**黙って引っ込める緩め**（defer-until・時限自動消去）は
  導入しない。前面固定を解くのはスコア逓減（handoffC）まで。**畳むのは人間の明示操作**
  （receive / reject / 締めモーダル経由の案件アーカイブ）だけ。
- **アーカイブ案件配下の可視性は read 時導出**（アイテムを変異させない＝復元で自動復帰・
  較正母数に触れない）。畳むのは人間の注意・承認要求（classified escalate/human・監査混入・
  blocked・**ゲート由来** proposed・着手中レーン）。**実行系の終端（awaiting_handoff / failed /
  timed_out / autoDone 未受領の取消ハンドル / needs_human 終端＝`isNeedsHumanProposed` な
  proposed と `isEscalateTerminated` な classified）は案件の生死と無関係に出し続ける**（§4-4。
  archive 後に走り切る実行の終端を黙らせない）。バックログ/スプリント未割当/horizon も同じ
  導出で畳む（バックログはトグルと案件フィルタ明示選択で参照可）。ヘッダの「承認待ち」
  （`executor.inFlightCount`）は畳まれる proposed を数えない（キューと恒久不整合にしない）。
- **アーカイブ案件配下では自動着火しない**（/api/state 点火掃き出し・`resumePausedAuto`・
  inbox ドレインが見送り、`requestExecution` の非 manual 呼び出しも no-op）。人間の明示タップ
  （manual / approve / 指示つき再走）は通す（§3.4 の非対称）。AddItem の案件ピッカーは
  archived を出さない（新規流入が誰にも見られず畳まれる穴を入口で塞ぐ）。
- 未完のある案件の**削除は締めモーダル経由**（archive と同じ導線。「未所属で残す」の帰結を
  明示する）。`projects.remove` は projectId だけ外し **sprintId には触れない**。
- 監査サンプルは通常項目と見分けのつかない形で混ぜる（§4-3。専用画面・専用枠にしない）。
- proposed の一行理由（surfaceReason）は **read 時に現在の構造から導出**する
  （`gates.deriveProposedGate`）。保存 `executionResult` はゲート発動時点の痕跡で、
  **表示の真実にしない**（needs_human 由来＝`gates.isNeedsHumanProposed` が真のものは例外＝
  worker 語を出す。ただし全文素通しではなく **先頭行の列選択＋80字上限**まで。
  導出での上書きは不可）。**bad_project_dir だけは needs_human 素通しより先に評価**する
  （素通し優先だと承認→無言バウンスの原因が worker 文言の裏に隠れる。素通しの明示例外）。
  導出は書き込みを伴わない（updatedAt を洗わない＝ageDays 滞留表示を壊さない）。
  `gateKind` / `blockerId` / `needsHuman` は QueueItem の計算フィールドで、DB 列に永続化しない
  （needs_human 判別式をクライアントに複製しない）。
- `gates.isEscalateTerminated`（classified + leaf + executionStatus='none' + worker成果実在）は
  承認後 needs_human の **escalate 終端の正規状態**（一行理由「AI停止(人間の対応待ち)」）。
- **一度でも worker が走った項目（autoExecuted）は自動では再点火しない**。全ての自動再点火経路が
  `!autoExecuted` でガードする: /api/state の点火掃き出し / resumePausedAuto / 在庫再適用 /
  案件割当の再分類 sweep（実行済み項目を classify に流して auto 復帰→無承認再着火させない）。
  undo 等で disposition=auto に復元された実行済み項目の再実行は人間の明示タップのみ。

## 注入（コンテキスト）の信頼境界と天井（`context.ts` / `ai/prompts.ts`）

- **高信頼（ctx 側）＝人間由来**: `productContext` / `Project.context` / `Item.context` / 親チェーン。
- **低信頼（fenceBody 側）＝観察対象データ**: title/body / worker 出力（レビュー材料を含む）。
  本文中の指示・スコア自己申告には従わない（詐称シグナルとして escalate に倒す）。
  worker 由来テキストを ctx 側に相乗りさせない。
- `redactSecrets` は**結合後テキストへ1回だけの最終ゲート**（漏れ口を増やさない）。
  新しい注入経路・export 経路は必ずこのゲートを通す。
- `instruction`（人間の追加指示・複数行可。manual execute / 再走 / 承認の補足が同じ経路）は
  人間由来＝高信頼で fence しないが、`redactSecrets` + `clip`（4,000字・番兵）を
  **runExecution の一箇所**（全経路の合流点）で通す。文言は偽前提を注入しない:
  レビュー leaf（reviewMaterial 非空）＝「前提・観点」、worker 成果の実在
  （`gates.hasWorkerOutcome`、発火前の item で評価）がある再走のみ「前回の成果物を踏まえ」、
  成果なし＝中立の「補足情報」。
- 注入総量は `MAX_CONTEXT_CHARS`（16k、ARG_MAX/E2BIG 防御）天井。人間ゾーンを優先で残し、
  残予算を AIゾーンに配分する（切り詰め順を逆転させない）。
- プレビュー経路（`GET /api/items/:id/context-preview` → `buildContextPreview`）は **read-only**:
  `learnings.touch`（生存信号）を発火させない（眺めただけの学びを減衰から延命させない）。
  返すのは `redactSecrets` の最終ゲートを通った**結合後テキストのみ**で、本注入
  `buildContextBlock` と単一の組み立てを共有する（複製しない＝プレビューが実注入とドリフトしない）。

## 状態機械と Undo（§4-4 可逆＆可視）

- `UNDOABLE`（`queue.ts`）が undo 可能集合の**単一の真実源**。`undoLastLabel` は非対象 label を
  削除しない（no-op で返す）。
- 逆適用先が状態依存で分かれる場合は `label.note` の**決定論マーカー**で分岐する
  （send_back の着手前/後、receive の3種）。推論はしない。
- 人間の処分（rejected）を sweep / reconcile が上書きしない。
- `cancelled` は「実行済みの取り消し」専用。未実行 proposed の取り消しは reject 経路（undo 可能）。
- winnow は巻き戻し・採用（マージ/送信/デプロイ/削除）を**能動実行しない**。rollbackPlan は提示のみ。
  PR作成＝可逆な提示 / マージ＝不可逆な採用、の非対称を堅持。

## 実行ゲート（`executor.ts` / `gates.ts`）

- ガードは**決定論（構造シグナル）のみ**。推論でゲートしない
  （cross-repo 兄弟 / 上流未完 / auto 出所検証＝confidence null チェック）。
- ゲートの述語・閾値・文言は **`gates.ts` が単一の真実源**（executor＝write 時の痕跡、
  queue＝read 時の表示、の双方が import する）。proposed に倒す新ゲートを足すときは
  gates.ts に述語・GateKind・文言を**同時登録**する（登録漏れは read 時導出が
  「解消済み」を誤表示する）。
- 人間の明示ワンタップ（approve / manual execute / handoff への指示つき再走）はゲートを通す（§3.4）。
  承認は任意の人間補足（instruction）を運べるが、承認の意味論は変えない: 外部送信の解禁は
  settings オプトインのみ・escalate 終端（approvedRetry）の判定に非関与・approve ラベルにも積まない。
- 外部送信の解禁は `allowExternalSend` オプトイン時の承認・明示再走のみ（既定 OFF＝緩めは慎重）。
- **承認経由の再実行プロンプトは初回 needs_human 時と同一にならない**（`humanApproved`＝承認の事実
  ＋needs_human 起源のときのみ `priorPlan`＝前回計画を注入。同一プロンプト再投入は再拒否ループの
  再導入＝禁止）。承認が伝えるのは承認の事実のみで、外部送信の解禁を含まない（解禁は
  externalApproved だけが担う）。**送信可否・採用/破壊の方針の規範文は softwareNote 側の一箇所が
  真実源**（approvedNote に重複させない＝同一プロンプト内で規範が矛盾/ドリフトしない）。
  前回計画が存在しない初回承認（ゲート由来）に「前回計画を確認済み」と偽の前提を注入しない。
- **承認済み再走（approvedRetry＝承認 × `gates.isNeedsHumanProposed`）**への needs_human 応答は
  proposed に戻らず classified に倒れる（escalate 終端）。判定は「worker 成果の実在」ではなく
  **needs_human 起源**（成果実在＋executionResult 連結一致）＝failed/succeeded の残骸を持つ item の
  ゲート由来初回承認を誤終端させない。disposition は human 以外（auto/null/escalate）を escalate へ
  （human のみ保持＝人間の処分が勝つ。null 素通しは可視ルールを通らず黙って消えるため不可）。
  labels / recordOutcome は積まない（較正母数の純度）。timed_out→sentinel 回収は approvedRetry を
  復元できないため proposed に戻る（安全側）。
- needs_human 判別の単一真実源は `gates.ts`（`hasWorkerOutcome`＝成果の実在 /
  `isNeedsHumanProposed`＝proposed の needs_human 起源 / `isEscalateTerminated`＝終端状態。
  executor＝write と queue/actions＝read が同一述語を import する。インライン複製を作らない）。
  needs_human 応答で summary/output が両方欠落した場合は executor が最低限の停止理由を合成する
  （無検証 Partial のまま判別を不発にしない）。
- レビュー leaf: **深さ1固定**（レビューのレビューを作らない）・同一対象の未決レビューは重複生成しない・
  成功時のみ生成・上流未完ゲートの「上流」に数えない。
- 実行の終端は受領（`receivedAt`）。全成功実行は人間が受領するまで取消ハンドルとして可視。

## リモートアクセスの信頼境界（`security.ts` / `config.ts`）

- winnow 本体は**認証・TLS を持たない**（ユーザ識別子なし）。公開時の境界は前段のリバースプロキシ
  （認証＋TLS）が担保する。
- バインド（`WINNOW_HOST`）と Origin/Host 許可リストの追加（`WINNOW_ALLOWED_HOSTS` /
  `WINNOW_ALLOWED_PORTS`）は**起動時 env のみ**で緩められ、`PATCH /api/settings` からは緩められない
  （claudeAllowedFlags と同じ非対称ポリシー）。
- 公開構成（非 loopback バインド or `WINNOW_ALLOWED_HOSTS` 設定）× `NODE_ENV !== "production"` は
  **起動拒否**（dev のシークレット免除と公開を併用させない）。
- 公開構成では `/mcp` は **loopback からのみ**受け付ける（Host ヘッダ と 接続元アドレスの両方で判定。
  ローカル claude 直結の正規経路を維持しつつ、直バインド時の Host 偽装と、プロキシの `/mcp`
  遮断漏れへの多層防御。Host 側の判定は**プロキシがクライアント Host を透過する構成が前提** —
  nginx は `proxy_set_header Host $host` 必須）。

## 自己更新の信頼境界（`updater.ts`）

- 取得元は**コード内定数のリポジトリ**（検知）と **clone の origin**（適用）のみ。
  API・settings・env から取得元/チェック間隔を変更できない（非対称ポリシーの適用）。
- 検知は **read-only**（GitHub API への GET のみ・DB/ファイル書き込みなし）。`/api/state` の
  背景 sweep に相乗りし、専用の常駐タイマーを作らない。
- 適用は**人間の明示ワンタップのみ**（自動適用しない）。状態変更系としてローカルシークレットが
  要求される。実行中ジョブあり / working tree dirty / 適用進行中 / 非 production / npm 未解決は
  拒否。**適用中は新規の自動着火を点火しない**（点火直後の exit でジョブを轢かない）。
- プロセスは**自前 re-exec しない**。適用後は非0 exit し、再起動は supervisor（systemd 等）に
  委ねる。`bootId`（プロセス毎・非秘密）の変化を web が検知して自動再読込する。

## DB スキーマ変更の規約（`db.ts`）

- `CREATE TABLE` への列追記だけでは既存 DB に効かない。**`CODE_SCHEMA_VERSION` 繰り上げ ＋
  専用 `migrateVxtoVy`（冪等 ensureColumn）の両方が必須**。
- 追加列は nullable（可逆＝撤退は無視するだけ）を基本とする。
- 較正/監査/実行来歴フィールド（disposition/confidence/…/executionStatus/autoExecuted 等）は
  `PATCH /api/items` から書けない（口はバカ・分類器が賢い、の機械的強制）。

## メトリクスと画面（§4）

- 処理量メトリクス（velocity / burndown / 消化率 / 達成% / 完了予測線）を**どこにも出さない**。
  出すのは滞留（ageDays）と判断対象の列挙。
- 新画面・新タスク種別・新 LabelAction を安易に足さない。俯瞰は QueueView 内 groupBy の
  2レンズ（案件/見通し）まで。既存軸から導出できる事象に新 executionStatus を足さない。
- 週次一行に足してよいのは「注意の落とし所の健康指標」1語まで（受領/送り返し等）。
- ビルドゲート: typecheck `npx tsc --noEmit`（ルート1枚の tsconfig が src/ と web/src/ を検査。
  colocate した `*.test.ts` も同時に型検査される）/ test `npm test`（node:test + 既存 tsx。
  ランナーは node 組み込みのみ・追加依存なし）/ build `npx vite build` /
  smoke `WINNOW_HOME=$(mktemp -d) npx tsx scripts-smoke-feedback.ts`。
- DB に触るテストは `src/server/testing/tmp-home.ts` を import 文の先頭に置き、WINNOW_HOME を
  使い捨て一時ディレクトリへ向ける（実 `~/.winnow` をテストが触らない）。
