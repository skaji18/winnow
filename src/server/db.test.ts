// 版5 マイグレーション (items.resolution) の決定論テスト
// (docs/INVARIANTS.md「DB スキーマ変更の規約」: CODE_SCHEMA_VERSION 繰り上げ + 冪等 ensureColumn)。
// - 新規DB起動で user_version=5・items.resolution 列が存在する。
// - repo 経由で resolution が往復する (create/update/get。nullable=未記入は null のまま)。
// - 再オープンで冪等: user_version を 4 に戻して db.ts を別プロセスで再評価しても
//   migrateV4toV5 が no-op で成功し 5 に戻る (列の二重追加で落ちない)。
import "./testing/tmp-home.js"; // ← 必ず先頭: db.ts が WINNOW_HOME を読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { TEST_WINNOW_HOME } from "./testing/tmp-home.js";
import { db } from "./db.js";
import { items } from "./repo.js";

function userVersion(): number {
  return Number(db.pragma("user_version", { simple: true }));
}
function itemColumns(): string[] {
  return (db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map(
    (c) => c.name,
  );
}

test("新規DB起動で user_version=5・items.resolution 列が存在する", () => {
  assert.equal(userVersion(), 5);
  assert.ok(itemColumns().includes("resolution"), "items.resolution 列が無い");
});

test("repo 経由で resolution が往復する (未記入は null のまま)", () => {
  const created = items.create({ title: "人間実施タスク" });
  assert.equal(created.resolution, null); // nullable 既定=未記入
  const updated = items.update(created.id, { resolution: "A案で確定。B案は費用超過で却下。" });
  assert.equal(updated?.resolution, "A案で確定。B案は費用超過で却下。");
  // DB から読み直しても残っている (mapItem/INSERT/UPDATE の3経路が揃っている事)。
  assert.equal(items.get(created.id)?.resolution, "A案で確定。B案は費用超過で却下。");
});

test("再オープンで冪等: 版4に戻して再マイグレーションしても成功し 5 に戻る", () => {
  const before = items.create({ title: "冪等性の生存確認", resolution: "既存データ" });
  db.pragma("user_version = 4");
  // db.ts はモジュール評価時にマイグレーションを走らせるため、再オープン=別プロセスで
  // 同じ WINNOW_HOME を指して import し直す (同一プロセスの ESM キャッシュでは再評価できない)。
  const dbTs = path.join(path.dirname(fileURLToPath(import.meta.url)), "db.ts");
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `import(${JSON.stringify(pathToFileURL(dbTs).href)}).catch((e) => { console.error(e); process.exit(1); })`,
    ],
    { env: { ...process.env, WINNOW_HOME: TEST_WINNOW_HOME }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `再オープンが失敗した: ${r.stderr}`);
  assert.equal(userVersion(), 5);
  assert.ok(itemColumns().includes("resolution"));
  // 既存データは無傷 (ensureColumn の no-op で列も値も壊れない)。
  assert.equal(items.get(before.id)?.resolution, "既存データ");
});
