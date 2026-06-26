// Domain model — REQUIREMENTS §2 (ノード/リーフ, 抽象度ラダー, プロセス軸) and §3.1
// (item metadata). The vocabulary here is load-bearing: the whole point is that
// "task" is split so the classifier and executor don't misfire.

/** ノード=問い/意図 (割れるが直接実行不可) / リーフ=実行可能タスク (§2.1). */
export type Kind = "node" | "leaf";

/**
 * 抽象度ラダーの高度 (§2.2). 上段ほど量は少なく不可逆で人間的、下段ほど
 * 量が爆発し基準照合でさばける。数値が小さいほど上段(霧)。
 */
export const RUNGS = ["fog", "strategy", "tactic", "means", "execution"] as const;
export type Rung = (typeof RUNGS)[number];
// 表示語彙は Agile/Jira 文脈に寄せる (内部キーは不変、ラベルだけ差し替え)。
export const RUNG_LABEL: Record<Rung, string> = {
  fog: "テーマ",
  strategy: "イニシアチブ",
  tactic: "エピック",
  means: "ストーリー",
  execution: "タスク",
};

/** 三値仕分け (§3.2). 二値にすると「分からない」を表現できず盲点へ流す. */
export type Disposition = "auto" | "escalate" | "human";

/** プロセス軸 (§2.3) — ラダーと直交. */
export type Process = "waterfall" | "iterative";

/** 優先度。人間が手付けする (AIは触らない)。 */
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type ItemStatus =
  | "inbox" // 登録直後、未分類
  | "classified" // 分類済み、さばき待ち
  | "in_progress"
  | "review" // レビュー段 (§3.5 レビューをパイプラインに戻す)
  | "done"
  | "rejected"
  | "blocked";

export type ExecutionStatus =
  | "none"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "proposed" // 不可逆/高ステークス: 提案済み、人間のワンタップ承認待ち (§3.4)
  | "approved"
  | "cancelled"; // 取り消された自動実行 (§4-4 安く取り消せる)

export interface Item {
  id: string;
  title: string;
  body: string;
  kind: Kind;
  rung: Rung;
  parentId: string | null;
  orderIndex: number;
  status: ItemStatus;

  // 分類器の出力 (§3.2). null = 未分類.
  disposition: Disposition | null;
  confidence: number | null; // 0..1, 必ず出す (§4-2)
  reason: string | null; // 一行理由 (glanceable)
  stakes: number | null; // 0..1
  reversibility: number | null; // 0..1 (1=完全に可逆)
  category: string | null; // 基準率補正のバケット (§3.6-1)

  // raw* は分類器の生出力 (ルール・基準率補正・tightness/ゲートで上書きされる前の値)。
  // 較正母数 (category_stats) を汚染除去するための真実源。null = 未分類/レガシー。
  rawDisposition: Disposition | null;
  rawConfidence: number | null; // 0..1, clamp01後・tightness前
  // 環境不全 (classify失敗/JSON解析失敗/タイムアウト/dispatch不可) で安全側 escalate に
  // 倒した痕跡。較正母数に積まない判別と週次 failed 集計に使う。
  envEscalated: boolean;

  process: Process | null;
  uncertaintyResolved: boolean;

  // 監査・履歴用 (§3.1)
  autoExecuted: boolean;
  humanOverrode: boolean;
  auditSampled: boolean;

  executionStatus: ExecutionStatus;
  executionResult: string | null;

  // 実行成果物の分離保持 (§3.4)。executionResult は後方互換で連結文字列を維持し、
  // 以下は監査/取り消し提示のために分離して持つ。
  executionSummary: string | null; // general成果物の ExecuteOut.summary
  executionOutput: string | null; // general成果物本体 (ExecuteOut.output)
  rollbackPlan: string | null; // software実行の巻き戻し手順 (worker自己申告)
  declaredReversible: boolean | null; // worker が可逆と自己申告したか。null=未申告 (三値)
  artifacts: string | null; // 外部副作用 artifacts (自由文/URL配列) を JSON文字列で保持

