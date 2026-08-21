import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildReport, type CheckResult } from "../src/report.ts";
import { routeIntegrity } from "../src/integrity-policy.ts";
import { renderText, toSarif } from "../src/output.ts";
import {
  extractClaims,
  extractRunClaims,
  loadTranscript,
  toolCallFingerprint,
  type SessionToolCall,
} from "../src/transcript.ts";
import {
  checkCompletion,
  checkFilesChanged,
  checkIntegrity,
  checkIntegrityDiff,
  checkPathsExist,
  checkRunClaims,
  checkStepRepetition,
  checkTestsPass,
  checkWorkspaceBinding,
  checkWorkspaceMutation,
  parseTestSummary,
} from "../src/detectors/reality.ts";

function temp(prefix = "vigil-") { return mkdtempSync(join(tmpdir(), prefix)); }
function git(repo: string, ...args: string[]) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }); }
function initRepo(): string {
  const repo = temp("vigil-repo-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  writeFileSync(join(repo, "README.md"), "baseline\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "baseline");
  return repo;
}
function commit(repo: string, message: string) { git(repo, "add", "-A"); git(repo, "commit", "-qm", message); }
function result(verdict: CheckResult["verdict"], contributesToPass = true): CheckResult {
  return { claim: { kind: "path_exists", quote: "q", subject: "x" }, verdict, evidence: "e", contributesToPass };
}

test("extracts changed files, paths, tests, and completion", () => {
  const claims = extractClaims("I updated src/real.ts and created src/ghost.ts. All 12 tests pass. Work complete.");
  assert.ok(claims.some((c) => c.kind === "file_changed" && c.subject === "src/real.ts"));
  assert.ok(claims.some((c) => c.kind === "tests_pass" && c.expectedCount === 12));
  assert.ok(claims.some((c) => c.kind === "work_complete"));
});

test("extracts root-level changed files", () => {
  assert.ok(extractClaims("Updated README.md and package.json").some((c) => c.subject === "README.md"));
});

test("does not treat ordinary dotted words as repository paths", () => {
  assert.equal(extractClaims("The test suite passes on Node.js against example.com").filter((c) => c.kind === "path_exists").length, 0);
});

test("extracts paths only from explicit path contexts", () => {
  assert.ok(extractClaims("Receipt at dist/vigil.json exists").some((c) => c.kind === "path_exists" && c.subject === "dist/vigil.json"));
});

test("extracts no claims from neutral prose", () => assert.equal(extractClaims("looked around").length, 0));
test("deduplicates repeated claims", () => assert.equal(extractClaims("Updated src/a.ts. Updated src/a.ts.").filter((c) => c.kind === "file_changed").length, 1));
test("extracts multiword run claims", () => assert.ok(extractRunClaims("I ran npm test and then stopped").some((c) => c.subject === "npm test")));
test("does not capture stopword tail in run claim", () => assert.equal(extractRunClaims("I ran npm test and then deployed")[0].subject, "npm test"));

test("tool fingerprints are stable", () => {
  const call: SessionToolCall = { id: "1", name: "Bash", input: "npm test", sequence: 0 };
  assert.equal(toolCallFingerprint(call), toolCallFingerprint({ ...call }));
});
test("tool fingerprints change with input", () => {
  const call: SessionToolCall = { id: "1", name: "Bash", input: "npm test", sequence: 0 };
  assert.notEqual(toolCallFingerprint(call), toolCallFingerprint({ ...call, input: "npm build" }));
});

test("parses TAP totals", () => assert.deepEqual(parseTestSummary("# tests 12\n# pass 12\n# fail 0"), { total: 12, passed: 12, failed: 0 }));
test("parses Node 24 spec reporter totals", () => assert.deepEqual(parseTestSummary("ℹ tests 12\nℹ pass 12\nℹ fail 0"), { total: 12, passed: 12, failed: 0 }));
test("parses pytest totals", () => assert.deepEqual(parseTestSummary("47 passed, 2 skipped in 1.0s"), { total: 49, passed: 47, skipped: 2 }));
test("parses Jest totals", () => assert.equal(parseTestSummary("Tests: 2 failed, 8 passed, 10 total").total, 10));
test("parses cargo totals", () => assert.equal(parseTestSummary("test result: ok. 9 passed; 0 failed; 1 ignored").total, 10));
test("returns empty summary for unknown runner", () => assert.deepEqual(parseTestSummary("everything is lovely"), {}));
test("claimed pass count does not include skipped tests", () => {
  const parsed = parseTestSummary("10 passed, 2 skipped in 1.0s");
  assert.equal(parsed.passed, 10); assert.equal(parsed.total, 12);
});

