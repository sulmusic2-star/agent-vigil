import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runGuardDeployAuthorizeCommand,
  runGuardDeployBoundGateCommand,
  runGuardDeployRegisterCommand,
} from "../src/guard-admission-cli.ts";
import {
  buildGuardDeploymentAuthorization,
  buildGuardDeploymentRegistration,
  gateGuardDeploymentAuthorization,
  openGuardDeploymentAuthorization,
} from "../src/guard-deployment-authorization.ts";
import { signGuardControlAdmission, type GuardControlAdmission } from "../src/guard-control-protocol.ts";
import { guardDigest } from "../src/guard-compat.ts";
import type { GuardSigner } from "../src/guard-signing.ts";
import { publicKeyDer, signingKeyId } from "../src/signature.ts";

const issuedAt = "2026-09-03T16:00:00.000Z";
const validUntil = "2026-09-03T16:30:00.000Z";
const commitSha = "a".repeat(40);

function signer(): GuardSigner {
  const keys = generateKeyPairSync("ed25519");
  return {
    provider: "local-ed25519",
    keyId: signingKeyId(publicKeyDer(keys.publicKey)),
    publicKey: keys.publicKey,
    sign: (message) => sign(null, message, keys.privateKey),
  };
}

function fixture(decision: "APPROVE" | "HOLD" = "APPROVE") {
  const admissionSigner = signer();
  const deploymentSigner = signer();
  const roleIds = Array.from({ length: 5 }, (_, index) => guardDigest(`role-${index}`));
  const unsigned: Omit<GuardControlAdmission, "admissionHash"> = {
    schemaVersion: "agent-vigil-control-admission/v1",
    evaluatedAt: "2026-09-03T15:55:00.000Z",
    validUntil: "2026-09-03T16:55:00.000Z",
    decision,
    artifact: { host: "codex", version: "future-1", executableSha256: guardDigest("exact-package-bytes") },
    environmentSha256: guardDigest("managed-environment"),
    evidence: {
      current: { challengeHash: guardDigest("cc"), observationHash: guardDigest("co"), routeReceiptHash: guardDigest("cr"), isolationHash: guardDigest("ci") },
      candidate: { challengeHash: guardDigest("nc"), observationHash: guardDigest("no"), routeReceiptHash: guardDigest("nr"), isolationHash: guardDigest("ni") },
      routeDecisionHash: guardDigest("decision"),
    },
    trust: {
      challengeSignerKeyId: roleIds[0], observerSignerKeyId: roleIds[1], routeSignerKeyId: roleIds[2],
      environmentSignerKeyId: roleIds[3], isolationSignerKeyId: roleIds[4], admissionSignerKeyId: admissionSigner.keyId,
    },
    reasonCodes: [decision === "APPROVE" ? "EXACT_CONTROL_ADMISSION_PROVEN" : "CONTROL_REGRESSION"],
    limitations: ["Synthetic deployment authorization fixture."],
  };
  const admission = signGuardControlAdmission(unsigned, admissionSigner);
  return { admissionSigner, deploymentSigner, admission };
}

function authorize(f: ReturnType<typeof fixture>) {
  return buildGuardDeploymentAuthorization({
    admissionEnvelope: f.admission.envelope,
    admissionPublicKey: f.admissionSigner.publicKey,
    repository: "outside-owner/production-service",
    commitSha,
    environment: "production",
    deploymentSigner: f.deploymentSigner,
    issuedAt,
    validUntil,
  });
}

test("deployment authorization binds one approved admission to repository, commit, and environment", () => {
  const f = fixture();
  const result = authorize(f);
  const opened = openGuardDeploymentAuthorization(result.envelope, f.deploymentSigner.publicKey);
  assert.equal(opened.authorization.admissionHash, f.admission.admission.admissionHash);
  assert.equal(opened.authorization.commitSha, commitSha);
  assert.equal(opened.authorization.trust.admissionSignerKeyId, f.admissionSigner.keyId);
  assert.equal(gateGuardDeploymentAuthorization({
    authorizationEnvelope: result.envelope,
    deploymentPublicKey: f.deploymentSigner.publicKey,
    admissionEnvelope: f.admission.envelope,
    admissionPublicKey: f.admissionSigner.publicKey,
    repository: "outside-owner/production-service",
    commitSha,
    environment: "production",
    expectedArtifactSha256: f.admission.admission.artifact.executableSha256,
    expectedManagedEnvironmentSha256: f.admission.admission.environmentSha256,
    asOf: "2026-09-03T16:10:00.000Z",
  }).authorizationHash, result.authorization.authorizationHash);
  const registration = buildGuardDeploymentRegistration({
    authorizationEnvelope: result.envelope,
    deploymentPublicKey: f.deploymentSigner.publicKey,
    admissionEnvelope: f.admission.envelope,
    admissionPublicKey: f.admissionSigner.publicKey,
    asOf: "2026-09-03T16:10:00.000Z",
  });
  assert.equal(registration.registration.schemaVersion, "agent-vigil-deployment-registration/v1");
  assert.equal(registration.authorization.authorizationHash, result.authorization.authorizationHash);
});

