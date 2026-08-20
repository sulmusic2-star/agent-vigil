import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkIntegrity, checkRunClaims, checkTestsPass, inferTestCommand, parseTestSummary } from "../src/detectors/reality.ts";
import { extractRunClaims, loadTranscript, toolCallFingerprint, type SessionToolCall } from "../src/transcript.ts";
import type { Claim } from "../src/report.ts";

function git(repo: string, ...args: string[]) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }); }
function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "vigil-compat-"));
  git(path, "init", "-q");
  git(path, "config", "user.email", "compat@example.test");
  git(path, "config", "user.name", "Compatibility Lab");
  writeFileSync(join(path, "README.md"), "baseline\n");
  git(path, "add", "README.md"); git(path, "commit", "-qm", "baseline");
  return path;
}
function verifier(path: string, output: string, exitCode = 0): string {
  const script = join(path, "verify.mjs");
  writeFileSync(script, `process.stdout.write(${JSON.stringify(`${output}\n`)}); process.exit(${exitCode});\n`);
  return "node verify.mjs";
}
function countClaim(expectedCount: number): Claim {
  return { kind: "tests_pass", quote: `All ${expectedCount} tests pass.`, subject: `${expectedCount} tests`, expectedCount };
}

const runners = [
  ["Node TAP", "# tests 3\n# pass 3\n# fail 0", { total: 3, passed: 3, failed: 0 }],
  ["Node spec", "ℹ tests 3\nℹ pass 3\nℹ fail 0", { total: 3, passed: 3, failed: 0 }],
  ["Jest", "Tests: 3 passed, 3 total", { total: 3, passed: 3 }],
  ["Vitest", "Test Files  1 passed (1)\nTests  3 passed (3)", { total: 3, passed: 3 }],
  ["pytest", "3 passed in 0.03s", { total: 3, passed: 3 }],
  ["Cargo", "test result: ok. 3 passed; 0 failed; 0 ignored", { total: 3, passed: 3, failed: 0, skipped: 0 }],
  ["Go JSON", ["TestOne", "TestTwo", "TestThree"].map((name) => JSON.stringify({ Action: "pass", Package: "example.test/mod", Test: name })).join("\n"), { total: 3, passed: 3, failed: 0, skipped: 0 }],
  ["Maven Surefire", "[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0", { total: 3, passed: 3, failed: 0, skipped: 0 }],
  ["Gradle", "3 tests completed, 0 failed", { total: 3, passed: 3, failed: 0, skipped: 0 }],
  ["RSpec", "3 examples, 0 failures", { total: 3, passed: 3, failed: 0, skipped: 0 }],
  ["PHPUnit", "OK (3 tests, 6 assertions)", { total: 3, passed: 3, failed: 0, skipped: 0 }],
  ["dotnet test", "Passed! - Failed: 0, Passed: 3, Skipped: 0, Total: 3", { total: 3, passed: 3, failed: 0, skipped: 0 }],
  ["Mocha", "3 passing (12ms)", { total: 3, passed: 3 }],
  ["Bun", "3 pass\n0 fail\nRan 3 tests across 1 file.", { total: 3, passed: 3, failed: 0, skipped: 0 }],
  ["AVA", "3 tests passed", { total: 3, passed: 3 }],
  ["Playwright", "3 passed (1.2s)", { total: 3, passed: 3 }],
  ["Cypress/Mocha", "3 passing", { total: 3, passed: 3 }],
  ["Minitest", "3 runs, 6 assertions, 0 failures, 0 errors, 0 skips", { total: 3, passed: 3, failed: 0, skipped: 0 }],
] as const;

for (const [name, output, parsed] of runners) {
  test(`${name} summary is parsed`, () => {
    const actual = parseTestSummary(output);
    for (const [key, value] of Object.entries(parsed)) assert.equal(actual[key as keyof typeof actual], value);
  });
  test(`${name} repository verifies an exact claimed count`, () => {
    const path = repo();
    assert.equal(checkTestsPass([countClaim(3)], path, verifier(path, output))[0].verdict, "verified");
  });
  test(`${name} repository rejects an inflated claimed count`, () => {
    const path = repo();
    assert.equal(checkTestsPass([countClaim(9)], path, verifier(path, output))[0].verdict, "contradicted");
  });
}

test("plain Go output cannot substantiate a numeric claim", () => {
  const path = repo();
  assert.equal(checkTestsPass([countClaim(3)], path, verifier(path, "ok example.test/mod 0.01s"))[0].verdict, "unverifiable");
});
test("a nonzero test command contradicts a green claim", () => {
  const path = repo();
  assert.equal(checkTestsPass([countClaim(3)], path, verifier(path, "3 passed", 1))[0].verdict, "contradicted");
});
test("skipped tests do not count as passed", () => {
  const path = repo();
  assert.equal(checkTestsPass([countClaim(5)], path, verifier(path, "3 passed, 2 skipped in 0.1s"))[0].verdict, "contradicted");
});

test("a zero-exit runner summary with failures still contradicts green", () => {
  const path = repo();
  assert.equal(checkTestsPass([countClaim(2)], path, verifier(path, "Tests: 1 failed, 2 passed, 3 total"))[0].verdict, "contradicted");
});

test("multi-project dotnet summaries are aggregated", () => {
  const output = "Passed! - Failed: 0, Passed: 2, Skipped: 0, Total: 2\nPassed! - Failed: 0, Passed: 3, Skipped: 0, Total: 3";
  assert.deepEqual(parseTestSummary(output), { total: 5, passed: 5, failed: 0, skipped: 0 });
});

