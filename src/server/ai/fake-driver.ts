import type { AiDriver, AiRequest, AiResult, SessionInfo } from "./driver.js";

// デモ/録画専用のフェイク AI ドライバ。
//
// 本物の `claude` バイナリ・ログイン・tmux を一切使わず、AiDriver の契約だけを満たす。
// これ1つで「分類のLLM依存」「実行(worker)依存」「端末劇場(tmux capture)依存」を同時に外せる。
// 本番ロジック(classifier/executor)は AiDriver 越しにしか触らないので、ここは本番から疎結合。
//
// 有効化は環境変数 WINNOW_FAKE_AI=1 のときだけ(src/server/ai/index.ts)。本番起動経路からは到達しない。
//
// 注意: これは README デモGIFを決定的に撮り直すための仕組み(docs/DEMO_GIF_PLAN の方針)。
// 実プロダクトの振る舞いではない。

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// worker セッションの「動いている claude」を演じる台本。capture() が経過時間に応じて
// 1行ずつ開示し、末尾まで出たら少し溜めてからループする(端末劇場が生きて見える)。
const WORKER_LOG: string[] = [
  "$ claude   (winnow worker-0)",
  "",
  "● 実行: 決済APIの返金エンドポイントを実装",
  "",
  "> リポジトリと既存の返金処理を確認しています…",
  "  ⎿ Read src/api/refund.ts (142 lines)",
  "  ⎿ Read src/api/payment.ts (310 lines)",
  "",
  "● 方針を立てました:",
  "  1. POST /refunds に冪等キー (Idempotency-Key) を追加",
  "  2. 二重返金を防ぐロック取得",
  "  3. 失敗時のロールバック手順を整理",
  "  4. ユニットテストを追加",
  "",
  "● src/api/refund.ts を編集中…",
  "  ⎿ Updated src/api/refund.ts (+38 -4)",
  "● test/refund.test.ts を追加…",
  "  ⎿ Created test/refund.test.ts (+96)",
  "",
  "● テストを実行: npm test -- refund",
  "  ⎿ PASS  test/refund.test.ts (12 tests, 1.8s)",
  "",
  "● 変更をまとめました。返金は副作用が大きいため、",
  "  本番反映はせず人間の確認待ちにします。",
  "",
  "⏵ 待機中… (winnow が結果を引き取ります)",
];

const CONTROL_VIEW: string =
  ["$ claude   (winnow control)", "", "● 待機中。新しいタスクが来たら分類します。", "", "> "].join(
    "\n",
  );

export class FakeDriver implements AiDriver {
  private readonly bootedAt = Date.now();
  private readonly sessions: SessionInfo[] = [
    {
      name: "winnow:control",
      role: "control",
      busy: false,
      currentLabel: null,
      startedAt: this.bootedAt,
    },
    {
      name: "winnow:worker-0",
      role: "worker",
      busy: true,
      currentLabel: "決済APIの返金エンドポイントを実装",
      startedAt: this.bootedAt,
    },
  ];

  async init(): Promise<void> {}

  async dispatch(req: AiRequest): Promise<AiResult> {
    const started = Date.now();

    // 分類(control): キャプチャ直後にキューへ「要確認」で着地する様子を見せる。
    if (req.role === "control" && req.label.startsWith("分類")) {
      await sleep(1200);
      const data = {
        // 暫定タイトルでなければ classifier 側が無視するので、上書き目的では入れない。
        title: "",
        disposition: "escalate" as const,
        confidence: 0.58,
        reason: "外部に影響しうるため、着手前に一度あなたに確認します。",
        stakes: 0.5,
        reversibility: 0.6,
        kind: "leaf" as const,
        rung: "means" as const,
        process: "iterative" as const,
        uncertaintyResolved: false,
        executableReady: false,
        category: "確認",
      };
      return {
        ok: true,
        data,
        raw: JSON.stringify(data),
        sessionName: "winnow:control",
        durationMs: Date.now() - started,
      };
    }

    // 実行(worker): 承認後に「実行中→完了」と動いて見えるよう少し溜める。
    await sleep(1600);
    const data = {
      status: "succeeded" as const,
      summary: "返金エンドポイントを実装し、テストを通しました(デモ実行)。",
      output:
        "- POST /refunds に冪等キーを追加\n- 二重返金ガードを実装\n- test/refund.test.ts: 12 tests passed",
      reversible: true,
      rollbackPlan: "git revert <commit> でロールバック可能。本番反映は未実施。",
    };
    return {
      ok: true,
      data,
      raw: JSON.stringify(data),
      sessionName: "winnow:worker-0",
      durationMs: Date.now() - started,
    };
  }

  listSessions(): SessionInfo[] {
    return this.sessions;
  }

  async capture(sessionName: string): Promise<string> {
    if (sessionName.includes("control")) return CONTROL_VIEW;
    // 経過時間で1行ずつ開示→末尾で溜め→ループ。WS は 1 秒間隔で呼ぶ。
    const PER_LINE = 0.9; // 秒/行
    const HOLD = 6; // 末尾で溜める秒数
    const cycle = WORKER_LOG.length * PER_LINE + HOLD;
    const t = ((Date.now() - this.bootedAt) / 1000) % cycle;
    const shown = Math.min(WORKER_LOG.length, Math.floor(t / PER_LINE) + 1);
    return WORKER_LOG.slice(0, shown).join("\n");
  }

  attachCommand(sessionName: string): string {
    return `tmux attach -t ${sessionName}`;
  }

  async shutdown(): Promise<void> {}
}
