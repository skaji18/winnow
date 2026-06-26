import { applyRulesToInventory, recordOutcome } from "./calibration.js";
import { rollAudit } from "./classifier.js";
import type { Disposition, Item, Rung } from "./domain.js";
import { RUNGS } from "./domain.js";
import * as executor from "./executor.js";
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

/** やる: 人間が引き取って着手。AIの仕分けを是認したことになる。 */
export function doIt(itemId: string): Item | null {
  const item = items.get(itemId);
  if (!item) return null;
  labels.record({
    itemId,
    action: "do",
    fromDisposition: item.disposition,
    toDisposition: "human",
    category: item.category,
  });
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
 * 引き取り(handoff)の受領 (§3.5 継ぎ目)。awaiting_handoff の成果物を人間が確認/採用して完了へ進める。
 * 人間が成果物に責任を引き取った痕跡を label_event に残す(receive)。採用(マージ/送信)自体は
 * winnow がやらない=人間が外で行う。較正母数(recordOutcome)には積まない: 引き取りは
 * 「分類が正しかったか」の信号ではなく「成果物を受領したか」の儀式/レビューだから(過剰計上を避ける)。
 */
export async function acceptHandoff(itemId: string): Promise<Item | null> {
  const item = items.get(itemId);
  if (!item) return null;
  labels.record({ itemId, action: "receive", category: item.category });
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

  const confBin = confBinOf(item.rawConfidence ?? item.confidence);
  const rawDisp = item.rawDisposition ?? ev.fromDisposition ?? item.disposition;
  const patch: Partial<Item> = {};

  switch (ev.action) {
    case "do": {
      // doIt: status を in_progress にした。
      patch.status = "classified";
      if (ev.fromDisposition) patch.disposition = ev.fromDisposition;
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
    default:
      // これらは標準の Undo 対象にしない (監査教師信号/承認/降格は別経路で扱う)。安全側で no-op。
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
  labels.record({
    itemId,
    action: "override",
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
