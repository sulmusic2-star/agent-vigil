import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  verification: ChainVerification;
  decision: ContinuityDecision;
  privateKeyPath: string;
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
    verification,
    decision,
    privateKeyPath,
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

test("staple issuance rejects mismatched decisions, unsafe lifetimes, and the wrong key type", () => {
  for (const ttlSeconds of [0, 901, 1.5]) {
    const value = fixture();
    assert.throws(() => issueContinuityStaple({
      verification: value.verification,
      decision: value.decision,
      privateKeyPath: value.privateKeyPath,
      ttlSeconds,
    }), /TTL must be from 1 through 900/);
  }

  const variants: Array<[Partial<ContinuityDecision>, RegExp]> = [
    [{ protectedEnvironment: undefined }, /requires a protected environment/],
    [{ rootHash: digest("wrong-root") }, /does not match the verified root/],
    [{ chainTip: digest("wrong-tip") }, /does not match the verified chain tip/],
    [{ eventCount: 1 }, /does not match the complete event history/],
  ];
  for (const [override, pattern] of variants) {
    const value = fixture();
    assert.throws(() => issueContinuityStaple({
      verification: value.verification,
      decision: { ...value.decision, ...override },
      privateKeyPath: value.privateKeyPath,
    }), pattern);
  }

  const value = fixture();
  const rsaPath = join(mkdtempSync(join(tmpdir(), "agent-vigil-rsa-")), "private.pem");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(rsaPath, rsa.privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.throws(() => issueContinuityStaple({
    verification: value.verification,
    decision: value.decision,
    privateKeyPath: rsaPath,
  }), /signing key must be Ed25519/);
});

test("staple payload validation rejects malformed or internally inconsistent evidence", () => {
  const value = fixture();
  const baseOptions = { ...value.options, publicKeyPath: value.publicKeyPath };
  const cases: Array<[unknown, RegExp]> = [
    [null, /signed continuity staple must be an object/],
    [[], /signed continuity staple must be an object/],
    [{ ...value.staple, extra: true }, /signed continuity staple has unsupported or missing fields/],
    [{ ...value.staple, schemaVersion: "future" }, /unsupported signed continuity staple schema/],
    [{ ...value.staple, payload: null }, /payload must be an object/],
    [{ ...value.staple, payload: { ...value.staple.payload, extra: true } }, /payload has unsupported or missing fields/],
    [{ ...value.staple, payload: { ...value.staple.payload, schemaVersion: "future" } }, /unsupported continuity staple payload schema/],
    [{ ...value.staple, payload: { ...value.staple.payload, decision: null } }, /decision must be an object/],
    [{ ...value.staple, payload: { ...value.staple.payload, decision: { ...value.staple.payload.decision, extra: true } } }, /decision has unsupported or missing fields/],
    [{ ...value.staple, payload: { ...value.staple.payload, decision: { ...value.staple.payload.decision, continuity: "UNKNOWN" } } }, /continuity is unsupported/],
    [{ ...value.staple, payload: { ...value.staple.payload, decision: { ...value.staple.payload.decision, allowsProtectedAction: "yes" } } }, /allowsProtectedAction must be boolean/],
    [{ ...value.staple, payload: { ...value.staple.payload, decision: { ...value.staple.payload.decision, allowsProtectedAction: false } } }, /decision fields are inconsistent/],
    [{ ...value.staple, payload: { ...value.staple.payload, evidence: null } }, /evidence must be an object/],
    [{ ...value.staple, payload: { ...value.staple.payload, evidence: { ...value.staple.payload.evidence, extra: true } } }, /evidence has unsupported or missing fields/],
    [{ ...value.staple, payload: { ...value.staple.payload, evidence: { ...value.staple.payload.evidence, sequence: -1 } } }, /evidence.sequence must be an integer/],
    [{ ...value.staple, payload: { ...value.staple.payload, evidence: { ...value.staple.payload.evidence, eventCount: 100_001 } } }, /evidence.eventCount must be an integer/],
    [{ ...value.staple, payload: { ...value.staple.payload, evidence: { ...value.staple.payload.evidence, eventCount: 1 } } }, /sequence must equal/],
    [{ ...value.staple, payload: { ...value.staple.payload, policy: null } }, /policy must be an object/],
    [{ ...value.staple, payload: { ...value.staple.payload, policy: { ...value.staple.payload.policy, extra: true } } }, /policy has unsupported or missing fields/],
    [{ ...value.staple, payload: { ...value.staple.payload, issuedAt: 1 } }, /issuedAt must be canonical/],
    [{ ...value.staple, payload: { ...value.staple.payload, issuedAt: "2026-08-26" } }, /issuedAt must be canonical/],
    [{ ...value.staple, payload: { ...value.staple.payload, decision: { ...value.staple.payload.decision, evaluatedAt: "2026-08-26T12:00:01.000Z" } } }, /issue time must equal/],
    [{ ...value.staple, payload: { ...value.staple.payload, expiresAt: "2026-08-26T12:00:00.000Z" } }, /lifetime must be/],
    [{ ...value.staple, payload: { ...value.staple.payload, expiresAt: "2026-08-26T12:15:01.000Z" } }, /lifetime must be/],
    [{ ...value.staple, payload: { ...value.staple.payload, decision: { ...value.staple.payload.decision, decisionHash: "bad" } } }, /decisionHash must be a lowercase SHA-256/],
  ];
  for (const [input, pattern] of cases) assert.throws(() => verifyContinuityStaple(input, baseOptions), pattern);
});

test("staple signature validation rejects malformed, substituted, and unpinned keys", () => {
  const value = fixture();
  const baseOptions = { ...value.options, publicKeyPath: value.publicKeyPath };
  const clone = () => structuredClone(value.staple) as SignedContinuityStaple;

  const wrongHash = clone();
  wrongHash.payloadHash = digest("wrong-payload");
  assert.throws(() => verifyContinuityStaple(wrongHash, baseOptions), /payload hash is invalid/);

  const invalidSignatures: Array<[Partial<SignedContinuityStaple["signature"]> | null, RegExp]> = [
    [null, /signature must be an object/],
    [{ algorithm: "future" as "Ed25519" }, /algorithm must be Ed25519/],
    [{ publicKey: "!" }, /publicKey must be canonical base64/],
    [{ publicKey: Buffer.from("not a key").toString("base64") }, /embedded key is not a valid public key/],
    [{ keyId: "bad" }, /keyId must be a lowercase SHA-256/],
    [{ keyId: digest("other-key") }, /key ID does not match/],
    [{ value: "!" }, /signature.value must be canonical base64/],
    [{ value: Buffer.alloc(63).toString("base64") }, /invalid length or encoding/],
    [{ value: Buffer.alloc(64).toString("base64") }, /signature is invalid/],
  ];
  for (const [override, pattern] of invalidSignatures) {
    const staple = clone();
    staple.signature = override === null ? null as unknown as SignedContinuityStaple["signature"] : { ...staple.signature, ...override };
    assert.throws(() => verifyContinuityStaple(staple, baseOptions), pattern);
  }

  const extra = clone();
  (extra.signature as unknown as Record<string, unknown>).extra = true;
  assert.throws(() => verifyContinuityStaple(extra, baseOptions), /signature has unsupported or missing fields/);

  const other = fixture();
  assert.throws(() => verifyContinuityStaple(value.staple, { ...value.options, publicKeyPath: other.publicKeyPath }), /signer does not match/);
  assert.throws(() => verifyContinuityStaple(value.staple, { ...value.options, publicKeyPem: "not a key" }), /pinned continuity staple public key is invalid/);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => verifyContinuityStaple(value.staple, {
    ...value.options,
    publicKeyPem: rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }), /pinned continuity staple public key must be Ed25519/);
});

