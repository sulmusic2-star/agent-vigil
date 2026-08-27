import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
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
  classifyCandidateTestOutcome,
  changedPaths,
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
  const claims = extractClaims("The test suite passes on Node.js against example.com");
  assert.equal(claims.filter((c) => c.kind === "path_exists").length, 0);
  const testClaim = claims.find((claim) => claim.kind === "tests_pass");
  assert.ok(testClaim);
  assert.equal(Object.hasOwn(testClaim, "expectedCount"), false);
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

test("fresh verification cannot hide a tracked deletion by renaming it to an ignored evidence path", () => {
  const repo = initRepo();
  git(repo, "mv", "README.md", "session.md");
  const renameAware = execFileSync("git", ["diff", "HEAD", "--name-only", "-z"], { cwd: repo, encoding: "utf8" })
    .split("\0").filter(Boolean);
  assert.deepEqual(renameAware, ["session.md"], "the regression must exercise Git's destination-only rename view");
  const check = checkWorkspaceMutation(repo, ["session.md"])[0];
  assert.equal(check.ruleId, "workspace-mutated");
  assert.equal(check.blocksPass, true);
  assert.match(check.evidence, /README\.md/);
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
test("zero-test success cannot verify a passing-test claim", () => {
  const claim = { kind: "tests_pass" as const, quote: "tests pass", subject: "test suite" };
  const [result] = classifyCandidateTestOutcome([claim], "node --test", {
    status: 0,
    signal: null,
    output: "# tests 0\n# pass 0\n# fail 0\n",
  });
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.ruleId, "tests-empty");
  assert.equal(result.blocksPass, true);
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
test("integrity scan blocks deletion of an aliased test file without an exact replacement", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "security.test.js"), "const check = require('node:test');\nconst assert = require('node:assert');\ncheck('security', () => assert.ok(true));\n");
  commit(repo, "aliased test");
  git(repo, "rm", "-q", "test/security.test.js"); commit(repo, "delete aliased test");
  const result = checkIntegrity(repo, "HEAD~1", "HEAD").find((candidate) => candidate.ruleId === "test-file-deleted");
  assert.equal(result?.verdict, "contradicted");
});
test("integrity scan permits a byte-identical test-file move", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "before.test.js"), "test('security', () => assert.ok(true));\n");
  commit(repo, "test before move");
  git(repo, "mv", "test/before.test.js", "test/after.test.js"); commit(repo, "move test");
  const results = checkIntegrity(repo, "HEAD~1", "HEAD");
  assert.equal(results.some((candidate) => candidate.ruleId === "test-file-deleted"), false);
  assert.equal(results.some((candidate) => candidate.verdict === "contradicted"), false);
});
test("integrity scan keeps large byte-identical non-test moves within the bounded diff", () => {
  const repo = initRepo(); mkdirSync(join(repo, "assets"));
  writeFileSync(join(repo, "assets", "before.fixture"), "x".repeat(5 * 1024 * 1024));
  commit(repo, "large fixture before move");
  git(repo, "mv", "assets/before.fixture", "assets/after.fixture"); commit(repo, "move large fixture");
  const results = checkIntegrity(repo, "HEAD~1", "HEAD");
  assert.equal(results.some((candidate) => candidate.ruleId === "diff-unreadable"), false);
  assert.equal(results.some((candidate) => candidate.verdict === "contradicted" || candidate.verdict === "unverifiable"), false);
});
test("integrity scan routes both sides of a content-changing rename", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test")); mkdirSync(join(repo, "src"));
  const context = Array.from({ length: 20 }, (_, index) => `const fixture${index} = ${index};`);
  writeFileSync(join(repo, "test", "before.test.ts"), `${context.join("\n")}\nexpect(value()).toBe(2);\n`);
  commit(repo, "test before renamed weakening");
  git(repo, "mv", "test/before.test.ts", "src/value.ts");
  writeFileSync(join(repo, "src", "value.ts"), `${context.join("\n")}\nexpect(value()).toBeGreaterThan(0);\n`);
  commit(repo, "rename and weaken test");
  const results = checkIntegrity(repo, "HEAD~1", "HEAD");
  assert.equal(results.some((candidate) => candidate.ruleId === "diff-unparseable"), false);
  assert.ok(results.some((candidate) => candidate.ruleId === "test-file-deleted"));
});
test("integrity scan does not collapse distinct invalid UTF-8 test replacements", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  const prefix = Buffer.from("const check = require('node:test'); check('security', () => {}); // ");
  writeFileSync(join(repo, "test", "before.test.js"), Buffer.concat([prefix, Buffer.from([0xe9])]));
  commit(repo, "non-UTF8 test baseline");
  git(repo, "rm", "-q", "test/before.test.js");
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "after.test.js"), Buffer.concat([prefix, Buffer.from([0xe8])]));
  commit(repo, "different non-UTF8 replacement");
  const result = checkIntegrity(repo, "HEAD~1", "HEAD").find((candidate) => candidate.ruleId === "test-file-deleted");
  assert.equal(result?.verdict, "contradicted");
});
test("integrity scan rejects a symlink as an exact test replacement", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "before.test.js"), "no-test.js");
  commit(repo, "regular test-shaped baseline");
  git(repo, "rm", "-q", "test/before.test.js");
  mkdirSync(join(repo, "test"));
  symlinkSync("no-test.js", join(repo, "test", "after.test.js"));
  commit(repo, "symlink replacement");
  const result = checkIntegrity(repo, "HEAD~1", "HEAD")[0];
  assert.equal(result.ruleId, "integrity-unreadable");
  assert.match(result.evidence, /not one exact regular Git blob/);
});
test("integrity scan consumes exact test replacements one-to-one", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  const content = "const check = require('node:test');\ncheck('security', () => require('node:assert').ok(true));\n";
  writeFileSync(join(repo, "test", "first.test.js"), content);
  writeFileSync(join(repo, "test", "second.test.js"), content);
  commit(repo, "duplicate aliased tests");
  git(repo, "rm", "-q", "test/first.test.js", "test/second.test.js");
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "only-one.test.js"), content);
  commit(repo, "collapse duplicate tests");
  const result = checkIntegrity(repo, "HEAD~1", "HEAD").find((candidate) => candidate.ruleId === "test-file-deleted");
  assert.equal(result?.verdict, "contradicted");
  assert.match(result?.evidence ?? "", /1 deleted test file/);
});
test("WORKTREE path inventory preserves both sides of a rename", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "before.test.js"), "test('security', () => assert.ok(true));\n");
  commit(repo, "test before worktree move");
  git(repo, "mv", "test/before.test.js", "test/after.test.js");
  assert.deepEqual([...changedPaths(repo, "HEAD", "WORKTREE")].sort(), ["test/after.test.js", "test/before.test.js"]);
  assert.equal(checkIntegrity(repo, "HEAD", "WORKTREE").some((candidate) => candidate.ruleId === "test-file-deleted"), false);
});
test("clean integrity scan is passive", () => {
  const repo = initRepo(); writeFileSync(join(repo, "README.md"), "changed\n"); commit(repo, "docs");
  const check = checkIntegrity(repo, "HEAD~1", "HEAD")[0];
  assert.equal(check.verdict, "verified"); assert.equal(check.contributesToPass, false);
});

