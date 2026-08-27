import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assessOutcome,
  buildSettlementAdapterPayload,
  createOutcomeMandate,
  loadOutcomeJson,
  verifyOutcomeMandate,
  verifyOutcomeReceipt,
  type OutcomeAdapter,
  type OutcomeMandate,
  type OutcomeMandateInput,
  type OutcomeReceipt,
} from "../src/outcome.ts";
import { buildReport, recomputeReceiptHash, type CheckResult, type TrustReport } from "../src/report.ts";
import { generateSigningKey, publicKeyId, signReport } from "../src/signature.ts";
import { runMandateCommand, runOutcomeReceiptCommand } from "../src/outcome-cli.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const OTHER_BASE = "3".repeat(40);
const OTHER_HEAD = "4".repeat(40);
const CREATED = "2026-08-26T12:00:00.000Z";
const EXPIRES = "2026-09-26T12:00:00.000Z";

type CorpusCase = { id: string; stage: string; expected: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function silent(operation: () => number): number {
  const stdout = console.log;
  const stderr = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return operation(); }
  finally { console.log = stdout; console.error = stderr; }
}

function mutableObject(value: unknown, label = "fixture"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nestedObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return mutableObject(parent[key], key);
}

function result(ruleId: string, verdict: "verified" | "contradicted" | "unverifiable", contributesToPass = true, blocksPass = false): CheckResult {
  return {
    claim: { kind: "tests_pass", quote: ruleId, subject: ruleId },
    verdict,
    evidence: `${ruleId}: ${verdict}`,
    ruleId,
    contributesToPass,
    ...(blocksPass ? { blocksPass: true } : {}),
  };
}

test("Outcome Mandate v0.1 passes a valid exact-state report and emits no network action", () => {
  const fixture = setup();
  const receipt = assessOutcome(fixture.mandate(), fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.settlementSignal.action, "RELEASE");
  assert.equal(receipt.settlementSignal.dryRun, true);
  assert.equal(receipt.settlementSignal.networkAction, "NONE");
  assert.equal(verifyOutcomeReceipt(receipt, fixture.verifierPublic).valid, true);
});

