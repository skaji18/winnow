import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as actions from "../actions.js";
import { ensureDriver, getDriver, resetDriver } from "../ai/index.js";
import { classify } from "../classifier.js";
import * as decomposer from "../decomposer.js";
import * as executor from "../executor.js";
import * as promotion from "../promotion.js";
import { autoFoldedCount, queue } from "../queue.js";
import { items, jobs, labels, projects, rules, settings, sprints } from "../repo.js";
import { weekly } from "../summary.js";

// Run a possibly-long AI op in the background; the UI reflects progress by
// polling /api/state (job + item status are persisted as it runs).
function background(fn: () => Promise<unknown>): void {
  fn().catch((e) => console.error("[winnow] background op failed:", e));
}

// 自動着火 (§3.4/§0): キューを開くたびに、未着手の可逆リーフ自動アイテムを
// 点火する。overlapする /api/state ポーリングからの二重起動を防ぐため、
// 起動中の id を保持して重複ディスパッチをスキップする。
const igniting = new Set<string>();

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // One-shot snapshot powering the whole UI.
  app.get("/api/state", async () => {
    // 仕分け済みの自動アイテムはキューを開いた瞬間に走り出す (待ち行列を作らない)。
    // requestExecution が自己ガードする: executionStatus!=="none" は弾き、
    // 不可逆/高ステークスは proposed に回すので、ここでの追加ゲートは不要。
    // 監査サンプル済みも除外しない: 自動実行しつつキューにも出して見分けの効く
    // 監査を混入させる (§4-3, queue.ts のフィルタが面倒を見る)。
    for (const it of items.all()) {
      if (
        it.status === "classified" &&
        it.kind === "leaf" &&
        it.disposition === "auto" &&
        it.executionStatus === "none" &&
        !igniting.has(it.id)
      ) {
        igniting.add(it.id);
        background(() =>
          executor.requestExecution(it.id).finally(() => igniting.delete(it.id)),
        );
      }
    }
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
    };
  });

  // --- items CRUD -----------------------------------------------------------
  const createSchema = z.object({
    title: z.string().min(1),
    body: z.string().optional(),
    parentId: z.string().nullable().optional(),
    kind: z.enum(["node", "leaf"]).optional(),
    domain: z.enum(["software", "general"]).optional(),
    projectDir: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    sprintId: z.string().nullable().optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    dueDate: z.number().nullable().optional(),
    classify: z.boolean().optional(),
  });
  app.post("/api/items", async (req) => {
    const b = createSchema.parse(req.body);
    const item = items.create({
      title: b.title,
      body: b.body ?? "",
      parentId: b.parentId ?? null,
      kind: b.kind ?? "node",
      domain: b.domain ?? "general",
      projectDir: b.projectDir ?? null,
      projectId: b.projectId ?? null,
      sprintId: b.sprintId ?? null,
      priority: b.priority ?? "normal",
      dueDate: b.dueDate ?? null,
    });
    // 新規アイテムが着いたら分類器が disposition を書く (§4 利用動線)。
    if (b.classify !== false) background(() => classify(item.id));
    return item;
  });

  // 汎用更新。監査/自動化/来歴フィールド (auditSampled, humanOverrode,
  // autoExecuted, executionStatus, executionResult, createdAt, updatedAt, id) は
  // 意図的に除外し、専用の action/audit/execute/cancel ルートからしか動かせない
  // ようにする (簿記の信頼性を守る)。.strict() で未知キーも拒否。
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
      disposition: z.enum(["auto", "escalate", "human"]).nullable().optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
      reason: z.string().nullable().optional(),
      stakes: z.number().min(0).max(1).nullable().optional(),
      reversibility: z.number().min(0).max(1).nullable().optional(),
      category: z.string().nullable().optional(),
      process: z.enum(["waterfall", "iterative"]).nullable().optional(),
      domain: z.enum(["software", "general"]).optional(),
      projectDir: z.string().nullable().optional(),
      projectId: z.string().nullable().optional(),
      sprintId: z.string().nullable().optional(),
      dueDate: z.number().nullable().optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    })
    .strict();
  app.patch("/api/items/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = patchSchema.parse(req.body);
    return items.update(id, patch);
  });

  app.delete("/api/items/:id", async (req) => {
    const { id } = req.params as { id: string };
    items.remove(id);
    return { ok: true };
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
    return { project, assigned: ids.length };
  });

  // --- AI ops ---------------------------------------------------------------
  app.post("/api/items/:id/classify", async (req) => {
    const { id } = req.params as { id: string };
    return (await classify(id)) ?? { error: "not found" };
  });

  app.post("/api/items/:id/decompose", async (req) => {
    const { id } = req.params as { id: string };
    return { options: await decomposer.propose(id) };
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
  app.post("/api/items/:id/execute", async (req) => {
    const { id } = req.params as { id: string };
    background(() => executor.requestExecution(id));
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

  // --- 処分=ラベル -----------------------------------------------------------
  const actionSchema = z.object({
    action: z.enum(["do", "demote", "reclassify", "mute_category", "reject"]),
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

  // --- sessions (terminal theater) -----------------------------------------
  app.get("/api/sessions", async () => getDriver().listSessions());
  app.get("/api/sessions/:name/capture", async (req) => {
    const { name } = req.params as { name: string };
    return { text: await getDriver().capture(decodeURIComponent(name)) };
  });
  app.get("/api/sessions/:name/attach", async (req) => {
    const { name } = req.params as { name: string };
    return { command: getDriver().attachCommand(decodeURIComponent(name)) };
  });
  app.post("/api/ai/init", async () => {
    await ensureDriver();
    return { sessions: getDriver().listSessions() };
  });

  // --- settings / 再調律スライダー ------------------------------------------
  const settingsSchema = z.object({
    auditRate: z.number().min(0).max(1).optional(),
    escalationTightness: z.number().min(0).max(1).optional(),
    maxWorkers: z.number().int().min(1).max(8).optional(),
    claudeControlCmd: z.string().optional(),
    claudeWorkerCmd: z.string().optional(),
    useHeadless: z.boolean().optional(),
  });
  app.patch("/api/settings", async (req) => {
    const patch = settingsSchema.parse(req.body);
    const updated = settings.update(patch);
    if (patch.useHeadless !== undefined) resetDriver(); // ドライバ選択をやり直す
    return updated;
  });

  app.get("/api/summary", async () => weekly());

  // --- 案件 (projects) ------------------------------------------------------
  const projectSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    mode: z.enum(["board", "flow"]).optional(),
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

  // --- rules ----------------------------------------------------------------
  app.get("/api/rules", async () => rules.all());
  app.post("/api/rules/:id/deactivate", async (req) => {
    const { id } = req.params as { id: string };
    rules.deactivate(id);
    return { ok: true };
  });
}