test("repository, commit, environment, artifact, admission, and time mismatches fail closed", () => {
  const f = fixture();
  const result = authorize(f);
  const input = {
    authorizationEnvelope: result.envelope,
    deploymentPublicKey: f.deploymentSigner.publicKey,
    admissionEnvelope: f.admission.envelope,
    admissionPublicKey: f.admissionSigner.publicKey,
    repository: "outside-owner/production-service",
    commitSha,
    environment: "production",
    expectedArtifactSha256: f.admission.admission.artifact.executableSha256,
    expectedManagedEnvironmentSha256: f.admission.admission.environmentSha256,
    asOf: "2026-09-03T16:10:00.000Z",
  };
  assert.throws(() => gateGuardDeploymentAuthorization({ ...input, repository: "other/service" }), /different repository/);
  assert.throws(() => gateGuardDeploymentAuthorization({ ...input, commitSha: "b".repeat(40) }), /different commit/);
  assert.throws(() => gateGuardDeploymentAuthorization({ ...input, environment: "staging" }), /different GitHub environment/);
  assert.throws(() => gateGuardDeploymentAuthorization({ ...input, expectedArtifactSha256: guardDigest("tampered") }), /artifact bytes/);
  assert.throws(() => gateGuardDeploymentAuthorization({ ...input, expectedManagedEnvironmentSha256: guardDigest("other") }), /managed environment/);
  assert.throws(() => gateGuardDeploymentAuthorization({ ...input, asOf: "2026-09-03T16:31:00.000Z" }), /not currently valid/);

  const another = fixture();
  assert.throws(() => gateGuardDeploymentAuthorization({
    ...input, admissionEnvelope: another.admission.envelope, admissionPublicKey: another.admissionSigner.publicKey,
  }), /different control admission/);
});

test("tampering and the wrong deployment key cannot produce an authorization", () => {
  const f = fixture();
  const result = authorize(f);
  const tampered = structuredClone(result.envelope);
  const payload = JSON.parse(Buffer.from(tampered.payload, "base64").toString("utf8"));
  payload.environment = "staging";
  tampered.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  assert.throws(() => openGuardDeploymentAuthorization(tampered, f.deploymentSigner.publicKey), /signature is invalid/);
  assert.throws(() => openGuardDeploymentAuthorization(result.envelope, signer().publicKey), /signature is invalid/);
});

test("HOLD admissions, reused trust keys, excessive lifetimes, and unsafe identities are rejected", () => {
  const hold = fixture("HOLD");
  assert.throws(() => authorize(hold), /HOLD admission/);

  const sameKey = fixture();
  assert.throws(() => buildGuardDeploymentAuthorization({
    admissionEnvelope: sameKey.admission.envelope,
    admissionPublicKey: sameKey.admissionSigner.publicKey,
    repository: "owner/repo", commitSha, environment: "production",
    deploymentSigner: sameKey.admissionSigner, issuedAt, validUntil,
  }), /must be distinct/);

  const f = fixture();
  assert.throws(() => buildGuardDeploymentAuthorization({
    admissionEnvelope: f.admission.envelope, admissionPublicKey: f.admissionSigner.publicKey,
    repository: "owner/repo", commitSha, environment: "production", deploymentSigner: f.deploymentSigner,
    issuedAt, validUntil: "2026-09-03T17:00:01.000Z",
  }), /cannot outlive|at most one hour/);
  assert.throws(() => buildGuardDeploymentAuthorization({
    admissionEnvelope: f.admission.envelope, admissionPublicKey: f.admissionSigner.publicKey,
    repository: "owner/repo\nattack", commitSha, environment: "production", deploymentSigner: f.deploymentSigner,
    issuedAt, validUntil,
  }), /safe non-empty text|repository is invalid/);
  assert.throws(() => buildGuardDeploymentAuthorization({
    admissionEnvelope: f.admission.envelope, admissionPublicKey: f.admissionSigner.publicKey,
    repository: "owner/repo", commitSha, environment: "production\nattack", deploymentSigner: f.deploymentSigner,
    issuedAt, validUntil,
  }), /safe non-empty text|environment is invalid/);
});

