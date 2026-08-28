import assert from "node:assert/strict";
import { test } from "node:test";
import { renderProtectRehearsal, runProtectRehearsal } from "../src/protect-rehearsal.ts";

test("protect rehearsal proves the good differential and blocks the planted weak test", () => {
  const result = runProtectRehearsal();
  assert.deepEqual(result, { regression: "PASS", plantedWeakTest: "BLOCKED" });
  const rendered = renderProtectRehearsal(result);
  assert.match(rendered, /PASS\s+real regression test/);
  assert.match(rendered, /FAIL\s+planted weak test/);
  assert.match(rendered, /no repository code executed/);
});