test("Outcome verification rejects unknown fields and a rehashed forged report summary", () => {
  const fixture = setup();
  const mandate = fixture.mandate();
  const unknown = { ...mandate, paymentApi: "https://example.invalid/release" };
  assert.equal(verifyOutcomeMandate(unknown, fixture.requesterPublic).valid, false);

  const forged = fixture.report([result("tests-pass", "contradicted")]);
  forged.summary = { verified: 1, contradicted: 0, unverifiable: 0, meaningfulVerified: 1, status: "PASS", pass: true };
  forged.receiptHash = recomputeReceiptHash(forged);
  const receipt = assessOutcome(mandate, forged, fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  assert.equal(receipt.verdict, "FAIL");
  assert.equal(receipt.checks.find((item) => item.id === "evidence-summary")?.verdict, "FAIL");
});

test("50 adversarial outcome cases fail closed or stay network-inert", () => {
  const corpus = JSON.parse(readFileSync(new URL("../proof/outcome-cases/corpus-v0.1.json", import.meta.url), "utf8")) as CorpusCase[];
  assert.equal(corpus.length, 50);
  assert.equal(new Set(corpus.map((item) => item.id)).size, 50);
  const fixture = setup();

  for (const item of corpus) {
    const mandate = fixture.mandate();
    const validReport = fixture.report();
    const validReceipt = assessOutcome(mandate, validReport, fixture.verifierPrivate, {
      requesterPublicKeyPath: fixture.requesterPublic,
      issuedAt: "2026-08-27T12:00:00.000Z",
      attempts: 1,
    });

    if (item.stage === "mandate-verify") {
      const altered = mutableObject(clone(mandate));
      const task = nestedObject(altered, "task");
      const requester = nestedObject(altered, "requester");
      const acceptance = nestedObject(altered, "acceptance");
      const settlement = nestedObject(altered, "settlement");
      const signature = nestedObject(altered, "signature");
      const verifier = nestedObject(altered, "verifier");
      const mutations: Record<string, () => void> = {
        "mandate-description-tamper": () => { task.description = "Changed after signing"; },
        "mandate-requester-tamper": () => { requester.id = "different/requester"; },
        "mandate-provider-tamper": () => { altered.provider = { id: "different-agent" }; },
        "mandate-task-id-tamper": () => { task.id = "different-task"; },
        "mandate-task-class-tamper": () => { task.class = "different-class"; },
        "mandate-base-tamper": () => { task.base = OTHER_BASE; },
        "mandate-head-tamper": () => { task.head = OTHER_HEAD; },
        "mandate-minimum-tamper": () => { acceptance.minMeaningfulVerified = 99; },
        "mandate-adapter-tamper": () => { settlement.adapter = "generic"; },
        "mandate-reference-tamper": () => { settlement.reference = "different-reference"; },
        "mandate-expired": () => {},
        "mandate-wrong-pinned-key": () => {},
        "mandate-signature-tamper": () => { signature.value = Buffer.from("bad signature").toString("base64"); },
        "mandate-short-base": () => { task.base = "abc"; },
        "mandate-identical-commits": () => { task.head = task.base; },
        "mandate-active-settlement-mode": () => { settlement.mode = "active"; },
        "mandate-network-action": () => { settlement.networkAction = "POST"; },
        "mandate-weakened-required-status": () => { acceptance.requiredReportStatus = "INCONCLUSIVE"; },
        "mandate-no-verifier": () => { verifier.trustedKeyIds = []; },
        "mandate-duplicate-rule": () => { acceptance.requiredRuleIds = ["tests-pass", "tests-pass"]; },
      };
      assert.ok(mutations[item.id], `missing mutation for ${item.id}`);
      mutations[item.id]();
      const asOf = item.id === "mandate-expired" ? new Date("2026-10-01T00:00:00.000Z") : new Date("2026-08-27T00:00:00.000Z");
      const pinned = item.id === "mandate-wrong-pinned-key" ? fixture.otherPublic : fixture.requesterPublic;
      assert.equal(verifyOutcomeMandate(altered, pinned, asOf).valid, false, item.id);
      continue;
    }

    if (item.stage === "assess-error") {
      assert.throws(() => assessOutcome(mandate, validReport, fixture.otherPrivate, { requesterPublicKeyPath: fixture.requesterPublic, attempts: 1 }), /not trusted/, item.id);
      continue;
    }

    if (item.stage === "assess") {
      let selectedMandate = mandate;
      let selectedReport = validReport;
      let issuedAt = "2026-08-27T12:00:00.000Z";
      switch (item.id) {
        case "report-base-mismatch": selectedReport = fixture.report(undefined, { base: OTHER_BASE }); break;
        case "report-head-mismatch": selectedReport = fixture.report(undefined, { head: OTHER_HEAD }); break;
        case "report-content-tamper": selectedReport = clone(validReport); selectedReport.results[0].evidence = "altered"; break;
        case "report-fail": selectedReport = fixture.report([result("tests-pass", "contradicted")]); break;
        case "report-inconclusive": selectedReport = fixture.report([result("tests-pass", "unverifiable", true, true)]); break;
        case "report-contradiction": selectedReport = fixture.report([result("tests-pass", "verified"), result("test-integrity", "contradicted")]); break;
        case "report-minimum-unmet": selectedMandate = fixture.mandate({ minMeaningfulVerified: 3 }); break;
        case "report-required-rule-missing": selectedMandate = fixture.mandate({ requiredRuleIds: ["missing-rule"] }); break;
        case "report-required-rule-contradicted": selectedReport = fixture.report([result("tests-pass", "verified"), result("test-integrity", "contradicted")]); break;
        case "report-required-rule-unverifiable": selectedReport = fixture.report([result("tests-pass", "verified"), result("test-integrity", "verified"), result("required-uncertain", "unverifiable", false)]); selectedMandate = fixture.mandate({ requiredRuleIds: ["required-uncertain"] }); break;
        case "report-unsigned-when-required": selectedMandate = fixture.mandate({ requireSignedEvidence: true, trustedEvidenceSignerKeyIds: [publicKeyId(fixture.evidencePublic)] }); break;
        case "report-untrusted-signer": selectedMandate = fixture.mandate({ requireSignedEvidence: true, trustedEvidenceSignerKeyIds: [publicKeyId(fixture.evidencePublic)] }); selectedReport = fixture.report(undefined, { signWith: fixture.otherPrivate }); break;
        case "expired-at-assessment": issuedAt = "2026-10-01T00:00:00.000Z"; break;
        default: assert.fail(`missing assessment mutation for ${item.id}`);
      }
      const receipt = assessOutcome(selectedMandate, selectedReport, fixture.verifierPrivate, {
        requesterPublicKeyPath: fixture.requesterPublic,
        issuedAt,
        attempts: 1,
      });
      assert.equal(receipt.verdict, item.expected, item.id);
      assert.equal(receipt.settlementSignal.networkAction, "NONE", item.id);
      continue;
    }

    if (item.stage === "receipt-verify") {
      const altered = mutableObject(clone(validReceipt));
      const settlementSignal = nestedObject(altered, "settlementSignal");
      const signature = nestedObject(altered, "signature");
      const sourceEvidence = nestedObject(altered, "sourceEvidence");
      switch (item.id) {
        case "receipt-verdict-tamper": altered.verdict = "FAIL"; break;
        case "receipt-action-tamper": settlementSignal.action = "REFUND"; break;
        case "receipt-hash-tamper": altered.outcomeHash = `sha256:${"0".repeat(64)}`; break;
        case "receipt-signature-tamper": signature.value = Buffer.from("bad signature").toString("base64"); break;
        case "receipt-key-id-mismatch": signature.keyId = `sha256:${"0".repeat(64)}`; break;
        case "receipt-source-hash-malformed": sourceEvidence.reportHash = "bad"; break;
        case "receipt-source-base-malformed": sourceEvidence.base = "bad"; break;
        case "receipt-empty-checks": altered.checks = []; break;
        case "receipt-duplicate-reason": altered.reasonCodes = ["x", "x"]; break;
        default: assert.fail(`missing receipt mutation for ${item.id}`);
      }
      assert.equal(verifyOutcomeReceipt(altered, fixture.verifierPublic).valid, false, item.id);
      continue;
    }

    if (item.stage === "signal") {
      const adapters: Record<string, OutcomeAdapter | undefined> = {
        "signal-generic-no-network": "generic",
        "signal-a2a-no-network": "a2a",
        "signal-ap2-no-network": "ap2",
        "signal-x402-no-network": "x402",
        "signal-erc8004-no-network": "erc-8004",
        "signal-vcap-no-network": "vcap",
        "signal-override-no-network": "generic",
      };
      assert.ok(item.id in adapters, `missing adapter for ${item.id}`);
      const signal = buildSettlementAdapterPayload(validReceipt, adapters[item.id], { verifierPublicKeyPath: fixture.verifierPublic });
      assert.equal(signal.networkAction, "NONE", item.id);
      assert.equal(signal.draft, true, item.id);
      continue;
    }

    assert.fail(`unknown corpus stage ${item.stage}`);
  }
});

test("Outcome assessment enforces signed limits and never attributes an invalid optional signature", () => {
  const fixture = setup();
  const mandate = fixture.mandate({ maxAttempts: 2, maxBudgetUsd: 10 });
  const overLimit = assessOutcome(mandate, fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic, attempts: 3, costUsd: 11,
  });
  assert.equal(overLimit.verdict, "FAIL");
  assert.equal(overLimit.checks.find((item) => item.id === "attempt-limit")?.verdict, "FAIL");
  assert.equal(overLimit.checks.find((item) => item.id === "budget-limit")?.verdict, "FAIL");

  const missingUsage = assessOutcome(fixture.mandate(), fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
  });
  assert.equal(missingUsage.verdict, "INCONCLUSIVE");

  const forged = fixture.report(undefined, { signWith: fixture.otherPrivate });
  forged.signature!.value = Buffer.from("bad signature").toString("base64");
  const invalidSignature = assessOutcome(fixture.mandate(), forged, fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic, attempts: 1,
  });
  assert.equal(invalidSignature.verdict, "FAIL");
  assert.equal(invalidSignature.sourceEvidence.signerKeyId, undefined);
});

