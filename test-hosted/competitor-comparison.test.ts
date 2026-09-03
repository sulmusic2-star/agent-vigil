import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const result = JSON.parse(readFileSync("benchmarks/comparative/v0234-exact-results.json", "utf8"));
const document = readFileSync("docs/COMPETITOR_COMPARISON.md", "utf8");

test("the scoped comparison retains exact clean source and neutral interpretation", () => {
  assert.equal(result.generatedAt, "2026-09-01T18:43:08.569Z");
  assert.equal(result.tools.agentVigil.evaluatedVersion, "0.23.4");
  assert.equal(result.tools.agentVigil.evaluatedWithTrackedChanges, false);
  assert.equal(result.tools.agentVigil.evaluatedCommit, "f9361c74f1cf3a83027ee65c3db79316353d9917");
  assert.equal(result.tools.swarm.version, "12.1.1");
  assert.equal(result.synthetic.agent.balancedAccuracy, 0.884615);
  assert.equal(result.synthetic.swarm.balancedAccuracy, 0.644231);
  assert.ok(result.synthetic.anyPairedBroken.pExact > 0 && result.synthetic.anyPairedBroken.pExact < 0.000001);
  assert.equal(result.presumedClean.agent.advisoryPrRate.successes, 104);
  assert.equal(result.presumedClean.swarm.advisoryPrRate.successes, 71);
  assert.match(document, /not a\s+claim that Agent Vigil is the best product overall/);
  assert.match(document, /review burden rather than false-positive rates/);
  assert.match(document, /does not prove that they will buy Agent Vigil/);
  assert.match(readFileSync("benchmarks/comparative/v0234-exact-results.md", "utf8"), /exact p<0\.000001/);
});
