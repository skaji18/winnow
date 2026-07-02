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

## 実行ゲート（`executor.ts`）

- ガードは**決定論（構造シグナル）のみ**。推論でゲートしない
  （cross-repo 兄弟 / 上流未完 / auto 出所検証＝confidence null チェック）。
- 人間の明示ワンタップ（approve / manual execute / handoff への指示つき再走）はゲートを通す（§3.4）。
- 外部送信の解禁は `allowExternalSend` オプトイン時の承認・明示再走のみ（既定 OFF＝緩めは慎重）。
- レビュー leaf: **深さ1固定**（レビューのレビューを作らない）・同一対象の未決レビューは重複生成しない・
  成功時のみ生成・上流未完ゲートの「上流」に数えない。
- 実行の終端は受領（`receivedAt`）。全成功実行は人間が受領するまで取消ハンドルとして可視。

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
