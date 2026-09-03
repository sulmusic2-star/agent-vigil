import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCursorExactCostEvidence, validateExactCostEvidence } from "../src/cost-evidence.ts";
import { run } from "../src/cli.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { loadTranscript } from "../src/transcript.ts";

const SESSION = "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b";

function transcript(session = SESSION): Buffer {
  const row = (value: Record<string, unknown>, timestamp_ms: number) => ({ ...value, conversationId: session, timestamp_ms });
  return Buffer.from([
    JSON.stringify(row({ type: "system" }, 1788183000000)),
    JSON.stringify(row({ type: "assistant", message: { content: "Tests pass." } }, 1788184200000)),
    JSON.stringify(row({ type: "tool_call", subtype: "started", call_id: "one", tool_call: { shellToolCall: { args: { command: "npm test" } } } }, 1788184800000)),
    JSON.stringify(row({ type: "tool_call", subtype: "completed", call_id: "one", tool_call: { shellToolCall: { result: "ok" } } }, 1788184860000)),
    JSON.stringify(row({ type: "result", subtype: "success", result: "Tests pass." }, 1788186000000)),
  ].join("\n") + "\n");
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "1788184800000",
    conversationId: SESSION,
    model: "claude-test",
    kind: "Usage-based",
    isChargeable: true,
    chargedCents: 21.36232,
    ...overrides,
  };
}

function usageExport(events = [event(), event({ timestamp: "1788184860000", chargedCents: 37.33 })]): Buffer {
  return Buffer.from(JSON.stringify({
    totalUsageEventsCount: events.length,
    pagination: { numPages: 1, currentPage: 1, pageSize: Math.max(events.length, 1), hasNextPage: false, hasPreviousPage: false },
    usageEvents: events,
    period: { startDate: 1788181200000, endDate: 1788188400000 },
  }));
}

function passResult(): CheckResult {
  return {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict: "verified",
    evidence: "fresh suite exited zero",
    ruleId: "tests-pass",
  };
}

test("Cursor exact cost evidence binds one transcript conversation and sums only billed events", () => {
  const evidence = buildCursorExactCostEvidence({
    transcript: transcript(),
    usageExport: usageExport([
      event(),
      event({ timestamp: "1788184860000", chargedCents: 37.33 }),
      event({ timestamp: "1788184920000", isChargeable: false, chargedCents: 8 }),
      event({ timestamp: "1788184980000", conversationId: "another-session", chargedCents: 999 }),
      event({ timestamp: "1788185040000", conversationId: undefined, chargedCents: 999 }),
    ]),
  });
  assert.equal(evidence.recordsObserved, 3);
  assert.equal(evidence.chargeableRecords, 2);
  assert.equal(evidence.amountUsd, 0.5869232);
  assert.equal(evidence.exportPeriodStartedAt, "2026-08-31T13:00:00.000Z");
  assert.equal(evidence.exportPeriodEndedAt, "2026-08-31T15:00:00.000Z");
  assert.equal(evidence.startedAt, "2026-08-31T14:00:00.000Z");
  assert.equal(evidence.endedAt, "2026-08-31T14:02:00.000Z");
  assert.equal(validateExactCostEvidence(evidence).evidenceHash, evidence.evidenceHash);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(SESSION));
});

