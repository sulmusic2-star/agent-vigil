import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import {
  assessOutcome,
  buildSettlementAdapterPayload,
  createOutcomeMandate,
  loadOutcomeJson,
  validateOutcomeReceipt,
  verifyOutcomeMandate,
  verifyOutcomeReceipt,
  type OutcomeAdapter,
  type OutcomeMandate,
  type OutcomeMandateInput,
  type OutcomeReceipt,
} from "../src/outcome.ts";
import { buildReport, type CheckResult, type TrustReport } from "../src/report.ts";
import { generateSigningKey, publicKeyId, signReport } from "../src/signature.ts";

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

function mutableObject(value: unknown, label = "fixture"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nestedObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return mutableObject(parent[key], key);
}

function captureConsole(callback: () => number): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousLog = console.log;
  const previousError = console.error;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  try { return { code: callback(), stdout: stdout.join("\n"), stderr: stderr.join("\n") }; }
  finally {
    console.log = previousLog;
    console.error = previousError;
  }
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

test("Outcome verification rejects unknown fields and hard-rejects a forged report summary", () => {
  const fixture = setup();
  const mandate = fixture.mandate();
  const unknown = { ...mandate, paymentApi: "https://example.invalid/release" };
  assert.equal(verifyOutcomeMandate(unknown, fixture.requesterPublic).valid, false);

  const forged = fixture.report([result("tests-pass", "contradicted")]);
  forged.summary = { verified: 1, contradicted: 0, unverifiable: 0, meaningfulVerified: 1, status: "PASS", pass: true };
  assert.throws(() => assessOutcome(mandate, forged, fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  }), /receipt summary\.verified does not match results and policy/);
});

test("Outcome assessment records a stale hash as FAIL but rejects malformed nested reports", () => {
  const fixture = setup();
  const mandate = fixture.mandate();
  const stale = clone(fixture.report());
  stale.results[0].evidence = "changed after the receipt hash was computed";
  const failed = assessOutcome(mandate, stale, fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  assert.equal(failed.verdict, "FAIL");
  assert.equal(failed.checks.find((item) => item.id === "evidence-integrity")?.verdict, "FAIL");
  assert.equal(verifyOutcomeReceipt(failed, fixture.verifierPublic).valid, true);

  const malformed = mutableObject(clone(fixture.report()));
  const results = malformed.results as unknown[];
  nestedObject(mutableObject(results[0]), "claim").unexpected = true;
  assert.throws(() => assessOutcome(mandate, malformed, fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    attempts: 1,
  }), /receipt results\[0\]\.claim has unsupported or missing fields/);
});

test("Outcome assessment uses the detached report snapshot returned by validateTrustReport", () => {
  const fixture = setup();
  const report = fixture.report();
  const originalHash = report.receiptHash;
  Object.defineProperty(report, "receiptHash", {
    configurable: true,
    enumerable: true,
    get() {
      report.base = OTHER_BASE;
      report.results[0].verdict = "contradicted";
      return originalHash;
    },
  });
  const receipt = assessOutcome(fixture.mandate(), report, fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  assert.equal(report.base, OTHER_BASE);
  assert.equal(report.results[0].verdict, "contradicted");
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.sourceEvidence.base, BASE);
  assert.equal(receipt.checks.find((item) => item.id === "exact-base")?.verdict, "PASS");
});