test("zero evidence is INCONCLUSIVE", () => {
  const report = buildReport({ transcript: "x", transcriptFormat: "markdown", repo: ".", base: "a", head: "b", results: [] });
  assert.equal(report.summary.status, "INCONCLUSIVE");
  assert.equal(report.summary.pass, false);
});
test("one meaningful verification passes", () => {
  const report = buildReport({ transcript: "x", transcriptFormat: "markdown", repo: ".", base: "a", head: "b", results: [result("verified")] });
  assert.equal(report.summary.status, "PASS");
});
test("passive verification cannot satisfy evidence gate", () => {
  const report = buildReport({ transcript: "x", transcriptFormat: "markdown", repo: ".", base: "a", head: "b", results: [result("verified", false)] });
  assert.equal(report.summary.status, "INCONCLUSIVE");
});
test("strict mode makes unresolved evidence inconclusive", () => {
  const report = buildReport({ transcript: "x", transcriptFormat: "markdown", repo: ".", base: "a", head: "b", results: [result("verified"), result("unverifiable")], policy: { strict: true } });
  assert.equal(report.summary.status, "INCONCLUSIVE");
});
test("a blocking unresolved execution context is inconclusive without strict mode", () => {
  const blocking = { ...result("unverifiable"), blocksPass: true };
  const report = buildReport({ transcript: "x", transcriptFormat: "markdown", repo: ".", base: "a", head: "b", results: [result("verified"), blocking] });
  assert.equal(report.summary.status, "INCONCLUSIVE");
});
test("contradiction always fails", () => {
  const report = buildReport({ transcript: "x", transcriptFormat: "markdown", repo: ".", base: "a", head: "b", results: [result("contradicted")] });
  assert.equal(report.summary.status, "FAIL");
});
test("receipt hash is deterministic", () => {
  const input = { transcript: "x", transcriptFormat: "markdown", repo: ".", base: "a", head: "b", results: [result("verified")] };
  assert.equal(buildReport(input).receiptHash, buildReport(input).receiptHash);
});
test("receipt-bound advisories do not alter PASS and do alter the receipt hash", () => {
  const input = { transcript: "x", transcriptFormat: "markdown", repo: ".", base: "a", head: "b", results: [result("verified")] };
  const plain = buildReport(input);
  const advisory = { ...result("contradicted", false), ruleId: "test-skip-added" };
  const warned = buildReport({ ...input, advisories: [advisory] });
  assert.equal(warned.summary.status, "PASS");
  assert.notEqual(warned.receiptHash, plain.receiptHash);
  assert.match(renderText(warned), /non-blocking under this policy/);
  assert.equal(toSarif(warned).runs[0].results[0].level, "warning");
});
test("integrity routing preserves hard context errors and makes heuristic contradictions policy-selectable", () => {
  const contradiction = result("contradicted", false);
  const unresolved = { ...result("unverifiable", false), blocksPass: true };
  const advisory = routeIntegrity([contradiction, unresolved], "advisory");
  assert.deepEqual(advisory.advisories, [contradiction]);
  assert.deepEqual(advisory.results, [unresolved]);
  assert.deepEqual(routeIntegrity([contradiction], "blocking").results, [contradiction]);
});

test("dirty worktree state blocks an exact-head receipt", () => {
  const repo = initRepo();
  writeFileSync(join(repo, "unbound.txt"), "not in the selected commit\n");
  const check = checkWorkspaceBinding(repo, "HEAD")[0];
  assert.equal(check.verdict, "unverifiable");
  assert.equal(check.blocksPass, true);
  assert.equal(check.ruleId, "workspace-dirty");
});

test("a separately hashed transcript may remain untracked", () => {
  const repo = initRepo(); const transcript = join(repo, "session.md");
  writeFileSync(transcript, "tests pass\n");
  assert.equal(checkWorkspaceBinding(repo, "HEAD", [transcript])[0].verdict, "verified");
});

