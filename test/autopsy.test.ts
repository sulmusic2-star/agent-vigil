import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { discoverAutopsyCandidates } from "../src/autopsy-discovery.ts";
import { runAutopsyCommand } from "../src/autopsy-cli.ts";
import { buildRunAutopsy, recomputeRunAutopsyHash, type RunAutopsy } from "../src/autopsy.ts";
import { buildCursorExactCostEvidence } from "../src/cost-evidence.ts";
import { run } from "../src/cli.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { generateSigningKey, signReport } from "../src/signature.ts";
import { loadTranscript } from "../src/transcript.ts";

const SESSION = "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b";
const POLICY_SHA = `sha256:${"c".repeat(64)}`;

function cursorTranscript(session = SESSION, secret = "private prompt contents"): Buffer {
  const row = (value: Record<string, unknown>, timestamp_ms: number) => ({ ...value, conversationId: session, timestamp_ms });
  return Buffer.from([
    JSON.stringify(row({ type: "system" }, 1788183000000)),
    JSON.stringify(row({ type: "user", message: { content: secret } }, 1788183600000)),
    JSON.stringify(row({ type: "assistant", message: { content: "Implemented the requested change." } }, 1788184200000)),
    JSON.stringify(row({ type: "tool_call", subtype: "started", call_id: "one", tool_call: { shellToolCall: { args: { command: "npm test" } } } }, 1788184800000)),
    JSON.stringify(row({ type: "tool_call", subtype: "completed", call_id: "one", tool_call: { shellToolCall: { result: "ok" } } }, 1788184860000)),
    JSON.stringify(row({ type: "result", subtype: "success", result: "Implemented the requested change." }, 1788186000000)),
  ].join("\n") + "\n");
}

function usageEvent(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "1788184800000",
    conversationId: SESSION,
    model: "claude-test",
    kind: "Usage-based",
    isChargeable: true,
    chargedCents: 250,
    ...overrides,
  };
}

function usageExport(events = [usageEvent()]): Buffer {
  return Buffer.from(JSON.stringify({
    totalUsageEventsCount: events.length,
    pagination: { numPages: 1, currentPage: 1, pageSize: events.length, hasNextPage: false, hasPreviousPage: false },
    usageEvents: events,
    period: { startDate: 1788181200000, endDate: 1788188400000 },
  }));
}

function check(verdict: CheckResult["verdict"]): CheckResult {
  return {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict,
    evidence: verdict === "verified" ? "fresh suite exited zero" : "fresh suite failed",
    ruleId: "tests-pass",
  };
}

function fixture(options: { verdict?: CheckResult["verdict"]; strict?: boolean; sameCommit?: boolean; session?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vigil-autopsy-"));
  const transcriptPath = join(root, "cursor.jsonl");
  const receiptPath = join(root, "receipt.json");
  const publicKeyPath = join(root, "receipt-public.pem");
  const privateKeyPath = join(root, "receipt-private.pem");
  const costPath = join(root, "cost.json");
  const usagePath = join(root, "cursor-usage.json");
  const reviewPath = join(root, "review.json");
  const outcomePath = join(root, "outcome.json");
  const outputPath = join(root, "autopsy.json");
  const transcriptBytes = cursorTranscript(options.session ?? SESSION);
  writeFileSync(transcriptPath, transcriptBytes);
  const loaded = loadTranscript(transcriptPath);
  generateSigningKey(privateKeyPath, publicKeyPath);
  const base = "a".repeat(40);
  const head = options.sameCommit ? base : "b".repeat(40);
  const report = signReport(buildReport({
    transcript: "cursor.jsonl",
    transcriptSha256: loaded.transcriptSha256,
    transcriptFormat: loaded.format,
    repo: root,
    base,
    head,
    results: [check(options.verdict ?? "verified")],
    policy: { minVerified: 1, strict: options.strict ?? true, sha256: POLICY_SHA },
    repository: { remote: "https://example.invalid/owner/repository.git", tree: "d".repeat(40) },
  }), privateKeyPath);
  writeFileSync(receiptPath, `${JSON.stringify(report)}\n`);
  const usageBytes = usageExport();
  writeFileSync(usagePath, usageBytes);
  const cost = buildCursorExactCostEvidence({ transcript: transcriptBytes, usageExport: usageBytes });
  writeFileSync(costPath, `${JSON.stringify(cost)}\n`);
  writeFileSync(reviewPath, '{"state":"accepted"}\n');
  writeFileSync(outcomePath, '{"state":"merged"}\n');
  return {
    root,
    transcriptPath,
    receiptPath,
    publicKeyPath,
    privateKeyPath,
    costPath,
    usagePath,
    reviewPath,
    outcomePath,
    outputPath,
    transcriptBytes,
    cost,
  };
}

function readAutopsy(path: string): RunAutopsy {
  return JSON.parse(readFileSync(path, "utf8")) as RunAutopsy;
}

function earnedArgs(value: ReturnType<typeof fixture>): string[] {
  return [
    "autopsy", value.transcriptPath,
    "--receipt", value.receiptPath,
    "--public-key", value.publicKeyPath,
    "--cost-evidence", value.costPath,
    "--budget-usd", "5",
    "--disposition", "accepted",
    "--review-evidence", value.reviewPath,
    "--format", "json",
    "--output", value.outputPath,
  ];
}

function symlinkOrSkip(context: TestContext, target: string, path: string): boolean {
  try { symlinkSync(target, path); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
      context.skip(`host does not permit symlink creation (${code})`);
      return false;
    }
    throw error;
  }
}

