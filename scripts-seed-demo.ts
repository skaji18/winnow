// 録画(README GIF)専用シード。基本シード(scripts-seed.ts)に、GIFで見せたい状態を足す。
// 決定的に撮り直せるよう、新規ホーム(WINNOW_HOME)を空にしてから実行する前提(demo/run.mjs)。
import "./scripts-seed.js"; // 基本デモデータを投入(副作用 import)
import { items, labels, settings } from "./src/server/repo.js";

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

// さばきの実績を十分に積んで「学習中(コールドスタート)」バナーを消す(初日表示はGIFのノイズ)。
// COLD_THRESHOLD=10 を超えるよう過去のさばき(ラベル)を足すが、キューに見えているカードに付けると
// 「さばきを戻す」リンクが出てノイズになるので、すでに done/review の(キュー非表示の)アイテムに付ける。
const terminal = items
  .all()
  .filter((i) => i.status === "done" || i.status === "review" || i.status === "rejected");
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
