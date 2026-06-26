import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  type CategoryStat,
  type Disposition,
  type Item,
  type LabelAction,
  type LabelEvent,
  type Project,
  type Rule,
  type Settings,
  type Sprint,
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
    rawDisposition: (r.rawDisposition as Disposition) ?? null,
    rawConfidence:
      r.rawConfidence === null || r.rawConfidence === undefined
        ? null
        : Number(r.rawConfidence),
    envEscalated: boolize(r.envEscalated),
    process: (r.process as Item["process"]) ?? null,
    uncertaintyResolved: boolize(r.uncertaintyResolved),
    autoExecuted: boolize(r.autoExecuted),
    humanOverrode: boolize(r.humanOverrode),
    auditSampled: boolize(r.auditSampled),
    executionStatus: r.executionStatus as Item["executionStatus"],
    executionResult: (r.executionResult as string) ?? null,
    executionSummary: (r.executionSummary as string) ?? null,
    executionOutput: (r.executionOutput as string) ?? null,
    rollbackPlan: (r.rollbackPlan as string) ?? null,
    // 三値変換: null=未申告。0/1 → boolean。
    declaredReversible:
      r.declaredReversible === null || r.declaredReversible === undefined
        ? null
        : boolize(r.declaredReversible),
    artifacts: (r.artifacts as string) ?? null,
    sourceUrl: (r.sourceUrl as string) ?? null,
    externalKey: (r.externalKey as string) ?? null,
    domain: r.domain as Item["domain"],
    projectDir: (r.projectDir as string) ?? null,
    projectId: (r.projectId as string) ?? null,
    sprintId: (r.sprintId as string) ?? null,
    dueDate: r.dueDate === null || r.dueDate === undefined ? null : (r.dueDate as number),
    priority: (r.priority as Item["priority"]) ?? "normal",
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
  // 外部冪等キーで既存を検索 (capture の重複 no-op/追記)。非null時一意(部分ユニーク索引)。
  findByExternalKey(key: string): Item | null {
    const r = db.prepare("SELECT * FROM items WHERE externalKey = ?").get(key) as Row | undefined;
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
      rawDisposition: input.rawDisposition ?? null,
      rawConfidence: input.rawConfidence ?? null,
      envEscalated: input.envEscalated ?? false,
      process: input.process ?? null,
      uncertaintyResolved: input.uncertaintyResolved ?? false,
      autoExecuted: input.autoExecuted ?? false,
      humanOverrode: input.humanOverrode ?? false,
      auditSampled: input.auditSampled ?? false,
      executionStatus: input.executionStatus ?? "none",
      executionResult: input.executionResult ?? null,
      executionSummary: input.executionSummary ?? null,
      executionOutput: input.executionOutput ?? null,
      rollbackPlan: input.rollbackPlan ?? null,
      declaredReversible: input.declaredReversible ?? null,
      artifacts: input.artifacts ?? null,
      sourceUrl: input.sourceUrl ?? null,
      externalKey: input.externalKey ?? null,
      domain: input.domain ?? "general",
      projectDir: input.projectDir ?? null,
      projectId: input.projectId ?? null,
      sprintId: input.sprintId ?? null,
      dueDate: input.dueDate ?? null,
      priority: input.priority ?? "normal",
      createdAt: ts,
      updatedAt: ts,
    };
    db.prepare(
      `INSERT INTO items (id,title,body,kind,rung,parentId,orderIndex,status,disposition,confidence,reason,stakes,reversibility,category,rawDisposition,rawConfidence,envEscalated,process,uncertaintyResolved,autoExecuted,humanOverrode,auditSampled,executionStatus,executionResult,executionSummary,executionOutput,rollbackPlan,declaredReversible,artifacts,sourceUrl,externalKey,domain,projectDir,projectId,sprintId,dueDate,priority,createdAt,updatedAt)
       VALUES (@id,@title,@body,@kind,@rung,@parentId,@orderIndex,@status,@disposition,@confidence,@reason,@stakes,@reversibility,@category,@rawDisposition,@rawConfidence,@envEscalated,@process,@uncertaintyResolved,@autoExecuted,@humanOverrode,@auditSampled,@executionStatus,@executionResult,@executionSummary,@executionOutput,@rollbackPlan,@declaredReversible,@artifacts,@sourceUrl,@externalKey,@domain,@projectDir,@projectId,@sprintId,@dueDate,@priority,@createdAt,@updatedAt)`,
    ).run({
      ...item,
      envEscalated: item.envEscalated ? 1 : 0,
      uncertaintyResolved: item.uncertaintyResolved ? 1 : 0,
      autoExecuted: item.autoExecuted ? 1 : 0,
      humanOverrode: item.humanOverrode ? 1 : 0,
      auditSampled: item.auditSampled ? 1 : 0,
      // 三値: null はそのまま (SQLite NULL)、boolean は 0/1。
      declaredReversible:
        item.declaredReversible === null ? null : item.declaredReversible ? 1 : 0,
    });
    return item;
  },
  update(id: string, patch: Partial<Item>): Item | null {
    const current = items.get(id);
    if (!current) return null;
    const merged = { ...current, ...patch, id, updatedAt: now() };
    db.prepare(
      `UPDATE items SET title=@title,body=@body,kind=@kind,rung=@rung,parentId=@parentId,orderIndex=@orderIndex,status=@status,disposition=@disposition,confidence=@confidence,reason=@reason,stakes=@stakes,reversibility=@reversibility,category=@category,rawDisposition=@rawDisposition,rawConfidence=@rawConfidence,envEscalated=@envEscalated,process=@process,uncertaintyResolved=@uncertaintyResolved,autoExecuted=@autoExecuted,humanOverrode=@humanOverrode,auditSampled=@auditSampled,executionStatus=@executionStatus,executionResult=@executionResult,executionSummary=@executionSummary,executionOutput=@executionOutput,rollbackPlan=@rollbackPlan,declaredReversible=@declaredReversible,artifacts=@artifacts,sourceUrl=@sourceUrl,externalKey=@externalKey,domain=@domain,projectDir=@projectDir,projectId=@projectId,sprintId=@sprintId,dueDate=@dueDate,priority=@priority,updatedAt=@updatedAt WHERE id=@id`,
    ).run({
      ...merged,
      envEscalated: merged.envEscalated ? 1 : 0,
      uncertaintyResolved: merged.uncertaintyResolved ? 1 : 0,
      autoExecuted: merged.autoExecuted ? 1 : 0,
      humanOverrode: merged.humanOverrode ? 1 : 0,
      auditSampled: merged.auditSampled ? 1 : 0,
      declaredReversible:
        merged.declaredReversible === null ? null : merged.declaredReversible ? 1 : 0,
    });
    return merged;
  },
  // サブツリー件数を数えてから物理削除し、連鎖削除件数を返す (FK CASCADE が子を消す)。
  remove(id: string): { deleted: number } {
    const cnt = (
      db
        .prepare(
          "WITH RECURSIVE sub(id) AS (SELECT id FROM items WHERE id=? UNION ALL SELECT i.id FROM items i JOIN sub ON i.parentId=sub.id) SELECT COUNT(*) AS n FROM sub",
        )
        .get(id) as { n: number }
    ).n;
    db.prepare("DELETE FROM items WHERE id = ?").run(id);
    return { deleted: cnt };
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
  all(): LabelEvent[] {
    return db
      .prepare("SELECT * FROM label_events ORDER BY createdAt ASC")
      .all() as LabelEvent[];
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
  /** カテゴリ × アクション群で件数を数える (summary の方向別締緩・符号ズレ補正の母数)。 */
  countByCategoryAction(category: string, actions: LabelAction[], since: number): number {
    if (actions.length === 0) return 0;
    const ph = actions.map(() => "?").join(",");
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM label_events WHERE category = ? AND action IN (${ph}) AND createdAt >= ?`,
        )
        .get(category, ...actions, since) as { c: number }
    ).c;
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

export const categories = {
  /**
   * これまでに使われたカテゴリ語彙 (揺れ補正の案A: 分類プロンプトに見せて再利用を促す)。
   * items/rules/category_stats を横断して重複なく集める。新しい命名を「発生源で」抑え、
   * 基準率補正の母数(category_stats)やルールのバケットが表記揺れで割れるのを防ぐ。
   * 表記は正規化(normalizeCategory)済みの前提 — 書き込み口が classifier に一本化されている。
   */
  known(): string[] {
    const rows = db
      .prepare(
        `SELECT DISTINCT category FROM (
           SELECT category FROM items WHERE category IS NOT NULL AND category <> ''
           UNION SELECT category FROM rules
           UNION SELECT category FROM category_stats
         ) WHERE category IS NOT NULL AND category <> ''
           AND category NOT IN ('uncategorized','unclassified')
         ORDER BY category`,
      )
      .all() as { category: string }[];
    return rows.map((r) => r.category);
  },
  /**
   * known() に直近使用数を添えたもの (発生源抑制の強化)。items の category 別件数を添えて
   * 使用実績の多い既存語彙を分類プロンプトで優先再利用させる。意味クラスタリングはしない。
   * recentCount は items 上の総出現数 (createdAt 降順の重みは付けず単純カウント=決定論)。
   */
  knownWithRecency(): { category: string; recentCount: number }[] {
    const rows = db
      .prepare(
        `SELECT k.category AS category,
            (SELECT COUNT(*) FROM items i
               WHERE i.category = k.category AND i.category IS NOT NULL AND i.category <> '') AS recentCount
         FROM (
           SELECT DISTINCT category FROM (
             SELECT category FROM items WHERE category IS NOT NULL AND category <> ''
             UNION SELECT category FROM rules
             UNION SELECT category FROM category_stats
           ) WHERE category IS NOT NULL AND category <> ''
             AND category NOT IN ('uncategorized','unclassified')
         ) k
         ORDER BY recentCount DESC, k.category ASC`,
      )
      .all() as { category: string; recentCount: number }[];
    return rows;
  },
};

export const categoryStats = {
  // confBin はビン較正キー (Batch2 がシグネチャを拡張する)。本バッチでは confBin=0 既定で
  // 既存呼び出しが壊れないようにし、PRIMARY KEY (category,aiDisposition,confBin) に整合させる。
  bump(
    category: string,
    aiDisposition: Disposition,
    field: "agreed" | "overturned" | "overturnedToAuto",
    confBin = 0,
  ): void {
    db.prepare(
      `INSERT INTO category_stats (category, aiDisposition, confBin, agreed, overturned, overturnedToAuto)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(category, aiDisposition, confBin) DO UPDATE SET ${field} = ${field} + 1`,
    ).run(
      category,
      aiDisposition,
      confBin,
      field === "agreed" ? 1 : 0,
      field === "overturned" ? 1 : 0,
      field === "overturnedToAuto" ? 1 : 0,
    );
  },
  all(): CategoryStat[] {
    return db.prepare("SELECT * FROM category_stats").all() as CategoryStat[];
  },
  forCategory(category: string): CategoryStat[] {
    return db
      .prepare("SELECT * FROM category_stats WHERE category = ?")
      .all(category) as CategoryStat[];
  },
  /**
   * 全ビンを SUM して旧来の (category, aiDisposition) 単位の集計を再現する後方互換ヘルパ。
   * learned auto tip の Wilson 下限判定はビン横断で行うのでこちらを使う。confBin は便宜上 0。
   */
  aggregated(category: string): CategoryStat[] {
    return db
      .prepare(
        `SELECT category, aiDisposition, 0 AS confBin,
            SUM(agreed) AS agreed, SUM(overturned) AS overturned, SUM(overturnedToAuto) AS overturnedToAuto
         FROM category_stats WHERE category = ?
         GROUP BY category, aiDisposition`,
      )
      .all(category) as CategoryStat[];
  },
};

export const jobs = {
  create(input: Omit<ExecutionJob, "id" | "createdAt">): ExecutionJob {
    const job: ExecutionJob = { ...input, id: randomUUID(), createdAt: now() };
    db.prepare(
      `INSERT INTO jobs (id,itemId,role,kindOfWork,sessionName,status,startedAt,finishedAt,output,error,ipcId,createdAt)
       VALUES (@id,@itemId,@role,@kindOfWork,@sessionName,@status,@startedAt,@finishedAt,@output,@error,@ipcId,@createdAt)`,
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
  /** 前回プロセスで running のまま中断した execute ジョブ (起動時 reconcile が決着させる)。 */
  runningExecuteJobs(): ExecutionJob[] {
    return db
      .prepare(
        "SELECT * FROM jobs WHERE role='worker' AND kindOfWork='execute' AND status='running' ORDER BY createdAt ASC",
      )
      .all() as ExecutionJob[];
  },
  /** classify/execute の失敗ジョブ数 (summary の failed 集計)。finishedAt 基準。 */
  failedSince(ts: number): number {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM jobs
           WHERE status='failed' AND kindOfWork IN ('classify','execute') AND finishedAt >= ?`,
        )
        .get(ts) as { c: number }
    ).c;
  },
  /** 成功した execute ジョブの DISTINCT itemId 数 (summary の auto 件数のイベント基準)。 */
  succeededExecuteItemsSince(ts: number): number {
    return (
      db
        .prepare(
          `SELECT COUNT(DISTINCT itemId) AS c FROM jobs
           WHERE status='succeeded' AND kindOfWork='execute' AND finishedAt >= ?`,
        )
        .get(ts) as { c: number }
    ).c;
  },
};

