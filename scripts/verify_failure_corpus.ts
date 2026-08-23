import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkIntegrityDiff } from "../src/detectors/reality.ts";
import { routeIntegrity } from "../src/integrity-policy.ts";

type CorpusCase = {
  id: string;
  expectedRule: string;
  expectedRoute: "blocking" | "advisory";
  diff: string;
};

const corpusPath = resolve("proof/failure-patterns/v1.json");
const outputPath = resolve("proof/failure-patterns/results.json");
const raw = readFileSync(corpusPath, "utf8");
const corpus = JSON.parse(raw) as { schemaVersion: number; cases: CorpusCase[] };
const cases = corpus.cases.map((item) => {
  const routed = routeIntegrity(checkIntegrityDiff(item.diff), "calibrated");
  const blockingRules = routed.results.filter((result) => result.verdict === "contradicted").map((result) => result.ruleId);
  const advisoryRules = routed.advisories.map((result) => result.ruleId);
  const actualRoute = blockingRules.includes(item.expectedRule)
    ? "blocking"
    : advisoryRules.includes(item.expectedRule)
      ? "advisory"
      : "missing";
  return {
    id: item.id,
    expectedRule: item.expectedRule,
    expectedRoute: item.expectedRoute,
    actualRoute,
    verdict: actualRoute === item.expectedRoute ? "PASS" : "FAIL",
    blockingRules,
    advisoryRules,
  };
});
const result = {
  schemaVersion: 1,
  corpusSha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  detectorMode: "calibrated",
  reproduction: "npm run proof:failure-corpus",
  summary: {
    total: cases.length,
    passed: cases.filter((item) => item.verdict === "PASS").length,
    failed: cases.filter((item) => item.verdict === "FAIL").length,
  },
  cases,
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`${result.summary.passed}/${result.summary.total} failure-pattern expectations matched`);
process.exitCode = result.summary.failed ? 1 : 0;
