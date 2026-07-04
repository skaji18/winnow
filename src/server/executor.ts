import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDriver } from "./ai/index.js";
import { executePrompt } from "./ai/prompts.js";
import { parseJson } from "./ai/tmux-driver.js";
import { PATHS } from "./config.js";
import { buildContextBlock, clip, redactSecrets } from "./context.js";
import { extractLearning } from "./learning.js";
import type { ExecutionJob, Item } from "./domain.js";
import { items, jobs, labels, settings } from "./repo.js";
import { recordOutcome } from "./calibration.js";
import { validateProjectDir } from "./paths.js";
import {
  buildGateSnapshot,
  crossRepoSiblingPending,
  isNeedsHumanProposed,
  uncertainNodeOrUpstreamPending,
  uncertainGateReason,
  isIrreversibleOrHighStakes,
  HIGH_STAKES_THRESHOLD,
  GATE_TEXT_IRREVERSIBLE,
  GATE_TEXT_PAUSE_AUTO,
  GATE_TEXT_CROSS_REPO,
  gateTextBadProjectDir,
} from "./gates.js";
import { classifyJobError } from "./errors.js";

// 実行とトリガー (REQUIREMENTS §3.4). 自動実行は可逆性で段を分ける:
//  可逆な実行 → 自動着火 / 不可逆・高ステークス → 提案して人間ワンタップ承認。
// 自動は全部、安く取り消せる＆痕跡が残る (§4-4)。
// 点火ゲートの述語・閾値・文言は gates.ts が単一真実源 (queue の read 時導出と共有。
// proposed に倒す新ゲートを足すときは gates.ts へ同時登録する)。

interface ExecuteOut {
  status: "succeeded" | "failed" | "needs_human";
  summary: string;
  output: string;
  reviewTask?: string;
  // software 向け任意フィールド (申告なし=undefined=現状不変・後方互換)。
  rollbackPlan?: string; // 変更ファイル一覧＋巻き戻す git コマンド
  artifacts?: string[]; // 外部に生じた成果物の自由文/URL (read-only 痕跡)
  reversible?: boolean; // この実行が安く巻き戻せるか (可逆性自己申告)
  // 任意: 実行中に得た再利用可能な学び (memory AIゾーンへ自動蓄積)。tighten-only。
  learning?: string;
}

/**
 * 引き取り要否の導出 (handoff, §3.5 継ぎ目)。新しい申告軸は立てず、既存 stakes/reversibility と
 * worker 自己申告(out)から「やって終わり(none) / 人間が拾う(required)」を決める従属次元。
 * required 条件(OR):
 *  (a) 外部に観測可能な成果物を作った (artifacts 非空) — PR/送信物/公開物。
 *  (b) 不可逆を自己申告した (reversible===false)。
 *  (c) 高ステークス。※(c) 単独の項目は requestExecution で proposed に倒れ自動着火しないので、
 *      ここに届くのは approve 済み実行が成功したとき=approve 経由限定の従属条件。
 *  (d) 外部送信を人間が許可して実行した software (externalApproved)。artifacts 申告が空でも必ず
 *      引き取りへ: 外部に出したのに痕跡ゼロはむしろ要確認。worker 申告依存の (a) の穴を塞ぐ安全弁。
 * いずれも無く純ローカル・低ステークス・可逆なら none(=やって終わり、done に沈める)。
 * artifacts は worker の出力フィールド(実 git/PR 痕跡そのものではない)なので (a) 単独では詐称に
 * 完全には強くない。(d) で「外部送信を許可した実行」を申告非依存に拾うことで取りこぼしを防ぐ。
 */
function handoffRequired(
  item: Item,
  out: Partial<ExecuteOut>,
  externalApproved = false,
): boolean {
  const hasArtifacts = Array.isArray(out.artifacts) && out.artifacts.length > 0;
  const declaredIrreversible = out.reversible === false;
  const highStakes = (item.stakes ?? 0) > HIGH_STAKES_THRESHOLD;
  const approvedExternal = externalApproved && item.domain === "software";
  return hasArtifacts || declaredIrreversible || highStakes || approvedExternal;
}