test("validateOutcomeReceipt requires closed signed content and pinned verifier trust", () => {
  const fixture = setup();
  const receipt = assessOutcome(fixture.mandate(), fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  const verifierKeyId = publicKeyId(fixture.verifierPublic);
  const validated = validateOutcomeReceipt(receipt, { trustedKeyIds: [verifierKeyId] });
  assert.deepEqual(validated, receipt);
  assert.notEqual(validated, receipt);
  receipt.checks[0].evidence = "mutated after validation";
  assert.notEqual(validated.checks[0].evidence, receipt.checks[0].evidence);

  const fresh = assessOutcome(fixture.mandate(), fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  assert.throws(() => validateOutcomeReceipt(fresh, {}), /requires a pinned verifier/);
  assert.throws(() => validateOutcomeReceipt(fresh, { trustedKeyIds: [`sha256:${"0".repeat(64)}`] }), /verifier key ID is not trusted/);

  const unknown = clone(fresh) as OutcomeReceipt & { unexpected?: boolean };
  unknown.unexpected = true;
  assert.throws(() => validateOutcomeReceipt(unknown, { verifierPublicKeyPath: fixture.verifierPublic }), /unsupported field/);

  const stale = clone(fresh);
  stale.checks[0].evidence = "changed after outcome signing";
  assert.throws(() => validateOutcomeReceipt(stale, { verifierPublicKeyPath: fixture.verifierPublic }), /content hash is invalid/);

  const badSignature = clone(fresh);
  badSignature.signature.value = Buffer.from("bad signature").toString("base64");
  assert.throws(() => validateOutcomeReceipt(badSignature, { verifierPublicKeyPath: fixture.verifierPublic }), /signature is invalid/);
});

test("Outcome Git identities and schemas accept exactly 40 or 64 lowercase hex characters", () => {
  const fixture = setup();
  for (const length of [41, 63]) {
    assert.throws(
      () => createOutcomeMandate(fixture.mandateInput({ base: "a".repeat(length) }), fixture.requesterPrivate),
      /exact 40- or 64-character lowercase Git object ID/,
    );
  }
  assert.throws(
    () => createOutcomeMandate(fixture.mandateInput({ head: BASE }), fixture.requesterPrivate),
    /task\.base and task\.head must differ/,
  );
  const base64 = "a".repeat(64);
  const head64 = "b".repeat(64);
  const mandate64 = fixture.mandate({ base: base64, head: head64 });
  const receipt64 = assessOutcome(mandate64, fixture.report(undefined, { base: base64, head: head64 }), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  assert.equal(receipt64.verdict, "PASS");

  const sparseRules: string[] = [];
  sparseRules.length = 1;
  assert.throws(() => fixture.mandate({ requiredRuleIds: sparseRules }), /dense array of non-empty strings/);

  for (const schemaUrl of [
    new URL("../docs/outcome-mandate-v0.1.schema.json", import.meta.url),
    new URL("../docs/outcome-receipt-v0.1.schema.json", import.meta.url),
  ]) {
    const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as { $defs: { gitOid: { pattern: string } } };
    const pattern = new RegExp(schema.$defs.gitOid.pattern);
    assert.equal(pattern.test("a".repeat(40)), true);
    assert.equal(pattern.test("a".repeat(64)), true);
    assert.equal(pattern.test("a".repeat(41)), false);
    assert.equal(pattern.test("a".repeat(63)), false);
  }
});

test("Outcome JSON and signing-key reads reject links and oversized files", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-vigil-outcome-read-"));
  const json = join(directory, "outcome.json");
  const jsonLink = join(directory, "outcome-link.json");
  writeFileSync(json, "{}\n");
  symlinkSync(json, jsonLink);
  assert.throws(() => loadOutcomeJson(jsonLink), /regular file, not a symbolic link/);

  const oversizedJson = join(directory, "oversized.json");
  writeFileSync(oversizedJson, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  assert.throws(() => loadOutcomeJson(oversizedJson), /exceeds the 2097152 byte limit/);

  const fixture = setup();
  const requesterPrivateLink = join(directory, "requester-private-link.pem");
  const requesterPublicLink = join(directory, "requester-public-link.pem");
  const verifierPrivateLink = join(directory, "verifier-private-link.pem");
  const verifierPublicLink = join(directory, "verifier-public-link.pem");
  symlinkSync(fixture.requesterPrivate, requesterPrivateLink);
  symlinkSync(fixture.requesterPublic, requesterPublicLink);
  symlinkSync(fixture.verifierPrivate, verifierPrivateLink);
  symlinkSync(fixture.verifierPublic, verifierPublicLink);

  assert.throws(() => createOutcomeMandate(fixture.mandateInput(), requesterPrivateLink), /regular file, not a symbolic link/);
  assert.match(verifyOutcomeMandate(fixture.mandate(), requesterPublicLink).errors.join("\n"), /regular file, not a symbolic link/);
  assert.throws(() => assessOutcome(fixture.mandate(), fixture.report(), verifierPrivateLink, {
    requesterPublicKeyPath: fixture.requesterPublic,
    attempts: 1,
  }), /regular file, not a symbolic link/);

  const receipt = assessOutcome(fixture.mandate(), fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    attempts: 1,
  });
  assert.match(verifyOutcomeReceipt(receipt, verifierPublicLink).errors.join("\n"), /regular file, not a symbolic link/);

  const oversizedKey = join(directory, "oversized.pem");
  writeFileSync(oversizedKey, Buffer.alloc(64 * 1024 + 1, 0x41));
  assert.throws(() => createOutcomeMandate(fixture.mandateInput(), oversizedKey), /exceeds the 65536 byte limit/);
});

test("Top-level outcome CLI dispatch exposes help and terminal-safes attacker-derived text", () => {
  const help = captureConsole(() => run(["--help"]));
  assert.equal(help.code, 0);
  assert.match(help.stdout, /vigil mandate create/);
  assert.match(help.stdout, /vigil receipt verify/);

  const mandateHelp = captureConsole(() => run(["mandate", "--help"]));
  const receiptHelp = captureConsole(() => run(["receipt", "--help"]));
  assert.equal(mandateHelp.code, 0);
  assert.equal(receiptHelp.code, 0);
  assert.match(mandateHelp.stdout, /--max-attempts/);
  assert.match(receiptHelp.stdout, /receipt signal/);

  const hostile = captureConsole(() => run(["mandate", `unknown\u001b[31m\u202E`]));
  assert.equal(hostile.code, 2);
  assert.doesNotMatch(hostile.stderr, /\u001b|\u202e/);
  assert.match(hostile.stderr, /\\u\{001B\}/);
  assert.match(hostile.stderr, /\\u\{202E\}/);

  const missingPath = join(tmpdir(), `missing-outcome\u001b[31m\u202E.json`);
  const missing = captureConsole(() => run(["mandate", "verify", missingPath]));
  assert.equal(missing.code, 2);
  assert.doesNotMatch(missing.stderr, /\u001b|\u202e/);
  assert.match(missing.stderr, /\\u\{001B\}/);
  assert.match(missing.stderr, /\\u\{202E\}/);

  const fixture = setup();
  const hostileMandate = clone(fixture.mandate()) as OutcomeMandate & Record<string, unknown>;
  hostileMandate[`unsupported\u001b[31m\u202E`] = true;
  const hostilePath = join(mkdtempSync(join(tmpdir(), "agent-vigil-outcome-hostile-")), "mandate.json");
  writeFileSync(hostilePath, `${JSON.stringify(hostileMandate)}\n`);
  const verified = captureConsole(() => run(["mandate", "verify", hostilePath, "--requester-public-key", fixture.requesterPublic]));
  assert.equal(verified.code, 1);
  assert.doesNotMatch(verified.stdout, /\u001b|\u202e/);
  assert.match(verified.stdout, /\\u\{001B\}/);
  assert.match(verified.stdout, /\\u\{202E\}/);

  const documentation = readFileSync(new URL("../docs/OUTCOME_MANDATES.md", import.meta.url), "utf8");
  assert.match(documentation, /--attempts 1/);
  assert.match(documentation, /`--attempts` is required by the CLI/);
});

test("CLI signal JSON escapes unsafe display code points without changing parsed data", () => {
  const fixture = setup();
  const reference = "task-safe\u202Ehidden";
  const receipt = assessOutcome(fixture.mandate({ settlementReference: reference }), fixture.report(), fixture.verifierPrivate, {
    requesterPublicKeyPath: fixture.requesterPublic,
    issuedAt: "2026-08-27T12:00:00.000Z",
    attempts: 1,
  });
  const receiptPath = join(mkdtempSync(join(tmpdir(), "agent-vigil-outcome-cli-")), "receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const rendered = captureConsole(() => run(["receipt", "signal", receiptPath, "--verifier-public-key", fixture.verifierPublic]));
  assert.equal(rendered.code, 0);
  assert.doesNotMatch(rendered.stdout, /\u202e/);
  assert.match(rendered.stdout, /\\u202E/);
  const parsed = JSON.parse(rendered.stdout) as { reference: string; networkAction: string };
  assert.equal(parsed.reference, reference);
  assert.equal(parsed.networkAction, "NONE");
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

  const mandateInput = (overrides: Partial<OutcomeMandateInput> = {}): OutcomeMandateInput => ({
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
  });

  const mandate = (overrides: Partial<OutcomeMandateInput> = {}): OutcomeMandate => createOutcomeMandate(mandateInput(overrides), requesterPrivate);

  const report = (
    results: CheckResult[] = [result("tests-pass", "verified"), result("test-integrity", "verified")],
    options: { base?: string; head?: string; signWith?: string } = {},
  ): TrustReport => {
    const built = buildReport({
      transcript: "fixture.jsonl",
      transcriptSha256: `sha256:${"a".repeat(64)}`,
      transcriptFormat: "codex",
      repo: directory,
      base: options.base ?? BASE,
      head: options.head ?? HEAD,
      results,
      reproduction: "npm test -- outcome.test.ts",
    });
    return options.signWith ? signReport(built, options.signWith) : built;
  };

  return { requesterPrivate, requesterPublic, verifierPrivate, verifierPublic, evidencePrivate, evidencePublic, otherPrivate, otherPublic, mandateInput, mandate, report };
}