test("autopsy emits an EARNED privacy-preserving record only from joined pinned evidence", () => {
  const value = fixture();
  assert.equal(run(earnedArgs(value)), 0);
  const record = readAutopsy(value.outputPath);
  assert.equal(record.decision, "EARNED");
  assert.equal(record.change.receiptAuthority, "VALID_PINNED");
  assert.equal(record.change.transcriptJoin, "MATCHED");
  assert.equal(record.cost.transcriptJoin, "MATCHED");
  assert.equal(record.cost.amountUsd, 2.5);
  assert.equal(record.cost.budgetStatus, "WITHIN");
  assert.equal(record.acceptance.reviewEvidenceSha256, `sha256:${createHash("sha256").update('{"state":"accepted"}\n').digest("hex")}`);
  assert.deepEqual(record.evidenceGaps, []);
  assert.equal(recomputeRunAutopsyHash(record), record.autopsyHash);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /private prompt contents/);
  assert.doesNotMatch(serialized, new RegExp(SESSION));
  if (process.platform !== "win32") assert.equal(statSync(value.outputPath).mode & 0o777, 0o600);
});

test("autopsy stays NOT_CHECKED when required evidence is absent", () => {
  const value = fixture();
  assert.equal(run(["autopsy", value.transcriptPath, "--json", "--output", value.outputPath]), 2);
  const record = readAutopsy(value.outputPath);
  assert.equal(record.decision, "NOT_CHECKED");
  assert.deepEqual(record.reasonCodes.slice(0, 3), ["verification-missing", "cost-missing", "acceptance-missing"]);
  assert.equal(record.privacy.localOnly, true);
});

test("a self-asserted signing key cannot produce EARNED", () => {
  const value = fixture();
  const args = earnedArgs(value).filter((item, index, all) => item !== "--public-key" && all[index - 1] !== "--public-key");
  assert.equal(run(args), 2);
  const record = readAutopsy(value.outputPath);
  assert.equal(record.decision, "NOT_CHECKED");
  assert.equal(record.change.receiptAuthority, "VALID_SELF_ASSERTED");
  assert.ok(record.reasonCodes.includes("verification-key-unpinned"));
});

test("autopsy can import a complete Cursor export directly without retaining it", () => {
  const value = fixture();
  assert.equal(run([
    "autopsy", value.transcriptPath,
    "--receipt", value.receiptPath,
    "--public-key", value.publicKeyPath,
    "--cursor-usage-export", value.usagePath,
    "--outcome", "merged",
    "--outcome-evidence", value.outcomePath,
    "--format", "json",
    "--output", value.outputPath,
  ]), 0);
  const record = readAutopsy(value.outputPath);
  assert.equal(record.decision, "EARNED");
  assert.equal(record.cost.amountUsd, 2.5);
  assert.equal(record.acceptance.outcomeEvidenceSha256, `sha256:${createHash("sha256").update('{"state":"merged"}\n').digest("hex")}`);
  assert.doesNotMatch(JSON.stringify(record), /Usage-based|chargedCents|conversationId/);
});

