import { categoryStats, items, labels, rules, settings } from "./repo.js";
import type { Disposition } from "./domain.js";
import { confBinOf } from "./text.js";

// 自己較正=地味な簿記 (REQUIREMENTS §3.6). ゼロから方策を学ばない。明示ルールが先、
// 残差だけをカテゴリ別の基準率補正(カウント)で倒す。浅くて頑健。
//
// 較正母数の汚染除去 (Batch2 の背骨): recordOutcome に渡す aiDisposition は分類器が
// tightness/ゲートで書き換える「前」の生提案 (item.rawDisposition、null時は disposition に
// フォールバック)。tightness 後の disposition を渡してはならない — 母数が歪み learned tip が誤る。

const OVERTURN_TO_AUTO = 0.8; // 「カテゴリXでescalateを8割却下→自動に倒す」(§3.6-1)

/**
 * Wilson スコア区間の下限 (ライブラリ不要・決定論)。小標本の不確実性を吸収して、
 * 点推定 (overturnedToAuto/total) が偶然高いだけのカテゴリを早まって緩めないようにする。
 * total<1 は判定不能として 0 を返す (緩めない=安全側)。
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total < 1) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  const lb = (center - margin) / denom;
  return lb < 0 ? 0 : lb;
}

/**
 * 人間のさばき結果を記録する。AIの「生提案」と人間の最終判断が一致したか/覆ったか。
 * 信号の非対称 (§3.6-3): 過小エスカレーション(auto事故)は高く遅れて危険に出る。
 * よって audit_bad は即座に締め(learned rule で escalate 固定)。
 *
 * aiDisposition は生提案 (呼び出し側で item.rawDisposition ?? item.disposition)。confBin は
 * その生提案を出したときの confidence ビン (rawConfidence ?? confidence)。
 */
export function recordOutcome(
  category: string | null,
  aiDisposition: Disposition | null,
  humanFinal: Disposition,
  opts: { auditBad?: boolean; confBin?: number } = {},
): void {
  if (!category || !aiDisposition) return;
  const confBin = opts.confBin ?? 0;
  if (aiDisposition === humanFinal) {
    categoryStats.bump(category, aiDisposition, "agreed", confBin);
  } else {
    // 全方向の覆しは overturned に積む (全体の覆し率を正直に保つ)。
    categoryStats.bump(category, aiDisposition, "overturned", confBin);
    // 緩める判定 (§3.6-3) は escalate→auto の覆しだけを数える。人間が上げた
    // escalate→human を分子に混ぜると、安全側の判断が誤って自動へ倒してしまう。
    if (aiDisposition === "escalate" && humanFinal === "auto") {
      categoryStats.bump(category, aiDisposition, "overturnedToAuto", confBin);
    }
  }

  // 締めるのは速く: 自動が事故ったら、そのカテゴリは即 escalate 固定の learned rule。
  if (opts.auditBad) {
    rules.upsert({
      category,
      forcedDisposition: "escalate",
      source: "learned",
      note: "監査で自動処理の誤りを検出→安全側に締め",
    });
    return;
  }

  // 緩めるのは慎重に: 全ビン横断の Wilson 下限が閾値を超えるときだけ自動に倒す。
  // 点推定でなく下限を使うことで、小標本で偶然高い却下率に釣られない (MIN_SAMPLES の置換)。
  const stats = categoryStats.aggregated(category);
  const esc = stats.find((s) => s.aiDisposition === "escalate");
  if (esc) {
    // 分母は安全側 (agreed + 全方向の覆し)、分子は auto 方向の覆しだけ (§3.6-3)。
    const total = esc.agreed + esc.overturned;
    const lb = wilsonLowerBound(esc.overturnedToAuto, total);
    if (lb >= OVERTURN_TO_AUTO) {
      const existing = rules.forCategory(category);
      if (!existing) {
        rules.upsert({
          category,
          forcedDisposition: "auto",
          source: "learned",
          note: `escalateのoverturnToAuto Wilson下限${Math.round(lb * 100)}%>=80%(n=${total})→自動に倒す`,
        });
      }
    }
  }
}

/**
 * AIの提案を、明示ルール→基準率補正の順で最終決定に変換する (§3.6-1).
 * 明示ルール優先のまま。requiredConf 補正/監査率引き上げは classifier 側で別途呼ぶ
 * (ここに混ぜると learned auto rule が効いている間に補正が効かなくなる)。
 */
export function applyRulesAndCalibration(
  category: string | null,
  proposed: Disposition,
): { disposition: Disposition; note: string | null } {
  if (!category) return { disposition: proposed, note: null };

  // 1. 明示ルールが最優先 (manual/learned 問わず active なもの)。
  const rule = rules.forCategory(category);
  if (rule) {
    return {
      disposition: rule.forcedDisposition,
      note: `ルール(${rule.source}): ${rule.note ?? category}`,
    };
  }
  return { disposition: proposed, note: null };
}

