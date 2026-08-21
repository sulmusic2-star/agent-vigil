import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/config.ts";
import { renderMarkdown, remediationFor } from "../src/output.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { generateSigningKey, signReport, verifyReport } from "../src/signature.ts";
import { doctorRepository, initRepository } from "../src/setup.ts";
import { loadTranscript } from "../src/transcript.ts";
import { checkTestsPass } from "../src/detectors/reality.ts";

function temp(prefix = "vigil-adoption-") { return mkdtempSync(join(tmpdir(), prefix)); }
function jsonl(rows: unknown[], name = "session.jsonl"): string {
  const path = join(temp(), name);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return path;
}
function repo(): string {
  const path = temp("vigil-init-");
  execFileSync("git", ["init", "-q"], { cwd: path });
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  return path;
}

test("detects Cursor stream JSON and correlates tools", () => {
  const path = jsonl([
    { type: "system", subtype: "init", session_id: "s" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I ran " }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "npm test." }] } },
    { type: "tool_call", subtype: "started", call_id: "c", tool_call: { shellToolCall: { args: { command: "npm test" } } } },
    { type: "tool_call", subtype: "completed", call_id: "c", tool_call: { shellToolCall: { result: { success: { output: "ok" } } } } },
    { type: "result", subtype: "success", result: "I ran npm test." },
  ]);
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "cursor");
  assert.equal(loaded.narrative, "I ran npm test.");
  assert.equal(loaded.toolCalls[0].name, "shell");
  assert.match(loaded.toolCalls[0].input, /npm test/);
  assert.equal(loaded.toolCalls[0].isError, false);
});

test("correlates Cursor tool rows when call IDs are absent", () => {
  const path = jsonl([
    { type: "system", subtype: "init", session_id: "s" },
    { type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "npm test" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { result: "ok" } } },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const loaded = loadTranscript(path);
  assert.equal(loaded.toolCalls[0].output, "ok");
});

test("Claude system init does not collide with Cursor detection", () => {
  const path = jsonl([
    { type: "system", subtype: "init", session_id: "s" },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
  ]);
  assert.equal(loadTranscript(path).format, "claude-code");
});

test("detects Gemini CLI stream JSON and failed tools", () => {
  const path = jsonl([
    { type: "init", timestamp: "2026-01-01T00:00:00Z", session_id: "s", model: "gemini" },
    { type: "message", timestamp: "2026-01-01T00:00:01Z", role: "assistant", content: "I ran npm test." },
    { type: "tool_use", timestamp: "2026-01-01T00:00:02Z", tool_name: "run_shell_command", tool_id: "g", parameters: { command: "npm test" } },
    { type: "tool_result", timestamp: "2026-01-01T00:00:03Z", tool_id: "g", status: "error", error: { type: "x", message: "failed" } },
    { type: "result", timestamp: "2026-01-01T00:00:04Z", status: "error" },
  ]);
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "gemini-cli");
  assert.equal(loaded.toolCalls[0].name, "run_shell_command");
  assert.equal(loaded.toolCalls[0].isError, true);
});

test("detects GitHub Copilot CLI event logs", () => {
  const path = jsonl([
    { id: "1", type: "assistant.message", timestamp: "2026-01-01T00:00:00Z", data: { content: "I ran npm test." } },
    { id: "2", type: "tool.execution_start", timestamp: "2026-01-01T00:00:01Z", data: { toolCallId: "x", toolName: "bash", arguments: { command: "npm test" } } },
    { id: "3", type: "tool.execution_complete", timestamp: "2026-01-01T00:00:02Z", data: { toolCallId: "x", success: true, result: "ok" } },
    { id: "4", type: "session.idle", timestamp: "2026-01-01T00:00:03Z", data: { aborted: false } },
  ]);
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "github-copilot-cli");
  assert.equal(loaded.toolCalls[0].name, "bash");
  assert.equal(loaded.toolCalls[0].isError, false);
});

test("detects OpenCode JSON exports", () => {
  const path = join(temp(), "opencode.json");
  writeFileSync(path, JSON.stringify({
    info: { id: "s" },
    messages: [{ info: { role: "assistant" }, parts: [
      { type: "text", text: "I ran npm test." },
      { id: "p", callID: "o", type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "ok" } },
    ] }],
  }));
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "opencode");
  assert.equal(loaded.toolCalls[0].name, "bash");
  assert.equal(loaded.toolCalls[0].isError, false);
});

test("invalid OpenCode tool timestamps do not abort the adapter", () => {
  const path = join(temp(), "opencode.json");
  writeFileSync(path, JSON.stringify({ info: { id: "s" }, messages: [{ info: { role: "assistant" }, parts: [
    { type: "tool", tool: "bash", callID: "x", time: { start: "not-a-date" }, state: { status: "completed", output: "ok" } },
  ] }] }));
  assert.equal(loadTranscript(path).toolCalls[0].timestamp, undefined);
});

