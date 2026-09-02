import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { REVIEWED_PUBLIC_ACTION_SHA } from "../src/build-info.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("a clean repository gets one truthful prepared result without selecting a runtime SHA", () => {
  const repository = mkdtempSync(join(tmpdir(), "agent-vigil-five-minute-hosted-"));
  mkdirSync(join(repository, "test"));
  writeFileSync(join(repository, "package.json"), `${JSON.stringify({ scripts: { test: "node --test test/basic.test.cjs" } }, null, 2)}\n`);
  writeFileSync(
    join(repository, "test/basic.test.cjs"),
    "const assert = require('node:assert/strict'); const { test } = require('node:test'); test('works', () => assert.equal(1, 1));\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "hosted-test@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Hosted Test"], { cwd: repository });
  execFileSync("git", ["add", "."], { cwd: repository });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repository });

  const result = spawnSync(process.execPath, [join(ROOT, "dist/cli.js"), "protect", "--repo", repository], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Setup: READY — not running in GitHub yet\./);
  assert.match(result.stdout, /PASS\s+real regression test failed on old code and passed on proposed code/);
  assert.match(result.stdout, /FAIL\s+planted weak test passed on both versions; merge proof blocked/);
  assert.match(result.stdout, new RegExp(`Pinned\\s+${REVIEWED_PUBLIC_ACTION_SHA} \\(reviewed public release\\)`));
  assert.doesNotMatch(result.stdout, /Agent Vigil doctor|13 failure/);

  const workflow = readFileSync(join(repository, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.match(workflow, new RegExp(`sulmusic2-star/agent-vigil@${REVIEWED_PUBLIC_ACTION_SHA}`));
});

test("the release package binds public checks to the exact event commit", () => {
  const buildScript = readFileSync(join(ROOT, "scripts/build_cli.mjs"), "utf8");
  const publishWorkflow = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8");
  assert.match(buildScript, /process\.env\.AGENT_VIGIL_BUILD_SHA/);
  assert.match(buildScript, /AGENT_VIGIL_BUILD_SHA must be a full lowercase Git commit SHA/);
  assert.match(publishWorkflow, /AGENT_VIGIL_BUILD_SHA:\s*\$\{\{ github\.sha \}\}/);
  assert.match(publishWorkflow, /node scripts\/build_cli\.mjs\s+grep -F "\$GITHUB_SHA" dist\/cli\.js/);
});