test("staple verification binds every deployment input and rejects stale or future evidence", () => {
  const value = fixture();
  const pem = readFileSync(value.publicKeyPath, "utf8");
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ expectedHead: "bad" }, /expected continuity staple head must be a full lowercase/],
    [{ expectedHead: "c".repeat(40) }, /different head commit/],
    [{ expectedReceiptHash: "bad" }, /expected continuity staple receipt hash must be a lowercase/],
    [{ expectedReceiptHash: digest("different-receipt") }, /different original receipt/],
    [{ expectedEnvironment: "" }, /protected environment/],
    [{ expectedEnvironment: "staging" }, /different protected environment/],
    [{ expectedPolicySha256: "bad" }, /expected continuity staple policy hash must be a lowercase/],
    [{ expectedPolicySha256: digest("different-policy") }, /different policy/],
    [{ expectedChainTip: "bad" }, /expected continuity staple chain tip must be a lowercase/],
    [{ expectedChainTip: digest("different-tip") }, /does not match the expected chain tip/],
    [{ minimumSequence: -1 }, /minimum continuity staple sequence must be an integer/],
    [{ minimumSequence: 3 }, /predates the minimum accepted evidence sequence/],
    [{ now: new Date("invalid") }, /verification time is invalid/],
    [{ now: new Date("2026-08-26T11:58:59.000Z") }, /implausibly future-dated/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(() => verifyContinuityStaple(value.staple, {
      ...value.options,
      ...override,
      publicKeyPem: pem,
    } as Parameters<typeof verifyContinuityStaple>[1]), pattern);
  }

  const expired = verifyContinuityStaple(value.staple, {
    ...value.options,
    publicKeyPem: pem,
    now: new Date("2026-08-26T12:05:00.000Z"),
  });
  assert.equal(expired.fresh, false);
  assert.equal(expired.effectiveContinuity, "EXPIRED");
  assert.equal(expired.allowsProtectedAction, false);

  const revokedFixture = fixture();
  const revoked = issueContinuityStaple({
    verification: revokedFixture.verification,
    decision: { ...revokedFixture.decision, continuity: "REVOKED", allowsProtectedAction: false },
    privateKeyPath: revokedFixture.privateKeyPath,
  });
  const verifiedRevoked = verifyContinuityStaple(revoked, {
    ...revokedFixture.options,
    publicKeyPath: revokedFixture.publicKeyPath,
    now: new Date("2026-08-26T12:10:00.000Z"),
  });
  assert.equal(verifiedRevoked.fresh, false);
  assert.equal(verifiedRevoked.effectiveContinuity, "REVOKED");
  assert.equal(verifiedRevoked.allowsProtectedAction, false);
});

test("staple JSON parser rejects non-string input without coercion", () => {
  assert.throws(() => parseContinuityStapleJson(1 as unknown as string), /byte limit/);
});
