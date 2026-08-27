import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Continuity Staple publishes a bounded reproducible performance protocol", () => {
  const packageDocument = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
  const protocol = JSON.parse(readFileSync(new URL("../benchmarks/continuity-staple-performance-protocol-v1.json", import.meta.url), "utf8")) as {
    schemaVersion: number;
    budgets: Record<string, number>;
    iterations: Record<string, number>;
    rules: string[];
  };
  assert.equal(packageDocument.scripts?.["benchmark:continuity-staple"], "tsx scripts/benchmark_continuity_staple.ts");
  assert.equal(protocol.schemaVersion, 1);
  assert.deepEqual(protocol.budgets, {
    stapleBytesMaximum: 8192,
    coreP95MillisecondsMaximum: 2,
    fileP95MillisecondsMaximum: 5,
    coldCliP95MillisecondsMaximum: 250,
  });
  assert.deepEqual(protocol.iterations, { core: 10000, file: 2000, coldCli: 50 });
  assert.ok(protocol.rules.some((rule) => /not present.*universal|not.*universal/i.test(rule)));
});
