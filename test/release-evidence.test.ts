import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("v0.21.1 dogfood evidence stays first-party and fail-closed", () => {
  const proof = readFileSync(new URL("../proof/adoption/v0.21.1-dogfood.md", import.meta.url), "utf8");

  assert.match(proof, /retained PASS receipt for the exact pull-request head/);
  assert.match(proof, /first-party release evidence/);
  assert.match(proof, /does not count as external adoption/);
  assert.doesNotMatch(proof, /external repository|external receipt|customer|revenue/i);
});
