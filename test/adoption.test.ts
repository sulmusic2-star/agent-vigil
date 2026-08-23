import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/config.ts";
import { renderMarkdown, remediationFor } from "../src/output.ts";
import { buildReport, canonical, type CheckResult } from "../src/report.ts";
import { generateSigningKey, publicKeyId, signReport, verifyReport } from "../src/signature.ts";
import { createPortableReceipt, verifyPortableReceipt } from "../src/portable.ts";
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

test("policy validates the static integrity enforcement mode", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"integrityMode":"advisory"}');
  assert.equal(loadPolicy(path).value.integrityMode, "advisory");
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"integrityMode":"magic"}');
  assert.throws(() => loadPolicy(path), /integrityMode must be advisory, calibrated, or blocking/);
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
  assert.equal(result.created.length, 5);
  const workflow = readFileSync(join(path, ".github/workflows/agent-vigil.yml"), "utf8");
  const outcomes = readFileSync(join(path, ".github/workflows/agent-vigil-outcomes.yml"), "utf8");
  assert.match(workflow, /pull_request\.base\.sha/);
  assert.match(workflow, /pull_request\.head\.sha/);
  assert.match(workflow, /merge_group:/);
  assert.match(workflow, /merge_group\.base_sha/);
  assert.match(workflow, /merge_group\.head_sha/);
  assert.match(workflow, /uses: sulmusic2-star\/agent-vigil@v0\.14\.1/);
  assert.match(outcomes, /workflow_run:/);
  assert.match(outcomes, /actions\/download-artifact@v5/);
  assert.match(outcomes, /mode: outcome/);
  assert.doesNotMatch(outcomes, /actions\/checkout/);
  assert.match(readFileSync(join(path, ".agent-vigil.json"), "utf8"), /npm test --silent/);
  assert.match(readFileSync(join(path, ".agent-vigil.json"), "utf8"), /"integrityMode": "advisory"/);
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

test("maintainer init creates a base-anchored evidence gate and retained receipt artifact", () => {
  const path = repo();
  writeFileSync(join(path, "package-lock.json"), '{"lockfileVersion":3}\n');
  const result = initRepository(path, false, undefined, "maintainer");
  assert.equal(result.created.length, 4);
  const policy = JSON.parse(readFileSync(join(path, ".agent-vigil.json"), "utf8"));
  const workflow = readFileSync(join(path, ".github/workflows/agent-vigil.yml"), "utf8");
  const template = readFileSync(join(path, ".github/pull_request_template.md"), "utf8");
  assert.equal(policy.maintainer.reviewMode, "automated");
  assert.equal(policy.maintainer.requireHumanAttestation, false);
  assert.deepEqual(policy.maintainer.automatedReview.commands, ["npm test --silent"]);
  assert.equal(policy.maintainer.automatedReview.setupCommand, "npm ci --ignore-scripts");
  assert.equal(policy.maintainer.differentialTest.overlayChangedTests, true);
  assert.match(workflow, /mode: maintainer/);
  assert.match(workflow, /name: Install dependencies for fresh verification/);
  assert.match(workflow, /run: npm ci --ignore-scripts/);
  assert.match(workflow, /name: agent-vigil-receipt/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /types: \[opened, synchronize, reopened\]/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /agent-vigil-value-card\.json/);
  assert.match(workflow, /agent-vigil-github-evidence\.json/);
  assert.doesNotMatch(template, /Responsible human|I reviewed every changed line|I can explain and maintain/);
  assert.match(template, /isolated checkout of the\s+exact candidate commit/);
  const doctor = doctorRepository(path);
  assert.ok(doctor.some((check) => check.label === "Review mode" && check.status === "PASS" && /isolated exact-commit/.test(check.detail)));
});

