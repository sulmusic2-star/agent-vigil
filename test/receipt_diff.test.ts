import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReport, recomputeReceiptHash, type CheckResult } from "../src/report.ts";
import { compareReceipts, renderReceiptDelta } from "../src/receipt-diff.ts";
import { generateSigningKey, signReport } from "../src/signature.ts";

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

const unresolved = (ruleId: string, blocksPass = true): CheckResult => ({
  ...verified(ruleId), verdict: "unverifiable", blocksPass,
});

const contradicted = (ruleId: string): CheckResult => ({
  ...verified(ruleId), verdict: "contradicted",
});

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

test("receipt consistency independently binds every summary count, status, pass flag, and policy floor", () => {
  const before = report([verified("tests-pass")], "head-1");
  const mutations: Array<(value: ReturnType<typeof report>) => void> = [
    (value) => { value.summary.verified += 1; },
    (value) => { value.summary.contradicted += 1; },
    (value) => { value.summary.unverifiable += 1; },
    (value) => { value.summary.meaningfulVerified += 1; },
    (value) => { value.summary.status = "FAIL"; },
    (value) => { value.summary.pass = false; },
    (value) => { value.policy.minVerified = 0; },
  ];
  for (const mutate of mutations) {
    const after = report([verified("tests-pass")], "head-2");
    mutate(after);
    after.receiptHash = recomputeReceiptHash(after);
    const delta = compareReceipts(before, after);
    assert.equal(delta.status, "FAIL");
    assert.ok(delta.regressions.some((row) => row.ruleId === "receipt-consistency"));
  }
});

test("receipt delta records weakened, improved, new, missing, and advisory-resolved checks", () => {
  const oldAdvisory = contradicted("old-advisory");
  const before = report([
    verified("same"),
    verified("weakened"),
    unresolved("improved"),
    verified("missing-invariant", "missing", false),
    verified("ordinary-missing"),
  ], "head-1", { advisories: [oldAdvisory] });
  const after = report([
    verified("same"),
    unresolved("weakened"),
    verified("improved"),
    contradicted("new-contradiction"),
    unresolved("new-gap"),
    verified("new-proof"),
  ], "head-2");
  const delta = compareReceipts(before, after);
  assert.equal(delta.status, "FAIL");
  assert.equal(delta.unchangedChecks, 1);
  assert.ok(delta.regressions.some((row) => row.reason === "check verdict weakened"));
  assert.ok(delta.regressions.some((row) => row.reason === "new contradiction"));
  assert.ok(delta.regressions.some((row) => row.reason === "new blocking evidence gap"));
  assert.ok(delta.regressions.some((row) => row.reason === "previously verified invariant check disappeared"));
  assert.ok(delta.improvements.some((row) => row.reason === "check verdict improved"));
  assert.ok(delta.improvements.some((row) => row.reason === "new verified check"));
  assert.equal(delta.resolvedAdvisories.length, 1);
  const rendered = renderReceiptDelta(delta);
  assert.match(rendered, /✗ \[weakened\]/);
  assert.match(rendered, /✓ \[improved\]/);
  assert.match(rendered, /receipt delta: FAIL/);
});

test("an integrity scan converted to retained advisories is not reported as vanished", () => {
  const before = report([verified("integrity-scan", "clean scan", false), verified("tests-pass")], "head-1");
  const after = report([verified("tests-pass")], "head-2", { advisories: [contradicted("assertion-drop")] });
  const delta = compareReceipts(before, after);
  assert.equal(delta.status, "PASS");
  assert.equal(delta.regressions.length, 0);
  assert.equal(delta.newAdvisories.length, 1);
  assert.match(renderReceiptDelta(delta), /! \[assertion-drop\]/);
});

test("range and repository identity distinguish chained work from unrelated or remote-swapped work", () => {
  const chainedBefore = report([verified("tests-pass")], "middle", { base: "base" });
  chainedBefore.repository.remote = "git@example.test/one.git";
  chainedBefore.receiptHash = recomputeReceiptHash(chainedBefore);
  const chainedAfter = report([verified("tests-pass")], "head", { base: "middle" });
  chainedAfter.repository.remote = "git@example.test/two.git";
  chainedAfter.receiptHash = recomputeReceiptHash(chainedAfter);
  const chained = compareReceipts(chainedBefore, chainedAfter);
  assert.equal(chained.range.relationship, "chained");
  assert.equal(chained.range.related, true);
  assert.ok(chained.notes.includes("Repository remotes differ."));

  const unrelated = compareReceipts(chainedBefore, report([verified("tests-pass")], "other", { base: "other-base" }));
  assert.equal(unrelated.status, "INCONCLUSIVE");
  assert.match(unrelated.notes.join("\n"), /neither same-base/);
});

test("signer continuity distinguishes added, stable, removed, changed, and invalid signatures", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-receipt-signers-"));
  const firstPrivate = join(root, "first-private.pem");
  const firstPublic = join(root, "first-public.pem");
  const secondPrivate = join(root, "second-private.pem");
  const secondPublic = join(root, "second-public.pem");
  generateSigningKey(firstPrivate, firstPublic);
  generateSigningKey(secondPrivate, secondPublic);
  const unsignedBefore = report([verified("tests-pass")], "head-1");
  const unsignedAfter = report([verified("tests-pass")], "head-2");
  const signedBefore = signReport(structuredClone(unsignedBefore), firstPrivate);
  const signedAfter = signReport(structuredClone(unsignedAfter), firstPrivate);
  const otherSignedAfter = signReport(structuredClone(unsignedAfter), secondPrivate);

  assert.equal(compareReceipts(unsignedBefore, signedAfter).signer.continuity, "added");
  assert.equal(compareReceipts(signedBefore, signedAfter).signer.continuity, "same");
  const removed = compareReceipts(signedBefore, unsignedAfter);
  assert.equal(removed.signer.continuity, "removed");
  assert.equal(removed.status, "FAIL");
  const changed = compareReceipts(signedBefore, otherSignedAfter);
  assert.equal(changed.signer.continuity, "changed");
  assert.equal(changed.status, "INCONCLUSIVE");
  assert.match(changed.notes.join("\n"), /Signer key changed/);

  const invalid = structuredClone(signedAfter);
  invalid.signature!.value = Buffer.alloc(64).toString("base64");
  const invalidDelta = compareReceipts(unsignedBefore, invalid);
  assert.equal(invalidDelta.after.signature, "invalid");
  assert.ok(invalidDelta.regressions.some((row) => row.ruleId === "receipt-signature"));
});
