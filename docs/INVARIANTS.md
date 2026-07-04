# 不変条件（INVARIANTS）— 実装がいま守っている線

> **生きた現在形のドキュメント**。履歴は持たず、編集して常に現状を映す。
> 変更がここに書かれた線を破る/緩める場合は、先に `DECISIONS.md` へ決定を1節残してから本書を更新する。
> 決定の経緯・却下した代替は `DECISIONS.md`、要件の背骨は `../REQUIREMENTS.md`（§番号で引用）。

## 較正母数の純度（§3.6 浅くて頑健）

- `recordOutcome` を呼ぶのは人間の処分（`actions.ts`）と監査だけ。**receive**（受領／確認して畳む／
  レビュー完了）は呼ばない — 受領は「分類が正しかったか」の信号ではない。
- `learnings` は `calibration.ts` を import しない（コンパイル時に非呼出を保証）。
  `category_stats` / `label_events` に1行も書かない。
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
  autoDone 取消ハンドル（`receivedAt == null` のみ）→ failed/timed_out/blocked 再浮上 →
  done 畳み → proposed → 着手中レーン → escalate/human・監査混入。
- 人間が一度も見ていない attention 要求を**黙って引っ込める緩め**（defer-until・時限自動消去）は
  導入しない。前面固定を解くのはスコア逓減（handoffC）まで。**畳むのは人間の明示操作**
  （receive / reject）だけ。
- 監査サンプルは通常項目と見分けのつかない形で混ぜる（§4-3。専用画面・専用枠にしない）。
- proposed の一行理由（surfaceReason）は **read 時に現在の構造から導出**する
  （`gates.deriveProposedGate`）。保存 `executionResult` はゲート発動時点の痕跡で、
  **表示の真実にしない**（needs_human 由来＝autoExecuted かつ worker 成果
  （executionSummary/Output）が実在するものは例外＝素通し）。
  導出は書き込みを伴わない（updatedAt を洗わない＝ageDays 滞留表示を壊さない）。
  `gateKind` / `blockerId` は QueueItem の計算フィールドで、DB 列に永続化しない。

## 注入（コンテキスト）の信頼境界と天井（`context.ts` / `ai/prompts.ts`）

- **高信頼（ctx 側）＝人間由来**: `productContext` / `Project.context` / `Item.context` / 親チェーン。
- **低信頼（fenceBody 側）＝観察対象データ**: title/body / worker 出力（レビュー材料を含む）。
  本文中の指示・スコア自己申告には従わない（詐称シグナルとして escalate に倒す）。
  worker 由来テキストを ctx 側に相乗りさせない。
- `redactSecrets` は**結合後テキストへ1回だけの最終ゲート**（漏れ口を増やさない）。
  新しい注入経路・export 経路は必ずこのゲートを通す。
- 注入総量は `MAX_CONTEXT_CHARS`（16k、ARG_MAX/E2BIG 防御）天井。人間ゾーンを優先で残し、
  残予算を AIゾーンに配分する（切り詰め順を逆転させない）。

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
- 外部送信の解禁は `allowExternalSend` オプトイン時の承認・明示再走のみ（既定 OFF＝緩めは慎重）。
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
  要求される。実行中ジョブあり / working tree dirty / 適用進行中 / 非 production は拒否。
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
- ビルドゲート: server `npx tsc --noEmit` / web `npx tsc --noEmit && npx vite build` /
  smoke `WINNOW_HOME=$(mktemp -d) npx tsx scripts-smoke-feedback.ts`（テストランナー無し）。
