// Demo データ投入。repo 経由なので API では触れない監査/実行フィールドも設定できる。
import { items, labels, rules, categoryStats, projects, sprints } from "./src/server/repo.js";

const DAY = 86_400_000;
const now = Date.now();

function mk(patch: Parameters<typeof items.update>[1] & { title: string }) {
  const it = items.create({ title: patch.title });
  return items.update(it.id, patch)!;
}

// === 案件 ===
const pay = projects.create({ name: "決済リニューアル", mode: "board", description: "返金まわりの刷新" });
const ops = projects.create({ name: "社内運用", mode: "flow", description: "雑務・運用タスク" });
// スプリントはグローバルな時間箱 (案件に属さない)。
const s1 = sprints.create({ name: "Sprint 1 (6/23-6/30)", goal: "返金フローMVP" });
sprints.update(s1.id, { status: "active", startDate: now - 3 * DAY, endDate: now + 4 * DAY });

// === キューに出る案件群 ===
mk({
  title: "新規事業の方向性を決める",
  kind: "node", rung: "fog", status: "classified",
  disposition: "human", confidence: 0.35, stakes: 0.92, reversibility: 0.2,
  category: "戦略", reason: "霧の領域。戦略の二次効果は文脈依存でAIには測れない。",
  priority: "high",
});
mk({
  title: "顧客Aへの再提案をどう進めるか",
  kind: "node", rung: "strategy", status: "classified", projectId: ops.id, sprintId: s1.id,
  disposition: "escalate", confidence: 0.5, stakes: 0.7, reversibility: 0.5,
  category: "顧客対応", reason: "顧客関係のステークスがあり、AIだけでは確信が持てない。",
  priority: "high", dueDate: now + 5 * DAY,
});
mk({
  title: "決済APIの返金エンドポイントを実装",
  kind: "leaf", rung: "execution", status: "classified", domain: "software",
  projectId: pay.id, sprintId: s1.id,
  disposition: "escalate", confidence: 0.62, stakes: 0.55, reversibility: 0.6,
  category: "実装", reason: "実装自体は定型だが、返金は副作用が大きいので着手前に確認。",
  priority: "high", dueDate: now + 3 * DAY,
});
mk({
  title: "本番DBスキーマのマイグレーションを適用",
  kind: "leaf", rung: "execution", status: "classified", domain: "software",
  projectId: pay.id, sprintId: s1.id,
  disposition: "escalate", confidence: 0.7, stakes: 0.88, reversibility: 0.15,
  category: "インフラ", reason: "不可逆・高ステークスのため自動着火せず提案で止める。",
  executionStatus: "proposed", priority: "urgent", dueDate: now + DAY,
  // 計画プレビュー(QueueCard の details)を出すには executionSummary/Output が必要:
  // gateKind 由来の proposed は worker 成果が無いとペイン自体が抑止される(QueueCard.tsx)。
  // 注意: executionResult を summary+"\n\n"+output の厳密連結にしない(isNeedsHumanProposed の
  // 連結一致判定に誤マッチし、バッジが「AI停止」に化ける)。ゲート文言を接頭辞に足して外す。
  executionSummary: "変更計画: 0042_add_refunds を expand-contract で適用(ダウンタイムなし)。",
  executionOutput:
    "- 適用前にスナップショット snap-0706 を取得\n- 旧カラムは読み取り互換を維持(次リリースで削除)\n- 失敗時は 0042_add_refunds.down.sql で巻き戻し",
  executionResult:
    "不可逆/高ステークスのため、承認待ち(ワンタップで実行)。\n\n変更計画: 0042_add_refunds を expand-contract で適用(ダウンタイムなし)。\n\n- 適用前にスナップショット snap-0706 を取得\n- 旧カラムは読み取り互換を維持(次リリースで削除)\n- 失敗時は 0042_add_refunds.down.sql で巻き戻し",
});
mk({
  title: "経費精算(¥3,200 交通費)を承認",
  kind: "leaf", rung: "execution", status: "classified", projectId: ops.id,
  disposition: "auto", confidence: 0.9, stakes: 0.15, reversibility: 0.9,
  category: "経費", reason: "定型・低額・可逆。自動処理済み。", auditSampled: true,
  executionStatus: "succeeded",
});
mk({
  title: "週次レポートの下書きを生成",
  kind: "leaf", rung: "execution", status: "done", projectId: ops.id,
  disposition: "auto", confidence: 0.88, stakes: 0.2, reversibility: 0.85,
  category: "レポート", reason: "定型の下書き生成。可逆なので自動着火した。",
  autoExecuted: true, executionStatus: "succeeded",
  executionResult:
    "下書き生成完了。\n\n# 週次レポート(ドラフト)\n- 今週のクローズ: 12件\n- 進行中: 5件\n- 要確認: 顧客Aの再提案",
});
for (const t of ["Slackの定型返信を送る", "定例MTGの議事録を整形"]) {
  mk({
    title: t, kind: "node", rung: "means", status: "classified", projectId: ops.id,
    disposition: "auto", confidence: 0.93, stakes: 0.1, reversibility: 0.95,
    category: "雑務", reason: "定型・低リスク。自動に倒した。",
  });
}

// === スプリント1のボードを埋めるタスク (disposition=escalateで自動着火を避ける) ===
const board: [string, string, string][] = [
  ["返金フローのUIモック作成", "classified", "ストーリー"],
  ["返金APIの設計レビュー", "in_progress", "ストーリー"],
  ["返金ログ集計のバッチ", "review", "ストーリー"],
  ["返金エンドポイントの受け入れ基準定義", "done", "ストーリー"],
];
for (const [title, status, _label] of board) {
  void _label;
  mk({
    title, kind: "leaf", rung: "means", status, domain: "software",
    projectId: pay.id, sprintId: s1.id,
    disposition: "escalate", confidence: 0.6, stakes: 0.4, reversibility: 0.7,
    category: "実装", reason: "スプリント内の通常タスク。", priority: "normal",
  });
}
// スプリント未割当バックログも1件
mk({
  title: "返金の不正検知ルール検討", kind: "node", rung: "tactic", status: "classified",
  projectId: pay.id, disposition: "escalate", confidence: 0.45, stakes: 0.6, reversibility: 0.5,
  category: "設計", reason: "まだ問い。スプリント未割当。", priority: "normal",
});

// === 週次サマリを賑やかに ===
const all = items.all();
labels.record({ itemId: all[1]!.id, action: "override", fromDisposition: "auto", toDisposition: "escalate", category: "顧客対応" });
labels.record({ itemId: all[2]!.id, action: "override", fromDisposition: "auto", toDisposition: "escalate", category: "実装" });
labels.record({ itemId: all[4]!.id, action: "audit_ok", fromDisposition: "auto", category: "経費" });
rules.upsert({ category: "雑務", forcedDisposition: "auto", source: "learned", note: "要確認の86%が却下(n=7)→自動に倒す" });
categoryStats.bump("雑務", "escalate", "overturnedToAuto");

console.log("seeded", items.all().length, "items,", projects.all().length, "projects");
