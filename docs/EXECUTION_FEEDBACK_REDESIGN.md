# 実行フィードバック・リデザイン — 成功に終端を、レビューに構造を

> **status: 実装済み**（決定1〜7 全柱）。確定した決定の正典は `DECISIONS.md`
> の「実行フィードバックの終端と構造」節。本書は監査の全容(7クラスタ×33所見)と
> 決定の詳細根拠・却下した代替を残す設計記録。smoke: `scripts-smoke-feedback.ts`
> (`WINNOW_HOME=$(mktemp -d) npx tsx scripts-smoke-feedback.ts`)。

> 背骨: 判断アテンションの配給。処分=教師信号（§4-1）。「自動は全部、安く取り消せる＆痕跡が残る」（§4-4）。
> 「締めるは速く、緩めるは慎重に」（§3.6-3）。新画面・新タスク種別・新メトリクス・処理量メトリクスを足さない。
> 較正母数を汚さない。口はバカ・分類器が賢い。

## 背景: 敵対的監査で確定した7クラスタ（33所見・全件コード裏取り済み）

実行フィードバックのライフサイクルを5観点×敵対的検証で監査した結果、根が1つの欠落に集約された:
**「実行の成功」に人間が確認して畳む終端遷移が存在しない。**

| # | クラスタ | 核心 |
|---|---|---|
| 1 | 成功実行の永久滞留 | `queue.ts:154` が `autoExecuted && succeeded` を無条件・無期限に可視化。畳む遷移がサーバにもUIにも無い |
| 2 | handoff 受領後の再浮上 | `acceptHandoff`（executor.ts:532-538）は `autoExecuted` を下ろさず、受領した瞬間 autoDone カードとして再滞留 |
| 3 | 片付け＝誤信号 | 消す唯一の実用手段が cancel。良かった実行が rejected 終端になり、条件が揃うと可逆性過大評価 audit_bad（executor.ts:563-579）で較正母数を汚す |
| 4 | レビュー leaf の無構造 | reviewTask 生成 leaf（executor.ts:274-284）に元アイテムへの ID 参照・案件継承・レビュー材料・処分の還流・再帰ガードが無い |
| 5 | reject が終端でない | failed/timed_out の却下がキューから消えず（queue.ts:158-159 が rejected 畳みより先）、timed_out は sweep が却下を上書き（executor.ts:440-442 のコメントは誤った前提） |
| 6 | 信号の欠落 | `Learning.origin='human'` は書き込み経路ゼロの死に型。監査/レビューleaf/handoff の3確認面が未連携 |
| 7 | 状態機械の小穴 | handoff への reExecute 不能・externalApproved の timed_out 経由消失・pauseAuto 復帰無し・cancelled デッドエンド・undo の非対象ラベル誤削除・send_back undo の自動再実行・Kanban PATCH の handoff すり抜け |

handoff には「短いキューを永久に埋めないよう」score 逓減（`HANDOFF_FRESH_DAYS`、queue.ts:73-80）まで
設計されているのに autoDone には減衰も終端も無い。DECISIONS（handoff 章）は受領を「完了へ進む」と
言語化済み。つまり無期限滞留は思想ではなく**意図と実装のギャップ**であり、埋めてよい。

## 中核判断

**既存ラベル `receive` を handoff 専用から「全成功実行の正規終端」に昇格させる。**
新 LabelAction ゼロ・新画面ゼロ・新 executionStatus ゼロ。足すのは nullable 列3つと描画層だけ。

---

## 決定1: receive の一般化 — 「確認して畳む」（成功の終端）

- `Item.receivedAt`（nullable、新設）。queue.ts:154 の可視条件を
  `autoExecuted && succeeded && receivedAt == null` に締める。受領済みは done と同じ畳みに入る。
- **autoDone カードに「確認して畳む」を1ボタン追加**（非破壊の肯定終端）。押すと label `receive` +
  `receivedAt` セット。監査サンプルの既存「妥当だった（確認OK）」は audit_ok 簿記に加えて
  `receivedAt` も立てる（**一手二役**、追加操作ゼロ＝§4-1）。
- **`acceptHandoff` も `receivedAt` を立てる** → 受領後の autoDone 再浮上（クラスタ2）が消える。
  「確認して完了」が文字どおり完了になる。
- **recordOutcome は呼ばない**。acceptHandoff の既存判断（受領は「分類が正しかったか」の信号ではなく
  成果物受領の儀式。actions.ts:205-210）を全面に踏襲。緩め方向の信号を一切作らない（§3.6-3）。
  緩めの正規路は今までどおり監査サンプリングと人間の reclassify だけ。