test("detects Aider chat history by its documented filename", () => {
  const path = join(temp(), ".aider.chat.history.md");
  writeFileSync(path, "The test suite passes.\n");
  assert.equal(loadTranscript(path).format, "aider");
});

test("rejects unknown JSON object transcripts", () => {
  const path = join(temp(), "unknown.json");
  writeFileSync(path, JSON.stringify({ mystery: true }));
  assert.throws(() => loadTranscript(path), /unrecognized JSON transcript schema/);
});

test("policy hashing is canonical across JSON key order", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"strict":true,"minVerified":2}');
  const first = loadPolicy(path).sha256;
  writeFileSync(join(path, ".agent-vigil.json"), '{"minVerified":2,"strict":true,"schemaVersion":1}');
  assert.equal(loadPolicy(path).sha256, first);
});

test("policy rejects unknown fields instead of silently ignoring them", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"magicPass":true}');
  assert.throws(() => loadPolicy(path), /unknown field/);
});

test("policy can be anchored to a trusted Git ref", () => {
  const path = repo();
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: path });
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"strict":true}');
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync("git", ["commit", "-qm", "policy"], { cwd: path });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"strict":false}');
  const loaded = loadPolicy(path, ".agent-vigil.json", base);
  assert.equal(loaded.value.strict, true);
  assert.equal(loaded.ref, base);
});

test("an empty zero-exit command cannot substantiate a test claim", () => {
  const path = repo();
  const claim = { kind: "tests_pass" as const, quote: "tests pass", subject: "test suite" };
  const result = checkTestsPass([claim], path, "true")[0];
  assert.equal(result.verdict, "unverifiable");
  assert.match(result.evidence, /no supported test summary/);
});

test("init creates a policy, evidence placeholder, and exact-SHA workflow", () => {
  const path = repo();
  const result = initRepository(path);
  assert.equal(result.created.length, 4);
  const workflow = readFileSync(join(path, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.match(workflow, /pull_request\.base\.sha/);
  assert.match(workflow, /pull_request\.head\.sha/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(readFileSync(join(path, ".agent-vigil.json"), "utf8"), /npm test --silent/);
});

test("init preserves existing policy unless force is explicit", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), "custom\n");
  const result = initRepository(path);
  assert.ok(result.kept.includes(".agent-vigil.json"));
  assert.equal(readFileSync(join(path, ".agent-vigil.json"), "utf8"), "custom\n");
  initRepository(path, true);
  assert.match(readFileSync(join(path, ".agent-vigil.json"), "utf8"), /schemaVersion/);
});

test("doctor validates the generated installation", () => {
  const path = repo();
  initRepository(path);
  const checks = doctorRepository(path);
  assert.equal(checks.some((check) => check.status === "FAIL"), false);
  assert.ok(checks.some((check) => check.label === "Git range" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Policy trust" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Transcript" && check.status === "PASS"));
});

function sampleReport() {
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict: "verified",
    evidence: "fresh command passed",
    ruleId: "tests-pass",
  };
  return buildReport({
    transcript: "session.md", transcriptSha256: "sha256:t", transcriptFormat: "markdown",
    repo: ".", base: "a", head: "b", results: [result],
    policy: { minVerified: 1, strict: true, sha256: "sha256:p" },
    repository: { remote: "https://example.test/repo", tree: "tree" },
    reproduction: "vigil session.md --base a --head b",
  });
}

test("signed receipts verify with embedded and pinned Ed25519 keys", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const report = signReport(sampleReport(), privateKey);
  assert.deepEqual(verifyReport(report), { hashValid: true, signatureValid: true, keyPinned: false, keyId: report.signature!.keyId });
  assert.deepEqual(verifyReport(report, publicKey), { hashValid: true, signatureValid: true, keyPinned: true, keyId: report.signature!.keyId });
});

test("receipt verification catches tampering after signing", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const report = signReport(sampleReport(), privateKey);
  report.results[0].evidence = "fabricated";
  const result = verifyReport(report, publicKey);
  assert.equal(result.hashValid, false);
  assert.equal(result.signatureValid, true);
});

test("receipt hash binds summary counts and status", () => {
  const report = sampleReport();
  report.summary.verified = 999;
  assert.equal(verifyReport(report).hashValid, false);
});

test("pinned verification rejects the wrong public key", () => {
  const left = temp(); const right = temp();
  generateSigningKey(join(left, "private.pem"), join(left, "public.pem"));
  generateSigningKey(join(right, "private.pem"), join(right, "public.pem"));
  const report = signReport(sampleReport(), join(left, "private.pem"));
  assert.equal(verifyReport(report, join(right, "public.pem")).signatureValid, false);
});

test("failure output includes a concrete remediation", () => {
  assert.match(remediationFor("test-count"), /observed passing count/);
  const report = sampleReport();
  report.results[0].verdict = "contradicted";
  assert.match(renderMarkdown(report), /What to do next/);
});
