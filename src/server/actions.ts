import { applyRulesToInventory, recordOutcome } from "./calibration.js";
import { rollAudit } from "./classifier.js";
import type { Disposition, Item, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import * as executor from "./executor.js";
import { isEscalateTerminated } from "./gates.js";
import { UNDOABLE } from "./queue.js";
import { categoryStats, items, labels, rules } from "./repo.js";
import { confBinOf } from "./text.js";

/**
 * ルール変更後にその category の classified 在庫へ applyRulesAndCalibration を即再適用し
 * (AI往復ゼロ)、新たに auto leaf になった項目を着火する。循環 import 回避のため着火は
 * calibration でなくここ(呼び出し側)で行う。
 */
function reapplyAndIgnite(category: string): void {
  const { ignite } = applyRulesToInventory(category);
  for (const id of ignite) {
    void executor.requestExecution(id).catch(() => {});
  }
}

// 処分=ラベル (REQUIREMENTS §4-1). 各項目の操作はそのまま教師信号になる。
// 「やる / 下段へ降ろす / 分類し直す / この種類はもう上げるな」。追加労力ゼロ。

// doIt の note 決定論マーカー (INVARIANTS 状態機械とUndo: 逆適用が状態依存で分かれる場合は
// note で分岐)。AI停止(escalate 終端)項目の「やる」は agreed を積まないため、undo 側も
// このマーカーを見て unbump をスキップする(積んでいない bump の巻き戻しで母数を歪めない)。
const DO_NOTE_AI_STOPPED = "AI停止の引き取り";

/** やる: 人間が引き取って着手。AIの仕分けを是認したことになる。 */
export function doIt(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  // AI停止(承認後 needs_human の escalate 終端)の引き取り: これは分類の是認ではなく
  // 「AIが止めた作業を人間が引き取る」一手。rawDisposition が auto のまま残るため下の
  // recordOutcome に流すと agreed(auto) が積まれ、自律完遂に失敗したばかりの項目で
  // 較正を緩め方向に汚す — 簿記を丸ごとスキップする(監査分岐も disposition が escalate に
  // 倒れているため通らない=audit の簿記も発生しない)。
  const aiStopped = isEscalateTerminated(item);
  labels.record({
    itemId,
    action: "do",
    fromDisposition: item.disposition,
    toDisposition: "human",
    category: item.category,
    note: aiStopped ? DO_NOTE_AI_STOPPED : undefined,
  });
  if (aiStopped) {
    // 監査サンプルが armed のまま(取り消し→undo で disposition=auto に復元された場合等)なら
    // 旗だけ下ろす: audit_ok を簿記すると「自律完遂に失敗した実行」を是認として積む汚染、
    // 放置すると isAudit チップが永久に残り監査サンプルが未決のまま失われる。
    // 人間は現に確認している=旗は畳む・較正には数えない。
    return items.update(itemId, {
      status: "in_progress",
      ...(item.auditSampled ? { auditSampled: false } : {}),
    });
  }
  // 監査サンプルの auto を「やる」=自動処理を是認 → audit_ok の教師信号 (§4-3 見分けつかない混入).
  // recordAudit が audit_ok の簿記(bump+label)を一手に出すので、ここで recordOutcome を二重に呼ばない。
  if (item.auditSampled && item.disposition === "auto") {
    return items.update(itemId, { status: "in_progress", ...recordAudit(item, true) });
  }
  // 是認=agreed。aiDisposition は「生提案」(rawDisposition、null時は disposition にフォールバック)。
  // confBin も生 confidence(rawConfidence ?? confidence)から算出して較正母数の汚染を避ける。
  // env-escalated(生提案なし)は較正母数に積まない: rawDisp を null に潰して下の if でスキップ。
  const rawDisp = item.envEscalated ? null : (item.rawDisposition ?? item.disposition);
  if (rawDisp) {
    recordOutcome(item.category, rawDisp, rawDisp, {
      confBin: confBinOf(item.rawConfidence ?? item.confidence),
    });
  }
  return items.update(itemId, { status: "in_progress" });
}

/** 下段へ降ろす: 抽象度を一段下げる (§2.2 量は下段へ流す)。 */
export function demote(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  const idx = RUNGS.indexOf(item.rung);
  const next: Rung = RUNGS[Math.min(idx + 1, RUNGS.length - 1)]!;
  labels.record({ itemId, action: "demote", category: item.category });
  return items.update(itemId, { rung: next });
}

/**
 * 問いに戻す (send_back): AIが auto/leaf と賭けた項目を、人間が「これは要件検討が要る問いだ」と
 * 倒して node へ降格し再分解の俎上に戻す。disposition軸の reclassify に対称な kind軸のリカバリで、
 * §2.1 の最頻事故(方向性未確定ノードを実行に流す)の事後是正。締め方向(安全側)なので安く速く打てる。
 *
 * revive-as-node: kind=node(executor の kind!=='leaf' 門番で自動着火が止まる) +
 * disposition=escalate(kind=node だけだと queue が auto を畳んで不可視になるため、可視化と
 * 二重の着火停止を兼ねて escalate へ倒す) + executionStatus=none + status=classified +
 * uncertaintyResolved=false(将来の子の点火ゲートを締める)。node 化で UI の「分解する」が出る。
 *
 * 着手後(succeeded/awaiting_handoff)は先に cancelExecution(巻き戻し手順の提示 §4-4 +
 * 可逆性過大評価の即締め)を通してから revive する。reExecute 中(running)は対象外=defer。
 *
 * 教師信号(§3.6): 「auto に流したが実は要件未確定」は過小エスカレーションの遅発現。ただし着手前は
 * 実害が出る前の取りこぼしなので auditBad:false で即締めせず overturned(Wilson 母数)に積むだけ。
 * disposition が auto→escalate と動くときだけ記録する(kind誤りを disposition軸の agreed に
 * 誤記録して母数を汚さない)。ループ防止: 同一 item の2回目以降の send_back は母数に積まない。
 */
export async function sendBack(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  // 実行中(running)は対象外。fail/timeout/完了を待つ(running 割り込み UI は defer §5)。
  if (item.executionStatus === "running") return item;

  const from = item.disposition;
  // 実行後(成功/引き取り待ち)は先に cancel を通す(巻き戻し提示 + 可逆性過大評価の締め)。
  // cancel は status=rejected/executionStatus=cancelled に倒すが、後段の revive が上書きで戻す。
  if (item.executionStatus === "succeeded" || item.executionStatus === "awaiting_handoff") {
    await executor.cancelExecution(itemId);
  }

  // ループ防止: 既に send_back 済みなら母数に積まない(重複計上防止)。label は毎回残す。
  const firstSendBack = !labels.forItem(itemId).some((e) => e.action === "send_back");
  labels.record({
    itemId,
    action: "send_back",
    fromDisposition: from,
    toDisposition: "escalate",
    category: item.category,
    note: item.autoExecuted ? "送り返し(着手後)" : "送り返し(着手前)",
  });
  // 教師信号は disposition が auto→escalate と動くときだけ。env-escalated は母数に積まない。
  if (firstSendBack && from === "auto") {
    const rawDisp = item.envEscalated ? null : (item.rawDisposition ?? "auto");
    if (rawDisp) {
      recordOutcome(item.category, rawDisp, "escalate", {
        confBin: confBinOf(item.rawConfidence ?? item.confidence),
      });
    }
  }

  return items.update(itemId, {
    kind: "node",
    disposition: "escalate",
    status: "classified",
    executionStatus: "none",
    autoExecuted: false,
    uncertaintyResolved: false,
    humanOverrode: from !== "escalate",
    reason: "要件検討のため問いに戻しました（分解してください）",
  });
}

/** 分類し直す: 人間が disposition を覆す。境界線への明示ナッジ＝教師信号。 */
export function reclassify(itemId: string, to: Disposition): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  const from = item.disposition;

  // 監査サンプルの auto を非auto へ覆す = 監査が過小エスカレーションを捕まえた (§3.6-3, §4-3).
  // recordAudit(false, to) が audit_bad の簿記(即締め learned rule + 覆し)を一手に出す。
  // ここで reclassify/override の label_event や recordOutcome を別途出すと二重記録になるので出さない。
  if (item.auditSampled && from === "auto" && to !== "auto") {
    return items.update(itemId, recordAudit(item, false, to));
  }

  labels.record({
    itemId,
    action: from === to ? "reclassify" : "override",
    fromDisposition: from,
    toDisposition: to,
    category: item.category,
  });
  // 覆しは「生提案 vs 人間最終」で判定する (rawDisposition、null時は from にフォールバック)。
  // tightness が auto→escalate に締めた項目を人間が auto に戻したケースは、生提案 auto が
  // 正しかった証拠なので overturnedToAuto に積まれるべき。confBin も生 confidence から算出。
  // env-escalated(生提案なし)は較正母数に積まない: rawDisp を null に潰して recordOutcome を呼ばない。
  const rawDisp = item.envEscalated ? null : (item.rawDisposition ?? from);
  if (rawDisp) {
    recordOutcome(item.category, rawDisp, to, {
      confBin: confBinOf(item.rawConfidence ?? item.confidence),
    });
  }
  // auto へ倒し込んだら監査対象に入れ直す (§4-3). auto→auto 再是認は既存フラグを保ち二重計上を避ける。
  const intoAuto = to === "auto" && from !== "auto";
  const patch: Partial<Item> = { disposition: to, humanOverrode: from !== to };
  if (intoAuto) patch.auditSampled = rollAudit("auto", { category: item.category });
  return items.update(itemId, patch);
}

