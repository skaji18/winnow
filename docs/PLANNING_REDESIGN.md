# 計画リデザイン — 時間箱から案件/ラダーへ

> 背骨: 判断アテンションの配給。処理量メトリクス（velocity / burndown / 消化率 / 達成% / 完了予測線）は出さない。新画面・新タスク種別・新メトリクスを足さない。可逆（§4-4）。「学ぶために回し、出すために束ねる」（§2.3）。処分=教師信号（§4-1）。「締めるは速く、緩めるは慎重に」（§3.6-3, D1）。

## 背景: なぜ時間箱をやめるか

スプリント（時間箱）は「いつ出すか」を束ねる単位だが、winnow の主役は**判断のアテンション配給**であって処理量の管理ではない。時間箱を計画の主役に据えると、自然と velocity / burndown / 消化率という処理量メトリクスを呼び込み、背骨（§4 アテンション配給・処理量メトリクス禁止）と衝突する。

加えて `scoreItem`（`queue.ts:63-101`）は **sprintId を一切参照していない**。スプリントは既にスコアリングの外にあり、計画の実体は 案件（Project）/ node ツリー（抽象度ラダー §2.2）に移っている。よってスプリントを薄い「現在の focus」タグへ格下げしても移行コストはほぼゼロで、列/テーブルを残せば完全に可逆。

## 確定した2決定と根拠

### 決定1: 案件ゴール表示 — 新フィールドを足さない
既存の役割を明文化して使う。
- `Project.description`（`domain.ts:139`）= **人間が読むゴール/状況**。`buildContextBlock` に**注入されない**（`context.ts:38-44` は `p.context` のみ参照）。
- `Project.context`（`domain.ts:143-144`）= **AI に効く前提**。classify/decompose/promote/execute の4段に注入される。

根拠: 注入の非対称（context.ts が context のみ参照）は既に実装済み。新フィールドを足すと型/SQL/import の往復をすべて拡張する必要があるが、役割分離は**コメントと UI 文言だけ**で達成できる。description を誤って注入経路に足さないことが不変条件。

### 決定2: 締めの穴 — archive 時に未完を disposition で締める
案件を archive する時、その案件の未完（`status != done/rejected`）を **繰越（別案件へ）/ 止める（reject）/ 問いに戻す（send_back）/ そのまま** で締める導線を出す。

根拠: archive で未完を放置すると、処分=教師信号（§4-1）が飛ぶ。reject/send_back は `actions.ts` の正規路（`recordOutcome`/undo に既接続）へ流す。繰越は label を出さない純移動（`updateItem{projectId}`）で較正母数を汚さない。archive 自体は即・可逆（復元あり）を維持し、締め判断だけを人間に1画面で配給する（D1: 締めるは速く）。

## 5本の柱

### B. 計画単位移行
スプリント（時間箱）を薄い「現在の focus」タグへ格下げ。列/テーブルは残し UI 儀式だけ撤去。計画の主役は 案件 / node ツリー。`scoreItem`（`queue.ts:63-101`）は sprintId を見ない=移行コストほぼゼロ・可逆。

### C. 中長期 horizon
Gantt 不採用。**rung × due** の horizon ビュー（`horizon.ts` 新設、read-only）。上段（霧/戦略）ほど due を時間帯バケット/未確定幅でぼかし、下段 leaf のみ鋭い due。完了線/残数/消化率/burndown を出さない。due は子 leaf → 親 node へ巻き上げ（`rollupDue`、`context.ts:46-54` 親チェーン走法の鏡像）。巻き上げ結果は `item.dueDate` に書き戻さず `effectiveDue` として表示層のみに持つ（`scoreItem` の dueBoost 挙動を汚さない）。

### 俯瞰2レンズ
別画面を作らない。既存キューの groupBy トグル（`App.tsx` QueueView 内）。
- ① 案件レーン（projectId、+未所属 Inbox レーン）
- ② horizon（rung×due）

「偏在」は件数でなく滞留で表す:『この案件にエスカレが N件・最長 M日 滞留』（`ageDays` は QueueItem 既存フィールド）。`scoreItem` を client で再実装せず、`state.queue` の配列順（サーバ score 降順）を唯一の真実とする。flat 既定で現行挙動を完全温存（可逆）。

### memory（生きた context）
- `Item.context`（新設、nullable）を俯瞰面でインライン編集可に。node 段の前提を高信頼ルート（ctx 側）で全4段に注入。**body 相乗り不可**（fenceBody の低信頼ラベルと衝突 — `prompts.ts` の「自己申告に従うな」安全規則）。
- `Project.context` を俯瞰面でインライン編集可に。
- `buildContextBlock`（`context.ts:32-73`）経由で classify/decompose/promote/execute 全4段に効く。

### 学び（自動蓄積・オプトアウト）
AI が学びを検知 → memory の「AIゾーン」へ自動追記（人間作業ゼロ、デフォルトで効く）。任意で veto/pin。学びは専用 `learnings` テーブル（label_events と物理分離）に持つ。

## 学びのオプトアウト3ガードレール（人間手間ゼロ）

1. **AIゾーンは tighten-only**: 制約/注意/知識として品質は上げるが、auto 着火範囲を**緩めない**。緩めは較正（本物の人間さばき `recordOutcome`）か人間の memory 編集だけ。`extractLearning` は item の disposition/stakes/reversibility/confidence/executionStatus を一切書き換えず、テキストを足すだけ。executor の構造ゲート（`executor.ts:181-218`）を素通しする入力を持ち込まない。

