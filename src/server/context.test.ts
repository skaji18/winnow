// context.ts の注入まわりの決定論テスト (docs/INVARIANTS.md「注入（コンテキスト）の信頼境界と天井」)。
// - clip: 前方優先 slice + 番兵で省略を可視化する(黙って欠落させない)。予算ゼロはゾーンごと省く。
//   UTF-16 サロゲートペアの途中で切らない。
// - redactSecrets: 代表的なシークレット形(GitHub トークン・AWS キー・PEM 本文などの高エントロピー
//   40+ 連続)を伏字化し、閾値未満・平文は変えない(誤検出は安全側=伏字に倒す設計だが、
//   短い平文まで潰さない事もここで固定する)。
// - buildContextBlock: 結合後テキストへの redactSecrets 1回だけの最終ゲートを通る事、
//   天井(MAX_CONTEXT_CHARS=16k 相当)で人間ゾーンを優先して残し AIゾーンが残予算に収まる事
//   (切り詰め順を逆転させない=学びが productContext を押し出さない)。
// - buildContextPreview: 実注入と完全一致の文字列を返しつつ learnings.touch を発火させない事
//   (read-only=プレビューで眺めただけの学びを減衰から延命させない)。ゾーン文字数は
//   切り詰め・伏字化後=block 内の実長と一致する事(秘密で縮んだ分を過大表示しない)。
import "./testing/tmp-home.js"; // ← 必ず先頭: context.ts → repo.js → db.js が WINNOW_HOME を読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, redactSecrets, buildContextBlock, buildContextPreview } from "./context.js";
import { items, learnings, settings } from "./repo.js";
import { db } from "./db.js";

// context.ts の MAX_CONTEXT_CHARS は export されていないため、同値をここに写して
// buildContextBlock の観測可能な挙動(切り詰め位置・総量の上界)として固定する。
// 実装側の値が変わったらこのテストが割れて気付ける。
const CEILING = 16000;

// ---------------------------------------------------------------------------
// clip
// ---------------------------------------------------------------------------

test("clip: max 以下ならそのまま返し番兵を付けない(max ちょうども含む)", () => {
  assert.equal(clip("abc", 10, "…"), "abc");
  assert.equal(clip("abc", 3, "…"), "abc"); // 境界: ちょうど max は切らない
  assert.equal(clip("", 5, "…"), "");
});

test("clip: 超過時は先頭 max 文字 + 番兵(前方優先・省略の可視化)", () => {
  const sentinel = "\n…(省略)";
  assert.equal(clip("abcdef", 3, sentinel), "abc" + sentinel);
  // 番兵は max 予算の外側に付く(本文は max 文字きっかり残る)
  assert.equal(clip("abcdef", 3, sentinel).length, 3 + sentinel.length);
});

test("clip: 予算ゼロ以下はゾーンごと省く(番兵だけの注入をしない)", () => {
  assert.equal(clip("abcdef", 0, "…"), "");
  assert.equal(clip("abcdef", -1, "…"), "");
});

