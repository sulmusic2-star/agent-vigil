import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkIntegrityDiff } from "../src/detectors/reality.ts";
import { routeIntegrity } from "../src/integrity-policy.ts";

type CorpusCase = {
  id: string;
  expectedRule: string;
  expectedRoute: "blocking" | "advisory";
  diff: string;
};

const corpus = JSON.parse(readFileSync(new URL("../proof/failure-patterns/v1.json", import.meta.url), "utf8")) as {
  cases: CorpusCase[];
};

test("public failure corpus contains 20 distinct cases", () => {
  assert.equal(corpus.cases.length, 20);
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, 20);
});

for (const item of corpus.cases) {
  test(`failure corpus: ${item.id}`, () => {
    const routed = routeIntegrity(checkIntegrityDiff(item.diff), "calibrated");
    const surface = item.expectedRoute === "blocking" ? routed.results : routed.advisories;
    assert.ok(surface.some((result) => result.ruleId === item.expectedRule), `${item.expectedRule} was not ${item.expectedRoute}`);
  });
}