/** リーフをどう実行するか決める。可逆なら着火、不可逆/高ステークスなら提案止まり。 */
export async function requestExecution(
  itemId: string,
  instruction = "",
  opts: { manual?: boolean } = {},
): Promise<Item | null> {
  const manual = opts.manual === true;
  const item = items.get(itemId);
  if (!item) return null;
  // 二重着火ガード: classify 時の経路とキューopenの掃き出しが同一itemに発火するのを防ぐ。
  // executionStatus は "none" 既定で null にならない (db.ts DEFAULT 'none')。
  // failed / timed_out のみ再試行を許し、running/proposed/succeeded/approved/cancelled は早期return。
  // 再浮上した failed 項目の再実行 (Batch5 のワンタップ / 起動時 reconcile が failed に倒した
  // 項目) と、work timeout で timed_out に倒した項目の「待たず再実行」はここを通って再着火する
  // (timed_out からの再実行は新しい ipcId のジョブを立て、旧 sentinel は latestExecuteForItem が
  //  最新を返すので誤って当たらない)。
  // 例外: instruction 非空の「この方向で直す」(reExecute) は succeeded / awaiting_handoff の
  //   再走を許す。succeeded は GeneralOutlet(auto-done)、awaiting_handoff は引き取り待ちカード
  //   (PR にレビュー指摘が付いた→直させて再提示、の最頻ループ)から来る。
  //   succeeded 経由は可逆/承認ゲートが後段でそのまま効く。再走前に executionStatus を
  //   none 相当へ戻して runExecution に進めるようにする。
  const wantsRedo = instruction.trim() !== "";
  const redoFromHandoff = wantsRedo && item.executionStatus === "awaiting_handoff";
  const isReExecute =
    wantsRedo && (item.executionStatus === "succeeded" || redoFromHandoff);
  if (
    item.executionStatus &&
    item.executionStatus !== "none" &&
    item.executionStatus !== "failed" &&
    item.executionStatus !== "timed_out" &&
    !isReExecute
  )
    return item;
  if (isReExecute) {
    items.update(itemId, { executionStatus: "none" });
    if (redoFromHandoff) {
      // 引き取り待ちへの指示つき再走は人間の明示一手=承認と同格 (§3.4 人間が明示で押した
      // ものは流す)。handoff 項目は不可逆/高ステークス由来が多く、ゲートを再通過させると
      // 必ず proposed に落ちて指示が失われる(承認しても指示は渡らない)ため、approveExecution
      // と同型に runExecution を直呼びする。外部送信の解禁も承認と同じ意味論:
      // allowExternalSend オプトイン時のみ(手直し→再 push を再拒否ループにしない)。
      return runExecution(itemId, instruction, {
        externalApproved: settings.get().allowExternalSend === true,
      });
    }
  }
  // pauseAuto: 自動経路のみ抑止 (§3.6-3 の手動版)。requestExecution の自動着火経路
  // (キュー掃き出し・classify末尾の即時着火・在庫再適用)は manual 無しで呼ばれ、ここで
  // proposed に倒して痕跡を残す。一方、人間のワンタップ(POST /api/items/:id/execute)は
  // manual:true で呼ばれ、このガードをスキップする(手動アクションを止めない=非対称)。
  // approveExecution は runExecution を直呼びしここを通らない=手動承認の逃げ道も維持。
  if (!manual && settings.get().pauseAuto) {
    return items.update(itemId, {
      executionStatus: "proposed",
      executionResult: GATE_TEXT_PAUSE_AUTO,
    });
  }
  // auto source 検証 (背骨「口はバカ・分類器が賢い」の executor 側の最終ゲート)。
  // 分類器は auto に倒すとき必ず confidence を入れる (classifier.ts normalize/clamp01)。
  // 自動着火経路で disposition==='auto' なのに confidence==null = 分類器/監査を経ていない疑い
  // (人間が PATCH で直接 disposition=auto を書いた等)。分類由来でないと判断し、自動着火せず
  // 安全側に escalate に倒す(分類器経由は必ず confidence を持つので誤爆しない)。
  if (item.disposition === "auto" && item.confidence == null) {
    return items.update(itemId, {
      disposition: "escalate",
      status: "classified",
      executionResult: "auto の出所が分類器でないため安全側にエスカレートしました。",
    });
  }
  if (item.kind !== "leaf") {
    return items.update(itemId, {
      executionResult: "ノードは直接実行できません。先に分解してください。",
    });
  }

  if (isIrreversibleOrHighStakes(item)) {
    // 不可逆/高ステークス: 提案して人間のワンタップ承認待ち (§3.4)。
    return items.update(itemId, {
      executionStatus: "proposed",
      executionResult: GATE_TEXT_IRREVERSIBLE,
    });
  }
  // 構造ゲート用スナップショット (items 全件を1回だけ読む)。
  const snap = buildGateSnapshot(items.all());
  if (uncertainNodeOrUpstreamPending(item, snap)) {
    // 未確定ノード配下/上流未完: 親確定・上流完了を待ってから着火 (最上流の制約を先に見せる)。
    // 保存文言は発動時点の痕跡 — 表示の真実は queue の read 時導出 (gates.deriveProposedGate)。
    return items.update(itemId, {
      executionStatus: "proposed",
      executionResult: uncertainGateReason(item, snap),
    });
  }
  if (crossRepoSiblingPending(item, snap)) {
    // 同一案件で複数repoの自動実行が並んでいる: 横断変更の暴発を防ぎ承認待ちに回す。
    return items.update(itemId, {
      executionStatus: "proposed",
      executionResult: GATE_TEXT_CROSS_REPO,
    });
  }
  // 可逆: 自動着火。
  return runExecution(itemId, instruction);
}

