import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as actions from "../actions.js";
import { ensureDriver, getDriver, resetDriver } from "../ai/index.js";
import { captureItem, captureSchema } from "../capture.js";
import { classify } from "../classifier.js";
import * as decomposer from "../decomposer.js";
import * as executor from "../executor.js";
import * as promotion from "../promotion.js";
import { autoFoldedCount, queue } from "../queue.js";
import {
  categoryStats,
  importData,
  items,
  jobs,
  labels,
  learnings,
  projects,
  rules,
  settings,
  sprints,
} from "../repo.js";
import { getRuntimeState } from "../runtime-state.js";
import { decayLearnings } from "../learning.js";
import { horizonView } from "../horizon.js";
import { weekly } from "../summary.js";
import { validateClaudeCmd } from "../security.js";
import { redactSecrets } from "../context.js";
import { validateProjectDir } from "../paths.js";
import { SCHEMA_VERSION } from "../db.js";
import { SERVER_PORT } from "../config.js";

// Run a possibly-long AI op in the background; the UI reflects progress by
// polling /api/state (job + item status are persisted as it runs).
function background(fn: () => Promise<unknown>): void {
  fn().catch((e) => console.error("[winnow] background op failed:", e));
}

// 自動着火 (§3.4/§0): キューを開くたびに、未着手の可逆リーフ自動アイテムを
// 点火する。overlapする /api/state ポーリングからの二重起動を防ぐため、
// 起動中の id を保持して重複ディスパッチをスキップする。
const igniting = new Set<string>();

