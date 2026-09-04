import {
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonical } from "./report.ts";
import { guardDigest } from "./guard-compat.ts";
import { dssePae } from "./guard-route-seal.ts";
import { openGuardControlAdmission, type GuardControlAdmission, type GuardSignedEnvelope } from "./guard-control-protocol.ts";
import type { GuardSigner } from "./guard-signing.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";

export const GUARD_DEPLOYMENT_AUTHORIZATION_SCHEMA = "agent-vigil-deployment-authorization/v1" as const;
export const GUARD_DEPLOYMENT_AUTHORIZATION_PAYLOAD = "application/vnd.agent-vigil.deployment-authorization+json;version=1" as const;
export const GUARD_DEPLOYMENT_REGISTRATION_SCHEMA = "agent-vigil-deployment-registration/v1" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENVIRONMENT = /^[A-Za-z0-9_. /:@+-]+$/;
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_AUTHORIZATION_MS = 60 * 60 * 1000;

export type GuardDeploymentAuthorization = {
  schemaVersion: typeof GUARD_DEPLOYMENT_AUTHORIZATION_SCHEMA;
  issuedAt: string;
  validUntil: string;
  repository: string;
  commitSha: string;
  environment: string;
  admissionHash: string;
  artifact: GuardControlAdmission["artifact"];
  managedEnvironmentSha256: string;
  trust: {
    admissionSignerKeyId: string;
    deploymentSignerKeyId: string;
  };
  authorizationHash: string;
};

export type GuardDeploymentRegistration = {
  schemaVersion: typeof GUARD_DEPLOYMENT_REGISTRATION_SCHEMA;
  authorization: GuardSignedEnvelope;
  admission: GuardSignedEnvelope;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximum || /\p{C}/u.test(value)) {
    throw new Error(`${label} must be safe non-empty text`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const selected = text(value, label, 40);
  const epoch = Date.parse(selected);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== selected) {
    throw new Error(`${label} must be canonical RFC3339 UTC`);
  }
  return selected;
}

function digest(value: unknown, label: string): string {
  const selected = text(value, label, 71);
  if (!DIGEST.test(selected)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return selected;
}

function repository(value: unknown): string {
  const selected = text(value, "deployment repository", 201);
  if (!REPOSITORY.test(selected) || selected.includes("..")) throw new Error("deployment repository is invalid");
  return selected;
}

function environment(value: unknown): string {
  const selected = text(value, "deployment environment", 255);
  if (!ENVIRONMENT.test(selected) || selected.includes("..")) throw new Error("deployment environment is invalid");
  return selected;
}

function canonicalBase64(value: unknown, label: string, maximum = MAX_ENVELOPE_BYTES): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maximum
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || Buffer.from(value, "base64").toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return value;
}

function hashWithout(value: Record<string, unknown>, key: string): string {
  const copy = { ...value };
  delete copy[key];
  return guardDigest(copy);
}

function signAuthorization(value: GuardDeploymentAuthorization, signer: GuardSigner): GuardSignedEnvelope {
  const bytes = Buffer.from(canonical(value), "utf8");
  return {
    payloadType: GUARD_DEPLOYMENT_AUTHORIZATION_PAYLOAD,
    payload: bytes.toString("base64"),
    signatures: [{ keyid: signer.keyId, sig: signer.sign(dssePae(GUARD_DEPLOYMENT_AUTHORIZATION_PAYLOAD, bytes)).toString("base64") }],
  };
}