test("a receipt signed by the wrong pinned key stays NOT_CHECKED", () => {
  const value = fixture();
  const otherPrivate = join(value.root, "other-private.pem");
  const otherPublic = join(value.root, "other-public.pem");
  generateSigningKey(otherPrivate, otherPublic);
  const args = earnedArgs(value);
  args[args.indexOf(value.publicKeyPath)] = otherPublic;
  assert.equal(run(args), 2);
  const record = readAutopsy(value.outputPath);
  assert.equal(record.decision, "NOT_CHECKED");
  assert.equal(record.change.receiptAuthority, "INVALID");
  assert.ok(record.reasonCodes.includes("verification-receipt-invalid"));
});

test("a pinned failed receipt produces NOT_EARNED even when other evidence is absent", () => {
  const value = fixture({ verdict: "contradicted" });
  assert.equal(run([
    "autopsy", value.transcriptPath,
    "--receipt", value.receiptPath,
    "--public-key", value.publicKeyPath,
    "--format", "json",
    "--output", value.outputPath,
  ]), 1);
  const record = readAutopsy(value.outputPath);
  assert.equal(record.decision, "NOT_EARNED");
  assert.equal(record.reasonCodes[0], "verification-failed");
});

test("exact cost beyond a declared budget produces NOT_EARNED", () => {
  const value = fixture();
  assert.equal(run([
    "autopsy", value.transcriptPath,
    "--cost-evidence", value.costPath,
    "--budget-usd", "1",
    "--json", "--output", value.outputPath,
  ]), 1);
  const record = readAutopsy(value.outputPath);
  assert.equal(record.decision, "NOT_EARNED");
  assert.equal(record.cost.budgetStatus, "EXCEEDED");
  assert.equal(record.reasonCodes[0], "cost-budget-exceeded");
});

test("no-op changes and evidence-backed adverse outcomes are NOT_EARNED", () => {
  const noOp = fixture({ sameCommit: true });
  assert.equal(run(earnedArgs(noOp)), 1);
  assert.ok(readAutopsy(noOp.outputPath).reasonCodes.includes("no-change-produced"));

  const reverted = fixture();
  assert.equal(run([
    "autopsy", reverted.transcriptPath,
    "--outcome", "reverted",
    "--outcome-evidence", reverted.outcomePath,
    "--json", "--output", reverted.outputPath,
  ]), 1);
  assert.ok(readAutopsy(reverted.outputPath).reasonCodes.includes("outcome-reverted"));
});

test("receipt and cost evidence from another transcript cannot be joined", () => {
  const original = fixture();
  const otherTranscript = join(original.root, "other.jsonl");
  writeFileSync(otherTranscript, cursorTranscript("11111111-2222-3333-4444-555555555555"));
  assert.equal(run([
    "autopsy", otherTranscript,
    "--receipt", original.receiptPath,
    "--public-key", original.publicKeyPath,
    "--cost-evidence", original.costPath,
    "--disposition", "accepted",
    "--review-evidence", original.reviewPath,
    "--json", "--output", original.outputPath,
  ]), 2);
  const record = readAutopsy(original.outputPath);
  assert.equal(record.decision, "NOT_CHECKED");
  assert.equal(record.change.transcriptJoin, "MISMATCH");
  assert.equal(record.cost.transcriptJoin, "MISMATCH");
  assert.ok(record.reasonCodes.includes("verification-transcript-mismatch"));
  assert.ok(record.reasonCodes.includes("cost-transcript-mismatch"));
});

test("tampered cost evidence is rejected instead of becoming an autopsy record", () => {
  const value = fixture();
  writeFileSync(value.costPath, JSON.stringify({ ...value.cost, amountUsd: 0.01 }));
  assert.equal(run([
    "autopsy", value.transcriptPath,
    "--cost-evidence", value.costPath,
    "--json", "--output", value.outputPath,
  ]), 2);
  assert.equal(readFileSync(value.costPath, "utf8").includes('"amountUsd":0.01'), true);
  assert.throws(() => readFileSync(value.outputPath));
});

test("autopsy output cannot replace or hard-link-alias any input", () => {
  const value = fixture();
  const original = readFileSync(value.transcriptPath);
  assert.equal(run(["autopsy", value.transcriptPath, "--output", value.transcriptPath]), 2);
  assert.deepEqual(readFileSync(value.transcriptPath), original);

  const alias = join(value.root, "alias.jsonl");
  linkSync(value.transcriptPath, alias);
  assert.equal(run(["autopsy", value.transcriptPath, "--output", alias]), 2);
  assert.deepEqual(readFileSync(value.transcriptPath), original);
});