/** この種類はもう上げるな: カテゴリを自動に倒す明示ルール (§4-1, §3.6-1)。 */
export function muteCategory(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item || !item.category) return item ?? null;
  rules.upsert({
    category: item.category,
    forcedDisposition: "auto",
    source: "manual",
    note: "この種類はもう上げるな(手動)",
  });
  labels.record({
    itemId,
    action: "mute_category",
    fromDisposition: item.disposition,
    toDisposition: "auto",
    category: item.category,
  });
  // カテゴリを auto に強制 → この項目も監査対象に入れ直す (§4-3).
  // 既に auto で監査サンプル済みならフラグを保ち二重計上を避ける。
  const auditSampled =
    item.disposition === "auto" && item.auditSampled
      ? true
      : rollAudit("auto", { category: item.category });
  const updated = items.update(itemId, { disposition: "auto", auditSampled });
  // ルール変更の在庫即再適用 (AI往復ゼロ): 同カテゴリの classified 在庫を即 auto へ倒し着火。
  reapplyAndIgnite(item.category);
  return updated;
}

export function reject(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  labels.record({ itemId, action: "reject", fromDisposition: item.disposition, category: item.category });
  return items.update(itemId, { status: "rejected" });
}

export async function approve(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  labels.record({ itemId, action: "approve", category: item.category });
  return executor.approveExecution(itemId);
}

