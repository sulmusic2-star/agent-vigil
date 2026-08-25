import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTESTATION_PREDICATE_TYPE,
  buildAttestationPredicate,
  buildNotaryCheck,
  loadReceipt,
  verifyGhAttestationOutput,
  verifyGitHubAttestation,
  verifyWebhookSignature,
  writeAttestationPredicate,
} from "../src/attestation.ts";
import { buildReport, recomputeReceiptHash, type CheckResult, type ReportStatus, type TrustReport } from "../src/report.ts";
import { initRepository } from "../src/setup.ts";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "3".repeat(40);
const POLICY = `sha256:${"4".repeat(64)}`;
const ACTION_SHA = "a".repeat(40);

function result(status: ReportStatus): CheckResult {
  return {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "fresh test suite" },
    verdict: status === "PASS" ? "verified" : status === "FAIL" ? "contradicted" : "unverifiable",
    evidence: status === "PASS" ? "12 passed" : status === "FAIL" ? "1 failed" : "test runner unavailable",
    ruleId: "tests-pass",
    ...(status === "INCONCLUSIVE" ? { blocksPass: true } : {}),
  };
}

function receipt(status: ReportStatus = "PASS"): { root: string; path: string; report: TrustReport } {
  const root = mkdtempSync(join(tmpdir(), "vigil-attestation-"));
  const report = buildReport({
    transcript: ".agent-vigil/session.jsonl",
    transcriptSha256: `sha256:${"5".repeat(64)}`,
    transcriptFormat: "codex",
    repo: root,
    base: BASE,
    head: HEAD,
    results: [result(status)],
    policy: { strict: true, minVerified: 1, sha256: POLICY },
    repository: { tree: TREE },
    reproduction: `vigil verify ${HEAD}`,
  });
  const path = join(root, "agent-vigil-report.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return { root, path, report };
}

function verifiedGhOutput(path: string) {
  const predicate = buildAttestationPredicate(path);
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  return [{
    verificationResult: {
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: "agent-vigil-report.json", digest: { sha256: digest } }],
        predicateType: ATTESTATION_PREDICATE_TYPE,
        predicate,
      },
    },
  }];
}