test("Action accepts exactly one evidence mode", () => {
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  assert.match(action, /VIGIL_RECEIPT/);
  assert.match(action, /VIGIL_AUTHORITY_CONTRACT/);
  assert.match(action, /choose exactly one of transcript, authority contract, receipt, plan mode, maintainer mode, or outcome mode/);
  assert.match(action, /args=\(plan --repo "\$VIGIL_REPO" --base "\$VIGIL_BASE" --head "\$VIGIL_HEAD"/);
  assert.match(action, /receipt mode requires a base-anchored policy/);
  assert.match(action, /args=\(authority "\$VIGIL_TRANSCRIPT"/);
  assert.match(action, /authority-contract-ref must equal GitHub event base/);
  assert.match(action, /args=\(gate "\$VIGIL_RECEIPT"/);
  assert.match(action, /args=\(merge-group --event "\$GITHUB_EVENT_PATH"/);
  assert.match(action, /e\.merge_group\?\.base_sha/);
  assert.match(action, /echo "sarif=\$sarif_path"/);
  assert.match(action, /github-evidence --event/);
  assert.match(action, /value "\$report_file"/);
  assert.match(action, /echo "value_card=\$value_card_path"/);
  assert.match(action, /echo "value_verdict=\$value_verdict"/);
  assert.match(action, /echo "github_evidence=\$github_evidence_path"/);
  assert.match(action, /outcome mode requires a readable full outcome-receipt/);
  assert.match(action, /actions\/runs\/\$run_id\/jobs/);
  assert.doesNotMatch(action, /gh api[^\n]*--slurp[^\n]*--jq/);
  assert.match(action, /gh api --paginate[^\n]+\| jq -s 'add'/);
});

test("doctor validates the generated installation", () => {
  const path = repo();
  initRepository(path);
  const checks = doctorRepository(path);
  assert.equal(checks.some((check) => check.status === "FAIL"), false);
  assert.ok(checks.some((check) => check.label === "Git range" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Policy trust" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Merge queue" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Transcript" && check.status === "PASS"));
});

test("doctor refuses an unreviewed or expired authority scaffold", () => {
  const path = repo();
  initRepository(path, false, undefined, "authority");
  let checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Task authority" && check.status === "FAIL" && /taskId/.test(check.detail)));
  assert.ok(checks.some((check) => check.label === "Transcript" && check.status === "FAIL" && /structured/.test(check.detail)));
  const contractPath = join(path, ".agent-vigil-authority.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.taskId = "SEC-142";
  contract.expiresAt = "2099-01-01T00:00:00.000Z";
  writeFileSync(contractPath, JSON.stringify(contract, null, 2));
  checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Task authority" && check.status === "PASS"));
});

function sampleReport() {
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict: "verified",
    evidence: "fresh command passed",
    ruleId: "tests-pass",
  };
  return buildReport({
    transcript: "session.md", transcriptSha256: `sha256:${"1".repeat(64)}`, transcriptFormat: "markdown",
    repo: ".", base: "a", head: "b", results: [result],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"2".repeat(64)}` },
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

test("portable receipt omits transcript text and detailed claim evidence", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const report = sampleReport();
  const receipt = createPortableReceipt(report, privateKey);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /session\.md|fresh command passed|tests pass/);
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.hashValid, true);
  assert.equal(verified.signatureValid, true);
  assert.equal(verified.signerTrusted, true);
});

test("portable receipt signature binds status, Git identity, and policy", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  receipt.summary.status = "FAIL";
  receipt.summary.pass = false;
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.hashValid, false);
  assert.equal(verified.signatureValid, true);
});

test("portable receipt does not trust an unpinned embedded signer", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  const verified = verifyPortableReceipt(receipt, []);
  assert.equal(verified.signatureValid, true);
  assert.equal(verified.signerTrusted, false);
  assert.match(verified.errors.join(" "), /not pinned/);
});

test("portable receipt verification rejects malformed metadata and inconsistent summary", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  receipt.reportHash = "bad";
  receipt.repository.tree = "";
  receipt.summary.pass = false;
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.hashValid, false);
  assert.match(verified.errors.join(" "), /reportHash.*SHA-256/);
  assert.match(verified.errors.join(" "), /base, head, and repository tree/);
  assert.match(verified.errors.join(" "), /pass flag disagrees/);
});

test("portable receipt reports field errors separately from a matching payload hash", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  receipt.reportHash = "bad";
  const { portableHash: _portableHash, signature: _signature, ...payload } = receipt;
  receipt.portableHash = `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.hashValid, false);
  assert.match(verified.errors.join(" "), /reportHash.*SHA-256/);
  assert.doesNotMatch(verified.errors.join(" "), /portable receipt hash is invalid/);
});

test("portable receipt verification fails closed on an unreadable embedded key", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  receipt.signature.publicKey = "not-base64";
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.signatureValid, false);
  assert.equal(verified.signerTrusted, false);
  assert.match(verified.errors.join(" "), /could not be read/);
});

test("portable sealing refuses a tampered full receipt", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const report = sampleReport();
  report.summary.verified = 999;
  assert.throws(() => createPortableReceipt(report, privateKey), /full receipt hash is invalid/);
});

test("portable sealing refuses a report without a committed head tree", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict: "verified", evidence: "fresh command passed", ruleId: "tests-pass",
  };
  const report = buildReport({
    transcript: "session.md", transcriptSha256: `sha256:${"1".repeat(64)}`, transcriptFormat: "markdown",
    repo: ".", base: "a", head: "WORKTREE", results: [result],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"2".repeat(64)}` },
    repository: {}, reproduction: "vigil session.md --head WORKTREE",
  });
  assert.throws(() => createPortableReceipt(report, privateKey), /requires a committed head tree/);
});

test("policy validates portable receipt paths and signer IDs", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), JSON.stringify({
    schemaVersion: 1,
    portableReceipt: ".agent-vigil/receipt.json",
    trustedSignerKeyIds: [`sha256:${"a".repeat(64)}`],
  }));
  assert.equal(loadPolicy(path).value.portableReceipt, ".agent-vigil/receipt.json");
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":"../receipt.json"}');
  assert.throws(() => loadPolicy(path), /inside the repository/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":"..\\\\receipt.json"}');
  assert.throws(() => loadPolicy(path), /inside the repository/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":"C:\\\\receipt.json"}');
  assert.throws(() => loadPolicy(path), /inside the repository/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"trustedSignerKeyIds":["bad"]}');
  assert.throws(() => loadPolicy(path), /SHA-256 key IDs/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"trustedSignerKeyIds":[]}');
  assert.throws(() => loadPolicy(path), /non-empty array/);
  writeFileSync(join(path, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, trustedSignerKeyIds: [`sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}`] }));
  assert.throws(() => loadPolicy(path), /duplicates/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":"/tmp/receipt.json"}');
  assert.throws(() => loadPolicy(path), /inside the repository/);
});

test("doctor fails portable mode without a pinned signer", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":".agent-vigil/receipt.json"}');
  const checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Portable signer" && check.status === "FAIL"));
  assert.ok(checks.some((check) => check.label === "Portable receipt" && check.status === "WARN"));
});

test("failure output includes a concrete remediation", () => {
  assert.match(remediationFor("test-count"), /observed passing count/);
  const report = sampleReport();
  report.results[0].verdict = "contradicted";
  assert.match(renderMarkdown(report), /What to do next/);
});