// inbox 保留のドレイン (§3.4 キュー開封発火に相乗り)。capture が過負荷で classify を発火せず
// inbox に積んだ未分類 Item を、キュー開封(=/api/state 取得)時に sweep して classify を背景発火する。
// WIP天井(worker資源・igniting Set)とは別資源(control 直列)・別ループ・別 Set で管理する
// (両 Set を混同しない。budget は worker 専用で classify には適用しない)。
const classifying = new Set<string>();

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // One-shot snapshot powering the whole UI.
  app.get("/api/state", async (req) => {
    // 仕分け済みの自動アイテムはキューを開いた瞬間に走り出す (待ち行列を作らない)。
    // requestExecution が自己ガードする: executionStatus!=="none" は弾き、
    // 不可逆/高ステークスは proposed に回すので、ここでの追加ゲートは不要。
    // 監査サンプル済みも除外しない: 自動実行しつつキューにも出して見分けの効く
    // 監査を混入させる (§4-3, queue.ts のフィルタが面倒を見る)。
    //
    // WIP/worker 天井: 同時 in-flight が maxWorkers を超えないよう、点火可能枠を予算化する。
    // budget = maxWorkers - 実行中 - 今ポーリングで点火中(igniting)。超過分は次の /api/state
    // ポーリングまで待たせる(break)。igniting.size を差し引いて同一ポーリング内の過剰点火を防ぐ。
    const cfg = settings.get();
    const { running } = executor.inFlightCount();
    let budget = Math.max(0, cfg.maxWorkers - running - igniting.size);
    for (const it of items.all()) {
      if (
        it.status === "classified" &&
        it.kind === "leaf" &&
        it.disposition === "auto" &&
        it.executionStatus === "none" &&
        // 一度でも worker が走った項目は自動では再点火しない(他の自動再点火経路
        // resumePausedAuto / 在庫再適用 / 案件割当 sweep と同じガード)。これが無いと、
        // needs_human 提案の「取り消し→undo」で disposition=auto に復元された項目や
        // escalate 終端後に人間が auto へ再分類した項目が、worker が「人間の判断が要る」と
        // 申告した直後に無承認で自動再実行される。再実行は人間の明示タップ(manual)で。
        !it.autoExecuted &&
        !igniting.has(it.id)
      ) {
        if (budget <= 0) break;
        igniting.add(it.id);
        budget--;
        background(() =>
          executor.requestExecution(it.id).finally(() => igniting.delete(it.id)),
        );
      }
    }
    // inbox 保留のドレイン: 過負荷で classify を発火せず inbox に積まれた未分類 Item
    // (status==='inbox' && disposition===null) をキュー開封時に classify 背景発火する。
    // 別ループ・別 Set(classifying)で二重発火を防ぐ。control 直列なので budget は適用しない
    // (失敗=escalate とバックプレッシャ=inbox 保留→開封時 sweep ドレインを区別する §3.4)。
    for (const it of items.all()) {
      if (it.status === "inbox" && it.disposition === null && !classifying.has(it.id)) {
        classifying.add(it.id);
        background(() => classify(it.id).finally(() => classifying.delete(it.id)));
      }
    }
    // timed_out の late sentinel 回収 (proposal 2): work timeout 後に worker が完了して done
    // sentinel を書いていれば、再起動を待たず取り込んで succeeded 等へ昇格させる。猶予超過分は
    // failed へ落とす。AI 非起動の read-only/同期処理だが、/api/state 応答を妨げないよう背景発火する。
    background(async () => {
      executor.sweepLateExecutions();
      // memory AIゾーンの自動減衰: 未使用・未 pin の AI 学びを薄れさせる (read-only sweep に相乗り)。
      decayLearnings();
    });
    return {
      items: items.all(),
      queue: queue(),
      autoFolded: autoFoldedCount(),
      settings: settings.get(),
      sessions: getDriver().listSessions(),
      summary: weekly(),
      rules: rules.all(),
      recentJobs: jobs.recent(30),
      projects: projects.all(),
      sprints: sprints.all(),
      // memory AIゾーンの学び (俯瞰面で veto/pin するため全件。較正母数とは無関係の read-only)。
      learnings: learnings.forProject(),
      // 中長期 horizon (rung×due、子→親 due 巻き上げ、上段ぼかし。read-only・件数進捗なし)。
      horizon: horizonView(),
      // 起動時 preflight/reconcile の痕跡と in-flight 集計(実行中N/承認待ちM)。表示は Batch6。
      runtime: getRuntimeState(),
      inFlight: executor.inFlightCount(),
      // Batch6 UI が消費する薄い追加: AI 未接続バナー/cold-banner 初日/MCP スニペット/直近捕獲。
      // preflight: runtime の tmux/claude チェックを {ok,reason} に畳む (未チェック時は ok=true)。
      preflight: ((): { ok: boolean; reason: string | null } => {
        const pf = getRuntimeState().preflight;
        const ok = pf.tmuxOk && pf.claudeOk;
        return { ok, reason: ok ? null : (pf.note ?? "AI 接続を確認できません") };
      })(),
      totalLabels: labels.total(),
      captureStats: items.captureStats(),
      // MCP 接続先 (read-only。ローカル claude が capture を直接投げる正規経路 /mcp)。
      // 受信 Host を反射しない: /mcp はローカル直結が正 (リモート公開時は loopback 限定になるため、
      // HTTPS プロキシ越しに公開ホスト名を見せると誤った接続先を案内してしまう)。
      mcpEndpoint: `http://localhost:${SERVER_PORT}/mcp`,
    };
  });

  // --- items CRUD -----------------------------------------------------------
  // 「雑に貼る」入口は capture サービスに一本化 (REST と MCP が同じ経路を通る)。
  app.post("/api/items", async (req) => captureItem(captureSchema.parse(req.body)));

  // 汎用更新。人間が手で編集してよいのは編集系フィールドのみ。
  // 分類器/較正フィールド (disposition/confidence/reason/stakes/reversibility/category/
  // rawDisposition/rawConfidence) は意図的に除外する=背骨「口はバカ・分類器が賢い」の機械的強制
  // (人間が disposition=auto を直書きして分類器/監査をバイパスし auto-leaf を注入する穴を塞ぐ)。
  // disposition の人間変更は POST /api/items/:id/action(reclassify) に一本化されている
  // (label_event + recordOutcome を出す唯一の正規路なので機能欠落なし)。
  // 監査/自動化/来歴 (auditSampled/humanOverrode/autoExecuted/executionStatus/executionResult/
  // createdAt/updatedAt/id) も従来どおり除外。.strict() で範囲外キーは 400。
  const patchSchema = z
    .object({
      title: z.string().min(1).optional(),
      body: z.string().optional(),
      kind: z.enum(["node", "leaf"]).optional(),
      rung: z.enum(["fog", "strategy", "tactic", "means", "execution"]).optional(),
      parentId: z.string().nullable().optional(),
      orderIndex: z.number().optional(),
      status: z
        .enum(["inbox", "classified", "in_progress", "review", "done", "rejected", "blocked"])
        .optional(),
      process: z.enum(["waterfall", "iterative"]).nullable().optional(),
      domain: z.enum(["software", "general"]).optional(),
      projectDir: z.string().nullable().optional(),
      projectId: z.string().nullable().optional(),
      sprintId: z.string().nullable().optional(),
      dueDate: z.number().nullable().optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      // 楽観ロック (If-Unmodified-Since 相当)。未指定=チェックしない=現状維持(後方互換)。
      expectedUpdatedAt: z.number().optional(),
    })
    .strict();
  app.patch("/api/items/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { expectedUpdatedAt, ...patch } = patchSchema.parse(req.body);
    const cur = items.get(id);
    if (!cur) return reply.code(404).send({ error: "not found" });
    // 楽観ロック: その間に他所で変わっていれば 409 で弾く(全列上書きの黙った巻き戻り防止)。
    if (expectedUpdatedAt !== undefined && cur.updatedAt !== expectedUpdatedAt) {
      return reply.code(409).send({ error: "stale", current: cur });
    }
    // projectDir 検証: 絶対パス必須・realpath 化・機微パス拒否。不正は 400。
    // (capture/decompose は escalate に倒すが、ここは人間の直接編集なので即時 400 で気づかせる。)
    if (patch.projectDir !== undefined) {
      const v = validateProjectDir(patch.projectDir);
      if (v.escalate) return reply.code(400).send({ error: v.reason ?? "invalid projectDir" });
      patch.projectDir = v.dir;
    }
    // 引き取り待ちへの「完了」指定(Kanban DnD / 一覧の status セレクト)は受領(receive)の意味。
    // 生 PATCH で status=done だけ書くと status=done × executionStatus=awaiting_handoff という
    // 修復不能な不整合(キュー/引き取り待ちKに残り続ける)を作るため、acceptHandoff に
    // ルーティングして receive ラベルも正規に残す。他フィールドの更新は先に適用する。
    if (patch.status === "done" && cur.executionStatus === "awaiting_handoff") {
      const { status: _status, ...rest } = patch;
      if (Object.keys(rest).length) items.update(id, rest);
      return actions.acceptHandoff(id);
    }
    return items.update(id, patch);
  });

  app.delete("/api/items/:id", async (req) => {
    const { id } = req.params as { id: string };
    const r = items.remove(id);
    return { ok: true, deleted: r.deleted };
  });

  app.get("/api/items/:id/labels", async (req) => {
    const { id } = req.params as { id: string };
    return labels.forItem(id);
  });

  // この項目を案件に昇格 (§3.3 上流の問いを案件の入れ物に格上げ)。
  // 案件(入れ物)を項目名で作り、その項目とサブツリー全部を新案件に紐付ける。
  app.post("/api/items/:id/to-project", async (req) => {
    const { id } = req.params as { id: string };
    const item = items.get(id);
    if (!item) return { error: "not found" };
    const project = projects.create({ name: item.title, mode: "board" });
    // サブツリー収集
    const all = items.all();
    const childrenOf = new Map<string, string[]>();
    for (const it of all) {
      if (it.parentId) {
        const arr = childrenOf.get(it.parentId) ?? [];
        arr.push(it.id);
        childrenOf.set(it.parentId, arr);
      }
    }
    const ids: string[] = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const c of childrenOf.get(ids[i]!) ?? []) ids.push(c);
    }
    for (const itemId of ids) items.update(itemId, { projectId: project.id });
    // 案件に属したことで案件文脈(project.context)が分類に効くようになる。
    // まださばかれていない(inbox/classified)かつ未実行の項目だけ再分類に流し、
    // 案件前提を踏まえた仕分けへ更新する。done/in_progress/実行済みは触らない
    // (進行中の作業や履歴・教師信号を乱さない)。control は直列なので背景で順に処理。
    // 「実行済み」の判定は executionStatus だけでは足りない: 承認後 needs_human の
    // escalate 終端(executor.applyExecuteResult repeat)は classified+none に戻すため、
    // executionStatus のみだと終端項目を再分類→auto 復帰→無承認の自動再実行まで
    // 連鎖しうる。autoExecuted(一度でも worker が走った)で除外する。
    let reclassified = 0;
    for (const itemId of ids) {
      const it = items.get(itemId);
      if (
        it &&
        (it.status === "inbox" || it.status === "classified") &&
        it.executionStatus === "none" &&
        !it.autoExecuted
      ) {
        reclassified++;
        background(() => classify(itemId));
      }
    }
    return { project, assigned: ids.length, reclassified };
  });

  // --- AI ops ---------------------------------------------------------------
  app.post("/api/items/:id/classify", async (req) => {
    const { id } = req.params as { id: string };
    return (await classify(id)) ?? { error: "not found" };
  });

  // decompose も execute 同様に長くなりうるのでバックグラウンド化。UIは /api/state を
  // ポーリングし item.decomposeStatus/decomposeOptions で進捗と結果を映す(オーバーレイを
  // 閉じても候補を捨てない・再オープンで即表示)。
  app.post("/api/items/:id/decompose", async (req) => {
    const { id } = req.params as { id: string };
    background(() => decomposer.propose(id));
    return { started: true };
  });

  const applySchema = z.object({
    option: z.object({
      label: z.string(),
      rationale: z.string(),
      process: z.enum(["waterfall", "iterative"]),
      children: z.array(
        z.object({
          title: z.string(),
          kind: z.enum(["node", "leaf"]),
          rung: z.enum(["fog", "strategy", "tactic", "means", "execution"]),
          spec: z.string().optional().default(""),
          projectDir: z.string().optional(), // polyrepo: 別repoの子だけ作業ディレクトリ。省略=親継承。
        }),
      ),
    }),
  });
  app.post("/api/items/:id/decompose/apply", async (req) => {
    const { id } = req.params as { id: string };
    const { option } = applySchema.parse(req.body);
    return { created: await decomposer.applyOption(id, option) };
  });

  app.post("/api/items/:id/promote", async (req) => {
    const { id } = req.params as { id: string };
    return (await promotion.judge(id)) ?? { error: "not found" };
  });

  // execute は長くなりうるのでバックグラウンド。UIは /api/state をポーリング。
  // 任意 instruction: general成果物の『この方向で直す』(一行指示→同じ execute 再走)。
  // 未指定=従来の execute と同一 (後方互換)。
  const executeSchema = z.object({ instruction: z.string().optional() }).strict();
  app.post("/api/items/:id/execute", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body ? executeSchema.parse(req.body) : {};
    // 人間のワンタップ実行/再実行は manual:true で呼ぶ → pauseAuto ガードを回避する
    // (手動アクションは止めない=非対称)。自動経路(/api/state 掃き出し)は manual を渡さない。
    background(() => executor.requestExecution(id, body.instruction ?? "", { manual: true }));
    return { started: true };
  });
  app.post("/api/items/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    background(() => actions.approve(id));
    return { started: true };
  });
  app.post("/api/items/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return (await executor.cancelExecution(id)) ?? { error: "not found" };
  });
  // 引き取り(handoff)の受領: awaiting_handoff の成果物を人間が確認/採用し完了へ進める (§3.5)。
  app.post("/api/items/:id/accept", async (req) => {
    const { id } = req.params as { id: string };
    return (await actions.acceptHandoff(id)) ?? { error: "not found" };
  });

  // --- 処分=ラベル -----------------------------------------------------------
  const actionSchema = z.object({
    action: z.enum(["do", "demote", "send_back", "reclassify", "mute_category", "reject"]),
    to: z.enum(["auto", "escalate", "human"]).optional(),
  });
  app.post("/api/items/:id/action", async (req) => {
    const { id } = req.params as { id: string };
    const { action, to } = actionSchema.parse(req.body);
    switch (action) {
      case "do":
        return actions.doIt(id);
      case "demote":
        return actions.demote(id);
      case "send_back":
        return (await actions.sendBack(id)) ?? { error: "not found" };
      case "reclassify":
        return actions.reclassify(id, to ?? "escalate");
      case "mute_category":
        return actions.muteCategory(id);
      case "reject":
        return actions.reject(id);
    }
  });

  app.post("/api/items/:id/audit", async (req) => {
    const { id } = req.params as { id: string };
    const { ok } = z.object({ ok: z.boolean() }).parse(req.body);
    return actions.auditConfirm(id, ok);
  });

  // 処分=ラベルの Undo (直近1手の逆適用) と、即締め(muteCategory の対称)。
  app.post("/api/items/:id/undo-label", async (req) => {
    const { id } = req.params as { id: string };
    return actions.undoLastLabel(id) ?? { error: "not found" };
  });
  app.post("/api/items/:id/escalate-category", async (req) => {
    const { id } = req.params as { id: string };
    return actions.escalateCategory(id) ?? { error: "not found" };
  });

  // --- sessions (terminal theater) -----------------------------------------
  // 既知 session(listSessions の window 集合)だけを許可する照合。WS(index.ts)と同じ照合を
  // REST にも掛け、任意 tmux ターゲットへの capture 注入を塞ぐ(WS で閉じた穴の REST 側非対称を解消)。
  const isKnownSession = (name: string): boolean =>
    new Set(getDriver().listSessions().map((s) => s.name)).has(name);
  app.get("/api/sessions", async () => getDriver().listSessions());
  app.get("/api/sessions/:name/capture", async (req, reply) => {
    const { name } = req.params as { name: string };
    const decoded = decodeURIComponent(name);
    if (!isKnownSession(decoded)) return reply.code(404).send({ error: "unknown session" });
    return { text: await getDriver().capture(decoded) };
  });
  app.get("/api/sessions/:name/attach", async (req, reply) => {
    const { name } = req.params as { name: string };
    const decoded = decodeURIComponent(name);
    if (!isKnownSession(decoded)) return reply.code(404).send({ error: "unknown session" });
    return { command: getDriver().attachCommand(decoded) };
  });
  app.post("/api/ai/init", async () => {
    await ensureDriver();
    return { sessions: getDriver().listSessions() };
  });

  // --- settings / 再調律スライダー ------------------------------------------
  // claudeAllowedFlags 自体は PATCH 対象に含めない=許可リスト緩めの穴を作らない(非対称:
  // 締めるのは速く、緩めるは慎重に。緩めたい時はコード/DB 直編集)。
  const settingsSchema = z
    .object({
      auditRate: z.number().min(0).max(1).optional(),
      escalationTightness: z.number().min(0).max(1).optional(),
      maxWorkers: z.number().int().min(1).max(8).optional(),
      claudeControlCmd: z.string().optional(),
      claudeWorkerCmd: z.string().optional(),
      useHeadless: z.boolean().optional(),
      productContext: z.string().optional(),
      pauseAuto: z.boolean().optional(),
      // 外部送信(push/PR作成)の解禁。既定 OFF=緩めはオプトイン (§3.6-3)。
      allowExternalSend: z.boolean().optional(),
      // AI op タイムアウト (ms)。「明らかに長い実行」を持つ環境で締切を伸ばせるよう設定可能化。
      // 上限ガード付き(極端値でプール占有が長期化するのを防ぐ)。acquire は work timeout と別軸。
      executeTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
      decomposeTimeoutMs: z.number().int().min(15_000).max(900_000).optional(),
      classifyTimeoutMs: z.number().int().min(15_000).max(900_000).optional(),
      acquireTimeoutMs: z.number().int().min(5_000).max(900_000).optional(),
      timedOutGraceMs: z.number().int().min(60_000).max(86_400_000).optional(),
    })
    .strict();
  app.patch("/api/settings", async (req, reply) => {
    const patch = settingsSchema.parse(req.body);
    // 起動コマンド許可リスト: 先頭トークン=claude 固定 + settings.claudeAllowedFlags 内のトークンのみ。
    // RCE 面(任意コマンド注入)を閉じる。範囲外トークンを含む更新は 400。
    const allowed = settings.get().claudeAllowedFlags;
    for (const key of ["claudeControlCmd", "claudeWorkerCmd"] as const) {
      const cmd = patch[key];
      if (cmd !== undefined && !validateClaudeCmd(cmd, allowed)) {
        return reply.code(400).send({ error: `disallowed command tokens in ${key}` });
      }
    }
    // pauseAuto の true→false 遷移で、pause 中に proposed へ倒れた自動項目を再投入する
    // (全ゲート再通過=安全側。文言「再開するか」と実装の食い違いを解消)。遷移時のみ発火し、
    // false→false の再送でゲート待ち項目の executionResult/updatedAt を無駄に洗い替えない。
    const wasPaused = settings.get().pauseAuto;
    const updated = settings.update(patch);
    if (patch.useHeadless !== undefined) resetDriver(); // ドライバ選択をやり直す
    if (wasPaused && patch.pauseAuto === false) {
      background(async () => {
        executor.resumePausedAuto();
      });
    }
    return updated;
  });

  // --- export / import (版数付き JSON・空DB復元限定) -------------------------
  // GET /api/export: 全テーブルを版数付き JSON で書き出す(read-only、winnow は外部送出しない)。
  // boolean は SQLite 由来の 0/1 のまま往復させる(import の直 INSERT が同じ表現で書き戻す)。
  // 伏字化: context.ts の最終ゲートが止める秘密が export 経由で素通しになる穴を塞ぐ。
  // 最低限 productContext / claude*Cmd と items.body を redactSecrets に通す。
  app.get("/api/export", async () => {
    const s = settings.get();
    const redactedSettings = {
      ...s,
      productContext: redactSecrets(s.productContext ?? ""),
      claudeControlCmd: redactSecrets(s.claudeControlCmd ?? ""),
      claudeWorkerCmd: redactSecrets(s.claudeWorkerCmd ?? ""),
    };
    const redactedItems = items.all().map((it) => ({
      ...it,
      body: typeof it.body === "string" ? redactSecrets(it.body) : it.body,
      // node 段メモリも body 同様に export 経路で伏字化 (注入時の最終ゲートと対称)。
      context: typeof it.context === "string" ? redactSecrets(it.context) : it.context,
    }));
    const redactedLearnings = learnings.all().map((l) => ({
      ...l,
      text: typeof l.text === "string" ? redactSecrets(l.text) : l.text,
    }));
    return {
      version: SCHEMA_VERSION,
      exportedAt: Date.now(),
      data: {
        items: redactedItems,
        labels: labels.all(),
        rules: rules.all(),
        categoryStats: categoryStats.all(),
        projects: projects.all(),
        sprints: sprints.all(),
        learnings: redactedLearnings,
        jobs: jobs.recent(1_000_000),
        settings: redactedSettings,
      },
    };
  });

  // POST /api/import: 空DB復元限定(merge 禁止)。items/projects 件数 0 で「空」と判定
  // (settings seed 行は db.ts が必ず作るので判定に含めない)。版数照合の上、復元する。
  const importSchema = z.object({
    version: z.number(),
    data: z.object({
      items: z.array(z.record(z.unknown())).optional(),
      labels: z.array(z.record(z.unknown())).optional(),
      rules: z.array(z.record(z.unknown())).optional(),
      categoryStats: z.array(z.record(z.unknown())).optional(),
      projects: z.array(z.record(z.unknown())).optional(),
      sprints: z.array(z.record(z.unknown())).optional(),
      learnings: z.array(z.record(z.unknown())).optional(),
      jobs: z.array(z.record(z.unknown())).optional(),
      settings: z.record(z.unknown()).optional(),
    }),
  });
  app.post("/api/import", async (req, reply) => {
    const payload = importSchema.parse(req.body);
    // 旧版(<=現行)の export は復元可: restoreRows が表に在る列だけを INSERT し、後付け列は
    // DEFAULT で埋まる(加算的マイグレーション)。理解できない未来版(>現行)だけ弾く。
    if (payload.version > SCHEMA_VERSION) {
      return reply
        .code(409)
        .send({ error: `version mismatch: payload v${payload.version} is newer than code v${SCHEMA_VERSION}` });
    }
    const empty = items.all().length === 0 && projects.all().length === 0;
    if (!empty) return reply.code(409).send({ error: "import requires empty DB" });
    const r = importData(payload.data);
    return { ok: true, ...r };
  });

  app.get("/api/summary", async () => weekly());

  // --- 案件 (projects) ------------------------------------------------------
  const projectSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    mode: z.enum(["board", "flow"]).optional(),
    context: z.string().optional(),
  });
  app.post("/api/projects", async (req) => projects.create(projectSchema.parse(req.body)));
  app.patch("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        mode: z.enum(["board", "flow"]).optional(),
        status: z.enum(["active", "archived"]).optional(),
        context: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    return projects.update(id, patch);
  });
  app.delete("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    projects.remove(id);
    return { ok: true };
  });

  // --- スプリント (sprints) -------------------------------------------------
  app.post("/api/sprints", async (req) => {
    const b = z
      .object({
        name: z.string().min(1),
        goal: z.string().optional(),
        startDate: z.number().nullable().optional(),
        endDate: z.number().nullable().optional(),
      })
      .parse(req.body);
    return sprints.create(b);
  });
  app.patch("/api/sprints/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = z
      .object({
        name: z.string().min(1).optional(),
        goal: z.string().optional(),
        startDate: z.number().nullable().optional(),
        endDate: z.number().nullable().optional(),
        status: z.enum(["planned", "active", "completed"]).optional(),
      })
      .strict()
      .parse(req.body);
    return sprints.update(id, patch);
  });
  app.delete("/api/sprints/:id", async (req) => {
    const { id } = req.params as { id: string };
    sprints.remove(id);
    return { ok: true };
  });

  // --- 学び (memory AIゾーン) -------------------------------------------------
  // veto: 不要な学びを注入対象から外す (削除でなく可逆: 再度 veto=false で戻せる)。
  // pin: 学びを固定 (減衰しない・フル信頼)。どちらも較正母数には一切触れない。
  app.patch("/api/learnings/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = z
      .object({ vetoed: z.boolean().optional(), pinned: z.boolean().optional() })
      .strict()
      .parse(req.body);
    if (typeof patch.vetoed === "boolean") learnings.setVetoed(id, patch.vetoed);
    if (typeof patch.pinned === "boolean") learnings.setPinned(id, patch.pinned);
    return { ok: true };
  });

  // --- rules ----------------------------------------------------------------
  app.get("/api/rules", async () => rules.all());
  app.post("/api/rules/:id/deactivate", async (req) => {
    const { id } = req.params as { id: string };
    rules.deactivate(id);
    return { ok: true };
  });
}
