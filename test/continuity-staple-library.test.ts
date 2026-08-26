import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChainVerification } from "../src/continuity/chain.ts";
import { canonicalSha256, type ContinuityEvent, type ContinuityRoot } from "../src/continuity/contracts.ts";
import type { ContinuityDecision } from "../src/continuity/decision.ts";
import { issueContinuityStaple } from "../src/continuity/staple.ts";
import {
  parseContinuityStapleJson,
  verifyContinuityStaple,
  type SignedContinuityStaple,
} from "../src/continuity-staple-library.ts";
import type { TrustReport } from "../src/report.ts";
import { generateSigningKey } from "../src/signature.ts";

function digest(label: string): string {
  return canonicalSha256({ label });
}

function fixture(): {
  staple: SignedContinuityStaple;
  publicKeyPath: string;
  options: {
    expectedReceiptHash: string;
    expectedHead: string;
    expectedEnvironment: string;
    expectedPolicySha256: string;
    expectedChainTip: string;
    minimumSequence: number;
    now: Date;
  };
} {
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-library-"));
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.pem");
  generateSigningKey(privateKeyPath, publicKeyPath);
  const subject = {
    episodeReceiptHash: digest("library-receipt"),
    repositoryHash: digest("library-repository"),
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  const rootHash = digest("library-root");
  const chainTip = digest("library-chain-tip");
  const policyHash = digest("library-policy");
  const continuityRoot: ContinuityRoot = {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: digest("library-receipt-file"),
    receiptHash: subject.episodeReceiptHash,
    rootHash,
    subject,
    historicalVerification: "PASS",
    createdAt: "2026-08-26T11:00:00.000Z",
  };
  const verification: ChainVerification = {
    valid: true,
    errors: [],
    root: continuityRoot,
    report: {} as TrustReport,
    events: [{ sequence: 1 }, { sequence: 2 }] as ContinuityEvent[],
    chainTip,
    rootSignature: { present: true, valid: true, keyId: digest("library-root-key") },
  };
  const decision: ContinuityDecision = {
    schemaVersion: "agent-vigil-continuity-decision/v1",
    evaluatedAt: "2026-08-26T12:00:00.000Z",
    historicalVerification: "PASS",
    continuity: "CURRENT",
    allowsProtectedAction: true,
    protectedEnvironment: "production",
    rootHash,
    chainTip,
    eventCount: 2,
    policy: { sourceHash: digest("library-policy-source"), sha256: policyHash },
    outcomeFacts: [],
    reasons: [],
    decisionHash: digest("library-decision"),
  };
  return {
    staple: issueContinuityStaple({ verification, decision, privateKeyPath, ttlSeconds: 300 }),
    publicKeyPath,
    options: {
      expectedReceiptHash: subject.episodeReceiptHash,
      expectedHead: subject.headSha,
      expectedEnvironment: "production",
      expectedPolicySha256: policyHash,
      expectedChainTip: chainTip,
      minimumSequence: 2,
      now: new Date("2026-08-26T12:01:00.000Z"),
    },
  };
}

test("the public TypeScript API accepts a file path or identical in-memory pinned key", () => {
  const value = fixture();
  const fromPath = verifyContinuityStaple(value.staple, { ...value.options, publicKeyPath: value.publicKeyPath });
  const fromPem = verifyContinuityStaple(value.staple, { ...value.options, publicKeyPem: readFileSync(value.publicKeyPath) });
  assert.deepEqual(fromPem, fromPath);
  assert.equal(fromPem.effectiveContinuity, "CURRENT");
  assert.equal(fromPem.allowsProtectedAction, true);
});

test("the public TypeScript API bounds JSON and fails closed on ambiguous or wrong keys", () => {
  const value = fixture();
  const parsed = parseContinuityStapleJson(`${JSON.stringify(value.staple)}\n`);
  assert.equal(verifyContinuityStaple(parsed, { ...value.options, publicKeyPem: readFileSync(value.publicKeyPath, "utf8") }).allowsProtectedAction, true);
  assert.throws(() => parseContinuityStapleJson("{"), /malformed/);
  assert.throws(() => parseContinuityStapleJson("x".repeat(256 * 1024 + 1)), /byte limit/);
  assert.throws(() => verifyContinuityStaple(value.staple, {
    ...value.options,
    publicKeyPath: value.publicKeyPath,
    publicKeyPem: readFileSync(value.publicKeyPath),
  } as unknown as Parameters<typeof verifyContinuityStaple>[1]), /exactly one/);
});