test("selected head must match the checked-out commit", () => {
  const repo = initRepo(); writeFileSync(join(repo, "README.md"), "head\n"); commit(repo, "head");
  assert.equal(checkWorkspaceBinding(repo, "HEAD~1")[0].ruleId, "workspace-unbound");
});

test("fresh verification cannot silently mutate tracked inputs", () => {
  const repo = initRepo(); writeFileSync(join(repo, "README.md"), "mutated\n");
  const check = checkWorkspaceMutation(repo)[0];
  assert.equal(check.ruleId, "workspace-mutated");
  assert.equal(check.blocksPass, true);
});

test("three identical tool calls are a contradiction", () => {
  const calls = [0, 1, 2].map((sequence) => ({ id: String(sequence), name: "Read", input: "a", sequence }));
  assert.equal(checkStepRepetition(calls)[0].verdict, "contradicted");
});
test("different tool calls do not trigger a loop", () => {
  const calls = [0, 1, 2].map((sequence) => ({ id: String(sequence), name: "Read", input: String(sequence), sequence }));
  assert.equal(checkStepRepetition(calls)[0].verdict, "verified");
});
test("run claim tokens must occur in one tool call", () => {
  const claim = { kind: "command_ran" as const, quote: "I ran npm test", subject: "npm test" };
  const calls = [
    { id: "1", name: "Bash", input: "npm install", sequence: 0 },
    { id: "2", name: "Bash", input: "python test.py", sequence: 1 },
  ];
  assert.equal(checkRunClaims([claim], calls)[0].verdict, "contradicted");
});
test("matching failed tool call contradicts run claim", () => {
  const claim = { kind: "command_ran" as const, quote: "I ran npm test", subject: "npm test" };
  assert.equal(checkRunClaims([claim], [{ id: "1", name: "Bash", input: "npm test", sequence: 0, isError: true }])[0].verdict, "contradicted");
});
test("missing tool trace leaves run claim unresolved", () => {
  const claim = { kind: "command_ran" as const, quote: "I ran npm test", subject: "npm test" };
  assert.equal(checkRunClaims([claim], [])[0].verdict, "unverifiable");
});

