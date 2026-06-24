import Database from "better-sqlite3";
import { PATHS, ensureDirs } from "./config.js";
import { DEFAULT_SETTINGS } from "./domain.js";

ensureDirs();

export const db = new Database(PATHS.db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
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
  process TEXT,
  uncertaintyResolved INTEGER NOT NULL DEFAULT 0,
  autoExecuted INTEGER NOT NULL DEFAULT 0,
  humanOverrode INTEGER NOT NULL DEFAULT 0,
  auditSampled INTEGER NOT NULL DEFAULT 0,
  executionStatus TEXT NOT NULL DEFAULT 'none',
  executionResult TEXT,
  domain TEXT NOT NULL DEFAULT 'general',
  projectDir TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (parentId) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parentId);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_disposition ON items(disposition);

CREATE TABLE IF NOT EXISTS label_events (
  id TEXT PRIMARY KEY,
  itemId TEXT NOT NULL,
  action TEXT NOT NULL,
  fromDisposition TEXT,
  toDisposition TEXT,
  category TEXT,
  note TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_item ON label_events(itemId);
CREATE INDEX IF NOT EXISTS idx_labels_created ON label_events(createdAt);

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
  agreed INTEGER NOT NULL DEFAULT 0,
  overturned INTEGER NOT NULL DEFAULT 0,
  overturnedToAuto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, aiDisposition)
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
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_item ON jobs(itemId);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(createdAt);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);
`);

// 既存DBには overturnedToAuto 列が無い (§3.6-3 の信号非対称を正すための後付け列)。
// 冪等マイグレーション: 無ければ足す。既にあれば SQLite がエラーを投げるので握り潰す。
const hasOverturnedToAuto = (
  db.prepare("PRAGMA table_info(category_stats)").all() as { name: string }[]
).some((c) => c.name === "overturnedToAuto");
if (!hasOverturnedToAuto) {
  db.exec(
    "ALTER TABLE category_stats ADD COLUMN overturnedToAuto INTEGER NOT NULL DEFAULT 0",
  );
}

// Seed settings row once.
const existing = db.prepare("SELECT json FROM settings WHERE id = 1").get() as
  | { json: string }
  | undefined;
if (!existing) {
  db.prepare("INSERT INTO settings (id, json) VALUES (1, ?)").run(
    JSON.stringify(DEFAULT_SETTINGS),
  );
}
