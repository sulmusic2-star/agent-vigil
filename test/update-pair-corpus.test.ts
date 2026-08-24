import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const corpus = new URL("../proof/update-pair-corpus/", import.meta.url);

test("the published 15-pair corpus has three bounded regressions and no published private evidence", () => {
  const output = execFileSync(
    process.execPath,
    ["proof/update-pair-corpus/verify-durable-corpus.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  assert.match(output, /PASS 10 durable corpus commitments/);
  assert.match(output, /historical tarballs, receipts, and runtime executions were not replayed/);

  const pairs = JSON.parse(readFileSync(new URL("pairs.json", corpus), "utf8")) as {
    pairs: Array<{ materialRegression?: { independentlyReproduced: boolean } }>;
  };
  const validation = JSON.parse(
    readFileSync(new URL("metadata/corpus-validation.json", corpus), "utf8"),
  ) as {
    checks: {
      exactPairs: number;
      independentlyReproducedMaterialRegressions: number;
      safeReceipts: number;
    };
  };

  assert.equal(pairs.pairs.length, 15);
  assert.equal(
    pairs.pairs.filter((pair) => pair.materialRegression?.independentlyReproduced).length,
    3,
  );
  assert.equal(validation.checks.exactPairs, 15);
  assert.equal(validation.checks.independentlyReproducedMaterialRegressions, 3);
  assert.equal(validation.checks.safeReceipts, 0);

  for (const privatePath of ["fixtures", "logs", "receipts"]) {
    assert.equal(existsSync(new URL(`${privatePath}/`, corpus)), false);
  }
});
