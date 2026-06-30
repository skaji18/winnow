import Database from "better-sqlite3";
import { PATHS, ensureDirs } from "./config.js";
import { DEFAULT_SETTINGS } from "./domain.js";

ensureDirs();

export const db = new Database(PATHS.db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// スキーマ版管理 (PRAGMA user_version)。単一の真実源はここ (Settings JSON ではない)。
// CODE_SCHEMA_VERSION = コードが期待する版。DB の user_version がこれより小さければ
// 版数順に MIGRATIONS の up を適用、大きければ (ダウングレード) 起動停止。
// ---------------------------------------------------------------------------
const CODE_SCHEMA_VERSION = 3;
/** export/import ペイロードのメタに使う版数 (DDLには使わない)。 */
export const SCHEMA_VERSION = CODE_SCHEMA_VERSION;

function getUserVersion(): number {
  // Number(undefined) は NaN で ?? は発火しないため、NaN を明示的に 0 へ落とす。
  const v = Number(db.pragma("user_version", { simple: true }));
  return Number.isFinite(v) ? v : 0;
}
function setUserVersion(v: number): void {
  // PRAGMA に値はバインドできない。v は MIGRATIONS の数値定数由来なので算出済み整数のみ。
  db.pragma(`user_version = ${v}`);
}

/** 起動時整合チェック。NG なら throw して listen させない (index.ts のトップレベルで落ちる)。 */
function quickCheck(): void {
  const rows = db.pragma("quick_check") as { quick_check: string }[];
  const ok = rows.length === 1 && rows[0]?.quick_check === "ok";
  if (!ok) {
    const msg = `winnow: SQLite quick_check FAILED for ${PATHS.db}: ${JSON.stringify(rows)}`;
    process.stderr.write(msg + "\n");
    throw new Error(msg);
  }
}

// 起動時の整合チェック → ダウングレード検出 (どちらも起動停止)。
quickCheck();
{
  const current = getUserVersion();
  if (current > CODE_SCHEMA_VERSION) {
    const msg = `winnow: DB schema v${current} is newer than code v${CODE_SCHEMA_VERSION} (downgrade). Refusing to start.`;
    process.stderr.write(msg + "\n");
    throw new Error(msg);
  }
}

/**
 * 版0→版1 の up。
 * 新規DB: 巨大 CREATE TABLE IF NOT EXISTS ブロックが全表を版1スキーマ (新FK版
 *   label_events / projectId 無し sprints / confBin 付き category_stats /
 *   全新カラム付き items) で作る。冪等 ensureColumn / table-rebuild は対象が空なので no-op。
 * 既存DB (version=0 から来る): CREATE は IF NOT EXISTS で no-op、ensureColumn が
 *   後付け列を冪等追加、table-rebuild ブロックが旧スキーマを検出したときだけ一度きり走る。
 *
 * 破壊的 table-rebuild (label_events FK化 / sprints 死列除去 / category_stats PK再構築) は
 * foreign_keys=OFF を要する。better-sqlite3 の db.transaction 内では PRAGMA が無視されるため
 * applyMigrations は db.transaction を使わず、ここで手動 BEGIN/COMMIT + foreign_key_check 制御する。
 */
function migrateV0toV1(d: Database.Database): void {
  d.exec(`
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'node',
  rung TEXT NOT NULL DEFAULT 'strategy',
  parentId TEXT,
  orderIndex REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'inbox',
  disposition TEXT,
  confidence REAL,
  reason TEXT,
  stakes REAL,
  reversibility REAL,
  category TEXT,
  rawDisposition TEXT,
  rawConfidence REAL,
  envEscalated INTEGER NOT NULL DEFAULT 0,
  process TEXT,
  uncertaintyResolved INTEGER NOT NULL DEFAULT 0,
  autoExecuted INTEGER NOT NULL DEFAULT 0,
  humanOverrode INTEGER NOT NULL DEFAULT 0,
  auditSampled INTEGER NOT NULL DEFAULT 0,
  executionStatus TEXT NOT NULL DEFAULT 'none',
  executionResult TEXT,
  executionSummary TEXT,
  executionOutput TEXT,
  rollbackPlan TEXT,
  declaredReversible INTEGER,
  artifacts TEXT,
  sourceUrl TEXT,
  externalKey TEXT,
  domain TEXT NOT NULL DEFAULT 'general',
  projectDir TEXT,
  projectId TEXT,
  sprintId TEXT,
  context TEXT,
  dueDate INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal',
  decomposeStatus TEXT NOT NULL DEFAULT 'none',
  decomposeOptions TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (parentId) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parentId);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_disposition ON items(disposition);

CREATE TABLE IF NOT EXISTS label_events (
  id TEXT PRIMARY KEY,
  itemId TEXT,
  action TEXT NOT NULL,
  fromDisposition TEXT,
  toDisposition TEXT,
  category TEXT,
  note TEXT,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_item ON label_events(itemId);
CREATE INDEX IF NOT EXISTS idx_labels_created ON label_events(createdAt);

CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  category TEXT,
  itemId TEXT,
  text TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'ai',
  pinned INTEGER NOT NULL DEFAULT 0,
  vetoed INTEGER NOT NULL DEFAULT 0,
  lastSeenAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
CREATE INDEX IF NOT EXISTS idx_learnings_item ON learnings(itemId);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  forcedDisposition TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_category ON rules(category);

CREATE TABLE IF NOT EXISTS category_stats (
  category TEXT NOT NULL,
  aiDisposition TEXT NOT NULL,
  confBin INTEGER NOT NULL DEFAULT 0,
  agreed INTEGER NOT NULL DEFAULT 0,
  overturned INTEGER NOT NULL DEFAULT 0,
  overturnedToAuto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, aiDisposition, confBin)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  itemId TEXT NOT NULL,
  role TEXT NOT NULL,
  kindOfWork TEXT NOT NULL,
  sessionName TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  startedAt INTEGER,
  finishedAt INTEGER,
  output TEXT,
  error TEXT,
  ipcId TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_item ON jobs(itemId);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(createdAt);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'flow',
  status TEXT NOT NULL DEFAULT 'active',
  context TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  startDate INTEGER,
  endDate INTEGER,
  status TEXT NOT NULL DEFAULT 'planned',
  createdAt INTEGER NOT NULL
);
`);

  // --- 既存DB向けの冪等カラム追加 (新規DBは CREATE 済みなので no-op) -----------
  function ensureColumn(table: string, column: string, ddl: string): void {
    const has = (
      d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((c) => c.name === column);
    if (!has) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
  function hasColumn(table: string, column: string): boolean {
    return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === column,
    );
  }

  // 旧後付け列 (§3.6-3 信号非対称 / PjM要素)。
  ensureColumn("category_stats", "overturnedToAuto", "overturnedToAuto INTEGER NOT NULL DEFAULT 0");
  ensureColumn("items", "projectId", "projectId TEXT");
  ensureColumn("items", "sprintId", "sprintId TEXT");
  ensureColumn("items", "dueDate", "dueDate INTEGER");
  ensureColumn("items", "priority", "priority TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn("projects", "context", "context TEXT NOT NULL DEFAULT ''");

  // 版1で導入する新規カラム (後段バッチが要求するものも含め全部ここで)。
  ensureColumn("items", "rawDisposition", "rawDisposition TEXT");
  ensureColumn("items", "rawConfidence", "rawConfidence REAL");
  ensureColumn("items", "envEscalated", "envEscalated INTEGER NOT NULL DEFAULT 0");
  ensureColumn("items", "executionSummary", "executionSummary TEXT");
  ensureColumn("items", "executionOutput", "executionOutput TEXT");
  ensureColumn("items", "rollbackPlan", "rollbackPlan TEXT");
  ensureColumn("items", "declaredReversible", "declaredReversible INTEGER");
  ensureColumn("items", "artifacts", "artifacts TEXT");
  ensureColumn("items", "sourceUrl", "sourceUrl TEXT");
  ensureColumn("items", "externalKey", "externalKey TEXT");
  // 分解(decompose)を execute と同じく背景ジョブ化するための状態列。
  // none=未分解 / running=分解中 / ready=分解案あり / failed=失敗。decomposeOptions は
  // ready 時の DecomposeOption[] を JSON 文字列で保持し、オーバーレイ再オープンで即表示する。
  ensureColumn("items", "decomposeStatus", "decomposeStatus TEXT NOT NULL DEFAULT 'none'");
  ensureColumn("items", "decomposeOptions", "decomposeOptions TEXT");
  ensureColumn("jobs", "ipcId", "ipcId TEXT");

  // --- 破壊的 table-rebuild (旧スキーマ検出時のみ一度きり) -----------------------
  // label_events: itemId に FK ON DELETE SET NULL を付与 + NOT NULL 解除。
  // 旧スキーマ判定 = FK が無い (PRAGMA foreign_key_list が空)。新規DBは新FK版なので skip。
  const labelFks = d.prepare("PRAGMA foreign_key_list(label_events)").all() as unknown[];
  if (labelFks.length === 0) {
    d.exec("ALTER TABLE label_events RENAME TO label_events_old");
    d.exec(`
CREATE TABLE label_events (
  id TEXT PRIMARY KEY,
  itemId TEXT,
  action TEXT NOT NULL,
  fromDisposition TEXT,
  toDisposition TEXT,
  category TEXT,
  note TEXT,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE SET NULL
);`);
    // 旧 remove は単純 DELETE で label_events を掃除しなかったため孤児 itemId が残りうる。
    // 新FK (ON DELETE SET NULL) と整合させるべく、items に存在しない itemId は NULL 化して複写。
    // これをしないと直後の foreign_key_check が孤児を新FK違反と検出し起動を恒久ブロックする。
    d.exec(
      `INSERT INTO label_events (id,itemId,action,fromDisposition,toDisposition,category,note,createdAt)
       SELECT id, CASE WHEN itemId IN (SELECT id FROM items) THEN itemId ELSE NULL END,
              action,fromDisposition,toDisposition,category,note,createdAt FROM label_events_old`,
    );
    d.exec("DROP TABLE label_events_old");
    d.exec("CREATE INDEX IF NOT EXISTS idx_labels_item ON label_events(itemId)");
    d.exec("CREATE INDEX IF NOT EXISTS idx_labels_created ON label_events(createdAt)");
  }

  // sprints: 死列 projectId を除去。旧スキーマ判定 = projectId 列が存在する。
  if (hasColumn("sprints", "projectId")) {
    d.exec("ALTER TABLE sprints RENAME TO sprints_old");
    d.exec(`
CREATE TABLE sprints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  startDate INTEGER,
  endDate INTEGER,
  status TEXT NOT NULL DEFAULT 'planned',
  createdAt INTEGER NOT NULL
);`);
    d.exec(
      `INSERT INTO sprints (id,name,goal,startDate,endDate,status,createdAt)
       SELECT id,name,goal,startDate,endDate,status,createdAt FROM sprints_old`,
    );
    d.exec("DROP TABLE sprints_old");
    // idx_sprints_project は projectId 消滅により再作成しない。
  }

  // category_stats: PRIMARY KEY を (category,aiDisposition) → (category,aiDisposition,confBin)
  // へ再構築。SQLite は PK ALTER 不可。旧スキーマ判定 = confBin 列が無い。
  // 注: ensureColumn で confBin を既に足している可能性があるが、PK の再構築は別途必要。
  // 旧PK (confBin無し) を検出する = table_info の pk フラグで confBin が PK でないこと。
  const csInfo = d.prepare("PRAGMA table_info(category_stats)").all() as {
    name: string;
    pk: number;
  }[];
  const confBinIsPk = csInfo.some((c) => c.name === "confBin" && c.pk > 0);
  if (!confBinIsPk) {
    d.exec("ALTER TABLE category_stats RENAME TO category_stats_old");
    d.exec(`
CREATE TABLE category_stats (
  category TEXT NOT NULL,
  aiDisposition TEXT NOT NULL,
  confBin INTEGER NOT NULL DEFAULT 0,
  agreed INTEGER NOT NULL DEFAULT 0,
  overturned INTEGER NOT NULL DEFAULT 0,
  overturnedToAuto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, aiDisposition, confBin)
);`);
    // 旧行は confBin=0 埋め。ensureColumn で confBin を足していれば既存値を使い、
    // 無ければ 0。重複 (category,aiDisposition,confBin) は SUM で集約。
    // 注: GROUP BY に整数リテラルを書くと序数 (列位置) と誤解されるため、confBin が
    // 旧テーブルに有るときのみ GROUP BY 句に含める (無ければ全行 confBin=0 で一意)。
    const oldHasOverturnedToAuto = (
      d.prepare("PRAGMA table_info(category_stats_old)").all() as { name: string }[]
    ).some((c) => c.name === "overturnedToAuto");
    const oldHasConfBin = (
      d.prepare("PRAGMA table_info(category_stats_old)").all() as { name: string }[]
    ).some((c) => c.name === "confBin");
    const otaSel = oldHasOverturnedToAuto ? "SUM(overturnedToAuto)" : "0";
    if (oldHasConfBin) {
      d.exec(
        `INSERT INTO category_stats (category,aiDisposition,confBin,agreed,overturned,overturnedToAuto)
         SELECT category,aiDisposition,COALESCE(confBin,0),
                SUM(agreed),SUM(overturned),${otaSel}
         FROM category_stats_old
         GROUP BY category,aiDisposition,COALESCE(confBin,0)`,
      );
    } else {
      d.exec(
        `INSERT INTO category_stats (category,aiDisposition,confBin,agreed,overturned,overturnedToAuto)
         SELECT category,aiDisposition,0,
                SUM(agreed),SUM(overturned),${otaSel}
         FROM category_stats_old
         GROUP BY category,aiDisposition`,
      );
    }
    d.exec("DROP TABLE category_stats_old");
  }

  // 部分ユニーク索引 (非null externalKey のみ一意、null は重複可)。
  d.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_items_externalkey ON items(externalKey) WHERE externalKey IS NOT NULL",
  );
}

/**
 * 版1→版2 の up。
 * 版1の migrateV0toV1 に decomposeStatus / decomposeOptions を「その場」で後付けしたが
 * CODE_SCHEMA_VERSION を据え置いたため、既に user_version=1 まで上がっていた DB は
 * migrateV0toV1 を二度と再実行せず両カラムを取りこぼした (= "no such column: decomposeStatus")。
 * 版を 2 に繰り上げ、この欠落列を冪等に補填する。新規DB(版0→1で CREATE TABLE 済み)では no-op。
 * 列追加のみで FK/PK 再構築は無いが、適用ループの規約に合わせ db.transaction は使わない。
 */
function migrateV1toV2(d: Database.Database): void {
  function ensureColumn(table: string, column: string, ddl: string): void {
    const has = (
      d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((c) => c.name === column);
    if (!has) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
  ensureColumn("items", "decomposeStatus", "decomposeStatus TEXT NOT NULL DEFAULT 'none'");
  ensureColumn("items", "decomposeOptions", "decomposeOptions TEXT");
}

/**
 * 版2→版3 の up (計画リデザイン)。
 * items に node 段メモリ列 context を追加 (nullable)、memory AIゾーンを格納する learnings
 * テーブルを冪等に新設。新規DB(版0→1で CREATE TABLE 済み)では ensureColumn/CREATE は no-op。
 * 列追加 + テーブル新設のみで FK/PK 再構築は無い。
 */
function migrateV2toV3(d: Database.Database): void {
  function ensureColumn(table: string, column: string, ddl: string): void {
    const has = (
      d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((c) => c.name === column);
    if (!has) d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
  ensureColumn("items", "context", "context TEXT");
  d.exec(`
CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  category TEXT,
  itemId TEXT,
  text TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'ai',
  pinned INTEGER NOT NULL DEFAULT 0,
  vetoed INTEGER NOT NULL DEFAULT 0,
  lastSeenAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
CREATE INDEX IF NOT EXISTS idx_learnings_item ON learnings(itemId);
`);
}

const MIGRATIONS: { v: number; up: (d: Database.Database) => void }[] = [
  { v: 1, up: migrateV0toV1 },
  { v: 2, up: migrateV1toV2 },
  { v: 3, up: migrateV2toV3 },
];

// 版数順に適用。foreign_keys=OFF を要する table-rebuild を含むため db.transaction を使わず
// 手動 BEGIN/COMMIT で原子化し、最後に foreign_key_check で整合確認 (NGなら ROLLBACK+throw)。
for (const m of MIGRATIONS) {
  if (getUserVersion() < m.v) {
    db.pragma("foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      m.up(db);
      const fkViolations = db.pragma("foreign_key_check") as unknown[];
      if (fkViolations.length > 0) {
        db.exec("ROLLBACK");
        db.pragma("foreign_keys = ON");
        const msg = `winnow: migration v${m.v} foreign_key_check failed: ${JSON.stringify(fkViolations)}`;
        process.stderr.write(msg + "\n");
        throw new Error(msg);
      }
      setUserVersion(m.v);
      db.exec("COMMIT");
    } catch (e) {
      // BEGIN は冪等に ROLLBACK (既に ROLLBACK 済みなら no-op として握り潰す)。
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      db.pragma("foreign_keys = ON");
      throw e;
    }
    db.pragma("foreign_keys = ON");
  }
}

// Seed settings row once (版適用後)。pauseAuto 等の新キーは Settings JSON 経由で
// DEFAULT_SETTINGS から補完されるため settings テーブルの DDL 変更は不要。
const existing = db.prepare("SELECT json FROM settings WHERE id = 1").get() as
  | { json: string }
  | undefined;
if (!existing) {
  db.prepare("INSERT INTO settings (id, json) VALUES (1, ?)").run(
    JSON.stringify(DEFAULT_SETTINGS),
  );
}