test("Outcome CLI creates, verifies, assesses, verifies, and renders one signed dry-run signal", () => {
  const fixture = setup();
  const root = fixture.directory;
  const mandatePath = join(root, "mandate.json");
  const reportPath = join(root, "report.json");
  const receiptPath = join(root, "outcome-receipt.json");
  const signalPath = join(root, "signal.json");
  const evidenceKeyId = publicKeyId(fixture.evidencePublic);
  const verifierKeyId = publicKeyId(fixture.verifierPublic);

  assert.equal(silent(() => runMandateCommand([
    "create",
    "--requester", "acme/platform",
    "--provider", "coding-agent-7",
    "--task-id", "fix-1842",
    "--task-class", "code-change",
    "--description", "Fix the retry race without weakening its regression tests",
    "--base", BASE,
    "--head", HEAD,
    "--created-at", CREATED,
    "--expires", EXPIRES,
    "--requester-key", fixture.requesterPrivate,
    "--verifier-public-key", fixture.verifierPublic,
    "--required-rules", "tests-pass,test-integrity",
    "--min-verified", "2",
    "--require-signed-evidence",
    "--evidence-key-ids", evidenceKeyId,
    "--max-attempts", "2",
    "--max-budget-usd", "10",
    "--adapter", "x402",
    "--settlement-ref", "task-1842",
    "--output", mandatePath,
  ])), 0);
  assert.equal(silent(() => runMandateCommand([
    "verify", mandatePath, "--requester-public-key", fixture.requesterPublic, "--as-of", "2026-08-27T12:00:00.000Z",
  ])), 0);

  writeFileSync(reportPath, `${JSON.stringify(fixture.report(undefined, { signWith: fixture.evidencePrivate }), null, 2)}\n`);
  assert.equal(silent(() => runMandateCommand([
    "assess", mandatePath,
    "--receipt", reportPath,
    "--verifier-key", fixture.verifierPrivate,
    "--requester-public-key", fixture.requesterPublic,
    "--issued-at", "2026-08-27T12:00:00.000Z",
    "--attempts", "1",
    "--cost-usd", "5",
    "--output", receiptPath,
  ])), 0);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as OutcomeReceipt;
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.sourceEvidence.signerKeyId, evidenceKeyId);
  assert.equal(receipt.settlementSignal.networkAction, "NONE");

  assert.equal(silent(() => runOutcomeReceiptCommand([
    "verify", receiptPath, "--verifier-public-key", fixture.verifierPublic,
  ])), 0);
  assert.equal(silent(() => runOutcomeReceiptCommand([
    "signal", receiptPath, "--trusted-key-ids", verifierKeyId, "--adapter", "a2a", "--output", signalPath,
  ])), 0);
  const signal = JSON.parse(readFileSync(signalPath, "utf8"));
  assert.equal(signal.type, "agent-vigil/a2a-acceptance-extension-draft");
  assert.equal(signal.metadata.decision, "accept");
  assert.equal(signal.networkAction, "NONE");
  assert.equal(signal.draft, true);
  assert.equal(silent(() => runOutcomeReceiptCommand([
    "signal", receiptPath, "--verifier-public-key", fixture.verifierPublic,
  ])), 0);
});

