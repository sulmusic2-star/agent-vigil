import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { buildReport, recomputeReceiptHash, type CheckResult, type TrustReport } from "../src/report.ts";
import { loadTranscript } from "../src/transcript.ts";
import { buildValueCard, recomputeValueCardHash, renderValueCardHtml } from "../src/value.ts";

function passResult(): CheckResult {
  return {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict: "verified",
    evidence: "fresh suite exited zero",
    ruleId: "tests-pass",
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vigil-value-"));
  const transcript = join(root, "codex.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "session" } },
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The test suite passes." }] } },
    { type: "response_item", payload: { type: "function_call", call_id: "one", name: "exec", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "one", output: "ok" } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 6, total_tokens: 166 } } } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150, cached_input_tokens: 60, cache_write_input_tokens: 8, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 258 } } } },
  ];
  writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const loaded = loadTranscript(transcript);
  const report = buildReport({
    transcript: "codex.jsonl",
    transcriptSha256: loaded.transcriptSha256,
    transcriptFormat: loaded.format,
    repo: root,
    base: "a".repeat(40),
    head: "b".repeat(40),
    results: [passResult()],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"c".repeat(64)}` },
  });
  const receipt = join(root, "receipt.json");
  writeFileSync(receipt, JSON.stringify(report));
  return { root, transcript, receipt, report, loaded };
}

test("Claude usage deduplicates streamed assistant message IDs using final maxima", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-claude-usage-"));
  const transcript = join(root, "claude.jsonl");
  const assistant = (id: string, output: number, input = 2) => ({
    type: "assistant",
    message: {
      id,
      model: "claude-test",
      content: [{ type: "text", text: "working" }],
      usage: { input_tokens: input, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: output },
    },
  });
  writeFileSync(transcript, [assistant("m1", 4), assistant("m1", 40), assistant("m2", 5, 3)].map((row) => JSON.stringify(row)).join("\n"));
  const loaded = loadTranscript(transcript);
  assert.equal(loaded.format, "claude-code");
  assert.deepEqual(loaded.usage, {
    source: "transcript-observed",
    accounting: "deduplicated-assistant-messages",
    inputTokens: 5,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 20,
    outputTokens: 45,
    reasoningOutputTokens: 0,
    totalTokens: 110,
    modelIds: ["claude-test"],
    recordsObserved: 3,
    accountedUnits: 2,
  });
});

test("Claude usage rejects conflicting aliases and incoherent deduplicated snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-claude-usage-conflict-"));
  const transcript = join(root, "claude.jsonl");
  const assistant = (usage: Record<string, number>) => ({
    type: "assistant",
    message: {
      id: "m1",
      model: "claude-test",
      content: [{ type: "text", text: "working" }],
      usage,
    },
  });

  writeFileSync(transcript, JSON.stringify(assistant({
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_read_input_tokens: 1_000,
    output_tokens: 0,
    total_tokens: 1,
  })));
  assert.throws(() => loadTranscript(transcript), /cached_input_tokens and cache_read_input_tokens contradict/);

  writeFileSync(transcript, JSON.stringify(assistant({
    input_tokens: 1,
    cache_write_input_tokens: 0,
    cache_creation_input_tokens: 1_000,
    output_tokens: 0,
    total_tokens: 1,
  })));
  assert.throws(() => loadTranscript(transcript), /cache_write_input_tokens and cache_creation_input_tokens contradict/);

  writeFileSync(transcript, JSON.stringify(assistant({
    input_tokens: 1,
    cached_input_tokens: 2,
    cache_read_input_tokens: 2,
    cache_write_input_tokens: 3,
    cache_creation_input_tokens: 3,
    output_tokens: 4,
    total_tokens: 10,
  })));
  assert.equal(loadTranscript(transcript).usage?.totalTokens, 10);

  writeFileSync(transcript, [
    assistant({ input_tokens: 100, output_tokens: 1, total_tokens: 101 }),
    assistant({ input_tokens: 1, output_tokens: 100, total_tokens: 101 }),
  ].map((row) => JSON.stringify(row)).join("\n"));
  assert.throws(() => loadTranscript(transcript), /total_tokens contradicts its component counters/);
});

test("Codex usage selects the greatest cumulative session snapshot", () => {
  const { loaded } = fixture();
  assert.deepEqual(loaded.usage, {
    source: "transcript-observed",
    accounting: "cumulative-session-snapshot",
    inputTokens: 150,
    cachedInputTokens: 60,
    cacheWriteInputTokens: 8,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    totalTokens: 258,
    modelIds: ["gpt-test"],
    recordsObserved: 2,
    accountedUnits: 1,
  });
});

test("Codex usage validates totals without double-counting detail counters", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-codex-usage-total-"));
  const transcript = join(root, "codex.jsonl");
  const session = { type: "session_meta", payload: { id: "session" } };
  const row = (totalTokens?: number) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1_000,
          cached_input_tokens: 900,
          cache_write_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 40,
          total_tokens: totalTokens,
        },
      },
    },
  });

  writeFileSync(transcript, `${[session, row(1_050)].map((item) => JSON.stringify(item)).join("\n")}\n`);
  assert.equal(loadTranscript(transcript).usage?.totalTokens, 1_050);

  writeFileSync(transcript, `${[session, row()].map((item) => JSON.stringify(item)).join("\n")}\n`);
  assert.equal(loadTranscript(transcript).usage?.totalTokens, 1_050);

  writeFileSync(transcript, `${[session, row(1_049)].map((item) => JSON.stringify(item)).join("\n")}\n`);
  assert.throws(() => loadTranscript(transcript), /total_tokens contradicts its component counters/);
});

test("value CLI produces a positive evidence-hashed card with budget and outcome", () => {
  const { root, transcript, receipt } = fixture();
  const evidence = join(root, "invoice.csv");
  const reviewEvidence = join(root, "review.json");
  const outcomeEvidence = join(root, "merge.json");
  const output = join(root, "value.json");
  writeFileSync(evidence, "task,cost\nabc,1.25\n");
  writeFileSync(reviewEvidence, '{"disposition":"accepted"}\n');
  writeFileSync(outcomeEvidence, '{"merged":true}\n');
  assert.equal(run([
    "value", receipt,
    "--transcript", transcript,
    "--cost-usd", "1.25",
    "--cost-source", "provider-billed",
    "--cost-evidence", evidence,
    "--budget-usd", "2.00",
    "--review-minutes", "7",
    "--disposition", "accepted",
    "--review-evidence", reviewEvidence,
    "--outcome", "merged",
    "--outcome-as-of", "2026-08-22T12:00:00Z",
    "--outcome-evidence", outcomeEvidence,
    "--task-class", "bugfix",
    "--format", "json",
    "--output", output,
  ]), 0);
  const card = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(card.schemaVersion, "agent-vigil-value-card/v1");
  assert.equal(card.valueVerdict, "POSITIVE");
  assert.equal(card.task.budgetStatus, "WITHIN");
  assert.equal(card.cost.status, "EVIDENCE_HASHED");
  assert.match(card.cost.evidenceSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(card.metrics.costPerAcceptedChangeUsd, 1.25);
  assert.equal(card.human.evidence, "EVIDENCE_HASHED");
  assert.equal(card.outcome.evidence, "EVIDENCE_HASHED");
  assert.equal(card.usage.totalTokens, 258);
  assert.equal(card.agent.toolCalls, 1);
  assert.equal(card.agent.failedToolCalls, 0);
  assert.equal(card.trajectory.toolCalls, 1);
  assert.equal(card.trajectory.progressBearingActions, 0);
  assert.deepEqual(card.gaps, []);
  assert.match(card.cardHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(card).includes(root), false);
});

test("value CLI stays inconclusive when cost and human outcome are absent", () => {
  const { root, transcript, receipt } = fixture();
  const output = join(root, "inconclusive.json");
  assert.equal(run(["value", receipt, "--transcript", transcript, "--format", "json", "--output", output]), 2);
  const card = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(card.valueVerdict, "INCONCLUSIVE");
  assert.ok(card.gaps.includes("task cost is unavailable"));
  assert.ok(card.gaps.includes("maintainer disposition is unreviewed"));
  assert.ok(card.gaps.includes("downstream change outcome is unknown"));
});

test("value CLI stays inconclusive when unit-economics inputs are only self-asserted", () => {
  const { root, transcript, receipt } = fixture();
  const output = join(root, "self-asserted.json");
  assert.equal(run([
    "value", receipt, "--transcript", transcript,
    "--cost-usd", "1", "--cost-source", "user-estimated",
    "--disposition", "accepted", "--outcome", "merged",
    "--format", "json", "--output", output,
  ]), 2);
  const card = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(card.valueVerdict, "INCONCLUSIVE");
  assert.equal(card.cost.status, "SELF_ASSERTED");
  assert.equal(card.human.evidence, "SELF_ASSERTED");
  assert.equal(card.outcome.evidence, "SELF_ASSERTED");
});

test("value CLI reports a negative card for a reverted verified change", () => {
  const { root, transcript, receipt } = fixture();
  const output = join(root, "negative.json");
  assert.equal(run([
    "value", receipt, "--transcript", transcript,
    "--cost-usd", "0.50", "--cost-source", "subscription-allocated",
    "--disposition", "accepted", "--outcome", "reverted",
    "--format", "json", "--output", output,
  ]), 1);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).valueVerdict, "NEGATIVE");
});

test("value CLI refuses tampered receipts and mismatched transcripts", () => {
  const first = fixture();
  const tampered = JSON.parse(readFileSync(first.receipt, "utf8")) as TrustReport;
  tampered.summary.status = "FAIL";
  writeFileSync(first.receipt, JSON.stringify(tampered));
  assert.equal(run(["value", first.receipt, "--transcript", first.transcript]), 2);

  const second = fixture();
  writeFileSync(second.transcript, `${readFileSync(second.transcript, "utf8")}\n`);
  assert.equal(run(["value", second.receipt, "--transcript", second.transcript]), 2);
});

test("value CLI rejects ambiguous cost inputs and invalid enums", () => {
  const { root, receipt } = fixture();
  const arbitraryEvidence = join(root, "arbitrary-cost.txt");
  writeFileSync(arbitraryEvidence, "self-declared cost\n");
  assert.equal(run(["value", receipt, "--cost-usd", "1.00"]), 2);
  assert.equal(run(["value", receipt, "--cost-source", "provider-billed"]), 2);
  assert.equal(run(["value", receipt, "--cost-usd", "-1", "--cost-source", "provider-billed"]), 2);
  assert.equal(run([
    "value", receipt, "--cost-usd", "1", "--cost-source", "provider-exported", "--cost-evidence", arbitraryEvidence,
  ]), 2);
  assert.equal(run(["value", receipt, "--outcome", "amazing"]), 2);
  assert.equal(run(["value", receipt, "--unknown", "x"]), 2);
});

test("value CLI rejects orphan evidence, orphan through-date, and oversized evidence", () => {
  const { root, receipt } = fixture();
  const evidence = join(root, "evidence.json");
  writeFileSync(evidence, "{}\n");
  assert.equal(run(["value", receipt, "--outcome-as-of", "2026-08-22T12:00:00Z"]), 2);
  assert.equal(run(["value", receipt, "--outcome-evidence", evidence]), 2);
  assert.equal(run(["value", receipt, "--review-evidence", evidence]), 2);

  const oversized = join(root, "oversized.bin");
  writeFileSync(oversized, "");
  truncateSync(oversized, 64 * 1024 * 1024 + 1);
  assert.equal(run([
    "value", receipt, "--cost-usd", "1", "--cost-source", "provider-billed",
    "--cost-evidence", oversized,
  ]), 2);
});

test("value CLI auto-discovers its receipt-relative transcript and applies the platform permission contract", () => {
  const { root, receipt } = fixture();
  const output = join(root, "auto.json");
  assert.equal(run(["value", receipt, "--format", "json", "--output", output]), 2);
  const card = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(card.usage.totalTokens, 258);
  if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
});

test("value CLI fails closed on malformed and unsupported receipt documents", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-value-invalid-"));
  const malformed = join(root, "malformed.json");
  const unsupported = join(root, "unsupported.json");
  writeFileSync(malformed, "{");
  writeFileSync(unsupported, '{"schemaVersion":"1"}\n');
  assert.equal(run(["value", malformed]), 2);
  assert.equal(run(["value", unsupported]), 2);
});

test("HTML value card escapes model identity and records no unescaped executable markup", () => {
  const { report, loaded } = fixture();
  const usage = { ...loaded.usage!, modelIds: ["<script>alert(1)</script>"] };
  const card = buildValueCard({
    report,
    hashValid: true,
    usage,
    values: { costUsd: 1, costSource: "user-estimated", disposition: "accepted", outcome: "merged" },
  });
  const rendered = renderValueCardHtml(card);
  assert.doesNotMatch(rendered, /<script>alert\(1\)<\/script>/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(rendered.includes("github.com/sulmusic2-star/agent-vigil"));
});

test("card identity excludes render time but covers evidence fields", () => {
  const { report, loaded } = fixture();
  const card = buildValueCard({ report, hashValid: true, usage: loaded.usage, values: {} });
  const later = structuredClone(card);
  later.generatedAt = "2099-01-01T00:00:00.000Z";
  assert.equal(recomputeValueCardHash(later), card.cardHash);
  later.outcome.state = "merged";
  assert.notEqual(recomputeValueCardHash(later), card.cardHash);
});

test("receipt hash recomputation rejects an inconsistent fixture summary", () => {
  const { report } = fixture();
  const changed = structuredClone(report);
  changed.summary.status = "FAIL";
  assert.throws(() => recomputeReceiptHash(changed), /summary\.status does not match results and policy/);
});
