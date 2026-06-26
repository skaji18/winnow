import type { Item } from "./domain.js";
import { RUNG_LABEL } from "./domain.js";
import { items, projects, settings } from "./repo.js";

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

export function buildContextBlock(item: Item): string {
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

  // 親チェーン(ルート→直近の親)。循環ガード付き。
  const chain: Item[] = [];
  const seen = new Set<string>([item.id]);
  let cur = item.parentId ? items.get(item.parentId) : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? items.get(cur.parentId) : null;
  }
  if (chain.length) {
    const lines = chain.map(
      (a, i) =>
        `${"  ".repeat(i)}- [${RUNG_LABEL[a.rung]}] ${a.title}${a.body ? `\n${"  ".repeat(i)}  ${a.body.replace(/\n/g, " ")}` : ""}`,
    );
    parts.push(`### この項目が属する上位の意図(ルート→親)\n${lines.join("\n")}`);
  }

  if (!parts.length) return "";
  let bodyText = parts.join("\n\n");
  if (bodyText.length > MAX_CONTEXT_CHARS) {
    bodyText =
      bodyText.slice(0, MAX_CONTEXT_CHARS) +
      "\n\n…(文脈が長すぎるため後半を省略。設定『プロダクトの前提』または案件の前提を整理してください)";
  }
  // 注入直前に秘密を伏字化(切り詰めで分断された残骸も対象にするため切り詰めの後に適用)。
  bodyText = redactSecrets(bodyText);
  return `\n## 文脈（必ずこれに沿って判断・分解・実行する）\n${bodyText}\n`;
}