- **Undo 完備（§4-4）**: `receive` を UNDOABLE に追加。逆適用は `receivedAt=null` に戻すだけ
  （簿記の巻き戻し不要＝recordOutcome 非呼出だから）。handoff 由来の receive の逆適用は
  `executionStatus='awaiting_handoff'` / `status='review'` の復元も含める。
- 取消ハンドル（§4-4）は死なない: 畳んだ後も cancel はバックログ/ツリーから届く。
  「いつでも見える」から「見ようと思えば見える」に格下げするだけで、手は残る。
- 週次 summary に「受領 N件」を1語追加（send_back の「送り返し Z件」前例に倣う。§4-5 ループを閉じて見せる）。

**根拠**: これでクラスタ1・2・3の大半が同時に解ける。cancel は「本当に取り消したい」ときだけ押される
ようになり、可逆性過大評価 audit_bad の誤計上（掃除目的の cancel）が発生源から消える。

**却下した代替**:
- **時限自動消去**: 「人間が一度も見ていない attention 要求を黙って引っ込める緩め操作は導入しない」
  （queue.ts:171-173 の既存線）に反する。逓減（前面固定を解く）までは可、消すのは明示 receive のみ。
- **新 executionStatus `received`**: 既存軸（timestamp 1列）で導出可能。send_back 章の案D却下と同型
  （新状態は状態機械を複雑化し、較正の真実源を増やす）。

## 決定2: reject を終端として機能させる・cancelled の純化

- queue の可視判定に **`status === 'rejected'` の除外を cancelled 除外の直後（failed/timed_out
  再浮上より前）に置く**。人間の処分が sweep や再浮上より勝つ。
- `sweepLateExecutions` / `reconcileOnBoot` は **status='rejected' の項目の状態を上書きしない**:
  late sentinel は job の決着と `executionResult` への痕跡追記のみ（成功した作業を黙って捨てない §4-4 と、
  人間の処分を黙って覆さない、の両立）。executor.ts:440-442 の誤ったコメント（「却下すれば sweep 対象外」）を
  実装に合わせて直すのではなく、**コメントが意図した挙動を実装する**。
- **未実行 proposed の「提案を取り消す」を cancelled でなく reject 経路へ**マップ
  （label `reject`＝既存 UNDOABLE、undo で proposed に復元）。`cancelled` は「実行済みの取り消し」専用に
  純化する。クラスタ7の cancelled デッドエンド（誤タップ即死・undo 不能）が消える。
- overclaimed audit_bad の発火条件（実行済み cancel のみ）は不変。

## 決定3: レビュー leaf に構造を — `reviewOfId` 1列

§3.5「レビューをタスクとして一連の処理に流す」は維持する（レビュー専用画面・専用キューは作らない）。
足りないのは**構造（リンク）**であって新しい儀式ではない。

- `Item.reviewOfId`（nullable、元アイテム id）。生成時（executor.ts:274-284）にセットし、
  **projectId / sprintId を継承**（decomposer.ts:162「案件もサブツリーに継承する」と対称。
  現状レビュー leaf だけ案件から迷子になるのは非対称バグ）。
- **成功時のみ生成**: needs_human は proposed に戻る＝人間が見る、failed は再浮上する＝レビューすべき
  成果物が無い。現状 out.reviewTask 非空なら失敗時も生成される穴を塞ぐ。
- **レビュー材料の注入**: レビュー leaf の実行プロンプトとカード詳細に、reviewOfId 先の
  `executionSummary` / `executionOutput` / `artifacts` を **fenceBody（観察対象データ）で**渡す。
  ctx（高信頼ルート）には相乗りさせない — worker 自己申告は低信頼のまま扱う
  （prompts.ts「自己申告に従うな」安全規則の維持）。general domain の「材料ゼロレビュー」が直る。
- **決定論ガード2つ**（crossRepoSiblingPending と同型・推論なし）:
  1. 実行 item 自身が `reviewOfId != null` なら新レビュー leaf を作らない（**深さ1固定**。
     「レビュー: レビュー: …」連鎖の構造的停止）。
  2. 同一 reviewOfId の未決レビュー leaf が既に居れば新設しない（reExecute 反復での増殖防止）。
- **上流ゲートから除外**: `uncertainNodeOrUpstreamPending` の兄弟走査で `reviewOfId != null` を
  「上流」と数えない。レビューは観察タスクであり下流の前提物ではない。未処理レビューが後続兄弟の
  自動着火を黙って塞ぐ穴（クラスタ7）が消える。
