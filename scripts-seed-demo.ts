// 録画(README GIF)専用シード。基本シード(scripts-seed.ts)に、GIFで見せたい状態を足す。
// 決定的に撮り直せるよう、新規ホーム(WINNOW_HOME)を空にしてから実行する前提(demo/run.mjs)。
import "./scripts-seed.js"; // 基本デモデータを投入(副作用 import)
import { items, labels, settings } from "./src/server/repo.js";
import { DAY_MS } from "./src/server/queue.js";

function mk(patch: Parameters<typeof items.update>[1] & { title: string }) {
  const it = items.create({ title: patch.title });
  return items.update(it.id, patch)!;
}

// 「成果物の引き取り(handoff)」を見せる1件: PR作成までは自動、マージは人間。
// done に沈めず『引き取り待ち』としてキュー前面に出る。
mk({
  title: "管理画面の依存パッケージ更新PRを作成",
  kind: "leaf",
  rung: "execution",
  status: "review",
  domain: "software",
  disposition: "auto",
  confidence: 0.86,
  stakes: 0.45,
  reversibility: 0.7,
  category: "保守",
  reason: "PR作成までは自動。マージは責任が残るので人間が引き取る。",
  autoExecuted: true,
  executionStatus: "awaiting_handoff",
  executionSummary: "依存3件を更新し、テストを通したうえで PR を作成しました。",
  executionOutput: "- eslint 9.x へ更新\n- vite 5.4 へ更新\n- CI: 全テスト green",
  executionResult:
    "依存3件を更新し、テストを通したうえで PR を作成しました。\n\n- eslint 9.x へ更新\n- vite 5.4 へ更新\n- CI: 全テスト green",
  artifacts: JSON.stringify(["https://github.com/acme/admin/pull/482"]),
  priority: "normal",
});

// 「見通し」レンズ(rung×due)が映えるよう、中長期(それ以降バケット)の項目を足す。
// 基本シードは数日内の due ばかりで、レンズを切り替えても右列(それ以降)が空に見えるため。
// キューにも2枚のカードとして出る(human/escalate)のは意図した取捨: 見通しに出すには open で
// ある必要があり、auto に倒すと leaf は pauseAuto 経由で「承認待ち」カード化してかえって騒がしい。
// 現実的なカードが2枚増えても「要確認だけの短いキュー」の筋は崩れない。
const now = Date.now();
mk({
  title: "決済リニューアルの GA 判定",
  kind: "node",
  rung: "strategy",
  status: "classified",
  disposition: "human",
  confidence: 0.4,
  stakes: 0.85,
  reversibility: 0.3,
  category: "戦略",
  reason: "四半期スコープの判断。二次効果が大きく人間が決める。",
  priority: "normal",
  dueDate: now + 40 * DAY_MS,
});
mk({
  title: "返金レポートの月次自動化",
  kind: "leaf",
  rung: "execution",
  status: "classified",
  domain: "software",
  disposition: "escalate",
  confidence: 0.55,
  stakes: 0.4,
  reversibility: 0.8,
  category: "実装",
  reason: "来月の締めまでに。定型化できる範囲を一度確認したい。",
  priority: "normal",
  dueDate: now + 24 * DAY_MS,
});

// さばきの実績を十分に積んで「学習中(コールドスタート)」バナーを消す(初日表示はGIFのノイズ)。
// COLD_THRESHOLD=10 を超えるよう過去のさばき(ラベル)を足すが、キューに見えているカードに付けると
// 「さばきを戻す」リンクが出てノイズになるので、すでに done/review の(キュー非表示の)アイテムに付ける。
// 引き取り待ち(awaiting_handoff)は status='review' でもキュー最前面に可視なので除外する
// (flow05 のヒーローカードに filler の undo リンクを露出させない)。
const terminal = items
  .all()
  .filter(
    (i) =>
      (i.status === "done" || i.status === "review" || i.status === "rejected") &&
      i.executionStatus !== "awaiting_handoff",
  );
const fillerActions: ("do" | "reject" | "audit_ok" | "override")[] = [
  "audit_ok",
  "do",
  "reject",
  "override",
  "audit_ok",
  "do",
  "reject",
  "override",
  "audit_ok",
];
if (terminal.length > 0) {
  fillerActions.forEach((action, i) => {
    labels.record({ itemId: terminal[i % terminal.length]!.id, action });
  });
}

// 録画を安定させる: 自動実行は止め(承認は通せる)、監査サンプルの乱数チラつきも消す。
settings.update({ pauseAuto: true, auditRate: 0 });

console.log("demo seed augmented:", items.all().length, "items total");
