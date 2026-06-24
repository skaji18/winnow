import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  type CategoryStat,
  type Disposition,
  type Item,
  type LabelAction,
  type LabelEvent,
  type Rule,
  type Settings,
  type ExecutionJob,
  DEFAULT_SETTINGS,
} from "./domain.js";

type Row = Record<string, unknown>;

function boolize(v: unknown): boolean {
  return v === 1 || v === true;
}

function mapItem(r: Row): Item {
  return {
    id: r.id as string,
    title: r.title as string,
    body: (r.body as string) ?? "",
    kind: r.kind as Item["kind"],
    rung: r.rung as Item["rung"],
    parentId: (r.parentId as string) ?? null,
    orderIndex: r.orderIndex as number,
    status: r.status as Item["status"],
    disposition: (r.disposition as Disposition) ?? null,
    confidence: r.confidence === null ? null : (r.confidence as number),
    reason: (r.reason as string) ?? null,
    stakes: r.stakes === null ? null : (r.stakes as number),
    reversibility: r.reversibility === null ? null : (r.reversibility as number),
    category: (r.category as string) ?? null,
    process: (r.process as Item["process"]) ?? null,
    uncertaintyResolved: boolize(r.uncertaintyResolved),
    autoExecuted: boolize(r.autoExecuted),
    humanOverrode: boolize(r.humanOverrode),
    auditSampled: boolize(r.auditSampled),
    executionStatus: r.executionStatus as Item["executionStatus"],
    executionResult: (r.executionResult as string) ?? null,
    domain: r.domain as Item["domain"],
    projectDir: (r.projectDir as string) ?? null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  };
}

const now = () => Date.now();

