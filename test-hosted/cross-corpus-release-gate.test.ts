import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FROZEN_CROSS_CORPUS_GATE, verifyCrossCorpusGate } from "../scripts/verify_cross_corpus_benchmark.ts";
import { isGeneratedOrVendorPath } from "../src/detectors/reality.ts";

const frozenSha = "b2b681ff529929d39a14c0541d0e2b71b642b5da";

test("scheduled and release workflows enforce the same frozen cross-corpus gate", () => {
  const scheduled = readFileSync(".github/workflows/cross-corpus-benchmark.yml", "utf8");
  const release = readFileSync(".github/workflows/publish.yml", "utf8");
  for (const [name, workflow] of [["scheduled", scheduled], ["release", release]] as const) {
    assert.match(workflow, new RegExp(frozenSha), `${name} workflow must select the frozen source commit`);
    assert.match(workflow, /benchmark:swarm(?:\s|$)/, `${name} workflow must reproduce the oracle result`);
    assert.match(workflow, /benchmark:swarm-real(?:\s|$)/, `${name} workflow must reproduce the real-PR result`);
    assert.match(workflow, /benchmark:gate(?:\s|$)/, `${name} workflow must enforce the benchmark boundary`);
  }
});

test("the benchmark protocol binds corpus size, recall, noise, and incomplete evidence", () => {
  const protocol = FROZEN_CROSS_CORPUS_GATE;
  assert.equal(protocol.schemaVersion, 2);
  assert.equal(protocol.source.commit, frozenSha);
  assert.equal(protocol.source.oracleTree, "afb71177457fd15a6b8e39b88c0a98564cc5e9a7");
  assert.equal(protocol.source.realPrTree, "00d30fd8660822313306d6960ffb83c287f3fff3");
  assert.equal(protocol.oracle.scopedCases, 220);
  assert.equal(protocol.oracle.minExactRecall, 1);
  assert.equal(protocol.oracle.maxTargetedFalsePositives, 0);
  assert.equal(protocol.realPrCalibration.prs, 232);
  assert.equal(protocol.realPrCalibration.maxAdvisoryPrs, 104);
  assert.equal(protocol.realPrCalibration.maxIncompleteStaticAudits, 9);
  assert.equal(protocol.realPrCalibration.arbiterCases, 4);
  assert.equal(protocol.realPrCalibration.minAnyAdvisory, 4);
  assert.equal(protocol.realPrCalibration.minExactCategoryAdvisory, 2);
});

test("the benchmark derives exclusions from the production static-audit predicate", () => {
  const source = readFileSync("scripts/benchmark_swarm_oracle.ts", "utf8");
  assert.match(source, /isGeneratedOrVendorPath\(label\.file\)/);
  assert.equal(isGeneratedOrVendorPath("dist/generated.js"), true);
  assert.equal(isGeneratedOrVendorPath("packages/app/dist/source.test.js"), false);
  assert.equal(isGeneratedOrVendorPath("tests/example.snap"), false);
});

test("the package exposes one deterministic benchmark gate command", () => {
  const packageDocument = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(packageDocument.scripts?.["benchmark:gate"], "tsx scripts/verify_cross_corpus_benchmark.ts");
});

test("the benchmark gate fails closed when catch quality falls or review burden rises", () => {
  const oracle = {
    schemaVersion: 2,
    tool: { version: "0.23.4" },
    source: { repository: FROZEN_CROSS_CORPUS_GATE.source.repository, commit: frozenSha, corpusTree: FROZEN_CROSS_CORPUS_GATE.source.oracleTree },
    summary: { scopedCases: 220, exactRecall: 0.99, honestTargetedFalsePositives: 1 },
  };
  const real = {
    schemaVersion: 2,
    tool: { version: "0.23.4" },
    source: { repository: FROZEN_CROSS_CORPUS_GATE.source.repository, commit: frozenSha, corpusTree: FROZEN_CROSS_CORPUS_GATE.source.realPrTree },
    presumedClean: { prs: 232, prsWithAdvisories: 135, incompleteStaticAudits: 10 },
    arbiterAgreedTrueCheats: { cases: 4, anyAdvisory: 3, exactCategoryAdvisory: 1 },
  };
  const errors = verifyCrossCorpusGate(FROZEN_CROSS_CORPUS_GATE, oracle, real).join("\n");
  assert.match(errors, /exact recall regressed/);
  assert.match(errors, /false positives increased/);
  assert.match(errors, /advisory burden increased/);
  assert.match(errors, /incomplete static audits increased/);
  assert.match(errors, /any-advisory catches regressed/);
  assert.match(errors, /exact-category catches regressed/);
});

test("the committed benchmark ledger states its current quality and review burden", () => {
  const oracle = JSON.parse(readFileSync("benchmarks/swarm-oracle-results.json", "utf8"));
  const real = JSON.parse(readFileSync("benchmarks/swarm-real-results.json", "utf8"));
  assert.equal(oracle.schemaVersion, 2);
  assert.equal(oracle.source.commit, frozenSha);
  assert.equal(oracle.source.corpusTree, FROZEN_CROSS_CORPUS_GATE.source.oracleTree);
  assert.equal(oracle.summary.exactCatches, 220);
  assert.equal(oracle.summary.scopedCases, 220);
  assert.equal(oracle.summary.honestTargetedFalsePositives, 0);
  assert.equal(oracle.summary.honestOtherFindings, 1);
  assert.equal(real.schemaVersion, 2);
  assert.equal(real.source.commit, frozenSha);
  assert.equal(real.source.corpusTree, FROZEN_CROSS_CORPUS_GATE.source.realPrTree);
  assert.equal(real.presumedClean.prsWithAdvisories, 99);
  assert.equal(real.presumedClean.incompleteStaticAudits, 9);
  assert.equal(real.arbiterAgreedTrueCheats.anyAdvisory, 4);
  assert.equal(real.arbiterAgreedTrueCheats.exactCategoryAdvisory, 2);
});
