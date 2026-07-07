import type { Item } from "./domain.js";
import { RUNG_LABEL } from "./domain.js";
import { items, projects, settings } from "./repo.js";
import { buildAiZone } from "./learning.js";

// 文脈の組み立て (REQUIREMENTS §2.2). 上段の鋭いスペックを下段に渡すための配管。
// プロダクト全体の前提 + 案件の前提 + 親チェーン(ルート→親) を1つのブロックにする。
// これを分類・分解・昇格・実行プロンプトすべてに注入し、エージェントが方向性を
// 再導出して壊れる(=一番高くつく失敗)のを防ぐ。

// 注入の天井 (§6 経済・防御). 文脈は毎 dispatch 全量送られるので、肥大した前提が
// (a) トークンを食い続け、(b) HeadlessDriver の execFile 引数経由で ARG_MAX(E2BIG) に
// ぶつかって未検証クラッシュになるのを防ぐ。超過時は先頭優先で切り、番兵で「省略した」
// ことを可視化する(黙って欠落させない)。TmuxDriver はファイルI/Oで実質無制限だが、
// driver 非対称を1上限で丸める割り切り(暫定値・実機計測で調整可)。
const MAX_CONTEXT_CHARS = 16000;

// 秘密伏字化 (§6 防御). productContext/案件context/親body 由来の秘密が分類・分解・実行
// プロンプトに無差別注入されるのを最終ゲートで止める(締め込み)。ホットパス(全 dispatch)で
// 走るので正規表現はモジュールトップで事前コンパイルし、毎回 .replace で使う(test は使わない)。
// 閾値は保守的(40+連続)にし、誤検出は安全側(伏字)に倒れる。
const RE_GH_TOKEN = /gh[pousr]_[A-Za-z0-9]{20,}/g;
const RE_AWS_KEY = /AKIA[0-9A-Z]{16}/g;
const RE_HIGH_ENTROPY = /[A-Za-z0-9+/=]{40,}/g;

export function redactSecrets(s: string): string {
  return s
    .replace(RE_GH_TOKEN, "[REDACTED-TOKEN]")
    .replace(RE_AWS_KEY, "[REDACTED-AWS-KEY]")
    .replace(RE_HIGH_ENTROPY, "[REDACTED-HIGH-ENTROPY]");
}

// 切り詰め (前方優先 slice + 番兵=省略を可視化する。黙って欠落させない)。区画別予算で
// 人間ゾーン/AIゾーンに別々に適用するほか、executor の priorPlan 切り詰めも共有する。
export function clip(text: string, max: number, sentinel: string): string {
  if (max <= 0) return ""; // 予算ゼロ=ゾーンごと省く(番兵だけ注入しない)。
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  // UTF-16 サロゲートペアの途中で切らない(先頭サロゲートの単独残りは書き出し時に
  // U+FFFD へ置換され末尾が壊れる)。
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + sentinel;
}

/**
 * memory の人間ゾーンを組む (productContext + 案件前提 + node 段メモリ + 親チェーン)。
 * いずれも人間が書く/AI 注入される高信頼の前提。AIゾーン (学び) とは予算も信頼度も分ける。
 */
