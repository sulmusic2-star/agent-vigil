import assert from "node:assert/strict";
import test from "node:test";
import { buildReport, recomputeReceiptHash, type CheckResult } from "../src/report.ts";
import { compareReceipts } from "../src/receipt-diff.ts";

const verified = (ruleId: string, subject = ruleId, contributesToPass = true): CheckResult => ({
  claim: { kind: "integrity", quote: "check", subject },
  verdict: "verified",
  evidence: "ok",
  ruleId,
  contributesToPass,
});

function report(results: CheckResult[], head: string, overrides: { base?: string; policy?: { minVerified: number; strict: boolean; sha256: string }; advisories?: CheckResult[] } = {}) {
  return buildReport({
    transcript: "evidence.md",
    transcriptFormat: "markdown",
    repo: "repo",
    base: overrides.base ?? "base",
    head,
    results,
    advisories: overrides.advisories,
    policy: overrides.policy ?? { minVerified: 1, strict: true, sha256: "sha256:policy" },
  });
}

test("receipt delta passes a same-policy revision that preserves invariants", () => {
  const before = report([verified("workspace-bound", "workspace", false), verified("tests-pass")], "head-1");
  const after = report([verified("workspace-bound", "workspace", false), verified("tests-pass"), verified("new-proof")], "head-2");
  const delta = compareReceipts(before, after);
  assert.equal(delta.status, "PASS");
  assert.equal(delta.regressions.length, 0);
  assert.ok(delta.improvements.some((row) => row.ruleId === "new-proof"));
  assert.equal(delta.range.relationship, "same-base");
});

test("receipt delta fails on a disappeared invariant and new contradiction", () => {
  const before = report([verified("workspace-bound", "workspace", false), verified("tests-pass")], "head-1");
  const after = report([{
    ...verified("tests-pass"), verdict: "contradicted", evidence: "runner failed",
  }], "head-2");
  const delta = compareReceipts(before, after);
  assert.equal(delta.status, "FAIL");
  assert.ok(delta.regressions.some((row) => row.reason.includes("disappeared")));
  assert.ok(delta.regressions.some((row) => row.ruleId === "tests-pass"));
});

test("receipt delta fails closed on tampering and weaker policy", () => {
  const before = report([verified("tests-pass")], "head-1", { policy: { minVerified: 2, strict: true, sha256: "sha256:strong" } });
  const after = report([verified("tests-pass")], "head-2", { policy: { minVerified: 1, strict: false, sha256: "sha256:weak" } });
  after.results[0].evidence = "tampered";
  const delta = compareReceipts(before, after);
  assert.equal(delta.status, "FAIL");
  assert.equal(delta.after.hashValid, false);
  assert.equal(delta.policy.weakened.length, 2);
});

test("receipt delta rejects a rehashed receipt with forged summary counts", () => {
  const before = report([verified("tests-pass")], "head-1");
  const after = report([verified("tests-pass")], "head-2");
  after.summary.status = "FAIL";
  after.summary.pass = false;
  after.receiptHash = recomputeReceiptHash(after);
  const delta = compareReceipts(before, after);
  assert.equal(delta.after.hashValid, true);
  assert.equal(delta.after.internallyConsistent, false);
  assert.equal(delta.status, "FAIL");
  assert.ok(delta.regressions.some((row) => row.ruleId === "receipt-consistency"));
});

test("receipt delta is inconclusive across unrelated ranges or changed policies without regression", () => {
  const before = report([verified("tests-pass")], "head-1");
  const after = report([verified("tests-pass")], "other-head", { base: "other-base", policy: { minVerified: 1, strict: true, sha256: "sha256:other" } });
  const delta = compareReceipts(before, after);
  assert.equal(delta.status, "INCONCLUSIVE");
  assert.equal(delta.range.relationship, "unrelated");
});

test("receipt delta tracks advisory additions without silently converting them to blockers", () => {
  const advisory = { ...verified("assertion-drop", "assertion surface", false), verdict: "contradicted" as const };
  const before = report([verified("tests-pass"), verified("integrity-scan", "clean integrity scan", false)], "head-1");
  const after = report([verified("tests-pass")], "head-2", { advisories: [advisory] });
  const delta = compareReceipts(before, after);
  assert.equal(delta.status, "PASS");
  assert.equal(delta.newAdvisories.length, 1);
});
