import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const directCommand = "node --test --test-concurrency=1 test-hosted/*.test.ts";

test("the required check uses the dedicated hosted regression lane", () => {
  const policy = JSON.parse(readFileSync(".agent-vigil.json", "utf8"));
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));

  assert.equal(policy.testCommand, directCommand);
  assert.deepEqual(policy.maintainer.testPathPatterns, ["test-hosted/**"]);
  assert.deepEqual(policy.maintainer.automatedReview.commands, [directCommand]);
  assert.equal(policy.maintainer.differentialTest.command, directCommand);
  assert.equal(manifest.agentVigil.hostedTestCommand, directCommand);
  assert.match(manifest.scripts.test, /test-hosted\/\*\.test\.ts/);
  assert.match(manifest.scripts["test:coverage"], /test-hosted\/\*\.test\.ts/);
  assert.ok(policy.maintainer.protectedPaths.includes("test-hosted/repository-contract.test.ts"));
});
