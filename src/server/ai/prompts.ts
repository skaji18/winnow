import type { Item } from "../domain.js";
import { RUNGS, RUNG_LABEL } from "../domain.js";

// Prompts are the "上段への投資=鋭いスペック" (§2.2). They carry the design
// spine so the stateless cognition (§1.3) reasons the way the tool intends.

const LADDER = RUNGS.map((r) => `${r}(${RUNG_LABEL[r]})`).join(" → ");

const SPINE = `あなたは「Winnow」という道具の認知エンジンです。Winnowの目的は処理量を増やすことではなく、
希少資源である「人間の判断アテンション」の落とし所を最適化することです。
仕分けの本当の切り口は「上段=人間」ではなくレジビリティ(明示基準に乗るか)です。
- AIが得意: 基準照合できる次元、定型の自明案件、calibrated uncertaintyの申告。
- AIが構造的に盲: unknown-unknown(霧そのもの)、文脈に宿るステークス(顧客関係・戦略の二次効果)。
確信のない所で断定しないこと。分からないものは escalate にし、confidence を正直に下げること。`;

/** classify: disposition(三値) + confidence + 一行理由 + scores + category (§3.2). */
export function classifyPrompt(item: Item): string {
  return `${SPINE}

# タスク: 分類(仕分け)
以下のアイテムを「auto / escalate / human」の三値で仕分け、確信度つきでスコアリングしてください。
スコアリング次元は「確信度 × ステークス × 不可逆性」です。
- auto: 低リスク・可逆・高確信な、定型でレジブルな案件。AIが自動処理してよい。
- escalate: AIだけでは確信が持てない、または文脈に宿るステークスがありそうな案件。人間に上げる。
- human: 還元不能に人間的(霧・戦略・高ステークスで不可逆)。人間が判断すべき。

## アイテム
title: ${item.title}
body: ${item.body || "(なし)"}
現在のkind: ${item.kind} / rung: ${item.rung}

## ラダー(参考): ${LADDER}

## 出力(この形のJSONのみ)
{
  "disposition": "auto|escalate|human",
  "confidence": 0.0〜1.0,
  "reason": "一行理由(glanceableに。なぜその仕分けか)",
  "stakes": 0.0〜1.0,
  "reversibility": 0.0〜1.0,
  "kind": "node|leaf",
  "rung": "${RUNGS.join("|")}",
  "process": "waterfall|iterative",
  "uncertaintyResolved": true|false,
  "category": "短いカテゴリ名(同種の案件をまとめる安定したラベル。基準率補正に使う)"
}`;
}

/** decompose: ノードに効く。子の提案＋割り方の選択肢 (§3.3-1). */
export function decomposePrompt(item: Item): string {
  return `${SPINE}

# タスク: 分解(木を割る)
以下は「ノード(問い/意図)」です。これを子(ノード or リーフ)に割ってください。
割り方の選択肢も複数出してください(例: ウォーターフォール的にまとめて割る / PoCで情報を買う短サイクルで割る)。
原則: サイクル長はその段の不確実性に反比例。不明な段はウォーターフォール有害、情報を買う短サイクルが正解。

## アイテム
title: ${item.title}
body: ${item.body || "(なし)"}
rung: ${item.rung}

## 出力(この形のJSONのみ)
{
  "options": [
    {
      "label": "割り方の名前(例: PoC優先 / 全体設計優先)",
      "rationale": "なぜこの割り方か(不確実性との関係)",
      "process": "waterfall|iterative",
      "children": [
        { "title": "子の見出し", "kind": "node|leaf", "rung": "${RUNGS.join("|")}" }
      ]
    }
  ]
}`;
}

/** promote: 出てきた子に「まだ問いか/もう実行可能か」を付け直す (§3.3-3). */
export function promotePrompt(item: Item): string {
  return `${SPINE}

# タスク: 昇格判定
以下の子アイテムに、いま「まだ問い(node)か / もう実行可能(leaf)か」を付け直してください。
これが無いと子が無限に問いのまま降りてきません。

## アイテム
title: ${item.title}
body: ${item.body || "(なし)"}
現在: kind=${item.kind}, rung=${item.rung}

## 出力(この形のJSONのみ)
{
  "kind": "node|leaf",
  "rung": "${RUNGS.join("|")}",
  "executable": true|false,
  "reason": "一行理由"
}`;
}

/** execute: リーフの実行。domain で挙動を変える (§3.4). */
export function executePrompt(item: Item): string {
  const softwareNote =
    item.domain === "software"
      ? `これはソフトウェア開発タスクです。作業ディレクトリ内で実際に手を動かして構いません(編集/実行)。
ただし不可逆な操作(本番デプロイ・データ削除・外部送信など)はしないこと。それらが必要なら status を "needs_human" にして提案だけ返すこと。`
      : `これは一般タスクです。実際の外部副作用は起こさず、成果物の下書き・提案・手順を作成してください。`;
  return `${SPINE}

# タスク: 実行(Executor)
以下は「リーフ(実行可能タスク)」です。実行してください。
${softwareNote}

## アイテム
title: ${item.title}
body: ${item.body || "(なし)"}

## 出力(この形のJSONのみ)
{
  "status": "succeeded|failed|needs_human",
  "summary": "何をしたかの一行サマリ",
  "output": "成果物本体 or 詳細(markdown可)",
  "reviewTask": "このあと人間/自動でレビューすべき点があれば一行で(無ければ空文字)"
}`;
}
