import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { signGuardControlAdmission } from "../src/guard-control-protocol.ts";
import { buildGuardDeploymentAuthorization, gateGuardDeploymentAuthorization } from "../src/guard-deployment-authorization.ts";
import { guardDigest } from "../src/guard-compat.ts";
import type { GuardSigner } from "../src/guard-signing.ts";
import { publicKeyDer, signingKeyId } from "../src/signature.ts";

function signer(): GuardSigner {
  const keys = generateKeyPairSync("ed25519");
  return { provider: "local-ed25519", keyId: signingKeyId(publicKeyDer(keys.publicKey)), publicKey: keys.publicKey,
    sign: (message) => sign(null, message, keys.privateKey) };
}

function fixture() {
  const admissionSigner = signer();
  const deploymentSigner = signer();
  const roles = Array.from({ length: 5 }, (_, index) => guardDigest(`role-${index}`));
  const admission = signGuardControlAdmission({
    schemaVersion: "agent-vigil-control-admission/v1",
    evaluatedAt: "2026-09-03T18:00:00.000Z",
    validUntil: "2026-09-03T19:00:00.000Z",
    decision: "APPROVE",
    artifact: { host: "codex", version: "future-1", executableSha256: guardDigest("package") },
    environmentSha256: guardDigest("environment"),
    evidence: {
      current: { challengeHash: guardDigest("cc"), observationHash: guardDigest("co"), routeReceiptHash: guardDigest("cr"), isolationHash: guardDigest("ci") },
      candidate: { challengeHash: guardDigest("nc"), observationHash: guardDigest("no"), routeReceiptHash: guardDigest("nr"), isolationHash: guardDigest("ni") },
      routeDecisionHash: guardDigest("decision"),
    },
    trust: { challengeSignerKeyId: roles[0], observerSignerKeyId: roles[1], routeSignerKeyId: roles[2],
      environmentSignerKeyId: roles[3], isolationSignerKeyId: roles[4], admissionSignerKeyId: admissionSigner.keyId },
    reasonCodes: ["EXACT_CONTROL_ADMISSION_PROVEN"],
    limitations: ["Focused test fixture."],
  }, admissionSigner);
  return { admissionSigner, deploymentSigner, admission };
}

test("deployment authorization narrows an admission to exact GitHub and artifact identities", () => {
  const value = fixture();
  const commitSha = "a".repeat(40);
  const authorization = buildGuardDeploymentAuthorization({
    admissionEnvelope: value.admission.envelope,
    admissionPublicKey: value.admissionSigner.publicKey,
    repository: "outside/repository",
    commitSha,
    environment: "production",
    deploymentSigner: value.deploymentSigner,
    issuedAt: "2026-09-03T18:10:00.000Z",
    validUntil: "2026-09-03T18:25:00.000Z",
  });
  const input = {
    authorizationEnvelope: authorization.envelope,
    deploymentPublicKey: value.deploymentSigner.publicKey,
    admissionEnvelope: value.admission.envelope,
    admissionPublicKey: value.admissionSigner.publicKey,
    repository: "outside/repository",
    commitSha,
    environment: "production",
    expectedArtifactSha256: guardDigest("package"),
    expectedManagedEnvironmentSha256: guardDigest("environment"),
    asOf: "2026-09-03T18:15:00.000Z",
  };
  assert.equal(gateGuardDeploymentAuthorization(input).authorizationHash, authorization.authorization.authorizationHash);
  assert.throws(() => gateGuardDeploymentAuthorization({ ...input, commitSha: "b".repeat(40) }), /different commit/);
  assert.throws(() => gateGuardDeploymentAuthorization({ ...input, expectedArtifactSha256: guardDigest("tampered") }), /different artifact/);
});

test("admission and deployment roles must be distinct", () => {
  const value = fixture();
  assert.throws(() => buildGuardDeploymentAuthorization({
    admissionEnvelope: value.admission.envelope,
    admissionPublicKey: value.admissionSigner.publicKey,
    repository: "outside/repository",
    commitSha: "a".repeat(40),
    environment: "production",
    deploymentSigner: value.admissionSigner,
    issuedAt: "2026-09-03T18:10:00.000Z",
  }), /must be distinct/);
});
