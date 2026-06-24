import type { Item } from "./domain.js";
import { RUNG_LABEL } from "./domain.js";
import { items, projects, settings } from "./repo.js";

// 文脈の組み立て (REQUIREMENTS §2.2). 上段の鋭いスペックを下段に渡すための配管。
// プロダクト全体の前提 + 案件の前提 + 親チェーン(ルート→親) を1つのブロックにする。
// これを分類・分解・昇格・実行プロンプトすべてに注入し、エージェントが方向性を
// 再導出して壊れる(=一番高くつく失敗)のを防ぐ。

export function buildContextBlock(item: Item): string {
  const parts: string[] = [];

  const product = settings.get().productContext?.trim();
  if (product) parts.push(`### プロダクト全体の前提\n${product}`);

  if (item.projectId) {
    const p = projects.get(item.projectId);
    if (p) {
      const ctx = p.context?.trim();
      parts.push(`### 案件「${p.name}」${ctx ? `の前提\n${ctx}` : "(前提未記入)"}`);
    }
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
  return `\n## 文脈（必ずこれに沿って判断・分解・実行する）\n${parts.join("\n\n")}\n`;
}
