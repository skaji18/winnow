import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { validateClaudeCmd } from "./security.js";
import {
  type CategoryStat,
  type Disposition,
  type Item,
  type LabelAction,
  type LabelEvent,
  type Learning,
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
    receivedAt: r.receivedAt === null || r.receivedAt === undefined ? null : (r.receivedAt as number),
    reviewOfId: (r.reviewOfId as string) ?? null,
    decomposeStatus: (r.decomposeStatus as Item["decomposeStatus"]) ?? "none",
    decomposeOptions: (r.decomposeOptions as string) ?? null,
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
    context: (r.context as string) ?? null,
    resolution: (r.resolution as string) ?? null,
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
  /**
   * 外部取り込み(capture)の直近統計 (設定の『直近の捕獲』表示用)。externalKey か sourceUrl を
   * 持つ Item を「外部取り込み由来」とみなし、件数と最新 createdAt を返す。0 件なら lastAt=null。
   */
  captureStats(): { count: number; lastAt: number | null } {
    const r = db
      .prepare(
        "SELECT COUNT(*) AS c, MAX(createdAt) AS m FROM items WHERE externalKey IS NOT NULL OR sourceUrl IS NOT NULL",
      )
      .get() as { c: number; m: number | null };
    return { count: r.c, lastAt: r.m ?? null };
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
      receivedAt: input.receivedAt ?? null,
      reviewOfId: input.reviewOfId ?? null,
      decomposeStatus: input.decomposeStatus ?? "none",
      decomposeOptions: input.decomposeOptions ?? null,
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
      context: input.context ?? null,
      resolution: input.resolution ?? null,
      dueDate: input.dueDate ?? null,
      priority: input.priority ?? "normal",
      createdAt: ts,
      updatedAt: ts,
    };
    db.prepare(
      `INSERT INTO items (id,title,body,kind,rung,parentId,orderIndex,status,disposition,confidence,reason,stakes,reversibility,category,rawDisposition,rawConfidence,envEscalated,process,uncertaintyResolved,autoExecuted,humanOverrode,auditSampled,executionStatus,executionResult,receivedAt,reviewOfId,decomposeStatus,decomposeOptions,executionSummary,executionOutput,rollbackPlan,declaredReversible,artifacts,sourceUrl,externalKey,domain,projectDir,projectId,sprintId,context,resolution,dueDate,priority,createdAt,updatedAt)
       VALUES (@id,@title,@body,@kind,@rung,@parentId,@orderIndex,@status,@disposition,@confidence,@reason,@stakes,@reversibility,@category,@rawDisposition,@rawConfidence,@envEscalated,@process,@uncertaintyResolved,@autoExecuted,@humanOverrode,@auditSampled,@executionStatus,@executionResult,@receivedAt,@reviewOfId,@decomposeStatus,@decomposeOptions,@executionSummary,@executionOutput,@rollbackPlan,@declaredReversible,@artifacts,@sourceUrl,@externalKey,@domain,@projectDir,@projectId,@sprintId,@context,@resolution,@dueDate,@priority,@createdAt,@updatedAt)`,
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
      `UPDATE items SET title=@title,body=@body,kind=@kind,rung=@rung,parentId=@parentId,orderIndex=@orderIndex,status=@status,disposition=@disposition,confidence=@confidence,reason=@reason,stakes=@stakes,reversibility=@reversibility,category=@category,rawDisposition=@rawDisposition,rawConfidence=@rawConfidence,envEscalated=@envEscalated,process=@process,uncertaintyResolved=@uncertaintyResolved,autoExecuted=@autoExecuted,humanOverrode=@humanOverrode,auditSampled=@auditSampled,executionStatus=@executionStatus,executionResult=@executionResult,receivedAt=@receivedAt,reviewOfId=@reviewOfId,decomposeStatus=@decomposeStatus,decomposeOptions=@decomposeOptions,executionSummary=@executionSummary,executionOutput=@executionOutput,rollbackPlan=@rollbackPlan,declaredReversible=@declaredReversible,artifacts=@artifacts,sourceUrl=@sourceUrl,externalKey=@externalKey,domain=@domain,projectDir=@projectDir,projectId=@projectId,sprintId=@sprintId,context=@context,resolution=@resolution,dueDate=@dueDate,priority=@priority,updatedAt=@updatedAt WHERE id=@id`,
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
  /** 全期間の LabelEvent 総数 (cold-banner 初日=実績ゼロ判定に使う)。 */
  total(): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM label_events").get() as { c: number }).c;
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
  /** 直近1件の label_event (Undo=直近1手の逆適用の起点)。無ければ null。 */
  lastForItem(itemId: string): LabelEvent | null {
    const r = db
      .prepare("SELECT * FROM label_events WHERE itemId = ? ORDER BY createdAt DESC LIMIT 1")
      .get(itemId) as LabelEvent | undefined;
    return r ?? null;
  },
  /** label_event を1件物理削除する (Undo の逆適用後に教師信号も巻き戻す)。 */
  deleteById(id: string): void {
    db.prepare("DELETE FROM label_events WHERE id = ?").run(id);
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

// 学び (memory AIゾーン)。label_events / category_stats とは物理分離し、calibration を import しない
// = recordOutcome を構造的に呼べない (較正母数を汚さない不変条件をコンパイル時に担保)。
function mapLearning(r: Row): Learning {
  return {
    id: r.id as string,
    category: (r.category as string) ?? null,
    itemId: (r.itemId as string) ?? null,
    text: r.text as string,
    origin: r.origin as Learning["origin"],
    pinned: boolize(r.pinned),
    vetoed: boolize(r.vetoed),
    lastSeenAt: r.lastSeenAt as number,
    createdAt: r.createdAt as number,
  };
}

export const learnings = {
  record(input: {
    text: string;
    category?: string | null;
    itemId?: string | null;
    origin?: Learning["origin"];
    pinned?: boolean;
  }): Learning {
    const ts = now();
    const l: Learning = {
      id: randomUUID(),
      category: input.category ?? null,
      itemId: input.itemId ?? null,
      text: input.text,
      origin: input.origin ?? "ai",
      pinned: input.pinned ?? false,
      vetoed: false,
      lastSeenAt: ts,
      createdAt: ts,
    };
    db.prepare(
      `INSERT INTO learnings (id,category,itemId,text,origin,pinned,vetoed,lastSeenAt,createdAt)
       VALUES (@id,@category,@itemId,@text,@origin,@pinned,@vetoed,@lastSeenAt,@createdAt)`,
    ).run({ ...l, pinned: l.pinned ? 1 : 0, vetoed: l.vetoed ? 1 : 0 });
    return l;
  },
  /** カテゴリ一致 + 共通(category IS NULL) の、veto されていない学び。注入候補。 */
  forCategory(category: string | null): Learning[] {
    const rows =
      category == null
        ? db.prepare("SELECT * FROM learnings WHERE category IS NULL AND vetoed = 0").all()
        : db
            .prepare(
              "SELECT * FROM learnings WHERE (category = ? OR category IS NULL) AND vetoed = 0",
            )
            .all(category);
    return (rows as Row[]).map(mapLearning);
  },
  forProject(): Learning[] {
    return (db.prepare("SELECT * FROM learnings ORDER BY createdAt DESC").all() as Row[]).map(
      mapLearning,
    );
  },
  forItem(itemId: string): Learning[] {
    return (
      db
        .prepare("SELECT * FROM learnings WHERE itemId = ? ORDER BY createdAt DESC")
        .all(itemId) as Row[]
    ).map(mapLearning);
  },
  /** 既存の同一テキスト学び (素朴な重複判定: 同 category + 同 text)。 */
  findDuplicate(category: string | null, text: string): Learning | null {
    const r = (
      category == null
        ? db
            .prepare("SELECT * FROM learnings WHERE category IS NULL AND text = ? LIMIT 1")
            .get(text)
        : db
            .prepare("SELECT * FROM learnings WHERE category = ? AND text = ? LIMIT 1")
            .get(category, text)
    ) as Row | undefined;
    return r ? mapLearning(r) : null;
  },
  /** 注入に使われた学びの生存信号を更新 (減衰の起点をリセット)。 */
  touch(ids: string[]): void {
    if (ids.length === 0) return;
    const ph = ids.map(() => "?").join(",");
    db.prepare(`UPDATE learnings SET lastSeenAt = ? WHERE id IN (${ph})`).run(now(), ...ids);
  },
  setPinned(id: string, pinned: boolean): void {
    db.prepare("UPDATE learnings SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  },
  setVetoed(id: string, vetoed: boolean): void {
    // 解除(復帰)時は lastSeenAt をいまに置き直す: veto 中は注入候補(forCategory)から外れて
    // touch が走らず lastSeenAt が凍結するため、凍結値のままだと減衰期間を跨いだ復帰が
    // 「注入候補に戻らない+次の sweep で即削除」になり「戻せる」が実質機能しない。
    // 人間の明示復帰は新規 record と同じく生存信号の起点を置き直す (プレビュー閲覧のような
    // 受動的延命ではない)。
    if (vetoed) db.prepare("UPDATE learnings SET vetoed = 1 WHERE id = ?").run(id);
    else db.prepare("UPDATE learnings SET vetoed = 0, lastSeenAt = ? WHERE id = ?").run(now(), id);
  },
  /** AI 由来・未 pin・未 veto・未使用 (lastSeenAt < cutoff) を物理削除し件数を返す (自動減衰)。
      veto 済みは対象外: veto は forCategory の注入候補から外す=touch が走らず lastSeenAt が
      veto 時点で凍結するため、減衰対象に含めると「却下は戻せる」(SettingsView) の約束が
      減衰期間経過で黙って破れる (行ごと消えて復帰不能)。veto の解除=注入復帰で touch が再開し、
      通常の減衰サイクルに戻る。 */
  pruneDecayed(cutoff: number): number {
    const info = db
      .prepare(
        "DELETE FROM learnings WHERE origin = 'ai' AND pinned = 0 AND vetoed = 0 AND lastSeenAt < ?",
      )
      .run(cutoff);
    return info.changes;
  },
  all(): Learning[] {
    return (db.prepare("SELECT * FROM learnings ORDER BY createdAt ASC").all() as Row[]).map(
      mapLearning,
    );
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
  /**
   * bump の逆操作 (Undo=直近1手の逆適用)。該当行のカウンタを -1 する (0 未満にはしない=
   * MAX(0,...))。行が無ければ何もしない。教師信号の巻き戻しに使う (recordOutcome の bump と対称)。
   */
  unbump(
    category: string,
    aiDisposition: Disposition,
    field: "agreed" | "overturned" | "overturnedToAuto",
    confBin = 0,
  ): void {
    db.prepare(
      `UPDATE category_stats SET ${field} = MAX(0, ${field} - 1)
       WHERE category = ? AND aiDisposition = ? AND confBin = ?`,
    ).run(category, aiDisposition, confBin);
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

// externalApproved は DB では 0/1/null、型では boolean|null (declaredReversible と同じ三値変換)。
function mapJob(r: Row): ExecutionJob {
  return {
    ...(r as unknown as ExecutionJob),
    externalApproved:
      r.externalApproved === null || r.externalApproved === undefined
        ? null
        : boolize(r.externalApproved),
  };
}

export const jobs = {
  // externalApproved は execute ジョブのみ意味を持つため省略可 (省略=null=非承認/レガシー)。
  create(
    input: Omit<ExecutionJob, "id" | "createdAt" | "externalApproved"> & {
      externalApproved?: boolean | null;
    },
  ): ExecutionJob {
    const job: ExecutionJob = {
      ...input,
      externalApproved: input.externalApproved ?? null,
      id: randomUUID(),
      createdAt: now(),
    };
    db.prepare(
      `INSERT INTO jobs (id,itemId,role,kindOfWork,sessionName,status,startedAt,finishedAt,output,error,ipcId,externalApproved,createdAt)
       VALUES (@id,@itemId,@role,@kindOfWork,@sessionName,@status,@startedAt,@finishedAt,@output,@error,@ipcId,@externalApproved,@createdAt)`,
    ).run({
      ...job,
      externalApproved: job.externalApproved === null ? null : job.externalApproved ? 1 : 0,
    });
    return job;
  },
  update(id: string, patch: Partial<ExecutionJob>): void {
    const cur = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    if (!cur) return;
    const merged = { ...cur, ...patch };
    db.prepare(
      `UPDATE jobs SET sessionName=@sessionName,status=@status,startedAt=@startedAt,finishedAt=@finishedAt,output=@output,error=@error WHERE id=@id`,
    ).run(merged);
  },
  recent(limit = 50): ExecutionJob[] {
    return (
      db.prepare("SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?").all(limit) as Row[]
    ).map(mapJob);
  },
  /** 前回プロセスで running のまま中断した execute ジョブ (起動時 reconcile が決着させる)。 */
  runningExecuteJobs(): ExecutionJob[] {
    return (
      db
        .prepare(
          "SELECT * FROM jobs WHERE role='worker' AND kindOfWork='execute' AND status='running' ORDER BY createdAt ASC",
        )
        .all() as Row[]
    ).map(mapJob);
  },
  /**
   * ある item の最新の execute ジョブ (timed_out の late sentinel 回収で ipcId を引くため)。
   * 1 item が再実行で複数 execute ジョブを持ちうるので createdAt 降順の先頭=今回の実行を採る。
   */
  latestExecuteForItem(itemId: string): ExecutionJob | null {
    const r = db
      .prepare(
        "SELECT * FROM jobs WHERE itemId=? AND role='worker' AND kindOfWork='execute' ORDER BY createdAt DESC LIMIT 1",
      )
      .get(itemId) as Row | undefined;
    return r ? mapJob(r) : null;
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
  /**
   * 指定窓 [from, to) 内に成功した execute ジョブの DISTINCT itemId 数。
   * 先週比(autoPrev)を差分でなく直接窓で数えるため(包含窓の DISTINCT 差で相殺・過小になる罠を回避)。
   */
  succeededExecuteItemsBetween(from: number, to: number): number {
    return (
      db
        .prepare(
          `SELECT COUNT(DISTINCT itemId) AS c FROM jobs
           WHERE status='succeeded' AND kindOfWork='execute' AND finishedAt >= ? AND finishedAt < ?`,
        )
        .get(from, to) as { c: number }
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
    // スプリントは版1でグローバル化 (projectId 死列除去) されたため案件削除では消さず、
    // アイテムの sprintId にも触れない (時間箱への割当は案件に従属しない。
    // docs/DECISIONS.md「案件クローズ・バッチ」決定2)。
    db.prepare("UPDATE items SET projectId = NULL WHERE projectId = ?").run(id);
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
  learnings?: Array<Record<string, unknown>>;
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
  learnings: number;
  jobs: number;
} {
  // settings はシード行を上書き(import の設定で復元)。
  if (payload.settings) {
    const merged = { ...DEFAULT_SETTINGS, ...payload.settings } as Settings;
    // import が PATCH /api/settings の起動コマンド許可リストを迂回する穴を塞ぐ。
    // claudeControlCmd/WorkerCmd を validateClaudeCmd で検証し、不正なら DEFAULT へ落とす
    // (settings 検証の単一窓口に揃える。RCE 面を import 経路からも閉じる)。
    if (!validateClaudeCmd(merged.claudeControlCmd, merged.claudeAllowedFlags)) {
      merged.claudeControlCmd = DEFAULT_SETTINGS.claudeControlCmd;
    }
    if (!validateClaudeCmd(merged.claudeWorkerCmd, merged.claudeAllowedFlags)) {
      merged.claudeWorkerCmd = DEFAULT_SETTINGS.claudeWorkerCmd;
    }
    db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(merged));
  }

  // items.parentId は即時(非DEFERRABLE) FK。export は親→子順を保証しないため、
  // foreign_keys=ON のまま子→親順に INSERT すると FK 違反 throw する。
  // better-sqlite3 は db.transaction 内の PRAGMA を無視するため、トランザクション外で
  // foreign_keys=OFF にして restoreRows 群を流し、foreign_key_check で整合確認後 ON に戻す。
  db.pragma("foreign_keys = OFF");
  try {
    const result = {
      projects: restoreRows("projects", payload.projects ?? []),
      sprints: restoreRows("sprints", payload.sprints ?? []),
      items: restoreRows("items", payload.items ?? []),
      labels: restoreRows("label_events", payload.labels ?? []),
      rules: restoreRows("rules", payload.rules ?? []),
      categoryStats: restoreRows("category_stats", payload.categoryStats ?? []),
      learnings: restoreRows("learnings", payload.learnings ?? []),
      jobs: restoreRows("jobs", payload.jobs ?? []),
    };
    const fkViolations = db.pragma("foreign_key_check") as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `import: foreign_key_check failed: ${JSON.stringify(fkViolations)}`,
      );
    }
    return result;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