test("integrity scan blocks when changed paths cannot be enumerated", () => {
  const result = checkIntegrity(initRepo(), "missing-base", "HEAD")[0];
  assert.equal(result.ruleId, "integrity-unreadable");
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.blocksPass, true);
});

test("integrity scan blocks when the bounded unified diff cannot be read", () => {
  const repo = initRepo();
  writeFileSync(join(repo, "large.ts"), `${"a".repeat(5 * 1024 * 1024)}\n`); commit(repo, "large baseline");
  writeFileSync(join(repo, "large.ts"), `${"b".repeat(5 * 1024 * 1024)}\n`); commit(repo, "large change");
  const result = checkIntegrity(repo, "HEAD~1", "HEAD")[0];
  assert.equal(result.ruleId, "diff-unreadable");
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.blocksPass, true);
});

test("integrity scan blocks when a required changed-test blob exceeds its read limit", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  const path = join(repo, "test", "large.test.ts");
  writeFileSync(path, `${"// baseline fixture\n".repeat(240_000)}\n`); commit(repo, "large test baseline");
  writeFileSync(path, `${readFileSync(path, "utf8")}test('added', () => {});\n`); commit(repo, "touch large test");
  const result = checkIntegrity(repo, "HEAD~1", "HEAD")[0];
  assert.equal(result.ruleId, "integrity-unreadable");
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.blocksPass, true);
});

test("integrity scan forces text patches despite candidate diff attributes", () => {
  const repo = initRepo(); mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "value.ts"), "return value;\n"); commit(repo, "attribute baseline");
  writeFileSync(join(repo, ".gitattributes"), "*.ts -diff\n");
  writeFileSync(join(repo, "src", "value.ts"), "if (false) return fallback;\nreturn value;\n"); commit(repo, "hidden bypass");
  const result = checkIntegrity(repo, "HEAD~1", "HEAD").find((candidate) => candidate.ruleId === "dead-branch-added");
  assert.equal(result?.verdict, "contradicted");
});

