import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { initRepository, doctorRepository } from "../src/setup.ts";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "3".repeat(40);
const POLICY = `sha256:${"4".repeat(64)}`;

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
  assert.throws(() => buildAttestationPredicate(fixture.path), /does not match receiptHash/);
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
    ["status", (report) => { report.summary.status = "MAYBE"; }, /invalid status/],
    ["count", (report) => { report.summary.verified = -1; }, /invalid evidence counts/],
    ["base", (report) => { report.base = "short"; }, /full base and head/],
    ["tree", (report) => { report.repository.tree = "short"; }, /exact committed Git tree/],
    ["policy", (report) => { report.policy.sha256 = "unavailable"; }, /SHA-256 policy digest/],
    ["hash", (report) => { report.receiptHash = "sha256:short"; }, /invalid receiptHash/],
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
  const large = join(fixture.root, "large.json");
  writeFileSync(large, Buffer.alloc(16 * 1024 * 1024 + 1));
  assert.throws(() => loadReceipt(large), /16 MB/);
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

test("attested init grants only the permissions needed for GitHub signing", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-attested-init-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  initRepository(root, false, undefined, "default", true);
  const workflow = readFileSync(join(root, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.match(workflow, /attest: true/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.equal(doctorRepository(root).find((check) => check.label === "GitHub attestation")?.status, "PASS");

  writeFileSync(join(root, ".github/workflows/agent-vigil.yml"), workflow.replace("contents: read", "contents: write"));
  assert.equal(doctorRepository(root).find((check) => check.label === "GitHub attestation")?.status, "WARN");
});

test("CLI prepares, verifies, and notarizes one exact receipt", () => {
  const fixture = receipt();
  const predicatePath = join(fixture.root, "predicate.json");
  assert.equal(run(["attest", fixture.path, "--predicate-output", predicatePath]), 0);

  const bin = join(fixture.root, "bin");
  mkdirSync(bin);
  const ghOutputPath = join(fixture.root, "gh-output.json");
  writeFileSync(ghOutputPath, JSON.stringify(verifiedGhOutput(fixture.path)));
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$VIGIL_TEST_GH_ARGS\"\ncat \"$VIGIL_TEST_GH_OUTPUT\"\n");
  chmodSync(gh, 0o700);

  const previousPath = process.env.PATH;
  const previousOutput = process.env.VIGIL_TEST_GH_OUTPUT;
  const previousArgs = process.env.VIGIL_TEST_GH_ARGS;
  const ghArgsPath = join(fixture.root, "gh-args.txt");
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.VIGIL_TEST_GH_OUTPUT = ghOutputPath;
  process.env.VIGIL_TEST_GH_ARGS = ghArgsPath;
  try {
    assert.equal(run(["verify-attestation", fixture.path, "--repository", "owner/repository"]), 0);
    const checkPath = join(fixture.root, "check.json");
    assert.equal(run([
      "notary", fixture.path,
      "--repository", "owner/repository",
      "--head", HEAD,
      "--policy-sha256", POLICY,
      "--output", checkPath,
    ]), 0);
    const check = JSON.parse(readFileSync(checkPath, "utf8"));
    assert.equal(check.name, "Agent Vigil verified");
    assert.equal(check.head_sha, HEAD);
    assert.equal(check.conclusion, "success");
    const ghArgs = readFileSync(ghArgsPath, "utf8");
    assert.match(ghArgs, /--signer-workflow owner\/repository\/\.github\/workflows\/agent-vigil\.yml/);
    assert.match(ghArgs, /--deny-self-hosted-runners/);
  } finally {
    process.env.PATH = previousPath;
    if (previousOutput === undefined) delete process.env.VIGIL_TEST_GH_OUTPUT;
    else process.env.VIGIL_TEST_GH_OUTPUT = previousOutput;
    if (previousArgs === undefined) delete process.env.VIGIL_TEST_GH_ARGS;
    else process.env.VIGIL_TEST_GH_ARGS = previousArgs;
  }
});

test("GitHub verification reports bad trust settings and bad CLI output", () => {
  const fixture = receipt();
  assert.equal(run(["verify-attestation", fixture.path, "--signer-workflwo", "wrong"]), 2);
  assert.equal(run(["attest", fixture.path, fixture.path, "--predicate-output", join(fixture.root, "bad.json")]), 2);
  assert.throws(() => verifyGitHubAttestation(fixture.path, "not-a-repository"), /owner\/name/);
  assert.throws(() => verifyGitHubAttestation(fixture.path, "owner/repository", { signerWorkflow: "wrong" }), /signer workflow/);

  const bin = join(fixture.root, "bad-bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/bin/sh\necho denied >&2\nexit 1\n");
  chmodSync(gh, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    assert.throws(() => verifyGitHubAttestation(fixture.path, "owner/repository"), /denied/);
    writeFileSync(gh, "#!/bin/sh\necho not-json\n");
    assert.throws(() => verifyGitHubAttestation(fixture.path, "owner/repository"), /unreadable attestation JSON/);
  } finally {
    process.env.PATH = previousPath;
  }
});
