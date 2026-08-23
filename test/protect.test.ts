import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/config.ts";
import { checkIntegrityDiff } from "../src/detectors/reality.ts";
import { routeIntegrity } from "../src/integrity-policy.ts";
import { run } from "../src/cli.ts";
import { initRepository } from "../src/setup.ts";

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
  return path;
}

test("protect discovers common repository checks and installs calibrated integrity", () => {
  const path = repo();
  initRepository(path, false, undefined, "protect");
  const policy = loadPolicy(path).value;
  assert.equal(policy.integrityMode, "calibrated");
  assert.deepEqual(policy.maintainer?.automatedReview?.commands, [
    "npm run typecheck", "npm run lint", "npm run build", "npm test --silent",
  ]);
  assert.equal(policy.maintainer?.reviewMode, "automated");
  assert.equal(policy.maintainer?.requireHumanAttestation, false);
  assert.match(readFileSync(join(path, ".github/workflows/agent-vigil-outcomes.yml"), "utf8"), /Agent Vigil outcomes/);
});

test("calibrated policy blocks direct test weakening but keeps broad heuristics advisory", () => {
  const checks = checkIntegrityDiff([
    "diff --git a/x.test.js b/x.test.js",
    "--- a/x.test.js",
    "+++ b/x.test.js",
    "@@ -1 +1,3 @@",
    "+test.skip('critical', () => expect(run()).toBe(true));",
    "+test('empty', () => {});",
    "+test('constant', () => expect(true).toBe(true));",
  ].join("\n"));
  const routed = routeIntegrity(checks, "calibrated");
  assert.ok(routed.results.some((check) => check.ruleId === "test-skip-added"));
  assert.ok(routed.results.some((check) => check.ruleId === "test-empty-added"));
  assert.ok(routed.results.some((check) => check.ruleId === "test-oracle-constant"));
});

test("browser runtime patch and coverage exclusion remain visible advisories", () => {
  const checks = checkIntegrityDiff([
    "diff --git a/ui.test.ts b/ui.test.ts",
    "--- a/ui.test.ts",
    "+++ b/ui.test.ts",
    "@@ -1 +1,4 @@",
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