/**
 * 受領 (receive) — 成功の終端 (§3.5 継ぎ目 / §4-4)。handoff の受領と autoDone の
 * 「確認して畳む」を同じ一手にする。人間が成果物に責任を引き取った/確認した痕跡を
 * label_event に残す(receive)。採用(マージ/送信)自体は winnow がやらない=人間が外で行う。
 * 較正母数(recordOutcome)には積まない: 受領は「分類が正しかったか」の信号ではなく
 * 「成果物を受領したか」の儀式/レビューだから(過剰計上を避ける)。緩め信号も作らない(§3.6-3)。
 * note は Undo の逆適用先の判別に使う(send_back の着手前/後と同じ決定論マーカー方式)。
 */
export async function acceptHandoff(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  // レビュー leaf の「問題なし(束で畳む)」: レビューを受領で閉じ、元アイテムも束で受領する
  // (1タップ2畳み — 受領とレビュー処分の二重操作を要求しない)。どちらも recordOutcome 非呼出。
  // 「問題あり」の側はここを通らず、元カードの cancel/send_back(既存の締め方向の教師信号)へ
  // 流す=レビュー専用カウンタを作らない (§1-4 浅くて頑健)。
  if (item.reviewOfId) {
    labels.record({
      itemId,
      action: "receive",
      category: item.category,
      note: "レビュー完了(問題なし)",
    });
    const updated = items.update(itemId, { status: "done", receivedAt: Date.now() });
    const src = items.get(item.reviewOfId);
    if (
      src &&
      (src.executionStatus === "awaiting_handoff" ||
        (src.autoExecuted && src.executionStatus === "succeeded" && src.receivedAt == null))
    ) {
      // 元アイテム側の受領も通常の receive として記録する(束の undo は item ごと=直近1手ずつ)。
      await acceptHandoff(src.id);
    }
    return updated;
  }
  labels.record({
    itemId,
    action: "receive",
    category: item.category,
    note: item.executionStatus === "awaiting_handoff" ? "受領(引き取り)" : "確認して畳む",
  });
  return executor.acceptHandoff(itemId);
}