test("clip: サロゲートペアの途中で切らない(先頭サロゲート単独残りを作らない)", () => {
  // "ab😀cd" = a b \uD83D \uDE00 c d (length 6)
  const text = "ab\u{1F600}cd";
  // max=3 だと slice が高サロゲートで終わる → 1 文字捨てて "ab" + 番兵
  assert.equal(clip(text, 3, "…"), "ab…");
  // max=4 はペアが完結しているのでそのまま残す
  assert.equal(clip(text, 4, "…"), "ab\u{1F600}…");
  // 切り出し結果の末尾に孤立高サロゲートが残らない事を一般に確認
  for (let max = 1; max <= 5; max++) {
    const cut = clip(text, max, "");
    const last = cut.charCodeAt(cut.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `max=${max}: 末尾が孤立高サロゲート`);
  }
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

test("redactSecrets: GitHub トークン(gh[pousr]_ + 20+ 英数)を伏字化する", () => {
  for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
    const token = `${prefix}_${"a1B2".repeat(9)}`; // 接頭辞 + 36 文字
    const out = redactSecrets(`deploy token=${token} を使う`);
    assert.ok(!out.includes(token), `${prefix}: 生トークンが残った`);
    assert.ok(out.includes("[REDACTED-TOKEN]"), `${prefix}: 伏字マーカーが無い`);
  }
});

test("redactSecrets: AWS アクセスキー(AKIA + 16 文字)を伏字化する", () => {
  const key = "AKIAIOSFODNN7EXAMPLE"; // AWS ドキュメントの例示キー形
  const out = redactSecrets(`aws_access_key_id = ${key}`);
  assert.ok(!out.includes(key));
  assert.ok(out.includes("[REDACTED-AWS-KEY]"));
});

test("redactSecrets: 高エントロピー40+連続(base64/PEM 本文)を伏字化する", () => {
  const run40 = "A0b1".repeat(10); // ちょうど 40 文字
  assert.ok(redactSecrets(run40).includes("[REDACTED-HIGH-ENTROPY]"));
  // PEM 秘密鍵: ヘッダは残ってよいが base64 本文(64 文字行)は落ちる事
  const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
  const pem = `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`;
  const out = redactSecrets(pem);
  assert.ok(!out.includes(pemBody), "PEM 本文が残った");
  assert.ok(out.includes("[REDACTED-HIGH-ENTROPY]"));
});

test("redactSecrets: 閾値未満・通常の文章は変えない(伏字化は保守的閾値)", () => {
  const run39 = "A0b1".repeat(9) + "A0b"; // 39 文字 = 閾値未満
  assert.equal(redactSecrets(run39), run39);
  const plain = "通常のタスク説明。variable_name_1 と someFunctionCall() を直す。";
  assert.equal(redactSecrets(plain), plain);
  // 20 文字未満の gh 接頭辞も温存(短すぎるものまで潰さない)
  const shortGh = "ghp_short12345";
  assert.equal(redactSecrets(shortGh), shortGh);
});

test("redactSecrets: 複数種・複数出現をすべて伏字化する", () => {
  const t1 = `ghp_${"x9Y8".repeat(9)}`;
  const t2 = `gho_${"Q7w6".repeat(9)}`;
  const out = redactSecrets(`一つ目 ${t1} と二つ目 ${t2} と AKIAIOSFODNN7EXAMPLE`);
  assert.ok(!out.includes(t1) && !out.includes(t2) && !out.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.equal(out.match(/\[REDACTED-TOKEN\]/g)?.length, 2);
  assert.equal(out.match(/\[REDACTED-AWS-KEY\]/g)?.length, 1);
});

// ---------------------------------------------------------------------------
// buildContextBlock (tmp-home の使い捨て DB 上で settings/learnings を組み立てる)
// ---------------------------------------------------------------------------

// 人間ゾーン/AIゾーンそれぞれの番兵の識別子(実装の文言の一部)。
const HUMAN_SENTINEL_MARK = "文脈が長すぎるため後半を省略";
const AI_SENTINEL_MARK = "学びが多いため一部を省略";
const AI_ZONE_HEADING = "### AI が観測した学び";

test("buildContextBlock: 前提が何も無ければ空文字(空見出しをトークンとして漏らさない)", () => {
  const item = items.create({ title: "空テスト" });
  assert.equal(buildContextBlock(item), "");
});

// 各テストは productContext を汚すため、t.after で復元する (assert 失敗時もスキップされない)。
test("buildContextBlock: 結合後テキストが redactSecrets の最終ゲートを通る", (t) => {
  t.after(() => settings.update({ productContext: "" }));
  const token = `ghp_${"z1X2".repeat(9)}`;
  settings.update({ productContext: `デプロイには ${token} を使う` });
  const item = items.create({ title: "伏字テスト" });
  const out = buildContextBlock(item);
  assert.ok(out.includes("## 文脈"), "文脈ブロックの見出しが無い");
  assert.ok(!out.includes(token), "productContext 由来の生トークンが注入された");
  assert.ok(out.includes("[REDACTED-TOKEN]"));
});

test("buildContextBlock: 人間ゾーンが先頭・AIゾーンが後段の順で連結される", (t) => {
  t.after(() => settings.update({ productContext: "" }));
  settings.update({ productContext: "小さなプロダクト前提。" });
  learnings.record({ text: "学びマーカーL1: ログは構造化する。", category: null });
  const item = items.create({ title: "順序テスト" });
  const out = buildContextBlock(item);
  const humanIdx = out.indexOf("### プロダクト全体の前提");
  const aiIdx = out.indexOf(AI_ZONE_HEADING);
  assert.ok(humanIdx >= 0, "人間ゾーンが無い");
  assert.ok(aiIdx >= 0, "AIゾーンが無い");
  assert.ok(humanIdx < aiIdx, "人間ゾーンが AIゾーンより後に来た(信頼度順の逆転)");
  assert.ok(out.includes("学びマーカーL1"));
});

test("buildContextBlock: 両ゾーン満杯時は人間ゾーンを無傷で残し AIゾーンだけ残予算に切り詰める", (t) => {
  t.after(() => settings.update({ productContext: "" }));
  // 人間ゾーン ≈ 15815 文字 (< 16000 なので人間ゾーンは切られない)。
  // AIゾーンの予算は残り ≈ 185 文字しか無く、長い学びは番兵付きで切られる事。
  const product = "前提".repeat(7900); // 15800 文字 (英数40+連続を含まない=伏字化の影響なし)
  settings.update({ productContext: product });
  learnings.record({ text: "長い学びマーカーL2。" + "学".repeat(2000), category: null });
  const item = items.create({ title: "AIゾーン切り詰めテスト" });
  const out = buildContextBlock(item);
  assert.ok(!out.includes(HUMAN_SENTINEL_MARK), "人間ゾーンが切られた(優先順の逆転)");
  assert.ok(out.includes(AI_ZONE_HEADING), "AIゾーンの先頭(見出し)まで消えた");
  assert.ok(out.includes(AI_SENTINEL_MARK), "AIゾーンの省略が可視化されていない");
  // 注入総量は天井 + 番兵/見出し程度に収まる(ARG_MAX 防御が破れていない)
  assert.ok(out.length <= CEILING + 300, `総量 ${out.length} が天井を大きく超えた`);
});

test("buildContextBlock: 人間ゾーン単独で天井超過なら人間ゾーンを番兵付きで切り AIゾーンは省く", (t) => {
  t.after(() => settings.update({ productContext: "" }));
  // 残留状態に依存せず自前で学びを用意する(単独実行・並べ替えでも「学びが漏れない」検証力を保つ)。
  learnings.record({ text: "学びマーカーL3: 天井テスト用の学び。", category: null });
  const product = "前提".repeat(14000); // 28000 文字 > 16000
  settings.update({ productContext: product });
  const item = items.create({ title: "天井テスト" });
  const out = buildContextBlock(item);
  assert.ok(out.includes("### プロダクト全体の前提"), "productContext の先頭が残っていない");
  assert.ok(out.includes(HUMAN_SENTINEL_MARK), "人間ゾーンの省略が可視化されていない(黙った欠落)");
  assert.ok(!out.includes(AI_ZONE_HEADING), "残予算ゼロなのに AIゾーンが注入された");
  assert.ok(!out.includes("学びマーカーL3"), "予算ゼロの AIゾーンから学びが漏れた");
  assert.ok(!out.includes(AI_SENTINEL_MARK), "予算ゼロのゾーンに番兵だけ注入された");
  // 人間ゾーン本文は天井きっかりで切られている(前方優先 slice)
  assert.ok(out.length <= CEILING + 300, `総量 ${out.length} が天井を大きく超えた`);
});

// ---------------------------------------------------------------------------
// buildContextPreview (実注入との一致 + touch 副作用の分離)
// ---------------------------------------------------------------------------

test("buildContextPreview: lastSeenAt を更新しない(対比: buildContextBlock は更新する)", (t) => {
  t.after(() => settings.update({ productContext: "" }));
  settings.update({ productContext: "プレビュー対比テストの前提。" });
  const text = "学びマーカーP1: プレビューは touch しない。";
  learnings.record({ text, category: null });
  // 生存信号の起点を 60 秒過去に倒す (record 直後だと touch の now() と同一 ms になり得て
  // 「更新された/されなかった」が見分けられない)。減衰 cutoff (既定30日) より十分新しいので
  // 注入候補のままである事に注意。
  const backdated = Date.now() - 60_000;
  db.prepare("UPDATE learnings SET lastSeenAt = ? WHERE text = ?").run(backdated, text);
  const item = items.create({ title: "プレビュー touch テスト" });

  const preview = buildContextPreview(item);
  assert.ok(preview.block.includes("学びマーカーP1"), "プレビューに学びが注入されていない");
  assert.equal(
    learnings.findDuplicate(null, text)?.lastSeenAt,
    backdated,
    "プレビューが lastSeenAt を更新した(眺めただけの学びが減衰から延命される)",
  );
  // 対比: 本注入は生存信号を更新する (減衰の起点=実注入の事実)。
  buildContextBlock(item);
  assert.ok(
    (learnings.findDuplicate(null, text)?.lastSeenAt ?? 0) > backdated,
    "本注入 buildContextBlock が lastSeenAt を更新しなかった",
  );
});

test("buildContextPreview: block は buildContextBlock の実注入文字列と完全一致し天井を返す", (t) => {
  t.after(() => settings.update({ productContext: "" }));
  settings.update({ productContext: "一致テストの前提。" });
  learnings.record({ text: "学びマーカーP2: 一致テスト用。", category: null });
  const item = items.create({ title: "プレビュー一致テスト" });
  const preview = buildContextPreview(item);
  // touch の有無以外は同一の組み立て=文字列は完全一致 (ドリフト=プレビューが嘘をつく、の検出)。
  assert.equal(preview.block, buildContextBlock(item), "プレビューが実注入とドリフトした");
  assert.equal(preview.maxChars, CEILING);
  // ゾーン文字数は切り詰め後(=実際に注入される長さ)。両ゾーン非空・天井以下。
  assert.ok(preview.humanZoneChars > 0, "人間ゾーン文字数が 0");
  assert.ok(preview.aiZoneChars > 0, "AIゾーン文字数が 0");
  assert.ok(preview.humanZoneChars <= CEILING && preview.aiZoneChars <= CEILING);
});

test("buildContextPreview: ゾーン文字数は伏字化後=block 内の実長と一致する(秘密で過大表示しない)", (t) => {
  t.after(() => settings.update({ productContext: "" }));
  const secret = "A0b1".repeat(16); // 64字の高エントロピー連続 → 23字の [REDACTED-HIGH-ENTROPY] に縮む
  const raw = `デプロイ鍵 ${secret} を使う`;
  settings.update({ productContext: raw });
  const item = items.create({ title: "文字数一致テスト" });
  const preview = buildContextPreview(item);
  assert.ok(preview.block.includes("[REDACTED-HIGH-ENTROPY]"), "伏字化が発火していない");
  // clip 直後(伏字化前)の人間ゾーンは "### プロダクト全体の前提\n" + raw。数字がそれより
  // 小さい=伏字化後の長さで計上されている(過大側の嘘を返していない)事を固定する。
  assert.ok(
    preview.humanZoneChars < "### プロダクト全体の前提\n".length + raw.length,
    "humanZoneChars が伏字化前の長さのまま(実注入より過大表示)",
  );
  // block の外形 (\n見出し\n本文\n) から本文を取り出し、区画別文字数の合算(両ゾーン非空なら
  // 結合セパレータ "\n\n" の2文字を足す)と正確に一致する事=数えれば数字と合う事を固定する。
  const body = preview.block.match(/^\n## 文脈（必ずこれに沿って判断・分解・実行する）\n([\s\S]*)\n$/)?.[1];
  assert.ok(body != null, "block の外形が想定と違う");
  const sep = preview.humanZoneChars > 0 && preview.aiZoneChars > 0 ? 2 : 0;
  assert.equal(
    body.length,
    preview.humanZoneChars + sep + preview.aiZoneChars,
    "ゾーン文字数の合算が block の実長と一致しない",
  );
});

test("buildContextPreview: block が redactSecrets の最終ゲートを通っている", (t) => {
  t.after(() => settings.update({ productContext: "" }));
  const token = `ghp_${"k3J4".repeat(9)}`;
  settings.update({ productContext: `プレビューでも ${token} は見せない` });
  const item = items.create({ title: "プレビュー伏字テスト" });
  const preview = buildContextPreview(item);
  assert.ok(!preview.block.includes(token), "プレビューに生トークンが漏れた");
  assert.ok(preview.block.includes("[REDACTED-TOKEN]"));
});