  // 外部取り込み痕跡 (read-only、winnow は送出しない)。
  sourceUrl: string | null; // 取り込み元 URL/参照。null = 手入力
  externalKey: string | null; // 外部ソース由来の冪等キー (重複取り込み防止)

  // domain: ソフト開発タスクは実際にコードを動かす / 一般タスクは下書き提案 (§3.4)
  domain: "software" | "general";
  projectDir: string | null; // software実行時の作業ディレクトリ

  // タスク管理の器 (PjM要素)。
  projectId: string | null; // 所属する案件
  sprintId: string | null; // 割り当てられたスプリント (mode=sprint の案件のみ)
  dueDate: number | null; // 期日 (epoch ms)
  priority: Priority;

  createdAt: number;
  updatedAt: number;
}

/** 案件 (プロジェクト) — 最上位の束ね。関連する木をまとめる。 */
export interface Project {
  id: string;
  name: string;
  description: string;
  // 案件ビューの見せ方: board=状態カンバン / flow=優先度・期日順リスト。
  mode: "board" | "flow";
  status: "active" | "archived";
  // 案件固有の前提・文脈 (スタック/制約/関係者など)。分解・実行プロンプトに注入する。
  context: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * スプリント (時間箱) — 反復の単位 (§2.3 "学ぶために回し、出すために束ねる")。
 * 案件に属さない**グローバルな期間**。1スプリントに複数案件のタスクが混ざる。
 */
export interface Sprint {
  id: string;
  name: string;
  goal: string;
  startDate: number | null;
  endDate: number | null;
  status: "planned" | "active" | "completed";
  createdAt: number;
}

/**
 * 人間のさばき=ラベル (§4-1). 普段の一手がそのまま教師信号になる。
 * これがバイアスの少ない教師信号の唯一の源 (§3.6).
 */
export type LabelAction =
  | "do" // やる (= disposition human/escalate を是認して着手)
  | "demote" // 下段へ降ろす
  | "reclassify" // 分類し直す
  | "mute_category" // この種類はもう上げるな
  | "approve" // 不可逆実行を承認
  | "reject" // 却下
  | "override" // AI の仕分けを覆した
  | "audit_ok" // 監査: 自動処理は妥当だった
  | "audit_bad"; // 監査: 自動処理は誤りだった (過小エスカレーション検出)

export interface LabelEvent {
  id: string;
  itemId: string;
  action: LabelAction;
  fromDisposition: Disposition | null;
  toDisposition: Disposition | null;
  category: string | null;
  note: string | null;
  createdAt: number;
}

/**
 * 明示ルール (§3.6-1). 先にルールを置き、残差だけ学ぶ。
 * source=learned は基準率補正がカウントから倒したもの。
 */
export interface Rule {
  id: string;
  category: string;
  forcedDisposition: Disposition;
  source: "manual" | "learned";
  active: boolean;
  note: string | null;
  createdAt: number;
}

/** カテゴリ別 基準率補正のカウント (§3.6-1 "浅くて頑健"). */
export interface CategoryStat {
  category: string;
  aiDisposition: Disposition;
  // confidenceビン (0..4 = floor(rawConfidence*5) clamp4)。PRIMARY KEY は
  // (category, aiDisposition, confBin)。既存集計は全ビン SUM で後方互換。
  confBin: number;
  agreed: number; // 人間が是認
  overturned: number; // 人間が覆した (全方向)
  overturnedToAuto: number; // escalate を auto へ覆した分だけ (§3.6-3 緩める判定の分子)
}

export interface ExecutionJob {
  id: string;
  itemId: string;
  role: "control" | "worker";
  kindOfWork: "classify" | "decompose" | "promote" | "execute";
  sessionName: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  output: string | null;
  error: string | null;
  // dispatch時の req.id (IPC相関ID)。起動時 reconcile が running ジョブの done
  // sentinel を決定論で特定するため。null = レガシー (reconcile は sentinel 探索 skip)。
  ipcId: string | null;
  createdAt: number;
}

export interface Settings {
  // 監査サンプル率 N% (§3.6-2, §4-3). 節約したい注意を意図的に少額払う。
  auditRate: number; // 0..1
  // 再調律スライダー (§4 末). 高いほど締める(エスカレ寄り)、低いほど緩める(自動寄り).
  // 信号の非対称 (§3.6-3): 締めるのは速く、緩めるのは慎重に。
  escalationTightness: number; // 0..1
  // worker セッション上限 (§6 クォータ天井).
  maxWorkers: number;
  // claude 起動コマンド (ローカル環境ごとに調整可能).
  // 既定は --permission-mode auto。許可プロンプトなしで自動実行しつつ、claude 側の
  // 分類器が各アクションを事前審査し危険操作 (curl|bash, main への force push,
  // git reset --hard, 機微データ送信, 本番デプロイ等) はブロックする安全網付き automode。
  // tmux 常駐セッションがプロンプト待ちで詰まる事故を避けつつ事故も抑えられる。
  // auto は Claude Code v2.1.83+ / Opus 4.6+ ・Sonnet 4.6+ 等が要件 (Sonnet 4.5/Haiku 非対応)。
  // 許可確認を残したい場合は GUI から "claude --permission-mode acceptEdits"、
  // 逆に安全網ごと全バイパスしたい隔離環境では "claude --dangerously-skip-permissions" に変更する。
  claudeControlCmd: string;
  claudeWorkerCmd: string;
  // ヘッドレス(claude -p)で動かすdevモード。将来課金リスクありだが検証は速い。
  useHeadless: boolean;
  // プロダクト全体の前提 (何を作っている/スタック/規約/方針)。上段への鋭い投資は
  // 下段で複利で効く (§2.2)。分類・分解・実行プロンプト全部に注入する。
  productContext: string;