test("Outcome CLI rejects expired, malformed, untrusted, and ambiguous requests without side effects", () => {
  const fixture = setup();
  const mandatePath = join(fixture.directory, "mandate.json");
  const receiptPath = join(fixture.directory, "outcome-receipt.json");
  writeFileSync(mandatePath, `${JSON.stringify(fixture.mandate(), null, 2)}\n`);
  writeFileSync(receiptPath, `${JSON.stringify(assessOutcome(fixture.mandate(), fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  }), null, 2)}\n`);

  assert.equal(silent(() => runMandateCommand(["verify", mandatePath, "--as-of", "2026-10-01T00:00:00.000Z"])), 1);
  assert.equal(silent(() => runMandateCommand(["verify", mandatePath, "--as-of", "not-a-time"])), 2);
  assert.equal(silent(() => runMandateCommand(["create", "--min-verified", "0"])), 2);
  assert.equal(silent(() => runMandateCommand(["create", "--max-budget-usd", "0"])), 2);
  assert.equal(silent(() => runMandateCommand(["create", "--adapter", "wire-transfer"])), 2);
  assert.equal(silent(() => runMandateCommand(["create", "--requester", "one", "--requester", "two"])), 2);
  assert.equal(silent(() => runMandateCommand(["unknown"])), 2);
  assert.equal(silent(() => runOutcomeReceiptCommand(["signal", receiptPath])), 2);
  assert.equal(silent(() => runOutcomeReceiptCommand(["verify", receiptPath, "--trusted-key-ids", `sha256:${"0".repeat(64)}`])), 1);
  assert.equal(silent(() => runOutcomeReceiptCommand(["unknown"])), 2);
});