test("Maven class summaries are not double-counted with the module result", () => {
  const output = "Tests run: 2, Failures: 0, Errors: 0, Skipped: 0 -- in ATest\n[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0";
  assert.deepEqual(parseTestSummary(output), { total: 3, passed: 3, failed: 0, skipped: 0 });
});

test("Gradle wrapper inference uses the platform-native launcher", () => {
  const path = repo();
  writeFileSync(join(path, "gradlew"), "#!/bin/sh\n");
  writeFileSync(join(path, "gradlew.bat"), "@echo off\r\n");
  assert.equal(inferTestCommand(path, "darwin"), "./gradlew test");
  assert.equal(inferTestCommand(path, "linux"), "./gradlew test");
  assert.equal(inferTestCommand(path, "win32"), "gradlew.bat test");
});

function codexTranscript(output: unknown, input: unknown = { cmd: "npm test" }): string {
  const path = join(mkdtempSync(join(tmpdir(), "vigil-codex-")), "session.jsonl");
  const rows = [
    { type: "session_meta", payload: {} },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I ran npm test." }] } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c", name: "exec", input } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c", output } },
  ];
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  return path;
}

for (const marker of [
  "Process exited with code 1",
  "exit_code: 2",
  { exitCode: 3 },
  { is_error: true },
  "Command terminated by signal SIGTERM",
  "command timed out",
  "script error",
]) {
  test(`Codex failure marker ${JSON.stringify(marker)} contradicts a run claim`, () => {
    const loaded = loadTranscript(codexTranscript(marker));
    assert.equal(checkRunClaims(extractRunClaims(loaded.narrative), loaded.toolCalls)[0].verdict, "contradicted");
  });
}

test("Codex object-valued tool input remains searchable", () => {
  const loaded = loadTranscript(codexTranscript({ exit_code: 0 }));
  assert.match(loaded.toolCalls[0].input, /npm test/);
  assert.equal(checkRunClaims(extractRunClaims(loaded.narrative), loaded.toolCalls)[0].verdict, "verified");
});
test("sentence punctuation is not part of a run claim", () => assert.equal(extractRunClaims("I ran npm test.")[0].subject, "npm test"));
test("semantically identical JSON tool calls share a fingerprint", () => {
  const left: SessionToolCall = { id: "1", name: "Bash", input: '{"cmd":"npm test","cwd":"."}', sequence: 0 };
  const right: SessionToolCall = { id: "2", name: "bash", input: '{ "cwd": ".", "cmd": "npm test" }', sequence: 1 };
  assert.equal(toolCallFingerprint(left), toolCallFingerprint(right));
});

test("malformed JSONL fails loudly", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vigil-jsonl-")), "bad.jsonl"); writeFileSync(path, "{bad json}\n");
  assert.throws(() => loadTranscript(path), /invalid JSONL at line 1/);
});
test("mixed valid and malformed JSONL fails loudly", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vigil-jsonl-")), "mixed.jsonl"); writeFileSync(path, '{"type":"session_meta","payload":{}}\nnot json\n');
  assert.throws(() => loadTranscript(path), /invalid JSONL at line 2/);
});
test("unknown JSONL schema fails loudly", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vigil-jsonl-")), "unknown.jsonl"); writeFileSync(path, '{"type":"mystery"}\n');
  assert.throws(() => loadTranscript(path), /unrecognized JSONL transcript schema/);
});
test("mixed JSONL schemas fail at the foreign record", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vigil-jsonl-")), "mixed-schema.jsonl");
  writeFileSync(path, '{"type":"session_meta","payload":{}}\n{"type":"assistant","message":{"content":[]}}\n');
  assert.throws(() => loadTranscript(path), /unsupported record type "assistant" at line 2/);
});
test("unknown records inside a known schema fail at their source line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vigil-jsonl-")), "unknown-record.jsonl");
  writeFileSync(path, '\n{"type":"session_meta","payload":{}}\n{"type":"mystery"}\n');
  assert.throws(() => loadTranscript(path), /unsupported record type "mystery" at line 3/);
});
test("UTF-8 BOM JSONL remains readable", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vigil-jsonl-")), "bom.jsonl"); writeFileSync(path, '\uFEFF{"type":"session_meta","payload":{}}\n');
  assert.equal(loadTranscript(path).format, "codex");
});

test("documentation mentioning a bypass is not itself a contradiction", () => {
  const path = repo();
  writeFileSync(join(path, "README.md"), "Never use `npm test || true` in CI.\n"); // vigil:detector-pattern
  git(path, "add", "README.md"); git(path, "commit", "-qm", "document anti-pattern");
  assert.equal(checkIntegrity(path, "HEAD~1", "HEAD").some((result) => result.verdict === "contradicted"), false);
});

test("untracked worktree files are included in anti-bypass scans", () => {
  const path = repo();
  writeFileSync(join(path, "verify.sh"), "npm test || true\n"); // vigil:detector-pattern
  assert.ok(checkIntegrity(path, "HEAD", "WORKTREE").some((result) => result.ruleId === "verification-bypass" && result.verdict === "contradicted"));
});

test("untracked worktree test definitions contribute to the test surface", () => {
  const path = repo();
  writeFileSync(join(path, "new.test.ts"), "test('new',()=>{})\n");
  const result = checkIntegrity(path, "HEAD", "WORKTREE");
  assert.equal(result.some((item) => item.ruleId === "test-count-drop"), false);
});