function buildHumanZone(item: Item): string {
  const parts: string[] = [];

  const product = settings.get().productContext?.trim();
  if (product) parts.push(`### プロダクト全体の前提\n${product}`);

  if (item.projectId) {
    const p = projects.get(item.projectId);
    const ctx = p?.context?.trim();
    // 案件前提が空なら案件ブロックごと省略する (productContext/親チェーンと対称)。
    // 以前の「(前提未記入)」見出しは、空でも毎プロンプトにトークンとして漏れていた。
    if (p && ctx) parts.push(`### 案件「${p.name}」の前提\n${ctx}`);
  }

  // この項目自身の node 段メモリ (Item.context)。body 相乗りでなく高信頼の前提として注入。
  const selfCtx = item.context?.trim();
  if (selfCtx) parts.push(`### この項目の前提(メモ)\n${selfCtx}`);

  // 親チェーン(ルート→直近の親)。循環ガード付き。各 node の前提(context)も併記する。
  const chain: Item[] = [];
  const seen = new Set<string>([item.id]);
  let cur = item.parentId ? items.get(item.parentId) : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? items.get(cur.parentId) : null;
  }
  if (chain.length) {
    const lines = chain.map((a, i) => {
      const pad = "  ".repeat(i);
      const body = a.body ? `\n${pad}  ${a.body.replace(/\n/g, " ")}` : "";
      const ctx = a.context?.trim() ? `\n${pad}  前提: ${a.context.trim().replace(/\n/g, " ")}` : "";
      return `${pad}- [${RUNG_LABEL[a.rung]}] ${a.title}${body}${ctx}`;
    });
    parts.push(`### この項目が属する上位の意図(ルート→親)\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

// 注入本文の組み立て (単一の内部関数)。本注入 (buildContextBlock) とプレビュー
// (buildContextPreview) の分岐は learnings.touch の副作用の有無だけで、切り詰め・番兵・
// redactSecrets の最終ゲートは完全に共有する。ロジックを複製すると「表示の真実」が
// 実注入とドリフトする(プレビューが嘘をつく)ため、分岐点は touch フラグ1個に絞る。
function assemble(item: Item, opts: { touch: boolean }): {
  block: string;
  humanZoneChars: number;
  aiZoneChars: number;
} {
  // 人間ゾーンを優先予算で残し、AIゾーンを別予算で後段に積む (切り詰め順の逆転バグ回避:
  // 肥大時に node 段メモリや AI の学びが先頭の productContext を押し出さない)。
  const humanZone = clip(
    buildHumanZone(item),
    MAX_CONTEXT_CHARS,
    "\n\n…(文脈が長すぎるため後半を省略。設定『プロダクトの前提』または案件の前提を整理してください)",
  );
  // AIゾーンの予算は「専用上限」と「総量 MAX_CONTEXT_CHARS の残予算」の小さい方。これで
  // 人間ゾーン優先を保ちつつ、両ゾーン満杯で注入本文が天井(≒ARG_MAX防御の値)を超えない。
  const aiBudget = Math.max(
    0,
    Math.min(settings.get().aiZoneMaxChars ?? MAX_CONTEXT_CHARS, MAX_CONTEXT_CHARS - humanZone.length),
  );
  // memory の AIゾーン (自動蓄積された学び)。tighten-only・区画別予算で注入される。
  // touch=false (プレビュー) では学びの生存信号 (lastSeenAt) を更新しない (learning.ts)。
  const aiZone = clip(
    buildAiZone(item, { touch: opts.touch }),
    aiBudget,
    "\n…(学びが多いため一部を省略。不要な学びは veto してください)",
  );

  // ゾーン文字数は切り詰め・伏字化後 (番兵込み) = 実際に注入される長さ。予算の可視化であって
  // 処理量メトリクスではない (INVARIANTS: 件数・処理量の実績は表示しない)。
  // clip 直後の長さで計上すると、伏字置換 (元より必ず短い) が発火した時に block の実長より
  // 過大な数字を返して「表示された block と数字が合わない」嘘になるため、計測は区画別に
  // redactSecrets を通した長さで取る。最終ゲート (結合後テキストへの 1回の redactSecrets) は
  // 下でそのまま維持する: どの伏字パターンも改行を含まず結合セパレータ "\n\n" を跨いで
  // マッチしないため、区画別の伏字化結果は結合後伏字化の各区画と正確に一致する (計測専用の
  // 適用であって新しい注入経路ではない)。
  const chars = {
    humanZoneChars: redactSecrets(humanZone).length,
    aiZoneChars: redactSecrets(aiZone).length,
  };
  if (!humanZone && !aiZone) return { block: "", ...chars };
  // 人間ゾーンを先頭・AIゾーンを後段に連結。
  let bodyText = [humanZone, aiZone].filter((z) => z.length > 0).join("\n\n");
  // 注入直前に秘密を伏字化(両ゾーン結合後に1回だけ=最終ゲートの漏れ口を増やさない)。
  bodyText = redactSecrets(bodyText);
  return { block: `\n## 文脈（必ずこれに沿って判断・分解・実行する）\n${bodyText}\n`, ...chars };
}

export function buildContextBlock(item: Item): string {
  return assemble(item, { touch: true }).block;
}

/**
 * 注入プレビュー (GET /api/items/:id/context-preview)。buildContextBlock と同一の組み立てを
 * touch なしで実行し、実注入と完全一致する文字列 (redactSecrets 通過後) と区画別の
 * 切り詰め・伏字化後文字数 (= block 内の実長)・天井を返す。
 * read-only: 眺めるだけの学びを減衰から延命させない。
 */
export function buildContextPreview(item: Item): {
  block: string;
  humanZoneChars: number;
  aiZoneChars: number;
  maxChars: number;
} {
  return { ...assemble(item, { touch: false }), maxChars: MAX_CONTEXT_CHARS };
}