test("loads markdown transcript", () => {
  const path = join(temp(), "summary.md"); writeFileSync(path, "All tests pass");
  assert.equal(loadTranscript(path).format, "markdown");
});
test("loads Claude Code tool use and result", () => {
  const path = join(temp(), "claude.jsonl");
  writeFileSync(path, [
    { type: "assistant", timestamp: "t", message: { content: [{ type: "text", text: "I ran npm test" }, { type: "tool_use", id: "c1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "ok", is_error: false }] } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "claude-code");
  assert.equal(loaded.toolCalls[0].output, "ok");
});
test("loads Codex function calls", () => {
  const path = join(temp(), "codex.jsonl");
  writeFileSync(path, [
    { type: "session_meta", payload: {} },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I ran npm test" }] } },
    { type: "response_item", payload: { type: "function_call", call_id: "x", name: "exec_command", arguments: "{\"cmd\":\"npm test\"}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "x", output: "exit_code: 0" } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "codex");
  assert.equal(loaded.toolCalls[0].name, "exec_command");
});

test("changed file claim verifies against explicit range", () => {
  const repo = initRepo(); writeFileSync(join(repo, "README.md"), "changed\n"); commit(repo, "change");
  const claim = { kind: "file_changed" as const, quote: "updated README.md", subject: "README.md" };
  assert.equal(checkFilesChanged([claim], repo, "HEAD~1", "HEAD")[0].verdict, "verified");
});
test("changed file matching respects path-component boundaries", () => {
  const repo = initRepo(); writeFileSync(join(repo, "notfoo.ts"), "changed\n"); commit(repo, "change");
  const claim = { kind: "file_changed" as const, quote: "updated foo.ts", subject: "foo.ts" };
  assert.equal(checkFilesChanged([claim], repo, "HEAD~1", "HEAD")[0].verdict, "contradicted");
});
test("path traversal claim is contradicted", () => {
  const repo = initRepo();
  const claim = { kind: "path_exists" as const, quote: "../secret.txt", subject: "../secret.txt" };
  assert.equal(checkPathsExist([claim], repo)[0].verdict, "contradicted");
});
test("symlink targets outside the repository are contradicted", () => {
  const repo = initRepo();
  const outside = join(temp("vigil-outside-"), "secret.txt"); writeFileSync(outside, "secret\n");
  symlinkSync(outside, join(repo, "inside.txt"));
  const claim = { kind: "path_exists" as const, quote: "file inside.txt exists", subject: "inside.txt" };
  const check = checkPathsExist([claim], repo)[0];
  assert.equal(check.verdict, "contradicted"); assert.equal(check.ruleId, "path-outside-repo");
});
test("claimed test count must match observed count", () => {
  const repo = initRepo();
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test test.js" } }));
  writeFileSync(join(repo, "test.js"), "const{test}=require('node:test');test('one',()=>{});\n");
  const claim = { kind: "tests_pass" as const, quote: "12 tests pass", subject: "12 tests", expectedCount: 12 };
  assert.equal(checkTestsPass([claim], repo)[0].verdict, "contradicted");
});
test("unquantified passing test claim verifies", () => {
  const repo = initRepo();
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test test.js" } }));
  writeFileSync(join(repo, "test.js"), "const{test}=require('node:test');test('one',()=>{});\n");
  const claim = { kind: "tests_pass" as const, quote: "tests pass", subject: "test suite" };
  assert.equal(checkTestsPass([claim], repo)[0].verdict, "verified");
});

test("integrity scan catches skipped test added", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test")); writeFileSync(join(repo, "test", "a.test.ts"), "test('a',()=>{})\n"); commit(repo, "test");
  writeFileSync(join(repo, "test", "a.test.ts"), `test.${"skip"}('a',()=>{})\n`); commit(repo, "skip");
  assert.ok(checkIntegrity(repo, "HEAD~1", "HEAD").some((r) => r.ruleId === "test-skip-added" && r.verdict === "contradicted"));
});
test("integrity scan catches test count drop", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test")); writeFileSync(join(repo, "test", "a.test.ts"), "test('a',()=>{})\ntest('b',()=>{})\n"); commit(repo, "tests");
  writeFileSync(join(repo, "test", "a.test.ts"), "test('a',()=>{})\n"); commit(repo, "drop");
  assert.ok(checkIntegrity(repo, "HEAD~1", "HEAD").some((r) => r.ruleId === "test-count-drop"));
});
test("clean integrity scan is passive", () => {
  const repo = initRepo(); writeFileSync(join(repo, "README.md"), "changed\n"); commit(repo, "docs");
  const check = checkIntegrity(repo, "HEAD~1", "HEAD")[0];
  assert.equal(check.verdict, "verified"); assert.equal(check.contributesToPass, false);
});

function unifiedDiff(path: string, removed: string[], added: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${Math.max(1, removed.length)} +1,${Math.max(1, added.length)} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

test("static diff audit passes a clean code change with meaningful bounded evidence", () => {
  const results = checkIntegrityDiff(unifiedDiff("src/value.ts", ["return 1;"], ["return 2;"]));
  assert.equal(results[0].verdict, "verified");
  assert.equal(results[0].contributesToPass, true);
});

test("static diff audit is inconclusive for non-diff input", () => {
  const result = checkIntegrityDiff("not a diff")[0];
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.blocksPass, true);
});

test("static diff audit catches relaxed assertions and self-fulfilling mocks", () => {
  const results = checkIntegrityDiff(unifiedDiff(
    "test/value.test.ts",
    ["expect(compute()).toBe(42);"],
    ["const compute = jest.fn().mockReturnValue(1);", "expect(compute()).toBeGreaterThan(0);"],
  ));
  assert.ok(results.some((result) => result.ruleId === "test-assertion-relaxed"));
  assert.ok(results.some((result) => result.ruleId === "subject-mocked"));
});

test("static diff audit catches error swallowing, lost context, dead branches, suppressions, and no-op edits", () => {
  const diff = [
    unifiedDiff("src/swallow.ts", ["write(value);"], ["try { write(value); } catch {}"]),
    unifiedDiff("src/rethrow.ts", ["throw err;"], ["throw new Error('failed');"]),
    unifiedDiff("src/dead.ts", ["return value;"], ["if (false) return fallback;", "return value;"]),
    unifiedDiff("src/type.ts", ["parse(value);"], ["// @ts-expect-error", "parse(value);"]),
    unifiedDiff("src/noop.ts", ["return value;"], ["return value; // adjusted"]),
  ].join("\n");
  const rules = new Set(checkIntegrityDiff(diff).map((result) => result.ruleId));
  for (const rule of ["error-swallowed", "exception-context-lost", "dead-branch-added", "suppression-added", "no-op-code-change"]) {
    assert.ok(rules.has(rule), `missing ${rule}`);
  }
});

test("static diff audit catches a stale caller after a symbol rename", () => {
  const diff = [
    "diff --git a/src/refactor.ts b/src/refactor.ts",
    "--- a/src/refactor.ts",
    "+++ b/src/refactor.ts",
    "@@ -1,2 +1,2 @@",
    "-export function compute(x: number) { return x; }",
    "+export function computeV2(x: number) { return x; }",
    " export const wired = compute(1);",
    "",
  ].join("\n");
  assert.ok(checkIntegrityDiff(diff).some((result) => result.ruleId === "stale-refactor-caller"));
});
test("static diff audit recognizes Cypress tests and catches removed assertions", () => {
  const diff = unifiedDiff(
    "cypress/e2e/resources.cy.js",
    ["cy.get('[aria-label=ready]').should('exist');"],
    ["cy.wait(1000);"],
  );
  assert.ok(checkIntegrityDiff(diff).some((result) => result.ruleId === "assertion-drop"));
});
test("static diff audit catches cross-file stale callers with a clean negative control", () => {
  const declaration = unifiedDiff(
    "src/value.ts",
    ["export function compute(x: number) { return x; }"],
    ["export function computeV2(x: number) { return x; }"],
  );
  const stale = `${declaration}${unifiedDiff("src/caller.ts", [], ["export const value = compute(1);"])}`;
  const fixed = `${declaration}${unifiedDiff("src/caller.ts", ["export const value = compute(1);"], ["export const value = computeV2(1);"])}`;
  assert.ok(checkIntegrityDiff(stale).some((result) => result.ruleId === "stale-refactor-caller"));
  assert.equal(checkIntegrityDiff(fixed).some((result) => result.ruleId === "stale-refactor-caller"), false);
});
test("static diff audit catches comment-only fixes without flagging executable changes", () => {
  const comments = unifiedDiff("src/value.ts", [], ["// FIXME: this still returns the wrong value"]);
  const behavior = unifiedDiff("src/value.ts", ["return 0;"], ["// Return the corrected value", "return 1;"]);
  assert.ok(checkIntegrityDiff(comments).some((result) => result.ruleId === "comment-only-change"));
  assert.equal(checkIntegrityDiff(behavior).some((result) => result.ruleId === "comment-only-change"), false);
});
test("test-only assertion relaxation receives a no-op-fix label", () => {
  const relaxed = unifiedDiff("test/value.test.ts", ["expect(value()).toBe(2);"], ["expect(value()).toBeGreaterThan(0);"]);
  const implementationAndTest = `${unifiedDiff("src/value.ts", ["return 0;"], ["return 2;"])}${relaxed}`;
  assert.ok(checkIntegrityDiff(relaxed).some((result) => result.ruleId === "no-op-code-change"));
  assert.equal(checkIntegrityDiff(implementationAndTest).some((result) => result.ruleId === "no-op-code-change"), false);
});
test("completion without objective evidence is unresolved", () => {
  const repo = initRepo(); writeFileSync(join(repo, "README.md"), "changed\n"); commit(repo, "docs");
  const claim = { kind: "work_complete" as const, quote: "done", subject: "completion claim" };
  assert.equal(checkCompletion([claim], repo, "HEAD~1", "HEAD", [result("verified", false)])[0].verdict, "unverifiable");
});
test("completion with objective evidence verifies", () => {
  const repo = initRepo(); writeFileSync(join(repo, "README.md"), "changed\n"); commit(repo, "docs");
  const claim = { kind: "work_complete" as const, quote: "done", subject: "completion claim" };
  assert.equal(checkCompletion([claim], repo, "HEAD~1", "HEAD", [result("verified")])[0].verdict, "verified");
});
