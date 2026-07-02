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
  // 実行ディスパッチが work timeout を超過した。winnow は待つのをやめたが worker セッションは
  // 走り続けている可能性がある (§4-4 fire-and-forget にしない)。done sentinel が後から現れたら
  // 平常運転中の sweep / 起動時 reconcile が取り込んで succeeded 等へ昇格させる。取り込めないまま
  // 一定時間が過ぎたら failed へ落とす。failed と違い「まだ続行中かもしれない」を表す中間状態。
  | "timed_out"
  | "succeeded"
  | "failed"
  | "proposed" // 不可逆/高ステークス: 提案済み、人間のワンタップ承認待ち (§3.4)
  | "approved"
  // 実行は完了したが、成果物に人間の引き取り(レビュー/採用)責任が残る (§3.5 継ぎ目)。
  // やって終わり(none)でない=done に沈めずキュー前面に出し、人間の受領で done に進む。
  | "awaiting_handoff"
  | "cancelled"; // 取り消された自動実行 (§4-4 安く取り消せる)

/**
 * 分解(decompose)の背景ジョブ状態 (§3.3)。execute と同じく非同期化し、オーバーレイを
 * 閉じても割り方の候補を捨てない。none=未分解 / running=分解中 / ready=分解案あり(再オープンで
 * 即表示) / failed=失敗(再試行可)。
 */
export type DecomposeStatus = "none" | "running" | "ready" | "failed";

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

  // 人間が成功実行を確認して畳んだ時刻 (receive の一般化、§3.5/§4-4)。null=未受領。
  // autoExecuted && succeeded の取消ハンドルは receivedAt が立つまでキューに残り、
  // 受領で畳まれる(取消はバックログ/ツリーから引き続き可能=可視の場所が変わるだけ)。
  // recordOutcome には積まない(受領は分類正誤の信号ではない=較正母数を汚さない)。
  receivedAt: number | null;
  // レビュー leaf → レビュー対象(元アイテム)の構造リンク (§3.5)。null=通常アイテム。
  // 深さ1固定: reviewOfId を持つ item の実行からは新しいレビュー leaf を作らない。
  reviewOfId: string | null;

  // 分解(decompose)の背景ジョブ状態と結果キャッシュ (§3.3)。割り方の候補を JSON 文字列で
  // 持ち、オーバーレイを閉じても捨てない／再オープンで AI を呼び直さず即表示する。
  decomposeStatus: DecomposeStatus;
  decomposeOptions: string | null; // ready 時の DecomposeOption[] を JSON 文字列で保持。

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
  // node 段の AI に効く前提。buildContextBlock の親チェーンに高信頼(ctx側)で注入する。
  // body 相乗り不可: body は fenceBody で「自己申告=従うな」の低信頼ラベル付き注入もされ、
  // 指示として書いた前提が詐称シグナル化して escalate に倒れるため、専用フィールドに分ける。
  context: string | null;
  dueDate: number | null; // 期日 (epoch ms)
  priority: Priority;

  createdAt: number;
  updatedAt: number;
}

