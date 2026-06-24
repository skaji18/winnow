import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as actions from "../actions.js";
import { ensureDriver, getDriver, resetDriver } from "../ai/index.js";
import { classify } from "../classifier.js";
import * as decomposer from "../decomposer.js";
import * as executor from "../executor.js";
import * as promotion from "../promotion.js";
import { autoFoldedCount, queue } from "../queue.js";
import { items, jobs, labels, rules, settings } from "../repo.js";
import { weekly } from "../summary.js";

// Run a possibly-long AI op in the background; the UI reflects progress by
// polling /api/state (job + item status are persisted as it runs).
function background(fn: () => Promise<unknown>): void {
  fn().catch((e) => console.error("[winnow] background op failed:", e));
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // One-shot snapshot powering the whole UI.
  app.get("/api/state", async () => ({
    items: items.all(),
    queue: queue(),
    autoFolded: autoFoldedCount(),
    settings: settings.get(),
    sessions: getDriver().listSessions(),
    summary: weekly(),
    rules: rules.all(),
    recentJobs: jobs.recent(30),
  }));

  // --- items CRUD -----------------------------------------------------------
  const createSchema = z.object({
    title: z.string().min(1),
    body: z.string().optional(),
    parentId: z.string().nullable().optional(),
    kind: z.enum(["node", "leaf"]).optional(),
    domain: z.enum(["software", "general"]).optional(),
    projectDir: z.string().nullable().optional(),
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
    });
    // 新規アイテムが着いたら分類器が disposition を書く (§4 利用動線)。
    if (b.classify !== false) background(() => classify(item.id));
    return item;
  });

  app.patch("/api/items/:id", async (req) => {
    const { id } = req.params as { id: string };
    const patch = req.body as Record<string, unknown>;
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
    maxWorkers: z.number().int().min(0).max(8).optional(),
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

  // --- rules ----------------------------------------------------------------
  app.get("/api/rules", async () => rules.all());
  app.post("/api/rules/:id/deactivate", async (req) => {
    const { id } = req.params as { id: string };
    rules.deactivate(id);
    return { ok: true };
  });
}