export const items = {
  all(): Item[] {
    return (db.prepare("SELECT * FROM items ORDER BY orderIndex ASC").all() as Row[]).map(
      mapItem,
    );
  },
  get(id: string): Item | null {
    const r = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return r ? mapItem(r) : null;
  },
  children(parentId: string | null): Item[] {
    const rows = (
      parentId === null
        ? db.prepare("SELECT * FROM items WHERE parentId IS NULL ORDER BY orderIndex ASC").all()
        : db
            .prepare("SELECT * FROM items WHERE parentId = ? ORDER BY orderIndex ASC")
            .all(parentId)
    ) as Row[];
    return rows.map(mapItem);
  },
  create(input: Partial<Item> & { title: string }): Item {
    const id = input.id ?? randomUUID();
    const ts = now();
    // place at end of siblings
    const maxOrder =
      (
        db
          .prepare(
            "SELECT MAX(orderIndex) AS m FROM items WHERE IFNULL(parentId,'') = IFNULL(?, '')",
          )
          .get(input.parentId ?? null) as { m: number | null }
      ).m ?? 0;
    const item: Item = {
      id,
      title: input.title,
      body: input.body ?? "",
      kind: input.kind ?? "node",
      rung: input.rung ?? "strategy",
      parentId: input.parentId ?? null,
      orderIndex: input.orderIndex ?? maxOrder + 1,
      status: input.status ?? "inbox",
      disposition: input.disposition ?? null,
      confidence: input.confidence ?? null,
      reason: input.reason ?? null,
      stakes: input.stakes ?? null,
      reversibility: input.reversibility ?? null,
      category: input.category ?? null,
      process: input.process ?? null,
      uncertaintyResolved: input.uncertaintyResolved ?? false,
      autoExecuted: input.autoExecuted ?? false,
      humanOverrode: input.humanOverrode ?? false,
      auditSampled: input.auditSampled ?? false,
      executionStatus: input.executionStatus ?? "none",
      executionResult: input.executionResult ?? null,
      domain: input.domain ?? "general",
      projectDir: input.projectDir ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    db.prepare(
      `INSERT INTO items (id,title,body,kind,rung,parentId,orderIndex,status,disposition,confidence,reason,stakes,reversibility,category,process,uncertaintyResolved,autoExecuted,humanOverrode,auditSampled,executionStatus,executionResult,domain,projectDir,createdAt,updatedAt)
       VALUES (@id,@title,@body,@kind,@rung,@parentId,@orderIndex,@status,@disposition,@confidence,@reason,@stakes,@reversibility,@category,@process,@uncertaintyResolved,@autoExecuted,@humanOverrode,@auditSampled,@executionStatus,@executionResult,@domain,@projectDir,@createdAt,@updatedAt)`,
    ).run({
      ...item,
      uncertaintyResolved: item.uncertaintyResolved ? 1 : 0,
      autoExecuted: item.autoExecuted ? 1 : 0,
      humanOverrode: item.humanOverrode ? 1 : 0,
      auditSampled: item.auditSampled ? 1 : 0,
    });
    return item;
  },
  update(id: string, patch: Partial<Item>): Item | null {
    const current = items.get(id);
    if (!current) return null;
    const merged = { ...current, ...patch, id, updatedAt: now() };
    db.prepare(
      `UPDATE items SET title=@title,body=@body,kind=@kind,rung=@rung,parentId=@parentId,orderIndex=@orderIndex,status=@status,disposition=@disposition,confidence=@confidence,reason=@reason,stakes=@stakes,reversibility=@reversibility,category=@category,process=@process,uncertaintyResolved=@uncertaintyResolved,autoExecuted=@autoExecuted,humanOverrode=@humanOverrode,auditSampled=@auditSampled,executionStatus=@executionStatus,executionResult=@executionResult,domain=@domain,projectDir=@projectDir,updatedAt=@updatedAt WHERE id=@id`,
    ).run({
      ...merged,
      uncertaintyResolved: merged.uncertaintyResolved ? 1 : 0,
      autoExecuted: merged.autoExecuted ? 1 : 0,
      humanOverrode: merged.humanOverrode ? 1 : 0,
      auditSampled: merged.auditSampled ? 1 : 0,
    });
    return merged;
  },
  remove(id: string): void {
    db.prepare("DELETE FROM items WHERE id = ?").run(id);
  },
};

export const labels = {
  record(input: {
    itemId: string;
    action: LabelAction;
    fromDisposition?: Disposition | null;
    toDisposition?: Disposition | null;
    category?: string | null;
    note?: string | null;
  }): LabelEvent {
    const ev: LabelEvent = {
      id: randomUUID(),
      itemId: input.itemId,
      action: input.action,
      fromDisposition: input.fromDisposition ?? null,
      toDisposition: input.toDisposition ?? null,
      category: input.category ?? null,
      note: input.note ?? null,
      createdAt: now(),
    };
    db.prepare(
      `INSERT INTO label_events (id,itemId,action,fromDisposition,toDisposition,category,note,createdAt)
       VALUES (@id,@itemId,@action,@fromDisposition,@toDisposition,@category,@note,@createdAt)`,
    ).run(ev);
    return ev;
  },
  since(ts: number): LabelEvent[] {
    return db
      .prepare("SELECT * FROM label_events WHERE createdAt >= ? ORDER BY createdAt DESC")
      .all(ts) as LabelEvent[];
  },
  forItem(itemId: string): LabelEvent[] {
    return db
      .prepare("SELECT * FROM label_events WHERE itemId = ? ORDER BY createdAt DESC")
      .all(itemId) as LabelEvent[];
  },
};

export const rules = {
  all(): Rule[] {
    return (db.prepare("SELECT * FROM rules ORDER BY createdAt DESC").all() as Row[]).map(
      (r) => ({ ...r, active: boolize(r.active) }) as Rule,
    );
  },
  forCategory(category: string): Rule | null {
    const r = db
      .prepare("SELECT * FROM rules WHERE category = ? AND active = 1 ORDER BY createdAt DESC LIMIT 1")
      .get(category) as Row | undefined;
    return r ? ({ ...r, active: boolize(r.active) } as Rule) : null;
  },
  upsert(input: {
    category: string;
    forcedDisposition: Disposition;
    source?: "manual" | "learned";
    note?: string | null;
  }): Rule {
    // deactivate prior rules for the category, then insert
    db.prepare("UPDATE rules SET active = 0 WHERE category = ?").run(input.category);
    const rule: Rule = {
      id: randomUUID(),
      category: input.category,
      forcedDisposition: input.forcedDisposition,
      source: input.source ?? "manual",
      active: true,
      note: input.note ?? null,
      createdAt: now(),
    };
    db.prepare(
      `INSERT INTO rules (id,category,forcedDisposition,source,active,note,createdAt)
       VALUES (@id,@category,@forcedDisposition,@source,1,@note,@createdAt)`,
    ).run(rule);
    return rule;
  },
  deactivate(id: string): void {
    db.prepare("UPDATE rules SET active = 0 WHERE id = ?").run(id);
  },
};

export const categoryStats = {
  bump(category: string, aiDisposition: Disposition, field: "agreed" | "overturned"): void {
    db.prepare(
      `INSERT INTO category_stats (category, aiDisposition, agreed, overturned)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(category, aiDisposition) DO UPDATE SET ${field} = ${field} + 1`,
    ).run(category, aiDisposition, field === "agreed" ? 1 : 0, field === "overturned" ? 1 : 0);
  },
  all(): CategoryStat[] {
    return db.prepare("SELECT * FROM category_stats").all() as CategoryStat[];
  },
  forCategory(category: string): CategoryStat[] {
    return db
      .prepare("SELECT * FROM category_stats WHERE category = ?")
      .all(category) as CategoryStat[];
  },
};

export const jobs = {
  create(input: Omit<ExecutionJob, "id" | "createdAt">): ExecutionJob {
    const job: ExecutionJob = { ...input, id: randomUUID(), createdAt: now() };
    db.prepare(
      `INSERT INTO jobs (id,itemId,role,kindOfWork,sessionName,status,startedAt,finishedAt,output,error,createdAt)
       VALUES (@id,@itemId,@role,@kindOfWork,@sessionName,@status,@startedAt,@finishedAt,@output,@error,@createdAt)`,
    ).run(job);
    return job;
  },
  update(id: string, patch: Partial<ExecutionJob>): void {
    const cur = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as ExecutionJob | undefined;
    if (!cur) return;
    const merged = { ...cur, ...patch };
    db.prepare(
      `UPDATE jobs SET sessionName=@sessionName,status=@status,startedAt=@startedAt,finishedAt=@finishedAt,output=@output,error=@error WHERE id=@id`,
    ).run(merged);
  },
  recent(limit = 50): ExecutionJob[] {
    return db
      .prepare("SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?")
      .all(limit) as ExecutionJob[];
  },
};

export const settings = {
  get(): Settings {
    const r = db.prepare("SELECT json FROM settings WHERE id = 1").get() as
      | { json: string }
      | undefined;
    return r ? { ...DEFAULT_SETTINGS, ...JSON.parse(r.json) } : { ...DEFAULT_SETTINGS };
  },
  update(patch: Partial<Settings>): Settings {
    const merged = { ...settings.get(), ...patch };
    db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(merged));
    return merged;
  },
};