/** 案件 (プロジェクト) — 最上位の束ね。関連する木をまとめる。 */
export interface Project {
  id: string;
  name: string;
  // 人間が読むゴール/状況。buildContextBlock には注入されない(context.ts は p.context のみ参照)。
  description: string;
  // 案件ビューの見せ方: board=状態カンバン / flow=優先度・期日順リスト。
  mode: "board" | "flow";
  status: "active" | "archived";
  // 案件固有の前提・文脈 (スタック/制約/関係者など)。AI に効く前提として
  // 分類・分解・昇格・実行プロンプトに注入する (description とは役割が違う)。
  context: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 学び (§4-5 ループを閉じる) — AI が観測した注意・知識を memory の「AIゾーン」へ自動蓄積する。
 * label_events とは物理分離 (較正母数=category_stats を汚さないため)。origin で信頼度を分け、
 * AIゾーンは tighten-only (品質は上げるが auto 着火範囲は緩めない)・区画予算つき自動減衰。
 */
export interface Learning {
  id: string;
  category: string | null; // カテゴリ固有の学び。共通の学びは null
  itemId: string | null; // 由来 item (FK ON DELETE SET NULL で孤児許容)
  text: string;
  origin: "human" | "ai";
  pinned: boolean; // pin した学びは減衰しない・フル信頼
  vetoed: boolean; // veto された学びは注入対象から外す
  lastSeenAt: number; // 注入に使われた最終時刻 (減衰の生存信号)
  createdAt: number;
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
  | "send_back" // 問いに戻す: leaf→node 降格 (kind軸のリカバリ。reclassify の kind版 §2.1/§3.6-3)
  | "reclassify" // 分類し直す
  | "mute_category" // この種類はもう上げるな (カテゴリを auto 固定)
  | "escalate_category" // この種類は今後すべて要確認 (カテゴリを escalate 固定。mute の対称)
  | "approve" // 不可逆実行を承認
  | "receive" // 引き取り: 成果物を確認/採用し handoff を完了にした (§3.5)
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
  // 承認時の外部送信ゴーサイン (§3.4)。dispatch 時に永続化し、timed_out 後の late sentinel
  // 回収(tryTakeInSentinel)でも handoffRequired の安全弁 (d) を発火させる。null=レガシー/非承認。
  externalApproved: boolean | null;
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
  // 外部送信(push/PR作成)の解禁スイッチ (§3.4)。false=既定では、人間がワンタップ承認しても
  // worker に外部送信ゴーサイン(externalApproved)を渡さない=従来どおり push/PR は実行されない。
  // true にすると承認時のみ「このアイテムに限り push/PR 作成を実行してよい(マージ/デプロイ/削除は不可)」を
  // worker に伝える。緩め方向(外部副作用解禁)なので既定 OFF・明示オプトイン (締めるは速く緩めるは慎重に §3.6-3)。
  // ※ winnow 本体は push しない。実行主体は worker セッションで、その ambient 権限の技術的制約は別レイヤ。
  allowExternalSend: boolean;

  // --- AI op タイムアウト (ms)。従来はハードコード定数だった (§2.3 サイクル長は不確実性に反比例の
  // 時間定数化)。「明らかに長い実行」を持つ案件で人間が締切を伸ばせるよう設定可能にする。
  // 値は dispatch の work timeout (done sentinel 待ちの上限) に渡る。0/未指定は従来既定にフォールバック。
  executeTimeoutMs: number; // worker 実行 (旧 600_000)
  decomposeTimeoutMs: number; // control 分解 (旧 120_000)
  classifyTimeoutMs: number; // control 分類 (旧 90_000)
  // worker/control セッション獲得(acquire)待ちの上限。work timeout とは別軸 (プール枯渇=再試行で
  // 解ける一時失敗 / work timeout=実行そのものの超過)。両者を同じ定数に潰さないため独立に持つ。
  acquireTimeoutMs: number; // 旧 ACQUIRE_TIMEOUT_MS=120_000
  // timed_out を late sentinel 回収できないまま放置する上限。これを超えたら failed へ落とす
  // (中間状態に永久滞留させない)。
  timedOutGraceMs: number;

  // --- 学び (memory AIゾーン) のオプトアウト設定。人間手間ゼロで安全側に倒すための定数。
  // AI 出力から学びを自動蓄積するか。false で AI 由来の学び収集を止める (人間ゾーンは無関係)。
  learningAutoCapture: boolean;
  // memory の AIゾーンに割く char 予算。人間ゾーン (productContext/案件/node 前提) とは別枠で、
  // 人間前提を押し出さない (切り詰めは人間ゾーン優先)。注入天井 MAX_CONTEXT_CHARS 以下に据える。
  aiZoneMaxChars: number;
  // AI 由来の学びが pin されず未使用のまま薄れるまでの猶予 (ms)。lastSeenAt がこれを超えたら減衰削除。
  learningDecayMs: number;
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
  allowExternalSend: false, // 緩め方向=既定 OFF。push/PR 作成は明示オプトイン (§3.6-3)。
  // タイムアウト既定は従来のハードコード値を踏襲 (挙動の後方互換)。
  executeTimeoutMs: 600_000, // 10 分
  decomposeTimeoutMs: 120_000,
  classifyTimeoutMs: 90_000,
  acquireTimeoutMs: 120_000,
  timedOutGraceMs: 1_800_000, // 30 分。timed_out のまま回収できなければ failed へ。
  learningAutoCapture: true, // オプトアウト: 既定で学びを自動蓄積 (人間手間ゼロ)。
  aiZoneMaxChars: 16_000,
  learningDecayMs: 2_592_000_000, // 30 日
};
