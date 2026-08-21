import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/config.ts";
import {
  buildMaintainerChecks,
  checkAttestations,
  checkChangeScope,
  checkDifferentialTest,
  collectDiffEvidence,
  loadPullRequestEvidence,
  pathMatches,
  type PullRequestEvidence,
} from "../src/maintainer.ts";
import { run } from "../src/cli.ts";

function temp(prefix = "vigil-maintainer-"): string { return mkdtempSync(join(tmpdir(), prefix)); }
function git(repo: string, ...args: string[]): string { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); }
function commit(repo: string, message: string): string { git(repo, "add", "-A"); git(repo, "commit", "-qm", message); return git(repo, "rev-parse", "HEAD"); }
function body(login = "alice", issue = "#42"): string { return `## Agent Vigil maintainer evidence

- Responsible human: @${login}
- [x] I reviewed every changed line.
- [x] I can explain and maintain this change.
- AI assistance: agent
- Linked issue: ${issue}
- Known limitations: none known
`; }

function event(path: string, base: string, head: string, prBody = body()): string {
  const eventPath = join(temp("vigil-event-"), "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { user: { login: "alice" }, body: prBody, base: { sha: base }, head: { sha: head } }, repository: { full_name: "example/repo" } }));
  return eventPath;
}

function regressionRepo(catching = true): { repo: string; base: string; head: string; event: string } {
  const repo = temp();
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test test/*.test.js" } }));
  writeFileSync(join(repo, "math.js"), "exports.add=(a,b)=>a-b;\n");
  writeFileSync(join(repo, "test", "smoke.test.js"), "const test=require('node:test');const assert=require('node:assert/strict');test('module',()=>assert.equal(typeof require('../math').add,'function'));\n");
  writeFileSync(join(repo, ".agent-vigil.json"), JSON.stringify({
    schemaVersion: 1,
    testCommand: "npm test --silent",
    strict: true,
    minVerified: 1,
    maintainer: {
      requireHumanAttestation: true,
      requireLinkedIssue: true,
      requireAiDisclosure: true,
      maxChangedFiles: 5,
      maxChangedLines: 100,
      requireTestChange: true,
      protectedPaths: [".github/workflows/**", ".agent-vigil.json"],
      testPathPatterns: ["test/**"],
      differentialTest: { command: "npm test --silent", timeoutSeconds: 30, overlayChangedTests: true },
    },
  }, null, 2));
  const base = commit(repo, "base");
  if (catching) writeFileSync(join(repo, "math.js"), "exports.add=(a,b)=>a+b;\n");
  else writeFileSync(join(repo, "README.md"), "unrelated\n");
  writeFileSync(join(repo, "test", "regression.test.js"), `const test=require('node:test');const assert=require('node:assert/strict');test('regression',()=>assert.equal(require('../math').add(2,1),${catching ? 3 : 1}));\n`);
  const head = commit(repo, "candidate");
  return { repo, base, head, event: event(repo, base, head) };
}

test("path patterns match nested and root test conventions without substring leaks", () => {
  assert.equal(pathMatches("src/math.test.ts", ["**/*.test.*"]), true);
  assert.equal(pathMatches("test/a.js", ["test/**"]), true);
  assert.equal(pathMatches("contest/a.js", ["test/**"]), false);
});

test("pull request event parser rejects non-PR event payloads", () => {
  const path = join(temp(), "event.json"); writeFileSync(path, "{}");
  assert.throws(() => loadPullRequestEvidence(path), /pull_request/);
});

test("attestation checks bind the responsible human to the event author", () => {
  const evidence: PullRequestEvidence = { author: "alice", body: body() };
  const checks = checkAttestations(evidence, { requireHumanAttestation: true, requireLinkedIssue: true, requireAiDisclosure: true });
  assert.equal(checks.every((check) => check.verdict === "verified"), true);
  assert.match(checks[0].evidence, /not understanding/);
});

test("attestation checks fail closed on a different login, unchecked review, and missing issue", () => {
  const evidence: PullRequestEvidence = { author: "alice", body: body("mallory", "not-applicable").replace("[x] I reviewed", "[ ] I reviewed") };
  const checks = checkAttestations(evidence, { requireHumanAttestation: true, requireLinkedIssue: true, requireAiDisclosure: true });
  assert.ok(checks.some((check) => check.ruleId === "responsible-human" && check.verdict === "contradicted"));
  assert.ok(checks.some((check) => check.ruleId === "human-review-attestation" && check.verdict === "contradicted"));
  assert.ok(checks.some((check) => check.ruleId === "linked-issue" && check.verdict === "contradicted"));
});