export function validateGuardDeploymentAuthorization(value: unknown): GuardDeploymentAuthorization {
  const root = object(value, "deployment authorization");
  exactKeys(root, [
    "schemaVersion", "issuedAt", "validUntil", "repository", "commitSha", "environment", "admissionHash",
    "artifact", "managedEnvironmentSha256", "trust", "authorizationHash",
  ], "deployment authorization");
  if (root.schemaVersion !== GUARD_DEPLOYMENT_AUTHORIZATION_SCHEMA) throw new Error("unsupported deployment authorization schema");
  const artifact = object(root.artifact, "deployment authorization artifact");
  exactKeys(artifact, ["host", "version", "executableSha256"], "deployment authorization artifact");
  if (artifact.host !== "claude" && artifact.host !== "codex") throw new Error("deployment authorization artifact host is invalid");
  const trust = object(root.trust, "deployment authorization trust");
  exactKeys(trust, ["admissionSignerKeyId", "deploymentSignerKeyId"], "deployment authorization trust");
  const issuedAt = timestamp(root.issuedAt, "deployment authorization issuedAt");
  const validUntil = timestamp(root.validUntil, "deployment authorization validUntil");
  const duration = Date.parse(validUntil) - Date.parse(issuedAt);
  if (duration <= 0 || duration > MAX_AUTHORIZATION_MS) {
    throw new Error("deployment authorization validity must be greater than zero and at most one hour");
  }
  const commitSha = text(root.commitSha, "deployment commit SHA", 40);
  if (!SHA.test(commitSha)) throw new Error("deployment commit SHA must be 40 lowercase hexadecimal characters");
  const validated: GuardDeploymentAuthorization = {
    schemaVersion: GUARD_DEPLOYMENT_AUTHORIZATION_SCHEMA,
    issuedAt,
    validUntil,
    repository: repository(root.repository),
    commitSha,
    environment: environment(root.environment),
    admissionHash: digest(root.admissionHash, "deployment authorization admissionHash"),
    artifact: {
      host: artifact.host,
      version: text(artifact.version, "deployment authorization artifact version", 200),
      executableSha256: digest(artifact.executableSha256, "deployment authorization artifact digest"),
    },
    managedEnvironmentSha256: digest(root.managedEnvironmentSha256, "deployment authorization environment digest"),
    trust: {
      admissionSignerKeyId: digest(trust.admissionSignerKeyId, "deployment authorization admission signer"),
      deploymentSignerKeyId: digest(trust.deploymentSignerKeyId, "deployment authorization deployment signer"),
    },
    authorizationHash: digest(root.authorizationHash, "authorizationHash"),
  };
  if (validated.trust.admissionSignerKeyId === validated.trust.deploymentSignerKeyId) {
    throw new Error("deployment and admission signers must be distinct");
  }
  if (validated.authorizationHash !== hashWithout(validated as unknown as Record<string, unknown>, "authorizationHash")) {
    throw new Error("deployment authorization hash is invalid");
  }
  return validated;
}

export function openGuardDeploymentAuthorization(
  value: unknown,
  publicKeyValue: string | Buffer | KeyObject,
): { authorization: GuardDeploymentAuthorization; signerKeyId: string } {
  const root = object(value, "signed deployment authorization");
  exactKeys(root, ["payloadType", "payload", "signatures"], "signed deployment authorization");
  if (root.payloadType !== GUARD_DEPLOYMENT_AUTHORIZATION_PAYLOAD) throw new Error("signed deployment authorization has the wrong payload type");
  const payload = canonicalBase64(root.payload, "signed deployment authorization payload");
  if (!Array.isArray(root.signatures) || root.signatures.length !== 1) {
    throw new Error("signed deployment authorization must have exactly one signature");
  }
  const signature = object(root.signatures[0], "signed deployment authorization signature");
  exactKeys(signature, ["keyid", "sig"], "signed deployment authorization signature");
  const key = typeof publicKeyValue === "string" || Buffer.isBuffer(publicKeyValue)
    ? createPublicKey(publicKeyValue)
    : publicKeyValue;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("deployment public key must be Ed25519");
  const signerKeyId = signingKeyId(publicKeyDer(key));
  const selectedKeyId = digest(signature.keyid, "signed deployment authorization keyid");
  const sig = Buffer.from(canonicalBase64(signature.sig, "signed deployment authorization signature", 8192), "base64");
  const bytes = Buffer.from(payload, "base64");
  if (selectedKeyId !== signerKeyId
    || !verify(null, dssePae(GUARD_DEPLOYMENT_AUTHORIZATION_PAYLOAD, bytes), key, sig)) {
    throw new Error("signed deployment authorization signature is invalid for the pinned key");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("signed deployment authorization payload must contain JSON"); }
  const authorization = validateGuardDeploymentAuthorization(parsed);
  if (authorization.trust.deploymentSignerKeyId !== signerKeyId) {
    throw new Error("deployment authorization signer does not match the signed trust binding");
  }
  return { authorization, signerKeyId };
}

