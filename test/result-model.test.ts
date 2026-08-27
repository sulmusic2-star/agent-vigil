import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessOutcome, createOutcomeMandate } from "../src/outcome.ts";
import { remediationFor } from "../src/remediation.ts";
import { buildReport, recomputeReceiptHash } from "../src/report.ts";
import {
  buildOutcomeResultView,
  buildReportResultView,
  readChangedFileManifest,
  renderResultViewHtml,
} from "../src/result-view.ts";
import { generateSigningKey, publicKeyId } from "../src/signature.ts";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const POLICY_SHA = `sha256:${"c".repeat(64)}`;
const TRANSCRIPT_SHA = `sha256:${"d".repeat(64)}`;

function report(verdict: "PASS" | "FAIL" | "INCONCLUSIVE") {
  const result = verdict === "PASS"
    ? { claim: { kind: "tests_pass" as const, subject: "tests passed", quote: "tests passed" }, verdict: "verified" as const, evidence: "observed 12 tests", ruleId: "tests-pass" }
    : verdict === "FAIL"
      ? { claim: { kind: "tests_pass" as const, subject: "tests failed", quote: "tests passed" }, verdict: "contradicted" as const, evidence: "test/a.test.ts:12 failed", ruleId: "tests-pass" }
      : { claim: { kind: "command_ran" as const, subject: "build command", quote: "build ran" }, verdict: "unverifiable" as const, evidence: "no terminal result", ruleId: "command-ran", blocksPass: true };
  return buildReport({
    transcript: "fixture.jsonl",
    transcriptSha256: TRANSCRIPT_SHA,
    transcriptFormat: "markdown",
    repo: ".",
    base: OID_A,
    head: OID_B,
    results: [result],
    policy: { strict: false, minVerified: 1, sha256: POLICY_SHA },
    reproduction: `vigil verify --base ${OID_A} --head ${OID_B}`,
  });
}

function outcomeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "vigil-result-outcome-"));
  const requesterPrivate = join(directory, "requester.pem");
  const requesterPublic = join(directory, "requester.pub.pem");
  const verifierPrivate = join(directory, "verifier.pem");
  const verifierPublic = join(directory, "verifier.pub.pem");
  const otherPrivate = join(directory, "other.pem");
  const otherPublic = join(directory, "other.pub.pem");
  generateSigningKey(requesterPrivate, requesterPublic);
  generateSigningKey(verifierPrivate, verifierPublic);
  generateSigningKey(otherPrivate, otherPublic);
  const mandate = createOutcomeMandate({
    createdAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-28T00:00:00.000Z",
    requesterId: "result-view/requester",
    providerId: "result-view/provider",
    taskId: "result-view-task",
    taskClass: "code-change",
    description: "Render only a closed and trusted outcome receipt",
    base: OID_A,
    head: OID_B,
    verifierKeyIds: [publicKeyId(verifierPublic)],
  }, requesterPrivate);
  const receipt = assessOutcome(mandate, report("PASS"), verifierPrivate, {
    requesterPublicKeyPath: requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  return { receipt, verifierPublic, otherPublic };
}

test("missing required evidence cannot display PASS", () => {
  const input = report("INCONCLUSIVE");
  input.summary.status = "PASS";
  input.summary.pass = true;
  assert.throws(() => buildReportResultView(input), /summary|content does not match its hash/);
});

test("a changed result and matching changed summary cannot reuse the old receipt hash", () => {
  const input = report("FAIL");
  input.results[0].verdict = "verified";
  input.summary = { verified: 1, contradicted: 0, unverifiable: 0, meaningfulVerified: 1, status: "PASS", pass: true };
  assert.throws(() => buildReportResultView(input), /content does not match its hash/);
});

test("result views reject unknown fields and detach all rendered content", () => {
  const input = report("PASS");
  assert.throws(
    () => buildReportResultView({ ...input, unsupported: true }),
    /unsupported or missing fields/,
  );
  const view = buildReportResultView(input);
  const title = view.findings[0].title;
  input.results[0].claim.subject = "mutated after validation";
  input.repository.remote = "mutated after validation";
  assert.equal(view.findings[0].title, title);
  assert.doesNotMatch(JSON.stringify(view), /mutated after validation/);
});

test("default rendering performs no Git query and symbolic report refs remain compatible", () => {
  const input = report("PASS");
  input.repo = "/candidate-controlled/nonexistent/repository";
  input.base = "HEAD~1";
  input.head = "WORKTREE";
  input.receiptHash = recomputeReceiptHash(input);
  const previous = process.env.AGENT_VIGIL_INTERNAL_GIT_BIN;
  process.env.AGENT_VIGIL_INTERNAL_GIT_BIN = "candidate-relative-git";
  try {
    const view = buildReportResultView(input);
    assert.equal(view.base, "HEAD~1");
    assert.equal(view.head, "WORKTREE");
    assert.equal(view.changedFiles.complete, false);
    assert.match(view.changedFiles.evidence, /not requested/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_VIGIL_INTERNAL_GIT_BIN;
    else process.env.AGENT_VIGIL_INTERNAL_GIT_BIN = previous;
  }
});

test("changed-file collection accepts only exact 40- or 64-character object IDs", () => {
  for (const length of [41, 63]) {
    const manifest = readChangedFileManifest(".", "a".repeat(length), OID_B);
    assert.equal(manifest.complete, false);
    assert.match(manifest.evidence, /Exact base and head Git object IDs/);
  }
  const sha256Report = report("PASS");
  sha256Report.base = "a".repeat(64);
  sha256Report.head = "b".repeat(64);
  sha256Report.receiptHash = recomputeReceiptHash(sha256Report);
  assert.equal(buildReportResultView(sha256Report).base.length, 64);
});

test("outcome views require closed, hash-valid, signed, and pinned receipts", () => {
  const { receipt, verifierPublic, otherPublic } = outcomeFixture();
  const trusted = { trust: { verifierPublicKeyPath: verifierPublic } };
  const view = buildOutcomeResultView(receipt, trusted);
  const originalEvidence = view.findings[0].evidence;
  receipt.checks[0].evidence = "mutated after rendering";
  assert.equal(view.findings[0].evidence, originalEvidence);

  const fresh = outcomeFixture();
  const unsupported = { ...structuredClone(fresh.receipt), unsupported: true };
  assert.throws(() => buildOutcomeResultView(unsupported, { trust: { verifierPublicKeyPath: fresh.verifierPublic } }), /unsupported field/);

  const stale = structuredClone(fresh.receipt);
  stale.checks[0].evidence = "changed without recomputing the signed hash";
  assert.throws(() => buildOutcomeResultView(stale, { trust: { verifierPublicKeyPath: fresh.verifierPublic } }), /hash|invalid or untrusted/);

  const badSignature = structuredClone(fresh.receipt);
  badSignature.signature.value = "AAAA";
  assert.throws(() => buildOutcomeResultView(badSignature, { trust: { verifierPublicKeyPath: fresh.verifierPublic } }), /signature|invalid or untrusted/);
  assert.throws(() => buildOutcomeResultView(fresh.receipt, { trust: {} }), /trust|pinned/i);
  assert.throws(() => buildOutcomeResultView(fresh.receipt, { trust: { verifierPublicKeyPath: otherPublic } }), /signature|invalid or untrusted/);
  assert.equal(
    buildOutcomeResultView(fresh.receipt, { trust: { trustedKeyIds: [publicKeyId(fresh.verifierPublic)] } }).verdict,
    fresh.receipt.verdict,
  );

  const inexactOid = structuredClone(fresh.receipt);
  inexactOid.sourceEvidence.base = "a".repeat(41);
  assert.throws(() => buildOutcomeResultView(inexactOid, { trust: { verifierPublicKeyPath: fresh.verifierPublic } }), /40|64|object ID/);
});

test("claimed and observed test counts stay distinct and hostile text is neutralized", () => {
  const longPath = `${"nested/".repeat(40)}test\u001b[31m\u202e.ts:321`;
  const input = buildReport({
    transcript: "fixture.jsonl",
    transcriptSha256: TRANSCRIPT_SHA,
    transcriptFormat: "markdown",
    repo: ".",
    base: OID_A,
    head: OID_B,
    results: [{
      claim: { kind: "tests_pass", subject: `<script>alert(1)</script> count at ${longPath}`, quote: "184 tests passed", expectedCount: 184 },
      verdict: "contradicted",
      evidence: `isolated runner observed 161 tests at ${longPath}\rspoofed`,
      ruleId: "test-count",
    }],
    policy: { strict: true, sha256: POLICY_SHA },
  });
  const view = buildReportResultView(input);
  assert.equal(view.findings[0].claimedTestCount, 184);
  assert.equal(view.findings[0].observedTestCount, 161);
  assert.equal(view.findings[0].location?.line, 321);
  const web = renderResultViewHtml(view);
  assert.doesNotMatch(web, /\u001b|\u202e|\r/);
  assert.doesNotMatch(web, /<script>alert\(1\)<\/script>/);
});

test("normal detector mismatch evidence retains the observed test count", () => {
  const input = buildReport({
    transcript: "fixture.jsonl",
    transcriptSha256: TRANSCRIPT_SHA,
    transcriptFormat: "markdown",
    repo: ".",
    base: OID_A,
    head: OID_B,
    results: [{
      claim: { kind: "tests_pass", subject: "184 tests passed", quote: "184 tests passed", expectedCount: 184 },
      verdict: "contradicted",
      evidence: "runner reported 161 passed",
      ruleId: "test-count",
    }],
    policy: { strict: true, sha256: POLICY_SHA },
  });
  assert.equal(buildReportResultView(input).findings[0].observedTestCount, 161);
});

test("an unmet minimum-evidence gate is shown as not checked", () => {
  const input = buildReport({
    transcript: "fixture.jsonl",
    transcriptSha256: TRANSCRIPT_SHA,
    transcriptFormat: "markdown",
    repo: ".",
    base: OID_A,
    head: OID_B,
    results: [{
      claim: { kind: "integrity", subject: "workspace bound", quote: "workspace bound" },
      verdict: "verified",
      evidence: "head matched",
      ruleId: "workspace-bound",
      contributesToPass: false,
    }],
    policy: { strict: false, minVerified: 1, sha256: POLICY_SHA },
  });
  const view = buildReportResultView(input);
  assert.equal(view.verdict, "INCONCLUSIVE");
  assert.equal(view.counts.notChecked, 1);
  assert.ok(view.findings.some((finding) => finding.id === "completion-evidence" && finding.state === "NOT_CHECKED"));
});

test("advisory findings remain visible in the HTML view", () => {
  const input = report("PASS");
  input.advisories = [{
    claim: { kind: "integrity", subject: "new skip marker", quote: "skip" },
    verdict: "contradicted",
    evidence: "test/a.test.ts:8 added a skip",
    ruleId: "test-skip-added",
    contributesToPass: false,
  }];
  input.receiptHash = recomputeReceiptHash(input);
  const web = renderResultViewHtml(buildReportResultView(input));
  assert.match(web, /Review notes/);
  assert.match(web, /new skip marker/);
});

test("PASS, FAIL, and INCONCLUSIVE use the same result structure", () => {
  const views = (["PASS", "FAIL", "INCONCLUSIVE"] as const).map((value) => buildReportResultView(report(value)));
  const topKeys = Object.keys(views[0]);
  const countKeys = Object.keys(views[0].counts);
  for (const view of views) {
    assert.deepEqual(Object.keys(view), topKeys);
    assert.deepEqual(Object.keys(view.counts), countKeys);
  }
});

test("changed-file manifest covers the exact Git range including renames", () => {
  const repo = mkdtempSync(join(tmpdir(), "vigil-result-model-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
  writeFileSync(join(repo, "old.ts"), "export const old = 1;\n");
  writeFileSync(join(repo, "delete.ts"), "delete me\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  renameSync(join(repo, "old.ts"), join(repo, "new.ts"));
  writeFileSync(join(repo, "added.ts"), "added\n");
  execFileSync("git", ["rm", "-q", "delete.ts"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "head"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const manifest = readChangedFileManifest(repo, base, head);
  const gitNames = execFileSync("git", ["diff", "--name-only", "-z", `${base}..${head}`], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  assert.equal(manifest.complete, true);
  assert.deepEqual([...new Set(manifest.files.map((file) => file.path))].sort(), gitNames);
  assert.ok(manifest.files.some((file) => file.status === "renamed"));
});

test("result web view has labeled landmarks and narrow-screen rules", () => {
  const web = renderResultViewHtml(buildReportResultView(report("FAIL")));
  assert.match(web, /<main [^>]*data-result-view-version="1"/);
  assert.match(web, /<section class="card" aria-labelledby="result-title">/);
  assert.match(web, /<nav class="actions" aria-label="Result actions">/);
  assert.match(web, /min-height:44px/);
  assert.match(web, /@media\(max-width:540px\)/);
  assert.doesNotMatch(web, /user-scalable=no|maximum-scale=1/);
});

test("remediation is concrete for known rules and conservative for unknown rules", () => {
  assert.match(remediationFor("test-count"), /vigil doctor/);
  assert.equal(remediationFor("unknown-rule"), "Provide objective evidence or remove the unsupported claim.");
});
