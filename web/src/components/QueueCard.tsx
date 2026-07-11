import { useEffect, useState } from "react";
import { api } from "../api.js";
import {
  ArtifactChips,
  DueBadge,
  PriorityBadge,
  ProjectChip,
  copyText,
} from "./Bits.js";
import { useConfirm } from "./ConfirmDialog.js";
import { Markdown } from "./Markdown.js";
import { Select } from "./Select.js";
import { MiniScores, ScoreBadges } from "./ScoreBadges.js";
import { splitExecutionResult } from "../lib/execution-text.js";
import { buildDonePatch } from "../lib/resolution-patch.js";
import { undoLabelText } from "../lib/undo-label.js";
import { useLive } from "../live.js";
import type { AppState, ContextPreview, Disposition, QueueItem } from "../types.js";
import { DISPOSITION_LABEL } from "../types.js";

export function QueueCard({
  item,
  state,
  learning,
  onChange,
  onDecompose,
}: {
  item: QueueItem;
  state: AppState;
  learning: boolean;
  onChange: () => void;
  onDecompose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // 事前情報(複数行可): レビュー leaf の「前提・観点を添えてレビューさせる」と、承認待ちの
  // 「承認にひとこと添える」が使う。両状態は同時に描画されない(classified と proposed は排他)
  // ため1つで足りる。
  const [preInfo, setPreInfo] = useState("");
  // クリアは「worker に実際に渡った」の観測可能な事実 = executionStatus の running 遷移で行う。
  // タップ直後の .then でクリアすると (a) run() は失敗も握って resolve するため API 失敗
  // (電波断/タイムアウト/403)でも入力が消え、(b) ゲート落ち(proposed)ではサーバが instruction を
  // 破棄するのに入力まで消える。保持しておけば proposed カードの承認 textarea に同じ state が
  // そのまま引き継がれ、承認時に添えて届けられる(ゲート落ちで前提が失われる残穴の実UI側の緩和)。
  useEffect(() => {
    if (item.executionStatus === "running") setPreInfo("");
  }, [item.executionStatus]);
  // 実施の結果・決定(任意・複数行可): 着手中レーンの「完了にする」に相乗りし、下流の兄弟タスクの
  // AI 実行へ前提として渡す (DECISIONS「人間実施の結果の下流受け渡し」)。クリア規則:
  // 成功時はカードが done で畳まれ unmount=クリア不要。失敗/409 時は保持する
  // (run() の CONFLICT 分岐は onChange 再取得のみで入力 state に触れない)。
  const [resolutionDraft, setResolutionDraft] = useState("");
  const live = useLive();
  const confirmDialog = useConfirm();
  // スコープの広い操作(この1件でなく同じ種類すべての今後を変える)の確認。
  // 「要確認に固定」は再浮上カードと承認待ちカードの2箇所から使うため文言を共有する。
  const confirmEscalateCategory = () =>
    confirmDialog({
      title: "この種類を今後すべて要確認に",
      body:
        "この種類のタスクを今後すべて要確認に固定します。たまっている同種も要確認に戻ります。" +
        "このボタンからは取り消せません(解除は設定からのみ)。",
      okLabel: "要確認に固定する",
    });
  // run: 操作後にカードを即消ししない(onChange でサーバの可視集合に委ね、Undo を残す)。
  // 楽観ロック競合(409)は専用文言を aria-live に出して強制再取得する。
  const run = async (fn: () => Promise<unknown>, doneMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      if (doneMsg) live(doneMsg);
      await onChange();
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.startsWith("CONFLICT")) {
        live("他所で更新されました。最新に更新します。");
        await onChange();
      } else {
        live(`操作に失敗しました: ${msg}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const proposed = item.executionStatus === "proposed";
  const failed = item.executionStatus === "failed" || item.status === "blocked";
  // work timeout 超過: 失敗確定ではない(継続中かも)が、待たず再実行/却下できるよう failed と同じ
  // 復旧アクションを出す。バッジ文言だけ分ける。一行理由(surfaceReason)が状況を説明する。
  const timedOut = item.executionStatus === "timed_out";
  // 引き取り待ち (§3.5): 実行完了・人間の受領/採用が必要。done に沈めず前面に出す。
  const handoff = item.executionStatus === "awaiting_handoff";
  // 着手中レーン (queue.ts が lane='in_progress' を計算済み): 自分で引き取って作業中。
  // 完了/手放すをここで直接出し、ボードへ行かなくてもキュー内で閉じられるようにする。
  const inProgress = item.lane === "in_progress";
  // 監査サンプルは通常アイテムと見分けがつかない (§4-3): カード枠に特別扱いを残さない。
  const autoDone = item.autoExecuted && item.executionStatus === "succeeded";
  const autoDoneGeneral = autoDone && item.domain === "general";
  // 承認待ち/引き取り待ちは前面強調を共有(専用CSSは増やさない)。
  const cls = `card${proposed || handoff ? " proposed" : ""}`;

  // general 成果物の summary/output 分離 (分割規則は lib/execution-text.ts)。
  const [splitSummary, splitOutput] = splitExecutionResult(item);

  return (
    // id はカード間ジャンプ(レビュー対象チップ)のアンカー。
    <div className={cls} id={`qc-${item.id}`}>
      <div className="card-head">
        <span className="card-title">{item.title}</span>
        <ScoreBadges item={item} learning={learning} />
      </div>
      <div className="badges" style={{ marginTop: 6 }}>
        <ProjectChip
          projectId={item.projectId}
          projects={state.projects}
          sprints={state.sprints}
          sprintId={item.sprintId}
        />
        <PriorityBadge priority={item.priority} />
        <DueBadge due={item.dueDate} />
        {/* つながりチップ: このカードがレビュー leaf なら、レビュー対象の実体を一語で示す。
            対象カードがキューに見えていればクリックでジャンプ(ハイライトはスクロールで代替)。 */}
        {item.reviewOfId &&
          (() => {
            const src = state.items.find((i) => i.id === item.reviewOfId);
            return (
              <button
                className="badge"
                style={{ cursor: "pointer" }}
                title="レビュー対象のカード/実行結果へ移動"
                onClick={() => {
                  const el = document.getElementById(`qc-${item.reviewOfId}`);
                  el?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              >
                レビュー対象: {src ? src.title.slice(0, 24) : "(削除済み)"} →
              </button>
            );
          })()}
        {/* 依存の待ち先チップ: ゲートで止まっている承認待ちが「何を待っているか」の実体へ
            ジャンプ (reviewOfId チップと同型)。サーバの read 時導出 (queue.ts gateKind/blockerId)
            なので、上流が完了すればチップも自然に消える。 */}
        {item.blockerId &&
          (() => {
            const b = state.items.find((i) => i.id === item.blockerId);
            const label =
              item.gateKind === "parent_unresolved" || item.gateKind === "parent_blocked"
                ? "待ち先(親)"
                : "待ち先";
            return (
              <button
                className="badge"
                style={{ cursor: "pointer" }}
                title="このタスクを塞いでいるカードへ移動"
                onClick={() => {
                  const el = document.getElementById(`qc-${item.blockerId}`);
                  el?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              >
                {label}: {b ? b.title.slice(0, 24) : "(削除済み)"} →
              </button>
            );
          })()}
        {/* 分解の背景ジョブ進捗を静かに前面化する引っぱりナッジ (§3.3, §4)。 */}
        {item.decomposeStatus === "running" && <span className="badge">分解中…</span>}
        {item.decomposeStatus === "ready" && (
          <span className="badge disp-escalate">分解案あり</span>
        )}
      </div>
      {/* キュー一行理由はサーバの surfaceReason を優先(blocked/failed の種別を含む)。 */}
      {(item.surfaceReason || item.reason) && (
        <div className="reason">{item.surfaceReason || item.reason}</div>
      )}
      <MiniScores item={item} />

      {/* 漸進開示: 元の文脈(body)を畳んで見せる。 */}
      {item.body && (
        <details className="exec">
          <summary className="muted">元の文脈を見る</summary>
          <pre>{item.body}</pre>
        </details>
      )}

      {/* 注入の可視化: AIに実際に渡る文脈ブロック (サーバの buildContextBlock と同一経路=
          切り詰め・番兵・redactSecrets 通過後) を畳んで見せる。 */}
      <ContextPreviewDetails itemId={item.id} />

      {/* artifacts / sourceUrl のリンクチップ (read-only 痕跡)。 */}
      <ArtifactChips artifacts={item.artifacts} sourceUrl={item.sourceUrl} />

      {/* 実行結果: general は summary/output を分離表示、それ以外は連結を1ペイン。
          ゲート由来 proposed (gateKind 非null) で worker 成果物が無いものは出さない —
          executionResult はゲート発動時点の一行文言そのもので、live な理由 (surfaceReason)
          との二重表示=陳腐化文言の残置になるため。 */}
      {(item.executionResult || splitOutput) &&
        !(item.gateKind && !item.executionSummary && !item.executionOutput) && (
        <details className="exec">
          <summary className="muted">
            {proposed ? "計画プレビュー(実行されたら何が起きるか)を見る" : "実行結果 / メモを見る"}
          </summary>
          {item.domain === "general" && splitOutput ? (
            <>
              {splitSummary && <pre className="exec-summary">{splitSummary}</pre>}
              {/* output は execute プロンプトで「markdown可」: レンダラーで見やすく。
                  プレーンでも remark-breaks で改行が保たれ <pre> 相当に落ちる。 */}
              <Markdown className="exec-output" text={splitOutput} />
            </>
          ) : (
            <Markdown text={item.executionResult ?? ""} />
          )}
          {/* 取消時の巻き戻し手順 (自動実行しない=人間ワンタップ)。 */}
          {item.rollbackPlan && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              <b>取り消し時の巻き戻し手順(自動実行しません):</b>
              <pre>{item.rollbackPlan}</pre>
            </div>
          )}
        </details>
      )}

      {/* general 成果物の出口: コピー / この指示でやり直す。 */}
      {autoDoneGeneral && (
        <GeneralOutlet item={item} run={run} busy={busy} output={splitOutput || item.executionResult || ""} />
      )}

      {/* 再浮上カード: 実行失敗/タイムアウト超過/保留のワンタップ復旧 (再実行/エスカレ/却下)。 */}
      {(failed || timedOut) && (
        <div className="actions" style={{ marginTop: 10 }}>
          <span className="badge disp-human">{timedOut ? "タイムアウト超過" : "再浮上"}</span>
          <button
            className="primary"
            disabled={busy}
            onClick={() => run(() => api.execute(item.id), "再実行しました")}
          >
            再実行
          </button>
          <button
            disabled={busy}
            title="同じ種類のタスクを今後すべて要確認(エスカレ)に固定。たまっている同種も要確認に戻ります。このボタンからは戻せません(解除は設定から)"
            onClick={async () => {
              if (!(await confirmEscalateCategory())) return;
              run(() => api.escalateCategory(item.id), "この種類を今後すべて要確認にしました");
            }}
          >
            この種類を今後すべて要確認に
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => run(() => api.action(item.id, "reject"), "却下しました")}
          >
            却下
          </button>
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {/* 引き取り待ち: 実行は完了。成果物(PR/リンク等は上の ArtifactChips、詳細は実行結果)を
          人間が確認/採用(マージ等は外で)し、『受け取る』で完了へ。winnow は採用自体は実行しない。 */}
      {handoff && (
        <div className="actions" style={{ marginTop: 10 }}>
          <span className="badge disp-escalate">引き取り待ち</span>
          <button
            className="primary"
            disabled={busy}
            title="成果物を確認した。winnow 上は完了にする(マージ/送信などの採用操作は別途あなたが外で行う)"
            onClick={() => run(() => api.accept(item.id), "確認して完了にしました(採用は外で)")}
          >
            確認して完了（採用は外で）
          </button>
          <button
            className="danger"
            disabled={busy}
            title="成果物を取り消す(痕跡は履歴に残る。巻き戻し手順があれば提示)"
            onClick={() => run(() => api.cancel(item.id), "成果物を取り消しました")}
          >
            取り消す
          </button>
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}
      {/* handoff の手直しループ: PR のレビュー指摘等を一行指示で直させ、再提示させる。
          人間の明示一手=承認と同格でゲートを通す(外部送信の解禁は設定オプトイン時のみ)。 */}
      {handoff && (
        <GeneralOutlet
          item={item}
          run={run}
          busy={busy}
          output={splitOutput || item.executionResult || ""}
          placeholder="直す方向を指示(複数行可。例: レビュー指摘の◯◯を修正して再push)"
        />
      )}

      {/* 着手中: 自分で引き取って作業中。完了/手放すで閉じる(ボード不要の完了導線)。 */}
      {inProgress && (
        <div className="actions" style={{ marginTop: 10 }}>
          <span className="badge">着手中</span>
          <button
            className="primary"
            disabled={busy}
            title="自分で対応し終えた。完了にする"
            onClick={() =>
              run(() => {
                // 非空なら {status:'done', resolution} の単一 PATCH (set 意味論・楽観ロック付き)。
                // 空なら resolution キー自体を送らない=従来の完了経路と一字一句同一 (完全縮退)。
                const p = buildDonePatch(resolutionDraft, item.updatedAt);
                return api.updateItem(item.id, p.patch, p.expectedUpdatedAt);
              }, "完了にしました")
            }
          >
            完了にする
          </button>
          <button
            disabled={busy}
            title="まだやらない。着手を取りやめてキュー(未着手)に戻す"
            onClick={() => run(() => api.updateItem(item.id, { status: "classified" }), "キューに戻しました")}
          >
            手放す（キューに戻す）
          </button>
          {busy && <span className="spinner">実行中…</span>}
          {/* 実施の結果 textarea は「受け取る下流が実在する」ときだけ出す (hasDownstreamSiblings=
              サーバの read 時導出)。親も下流兄弟も無い単独タスクに「下流へ渡る」と約束する
              偽アフォーダンスを出さない。details 折り畳み=レーンの薄さ(寄生表示)を守る。 */}
          {item.hasDownstreamSiblings === true && (
            <details style={{ width: "100%" }}>
              <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                実施の結果・決定（任意）— 下流の兄弟タスクの AI 実行に前提として渡る
              </summary>
              <textarea
                rows={3}
                value={resolutionDraft}
                onChange={(e) => setResolutionDraft(e.target.value)}
                disabled={busy}
                placeholder={
                  "何をどう決めた/やったか(複数行可。例: ベンダAで契約。予算は据え置き)。" +
                  "空なら従来どおりの完了。コミット等のハッシュは伏字化されるため短縮形で"
                }
                aria-label="実施の結果・決定"
                style={{ width: "100%", marginTop: 6 }}
              />
            </details>
          )}
        </div>
      )}

      {!autoDone && !failed && !timedOut && !handoff && !inProgress && (
        <div className="actions" style={{ marginTop: 10 }}>
          {proposed ? (
            item.gateKind === "bad_project_dir" ? (
              // 作業ディレクトリ不正: サーバは承認でも実行しない(runExecution 最終ゲート)。
              // ボタンを消さず disabled+理由で「押しても実行されない」を正直に開示する
              // (タップ手段を奪う変更ではなくサーバ既決挙動の開示 §3.4)。承認→無言バウンスの
              // 原因不明ループをUIで塞ぐ。
              <>
                <span className="badge disp-escalate">承認待ち(要修正)</span>
                <button
                  className="primary"
                  disabled
                  title="作業ディレクトリが不正のため、承認しても実行されません"
                >
                  承認して実行
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  title="この実行提案を取り消す(実行しない)"
                  onClick={() => run(() => api.cancel(item.id), "提案を取り消しました")}
                >
                  提案を取り消す
                </button>
                <div className="muted" style={{ fontSize: 12, width: "100%" }}>
                  作業ディレクトリが不正のため、承認しても実行されません。項目の projectDir
                  を修正してください。
                </div>
              </>
            ) : (
              // 不可逆/高ステークスのゲート由来、または worker の needs_human 由来:
              // ワンタップ承認 (§3.4, §4-4)。needs_human 由来はバッジで判別可能に。
              <>
                <span className="badge disp-escalate">
                  {item.needsHuman ? "AI停止: あなたの判断待ち" : "承認待ち"}
                </span>
                <button
                  className="primary"
                  disabled={busy}
                  title="承認して実行する(下の欄にひとこと書けば添えて渡す。空なら承認のみ)"
                  onClick={() => run(() => api.approve(item.id, preInfo), "承認して実行しました")}
                >
                  承認して実行
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  title="この実行提案を取り消す(実行しない)"
                  onClick={() => run(() => api.cancel(item.id), "提案を取り消しました")}
                >
                  提案を取り消す
                </button>
                {/* 外部送信OFFの事実開示: needs_human の理由が送信以外でもミスリードしないよう
                    原因は断定せず「承認が何を解禁しないか」だけを言う (§4-2 グランス可能に)。 */}
                {item.needsHuman &&
                  item.domain === "software" &&
                  !state.settings.allowExternalSend && (
                    <div className="muted" style={{ fontSize: 12, width: "100%" }}>
                      設定「外部送信(push/PR作成)を承認時に解禁」はOFFです。承認しても外部送信は
                      解禁されません(AIは送信の一歩手前までの作業を進め、必要な外部操作を提示します)。
                      送信まで任せる場合は設定からONにしてください。
                    </div>
                  )}
                {/* 承認への補足(任意・複数行可): needs_human で止まった実行に情報を足して再開する、
                    ゲート由来の承認に方針をひとこと添える、の入口。承認の意味論は変えない。 */}
                <textarea
                  rows={2}
                  value={preInfo}
                  onChange={(e) => setPreInfo(e.target.value)}
                  disabled={busy}
                  placeholder="承認にひとこと添える(任意・複数行可。例: この方針でOK / ◯◯は対象外 / 不足していた情報は…)"
                  aria-label="承認に添える補足"
                  style={{ width: "100%" }}
                />
              </>
            )
          ) : (
            // 通常の処分=ラベル (§4-1). 監査サンプルもここに同じ形で混ざる (§4-3)。
            <>
              {/* 環境不全で自動分類に失敗した escalate (envEscalated): AI にもう一度分類させる
                  ワンタップ復旧。成功すれば classifier が envEscalated を下ろしバッジごと消える。
                  再失敗は成功と紛れないようエラー文言で返す(黙って成功を装わない)。 */}
              {item.envEscalated && (
                <>
                  <span className="badge disp-human">分類失敗</span>
                  <button
                    disabled={busy}
                    title="環境不全で自動分類に失敗しています。環境が直っていれば、AIにもう一度分類させます"
                    onClick={() =>
                      run(async () => {
                        const updated = await api.classify(item.id);
                        if (updated.envEscalated)
                          throw new Error("分類が再び失敗しました。環境を確認してください");
                      }, "AIが分類し直しました")
                    }
                  >
                    AIに分類し直させる
                  </button>
                </>
              )}
              {item.isAudit && <span className="chip-audit muted">確認(自動処理)</span>}
              {/* レビュー leaf: 問題なし=レビューとレビュー対象を束で畳む(1タップ2畳み)。
                  問題ありのときは対象カード側の『実行を取り消す/巻き戻して問いに戻す』で
                  締め方向の教師信号を出す(レビュー専用の信号は作らない)。 */}
              {item.reviewOfId && (
                <button
                  className="primary"
                  disabled={busy}
                  title="レビューして問題なかった。このレビューとレビュー対象の実行結果をまとめて畳む。問題があれば、対象カード側で『実行を取り消す』か『巻き戻して問いに戻す』を"
                  onClick={() =>
                    run(() => api.accept(item.id), "問題なし: レビューと対象を畳みました")
                  }
                >
                  問題なし（束で畳む）
                </button>
              )}
              <button
                className="primary"
                disabled={busy}
                title="自分で引き取って着手する。完了は下の『着手中』レーン(または案件/スプリントのボード)で"
                onClick={() =>
                  run(() => api.action(item.id, "do"), "着手中にしました。完了は『着手中』レーンで")
                }
              >
                自分でやる（着手）
              </button>
              {item.kind === "node" ? (
                <button disabled={busy} onClick={onDecompose}>
                  {item.decomposeStatus === "ready"
                    ? "分解案を見る"
                    : item.decomposeStatus === "running"
                      ? "分解の進捗を見る"
                      : "分解する"}
                </button>
              ) : (
                <>
                  <button
                    disabled={busy}
                    title={
                      item.reviewOfId
                        ? "AI にレビューさせる(下の欄に前提・観点を書けば添えて渡す。空なら丸投げ)"
                        : "AI に実行させる(可逆なら自動着火、不可逆なら承認待ちに)"
                    }
                    onClick={() =>
                      run(
                        () => api.execute(item.id, preInfo),
                        item.reviewOfId ? "AI にレビューを依頼しました" : "AI に実行を依頼しました",
                      )
                    }
                  >
                    {item.reviewOfId ? "AIにレビューさせる" : "AIに実行させる"}
                  </button>
                  {/* これは実行可能タスクではなく『問い』だった、と倒して分解に戻す (§2.1 最頻事故の事後是正)。 */}
                  <button
                    disabled={busy}
                    title="実行可能タスクではなく『問い』だった、と倒して分解に戻す(要件検討へ)。分類器への教師信号になります"
                    onClick={() =>
                      run(() => api.action(item.id, "send_back"), "問いに戻しました（分解できます）")
                    }
                  >
                    問いに戻す
                  </button>
                </>
              )}
              {item.kind === "node" && !item.projectId && (
                <button
                  disabled={busy}
                  title="この問いを案件(入れ物)に格上げし、サブツリーごと紐付ける"
                  onClick={() => run(() => api.toProject(item.id), "案件に昇格しました")}
                >
                  案件に昇格
                </button>
              )}
              <Reclassify itemId={item.id} current={item.disposition} run={run} />
              {/* スコープが広い操作(この1件でなく同じ種類すべての今後を永続的に変える)を視覚分離。 */}
              {item.category && (
                <span className="scope-group" role="group" aria-label="この種類すべてに適用する操作">
                  <span className="scope-sep" aria-hidden="true" />
                  <span className="scope-label">この種類すべてに:</span>
                  <button
                    disabled={busy}
                    title="同じ種類のタスクを今後すべて自動処理にし、在庫もまとめて自動実行します(設定から解除可)"
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: "この種類を今後すべて自動で",
                        body:
                          "この種類のタスクを今後すべて自動処理にします。たまっている同種も自動実行されます。" +
                          "(設定からあとで解除できます)",
                        okLabel: "自動処理にする",
                      });
                      if (!ok) return;
                      run(
                        () => api.action(item.id, "mute_category"),
                        "この種類を今後すべて自動で処理にしました",
                      );
                    }}
                  >
                    今後すべて自動で
                  </button>
                  <button
                    disabled={busy}
                    title="同じ種類のタスクを今後すべて要確認(エスカレ)に固定。たまっている同種も要確認に戻ります。このボタンからは戻せません(解除は設定から)"
                    onClick={async () => {
                      if (!(await confirmEscalateCategory())) return;
                      run(
                        () => api.escalateCategory(item.id),
                        "この種類を今後すべて要確認にしました",
                      );
                    }}
                  >
                    今後すべて要確認に
                  </button>
                </span>
              )}
              <span className="spacer" />
              <button
                className="danger"
                disabled={busy}
                onClick={() => run(() => api.action(item.id, "reject"), "却下しました")}
              >
                却下
              </button>
              {/* レビュー leaf の事前情報 (§3.5): レビュー依頼を読んだ人間が持っている前提・観点を
                  先に与えてから任せる(複数行可)。空のまま『AIにレビューさせる』なら丸投げ。 */}
              {item.kind === "leaf" && item.reviewOfId && (
                <textarea
                  rows={2}
                  value={preInfo}
                  onChange={(e) => setPreInfo(e.target.value)}
                  disabled={busy}
                  placeholder="レビューの前提・観点があれば(複数行可。例: 仕様は◯◯が正 / △△は今回対象外)。空なら丸投げ"
                  aria-label="レビューの前提・観点"
                  style={{ width: "100%" }}
                />
              )}
            </>
          )}
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {/* auto-done: 監査キューに見分けつかない形で混ぜる (§4-3)。autoDone は「やる(着手戻し)」が
          意味的に変なので、監査向けに『取り消す / 分類し直す』に限定する。reclassify→escalate は
          サーバが audit_bad に写像する(actions.ts)。 */}
      {autoDone && (
        <div className="actions" style={{ marginTop: 10 }}>
          {item.isAudit && <span className="chip-audit muted">確認(自動処理)</span>}
          {item.isAudit && (
            <button
              className="primary"
              disabled={busy}
              title="この自動処理は妥当だった、と確認する(分類器への正のフィードバック)。確認した実行はキューから畳まれます"
              onClick={() => run(() => api.audit(item.id, true), "妥当だったと確認し、畳みました")}
            >
              妥当だった（確認OK）
            </button>
          )}
          {/* 成功の終端: 確認して畳む(receive)。監査サンプルは上の『妥当だった』が一手二役で
              畳むので二重に出さない。取消はバックログ/ツリーから引き続き可能。 */}
          {!item.isAudit && (
            <button
              className="primary"
              disabled={busy}
              title="実行結果を確認した。問題ないので畳む(取り消しはバックログ/ツリーからいつでも可能)"
              onClick={() => run(() => api.accept(item.id), "確認して畳みました")}
            >
              確認して畳む
            </button>
          )}
          <button
            className="danger"
            disabled={busy}
            title="この自動実行を取り消す(痕跡は履歴に残る)"
            onClick={() => run(() => api.cancel(item.id), "実行を取り消しました")}
          >
            実行を取り消す
          </button>
          {/* やってみたら要件未確定だった: 巻き戻して問いに戻す(cancel を内包してから node へ降格)。 */}
          <button
            disabled={busy}
            title="やってみたら要件検討が必要だった、と倒す。実行を巻き戻して『問い』に戻し、分解し直せるようにします"
            onClick={() =>
              run(() => api.action(item.id, "send_back"), "巻き戻して問いに戻しました（分解できます）")
            }
          >
            巻き戻して問いに戻す
          </button>
          <Reclassify itemId={item.id} current={item.disposition} run={run} />
          <span className="muted" style={{ fontSize: 12 }}>
            痕跡は履歴に残ります。
          </span>
          {busy && <span className="spinner">実行中…</span>}
        </div>
      )}

      {/* 処分=ラベルの Undo: 直近1手の逆適用。カードを即消ししない前提で控えめに出す。
          ラベルは cancel(実行/成果物の取消)と紛れないよう『さばきを戻す』にする。
          カテゴリ締め(escalateCategory)は専用 action(escalate_category)で UNDOABLE から外して
          いるためここには出ない=締めは戻しにくい(背骨『締めは速く緩めは慎重』)。単件の
          reclassify→escalate(override)は通常どおり戻せる。
          着手中レーンでは『手放す(キューに戻す)』が同じ役割を果たすので、二重に出さない。 */}
      {item.undoableLabel && !inProgress && (
        <div style={{ marginTop: 6 }}>
          <button
            className="undo-inline"
            disabled={busy}
            title="直前のさばき(分類/着手など)を取り消して元に戻す"
            onClick={() => run(() => api.undoLabel(item.id), "直前のさばきを取り消しました")}
          >
            さばきを戻す（{undoLabelText(item.undoableLabel.action)}）
          </button>
        </div>
      )}
    </div>
  );
}

// AIに渡る文脈の遅延プレビュー:
// - open のたびに再 fetch する (read-only なので onChange 経路=AppState には乗せない)。
//   初回 open のみのキャッシュだと「上流兄弟の resolution を書く→下流カードのプレビューで
//   届いたのを見る」の確認ループが成立しない (DECISIONS「人間実施の結果の下流受け渡し」)。
//   再読込中は前回結果を出したままにする (ちらつかせない)。
// - 開いたまま文脈が変わっても自動追随しない=開いた時点のスナップショット (summary 文言で開示)。
// - fetch 失敗は控えめなエラーテキストにし、閉じて開き直せば再試行する。
// - 文字数は切り詰め・伏字化後=実際に注入される長さの数字だけを出す。グラフ/バーは出さない
//   (INVARIANTS: 処理量メトリクス禁止の作法に合わせ、計器化しない)。
function ContextPreviewDetails({ itemId }: { itemId: string }) {
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    api
      .contextPreview(itemId)
      .then(setPreview)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };
  return (
    <details className="exec" onToggle={(e) => e.currentTarget.open && load()}>
      <summary className="muted">AIに渡る文脈を見る（開いた時点のスナップショット）</summary>
      {loading && (
        <div className="muted" style={{ fontSize: 12 }}>
          読み込み中…
        </div>
      )}
      {error && (
        <div className="muted" style={{ fontSize: 12 }}>
          読み込みに失敗しました: {error}
        </div>
      )}
      {preview &&
        (preview.block === "" ? (
          <div className="muted" style={{ fontSize: 12 }}>
            注入される文脈はありません
          </div>
        ) : (
          <>
            <div className="mini-scores">
              <span>
                人間ゾーン <b>{preview.humanZoneChars.toLocaleString("ja-JP")}</b>字 / AIの学び{" "}
                <b>{preview.aiZoneChars.toLocaleString("ja-JP")}</b>字（上限{" "}
                {preview.maxChars.toLocaleString("ja-JP")}字）
              </span>
            </div>
            <pre>{preview.block}</pre>
          </>
        ))}
    </details>
  );
}

// general 成果物の出口 (§3.4): コピー / この方向で直す(指示・複数行可→同じ execute 再走)。
// handoff(引き取り待ち)カードにも流用する: PR にレビュー指摘が付いた→指示を添えて直させる、の
// 最頻ループ (placeholder だけ差し替え)。
function GeneralOutlet({
  item,
  run,
  busy,
  output,
  placeholder,
}: {
  item: QueueItem;
  run: (fn: () => Promise<unknown>, doneMsg?: string) => Promise<void>;
  busy: boolean;
  output: string;
  placeholder?: string;
}) {
  const live = useLive();
  const [instruction, setInstruction] = useState("");
  // クリアは running 遷移で行う(preInfo と同型): run() は失敗も握って resolve するため、
  // タップ直後の .then クリアだと API 失敗時に入力(複数行)が消える。
  useEffect(() => {
    if (item.executionStatus === "running") setInstruction("");
  }, [item.executionStatus]);
  return (
    <div className="actions" style={{ marginTop: 10, flexWrap: "wrap" }}>
      <button
        disabled={!output}
        onClick={async () => {
          // 偽の成功通知を出さない: http 越しのモバイル等では clipboard API が使えない。
          live(
            (await copyText(output))
              ? "成果物をコピーしました"
              : "コピーできませんでした。成果物のテキストを長押しで選択してください",
          );
        }}
      >
        コピー
      </button>
      <textarea
        rows={2}
        placeholder={placeholder ?? "直す方向を指示(複数行可。例: もっと簡潔に / 表形式で)"}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        style={{ flex: 1, minWidth: 180 }}
        aria-label="直す方向を指示"
      />
      <button
        className="primary"
        disabled={busy || !instruction.trim()}
        title="左の指示を踏まえて、同じ実行をやり直す"
        onClick={() =>
          run(() => api.reExecute(item.id, instruction.trim()), "この指示でやり直しました")
        }
      >
        この指示でやり直す
      </button>
    </div>
  );
}

function Reclassify({
  itemId,
  current,
  run,
}: {
  itemId: string;
  current: Disposition | null;
  run: (fn: () => Promise<unknown>, doneMsg?: string) => Promise<void>;
}) {
  // 操作メニュー化: 常に見出し『分類し直す…』を表示し、選んだ段へ覆す(教師信号)。
  // 現在の分類は title に出す(value に束縛して「○○に変更」が現状と一致する誤読を避ける)。
  // value は "" 固定 = 選択後も見出し表示へ戻る (disabled の "" オプションが表示を担う)。
  const cur = current ? DISPOSITION_LABEL[current] : "未分類";
  return (
    <Select
      value=""
      ariaLabel="分類し直す"
      title={`分類し直す(現在: ${cur})。境界線への明示ナッジ=教師信号になります`}
      onChange={(to) => {
        if (!to) return;
        run(
          () => api.action(itemId, "reclassify", to as Disposition),
          `「${DISPOSITION_LABEL[to as Disposition]}」に分類し直しました`,
        );
      }}
      options={[
        { value: "", label: "分類し直す…", disabled: true },
        { value: "auto", label: "自動に変更" },
        { value: "escalate", label: "要確認に変更" },
        { value: "human", label: "要判断に変更" },
      ]}
    />
  );
}
