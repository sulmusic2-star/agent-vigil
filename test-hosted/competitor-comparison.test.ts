import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import test from "node:test";

const result = JSON.parse(gunzipSync(readFileSync("benchmarks/comparative/v0234-exact-results.json.gz")).toString("utf8"));
const document = readFileSync("docs/COMPETITOR_COMPARISON.md", "utf8");

test("the scoped comparison retains exact clean source and neutral interpretation", () => {
  assert.equal(result.tools.agentVigil.evaluatedVersion, "0.23.4");
  assert.equal(result.tools.agentVigil.evaluatedWithTrackedChanges, false);
  assert.match(result.tools.agentVigil.evaluatedCommit, /^[0-9a-f]{40}$/);
  assert.equal(result.tools.swarm.version, "12.1.1");
  assert.equal(result.synthetic.agent.balancedAccuracy, 0.884615);
  assert.equal(result.synthetic.swarm.balancedAccuracy, 0.644231);
  assert.equal(result.presumedClean.agent.advisoryPrRate.successes, 104);
  assert.equal(result.presumedClean.swarm.advisoryPrRate.successes, 71);
  assert.match(document, /not a\s+claim that Agent Vigil is the best product overall/);
  assert.match(document, /review burden rather than false-positive rates/);
  assert.match(document, /does not prove that they will buy Agent Vigil/);
});