export const projects = {
  all(): Project[] {
    return db.prepare("SELECT * FROM projects ORDER BY createdAt ASC").all() as Project[];
  },
  get(id: string): Project | null {
    return (db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project) ?? null;
  },
  create(input: {
    name: string;
    description?: string;
    mode?: "board" | "flow";
    context?: string;
  }): Project {
    const p: Project = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? "",
      mode: input.mode ?? "flow",
      status: "active",
      context: input.context ?? "",
      createdAt: now(),
      updatedAt: now(),
    };
    db.prepare(
      `INSERT INTO projects (id,name,description,mode,status,context,createdAt,updatedAt)
       VALUES (@id,@name,@description,@mode,@status,@context,@createdAt,@updatedAt)`,
    ).run(p);
    return p;
  },
  update(id: string, patch: Partial<Project>): Project | null {
    const cur = projects.get(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch, id, updatedAt: now() };
    db.prepare(
      `UPDATE projects SET name=@name,description=@description,mode=@mode,status=@status,context=@context,updatedAt=@updatedAt WHERE id=@id`,
    ).run(merged);
    return merged;
  },
  remove(id: string): void {
    // 案件を消したらアイテムは孤児にせず案件参照だけ外す (タスクは残す)。
    // スプリントは版1でグローバル化 (projectId 死列除去) されたため案件削除では消さない。
    db.prepare("UPDATE items SET projectId = NULL, sprintId = NULL WHERE projectId = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  },
};

export const sprints = {
  all(): Sprint[] {
    return db.prepare("SELECT * FROM sprints ORDER BY createdAt ASC").all() as Sprint[];
  },
  get(id: string): Sprint | null {
    return (db.prepare("SELECT * FROM sprints WHERE id = ?").get(id) as Sprint) ?? null;
  },
  create(input: {
    name: string;
    goal?: string;
    startDate?: number | null;
    endDate?: number | null;
  }): Sprint {
    const s: Sprint = {
      id: randomUUID(),
      name: input.name,
      goal: input.goal ?? "",
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      status: "planned",
      createdAt: now(),
    };
    // projectId 列は版1のテーブル再構築で物理削除済み (グローバル化)。
    db.prepare(
      `INSERT INTO sprints (id,name,goal,startDate,endDate,status,createdAt)
       VALUES (@id,@name,@goal,@startDate,@endDate,@status,@createdAt)`,
    ).run(s);
    return s;
  },
  update(id: string, patch: Partial<Sprint>): Sprint | null {
    const cur = sprints.get(id);
    if (!cur) return null;
    const merged = { ...cur, ...patch, id };
    db.prepare(
      `UPDATE sprints SET name=@name,goal=@goal,startDate=@startDate,endDate=@endDate,status=@status WHERE id=@id`,
    ).run(merged);
    return merged;
  },
  remove(id: string): void {
    db.prepare("UPDATE items SET sprintId = NULL WHERE sprintId = ?").run(id);
    db.prepare("DELETE FROM sprints WHERE id = ?").run(id);
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

// --- export/import (空DB復元限定) -------------------------------------------
// 表の実カラム集合(PRAGMA table_info)に存在する列だけを INSERT する汎用復元。これで
// export の行形(mapItem 由来の JS boolean 等)を版1スキーマに書き戻せる。SQLite に渡せない
// 値(boolean→0/1、配列/オブジェクト→JSON 文字列)だけ正規化する。0/1 はそのまま往復。
function normalizeForSqlite(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

function restoreRows(table: string, rows: Array<Record<string, unknown>>): number {
  if (!rows.length) return 0;
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  const insert = db.transaction((rs: Array<Record<string, unknown>>) => {
    for (const row of rs) {
      const present = cols.filter((c) => c in row);
      if (present.length === 0) continue;
      const placeholders = present.map((c) => `@${c}`).join(",");
      const params: Record<string, unknown> = {};
      for (const c of present) params[c] = normalizeForSqlite(row[c]);
      db.prepare(
        `INSERT INTO ${table} (${present.join(",")}) VALUES (${placeholders})`,
      ).run(params);
    }
  });
  insert(rows);
  return rows.length;
}

export interface ImportPayload {
  items?: Array<Record<string, unknown>>;
  labels?: Array<Record<string, unknown>>;
  rules?: Array<Record<string, unknown>>;
  categoryStats?: Array<Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
  sprints?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
}

/**
 * 空DB復元。呼び出し側(routes)が空DB判定・版数照合済みである前提。merge はしない。
 * 復元順序は FK 親→子(projects/sprints → items → label_events/jobs)。部分ユニーク externalKey の
 * 不変条件(非null時一意)は export 元が保証している前提(空DBなので衝突は復元元の重複のみ)。
 */
export function importData(payload: ImportPayload): {
  items: number;
  projects: number;
  sprints: number;
  labels: number;
  rules: number;
  categoryStats: number;
  jobs: number;
} {
  // settings はシード行を上書き(import の設定で復元)。
  if (payload.settings) {
    const merged = { ...DEFAULT_SETTINGS, ...payload.settings } as Settings;
    db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(merged));
  }
  return {
    projects: restoreRows("projects", payload.projects ?? []),
    sprints: restoreRows("sprints", payload.sprints ?? []),
    items: restoreRows("items", payload.items ?? []),
    labels: restoreRows("label_events", payload.labels ?? []),
    rules: restoreRows("rules", payload.rules ?? []),
    categoryStats: restoreRows("category_stats", payload.categoryStats ?? []),
    jobs: restoreRows("jobs", payload.jobs ?? []),
  };
}
