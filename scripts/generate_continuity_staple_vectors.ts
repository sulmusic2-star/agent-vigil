import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChainVerification } from "../src/continuity/chain.ts";
import { canonicalSha256, type ContinuityEvent, type ContinuityRoot, type ContinuityState } from "../src/continuity/contracts.ts";
import type { ContinuityDecision } from "../src/continuity/decision.ts";
import { issueContinuityStaple } from "../src/continuity/staple.ts";
import type { TrustReport } from "../src/report.ts";

const output = resolve("test-vectors/continuity-staple/v1");
const scratch = mkdtempSync(join(tmpdir(), "agent-vigil-vector-generation-"));

function digest(label: string): string {
  return canonicalSha256({ label });
}

function fileSha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

try {
  mkdirSync(output, { recursive: true });
  const privatePath = join(scratch, "test-only-private.pem");
  const seed = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  const privateDer = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  writeFileSync(privatePath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(join(output, "authority-public.pem"), publicKey.export({ format: "pem", type: "spki" }));

  const subject = {
    episodeReceiptHash: digest("vector-receipt"),
    repositoryHash: digest("vector-repository"),
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
  };
  const rootHash = digest("vector-root");
  const chainTip = digest("vector-chain-tip");
  const policySha256 = digest("vector-policy");
  const issuedAt = "2030-01-01T00:00:00.000Z";
  const root: ContinuityRoot = {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: digest("vector-receipt-file"),
    receiptHash: subject.episodeReceiptHash,
    rootHash,
    subject,
    historicalVerification: "PASS",
    createdAt: "2029-12-31T23:59:00.000Z",
  };
  const verification: ChainVerification = {
    valid: true,
    errors: [],
    root,
    report: {} as TrustReport,
    events: [{ sequence: 1 }, { sequence: 2 }] as ContinuityEvent[],
    chainTip,
    rootSignature: { present: true, valid: true, keyId: digest("vector-root-key") },
  };
  const stapleFor = (continuity: ContinuityState) => {
    const decision: ContinuityDecision = {
      schemaVersion: "agent-vigil-continuity-decision/v1",
      evaluatedAt: issuedAt,
      historicalVerification: "PASS",
      continuity,
      allowsProtectedAction: continuity === "CURRENT",
      protectedEnvironment: "production",
      rootHash,
      chainTip,
      eventCount: 2,
      policy: { sourceHash: digest("vector-policy-source"), sha256: policySha256 },
      outcomeFacts: [],
      reasons: [],
      decisionHash: digest(`vector-decision-${continuity}`),
    };
    return issueContinuityStaple({ verification, decision, privateKeyPath: privatePath, ttlSeconds: 300 });
  };

  const currentPath = join(output, "current.staple.json");
  const revokedPath = join(output, "revoked.staple.json");
  const tamperedPath = join(output, "tampered.staple.json");
  const current = stapleFor("CURRENT");
  writeFileSync(currentPath, `${JSON.stringify(current, null, 2)}\n`);
  writeFileSync(revokedPath, `${JSON.stringify(stapleFor("REVOKED"), null, 2)}\n`);
  const tampered = structuredClone(current);
  tampered.payload.decision.continuity = "HOLD";
  tampered.payload.decision.allowsProtectedAction = false;
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);

  const manifest = {
    schemaVersion: "agent-vigil-continuity-staple-test-vectors/v1",
    generatedBy: "scripts/generate_continuity_staple_vectors.ts",
    algorithm: "Ed25519",
    privateKeyIncluded: false,
    bindings: {
      expectedReceiptHash: subject.episodeReceiptHash,
      expectedHead: subject.headSha,
      expectedEnvironment: "production",
      expectedPolicySha256: policySha256,
      expectedChainTip: chainTip,
      minimumSequence: 2,
    },
    times: {
      freshVerification: "2030-01-01T00:01:00.000Z",
      expiredVerification: "2030-01-01T00:06:00.000Z",
    },
    files: {
      "authority-public.pem": fileSha256(join(output, "authority-public.pem")),
      "current.staple.json": fileSha256(currentPath),
      "revoked.staple.json": fileSha256(revokedPath),
      "tampered.staple.json": fileSha256(tamperedPath),
    },
    expectations: [
      { file: "current.staple.json", time: "freshVerification", result: "CURRENT", allowsProtectedAction: true },
      { file: "current.staple.json", time: "expiredVerification", result: "EXPIRED", allowsProtectedAction: false },
      { file: "revoked.staple.json", time: "expiredVerification", result: "REVOKED", allowsProtectedAction: false },
      { file: "tampered.staple.json", time: "freshVerification", result: "ERROR", allowsProtectedAction: false },
    ],
    limits: [
      "The public key and staples are test material and must not be trusted for a protected action.",
      "Verification uses the manifest time so the fixed vector remains reproducible; production verification must use the current trusted clock.",
    ],
  };
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Wrote deterministic Continuity Staple vectors to ${output}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
