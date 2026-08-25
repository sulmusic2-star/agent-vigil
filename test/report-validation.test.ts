import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildReport,
  canonical,
  CLAIM_KINDS,
  REPORT_STATUSES,
  recomputeReceiptHash,
  TRANSCRIPT_FORMATS,
  VERDICTS,
  validateTrustReport,
  type CheckResult,
  type TrustReport,
} from "../src/report.ts";
import { generateSigningKey, publicKeyId, signReport, verifyReport } from "../src/signature.ts";

function result(): CheckResult {
  return {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "fresh test suite", expectedCount: 1 },
    verdict: "verified",
    evidence: "one test passed",
    ruleId: "tests-pass",
  };
}

function report(): TrustReport {
  return buildReport({
    transcript: ".aider.chat.history.md",
    transcriptFormat: "aider",
    repo: ".",
    base: "a".repeat(40),
    head: "b".repeat(40),
    results: [result()],
    repository: { remote: "https://example.test/repository.git", tree: "c".repeat(40) },
    reproduction: "vigil .aider.chat.history.md",
  });
}

function signingFixture(): { privateKey: string; publicKey: string } {
  const root = mkdtempSync(join(tmpdir(), "vigil-report-validation-"));
  const privateKey = join(root, "private.pem");
  const publicKey = join(root, "public.pem");
  generateSigningKey(privateKey, publicKey);
  return { privateKey, publicKey };
}

function attackerRehash(value: any): string {
  const {
    transcript: _transcript,
    repo: _repo,
    generatedAt: _generatedAt,
    receiptHash: _receiptHash,
    signature: _signature,
    ...payload
  } = value;
  return `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
}

test("full receipt validation accepts valid builder output and preserves explicit unavailable digests", () => {
  const built = report();
  const validated = validateTrustReport(built);
  assert.deepEqual(validated, built);
  assert.equal(validated.transcriptFormat, "aider");
  assert.equal(validated.transcriptSha256, "sha256:unavailable");
  assert.equal(validated.policy.sha256, "sha256:unavailable");

  const schema = JSON.parse(readFileSync(new URL("../docs/receipt-v2.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.transcriptFormat.enum, [...TRANSCRIPT_FORMATS]);
  assert.deepEqual(schema.properties.results.items.properties.claim.properties.kind.enum, [...CLAIM_KINDS]);
  assert.deepEqual(schema.properties.results.items.properties.verdict.enum, [...VERDICTS]);
  assert.deepEqual(schema.properties.summary.properties.status.enum, [...REPORT_STATUSES]);
  assert.equal(schema.$defs.sha256OrUnavailable.oneOf[1].const, "sha256:unavailable");
});

test("a valid signature cannot bless unknown receipt-v2 root fields", () => {
  const { privateKey } = signingFixture();
  const signed = signReport(report(), privateKey);
  assert.equal(verifyReport(signed).signatureValid, true);

  const smuggled = { ...signed, independentlyApproved: true };
  assert.throws(
    () => verifyReport(smuggled),
    /Agent Vigil receipt has unsupported or missing fields.*independentlyApproved/,
  );
});

test("full receipt validation rejects unknown nested fields and forged summaries even after rehashing", () => {
  const nested = structuredClone(report()) as any;
  nested.results[0].claim.independentlyApproved = true;
  assert.throws(() => recomputeReceiptHash(nested), /claim has unsupported or missing fields/);
  assert.throws(() => validateTrustReport(nested), /receipt results\[0\]\.claim has unsupported or missing fields/);

  const forged = structuredClone(report()) as any;
  forged.summary.verified = 2;
  forged.receiptHash = attackerRehash(forged);
  assert.throws(() => validateTrustReport(forged), /summary\.verified does not match results and policy/);

  const policy = structuredClone(report()) as any;
  policy.policy.bypass = true;
  assert.throws(() => recomputeReceiptHash(policy), /receipt policy has unsupported or missing fields/);
  assert.throws(() => validateTrustReport(policy), /receipt policy has unsupported or missing fields/);

  const namedArray = structuredClone(report()) as any;
  namedArray.results.independentlyApproved = true;
  assert.throws(() => validateTrustReport(namedArray), /results must not be sparse or contain named properties/);
});

test("full receipt validation enforces enums, canonical timestamps, digests, Git trees, and signatures", () => {
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ["format", (value) => { value.transcriptFormat = "unknown-agent"; }, /transcriptFormat has an unsupported value/],
    ["timestamp", (value) => { value.generatedAt = "2026-08-25T12:00:00+00:00"; }, /generatedAt must be canonical RFC3339 UTC/],
    ["transcript digest", (value) => { value.transcriptSha256 = "SHA256:" + "1".repeat(64); }, /transcriptSha256 must be a lowercase SHA-256 identifier/],
    ["tree", (value) => { value.repository.tree = "short"; }, /repository\.tree must be a full lowercase Git object ID/],
    ["claim enum", (value) => { value.results[0].claim.kind = "approved"; }, /claim\.kind has an unsupported value/],
    ["verdict enum", (value) => { value.results[0].verdict = "mostly-verified"; }, /verdict has an unsupported value/],
  ];
  for (const [name, mutate, expected] of cases) {
    const candidate = structuredClone(report()) as any;
    mutate(candidate);
    assert.throws(() => validateTrustReport(candidate), expected, name);
  }

  const { privateKey } = signingFixture();
  const malformedSignature = structuredClone(signReport(report(), privateKey)) as any;
  malformedSignature.signature.publicKey = "not-base64";
  assert.throws(() => validateTrustReport(malformedSignature), /signature\.publicKey must be canonical base64/);
});

test("signing refuses a structurally valid report whose receipt hash is stale", () => {
  const { privateKey } = signingFixture();
  const stale = report();
  stale.results[0].evidence = "content changed after hashing";
  assert.throws(() => signReport(stale, privateKey), /content does not match receiptHash; refusing to sign/);
});

test("signing key reads are bounded", () => {
  const { privateKey } = signingFixture();
  const oversized = join(mkdtempSync(join(tmpdir(), "vigil-oversized-key-")), "private.pem");
  writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1));
  assert.throws(() => signReport(report(), oversized), /65536 byte limit/);
  assert.doesNotThrow(() => signReport(report(), privateKey));
});

test("signing key reads refuse symbolic links", (context) => {
  if (process.platform === "win32") {
    context.skip("symbolic-link creation requires privileges on Windows");
    return;
  }
  const { privateKey, publicKey } = signingFixture();
  const root = mkdtempSync(join(tmpdir(), "vigil-linked-key-"));
  const linkedPrivate = join(root, "private.pem");
  const linkedPublic = join(root, "public.pem");
  symlinkSync(privateKey, linkedPrivate);
  symlinkSync(publicKey, linkedPublic);
  assert.throws(() => signReport(report(), linkedPrivate), /regular file, not a symbolic link/);
  assert.throws(() => publicKeyId(linkedPublic), /regular file, not a symbolic link/);

  const signed = signReport(report(), privateKey);
  assert.equal(verifyReport(signed, linkedPublic).signatureValid, false);
});

test("validation returns a detached nested snapshot for subsequent security decisions", () => {
  const input = report();
  const validated = validateTrustReport(input);
  input.results[0].evidence = "mutated after validation";
  input.repository.tree = "d".repeat(40);
  assert.equal(validated.results[0].evidence, "one test passed");
  assert.equal(validated.repository.tree, "c".repeat(40));
});
