// wilsonLowerBound の決定論テスト (docs/INVARIANTS.md「較正母数の純度」)。
// 緩め方向の自動化は Wilson 下限 + probation だけ — その土台となる下限計算が
// 「小標本では緩めない(安全側)」性質を持つことを runtime で固定する。
// - total<1 → 0 (判定不能は緩めない)。
// - z=1.96 の代表例を独立の手計算値(標準的な Wilson 下限表と一致)と誤差付きで検算。
// - successes 単調増加で下限も単調非減少 (証拠が増えるほど下限は下がらない)。
// - total 増加(比率固定)で点推定へ下から収束する方向 (常に点推定未満で単調接近)。
// - 戻り値は常に [0,1] (負は 0 に clamp、上限は denom>1 で数学的に 1 未満)。
import "./testing/tmp-home.js"; // ← 必ず先頭: calibration.ts → repo.js → db.js が WINNOW_HOME を読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { wilsonLowerBound } from "./calibration.js";

/** 浮動小数の検算は厳密等値でなく誤差付きで比較する。 */
function approx(actual: number, expected: number, eps: number, msg: string): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${msg}: expected ${actual} ≈ ${expected} (±${eps})`,
  );
}

test("total<1 は 0 を返す(判定不能は緩めない=安全側)", () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(5, 0), 0); // successes があっても total が無ければ緩めない
  assert.equal(wilsonLowerBound(0, -1), 0);
  assert.equal(wilsonLowerBound(1, 0.5), 0); // 端数 total も 1 未満なら判定不能扱い
});

test("z=1.96 の代表例を手計算値と検算する", () => {
  // 標準的な Wilson score interval (95%) の下限。独立に手計算した値と 1e-4 で一致する事。
  approx(wilsonLowerBound(8, 10), 0.4902, 1e-4, "8/10");
  approx(wilsonLowerBound(10, 10), 0.7225, 1e-4, "10/10 (全勝でも下限は 1 に張り付かない)");
  approx(wilsonLowerBound(1, 1), 0.2065, 1e-4, "1/1 (n=1 の全勝は大きく割り引かれる)");
  // 0/n は解析的に厳密 0: center = margin = z²/(2n)。
  assert.equal(wilsonLowerBound(0, 10), 0);
  assert.equal(wilsonLowerBound(0, 100), 0);
});

test("successes 単調増加で下限は単調非減少", () => {
  for (const total of [1, 5, 10, 37, 100]) {
    let prev = -Infinity;
    for (let s = 0; s <= total; s++) {
      const lb = wilsonLowerBound(s, total);
      assert.ok(
        lb >= prev,
        `total=${total}: lb(${s})=${lb} が lb(${s - 1})=${prev} を下回った`,
      );
      prev = lb;
    }
  }
});

test("total 増加(比率固定)で点推定へ下から収束する方向", () => {
  // p=0.8 固定。標本が増えるほど下限は点推定 0.8 に近づき、かつ常に下回る
  // (下限が点推定を超えたら「小標本ほど慎重」の意味が壊れる)。
  const p = 0.8;
  let prevGap = Infinity;
  for (const total of [10, 100, 1000, 10000]) {
    const lb = wilsonLowerBound(p * total, total);
    assert.ok(lb < p, `n=${total}: 下限 ${lb} が点推定 ${p} 以上になった`);
    const gap = p - lb;
    assert.ok(gap < prevGap, `n=${total}: 点推定との差 ${gap} が縮まっていない`);
    prevGap = gap;
  }
  // 収束の実効性: n=10000 では点推定との差が 1% 未満まで詰まる。
  assert.ok(prevGap < 0.01, `n=10000 でも差が ${prevGap} 残っている`);
});

test("戻り値は常に [0,1] に収まる", () => {
  for (const total of [1, 2, 3, 10, 50, 1000]) {
    for (let s = 0; s <= total; s++) {
      const lb = wilsonLowerBound(s, total);
      assert.ok(lb >= 0 && lb <= 1, `lb(${s},${total})=${lb} が [0,1] を外れた`);
    }
  }
  // z を振っても範囲は守られる (z=0 は点推定そのもの、z 大は 0 側へ潰れる)。
  for (const z of [0, 1, 1.96, 3, 10]) {
    for (const [s, t] of [
      [0, 10],
      [10, 10],
      [7, 13],
    ] as const) {
      const lb = wilsonLowerBound(s, t, z);
      assert.ok(lb >= 0 && lb <= 1, `z=${z}: lb(${s},${t})=${lb} が [0,1] を外れた`);
    }
  }
  // z=0 なら下限は点推定と一致する (割引ゼロの検算)。
  approx(wilsonLowerBound(7, 13, 0), 7 / 13, 1e-12, "z=0 は点推定");
});