test("scope gate counts exact files and lines, requires tests, and protects paths", () => {
  const checks = checkChangeScope({ paths: ["src/a.ts", ".agent-vigil.json"], testPaths: [], changedLines: 19, binaryPaths: [] }, {
    maxChangedFiles: 1, maxChangedLines: 10, requireTestChange: true, protectedPaths: [".agent-vigil.json"],
  });
  assert.equal(checks.filter((check) => check.verdict === "contradicted").length, 4);
});

test("binary diffs make a changed-line budget inconclusive instead of pretending to count", () => {
  const check = checkChangeScope({ paths: ["image.png"], testPaths: [], binaryPaths: ["image.png"] }, { maxChangedLines: 10 })[0];
  assert.equal(check.verdict, "unverifiable");
  assert.equal(check.blocksPass, true);
});

test("differential proof passes only when candidate tests fail on base source and pass on head", () => {
  const fixture = regressionRepo(true);
  const diff = collectDiffEvidence(fixture.repo, fixture.base, fixture.head, ["test/**"]);
  const check = checkDifferentialTest(fixture.repo, fixture.base, fixture.head, diff.testPaths, { command: "npm test --silent", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "verified");
  assert.match(check.evidence, /base source failed/);
});

test("differential proof rejects a new test that already passes on base", () => {
  const fixture = regressionRepo(false);
  const diff = collectDiffEvidence(fixture.repo, fixture.base, fixture.head, ["test/**"]);
  const check = checkDifferentialTest(fixture.repo, fixture.base, fixture.head, diff.testPaths, { command: "npm test --silent", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "contradicted");
  assert.equal(check.ruleId, "differential-base-fail");
});

test("differential setup failures are inconclusive rather than false failures", () => {
  const fixture = regressionRepo(true);
  const diff = collectDiffEvidence(fixture.repo, fixture.base, fixture.head, ["test/**"]);
  const check = checkDifferentialTest(fixture.repo, fixture.base, fixture.head, diff.testPaths, { command: "npm test --silent", setupCommand: "exit 17", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "unverifiable");
  assert.equal(check.ruleId, "differential-setup");
  assert.equal(check.blocksPass, true);
});

test("differential base failure can be pinned to a trusted output pattern", () => {
  const fixture = regressionRepo(true);
  const diff = collectDiffEvidence(fixture.repo, fixture.base, fixture.head, ["test/**"]);
  const check = checkDifferentialTest(fixture.repo, fixture.base, fixture.head, diff.testPaths, { command: "npm test --silent", baseFailurePattern: "does-not-occur", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "contradicted");
  assert.equal(check.ruleId, "differential-failure-pattern");
});

test("symlink test overlays fail closed", () => {
  const fixture = regressionRepo(true);
  symlinkSync("../math.js", join(fixture.repo, "test", "linked.test.js"));
  const head = commit(fixture.repo, "symlink test");
  const check = checkDifferentialTest(fixture.repo, fixture.head, head, ["test/linked.test.js"], { command: "npm test --silent", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "unverifiable");
  assert.match(check.evidence, /symlink/);
});

test("maintainer checks catch over-broad and non-catching PRs as separate contradictions", () => {
  const fixture = regressionRepo(false);
  const policy = loadPolicy(fixture.repo, ".agent-vigil.json", fixture.base).value.maintainer!;
  const evidence = loadPullRequestEvidence(fixture.event);
  const checks = buildMaintainerChecks(fixture.repo, fixture.base, fixture.head, evidence, { ...policy, maxChangedFiles: 1 });
  assert.ok(checks.some((check) => check.ruleId === "changed-file-budget" && check.verdict === "contradicted"));
  assert.ok(checks.some((check) => check.ruleId === "differential-base-fail" && check.verdict === "contradicted"));
});

test("CLI maintainer mode emits a PASS receipt for a bounded catching regression", () => {
  const fixture = regressionRepo(true);
  const output = join(temp(), "report.json");
  assert.equal(run(["maintainer", "--event", fixture.event, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 0);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.summary.status, "PASS");
  assert.equal(report.transcriptFormat, "pull-request-evidence");
  assert.ok(report.results.some((check: { ruleId: string }) => check.ruleId === "differential-test"));
});

test("CLI maintainer mode rejects a forged event Git range", () => {
  const fixture = regressionRepo(true);
  const forged = event(fixture.repo, fixture.head, fixture.head);
  assert.equal(run(["maintainer", "--event", forged, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base]), 2);
});

test("maintainer policy rejects unknown nested controls and invalid regex", () => {
  const fixture = regressionRepo(true);
  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: { magic: true } }));
  assert.throws(() => loadPolicy(fixture.repo), /maintainer contains unknown/);
  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: { differentialTest: { command: "test", baseFailurePattern: "[" } } }));
  assert.throws(() => loadPolicy(fixture.repo), /valid regular expression/);
});
