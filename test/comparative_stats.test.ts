import assert from "node:assert/strict";
import test from "node:test";
import { holmAdjust, mcnemarExact, pairedBootstrapMeanDifference, wilsonInterval } from "../scripts/comparative_stats.ts";

test("Wilson interval matches a published calculator-scale reference", () => {
  const interval = wilsonInterval(81, 100);
  assert.ok(Math.abs(interval.low - 0.72221155) < 0.0000001);
  assert.ok(Math.abs(interval.high - 0.87485248) < 0.0000001);
});

test("Wilson interval handles boundary counts and rejects invalid inputs", () => {
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
  const zero = wilsonInterval(0, 10);
  assert.equal(zero.low, 0);
  assert.ok(zero.high > 0 && zero.high < 0.3);
  const full = wilsonInterval(10, 10);
  assert.ok(full.low > 0.7);
  assert.ok(Math.abs(full.high - 1) < Number.EPSILON);
  assert.throws(() => wilsonInterval(11, 10));
});

test("exact McNemar reproduces symmetric and one-sided discordance", () => {
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(mcnemarExact(3, 3), 1);
  assert.equal(mcnemarExact(0, 10), 0.001953125);
  assert.equal(mcnemarExact(10, 0), 0.001953125);
});

test("Holm adjustment preserves input order and monotonic correction", () => {
  const adjusted = holmAdjust([0.01, 0.04, 0.03]);
  assert.deepEqual(adjusted.map((value) => Number(value.toFixed(4))), [0.03, 0.06, 0.06]);
});

test("paired bootstrap is deterministic and centers on paired mean difference", () => {
  const first = pairedBootstrapMeanDifference([2, 4, 6, 8], [1, 1, 3, 3], { resamples: 1_000, seed: 7 });
  const second = pairedBootstrapMeanDifference([2, 4, 6, 8], [1, 1, 3, 3], { resamples: 1_000, seed: 7 });
  assert.deepEqual(first, second);
  assert.equal(first.estimate, 3);
  assert.ok(first.low <= first.estimate && first.high >= first.estimate);
});