/**
 * ExecuteOut を解釈して item を更新し、必要ならレビュータスクを戻す共通ヘルパ。
 * runExecution の成功パスと起動時 reconcile の done sentinel 取り込みパスの両方から
 * 呼ぶ(挙動一致・重複排除)。Batch4 はこのヘルパ内に新カラム(executionSummary/
 * Output/rollbackPlan/declaredReversible/artifacts)の書き込みを足す前提。
 *
 * blocked語義整理: 失敗(out.status==='failed')は status を blocked にせず in_progress に
 * 保ち、再浮上は executionStatus==='failed' で表す(queue の visible が拾う)。
 */
function applyExecuteResult(
  itemId: string,
  out: Partial<ExecuteOut>,
  opts: { externalApproved?: boolean; approvedRetry?: boolean } = {},
): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  // worker JSON は無検証の Partial (parseJson は形を強制しない)。needs_human で summary/output が
  // 両方欠落すると hasWorkerOutcome が立たず、承認再走の注入・escalate 終端・UI の needs_human
  // 判別が全て不発になり「ゲートは解消済み」の逆信号まで出る。最低限の停止理由を合成して
  // 決定論の判別(isNeedsHumanProposed の連結一致を含む)を成立させる。
  if (out.status === "needs_human" && !(out.summary ?? "").trim() && !(out.output ?? "").trim()) {
    out = { ...out, summary: "AIが人間の判断が必要と申告しました(停止理由の申告なし)。" };
  }
  const succeeded = out.status === "succeeded";
  // 引き取り要否 (§3.5): 成功かつ責任が残る成果物なら done に沈めず awaiting_handoff へ。
  const handoff = succeeded && handoffRequired(item, out, opts.externalApproved === true);
  // 承認後 needs_human の escalate 終端: needs_human 起源の proposed を人間が承認し、前回計画
  // 注入済みの再走がそれでも needs_human を返したら、proposed に戻さず classified に倒す
  // = 承認カードの無限再出現を断ち、承認サイクルあたり worker 実行を最大2回で終端する。
  // approvedRetry は runExecution が発火前の item に isNeedsHumanProposed で判定して渡す
  // (成果の実在だけで判定すると、failed/succeeded の残骸を持つ item がゲート経由で proposed に
  // 落ちた場合の初回承認まで誤って終端する)。ゲート由来 proposed の初回承認の needs_human は
  // 従来どおり proposed に落ちる(承認チャネルは残る)。escalate 後の手動再実行は承認を経ないので
  // needs_human を返せば proposed に戻り承認チャネルが再開通する(袋小路にしない。タップ律速で有界)。
  const repeat = opts.approvedRetry === true && out.status === "needs_human";
  const updated = items.update(itemId, {
    executionStatus:
      out.status === "needs_human"
        ? repeat
          ? "none"
          : "proposed"
        : !succeeded
          ? "failed"
          : handoff
            ? "awaiting_handoff"
            : "succeeded",
    // 成功かつ引き取り要 → done にせず review(引き取り待ち)。やって終わりの成功のみ done。
    // それ以外(needs_human/failed)は in_progress のまま(blocked にしない)。
    // escalate 終端(repeat)のみ classified へ=キューの通常可視ルールで前面に残る。
    status: succeeded ? (handoff ? "review" : "done") : repeat ? "classified" : "in_progress",
    // disposition の書き換えは human 以外(auto/escalate/null)を escalate へ。human だけは保持
    // (人間が reclassify で明示した処分を label 無しで潰さない=人間の処分が勝つ)。null を
    // 素通しすると classified+null がキュー可視ルールのどの段も通らず黙って消える。
    // labels は積まず recordOutcome も呼ばない(worker 自己申告由来の機械遷移を較正母数に
    // 混ぜない — requestExecution の auto 出所不正 flip と同型)。
    ...(repeat && item.disposition !== "human" ? { disposition: "escalate" as const } : {}),
    autoExecuted: true,
    // executionResult は後方互換で連結文字列を維持(UI/キュー一行が参照)。
    executionResult: `${out.summary ?? ""}\n\n${out.output ?? ""}`.trim(),
    // 成果物の分離保持: summary/output を分け、software のみ rollbackPlan を持つ。
    executionSummary: out.summary ?? null,
    executionOutput: out.output ?? null,
    rollbackPlan: item.domain === "software" ? (out.rollbackPlan ?? null) : null,
    declaredReversible: typeof out.reversible === "boolean" ? out.reversible : null,
    // 外部副作用 artifacts は JSON 文字列で read-only 痕跡として保持 (winnow は能動操作しない)。
    artifacts:
      Array.isArray(out.artifacts) && out.artifacts.length ? JSON.stringify(out.artifacts) : null,
  });

  // 学びの自動蓄積 (memory AIゾーン)。tighten-only=item は書き換えない・較正母数に積まない。
  if (updated) extractLearning(updated, out.learning);

  // レビューをパイプラインに戻す (§3.5). 継ぎ目=チェックポイントが実装ポイント。
  // 構造リンク(reviewOfId)+案件継承つきで生成し、決定論ガード3つで暴走を塞ぐ:
  //  (1) 成功時のみ: needs_human は proposed=人間が見る / failed は再浮上する
  //      =レビューすべき成果物が無い(旧実装は失敗時も生成する穴があった)。
  //  (2) 深さ1固定: レビュー leaf 自身の実行からは新レビューを作らない
  //      (「レビュー: レビュー: …」の再帰連鎖の構造的停止)。
  //  (3) 同一対象の未決レビューが居れば新設しない(reExecute 反復での増殖防止)。
  if (
    succeeded &&
    out.reviewTask &&
    out.reviewTask.trim() &&
    item.reviewOfId == null &&
    !items
      .all()
      .some((o) => o.reviewOfId === item.id && o.status !== "done" && o.status !== "rejected")
  ) {
    items.create({
      title: `レビュー: ${out.reviewTask.trim()}`,
      body: `自動実行「${item.title}」の結果レビュー。`,
      kind: "leaf",
      rung: "execution",
      parentId: item.parentId,
      domain: item.domain,
      projectDir: item.projectDir,
      // 案件/スプリントもサブツリーに継承する (decomposer.applyOption と対称)。
      // 継承しないとレビューだけ案件レーンの「未所属(Inbox)」に迷子になる。
      projectId: item.projectId,
      sprintId: item.sprintId,
      reviewOfId: item.id,
    });
  }
  return updated;
}

