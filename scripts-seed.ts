// Demo データ投入。repo 経由なので API では触れない監査/実行フィールドも設定できる。
import { items, labels, rules, categoryStats } from "./src/server/repo.js";

function mk(patch: Parameters<typeof items.update>[1] & { title: string }) {
  const it = items.create({ title: patch.title });
  return items.update(it.id, patch)!;
}

// 1. 霧/戦略の人間案件
mk({
  title: "新規事業の方向性を決める",
  kind: "node", rung: "fog", status: "classified",
  disposition: "human", confidence: 0.35, stakes: 0.92, reversibility: 0.2,
  category: "戦略", reason: "霧の領域。戦略の二次効果は文脈依存でAIには測れない。",
});
// 2. 顧客対応のエスカレーション
mk({
  title: "顧客Aへの再提案をどう進めるか",
  kind: "node", rung: "strategy", status: "classified",
  disposition: "escalate", confidence: 0.5, stakes: 0.7, reversibility: 0.5,
  category: "顧客対応", reason: "顧客関係のステークスがあり、AIだけでは確信が持てない。",
});
// 3. 実装リーフのエスカレーション(software)
mk({
  title: "決済APIの返金エンドポイントを実装",
  kind: "leaf", rung: "execution", status: "classified", domain: "software",
  disposition: "escalate", confidence: 0.62, stakes: 0.55, reversibility: 0.6,
  category: "実装", reason: "実装自体は定型だが、返金は副作用が大きいので着手前に確認。",
});
// 4. 不可逆・高ステークス → ワンタップ承認待ち
mk({
  title: "本番DBスキーマのマイグレーションを適用",
  kind: "leaf", rung: "execution", status: "classified", domain: "software",
  disposition: "escalate", confidence: 0.7, stakes: 0.88, reversibility: 0.15,
  category: "インフラ", reason: "不可逆・高ステークスのため自動着火せず提案で止める。",
  executionStatus: "proposed",
  executionResult: "不可逆/高ステークスのため、承認待ち(ワンタップで実行)。",
});
// 5. 監査サンプル(auto + auditSampled): 見分けつかない形でキューに混ざる
mk({
  title: "経費精算(¥3,200 交通費)を承認",
  kind: "leaf", rung: "execution", status: "classified",
  disposition: "auto", confidence: 0.9, stakes: 0.15, reversibility: 0.9,
  category: "経費", reason: "定型・低額・可逆。自動処理済み。", auditSampled: true,
  executionStatus: "succeeded", autoExecuted: false,
});
// 6. 自動実行済み → 結果 + 安く取り消せる導線(§4-4)
mk({
  title: "週次レポートの下書きを生成",
  kind: "leaf", rung: "execution", status: "done",
  disposition: "auto", confidence: 0.88, stakes: 0.2, reversibility: 0.85,
  category: "レポート", reason: "定型の下書き生成。可逆なので自動着火した。",
  autoExecuted: true, executionStatus: "succeeded",
  executionResult:
    "下書き生成完了。\n\n# 週次レポート(ドラフト)\n- 今週のクローズ: 12件\n- 進行中: 5件\n- 要確認: 顧客Aの再提案\n\n※人間レビュー用に登録済み。",
});
// 7. 自動で畳んだ分(キューに出ない) → コールドスタートバナーの数字に効く
for (const t of ["Slackの定型返信を送る", "定例MTGの議事録を整形"]) {
  mk({
    title: t, kind: "node", rung: "means", status: "classified",
    disposition: "auto", confidence: 0.93, stakes: 0.1, reversibility: 0.95,
    category: "雑務", reason: "定型・低リスク。自動に倒した。", auditSampled: false,
  });
}

// 週次サマリを賑やかにする: ラベル履歴・学習ルール・カウント
const all = items.all();
labels.record({ itemId: all[1]!.id, action: "override", fromDisposition: "auto", toDisposition: "escalate", category: "顧客対応" });
labels.record({ itemId: all[2]!.id, action: "override", fromDisposition: "auto", toDisposition: "escalate", category: "実装" });
labels.record({ itemId: all[4]!.id, action: "audit_ok", fromDisposition: "auto", category: "経費" });
rules.upsert({ category: "雑務", forcedDisposition: "auto", source: "learned", note: "escalateの86%が却下(n=7)→自動に倒す" });
categoryStats.bump("雑務", "escalate", "overturned");

console.log("seeded", items.all().length, "items");
