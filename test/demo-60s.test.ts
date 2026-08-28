import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the demo gives every subprocess the remaining time from one deadline", () => {
  const source = readFileSync(new URL("../scripts/demo_60s.mjs", import.meta.url), "utf8");
  assert.match(source, /const deadline = started \+ 60_000/);
  assert.match(source, /const remaining = deadline - Date\.now\(\)/);
  assert.match(source, /timeout: Math\.max\(1, Math\.min\(options\.timeout \?\? 20_000, remaining\)\)/);
  assert.equal((source.match(/const deadline =/g) ?? []).length, 1);
});
