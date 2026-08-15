import { test } from "node:test";
import assert from "node:assert/strict";
import { extractClaims } from "../src/transcript.ts";

test("extracts fabricated-path, change, test, and completion claims", () => {
  const n = "I updated src/real.ts and created src/ghost/phantom.ts. All 12 tests pass. The work is complete.";
  const kinds = extractClaims(n).map((c) => `${c.kind}:${c.subject}`);
  assert.ok(kinds.includes("file_changed:src/real.ts"));
  assert.ok(kinds.includes("file_changed:src/ghost/phantom.ts"));
  assert.ok(kinds.includes("tests_pass:12 tests"));
  assert.ok(kinds.includes("work_complete:completion claim"));
});

test("no claims from empty narrative", () => {
  assert.equal(extractClaims("nothing to see").length, 0);
});
