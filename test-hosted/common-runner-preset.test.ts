import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { OFFICIAL_COMMON_RUNNER_IMAGE } from "../src/setup.ts";

const ACTION_SHA = "0123456789abcdef0123456789abcdef01234567";

test("the common runner preset creates an exact digest-pinned hosted contract", () => {
  const repository = mkdtempSync(join(tmpdir(), "agent-vigil-common-runner-"));
  execFileSync("git", ["init", "-q"], { cwd: repository });
  writeFileSync(join(repository, "pyproject.toml"), "[project]\nname = 'common-runner-hosted-fixture'\n");
  writeFileSync(join(repository, "test_example.py"), "def test_example():\n    assert 2 + 2 == 4\n");

  assert.equal(run([
    "protect", "--repo", repository, "--action-sha", ACTION_SHA,
    "--runner", "common", "--test-cmd", "python3 -m pytest -q",
  ]), 0);

  const contract = JSON.parse(readFileSync(join(repository, ".agent-vigil-runner.json"), "utf8"));
  assert.deepEqual(contract, {
    schemaVersion: 1,
    image: OFFICIAL_COMMON_RUNNER_IMAGE,
    testCommand: "python3 -m pytest -q",
  });
  assert.match(readFileSync(join(repository, ".github/workflows/agent-vigil.yml"), "utf8"),
    new RegExp(`candidate-image: ${OFFICIAL_COMMON_RUNNER_IMAGE}`));
});