test("CLI creates, registers, and rechecks a signed deployment authorization against actual file bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-deployment-authorization-"));
  const admissionPair = generateKeyPairSync("ed25519");
  const deploymentPair = generateKeyPairSync("ed25519");
  const makeSigner = (pair: ReturnType<typeof generateKeyPairSync>): GuardSigner => ({
    provider: "local-ed25519", keyId: signingKeyId(publicKeyDer(pair.publicKey)), publicKey: pair.publicKey,
    sign: (message) => sign(null, message, pair.privateKey),
  });
  const admissionSigner = makeSigner(admissionPair);
  const deploymentSigner = makeSigner(deploymentPair);
  const ids = Array.from({ length: 5 }, (_, index) => guardDigest(`cli-role-${index}`));
  const signedAdmission = signGuardControlAdmission({
    schemaVersion: "agent-vigil-control-admission/v1", evaluatedAt: "2026-09-03T15:55:00.000Z",
    validUntil: "2026-09-03T16:55:00.000Z", decision: "APPROVE",
    artifact: { host: "codex", version: "future-1", executableSha256: guardDigest("exact-package-bytes") },
    environmentSha256: guardDigest("managed-environment"),
    evidence: {
      current: { challengeHash: guardDigest("cc"), observationHash: guardDigest("co"), routeReceiptHash: guardDigest("cr"), isolationHash: guardDigest("ci") },
      candidate: { challengeHash: guardDigest("nc"), observationHash: guardDigest("no"), routeReceiptHash: guardDigest("nr"), isolationHash: guardDigest("ni") },
      routeDecisionHash: guardDigest("decision"),
    },
    trust: { challengeSignerKeyId: ids[0], observerSignerKeyId: ids[1], routeSignerKeyId: ids[2],
      environmentSignerKeyId: ids[3], isolationSignerKeyId: ids[4], admissionSignerKeyId: admissionSigner.keyId },
    reasonCodes: ["EXACT_CONTROL_ADMISSION_PROVEN"], limitations: ["CLI fixture."],
  }, admissionSigner);
  const paths = Object.fromEntries(["admission", "admissionPublic", "deploymentPrivate", "deploymentPublic", "authorization", "artifact"]
    .map((name) => [name, join(directory, name)])) as Record<string, string>;
  const logs = { log: console.log, error: console.error };
  const originalFetch = globalThis.fetch;
  const priorRegistrationSecret = process.env.AGENT_VIGIL_REGISTRATION_SECRET;
  try {
    writeFileSync(paths.admission, JSON.stringify(signedAdmission.envelope));
    writeFileSync(paths.admissionPublic, admissionPair.publicKey.export({ format: "pem", type: "spki" }));
    writeFileSync(paths.deploymentPrivate, deploymentPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    writeFileSync(paths.deploymentPublic, deploymentPair.publicKey.export({ format: "pem", type: "spki" }));
    writeFileSync(paths.artifact, "exact-package-bytes");
    console.log = (() => undefined) as typeof console.log;
    console.error = (() => undefined) as typeof console.error;
    assert.equal(runGuardDeployAuthorizeCommand([
      "--admission", paths.admission, "--admission-public-key", paths.admissionPublic,
      "--repository", "outside-owner/production-service", "--commit-sha", commitSha, "--environment", "production",
      "--deployment-key", paths.deploymentPrivate, "--output", paths.authorization, "--issued-at", issuedAt, "--valid-until", validUntil,
    ]), 0);
    const opened = openGuardDeploymentAuthorization(JSON.parse(readFileSync(paths.authorization, "utf8")), deploymentPair.publicKey);
    process.env.AGENT_VIGIL_REGISTRATION_SECRET = "a-separate-registration-secret-with-at-least-thirty-two-characters";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.redirect, "error");
      const request = JSON.parse(String(init?.body));
      assert.equal(request.schemaVersion, "agent-vigil-deployment-registration/v1");
      assert.match(String((init?.headers as Record<string, string>)["x-agent-vigil-registration-signature"]), /^sha256=[0-9a-f]{64}$/);
      return new Response(JSON.stringify({ status: "registered", authorization_hash: opened.authorization.authorizationHash }), { status: 201 });
    }) as typeof fetch;
    assert.equal(await runGuardDeployRegisterCommand([
      "--authorization", paths.authorization, "--deployment-public-key", paths.deploymentPublic,
      "--admission", paths.admission, "--admission-public-key", paths.admissionPublic,
      "--url", "https://app.example/deployment/authorizations", "--as-of", "2026-09-03T16:10:00.000Z",
    ]), 0);
    const gate = [
      "--authorization", paths.authorization, "--deployment-public-key", paths.deploymentPublic,
      "--admission", paths.admission, "--admission-public-key", paths.admissionPublic,
      "--repository", "outside-owner/production-service", "--commit-sha", commitSha, "--environment", "production",
      "--artifact", paths.artifact, "--environment-sha256", signedAdmission.admission.environmentSha256,
      "--as-of", "2026-09-03T16:10:00.000Z",
    ];
    assert.equal(runGuardDeployBoundGateCommand(gate), 0);
    writeFileSync(paths.artifact, "tampered");
    assert.equal(runGuardDeployBoundGateCommand(gate), 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorRegistrationSecret === undefined) delete process.env.AGENT_VIGIL_REGISTRATION_SECRET;
    else process.env.AGENT_VIGIL_REGISTRATION_SECRET = priorRegistrationSecret;
    console.log = logs.log;
    console.error = logs.error;
    rmSync(directory, { recursive: true, force: true });
  }
});
