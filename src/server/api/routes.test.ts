// PATCH /api/items/:id の resolution/context 書き込み口の外形テスト
// (docs/DECISIONS.md「人間実施の結果の下流受け渡し」書き込み口(API))。
// - resolution/context は人間専有の編集系フィールドとして patchSchema が受理し永続化する。
// - .strict() 維持: 較正フィールドの直書きは従来どおり 400 (口はバカ・分類器が賢い)。
// - この write 経路は較正 (label_events / category_stats) に一切触れない
//   (「記録は分類の是認ではない」。routes は actions/executor を import 済みで
//   コンパイル時保証が無いため、非接触をここで runtime 固定する)。
// - export は resolution を body/context と同列に redactSecrets へ通す (最終ゲート)。
import "../testing/tmp-home.js"; // ← 必ず先頭: routes.ts → repo.js → db.js が WINNOW_HOME を読む
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { categoryStats, items, labels } from "../repo.js";

// index.ts と同じ ZodError→400 変換を張り、.strict() の範囲外キー検証を本番同等の外形で見る。
const app = Fastify({ logger: false });
app.setErrorHandler((err, _req, reply) => {
  const e = err as { name?: string; issues?: unknown };
  if (e.name === "ZodError" || Array.isArray(e.issues)) {
    reply.code(400).send({ error: "invalid request", issues: e.issues });
    return;
  }
  reply.send(err);
});
await registerRoutes(app);
await app.ready();
after(() => app.close());

test("PATCH が resolution/context を受理して永続化する (較正には非接触)", async () => {
  const it = items.create({ title: "上流の人間判断" });
  const labelsBefore = labels.total();
  const statsBefore = categoryStats.all();

  const res = await app.inject({
    method: "PATCH",
    url: `/api/items/${it.id}`,
    payload: {
      resolution: "ベンダAで契約した。予算枠は据え置き。",
      context: "着手前の前提: 予算は今期枠のみ。",
      expectedUpdatedAt: it.updatedAt, // 楽観ロックの正常系も同時に通す
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { resolution: string | null; context: string | null };
  assert.equal(body.resolution, "ベンダAで契約した。予算枠は据え置き。");
  assert.equal(body.context, "着手前の前提: 予算は今期枠のみ。");
  // DB に残っている (patchSchema → items.update → mapItem の経路が通しで揃っている事)。
  assert.equal(items.get(it.id)?.resolution, "ベンダAで契約した。予算枠は据え置き。");
  assert.equal(items.get(it.id)?.context, "着手前の前提: 予算は今期枠のみ。");
  // 較正非接触: 記録は分類の是認ではない (label_events / category_stats が動かない)。
  assert.equal(labels.total(), labelsBefore);
  assert.deepEqual(categoryStats.all(), statsBefore);
});

test(".strict() 維持: 較正フィールドの直書きは 400 のまま", async () => {
  const it = items.create({ title: "分類器バイパスの試み" });
  const res = await app.inject({
    method: "PATCH",
    url: `/api/items/${it.id}`,
    payload: { disposition: "auto", resolution: "同時に送っても弾かれる" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(items.get(it.id)?.resolution, null); // 部分適用もしない
});

test("export は resolution 内の秘密を伏字化する (最終ゲート)", async () => {
  const token = "ghp_" + "a".repeat(30);
  const it = items.create({ title: "秘密入りの実施結果", resolution: `トークン ${token} で対応した` });
  const res = await app.inject({ method: "GET", url: "/api/export" });
  assert.equal(res.statusCode, 200);
  const payload = res.json() as { data: { items: { id: string; resolution: string }[] } };
  const exported = payload.data.items.find((x) => x.id === it.id);
  assert.ok(exported, "export に item が出ていない");
  assert.ok(exported.resolution.includes("[REDACTED-TOKEN]"), exported.resolution);
  assert.ok(!exported.resolution.includes(token), "生トークンが export に素通しになっている");
});