test("attestation predicate is bound to the receipt without publishing source or prompt text", () => {
  const fixture = receipt();
  const predicate = buildAttestationPredicate(fixture.path);
  assert.equal(predicate.receipt.receiptHash, fixture.report.receiptHash);
  assert.equal(predicate.receipt.head, HEAD);
  assert.equal(predicate.receipt.policySha256, POLICY);
  assert.deepEqual(predicate.privacy, { sourceIncluded: false, transcriptIncluded: false, promptIncluded: false });
  const serialized = JSON.stringify(predicate);
  assert.doesNotMatch(serialized, /session\.jsonl/);
  assert.doesNotMatch(serialized, /tests pass/);
  assert.doesNotMatch(serialized, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("attestation preparation writes the versioned custom predicate", () => {
  const fixture = receipt();
  const output = join(fixture.root, "predicate.json");
  writeAttestationPredicate(fixture.path, output);
  const parsed = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(parsed.predicateVersion, "1");
  assert.equal(parsed.receipt.status, "PASS");
});

test("attestation preparation rejects a tampered receipt", () => {
  const fixture = receipt();
  const altered = JSON.parse(readFileSync(fixture.path, "utf8"));
  altered.summary.status = "FAIL";
  writeFileSync(fixture.path, JSON.stringify(altered));
  assert.throws(() => buildAttestationPredicate(fixture.path), /summary\.status does not match results and policy/);
});

test("GitHub attestation verification binds subject digest and privacy-reduced predicate", () => {
  const fixture = receipt();
  const verification = verifyGhAttestationOutput(fixture.path, verifiedGhOutput(fixture.path));
  assert.equal(verification.valid, true);
  assert.equal(verification.statementCount, 1);
});

test("GitHub attestation verification rejects the wrong subject digest", () => {
  const fixture = receipt();
  const output = verifiedGhOutput(fixture.path) as any;
  output[0].verificationResult.statement.subject[0].digest.sha256 = "0".repeat(64);
  const verification = verifyGhAttestationOutput(fixture.path, output);
  assert.equal(verification.valid, false);
  assert.equal(verification.subjectDigestValid, false);
});

test("GitHub attestation verification rejects a replayed predicate for another head", () => {
  const fixture = receipt();
  const output = verifiedGhOutput(fixture.path) as any;
  output[0].verificationResult.statement.predicate.receipt.head = "9".repeat(40);
  const verification = verifyGhAttestationOutput(fixture.path, output);
  assert.equal(verification.valid, false);
  assert.equal(verification.predicateValid, false);
});

test("GitHub attestation verification rejects a predicate for another Git tree", () => {
  const fixture = receipt();
  const output = verifiedGhOutput(fixture.path) as any;
  output[0].verificationResult.statement.predicate.receipt.tree = "9".repeat(40);
  const verification = verifyGhAttestationOutput(fixture.path, output);
  assert.equal(verification.valid, false);
  assert.equal(verification.predicateValid, false);
});

test("attestation preparation refuses a receipt without a committed Git tree", () => {
  const fixture = receipt();
  delete fixture.report.repository.tree;
  fixture.report.receiptHash = recomputeReceiptHash(fixture.report);
  writeFileSync(fixture.path, `${JSON.stringify(fixture.report, null, 2)}\n`);
  assert.throws(() => buildAttestationPredicate(fixture.path), /requires the exact committed Git tree/);
});

test("attestation preparation rejects malformed and oversized receipt files", () => {
  const cases: Array<[string, (report: any) => void, RegExp]> = [
    ["schema", (report) => { report.schemaVersion = "1"; }, /unsupported receipt schema/],
    ["status", (report) => { report.summary.status = "MAYBE"; }, /summary\.status has an unsupported value/],
    ["count", (report) => { report.summary.verified = -1; }, /summary\.verified must be a non-negative integer/],
    ["base", (report) => { report.base = "short"; }, /full base and head/],
    ["tree", (report) => { report.repository.tree = "short"; }, /repository\.tree must be a full lowercase Git object ID/],
    ["policy", (report) => { report.policy.sha256 = "unavailable"; }, /policy\.sha256 must be a lowercase SHA-256 identifier/],
    ["hash", (report) => { report.receiptHash = "sha256:short"; }, /receiptHash must be a lowercase SHA-256 identifier/],
  ];
  for (const [name, alter, message] of cases) {
    const fixture = receipt();
    const malformed = structuredClone(fixture.report) as any;
    alter(malformed);
    writeFileSync(fixture.path, JSON.stringify(malformed));
    assert.throws(() => loadReceipt(fixture.path), message, name);
  }
  const fixture = receipt();
  assert.throws(() => loadReceipt(fixture.root), /regular file/);
  const linked = join(fixture.root, "linked-receipt.json");
  symlinkSync(fixture.path, linked);
  assert.throws(() => loadReceipt(linked), /regular file, not a symbolic link/);
  const large = join(fixture.root, "large.json");
  writeFileSync(large, Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.throws(() => loadReceipt(large), /16777216 byte limit/);
});

test("attestation verification rejects extra fields and misleading subject names", () => {
  const fixture = receipt();
  const extraPredicate = verifiedGhOutput(fixture.path) as any;
  extraPredicate[0].verificationResult.statement.predicate.extra = true;
  assert.equal(verifyGhAttestationOutput(fixture.path, extraPredicate).valid, false);

  const extraPrivacy = verifiedGhOutput(fixture.path) as any;
  extraPrivacy[0].verificationResult.statement.predicate.privacy.extra = false;
  assert.equal(verifyGhAttestationOutput(fixture.path, extraPrivacy).valid, false);

  const misleadingName = verifiedGhOutput(fixture.path) as any;
  misleadingName[0].verificationResult.statement.subject[0].name = "forged-agent-vigil-report.json";
  assert.equal(verifyGhAttestationOutput(fixture.path, misleadingName).subjectDigestValid, false);

  const plainStatement = (verifiedGhOutput(fixture.path) as any)[0].verificationResult.statement;
  assert.equal(verifyGhAttestationOutput(fixture.path, plainStatement).valid, true);
});

test("notary check uses blocking conclusions for FAIL and INCONCLUSIVE", () => {
  for (const [status, conclusion] of [["PASS", "success"], ["FAIL", "failure"], ["INCONCLUSIVE", "action_required"]] as const) {
    const fixture = receipt(status);
    const verification = verifyGhAttestationOutput(fixture.path, verifiedGhOutput(fixture.path));
    const payload = buildNotaryCheck(fixture.path, verification, HEAD, POLICY);
    assert.equal(payload.conclusion, conclusion);
    assert.equal(payload.head_sha, HEAD);
    assert.match(payload.output.summary, status === "PASS" ? /required evidence is present/ : status === "FAIL" ? /contradicted/ : /not enough/);
  }
});

test("notary refuses wrong heads, wrong policies, and invalid attestations", () => {
  const fixture = receipt();
  const verification = verifyGhAttestationOutput(fixture.path, verifiedGhOutput(fixture.path));
  assert.throws(() => buildNotaryCheck(fixture.path, verification, "9".repeat(40), POLICY), /does not match expected head/);
  assert.throws(() => buildNotaryCheck(fixture.path, verification, HEAD, `sha256:${"9".repeat(64)}`), /does not match trusted policy/);
  assert.throws(() => buildNotaryCheck(fixture.path, { ...verification, valid: false }, HEAD, POLICY), /invalid GitHub attestation/);
  assert.throws(() => buildNotaryCheck(fixture.path, verification, "short", POLICY), /full commit SHA/);
  assert.throws(() => buildNotaryCheck(fixture.path, verification, HEAD, "sha256:short"), /64 hex/);
});

test("GitHub webhook signatures use HMAC-SHA256 and constant-length comparison", () => {
  const body = Buffer.from('{"action":"completed"}');
  const secret = "not-a-real-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature(secret, body, signature), true);
  assert.equal(verifyWebhookSignature(secret, Buffer.from("altered"), signature), false);
  assert.equal(verifyWebhookSignature(secret, body, "sha256=short"), false);
  assert.equal(verifyWebhookSignature("", body, signature), false);
  assert.equal(verifyWebhookSignature(secret, body, "not-sha256"), false);
  assert.equal(verifyWebhookSignature(secret, body, undefined), false);
});

test("candidate-executing init profiles refuse attestation until a separate signer exists", () => {
  for (const profile of ["default", "maintainer", "authority", "protect"] as const) {
    const root = mkdtempSync(join(tmpdir(), `vigil-attested-${profile}-`));
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    assert.throws(
      () => initRepository(root, false, undefined, profile, true, ACTION_SHA),
      /--attest is disabled for candidate-executing workflows until a separately controlled signer is available/,
    );
    assert.equal(existsSync(join(root, ".github/workflows/agent-vigil.yml")), false);
  }
});

test("CLI prepares, verifies, and notarizes one exact receipt", () => {
  const fixture = receipt();
  const predicatePath = join(fixture.root, "predicate.json");
  assert.equal(run(["attest", fixture.path, "--predicate-output", predicatePath]), 0);
  const ghCalls: string[][] = [];
  const executeGh = (args: string[]) => {
    ghCalls.push(args);
    return JSON.stringify(verifiedGhOutput(fixture.path));
  };
  const verification = verifyGitHubAttestation(fixture.path, "owner/repository", {}, executeGh);
  assert.equal(verification.valid, true);
  const checkPath = join(fixture.root, "check.json");
  const check = buildNotaryCheck(fixture.path, verification, HEAD, POLICY);
  writeFileSync(checkPath, `${JSON.stringify(check, null, 2)}\n`);
  assert.equal(check.name, "Agent Vigil verified");
  assert.equal(check.head_sha, HEAD);
  assert.equal(check.conclusion, "success");
  assert.deepEqual(ghCalls[0].slice(0, 2), ["attestation", "verify"]);
  assert.ok(ghCalls[0].includes("owner/repository/.github/workflows/agent-vigil.yml"));
  assert.ok(ghCalls[0].includes("--deny-self-hosted-runners"));
});

test("GitHub verification reports bad trust settings and bad CLI output", () => {
  const fixture = receipt();
  assert.equal(run(["verify-attestation", fixture.path, "--signer-workflwo", "wrong"]), 2);
  assert.equal(run(["attest", fixture.path, fixture.path, "--predicate-output", join(fixture.root, "bad.json")]), 2);
  assert.throws(() => verifyGitHubAttestation(fixture.path, "not-a-repository"), /owner\/name/);
  assert.throws(() => verifyGitHubAttestation(fixture.path, "owner/repository", { signerWorkflow: "wrong" }), /signer workflow/);

  assert.throws(
    () => verifyGitHubAttestation(fixture.path, "owner/repository", {}, () => {
      const error = Object.assign(new Error("failed"), { stderr: "denied" });
      throw error;
    }),
    /denied/,
  );
  assert.throws(
    () => verifyGitHubAttestation(fixture.path, "owner/repository", {}, () => "not-json"),
    /unreadable attestation JSON/,
  );
});