test("local discovery is bounded, metadata-only, and refuses symlink candidates", (context) => {
  const home = mkdtempSync(join(tmpdir(), "vigil-autopsy-home-"));
  const codexRoot = join(home, ".codex", "sessions", "2026", "09", "02");
  const claudeRoot = join(home, ".claude", "projects", "sample");
  mkdirSync(codexRoot, { recursive: true });
  mkdirSync(claudeRoot, { recursive: true });
  const codexPath = join(codexRoot, "codex.jsonl");
  writeFileSync(codexPath, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/codex", git: { branch: "feature" } } })}\n`);
  const claudePath = join(claudeRoot, "claude.jsonl");
  writeFileSync(claudePath, `${JSON.stringify({ type: "user", cwd: "/workspace/claude", gitBranch: "main" })}\n`);
  const oversized = join(codexRoot, "oversized.jsonl");
  writeFileSync(oversized, "");
  truncateSync(oversized, 50 * 1024 * 1024 + 1);
  const outside = join(home, "outside.jsonl");
  writeFileSync(outside, "do not follow\n");
  const linked = join(codexRoot, "linked.jsonl");
  if (!symlinkOrSkip(context, outside, linked)) return;

  const discovery = discoverAutopsyCandidates([
    { agent: "codex", path: join(home, ".codex", "sessions"), maxDepth: 6 },
    { agent: "claude-code", path: join(home, ".claude", "projects"), maxDepth: 3 },
  ]);
  assert.equal(discovery.scannedFiles, 3);
  assert.equal(discovery.skippedOversized, 1);
  assert.equal(discovery.candidates.some((candidate) => candidate.path === linked), false);
  assert.equal(discovery.candidates.find((candidate) => candidate.path === codexPath)?.repository, "/workspace/codex");
  assert.equal(discovery.candidates.find((candidate) => candidate.path === codexPath)?.branch, "feature");
  assert.equal(discovery.candidates.find((candidate) => candidate.path === claudePath)?.repository, "/workspace/claude");
  assert.equal(discovery.candidates.find((candidate) => candidate.path === oversized)?.selectable, false);
});

test("no-argument autopsy selects one bounded local transcript but asks when discovery is ambiguous", () => {
  const home = mkdtempSync(join(tmpdir(), "vigil-autopsy-select-"));
  const codexRoot = join(home, ".codex", "sessions");
  mkdirSync(codexRoot, { recursive: true });
  const transcript = join(codexRoot, "one.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/one", model: "gpt-test" } })}\n`);
  const output = join(home, "result.json");
  assert.equal(runAutopsyCommand(["--json", "--output", output], { HOME: home }), 2);
  assert.equal(readAutopsy(output).decision, "NOT_CHECKED");

  writeFileSync(join(codexRoot, "two.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace/two" } })}\n`);
  const listing = join(home, "listing.json");
  assert.equal(runAutopsyCommand(["--json", "--output", listing], { HOME: home }), 2);
  assert.equal(existsSync(listing), false, "an ambiguous choice must not replace the intended result path with a discovery document");
  assert.equal(runAutopsyCommand(["--list", "--json", "--output", listing], { HOME: home }), 0);
  const discovery = JSON.parse(readFileSync(listing, "utf8"));
  assert.equal(discovery.schemaVersion, "agent-vigil-autopsy-discovery/v1");
  assert.equal(discovery.candidates.length, 2);

  const original = readFileSync(transcript);
  assert.equal(runAutopsyCommand(["--list", "--output", transcript], { HOME: home }), 2);
  assert.deepEqual(readFileSync(transcript), original);
});

test("unbounded model identifiers fail closed before entering a record", () => {
  const home = mkdtempSync(join(tmpdir(), "vigil-autopsy-model-"));
  const transcript = join(home, "codex.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "session_meta", payload: { model: "x".repeat(201) } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } }),
  ].join("\n"));
  const output = join(home, "autopsy.json");
  assert.equal(run(["autopsy", transcript, "--json", "--output", output]), 2);
  assert.equal(existsSync(output), false);
});