export function buildGuardDeploymentAuthorization(input: {
  admissionEnvelope: unknown;
  admissionPublicKey: string | Buffer | KeyObject;
  repository: string;
  commitSha: string;
  environment: string;
  deploymentSigner: GuardSigner;
  issuedAt?: string;
  validUntil?: string;
}): { authorization: GuardDeploymentAuthorization; envelope: GuardSignedEnvelope } {
  const issuedAt = timestamp(input.issuedAt ?? new Date().toISOString(), "deployment authorization issuedAt");
  const opened = openGuardControlAdmission(input.admissionEnvelope, input.admissionPublicKey);
  const admission = opened.admission;
  if (admission.decision !== "APPROVE") throw new Error("cannot authorize deployment from a HOLD admission");
  if (Object.values(admission.trust).includes(input.deploymentSigner.keyId)) {
    throw new Error("deployment signer must be distinct from every admission trust role");
  }
  if (Date.parse(issuedAt) < Date.parse(admission.evaluatedAt) || Date.parse(issuedAt) > Date.parse(admission.validUntil)) {
    throw new Error("deployment authorization issuance is outside the admission validity window");
  }
  const defaultExpiry = new Date(Math.min(Date.parse(admission.validUntil), Date.parse(issuedAt) + 15 * 60 * 1000)).toISOString();
  const validUntil = timestamp(input.validUntil ?? defaultExpiry, "deployment authorization validUntil");
  if (Date.parse(validUntil) > Date.parse(admission.validUntil)) {
    throw new Error("deployment authorization cannot outlive its control admission");
  }
  const base = {
    schemaVersion: GUARD_DEPLOYMENT_AUTHORIZATION_SCHEMA,
    issuedAt,
    validUntil,
    repository: repository(input.repository),
    commitSha: (() => {
      const selected = text(input.commitSha, "deployment commit SHA", 40);
      if (!SHA.test(selected)) throw new Error("deployment commit SHA must be 40 lowercase hexadecimal characters");
      return selected;
    })(),
    environment: environment(input.environment),
    admissionHash: admission.admissionHash,
    artifact: admission.artifact,
    managedEnvironmentSha256: admission.environmentSha256,
    trust: {
      admissionSignerKeyId: opened.signerKeyId,
      deploymentSignerKeyId: input.deploymentSigner.keyId,
    },
  };
  const authorization: GuardDeploymentAuthorization = { ...base, authorizationHash: guardDigest(base) };
  validateGuardDeploymentAuthorization(authorization);
  return { authorization, envelope: signAuthorization(authorization, input.deploymentSigner) };
}