  // 自動実行の一時停止スイッチ (§3.6-3 の手動版)。true で自動経路 (キュー掃き出し
  // ループ・classify末尾の即時着火・capture sweep) を抑止。approve (手動承認) は通す。
  // default=false で現状維持。締めるのは速く。
  pauseAuto: boolean;
  // learned auto rule カテゴリに恒常維持する最低監査率。通常 auditRate より高く緩めた
  // 境界を継続監視。rollAudit が max(auditRate, learnedAuditFloor) を採る。
  learnedAuditFloor: number; // 0..1
  // learned auto rule tip直後の一時監査引き上げ期間 (既定1週間)。
  tipProbationMs: number; // ms
  // tip直後 probation 期間中の引き上げ監査率。
  tipProbationRate: number; // 0..1
  // confidenceビン較正を発火させる最小サンプル数 (ビン単位)。これ未満は補正しない。
  binCalibrationMinSamples: number; // int
  // ビン実 overturn 率が申告を上回る乖離閾値。これ超で当該カテゴリの requiredConf を締め側に補正。
  binOverturnGap: number; // 0..1
  // claudeControlCmd/WorkerCmd を PATCH で書き換える際に許可するトークン集合 (RCE面を閉じる)。
  claudeAllowedFlags: string[];
  // 過負荷時に capture を即 classify せず inbox 保留にする閾値。0 で無効=現状維持。
  captureInboxHoldThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
  auditRate: 0.15,
  escalationTightness: 0.7, // コールドスタートは保守的=締め気味 (§4 末, §5)
  maxWorkers: 2,
  claudeControlCmd: "claude --permission-mode auto",
  claudeWorkerCmd: "claude --permission-mode auto",
  useHeadless: false,
  productContext: "",
  pauseAuto: false,
  learnedAuditFloor: 0.25,
  tipProbationMs: 604_800_000, // 1週間
  tipProbationRate: 0.5,
  binCalibrationMinSamples: 8,
  binOverturnGap: 0.25,
  claudeAllowedFlags: [
    "--permission-mode",
    "auto",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "-p",
    "--output-format",
    "json",
    "--model",
    "sonnet",
    "opus",
    "haiku",
    "plan",
    "default",
  ],
  captureInboxHoldThreshold: 24,
};