test("printable Unicode model identifiers satisfy the emitted autopsy schema", () => {
  const home = mkdtempSync(join(tmpdir(), "vigil-autopsy-unicode-model-"));
  const transcript = join(home, "codex.jsonl");
  const model = "model-模型-α";
  writeFileSync(transcript, [
    JSON.stringify({ type: "session_meta", payload: { id: "run", model } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } }),
  ].join("\n"));
  const record = buildRunAutopsy({ transcript: loadTranscript(transcript) });
  assert.deepEqual(record.run.modelIds, [model]);
  const schema = JSON.parse(readFileSync(new URL("../docs/run-autopsy-v1.schema.json", import.meta.url), "utf8"));
  const item = schema.$defs.modelIds.items;
  assert.match(model, new RegExp(item.pattern));
  assert.ok([...model].length <= item.maxLength);
});

test("autopsy argument and schema contracts reject ambiguous inputs", () => {
  const value = fixture();
  assert.equal(run(["autopsy", value.transcriptPath, "--cost-evidence", value.costPath, "--cursor-usage-export", value.costPath]), 2);
  assert.equal(run(["autopsy", value.transcriptPath, "--public-key", value.publicKeyPath]), 2);
  assert.equal(run(["autopsy", value.transcriptPath, "--disposition", "great"]), 2);
  assert.equal(run(["autopsy", value.transcriptPath, "--budget-usd", "Infinity"]), 2);
  assert.equal(run(["autopsy", "--list", "--receipt", value.receiptPath]), 2);
  const schema = JSON.parse(readFileSync(new URL("../docs/run-autopsy-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, "agent-vigil-run-autopsy/v1");
  assert.ok(schema.required.includes("autopsyHash"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    schema.properties.cost.allOf.map((condition: { then: { required: string[] } }) => condition.then.required),
    [["amountUsd", "evidenceHash"], ["amountUsd", "budgetUsd"]],
  );
  assert.deepEqual(
    schema.properties.acceptance.allOf.map((condition: { then: { required: string[] } }) => condition.then.required),
    [["reviewEvidenceSha256"], ["outcomeEvidenceSha256"]],
  );
  const earned = schema.allOf.find((condition: any) => condition.if?.properties?.decision?.const === "EARNED");
  assert.ok(earned, "the schema must bind EARNED to its supporting evidence");
  assert.deepEqual(earned.then.properties.change.properties.verification, { const: "PASS" });
  assert.deepEqual(earned.then.properties.change.properties.receiptAuthority, { const: "VALID_PINNED" });
  assert.deepEqual(earned.then.properties.change.properties.transcriptJoin, { const: "MATCHED" });
  assert.deepEqual(earned.then.properties.cost.properties.evidence, { const: "PROVIDER_EXPORTED" });
  assert.deepEqual(earned.then.properties.cost.properties.transcriptJoin, { const: "MATCHED" });
  assert.deepEqual(
    earned.then.properties.acceptance.allOf[0].anyOf.map((condition: any) => condition.required),
    [
      ["disposition", "reviewEvidence", "reviewEvidenceSha256"],
      ["outcome", "outcomeEvidence", "outcomeEvidenceSha256"],
    ],
  );
  assert.equal(earned.then.properties.evidenceGaps.maxItems, 0);
  assert.equal(
    earned.then.properties.reasonCodes.contains.const,
    "verified-accepted-change-with-exact-cost",
  );
});

test("run autopsy hash detects mutation and ignores presentation time", () => {
  const value = fixture();
  assert.equal(run(earnedArgs(value)), 0);
  const record = readAutopsy(value.outputPath);
  const changedTime = { ...record, generatedAt: "2030-01-01T00:00:00.000Z" };
  assert.equal(recomputeRunAutopsyHash(changedTime), record.autopsyHash);
  const changedCost = { ...record, cost: { ...record.cost, amountUsd: 0 } };
  assert.notEqual(recomputeRunAutopsyHash(changedCost), record.autopsyHash);
});

test("review evidence bytes are hashed without being copied", () => {
  const value = fixture();
  const secret = "maintainer private explanation";
  writeFileSync(value.reviewPath, secret);
  chmodSync(value.reviewPath, 0o600);
  assert.equal(run(earnedArgs(value)), 0);
  const record = readAutopsy(value.outputPath);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
  const expected = `sha256:${createHash("sha256").update(secret).digest("hex")}`;
  assert.equal(record.acceptance.reviewEvidence, "HASHED");
  assert.equal(record.acceptance.reviewEvidenceSha256, expected);
  const changedEvidence = {
    ...record,
    acceptance: { ...record.acceptance, reviewEvidenceSha256: `sha256:${"0".repeat(64)}` },
  };
  assert.notEqual(recomputeRunAutopsyHash(changedEvidence), record.autopsyHash);
});