test("exact cost import refuses ambiguous, unbound, duplicate, and malformed billing evidence", () => {
  assert.throws(() => buildCursorExactCostEvidence({
    transcript: Buffer.from([
      JSON.stringify({ type: "system", conversationId: SESSION, timestamp_ms: 1788183000000 }),
      JSON.stringify({ type: "result", conversationId: "another-session", timestamp_ms: 1788186000000 }),
    ].join("\n")),
    usageExport: usageExport([event(), event({ conversationId: "another-session", timestamp: "1788184860000" })]),
  }), /more than one session/);
  assert.throws(() => buildCursorExactCostEvidence({ transcript: transcript("missing-session"), usageExport: usageExport() }), /no conversationId bound/);
  assert.throws(() => buildCursorExactCostEvidence({
    transcript: Buffer.from(`${JSON.stringify({ type: "assistant", message: { content: `the unrelated ID is ${SESSION}` } })}\n`),
    usageExport: usageExport(),
  }), /start with a system initialization/, "a narrative mention must not bind provider cost");
  assert.throws(() => buildCursorExactCostEvidence({
    transcript: Buffer.from(`${JSON.stringify({
      type: "tool_call",
      tool_call: { shellToolCall: { args: { conversationId: SESSION } } },
    })}\n`),
    usageExport: usageExport(),
  }), /start with a system initialization/, "a nested tool argument must not bind provider cost");
  assert.throws(() => buildCursorExactCostEvidence({
    transcript: Buffer.from(`${JSON.stringify({ type: "assistant", conversationId: SESSION, timestamp_ms: 1788183000000 })}\n`),
    usageExport: usageExport(),
  }), /start with a system initialization/, "a non-system root record must not bind provider cost");
  const narrow = JSON.parse(usageExport().toString("utf8"));
  narrow.period.endDate = 1788185400000;
  assert.throws(
    () => buildCursorExactCostEvidence({ transcript: transcript(), usageExport: Buffer.from(JSON.stringify(narrow)) }),
    /does not cover the complete transcript session/,
  );
  const lateStart = JSON.parse(usageExport().toString("utf8"));
  lateStart.period.startDate = 1788183600000;
  assert.throws(
    () => buildCursorExactCostEvidence({ transcript: transcript(), usageExport: Buffer.from(JSON.stringify(lateStart)) }),
    /does not cover the complete transcript session/,
  );
  const untimed = transcript().toString("utf8").split("\n").filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    delete row.timestamp_ms;
    return JSON.stringify(row);
  }).join("\n");
  assert.throws(
    () => buildCursorExactCostEvidence({ transcript: Buffer.from(untimed), usageExport: usageExport() }),
    /cannot prove its complete session period/,
  );
  const truncated = transcript().toString("utf8").split("\n").filter(Boolean).slice(0, -1).join("\n");
  assert.throws(
    () => buildCursorExactCostEvidence({ transcript: Buffer.from(truncated), usageExport: usageExport() }),
    /end with a terminal result record/,
  );
  const duplicate = event();
  assert.throws(() => buildCursorExactCostEvidence({ transcript: transcript(), usageExport: usageExport([duplicate, duplicate]) }), /duplicate events/);
  assert.throws(() => buildCursorExactCostEvidence({ transcript: transcript(), usageExport: usageExport([event({ isChargeable: "yes" })]) }), /isChargeable must be explicit/);
  for (const invalidTimestamp of [1788184800000, "2026-08-31T14:00:00.000Z", "not-a-timestamp", null, true, false, {}, []]) {
    assert.throws(
      () => buildCursorExactCostEvidence({ transcript: transcript(), usageExport: usageExport([event({ timestamp: invalidTimestamp })]) }),
      /timestamp is invalid/,
    );
  }
  for (const invalidTimestamp of ["1788181200000", "2026-08-31T13:00:00.000Z", "not-a-timestamp", null, true, false, {}, []]) {
    const invalidPeriod = JSON.parse(usageExport().toString("utf8"));
    invalidPeriod.period.startDate = invalidTimestamp;
    assert.throws(
      () => buildCursorExactCostEvidence({ transcript: transcript(), usageExport: Buffer.from(JSON.stringify(invalidPeriod)) }),
      /timestamp is invalid/,
    );
  }
  assert.throws(() => buildCursorExactCostEvidence({
    transcript: transcript(),
    usageExport: usageExport([
      event({ chargedCents: 60_000_000 }),
      event({ timestamp: "1788184860000", chargedCents: 60_000_000 }),
    ]),
  }), /total exceeds the \$1000000 session limit/);
  const incomplete = JSON.parse(usageExport().toString("utf8"));
  incomplete.totalUsageEventsCount += 1;
  incomplete.pagination.hasNextPage = true;
  assert.throws(() => buildCursorExactCostEvidence({ transcript: transcript(), usageExport: Buffer.from(JSON.stringify(incomplete)) }), /incomplete/);
  const evidence = buildCursorExactCostEvidence({ transcript: transcript(), usageExport: usageExport() });
  assert.throws(() => validateExactCostEvidence({ ...evidence, amountUsd: 0 }), /hash is invalid/);
  const empty = { ...evidence, recordsObserved: 0, chargeableRecords: 0 };
  assert.throws(() => validateExactCostEvidence({ ...empty, evidenceHash: evidence.evidenceHash }), /at least one observed record/);
  const excessive = { ...evidence, amountUsd: 1_000_001 };
  assert.throws(() => validateExactCostEvidence({ ...excessive, evidenceHash: evidence.evidenceHash }), /amountUsd is invalid/);
});

test("cost-evidence CLI feeds a provider-exported amount into an exact change Value Card", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-cost-evidence-"));
  const transcriptPath = join(root, "cursor.jsonl");
  const usagePath = join(root, "cursor-usage.json");
  const costPath = join(root, "cost.json");
  const receiptPath = join(root, "receipt.json");
  const cardPath = join(root, "card.json");
  const reviewPath = join(root, "review.json");
  const outcomePath = join(root, "merge.json");
  writeFileSync(transcriptPath, transcript());
  writeFileSync(usagePath, usageExport());
  writeFileSync(reviewPath, "{}\n");
  writeFileSync(outcomePath, "{}\n");
  const loaded = loadTranscript(transcriptPath);
  const report = buildReport({
    transcript: "cursor.jsonl",
    transcriptSha256: loaded.transcriptSha256,
    transcriptFormat: loaded.format,
    repo: root,
    base: "a".repeat(40),
    head: "b".repeat(40),
    results: [passResult()],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"c".repeat(64)}` },
  });
  writeFileSync(receiptPath, JSON.stringify(report));

  assert.equal(run(["cost-evidence", "cursor", "--transcript", transcriptPath, "--usage-export", usagePath, "--output", costPath]), 0);
  assert.equal(run(["cost-evidence", "cursor", "--transcript", transcriptPath, "--transcript", transcriptPath, "--usage-export", usagePath]), 2);
  assert.equal(run(["cost-evidence", "cursor", "--transcript", transcriptPath, "--usage-export", usagePath, "--output", usagePath]), 2);
  assert.equal(run([
    "value", receiptPath,
    "--transcript", transcriptPath,
    "--cost-evidence", costPath,
    "--disposition", "accepted", "--review-evidence", reviewPath,
    "--outcome", "merged", "--outcome-evidence", outcomePath,
    "--format", "json", "--output", cardPath,
  ]), 0);
  const card = JSON.parse(readFileSync(cardPath, "utf8"));
  assert.equal(card.cost.status, "EVIDENCE_HASHED");
  assert.equal(card.cost.source, "provider-exported");
  assert.equal(card.cost.amountUsd, 0.5869232);
  assert.equal(card.metrics.costPerAcceptedChangeUsd, 0.5869232);
  assert.equal(card.valueVerdict, "POSITIVE");

  assert.equal(run([
    "value", receiptPath, "--transcript", transcriptPath, "--cost-evidence", costPath,
    "--cost-usd", "99", "--format", "json", "--output", join(root, "bad.json"),
  ]), 2);
});