test("Outcome constructors and verifiers reject invalid keys, limits, identities, times, and files", () => {
  const fixture = setup();
  const input: OutcomeMandateInput = {
    createdAt: CREATED,
    expiresAt: EXPIRES,
    requesterId: "acme/platform",
    taskId: "fix-1842",
    taskClass: "code-change",
    description: "Fix the retry race",
    base: BASE,
    head: HEAD,
    verifierKeyIds: [publicKeyId(fixture.verifierPublic)],
  };
  const create = (overrides: Partial<OutcomeMandateInput> = {}, key = fixture.requesterPrivate) =>
    createOutcomeMandate({ ...input, ...overrides }, key);

  assert.throws(() => create({ createdAt: "not-a-time" }), /createdAt/);
  assert.throws(() => create({ expiresAt: CREATED }), /later than/);
  assert.throws(() => create({ expiresAt: "2028-01-01T00:00:00.000Z" }), /366 days/);
  assert.throws(() => create({ verifierKeyIds: [] }), /verifier key ID/);
  assert.throws(() => create({ requireSignedEvidence: true }), /trusted evidence signer/);
  assert.throws(() => create({ adapter: "wire-transfer" as OutcomeAdapter }), /unsupported settlement adapter/);
  assert.throws(() => create({ settlementReference: " " }), /settlementReference/);
  assert.throws(() => create({ settlementReference: "x".repeat(501) }), /settlementReference/);
  assert.throws(() => create({ requesterId: "invalid id" }), /requesterId/);
  assert.throws(() => create({ base: "bad" }), /base/);
  assert.throws(() => create({ head: BASE }), /base and head must differ/);
  assert.throws(() => create({ description: "x" }), /description/);
  assert.throws(() => create({ minMeaningfulVerified: 0 }), /minMeaningfulVerified/);
  assert.throws(() => create({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => create({ maxBudgetUsd: 0 }), /maxBudgetUsd/);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPrivate = join(fixture.directory, "rsa-private.pem");
  const rsaPublic = join(fixture.directory, "rsa-public.pem");
  writeFileSync(rsaPrivate, rsa.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(rsaPublic, rsa.publicKey.export({ type: "spki", format: "pem" }));
  assert.throws(() => create({}, rsaPrivate), /Ed25519/);

  const mandate = create();
  assert.equal(verifyOutcomeMandate(mandate, fixture.requesterPublic, new Date(Number.NaN)).valid, false);
  assert.equal(verifyOutcomeMandate(mandate, rsaPublic, new Date("2026-08-27T00:00:00.000Z")).valid, false);
  const badMandateKey = clone(mandate);
  badMandateKey.signature.publicKey = "not-base64";
  assert.equal(verifyOutcomeMandate(badMandateKey, undefined, new Date("2026-08-27T00:00:00.000Z")).valid, false);

  const receipt = assessOutcome(mandate, fixture.report([result("tests-pass", "verified")]), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  const unpinnedReceipt = verifyOutcomeReceipt(receipt);
  assert.equal(unpinnedReceipt.valid, true);
  assert.equal(unpinnedReceipt.keyPinned, false);
  assert.equal(verifyOutcomeReceipt(receipt, undefined, ["bad"]).valid, false);
  assert.equal(verifyOutcomeReceipt(receipt, undefined, [receipt.verifierKeyId, receipt.verifierKeyId]).valid, false);
  assert.equal(verifyOutcomeReceipt(receipt, rsaPublic).valid, false);
  const badReceiptKey = clone(receipt);
  badReceiptKey.signature.publicKey = "not-base64";
  assert.equal(verifyOutcomeReceipt(badReceiptKey, undefined, [receipt.verifierKeyId]).valid, false);
  assert.throws(() => assessOutcome(mandate, fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic, attempts: 0,
  }), /attempts/);
  assert.throws(() => assessOutcome(mandate, fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic, attempts: 1, costUsd: Number.NaN,
  }), /costUsd/);

  const malformed = join(fixture.directory, "malformed.json");
  const oversized = join(fixture.directory, "oversized.json");
  writeFileSync(malformed, "{");
  writeFileSync(oversized, "x".repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => loadOutcomeJson(malformed), /invalid/);
  assert.throws(() => loadOutcomeJson(oversized), /2 MiB/);
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "agent-vigil-outcome-"));
  const requesterPrivate = join(directory, "requester.pem");
  const requesterPublic = join(directory, "requester.pub.pem");
  const verifierPrivate = join(directory, "verifier.pem");
  const verifierPublic = join(directory, "verifier.pub.pem");
  const evidencePrivate = join(directory, "evidence.pem");
  const evidencePublic = join(directory, "evidence.pub.pem");
  const otherPrivate = join(directory, "other.pem");
  const otherPublic = join(directory, "other.pub.pem");
  generateSigningKey(requesterPrivate, requesterPublic);
  generateSigningKey(verifierPrivate, verifierPublic);
  generateSigningKey(evidencePrivate, evidencePublic);
  generateSigningKey(otherPrivate, otherPublic);

  const mandate = (overrides: Partial<OutcomeMandateInput> = {}): OutcomeMandate => createOutcomeMandate({
    createdAt: CREATED,
    expiresAt: EXPIRES,
    requesterId: "acme/platform",
    providerId: "coding-agent-7",
    taskId: "fix-1842",
    taskClass: "code-change",
    description: "Fix the retry race without weakening its regression tests",
    base: BASE,
    head: HEAD,
    minMeaningfulVerified: 2,
    requiredRuleIds: ["tests-pass", "test-integrity"],
    verifierKeyIds: [publicKeyId(verifierPublic)],
    adapter: "x402",
    settlementReference: "task-1842",
    ...overrides,
  }, requesterPrivate);

  const report = (
    results: CheckResult[] = [result("tests-pass", "verified"), result("test-integrity", "verified")],
    options: { base?: string; head?: string; signWith?: string } = {},
  ): TrustReport => {
    const built = buildReport({
      transcript: "fixture.jsonl",
      transcriptSha256: `sha256:${"a".repeat(64)}`,
      transcriptFormat: "jsonl",
      repo: directory,
      base: options.base ?? BASE,
      head: options.head ?? HEAD,
      results,
      reproduction: "npm test -- outcome.test.ts",
    });
    return options.signWith ? signReport(built, options.signWith) : built;
  };

  return { directory, requesterPrivate, requesterPublic, verifierPrivate, verifierPublic, evidencePrivate, evidencePublic, otherPrivate, otherPublic, mandate, report };
}