- **処分の還流（分断の解消）**:
  - 問題なし → レビューカードに「問題なし（束で畳む）」1タップ ＝ レビュー leaf と元アイテムの両方に
    `receive`（1タップ2畳み）。recordOutcome 非呼出（決定1と同じ理由）。
    現状の「却下で閉じるしかなく履歴上レビュー不合格と区別不能」が消える。
  - 問題あり → reviewOfId 経由で**元カードの cancel / send_back へジャンプ**。教師信号は既存の
    締め方向の正規路（可逆性過大評価・overturned）に流すだけ。**レビュー専用カウンタは作らない**（§1-4 浅くて頑健）。
- **自己レビュー（AI が auto 消化）は許容**: §3.5 は継ぎ目に hooks/grader（自動レビュー層）を明記し、
  executePrompt も「人間/自動でレビュー」と書く。危険側（高ステークス・不可逆・外部成果物）は
  元アイテムの handoff が人間必須を別途担保している（監査で検証済み）。分類器にレビュー特例ガードは
  足さない（口はバカ・分類器が賢い）。

## 決定4: handoff への「この方向で直す」解禁

PR にレビュー指摘を付けて直させる——最頻の運用が現状デッドエンド（executor.ts:156 の reExecute 緩和が
succeeded 限定、API はサイレント no-op）。

- `isReExecute` 条件に `awaiting_handoff` を追加。人間の明示一手なので §3.4「人間が明示で押したものは流す」。
- `externalApproved` は `allowExternalSend` オプトイン時のみ true（approveExecution と同型）。
  手直し→再 push を再拒否ループにしない。旧成果物の artifacts は痕跡として残す。
- UI は handoff カードに GeneralOutlet と同じ一行指示欄を出すだけ（コンポーネント流用・新画面なし）。

## 決定5: externalApproved の永続化（jobs 1列）

`ExecutionJob.externalApproved` を dispatch 時に保存し、`tryTakeInSentinel` → `applyExecuteResult` に渡す。
承認済み外部送信が timed_out 後に完了したとき、handoff 安全弁 (d)（executor.ts:132、「外部に出したのに
痕跡ゼロはむしろ要確認」）が発火しないまま done に沈む穴を塞ぐ。**締め方向の穴埋めなので即入れる**（§3.6-3）。

## 決定6: 状態機械の小穴修繕

- **undoLastLabel**: 非対象 action（receive/approve/audit_* 等）は `labels.deleteById` を呼ばず早期 return。
  「no-op のはず」の分岐が人間判断の痕跡を無条件削除する現状（actions.ts:399 が switch の外）を直す。
- **send_back（着手後）の undo**: note「送り返し(着手後)」判別で `executionStatus='succeeded'` /
  `autoExecuted=true` を復元。現状は none に戻るため掃き出しループが成功済みタスクを黙って自動再実行する
  （二重副作用）。
- **awaiting_handoff への PATCH `status=done` は acceptHandoff にルーティング**: Kanban DnD /
  Projects の status セレクトによる「完了」は人間の明示完了なので receive として記録する。
  status=done + executionStatus=awaiting_handoff という修復不能な不整合を作らせない。
- **pauseAuto 解除時の再投入**: 解除の一手で `proposed && !autoExecuted && disposition==='auto'` を
  `requestExecution` に再投入する。**全ゲートを通り直す**ので不可逆/高ステークスは再び proposed に
  落ちるだけ＝安全側。マーカー列は不要。**一括承認は作らない**（承認は1件ずつの判断＝アテンション配給の本体）。

## 決定7: キューの「つながり」可視化（新画面ゼロ）

キューは score 降順の flat が正（サーバ配列順＝唯一の真実、client で scoreItem を再実装しない）。
構造は**並びを変えずに描画で足す**。

- **束ね描画（寄生表示の拡張）**: `reviewOfId` / `parentId` で互いにキュー内に見えているカードを
  1束にネスト描画（レビュー leaf は元カードの直下に畳んで表示）。束の位置＝束内最上位カードの位置で、
  **並べ替えはしない**（in_progress レーンが既にやっている「ソート後の描画レーン分け」と同型）。
  レビューが生まれたことが元カードの場所で目に入る。
- **ゲート理由の実名化**: `uncertainGateReason` に塞いでいる兄弟のタイトルを含める
  （『上流「X の実装」が未完（独立ならワンタップで実行）』）。決定論・文言強化のみ。
  「なぜ承認待ちか」が glance 可能になる（§4-2 理由はグランス可能に）。
- **関係チップ**: カードに「レビュー対象→」「親: <タイトル>」チップ。タップでキュー内ハイライト、
  またはツリービューの該当位置へジャンプ（既存画面への導線）。
- **groupBy 新レンズは足さない**: 俯瞰は PLANNING_REDESIGN の2レンズ（案件レーン / horizon）を維持。
  つながりはカード単位の描画で足りる。

