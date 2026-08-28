import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REVIEWED_PUBLIC_ACTION_SHA, defaultActionPin } from "../src/build-info.ts";

test("source-mode onboarding falls back to the reviewed public release pin", () => {
  assert.deepEqual(defaultActionPin(), {
    sha: REVIEWED_PUBLIC_ACTION_SHA,
    source: "reviewed-public-release",
  });
  assert.match(REVIEWED_PUBLIC_ACTION_SHA, /^[0-9a-f]{40}$/);
});

test("release builds embed only an explicitly supplied exact source commit", () => {
  const script = readFileSync(new URL("../scripts/build_cli.mjs", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(script, /process\.env\.AGENT_VIGIL_BUILD_SHA/);
  assert.doesNotMatch(script, /git["'], \["rev-parse"/);
  assert.match(workflow, /AGENT_VIGIL_BUILD_SHA:\s*\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /node scripts\/build_cli\.mjs\s+grep -F "\$GITHUB_SHA" dist\/cli\.js/);
});