/**
 * 監査の教師信号を記録する共通簿記 (§3.6-2, §4-3).
 * auditConfirm と、通常処分アクション由来の監査確定(doIt/reclassify)が同一の
 * label_event + recordOutcome を出すよう一本化する。二重記録を防ぐ唯一の経路。
 * 返すのは「items.update に重ねるべき追加パッチ」。呼び出し側で他の更新と合成する。
 *  ok=true : 自動は妥当だった (audit_ok). auditSampled を下ろすだけ。
 *  ok=false: 過小エスカレーション検出 (audit_bad). 即締め(learned rule)+escalate へ覆す。
 * to は ok=false 時の覆し先。標準の /api/audit は escalate、通常アクション由来は人間の選んだ段。
 */
function recordAudit(item: Item, ok: boolean, to: Disposition = "escalate"): Partial<Item> {
  // 監査対象は「最終 auto に流れた」もの=生提案も auto のはず。confBin は生 confidence から。
  const confBin = confBinOf(item.rawConfidence ?? item.confidence);
  if (ok) {
    labels.record({ itemId: item.id, action: "audit_ok", fromDisposition: "auto", category: item.category });
    recordOutcome(item.category, "auto", "auto", { confBin });
    // 一手二役: 実行済み監査サンプルの「妥当だった」は監査簿記 + 受領(畳み)を同時に出す。
    // 別々に2タップさせない(§4-1 追加労力ゼロ)。未実行の監査サンプル(classified 段の確認)は
    // 受領の対象ではないので receivedAt を立てない。
    if (item.executionStatus === "succeeded") {
      return { auditSampled: false, receivedAt: Date.now() };
    }
    return { auditSampled: false };
  }
  labels.record({
    itemId: item.id,
    action: "audit_bad",
    fromDisposition: "auto",
    toDisposition: to,
    category: item.category,
  });
  recordOutcome(item.category, "auto", to, { auditBad: true, confBin });
  return { auditSampled: false, disposition: to, humanOverrode: true };
}

/**
 * 「tightness が締めた escalate」(rawDisposition='auto' かつ最終 disposition='escalate')の監査。
 * audit_ok のときは recordOutcome(category,'auto','auto') で agreed(auto) を簿記するだけ。
 * これは learned auto tip(overturnedToAuto)には寄与しない=緩め方向の自動化はしない(緩めは
 * 慎重・非対称)。overturnedToAuto は aiDisposition='escalate' && humanFinal='auto' のときだけ積まれ、
 * learned auto tip はその escalate バケットの overturnedToAuto を母数にする。agreed(auto) は別物で、
 * calibrateRequiredConf の auto バケット overturn 率分母を増やし締め下駄を弱める副次効果に留まる。
 * カードは既存「確認(自動処理)」チップと見分け不能 (queue.ts の isAudit が rawDisposition を含む)。
 * 返すのは items.update に重ねる追加パッチ。
 */
function recordTightenedEscalateAudit(item: Item, ok: boolean): Partial<Item> {
  const confBin = confBinOf(item.rawConfidence ?? item.confidence);
  if (ok) {
    labels.record({
      itemId: item.id,
      action: "audit_ok",
      fromDisposition: "escalate",
      toDisposition: "auto",
      category: item.category,
    });
    // 生提案 auto は妥当だった=緩め証拠。簿記のみ(Wilson 下限+probation が過度な緩めを抑える)。
    recordOutcome(item.category, "auto", "auto", { confBin });
    return { auditSampled: false };
  }
  // tightness の締めが正しかった=締め維持。簿記だけ(escalate を是認、覆し無し)。
  labels.record({
    itemId: item.id,
    action: "audit_bad",
    fromDisposition: "escalate",
    category: item.category,
  });
  return { auditSampled: false };
}

/** 締めた escalate の監査確認 (standalone)。doIt/reclassify とは別経路で簿記だけ積む。 */
export function auditTightenedEscalate(itemId: string, ok: boolean): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  return items.update(itemId, recordTightenedEscalateAudit(item, ok));
}

/**
 * 監査の確認 (§3.6-2, §4-3). 自動処理が妥当だったか/誤りだったか。
 * 過小エスカレーション(自動の誤り)は高く遅れて危険に出るので、見つけたら即締める。
 * standalone な /api/audit 用に残置。UI からは通常処分アクションが同じ信号を出すので不要。
 */
export function auditConfirm(itemId: string, ok: boolean): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  return items.update(itemId, recordAudit(item, ok));
}

