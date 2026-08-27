import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const receipt = `sha256:${"a".repeat(64)}`;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    repository: "outside/project",
    ownerConsentUrl: "https://github.com/outside/project/issues/7",
    workflowUrl: "https://github.com/outside/project/blob/main/.github/workflows/vigil.yml",
    latestRunUrl: "https://github.com/outside/project/actions/runs/123",
    firstObservedAt: "2026-01-01T00:00:00Z",
    lastObservedAt: "2026-02-15T00:00:00Z",
    currentWorkflowConfigured: true,
    verdictsObserved: 200,
    receiptHashes: [receipt],
    requiredCheckEvidenceUrl: "https://github.com/outside/project/issues/8",
    retentionEvidenceUrl: "https://github.com/outside/project/issues/9",
    maintainerAcceptedContradictions: [{
      receiptHash: receipt,
      evidenceUrl: "https://github.com/outside/project/issues/10",
      disposition: "fixed-change",
      acceptedAt: "2026-02-01T00:00:00Z",
    }],
    falseVerdictReports: [{
      evidenceUrl: "https://github.com/outside/project/issues/11",
      status: "still-open",
      reportedAt: "2026-02-10T00:00:00Z",
      resolvedAt: null,
    }],
    ...overrides,
  };
}

function runLedger(entries: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "vigil-adoption-evidence-"));
  const ledger = join(dir, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, entries }));
  return JSON.parse(execFileSync("python3", ["scripts/adoption_evidence.py", "--ledger", ledger], {
    cwd: process.cwd(),
    encoding: "utf8",
  }));
}

test("consented evidence keeps retention, required checks, receipts, and contradictions separate", () => {
  const result = runLedger([entry()]);
  assert.equal(result.counts.externalRepositoriesConfigured, 1);
  assert.equal(result.counts.uniqueExternalReceiptHashes, 1);
  assert.equal(result.counts.maintainersRetainedAfter30Days, 1);
  assert.equal(result.counts.maintainerAcceptedContradictions, 1);
  assert.equal(result.counts.externalRequiredChecks, 1);
  assert.equal(result.counts.externalVerdictsObserved, 200);
  assert.equal(result.counts.unexplainedFalseVerdictReports, 1);
  assert.equal(result.counts.unexplainedFalseVerdictRate, 0.005);
  assert.equal(result.gates.underOnePercentUnexplainedFalseVerdicts, true);
  assert.equal(result.milestonePassed, false);
});

test("first-party repositories cannot enter the external evidence ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-adoption-evidence-"));
  const ledger = join(dir, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, entries: [entry({
    repository: "sulmusic2-star/agent-vigil",
    ownerConsentUrl: "https://github.com/sulmusic2-star/agent-vigil/issues/24",
    workflowUrl: "https://github.com/sulmusic2-star/agent-vigil/blob/main/.github/workflows/agent-vigil.yml",
    latestRunUrl: "https://github.com/sulmusic2-star/agent-vigil/actions/runs/123",
  })] }));
  const result = spawnSync("python3", ["scripts/adoption_evidence.py", "--ledger", ledger], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /first-party/);
});

test("retention evidence cannot count before 30 days", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-adoption-evidence-"));
  const ledger = join(dir, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, entries: [entry({ lastObservedAt: "2026-01-20T00:00:00Z" })] }));
  const result = spawnSync("python3", ["scripts/adoption_evidence.py", "--ledger", ledger], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /less than 30 days/);
});

test("unknown fields and duplicate receipt hashes fail closed", () => {
  const first = entry({ unexpected: true });
  const unknown = (() => {
    const dir = mkdtempSync(join(tmpdir(), "vigil-adoption-evidence-"));
    const ledger = join(dir, "ledger.json");
    writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, entries: [first] }));
    return spawnSync("python3", ["scripts/adoption_evidence.py", "--ledger", ledger], { cwd: process.cwd(), encoding: "utf8" });
  })();
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown fields/);

  const secondReceipt = `sha256:${"b".repeat(64)}`;
  const duplicate = entry({
    repository: "another/project",
    ownerConsentUrl: "https://github.com/another/project/issues/7",
    workflowUrl: "https://github.com/another/project/blob/main/.github/workflows/vigil.yml",
    latestRunUrl: "https://github.com/another/project/actions/runs/123",
    receiptHashes: [receipt, secondReceipt],
    maintainerAcceptedContradictions: [],
    falseVerdictReports: [],
  });
  assert.throws(() => runLedger([entry(), duplicate]), /duplicate receipt hash/);
});