test("integrity scan fails closed on Git-quoted changed paths", () => {
  const repo = initRepo(); mkdirSync(join(repo, "src"));
  // Backslash is a valid POSIX filename byte but a Windows path separator.
  // A non-ASCII name remains portable while still forcing Git quoting there.
  if (process.platform === "win32") git(repo, "config", "core.quotePath", "true");
  const path = join(repo, "src", process.platform === "win32" ? "evil-é.ts" : "evil\\name.ts");
  writeFileSync(path, "return value;\n"); commit(repo, "quoted path baseline");
  writeFileSync(path, "if (false) return fallback;\nreturn value;\n"); commit(repo, "quoted path change");
  const result = checkIntegrity(repo, "HEAD~1", "HEAD")[0];
  assert.equal(result.ruleId, "diff-unparseable");
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.blocksPass, true);
  assert.match(result.evidence, /quoted unified-diff (?:old )?path header/);
});

test("integrity scan size-checks required worktree test blobs before reading", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  const path = join(repo, "test", "large.test.ts");
  writeFileSync(path, "test('baseline', () => {});\n"); commit(repo, "test baseline");
  writeFileSync(path, `${"x".repeat(5 * 1024 * 1024)}\n`);
  const result = checkIntegrity(repo, "HEAD", "WORKTREE")[0];
  assert.equal(result.ruleId, "integrity-unreadable");
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.blocksPass, true);
  assert.match(result.evidence, /exceeds the 4 MiB limit/);
});

test("integrity scan refuses symlinked worktree test blobs", () => {
  const repo = initRepo(); mkdirSync(join(repo, "test"));
  const path = join(repo, "test", "linked.test.ts");
  writeFileSync(path, "test('baseline', () => {});\n"); commit(repo, "test baseline");
  unlinkSync(path); symlinkSync(join(repo, "README.md"), path);
  const result = checkIntegrity(repo, "HEAD", "WORKTREE")[0];
  assert.equal(result.ruleId, "integrity-unreadable");
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.blocksPass, true);
  assert.match(result.evidence, /not a regular (?:non-symbolic-link|no-symlink) file/);
});

test("WORKTREE integrity fails closed for unsafe untracked evidence", () => {
  const fixtures: Array<{ name: string; create(repo: string, path: string): void; evidence: RegExp }> = [
    {
      name: "oversized",
      create: (_repo, path) => writeFileSync(path, "x".repeat(5 * 1024 * 1024)),
      evidence: /exceeds the 4 MiB limit/,
    },
    {
      name: "binary",
      create: (_repo, path) => writeFileSync(path, Buffer.from([0, 1, 2, 3])),
      evidence: /is binary/,
    },
    {
      name: "symlink",
      create: (repo, path) => symlinkSync(join(repo, "README.md"), path),
      evidence: /not a regular (?:non-symbolic-link|no-symlink) file/,
    },
    // chmod(0) does not make a file unreadable under Windows ACL semantics.
    ...(process.platform === "win32" ? [] : [{
      name: "unreadable",
      create: (_repo: string, path: string) => { writeFileSync(path, "unreadable\n"); chmodSync(path, 0); },
      evidence: /could not be read/,
    }]),
  ];
  for (const fixture of fixtures) {
    const repo = initRepo(); mkdirSync(join(repo, "test"));
    const path = join(repo, "test", `${fixture.name}.test.js`);
    fixture.create(repo, path);
    const result = checkIntegrity(repo, "HEAD", "WORKTREE")[0];
    assert.equal(result.ruleId, "integrity-unreadable", fixture.name);
    assert.equal(result.blocksPass, true, fixture.name);
    assert.match(result.evidence, fixture.evidence, fixture.name);
    if (fixture.name === "unreadable") chmodSync(path, 0o600);
  }
});