2. **較正母数を汚さない**: AIゾーンは `recordOutcome` を呼ばない（acceptHandoff `actions.ts:211-216` が雛形 — label を残すが recordOutcome 非呼出）。`learnings` repo は `calibration.ts` を import しない=コンパイル時に非呼出を保証。`category_stats` / `label_events` に1行も書かない。「学び消化率」等のメトリクス化もしない。

3. **区画予算つき自動減衰**: AIゾーンは人間ゾーンと別の char 予算（`aiZoneMaxChars` 既定 16000）で、人間前提を押し出さない（切り詰め順の逆転バグも解消 — 人間ゾーンを先頭・AIゾーンを後段に連結し、人間ゾーンを必ず優先で残す）。未使用の学びは `lastSeenAt` < cutoff で自動減衰（`pruneDecayed`、`learningDecayMs` 既定30日）。pinned は減衰しない。

人間ゾーン（人間が書く / pin）はフル信頼・緩めOK・自動退避なし。`origin`（human/ai）で信頼度を分ける。

## 背骨として死守する線

- **処理量メトリクス禁止**: HorizonCell / 案件レーン見出し / 締めモーダル のどこにも remaining/burndown/percentDone/消化率/完了予測線フィールドを作らない。出すのは滞留（ageDays/M日）と判断対象の列挙のみ。
- **新画面・新タスク種別・新メトリクスを作らない**: 俯瞰2レンズは QueueView 内 groupBy トグル。horizon は `/api/state` 相乗り（新エンドポイントなし）。締めは Projects タブ内ローカルモーダル。Learning は集計対象にしない。`LabelAction` を増やさない。
- **可逆（§4-4）**: スプリント格下げは列温存で復元可。`learnings` は専用テーブル=撤去は `DROP TABLE learnings` で完全に戻る。`effectiveDue` を `item.dueDate` に書き戻さない。archive は status 更新のみ（復元あり）。繰越は projectId 付替のみ（status 不変）。flat 経路を else に温存。
- **redactSecrets の単一最終ゲート**（`context.ts:25-30, 71`）: ゾーンを別変数で組んでも、結合後の bodyText に1回だけ適用（漏れ口を増やさない）。AIゾーン由来テキストも必ずこのゲートを通す。
- **注入の天井**（`context.ts:10-15`、ARG_MAX/E2BIG 防御）: 人間ゾーン + AIゾーンの総量が天井を大きく超えないよう aiZoneMaxChars を 16000 以下に据え、人間ゾーンを必ず優先で残す。
- **scoreItem の純度**（`queue.ts:63-101`）: 処理量項を足さない。sprintId 非参照を維持。dueBoost の境界値・挙動を変えない（定数抽出のみ）。
- **db スキーマの罠回避**（`db.ts:343-349` のコメントが踏んだ罠）: `CREATE TABLE` に列追加するだけでは既存DB（v2）で migrate が再走せず 'no such column'。`CODE_SCHEMA_VERSION` 繰り上げ（2→3）+ 専用 `migrateV2toV3` の両方が必須。

## 実装順序

1. **memory 配管**（`Item.context` 新設 / `learnings` テーブル / db v3 / repo 3点同期 / context.ts ゾーン分割）— 後続の土台。
2. **学び自動蓄積**（`learning.ts` / extractLearning 検知点 / AIゾーン注入 / veto-pin API / 自動減衰）— 柱1 の learnings repo と buildContextBlock 改修に接ぎ木。
3. **horizon サーバ集計**（`horizon.ts` / queue.ts 定数抽出 / `/api/state` 相乗り / types.ts ミラー）— migration 非依存・独立。
4. **俯瞰2レンズ**（App.tsx groupBy トグル: 案件 / 見通し）— 柱3 と groupBy state を共有。
5. **締め**（Projects.tsx archive 締めモーダル / description 配線）— 完全独立、任意の地点に差し込み可。

各柱は独立してビルドが通る粒度でコミット。ゲート: server `npx tsc --noEmit` / web `npx tsc --noEmit && npx vite build`。テストランナー無しのため migration / buildContextBlock / 母数非汚染 は tsx smoke で担保。

## 残課題

- **due 境界のドリフト**: `queue.ts` dueBoost の境界を export 定数化し horizon.ts と single source にするが、client 側でフォールバック純関数 `dueBucket` を使う場合は写経が残る。コメントで `queue.ts:49-56` を相互参照し、将来同期が要る点を明記する。
- **`horizonView()` の応答コスト**: `/api/state` は毎ポーリングで叩かれる。`items.all()` 単純走査 + 親チェーンに留め、件数進捗の重い集計に化けさせない。アイテム数が増えたら巻き上げの memo 化を検討（現状は据え置き）。
- **AIゾーン学びの重複/品質**: `extractLearning` の重複判定は「同 category + 同 text」の素朴一致。意味的重複（言い換え）は溜まりうる。減衰（30日）と区画予算（16000）で自然に薄れる設計だが、pin 過多時の予算圧迫は将来の veto/減衰チューニング課題。
- **スプリント完全撤去のタイミング**: 本リデザインは格下げ（列温存・UI 儀式撤去）に留める。focus タグへの完全移行と Sprints.tsx の最終撤去は、案件/horizon が定着し可逆性が不要と判断できてから別途。
- **learning スキーマのモデル依存**: `prompts.ts` の任意 `learning?` 出力は、モデルが「緩める指示」を書かない前提を文言で縛るが、構造ゲート（executor 181-218）+ learnings の recordOutcome 非呼出の二重担保に依存。モデル更新時に出力傾向を smoke で再確認すること。