/**
 * confidence ビン較正 (§3.6 締めは速く緩めは慎重に)。カテゴリのビン別 category_stats を見て、
 * ビンの実 overturn 率が「申告」(ビン代表 confidence=(confBin+0.5)/5 に対する 1-conf) を
 * binOverturnGap 超で上回るビンがあれば、そのカテゴリは申告より実際に外している証拠なので
 * requiredConf に足す下駄(締め側=正の値)を返す。乖離が無ければ null(現状維持)。
 * 緩める方向(負の下駄)には決して倒さない=非対称を守る。
 */
export function calibrateRequiredConf(category: string | null): number | null {
  if (!category) return null;
  const cfg = settings.get();
  const stats = categoryStats.forCategory(category);
  let maxGap = 0;
  for (const s of stats) {
    // auto の生提案ビンだけを見る (escalate/human は締めの母数にしない)。
    if (s.aiDisposition !== "auto") continue;
    const total = s.agreed + s.overturned;
    if (total < cfg.binCalibrationMinSamples) continue;
    const actualOverturn = s.overturned / total;
    const repConf = (s.confBin + 0.5) / 5; // ビン代表 confidence
    const declaredOverturn = 1 - repConf; // 申告(粗い近似)
    const gap = actualOverturn - declaredOverturn;
    if (gap > cfg.binOverturnGap && gap > maxGap) maxGap = gap;
  }
  if (maxGap <= 0) return null;
  // 締め側の下駄。乖離 gap をそのまま requiredConf に加算 (上限は classifier 側で clamp)。
  return maxGap;
}

/**
 * stakes/reversibility の符号ズレ補正 (締め側のみ)。申告が低ステークス/高可逆なのに
 * audit_bad(実際は高ステークス/不可逆だった)で覆ったカテゴリは、自動着火閾値を安全側に
 * だけ補正する床値を返す。母数は LabelEvent の audit_bad を簡便にカウント(専用枠は持たない)。
 * 未補正カテゴリは {} を返し現状維持(後方互換)。
 */
export function stakesReversibilityCorrection(
  category: string | null,
): { stakesFloor?: number; reversibilityFloor?: number } {
  if (!category) return {};
  // 直近(全期間)の audit_bad 件数。1件以上で「過小評価の前科あり」と見なし締め床を返す。
  const badCount = labels.countByCategoryAction(category, ["audit_bad"], 0);
  if (badCount <= 0) return {};
  // 締め側: 高ステークス判定の床を下げ(=より高ステークス扱いしやすく)、可逆判定の床を上げる
  // (=より不可逆扱いしやすく)。executor の REVERSIBLE_THRESHOLD/highStakes 相当をカテゴリ
  // 単位で安全側にだけ補正する素材。具体適用は executor 側 (Batch4) で消費。
  return { stakesFloor: 0.7, reversibilityFloor: 0.5 };
}

/**
 * ルール変更の在庫即再適用 (AI往復ゼロ)。rules upsert/mute_category/learned tip 後に呼び、
 * その category の classified 在庫へ applyRulesAndCalibration だけを再評価して disposition/reason
 * を更新する。生提案(rawDisposition ?? disposition)を基点にすることで、過去に tightness で
 * 締めた項目もルールが緩めれば即恩恵を受ける(レガシーは disposition にフォールバック)。
 *
 * 循環 import 回避: ここでは disposition 更新までに留め、新たに auto leaf になった項目の id を
 * 返す。着火 (executor.requestExecution) は呼び出し側 (actions.ts) が行う。
 * 返り値: { updated: 更新件数; ignite: 着火すべき itemId[] }。
 */
export function applyRulesToInventory(category: string): { updated: number; ignite: string[] } {
  const targets = items
    .all()
    .filter(
      (it) =>
        it.category === category &&
        it.status === "classified" &&
        it.executionStatus === "none" &&
        !it.autoExecuted,
    );
  let updated = 0;
  const ignite: string[] = [];
  for (const it of targets) {
    const base: Disposition | null = it.rawDisposition ?? it.disposition;
    if (!base) continue;
    const ruled = applyRulesAndCalibration(category, base);
    if (ruled.disposition === it.disposition && !ruled.note) continue;
    const reason = ruled.note
      ? `${it.reason ?? ""}（${ruled.note}）`
      : (it.reason ?? null);
    const next = items.update(it.id, { disposition: ruled.disposition, reason });
    if (!next) continue;
    updated++;
    if (next.disposition === "auto" && next.kind === "leaf") ignite.push(next.id);
  }
  return { updated, ignite };
}