/**
 * 処分=ラベルの Undo (§4-4 安く取り消せる)。直近1件の label_event を逆適用する。
 * 操作直後にカードを即消ししない前提で、人間が「取り消し」を1タップしたときに直近の一手を戻す。
 * 整合性 (calibration の簿記巻き戻し) はサーバ責務 (UI は undoableLabel の有無だけ見る)。
 *
 * 逆適用の内容:
 *  - disposition を fromDisposition に復元 (記録されていれば)。
 *  - status を「さばき前」へ: do/reject は classified に戻す (do は in_progress、reject は rejected を解く)。
 *  - mute_category はそのカテゴリの最新 active rule を deactivate (即締めの対称=緩めも1手だけ戻せる)。
 *  - recordOutcome が積んだ category_stats の bump を unbump で 1 戻す (教師信号を歪めない)。
 *  - 最後にその label_event を削除する (週次集計・母数から外す=二重計上しない)。
 * 戻せる label が無ければ item をそのまま返す。
 */
export function undoLastLabel(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  const ev = labels.lastForItem(itemId);
  if (!ev) return item;
  // 逆適用が定義された UNDOABLE(queue.ts と単一の真実源)だけ扱う。非対象(approve/audit_*/
  // demote/escalate_category 等)は label を消さず no-op で返す。旧実装は switch の外の
  // deleteById が無条件に走り、「no-op のはず」の直近ラベル(人間判断の痕跡=受領・承認・
  // 監査結果)を巻き戻し無しで削除して較正・週次集計を歪めていた。
  if (!UNDOABLE.has(ev.action)) return item;

  const confBin = confBinOf(item.rawConfidence ?? item.confidence);
  const rawDisp = item.rawDisposition ?? ev.fromDisposition ?? item.disposition;
  const patch: Partial<Item> = {};

  switch (ev.action) {
    case "do": {
      // doIt: status を in_progress にした。
      patch.status = "classified";
      if (ev.fromDisposition) patch.disposition = ev.fromDisposition;
      // AI停止の引き取り(note マーカー): doIt 側で agreed を積んでいないので unbump もしない
      // (無条件 unbump は同カテゴリの他項目が正当に積んだ agreed を横取りして母数を歪める)。
      if (ev.note === DO_NOTE_AI_STOPPED) break;
      // 監査 do(recordAudit true)と通常 do(auto 項目の是認)は最終状態が区別不能のため、
      // auditSampled の再武装はしない(存在しなかった監査サンプルを誤って再浮上させない)。
      // bump の巻き戻し(agreed)は両 do とも同じ auto/agreed 母数なので unbump のみ残す。
      if (item.disposition === "auto" && !item.auditSampled) {
        if (ev.category) categoryStats.unbump(ev.category, "auto", "agreed", confBin);
      } else if (ev.category && rawDisp) {
        // 通常 do = 是認: agreed(rawDisp) を bump した。
        categoryStats.unbump(ev.category, rawDisp, "agreed", confBin);
      }
      break;
    }
    case "reject": {
      patch.status = "classified";
      if (ev.fromDisposition) patch.disposition = ev.fromDisposition;
      break;
    }
    case "send_back": {
      // send_back: kind=leaf→node, disposition=from→escalate に倒し(auto のとき overturned を積んだ)。
      // 逆適用は降格部分だけ戻す: kind→leaf, disposition→from。実行後 send_back で
      // 合成された cancel(巻き戻し提示)は戻さない(winnow は巻き戻しを能動実行しない §4-4)。
      //
      // 復元先は note の決定論マーカー(着手前/後)で分ける。着手後(実行成功済みだった)を
      // classified+none に戻すと掃き出しループが成功済みタスクを黙って自動再実行する
      // (二重実行・二重副作用)。succeeded/done+autoExecuted に復元して autoDone カード
      // (取消ハンドル)へ戻す。awaiting_handoff まで戻さない=採用系の面は改めて人間が判断する。
      patch.kind = "leaf";
      if (ev.fromDisposition) patch.disposition = ev.fromDisposition;
      if (ev.note === "送り返し(着手後)") {
        patch.status = "done";
        patch.executionStatus = "succeeded";
        patch.autoExecuted = true;
      } else {
        patch.status = "classified";
      }
      patch.humanOverrode = false;
      // 母数の unbump は「この send_back が積んだ分」だけ。ev 以外に send_back が残っていれば
      // この ev は2回目以降=母数に積んでいないので unbump しない(record 側のループ防止と対称)。
      const otherSendBack = labels
        .forItem(itemId)
        .some((e) => e.id !== ev.id && e.action === "send_back");
      if (!otherSendBack && ev.fromDisposition === "auto" && ev.category && rawDisp === "auto") {
        categoryStats.unbump(ev.category, "auto", "overturned", confBin);
      }
      break;
    }
    case "receive": {
      // receive: receivedAt を立てて畳んだ(較正簿記なし=巻き戻す bump もない)。
      // note の決定論マーカーで逆適用先を分ける (send_back の着手前/後と同じ方式):
      //  - 受領(引き取り): awaiting_handoff → succeeded/done に進めた → 引き取り待ちへ戻す。
      //  - 確認して畳む: receivedAt のみ → 下ろすだけで autoDone カードが再可視化される。
      patch.receivedAt = null;
      if (ev.note === "受領(引き取り)") {
        patch.executionStatus = "awaiting_handoff";
        patch.status = "review";
      } else if (ev.note === "レビュー完了(問題なし)") {
        // レビュー leaf の畳みを戻す(さばき待ちへ)。束で畳んだ元アイテム側の receive は
        // 元アイテム自身の直近ラベルとして別途 undo する(undo は item ごと=直近1手ずつ)。
        patch.status = "classified";
      }
      break;
    }
    case "reclassify":
    case "override": {
      // reclassify/override: disposition を to に覆し recordOutcome を積んだ。
      if (ev.fromDisposition) patch.disposition = ev.fromDisposition;
      patch.humanOverrode = false;
      if (ev.category && rawDisp && ev.toDisposition) {
        const human = ev.toDisposition;
        if (rawDisp === human) {
          categoryStats.unbump(ev.category, rawDisp, "agreed", confBin);
        } else {
          categoryStats.unbump(ev.category, rawDisp, "overturned", confBin);
          if (rawDisp === "escalate" && human === "auto") {
            categoryStats.unbump(ev.category, rawDisp, "overturnedToAuto", confBin);
          }
        }
      }
      break;
    }
    case "mute_category": {
      // muteCategory: そのカテゴリに auto 固定 manual rule を立て disposition=auto にした。
      // 最新 active rule を deactivate し disposition を戻す (緩め方向の1手だけ戻せる)。
      if (item.category) {
        const r = rules.forCategory(item.category);
        if (r) rules.deactivate(r.id);
      }
      if (ev.fromDisposition) patch.disposition = ev.fromDisposition;
      break;
    }
    case "audit_ok":
    case "audit_bad":
    case "approve":
    case "demote":
    case "escalate_category":
    default:
      // これらは標準の Undo 対象にしない (監査教師信号/承認/降格/カテゴリ締めは別経路で扱う)。
      // escalate_category は UNDOABLE 外なので UI からは呼ばれない(締めは戻しにくい)。安全側で no-op。
      break;
  }

  labels.deleteById(ev.id);
  return Object.keys(patch).length ? (items.update(itemId, patch) ?? item) : item;
}

