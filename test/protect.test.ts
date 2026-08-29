import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/config.ts";
import { checkIntegrity, checkIntegrityDiff } from "../src/detectors/reality.ts";
import { routeIntegrity } from "../src/integrity-policy.ts";
import { buildReport } from "../src/report.ts";
import { run } from "../src/cli.ts";
import { initRepository } from "../src/setup.ts";
import { REVIEWED_PUBLIC_ACTION_SHA } from "../src/build-info.ts";

const ACTION_SHA = "a".repeat(40);

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "vigil-protect-"));
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: path });
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: {
    build: "tsc", lint: "eslint .", test: "node --test", typecheck: "tsc --noEmit",
  } }));
  writeFileSync(join(path, "app.js"), "export const answer = 42;\n");
  writeFileSync(join(path, "app.test.js"), "test('answer', () => expect(answer).toBe(42));\n");
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: path });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd: path });
  return path;
}

test("protect discovers common repository checks and installs calibrated integrity", () => {
  const path = repo();
  initRepository(path, false, undefined, "protect", false, ACTION_SHA);
  const policy = loadPolicy(path).value;
  assert.equal(policy.integrityMode, "calibrated");
  assert.deepEqual(policy.maintainer?.automatedReview?.commands, ["node --test"]);
  assert.equal(policy.maintainer?.reviewMode, "automated");
  assert.equal(policy.maintainer?.requireHumanAttestation, false);
  assert.match(readFileSync(join(path, ".github/workflows/agent-vigil-outcomes.yml"), "utf8"), /Agent Vigil outcomes/);
});

test("protect refuses candidate-executing attestation until a separate signer exists", () => {
  const path = repo();
  assert.equal(run(["protect", "--repo", path, "--action-sha", ACTION_SHA, "--attest"]), 2);
});

test("protect reports scaffold creation separately from committed doctor readiness", () => {
  const path = repo();
  assert.equal(run(["protect", "--repo", path, "--action-sha", ACTION_SHA]), 0);
  assert.equal(run(["doctor", "--repo", path]), 2);
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync("git", ["commit", "-qm", "install protection controls"], { cwd: path });
  assert.equal(run(["doctor", "--repo", path]), 0);
});

test("protect needs no SHA and reports one truthful prepared state", () => {
  const path = repo();
  const originalLog = console.log;
  let output = "";
  console.log = (...values: unknown[]) => { output += `${values.join(" ")}\n`; };
  try {
    assert.equal(run(["protect", "--repo", path]), 0);
  } finally {
    console.log = originalLog;
  }
  const workflow = readFileSync(join(path, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.match(workflow, new RegExp(`agent-vigil@${REVIEWED_PUBLIC_ACTION_SHA}`));
  assert.match(output, /Agent Vigil is ready to add/);
  assert.match(output, /State: PREPARED — not active yet/);
  assert.match(output, /Found\s+node --test/);
  assert.match(output, /real regression test failed on old code and passed on proposed code/);
  assert.match(output, /planted weak test passed on both versions; merge proof blocked/);
  assert.match(output, /Optional workflow badge \(run status only; not proof of required-check enforcement\)/);
  assert.match(output, /https:\/\/github\.com\/example\/project\/actions\/workflows\/agent-vigil\.yml\/badge\.svg/);
  assert.match(output, /Register an outside trial only after the workflow runs/);
  assert.match(output, /RUNNING IN CI, not enforced/);
  assert.match(output, /plain required job name is not a workflow trust root/);
  assert.match(output, /issues\/new\?template=adopter-feedback\.yml&title=%5Badoption%5D%20example%2Fproject/);
  assert.doesNotMatch(output, /13 failure|Agent Vigil doctor|✓ PASS|✗ FAIL/);
});

test("calibrated policy blocks direct test weakening but keeps broad heuristics advisory", () => {
  const checks = checkIntegrityDiff([
    "diff --git a/x.test.js b/x.test.js",
    "--- a/x.test.js",
    "+++ b/x.test.js",
    "@@ -0,0 +1,3 @@",
    "+test.skip('critical', () => expect(run()).toBe(true));",
    "+test('empty', () => {});",
    "+test('constant', () => expect(true).toBe(true));",
  ].join("\n"));
  const routed = routeIntegrity(checks, "calibrated");
  assert.ok(routed.results.some((check) => check.ruleId === "test-skip-added"));
  assert.ok(routed.results.some((check) => check.ruleId === "test-empty-added"));
  assert.ok(routed.results.some((check) => check.ruleId === "test-oracle-constant"));
});

test("calibrated protect policy fails when a test file is deleted without an exact replacement", () => {
  const path = repo();
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  execFileSync("git", ["rm", "-q", "app.test.js"], { cwd: path });
  execFileSync("git", ["commit", "-qm", "delete test"], { cwd: path });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  const routed = routeIntegrity(checkIntegrity(path, base, head), "calibrated");
  assert.ok(routed.results.some((check) => check.ruleId === "test-file-deleted"));
  const report = buildReport({ transcript: "tests pass", transcriptFormat: "markdown", repo: path, base, head, results: routed.results, advisories: routed.advisories });
  assert.equal(report.summary.status, "FAIL");
});

test("browser runtime patch and coverage exclusion remain visible advisories", () => {
  const checks = checkIntegrityDiff([
    "diff --git a/ui.test.ts b/ui.test.ts",
    "--- a/ui.test.ts",
    "+++ b/ui.test.ts",
    "@@ -0,0 +1,3 @@",
    "+await page.evaluate(() => { document.querySelector('#save').onclick = save; });",
    "+/* istanbul ignore next */",
    "+expect(await page.isVisible('#save')).toBe(true);",
  ].join("\n"));
  const routed = routeIntegrity(checks, "calibrated");
  assert.ok(routed.advisories.some((check) => check.ruleId === "test-runtime-patch"));
  assert.ok(routed.advisories.some((check) => check.ruleId === "coverage-exclusion-added"));
});

test("test-integrity command fails a candidate that adds an empty test", () => {
  const path = repo();
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  writeFileSync(join(path, "app.test.js"), "test('answer', () => {});\n");
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync("git", ["commit", "-qm", "weaken test"], { cwd: path });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  assert.equal(run(["test-integrity", "--repo", path, "--base", base, "--head", head, "--format", "json"]), 1);
});

test("policy accepts calibrated integrity and rejects unknown modes", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"integrityMode":"calibrated"}');
  assert.equal(loadPolicy(path).value.integrityMode, "calibrated");
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"integrityMode":"magic"}');
  assert.throws(() => loadPolicy(path), /advisory, calibrated, or blocking/);
});
