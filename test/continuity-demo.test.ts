import assert from "node:assert/strict";
import { test } from "node:test";
import { renderContinuityDemo, runContinuityDemo } from "../src/continuity/demo.ts";

test("the continuity demonstration stops a reverted change until independent repair evidence arrives", () => {
  const result = runContinuityDemo();
  assert.deepEqual(result.steps.map((step) => step.result), ["PASS", "CURRENT", "REVOKED", "REVOKED", "CURRENT"]);
  assert.deepEqual(result.steps.map((step) => step.deployment), ["not evaluated", "allowed", "stopped", "stopped", "allowed"]);
  assert.deepEqual(result.history, [
    "verification_refreshed",
    "merge_observed",
    "revert_observed",
    "verification_refreshed",
    "remediation_verified",
  ]);
  const rendered = renderContinuityDemo(result);
  assert.match(rendered, /later green check does not erase the recorded revert/i);
  assert.match(rendered, /Complete history/);
  for (const forbidden of ["private", "secret", "/tmp", "example/demonstration", "webhook"]) {
    assert.equal(JSON.stringify(result).toLowerCase().includes(forbidden.toLowerCase()), false);
  }
});
