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

// 切り詰め (前方優先 slice + 番兵)。区画別予算で人間ゾーン/AIゾーンに別々に適用する。
function clip(text: string, max: number, sentinel: string): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + sentinel;
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

// memory の AIゾーン (自動蓄積された学び) を組む。tighten-only・区画別予算で注入される。
function buildAiZoneText(item: Item): string {
  return buildAiZone(item);
}

export function buildContextBlock(item: Item): string {
  // 人間ゾーンを優先予算で残し、AIゾーンを別予算で後段に積む (切り詰め順の逆転バグ回避:
  // 肥大時に node 段メモリや AI の学びが先頭の productContext を押し出さない)。
  const humanZone = clip(
    buildHumanZone(item),
    MAX_CONTEXT_CHARS,
    "\n\n…(文脈が長すぎるため後半を省略。設定『プロダクトの前提』または案件の前提を整理してください)",
  );
  const aiZone = clip(
    buildAiZoneText(item),
    settings.get().aiZoneMaxChars ?? MAX_CONTEXT_CHARS,
    "\n…(学びが多いため一部を省略。不要な学びは veto してください)",
  );

  if (!humanZone && !aiZone) return "";
  // 人間ゾーンを先頭・AIゾーンを後段に連結。
  let bodyText = [humanZone, aiZone].filter((z) => z.length > 0).join("\n\n");
  // 注入直前に秘密を伏字化(両ゾーン結合後に1回だけ=最終ゲートの漏れ口を増やさない)。
  bodyText = redactSecrets(bodyText);
  return `\n## 文脈（必ずこれに沿って判断・分解・実行する）\n${bodyText}\n`;
}