function unifiedDiff(path: string, removed: string[], added: string[]): string {
  const oldRange = removed.length === 0 ? "0,0" : `1,${removed.length}`;
  const newRange = added.length === 0 ? "0,0" : `1,${added.length}`;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldRange} +${newRange} @@`,
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

test("static diff audit rejects quoted path headers it cannot bind exactly", () => {
  const result = checkIntegrityDiff([
    'diff --git "a/src/evil\\\\name.ts" "b/src/evil\\\\name.ts"',
    '--- "a/src/evil\\\\name.ts"',
    '+++ "b/src/evil\\\\name.ts"',
    "@@ -1 +1 @@",
    "-return value;",
    "+if (false) return fallback;",
    "",
  ].join("\n"))[0];
  assert.equal(result.ruleId, "diff-unparseable");
  assert.equal(result.blocksPass, true);
});

test("static diff audit rejects malformed, under-counted, and truncated hunks", () => {
  const clean = unifiedDiff("src/clean.ts", ["return 1;"], ["return 2;"]);
  const malformed = [
    clean,
    "diff --git a/src/hidden.ts b/src/hidden.ts",
    "--- a/src/hidden.ts",
    "+++ b/src/hidden.ts",
    "@@ malformed @@",
    "+if (false) return bypass;",
    "",
  ].join("\n");
  const underCounted = [
    "diff --git a/src/hidden.ts b/src/hidden.ts",
    "--- a/src/hidden.ts",
    "+++ b/src/hidden.ts",
    "@@ -0,0 +1,1 @@",
    "+return value;",
    "+if (false) return bypass;",
    "",
  ].join("\n");
  const truncated = [
    "diff --git a/src/hidden.ts b/src/hidden.ts",
    "--- a/src/hidden.ts",
    "+++ b/src/hidden.ts",
    "@@ -1,2 +1,2 @@",
    "-return old;",
    "+return next;",
  ].join("\n");
  const renamedAcrossScopes = [
    "diff --git a/test/value.test.ts b/src/value.ts",
    "--- a/test/value.test.ts",
    "+++ b/src/value.ts",
    "@@ -1 +1 @@",
    "-expect(value()).toBe(2);",
    "+expect(value()).toBeGreaterThan(0);",
    "",
  ].join("\n");
  const empty = [
    "diff --git a/src/value.ts b/src/value.ts",
    "--- a/src/value.ts",
    "+++ b/src/value.ts",
    "@@ -0,0 +0,0 @@",
    "",
  ].join("\n");
  const missingNewHeader = [
    clean,
    "--- a/test/hidden.test.ts",
    "@@ -1 +0,0 @@",
    "-expect(value()).toBe(2);",
    "",
  ].join("\n");
  const duplicateNewHeader = [
    "diff --git a/src/value.ts b/src/value.ts",
    "--- /dev/null",
    "+++ b/src/value.ts",
    "+++ b/docs/value.md",
    "@@ -0,0 +1 @@",
    "+if (false) return bypass;",
    "",
  ].join("\n");
  const mismatchedIdentity = [
    "diff --git a/src/value.ts b/src/value.ts",
    "--- a/docs/value.md",
    "+++ b/docs/value.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const headerlessThenDangling = [
    "--- a/docs/value.md",
    "+++ b/docs/value.md",
    "@@ -1 +1 @@",
    "-test('security', () => {});",
    "+test.skip('security', () => {});",
    "diff --git a/test/value.test.ts b/test/value.test.ts",
    "",
  ].join("\n");
  for (const diff of [malformed, underCounted, truncated, renamedAcrossScopes, empty, missingNewHeader, duplicateNewHeader, mismatchedIdentity, headerlessThenDangling]) {
    const result = checkIntegrityDiff(diff)[0];
    assert.equal(result.ruleId, "diff-unparseable");
    assert.equal(result.blocksPass, true);
  }
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

test("static diff audit treats in-hunk triple-prefix lines as code rather than file headers", () => {
  const addedPrefixCollision = unifiedDiff(
    "src/counter.ts",
    ["return value;"],
    ["++ counter;", "if (false) return fallback;", "return value;"],
  );
  const removedPrefixCollision = unifiedDiff(
    "test/counter.test.ts",
    ["-- counter;", "expect(value()).toBe(2);"],
    ["-- counter;"],
  );
  const results = checkIntegrityDiff(`${addedPrefixCollision}${removedPrefixCollision}`);
  assert.ok(results.some((result) => result.ruleId === "dead-branch-added"));
  assert.ok(results.some((result) => result.ruleId === "assertion-drop"));
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
test("completion marker scan forces text despite candidate diff attributes", () => {
  const repo = initRepo(); mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src", "value.ts"), "return 1;\n"); commit(repo, "source baseline");
  writeFileSync(join(repo, ".gitattributes"), "*.ts -diff\n");
  writeFileSync(join(repo, "src", "value.ts"), "// TODO: implement the trusted behavior\nreturn 1;\n");
  commit(repo, "hide unfinished marker");
  const claim = { kind: "work_complete" as const, quote: "done", subject: "completion claim" };
  const check = checkCompletion([claim], repo, "HEAD~1", "HEAD", [result("verified")])[0];
  assert.equal(check.ruleId, "completion-marker");
  assert.equal(check.verdict, "contradicted");
});
test("completion scan blocks when its bounded diff cannot be read", () => {
  const repo = initRepo();
  writeFileSync(join(repo, "large.ts"), `${"a".repeat(5 * 1024 * 1024)}\n`); commit(repo, "completion large baseline");
  writeFileSync(join(repo, "large.ts"), `${"b".repeat(5 * 1024 * 1024)}\n`); commit(repo, "completion large change");
  const claim = { kind: "work_complete" as const, quote: "done", subject: "completion claim" };
  const check = checkCompletion([claim], repo, "HEAD~1", "HEAD", [result("verified")])[0];
  assert.equal(check.ruleId, "completion-unreadable");
  assert.equal(check.verdict, "unverifiable");
  assert.equal(check.blocksPass, true);
});