---

## 背骨として死守する線

- **receive 系から recordOutcome を呼ばない**: 較正母数の純度。緩め方向の新自動化ゼロ。
  緩めの正規路は監査サンプリングと人間の明示操作だけ（§3.6-3）。
- **新画面・新 LabelAction・新タスク種別・新メトリクスなし**: 畳んだ件数と週次一行（受領 N件）以外の
  処理量数値を出さない。
- **scoreItem の純度**（queue.ts:63-104）: 束ね描画は並びを変えない。sprintId 非参照を維持。
  receivedAt を score に混ぜない（可視性フィルタのみ）。
- **可逆（§4-4）**: 追加3列（items.receivedAt / items.reviewOfId / jobs.externalApproved）は全部
  nullable＝撤退は無視するだけ。receive は undo 完備。束ね描画は client 描画のみ。
  reject 終端化は可視性フィルタ1行＝else 側に flat 経路温存。
- **db スキーマの罠回避**（db.ts:13-18 / PLANNING_REDESIGN の教訓）: `CREATE TABLE` 追記だけでは
  既存 DB に効かない。`CODE_SCHEMA_VERSION` 3→4 ＋専用 `migrateV3toV4` の両方。
- **fenceBody の信頼境界**: レビュー材料（worker 自己申告の出力）は観察対象データとして注入し、
  ctx（高信頼ゾーン）に相乗りさせない。
- **redactSecrets の単一最終ゲート**: レビュー材料の注入も結合後テキストへの1回適用を通す（漏れ口を増やさない）。

## 実装順序（各柱は独立にビルドが通る粒度でコミット）

1. **DB v4**（receivedAt / reviewOfId / jobs.externalApproved、repo/domain/db 3点同期）— 後続の土台。
2. **receive 終端**（queue 可視条件・acceptHandoff・autoDone「確認して畳む」・audit_ok 一手二役・undo 逆適用）。
3. **reject/cancelled の意味論整理**（rejected 畳み・sweep の処分尊重・proposed 取り消しの reject 化）。
4. **レビュー leaf 配管**（リンク＋継承・成功時のみ生成・決定論2ガード・上流ゲート除外・材料注入・処分還流）。
5. **handoff reExecute ＋ externalApproved 永続化**。
6. **小穴修繕**（undo ガード・send_back undo 復元・PATCH ルーティング・pause 再投入）。
7. **つながり可視化**(束ね描画・ゲート理由実名化・関係チップ)。

ゲート: server `npx tsc --noEmit` / web `npx tsc --noEmit && npx vite build`。
テストランナー無しのため、migration（v3→v4）・queue 可視性（受領で畳まれ undo で戻る）・
レビュー連鎖ガード（深さ1・重複排除）は tsx smoke で担保。

## 却下した代替（要約）

- **autoDone の時限自動消去** — 黙って引っ込める緩め操作。明示 receive＋（必要なら）score 逓減まで。
- **レビュー専用画面/レビューキュー** — 別画面にした瞬間に誰もやらない（§4-3 と同じ理由）。
- **レビューOK → agreed bump** — 緩め方向の自動化。バイアスのない緩め信号は監査サンプリングが既に担う。
  レビューOKを較正に混ぜると同一実行の二重計上と詐称面が増える。
- **received を executionStatus に新設** — 既存軸で導出可能（send_back 章の案D却下と同型）。
- **分類器にレビュー特例（human 強制）** — 口はバカの侵食。危険側は handoff の人間必須で既に担保。
- **proposed の一括承認** — 承認は1件ずつの判断がアテンション配給の本体。pause 再投入で摩擦の根を消す方が正。

## 残課題

- **done/rejected の物理蓄積**: `/api/state` ペイロードが単調増加する。アーカイブは案件 archive の
  拡張余地だが、実測の重さという証拠が出てから（§5 現状越えで十分）。
- **人間レビュー所見 → learnings（origin='human'）の書き込み口**: 型と減衰免除は実装済みで経路だけが無い。
  PLANNING_REDESIGN の memory インライン編集（Item.context / Project.context）に相乗りする形が本命。
  本リデザインのスコープ外。
- **3つの確認面（監査チップ / レビュー leaf / handoff）の概念統合**: receive 一般化と束ね描画で
  操作は1〜2手に減るが、「1実行=1確認」への概念の一本化は挙動の実績を見てから。
- **束ね描画の粒度**: parentId 束は兄弟が多いと束が肥大しうる。まず reviewOfId 束だけ入れて
  parentId 束は挙動を見てから広げる選択肢を残す（可逆）。