/**
 * 即締め: muteCategory の対称『この種類は当面上げて』(§3.6-3 締めるのは速く)。
 * escalate 固定の manual rule を upsert する。緩め方向(auto)とは非対称に、締め方向だけ
 * UI から手早く打てる正規路。disposition も escalate に倒し、在庫を即再適用する。
 */
export function escalateCategory(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item || !item.category) return item ?? null;
  rules.upsert({
    category: item.category,
    forcedDisposition: "escalate",
    source: "manual",
    note: "この種類は当面上げて(手動・締め)",
  });
  // 専用 action 'escalate_category' で記録する (mute_category と対称)。単件の reclassify→escalate
  // (action='override') と同じ label_event を出していた頃は、UI の Undo 抑止が両者を区別できず
  // 単件の覆しの取り消しまで巻き添えで無効化していた。専用 action にして UNDOABLE から外すことで、
  // 「カテゴリ締めは戻しにくい・単件の覆しは戻せる」を両立する。週次集計は summary.ts 側で
  // override と同様に締め/覆しへ算入する(メトリクスは不変)。
  labels.record({
    itemId,
    action: "escalate_category",
    fromDisposition: item.disposition,
    toDisposition: "escalate",
    category: item.category,
  });
  const updated = items.update(itemId, {
    disposition: "escalate",
    status: "classified",
    humanOverrode: item.disposition !== "escalate",
  });
  // 締め方向の在庫即再適用 (AI往復ゼロ)。auto に倒っていた classified 在庫を escalate へ。
  reapplyAndIgnite(item.category);
  return updated;
}