export function gateGuardDeploymentAuthorization(input: {
  authorizationEnvelope: unknown;
  deploymentPublicKey: string | Buffer | KeyObject;
  admissionEnvelope: unknown;
  admissionPublicKey: string | Buffer | KeyObject;
  repository: string;
  commitSha: string;
  environment: string;
  expectedArtifactSha256: string;
  expectedManagedEnvironmentSha256: string;
  asOf?: string;
}): GuardDeploymentAuthorization {
  const asOf = timestamp(input.asOf ?? new Date().toISOString(), "deployment gate time");
  const { authorization } = openGuardDeploymentAuthorization(input.authorizationEnvelope, input.deploymentPublicKey);
  const { admission, signerKeyId } = openGuardControlAdmission(input.admissionEnvelope, input.admissionPublicKey);
  if (admission.decision !== "APPROVE") throw new Error("linked control admission is HOLD");
  if (authorization.admissionHash !== admission.admissionHash
    || authorization.trust.admissionSignerKeyId !== signerKeyId) {
    throw new Error("deployment authorization is linked to a different control admission");
  }
  if (authorization.repository !== repository(input.repository)) throw new Error("deployment authorization is for a different repository");
  if (authorization.commitSha !== input.commitSha) throw new Error("deployment authorization is for a different commit");
  if (authorization.environment !== environment(input.environment)) throw new Error("deployment authorization is for a different GitHub environment");
  if (authorization.artifact.executableSha256 !== digest(input.expectedArtifactSha256, "expected artifact digest")
    || authorization.artifact.executableSha256 !== admission.artifact.executableSha256) {
    throw new Error("deployment authorization is for different artifact bytes");
  }
  if (authorization.artifact.host !== admission.artifact.host
    || authorization.artifact.version !== admission.artifact.version) {
    throw new Error("deployment authorization is for a different artifact identity");
  }
  if (Object.values(admission.trust).includes(authorization.trust.deploymentSignerKeyId)) {
    throw new Error("deployment signer is not independent from the admission trust roles");
  }
  if (authorization.managedEnvironmentSha256 !== digest(input.expectedManagedEnvironmentSha256, "expected managed environment digest")
    || authorization.managedEnvironmentSha256 !== admission.environmentSha256) {
    throw new Error("deployment authorization is for a different managed environment");
  }
  if (Date.parse(asOf) < Date.parse(authorization.issuedAt) || Date.parse(asOf) > Date.parse(authorization.validUntil)
    || Date.parse(asOf) < Date.parse(admission.evaluatedAt) || Date.parse(asOf) > Date.parse(admission.validUntil)) {
    throw new Error("deployment authorization is not currently valid");
  }
  return authorization;
}

export function buildGuardDeploymentRegistration(input: {
  authorizationEnvelope: unknown;
  deploymentPublicKey: string | Buffer | KeyObject;
  admissionEnvelope: unknown;
  admissionPublicKey: string | Buffer | KeyObject;
  asOf?: string;
}): { registration: GuardDeploymentRegistration; authorization: GuardDeploymentAuthorization } {
  const asOf = timestamp(input.asOf ?? new Date().toISOString(), "deployment registration time");
  const authorizationOpened = openGuardDeploymentAuthorization(input.authorizationEnvelope, input.deploymentPublicKey);
  const admissionOpened = openGuardControlAdmission(input.admissionEnvelope, input.admissionPublicKey);
  const { authorization } = authorizationOpened;
  const { admission } = admissionOpened;
  if (admission.decision !== "APPROVE") throw new Error("linked control admission is HOLD");
  if (authorization.admissionHash !== admission.admissionHash
    || authorization.trust.admissionSignerKeyId !== admissionOpened.signerKeyId
    || authorization.artifact.host !== admission.artifact.host
    || authorization.artifact.version !== admission.artifact.version
    || authorization.artifact.executableSha256 !== admission.artifact.executableSha256
    || authorization.managedEnvironmentSha256 !== admission.environmentSha256
    || Date.parse(authorization.issuedAt) < Date.parse(admission.evaluatedAt)
    || Date.parse(authorization.validUntil) > Date.parse(admission.validUntil)) {
    throw new Error("deployment authorization does not match the pinned control admission");
  }
  if (Date.parse(asOf) < Date.parse(authorization.issuedAt) || Date.parse(asOf) > Date.parse(authorization.validUntil)
    || Date.parse(asOf) < Date.parse(admission.evaluatedAt) || Date.parse(asOf) > Date.parse(admission.validUntil)) {
    throw new Error("deployment registration evidence is not currently valid");
  }
  return {
    registration: {
      schemaVersion: GUARD_DEPLOYMENT_REGISTRATION_SCHEMA,
      authorization: input.authorizationEnvelope as GuardSignedEnvelope,
      admission: input.admissionEnvelope as GuardSignedEnvelope,
    },
    authorization,
  };
}