/**
 * 実際に worker セッションへ投げて実行する。instruction は「この方向で直す」の一行指示(任意)。
 * opts.externalApproved=true は「人間がこのアイテムを明示ワンタップ承認済み=外部送信(push/PR作成)を
 * 実行してよい」を worker に伝える (approveExecution からのみ立つ)。これが無いと worker は外部送信を
 * needs_human で再拒否し続ける(承認しても push されない再拒否ループ)ため、承認の意味論を
 * 「ゲート解除」だけでなく「外部送信ゴーサインの伝達」まで広げる (§3.4 人間が明示で押したものは流す)。
 */
export async function runExecution(
  itemId: string,
  instruction = "",
  // humanApproved=true は「人間が(前回の変更計画を見て)ワンタップ承認した再走」
  // (approveExecution からのみ立つ)。externalApproved と独立: 承認の事実の伝達であって
  // 外部送信の解禁ではない。needs_human 再返答の escalate 終端(applyExecuteResult)の鍵。
  opts: { externalApproved?: boolean; humanApproved?: boolean } = {},
): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;

  // 防御的 projectDir 検証(最終ゲート): headless-driver が req.cwd を無検証 cwd にする穴を、
  // dispatch に渡る前に塞ぐ。不正(相対/機微パス)なら実行せず proposed に倒して人間確認へ。
  if (item.projectDir != null) {
    const v = validateProjectDir(item.projectDir);
    if (v.escalate) {
      return items.update(itemId, {
        executionStatus: "proposed",
        executionResult: gateTextBadProjectDir(v.reason ?? "検証失敗"),
      });
    }
  }

  // レビュー leaf: レビュー対象(reviewOfId 先)の実行結果を材料として組む (§3.5)。
  // 旧実装は材料ゼロ(タイトル文字列のみ)で、general の worker は見るものが無かった。
  // worker 自己申告由来のテキストなので信頼境界は fenceBody(観察対象データ)側に置き
  // (executePrompt がそう注入する)、redactSecrets の最終ゲートもここで通す。
  let reviewMaterial = "";
  if (item.reviewOfId) {
    const src = items.get(item.reviewOfId);
    if (src) {
      const art = (src.artifacts ?? "").trim();
      reviewMaterial = redactSecrets(
        [
          `レビュー対象タスク: ${src.title}`,
          src.executionSummary ? `実行サマリ: ${src.executionSummary}` : "",
          src.executionOutput ? `実行成果物:\n${src.executionOutput}` : "",
          art && art !== "[]" ? `外部成果物(artifacts): ${art}` : "",
          src.rollbackPlan ? `巻き戻し手順(worker申告):\n${src.rollbackPlan}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  }

  // 承認済み再走(approvedRetry)の判定は発火前の item に対して一度だけ行う:
  // isNeedsHumanProposed = needs_human 起源の proposed(成果の実在+連結一致)。成果の実在だけだと
  // failed/succeeded の残骸を持つ item がゲート経由で proposed に落ちた場合まで「前回 needs_human で
  // 停止」と誤注入し、初回承認の needs_human を誤って escalate 終端させる。
  const approvedRetry = opts.humanApproved === true && isNeedsHumanProposed(item);
  // 承認済み再走の差分保証: 前回 needs_human で返した変更計画/成果をプロンプトへ注入し、
  // 初回拒否時と同一プロンプトの再投入(worker が同じ判断で needs_human を繰り返す再拒否ループ)を
  // 構造的に無くす。worker 自己申告由来テキストなので redactSecrets を結合後に1回通し、
  // レビュー leaf の承認再走で reviewMaterial と同時非空になっても合算が暴れないよう
  // clip で先頭 4,000 字に切り詰める(番兵つき=切ったことを worker から見えるようにする)。
  let priorPlan = "";
  if (approvedRetry) {
    priorPlan = clip(
      redactSecrets(
        [
          item.executionSummary ? `前回サマリ: ${item.executionSummary}` : "",
          item.executionOutput ? `前回の変更計画/成果:\n${item.executionOutput}` : "",
          item.rollbackPlan ? `前回申告の巻き戻し手順:\n${item.rollbackPlan}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      4_000,
      "\n…(前回計画はここで切り詰め。全文は項目の実行結果を参照)",
    );
  }

  items.update(itemId, { executionStatus: "running", status: "in_progress" });
  const driver = await ensureDriver();
  // dispatch の req.id を相関IDとして先に確保し、jobs に永続化する。これで起動時
  // reconcile が done sentinel (PATHS.ipc/${ipcId}.done) と res.json を決定論で特定できる。
  const ipcId = randomUUID();
  const job = jobs.create({
    itemId,
    role: "worker",
    kindOfWork: "execute",
    sessionName: null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    output: null,
    error: null,
    ipcId,
    // 外部送信ゴーサインを job に永続化する。timed_out 後の late sentinel 回収
    // (tryTakeInSentinel)でも handoffRequired の安全弁 (d) を発火させるため
    // (旧実装はここで失われ、承認済み外部送信が引き取り待ちを素通りして done に沈み得た)。
    externalApproved: opts.externalApproved === true,
  });

  const res = await driver.dispatch({
    id: ipcId,
    role: "worker",
    label: `実行: ${item.title.slice(0, 30)}`,
    prompt: executePrompt(
      item,
      buildContextBlock(item),
      instruction,
      opts.externalApproved === true,
      reviewMaterial,
      { humanApproved: opts.humanApproved === true, priorPlan },
    ),
    cwd: item.projectDir ?? undefined,
    expectJson: true,
    timeoutMs: settings.get().executeTimeoutMs || 600_000,
  });

  jobs.update(job.id, {
    sessionName: res.sessionName,
    status: res.ok ? "succeeded" : "failed",
    finishedAt: Date.now(),
    output: res.raw,
    // クォータ/レート起因の失敗は "quota: ..." 接頭辞付けで種別を残す。
    error: classifyJobError(res.error),
  });

  if (!res.ok) {
    // blocked語義整理: 実行失敗は status を blocked にせず in_progress に保つ。
    // 可視性は queue の executionStatus フィルタ(failed/timed_out)が担保する。
    //
    // (1) プール枯渇 (acquire timeout / no worker): 実行はそもそもディスパッチされていない。
    //     再試行で解ける一時失敗なので「混雑」と明示して区別する (proposal 5: acquire≠work timeout)。
    if (res.poolBusy) {
      return items.update(itemId, {
        executionStatus: "failed",
        status: "in_progress",
        executionResult: `ワーカー混雑のため実行できませんでした(${res.error ?? "no worker"})。実行そのものの失敗ではありません。空き次第そのままワンタップで再実行してください。`,
      });
    }
    // (2) work timeout: winnow は待つのをやめたが worker セッションは走り続けている可能性。
    //     timed_out に倒して job(ipcId)を残し、late sentinel 回収 (sweepLateExecutions /
    //     reconcileOnBoot) に委ねる。成功した作業を黙って捨てて二重実行させない (§4-4)。
    if (res.timedOut) {
      return items.update(itemId, {
        executionStatus: "timed_out",
        status: "in_progress",
        executionResult: `実行がタイムアウト上限(${settings.get().executeTimeoutMs || 600_000}ms)を超過しました。バックグラウンドで継続中の可能性があり、完了すれば自動で取り込みます。待たずに再実行/却下もできます。`,
      });
    }
    // (3) それ以外 (JSON 解析失敗・dispatch 不可等) は従来どおりの実行失敗。
    return items.update(itemId, {
      executionStatus: "failed",
      status: "in_progress",
      executionResult: `実行失敗: ${res.error ?? "unknown"}`,
    });
  }

  return applyExecuteResult(itemId, res.data as Partial<ExecuteOut>, {
    externalApproved: opts.externalApproved === true,
    // これを落とすと escalate 終端(repeat)が通常経路で一切発火しない。
    approvedRetry,
  });
}

/**
 * WIP/worker 天井のための in-flight 集計。DB から決定論で算出する(状態の二重持ちを
 * 避けるため runtime-state には保持しない)。routes の掃き出しループと /api/state が使う。
 *   running         = 実行中 N
 *   proposed        = 承認待ち M
 *   awaitingHandoff = 引き取り待ち K (§3.5)
 */
export function inFlightCount(): { running: number; proposed: number; awaitingHandoff: number } {
  let running = 0;
  let proposed = 0;
  let awaitingHandoff = 0;
  for (const it of items.all()) {
    if (it.executionStatus === "running") running++;
    else if (it.executionStatus === "proposed") proposed++;
    else if (it.executionStatus === "awaiting_handoff") awaitingHandoff++;
  }
  return { running, proposed, awaitingHandoff };
}

/**
 * done sentinel + res.json があれば取り込み、applyExecuteResult で item を決着させて job も
 * 閉じる(取り込めたら true)。reconcileOnBoot(起動時)と sweepLateExecutions(平常運転中の
 * timed_out 回収)で共有する。AI は起動せず IPC sentinel を read-only に参照するだけ。
 * ipcId 無し / done 未出現 / parse 失敗 は false(呼び出し側がフォールバックを決める)。
 */
function tryTakeInSentinel(job: ExecutionJob): boolean {
  if (!job.ipcId) return false;
  const donePath = path.join(PATHS.ipc, `${job.ipcId}.done`);
  const resPath = path.join(PATHS.ipc, `${job.ipcId}.res.json`);
  if (!fs.existsSync(donePath)) return false;
  try {
    const raw = fs.existsSync(resPath) ? fs.readFileSync(resPath, "utf8") : "";
    const out = parseJson(raw) as Partial<ExecuteOut>;
    // job に永続化した外部送信ゴーサインを復元して渡す(handoffRequired 安全弁 (d) の発火)。
    // 承認済み再走(approvedRetry)は jobs に永続化していないため復元しない → repeat=false →
    // needs_human は従来どおり proposed に戻る(安全側フォールバック。timed_out を跨いだ承認再走の
    // escalate 終端は失われるが、人間が再承認すれば注入つきで再走する=タップ律速で有界。
    // jobs への新列永続化(v4→v5)は実測で頻発したら defer 解除)。
    applyExecuteResult(job.itemId, out, { externalApproved: job.externalApproved === true });
    jobs.update(job.id, {
      status: out.status === "failed" ? "failed" : "succeeded",
      finishedAt: Date.now(),
      output: raw,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 平常運転中の late sentinel 回収 (proposal 2)。work timeout で timed_out に倒した item は
 * worker が後から完了して done sentinel を書きうる。それを起動を待たず取り込む:
 *   - sentinel が現れていれば applyExecuteResult で succeeded/awaiting_handoff/done へ昇格 (recovered)。
 *   - 現れないまま timedOutGraceMs を超過したら failed へ落として再浮上させる (agedOut。中間状態に
 *     永久滞留させない)。
 * /api/state の sweep から背景発火する(AI 非起動の read-only 処理)。手動で再実行された item は
 * executionStatus が timed_out でなくなり自然に対象外(新しい実行の ipcId が別なので
 * 古い sentinel を誤って当てることもない: latestExecuteForItem が常に最新ジョブを返す)。
 * 却下(reject)は status='rejected' のみで executionStatus は timed_out のまま残るため、
 * ここで明示に skip する=人間の処分を sweep が黙って上書きしない(queue 側も rejected を畳む)。
 */
export function sweepLateExecutions(): { recovered: number; agedOut: number } {
  let recovered = 0;
  let agedOut = 0;
  const graceMs = settings.get().timedOutGraceMs || 1_800_000;
  for (const it of items.all()) {
    if (it.executionStatus !== "timed_out") continue;
    // 人間が却下済み: 回収も期限切れ倒しもしない(人間の処分が勝つ)。job は runExecution が
    // 既に failed で閉じている。late sentinel が残っても取り込まない(undo で classified に
    // 戻れば timed_out として再び対象になり、そこで回収される=成果は失われない)。
    if (it.status === "rejected") continue;
    const job = jobs.latestExecuteForItem(it.id);
    if (job && tryTakeInSentinel(job)) {
      recovered++;
      continue;
    }
    // まだ sentinel が無い。timed_out に倒してから graceMs を超えたら failed へ落とす
    // (updatedAt は timed_out をセットした瞬間)。
    if (Date.now() - it.updatedAt > graceMs) {
      items.update(it.id, {
        executionStatus: "failed",
        status: "in_progress",
        executionResult:
          "実行がタイムアウト後も完了を確認できませんでした(猶予超過)。再実行/エスカレ/却下できます。",
      });
      agedOut++;
    }
  }
  return { recovered, agedOut };
}

/**
 * 起動時 reconcile(index.ts が db 初期化直後・listen 前に一度だけ呼ぶ)。
 * 前回プロセスで running のまま中断した execute ジョブを、jobs.ipcId 経由で done
 * sentinel を探して決定論で決着させる:
 *   - done sentinel + res.json があれば取り込み(applyExecuteResult)→ recovered++
 *   - 無い / ipcId=null / parse 失敗 → executionStatus='failed'・status='in_progress'
 *     (blocked にしない)に倒し executionResult に痕跡 → 再浮上経路(queue)が拾う → failedOver++
 * さらに、前回プロセスで timed_out のまま落ちた item も sweepLateExecutions で回収/猶予超過判定する
 * (起動を跨いで完了した worker の成果を取りこぼさない)。
 * AI は一切起動しない(driver.init() を呼ばず、IPC sentinel と DB のみ参照する read-only
 * 痕跡処理)。同期(better-sqlite3 同期API + fs 同期API)。一度きり・冪等
 * (決着済み job は status を running から外すので二度と拾わない)。
 */
export function reconcileOnBoot(): { recovered: number; failedOver: number } {
  let recovered = 0;
  let failedOver = 0;
  const stranded = jobs.runningExecuteJobs();
  for (const job of stranded) {
    const item = items.get(job.itemId);
    // item が無い / 既に running 以外で決着済み / 人間が却下済み なら job だけ決着させて skip
    // (rejected の上書き禁止は sweepLateExecutions と対称)。
    if (!item || item.executionStatus !== "running" || item.status === "rejected") {
      jobs.update(job.id, { status: "failed", finishedAt: Date.now() });
      continue;
    }

    if (tryTakeInSentinel(job)) {
      recovered++;
      continue;
    }

    items.update(job.itemId, {
      executionStatus: "failed",
      status: "in_progress",
      executionResult:
        "前回セッション中に中断(再起動時 reconcile)。再実行/エスカレ/却下できます。",
    });
    jobs.update(job.id, { status: "failed", finishedAt: Date.now() });
    failedOver++;
  }
  // timed_out のまま跨いだ item の回収/猶予判定 (job.status は failed なので上の running 走査に
  // 載らない。共有 sweep で別途決着させる)。回収できた分は recovered に合算する。
  const late = sweepLateExecutions();
  recovered += late.recovered;
  return { recovered, failedOver };
}

/**
 * pauseAuto 解除時の再投入 (routes の設定 PATCH が true→false 遷移で呼ぶ)。
 * pause 中に proposed へ倒れた自動項目(disposition=auto・未実行 leaf)を requestExecution へ
 * 流し直す。全ゲート(pauseAuto/可逆/高ステークス/上流/横断)を通り直すので、元々不可逆ゲートで
 * proposed だった項目は再び proposed に落ちるだけ=安全側・冪等。旧実装は文言が「再開するか、
 * そのままワンタップで実行」と再開での復帰を示唆しながら復帰処理が無く、pause 中に流入した
 * 件数ぶん人間が N 回のワンタップを強いられた。一括承認は作らない(承認は1件ずつの判断=
 * アテンション配給の本体。ここで再投入するのは人間がまだ判断していない自動着火の続きだけ)。
 */
export function resumePausedAuto(): number {
  let resumed = 0;
  for (const it of items.all()) {
    if (
      it.executionStatus === "proposed" &&
      !it.autoExecuted &&
      it.kind === "leaf" &&
      it.disposition === "auto" &&
      it.status !== "rejected"
    ) {
      items.update(it.id, { executionStatus: "none" });
      void requestExecution(it.id).catch(() => {});
      resumed++;
    }
  }
  return resumed;
}

export async function approveExecution(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  if (item.executionStatus !== "proposed") return item;
  // 人間が明示で押した=承認の事実(humanApproved)を必ず worker へ伝える (§3.4)。
  // 外部送信(push/PR作成)の解禁はこれと独立で、settings.allowExternalSend のオプトイン時のみ
  // (既定 OFF=緩めは慎重 §3.6-3)。OFF でも承認再走は「承認済み+前回計画+ローカル可逆作業に限る」
  // 入りの非同一プロンプトになり、needs_human 再返答は applyExecuteResult が escalate 終端する
  // =承認が no-op になる再拒否ループを断つ。
  const externalApproved = settings.get().allowExternalSend === true;
  return runExecution(itemId, "", { externalApproved, humanApproved: true });
}

/**
 * 受領 (receive) の一般化 (§3.5 継ぎ目 / §4-4)。「成功の終端遷移」を一手に担う:
 *  (a) awaiting_handoff: 成果物を人間が確認/採用 → succeeded/done + receivedAt。
 *  (b) autoDone (autoExecuted && succeeded && 未受領): 「確認して畳む」→ receivedAt のみ。
 *      queue の取消ハンドル可視条件 (queue.ts) が receivedAt で畳む。取消(cancel)は
 *      バックログ/ツリーから引き続き可能=可視の場所が変わるだけで手は残る。
 * winnow は採用(マージ/送信)自体は実行しない=人間が外で採用したことの記録＝状態遷移のみ
 * (DECISIONS: winnow は外部副作用を能動的にやらない。PR作成=可逆な提示、マージ=不可逆な採用の非対称)。
 * recordOutcome は呼ばない(受領は分類正誤の信号ではない=較正母数を汚さない)。
 * 該当しない状態は no-op(冪等)。executionResult への文字列追記はしない
 * (summary\n\noutput の後方互換連結を汚さない=表示連結の純度を保つ)。
 */
export async function acceptHandoff(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  if (item.executionStatus === "awaiting_handoff") {
    return items.update(itemId, {
      executionStatus: "succeeded",
      status: "done",
      receivedAt: Date.now(),
    });
  }
  if (item.autoExecuted && item.executionStatus === "succeeded" && item.receivedAt == null) {
    return items.update(itemId, { receivedAt: Date.now() });
  }
  return item;
}

/**
 * 自動実行を安く取り消す (§4-4 fire-and-forgetにしない・可逆&可視)。
 * (1) 巻き戻し手順の提示: worker 自己申告の rollbackPlan があれば人間へ見せる文言にする
 *     (winnow は自動実行しない=人間ワンタップ)。
 * (2) 可逆性過大評価の信号: software auto succeeded を取り消したとき、可逆と自己申告したのに
 *     巻き戻し手順が空(自己申告と実態が乖離)なら『可逆性過大評価』として該当 category へ即締め
 *     (recordOutcome auditBad + audit_bad ラベルの二点セット。actions.ts recordAudit と同型)。
 */
export async function cancelExecution(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  // 冪等: 既に cancelled なら再発火しない (多重 POST /cancel で audit_bad を二重計上しない)。
  if (item.executionStatus === "cancelled") return item;

  // 未実行 proposed の「提案を取り消す」= 実行の取り消しではなく提案の却下。cancelled
  // (実行済みの取り消し専用・undo 不能の終端)に倒さず、reject の正規路(label あり=
  // 『さばきを戻す』で復元可能)へ流す (§4-4 誤タップから安く戻れる)。autoExecuted=true の
  // proposed(needs_human 往復後)も同じ扱い — ただし承認済み再走(humanApproved)は
  // 「ローカルで可逆な作業に限り進める」契約なので、needs_human=副作用完全ゼロとは
  // 限らなくなった。文言は「この提案自体による実行なし+過去の痕跡は履歴に残る」に留める。
  if (item.executionStatus === "proposed") {
    labels.record({
      itemId,
      action: "reject",
      fromDisposition: item.disposition,
      category: item.category,
      note: "提案の取り消し",
    });
    return items.update(itemId, {
      executionStatus: "none",
      status: "rejected",
      executionResult:
        "実行提案を取り消しました(この提案による実行はされていません。過去の実行痕跡があれば履歴に残ります)。",
    });
  }

  // (1) 巻き戻し手順の提示 (自動実行しない=人間ワンタップ)。
  const note = item.rollbackPlan
    ? `取り消されました(痕跡は履歴に残ります)。以下は worker が申告した巻き戻し手順です(自動実行しません。必要なら手動で1タップ実行してください):\n\n${item.rollbackPlan}`
    : "取り消されました(痕跡は履歴に残ります)。副作用は自動では巻き戻されません。";

  // (2) 可逆性過大評価: 可逆と申告したのに巻き戻し手順が空 = 自己申告と実態が乖離。
  // succeeded だけでなく awaiting_handoff(引き取り待ち=外部送信を伴う最も実害の大きいケース)も
  // 対象に含める。これを外すと外部に出した handoff 項目の取り消しで締め学習が抜ける (§3.6-3 締めは速く)。
  const overclaimed =
    item.domain === "software" &&
    item.autoExecuted &&
    (item.executionStatus === "succeeded" || item.executionStatus === "awaiting_handoff") &&
    item.declaredReversible === true &&
    (!item.rollbackPlan || !item.rollbackPlan.trim());
  if (overclaimed && item.category) {
    // 締め方向のみ (§3.6-3 緩めない)。escalate 固定の learned rule を即立てる。
    recordOutcome(item.category, "auto", "escalate", { auditBad: true });
    labels.record({
      itemId,
      action: "audit_bad",
      fromDisposition: "auto",
      toDisposition: "escalate",
      category: item.category,
    });
  }

  return items.update(itemId, {
    executionStatus: "cancelled",
    status: "rejected",
    executionResult: note,
  });
}
