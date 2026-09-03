import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { chmodSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { guardDigest } from "./guard-compat.ts";
import { readRegularFileSnapshot, readRegularUtf8, type RegularFileSnapshot } from "./safe-fs.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";
import type { GuardHost } from "./guard-compat.ts";

export const GUARD_ENVIRONMENT_SCHEMA = "agent-vigil-guard-environment/v1" as const;
export const GUARD_POLICY_FILES_SCHEMA = "agent-vigil-guard-policy-files/v1" as const;
export const GUARD_ENVIRONMENT_BINDING_SCHEMA = "agent-vigil-guard-environment-binding/v1" as const;
export const GUARD_PROFILE_BINDING_FILE = ".agent-vigil-profile-binding" as const;
export const GUARD_PROFILE_BINDING_PREFIX = "agent-vigil-profile-binding/v1:" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_STATEMENT_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_POLICY_BYTES = 64 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const MAX_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

export type GuardEnvironmentPolicy = {
  label: string;
  path: string;
  sha256: string;
};

export type GuardEnvironmentStatement = {
  schemaVersion: typeof GUARD_ENVIRONMENT_SCHEMA;
  environmentId: string;
  host: GuardHost;
  issuedAt: string;
  validUntil: string;
  nonce: string;
  profileIdentitySha256: string;
  policies: GuardEnvironmentPolicy[];
  policySetSha256: string;
  statementHash: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
    value: string;
  };
};

export type GuardEnvironmentReceiptBinding = {
  schemaVersion: typeof GUARD_ENVIRONMENT_BINDING_SCHEMA;
  statementHash: string;
  signerKeyId: string;
  environmentIdSha256: string;
  host: GuardHost;
  profileIdentitySha256: string;
  policySetSha256: string;
  validFrom: string;
  validUntil: string;
  bindingHash: string;
  signature: {
    algorithm: "Ed25519";
    value: string;
  };
};

export type VerifiedGuardEnvironment = {
  statement: GuardEnvironmentStatement;
  binding: GuardEnvironmentReceiptBinding;
  snapshots: Array<{ label: string; path: string; snapshot: RegularFileSnapshot }>;
};

type GuardPolicyFilesManifest = {
  schemaVersion: typeof GUARD_POLICY_FILES_SCHEMA;
  files: Array<{ label: string; path: string }>;
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

function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum || /\p{C}/u.test(value)) {
    throw new Error(`${label} must be safe non-empty text`);
  }
  return value.trim();
}

function digest(value: unknown, label: string): string {
  const selected = text(value, label, 71);
  if (!DIGEST.test(selected)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return selected;
}

function timestamp(value: unknown, label: string): string {
  const selected = text(value, label, 40);
  const epoch = Date.parse(selected);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== selected) {
    throw new Error(`${label} must be canonical RFC3339 UTC`);
  }
  return selected;
}

function canonicalBase64(value: unknown, label: string, maximum = 8192): string {
  const selected = text(value, label, maximum);
  if (!BASE64.test(selected) || Buffer.from(selected, "base64").toString("base64") !== selected) {
    throw new Error(`${label} must be canonical base64`);
  }
  return selected;
}

function fileSha256(snapshot: RegularFileSnapshot): string {
  return guardDigest(snapshot.bytes);
}

function safePolicyLabel(value: unknown, label: string): string {
  const selected = text(value, label, 80);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(selected)) {
    throw new Error(`${label} must use lowercase letters, digits, dots, underscores, or hyphens`);
  }
  return selected;
}

function policySetSha256(policies: GuardEnvironmentPolicy[]): string {
  return guardDigest(policies.map(({ label, sha256 }) => ({ label, sha256 })));
}

function unsignedStatement(statement: GuardEnvironmentStatement): Omit<GuardEnvironmentStatement, "statementHash" | "signature"> {
  const { statementHash: _statementHash, signature: _signature, ...unsigned } = statement;
  return unsigned;
}

type UnsignedGuardEnvironmentReceiptBinding = Omit<GuardEnvironmentReceiptBinding, "bindingHash" | "signature">;

function unsignedReceiptBinding(input: {
  statementHash: string;
  signerKeyId: string;
  environmentId: string;
  host: GuardHost;
  profileIdentitySha256: string;
  policySetSha256: string;
  validFrom: string;
  validUntil: string;
}): UnsignedGuardEnvironmentReceiptBinding {
  return {
    schemaVersion: GUARD_ENVIRONMENT_BINDING_SCHEMA,
    statementHash: input.statementHash,
    signerKeyId: input.signerKeyId,
    environmentIdSha256: guardDigest(input.environmentId),
    host: input.host,
    profileIdentitySha256: input.profileIdentitySha256,
    policySetSha256: input.policySetSha256,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
  };
}

function statementReceiptBinding(statement: GuardEnvironmentStatement): GuardEnvironmentReceiptBinding {
  const unsigned = unsignedReceiptBinding({
    statementHash: statement.statementHash,
    signerKeyId: statement.signature.keyId,
    environmentId: statement.environmentId,
    host: statement.host,
    profileIdentitySha256: statement.profileIdentitySha256,
    policySetSha256: statement.policySetSha256,
    validFrom: statement.issuedAt,
    validUntil: statement.validUntil,
  });
  return {
    ...unsigned,
    bindingHash: guardDigest(unsigned),
    signature: { algorithm: "Ed25519", value: statement.signature.value },
  };
}

function validateProfileBinding(profileHome: string): { path: string; snapshot: RegularFileSnapshot; sha256: string } {
  const home = realpathSync(profileHome);
  if (!lstatSync(home).isDirectory()) throw new Error("profile home must be a directory");
  const path = join(home, GUARD_PROFILE_BINDING_FILE);
  const snapshot = readRegularFileSnapshot(path, 256, "guard profile binding");
  if ((snapshot.mode & 0o077) !== 0) throw new Error("guard profile binding must not be readable or writable by group or others");
  const body = snapshot.bytes.toString("utf8");
  if (!new RegExp(`^${GUARD_PROFILE_BINDING_PREFIX.replace("/", "\\/")}[0-9a-f]{64}\\n$`).test(body)) {
    throw new Error("guard profile binding has invalid content");
  }
  return { path, snapshot, sha256: fileSha256(snapshot) };
}

export function initializeGuardProfileBinding(profileHome: string): string {
  const home = realpathSync(profileHome);
  if (!lstatSync(home).isDirectory()) throw new Error("profile home must be a directory");
  const path = join(home, GUARD_PROFILE_BINDING_FILE);
  const body = `${GUARD_PROFILE_BINDING_PREFIX}${randomBytes(32).toString("hex")}\n`;
  writeFileSync(path, body, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function loadGuardPolicyFilesManifest(path: string): GuardPolicyFilesManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(readRegularUtf8(resolve(path), MAX_MANIFEST_BYTES, "guard policy manifest")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("guard policy manifest must contain valid JSON");
    throw error;
  }
  const root = object(parsed, "guard policy manifest");
  exactKeys(root, ["schemaVersion", "files"], "guard policy manifest");
  if (root.schemaVersion !== GUARD_POLICY_FILES_SCHEMA) throw new Error("unsupported guard policy manifest");
  if (!Array.isArray(root.files) || root.files.length < 1 || root.files.length > 32) {
    throw new Error("guard policy manifest must contain 1 to 32 files");
  }
  const seenLabels = new Set<string>();
  const seenPaths = new Set<string>();
  const files = root.files.map((value, index) => {
    const item = object(value, `guard policy manifest files[${index}]`);
    exactKeys(item, ["label", "path"], `guard policy manifest files[${index}]`);
    const label = safePolicyLabel(item.label, `guard policy manifest files[${index}].label`);
    const path = text(item.path, `guard policy manifest files[${index}].path`, 4096);
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`guard policy manifest files[${index}].path must be an absolute normalized path`);
    if (seenLabels.has(label)) throw new Error(`duplicate guard policy label: ${label}`);
    if (seenPaths.has(path)) throw new Error("guard policy manifest must not repeat a file path");
    seenLabels.add(label);
    seenPaths.add(path);
    return { label, path };
  });
  return { schemaVersion: GUARD_POLICY_FILES_SCHEMA, files };
}

export function issueGuardEnvironmentStatement(input: {
  environmentId: string;
  host: GuardHost;
  profileHome: string;
  policyManifestPath: string;
  privateKeyPath: string;
  issuedAt?: string;
  validUntil: string;
  nonce?: string;
}): GuardEnvironmentStatement {
  const environmentId = text(input.environmentId, "environment ID", 160);
  const issuedAt = timestamp(input.issuedAt ?? new Date().toISOString(), "issuedAt");
  const validUntil = timestamp(input.validUntil, "validUntil");
  const duration = Date.parse(validUntil) - Date.parse(issuedAt);
  if (duration <= 0 || duration > MAX_VALIDITY_MS) throw new Error("guard environment validity must be greater than zero and no more than seven days");
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  if (!SAFE_NONCE.test(nonce)) throw new Error("guard environment nonce must be 16 to 128 safe characters");
  const profile = validateProfileBinding(input.profileHome);
  const manifest = loadGuardPolicyFilesManifest(input.policyManifestPath);
  const policies = manifest.files.map(({ label, path }) => {
    const snapshot = readRegularFileSnapshot(path, MAX_POLICY_BYTES, `guard policy ${label}`);
    return { label, path, sha256: fileSha256(snapshot) };
  });
  const payload = {
    schemaVersion: GUARD_ENVIRONMENT_SCHEMA,
    environmentId,
    host: input.host,
    issuedAt,
    validUntil,
    nonce,
    profileIdentitySha256: profile.sha256,
    policies,
    policySetSha256: policySetSha256(policies),
  };
  const statementHash = guardDigest(payload);
  const privateKeyBytes = readRegularFileSnapshot(resolve(input.privateKeyPath), MAX_KEY_BYTES, "guard environment private key").bytes;
  const privateKey = createPrivateKey(privateKeyBytes);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("guard environment private key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  const keyId = signingKeyId(der);
  const unsignedBinding = unsignedReceiptBinding({
    statementHash,
    signerKeyId: keyId,
    environmentId,
    host: input.host,
    profileIdentitySha256: payload.profileIdentitySha256,
    policySetSha256: payload.policySetSha256,
    validFrom: issuedAt,
    validUntil,
  });
  const bindingHash = guardDigest(unsignedBinding);
  return {
    ...payload,
    statementHash,
    signature: {
      algorithm: "Ed25519",
      keyId,
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(bindingHash, "utf8"), privateKey).toString("base64"),
    },
  };
}

export function validateGuardEnvironmentStatement(value: unknown): GuardEnvironmentStatement {
  const root = object(value, "guard environment statement");
  exactKeys(root, [
    "schemaVersion", "environmentId", "host", "issuedAt", "validUntil", "nonce",
    "profileIdentitySha256", "policies", "policySetSha256", "statementHash", "signature",
  ], "guard environment statement");
  if (root.schemaVersion !== GUARD_ENVIRONMENT_SCHEMA) throw new Error("unsupported guard environment statement");
  const host = text(root.host, "guard environment host", 20);
  if (host !== "claude" && host !== "codex") throw new Error("guard environment host must be claude or codex");
  const issuedAt = timestamp(root.issuedAt, "guard environment issuedAt");
  const validUntil = timestamp(root.validUntil, "guard environment validUntil");
  const duration = Date.parse(validUntil) - Date.parse(issuedAt);
  if (duration <= 0 || duration > MAX_VALIDITY_MS) throw new Error("guard environment validity must be greater than zero and no more than seven days");
  const nonce = text(root.nonce, "guard environment nonce", 128);
  if (!SAFE_NONCE.test(nonce)) throw new Error("guard environment nonce must be 16 to 128 safe characters");
  if (!Array.isArray(root.policies) || root.policies.length < 1 || root.policies.length > 32) {
    throw new Error("guard environment statement must contain 1 to 32 policies");
  }
  const seenLabels = new Set<string>();
  const seenPaths = new Set<string>();
  const policies = root.policies.map((value, index) => {
    const item = object(value, `guard environment policies[${index}]`);
    exactKeys(item, ["label", "path", "sha256"], `guard environment policies[${index}]`);
    const label = safePolicyLabel(item.label, `guard environment policies[${index}].label`);
    const path = text(item.path, `guard environment policies[${index}].path`, 4096);
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`guard environment policies[${index}].path must be an absolute normalized path`);
    if (seenLabels.has(label) || seenPaths.has(path)) throw new Error("guard environment policies must have unique labels and paths");
    seenLabels.add(label);
    seenPaths.add(path);
    return { label, path, sha256: digest(item.sha256, `guard environment policies[${index}].sha256`) };
  });
  const signature = object(root.signature, "guard environment signature");
  exactKeys(signature, ["algorithm", "keyId", "publicKey", "value"], "guard environment signature");
  if (signature.algorithm !== "Ed25519") throw new Error("guard environment signature algorithm must be Ed25519");
  const statement: GuardEnvironmentStatement = {
    schemaVersion: GUARD_ENVIRONMENT_SCHEMA,
    environmentId: text(root.environmentId, "guard environment ID", 160),
    host,
    issuedAt,
    validUntil,
    nonce,
    profileIdentitySha256: digest(root.profileIdentitySha256, "guard environment profileIdentitySha256"),
    policies,
    policySetSha256: digest(root.policySetSha256, "guard environment policySetSha256"),
    statementHash: digest(root.statementHash, "guard environment statementHash"),
    signature: {
      algorithm: "Ed25519",
      keyId: digest(signature.keyId, "guard environment signature keyId"),
      publicKey: canonicalBase64(signature.publicKey, "guard environment signature publicKey"),
      value: canonicalBase64(signature.value, "guard environment signature value"),
    },
  };
  if (policySetSha256(statement.policies) !== statement.policySetSha256) throw new Error("guard environment policy set hash is invalid");
  if (guardDigest(unsignedStatement(statement)) !== statement.statementHash) throw new Error("guard environment statement hash is invalid");
  return statement;
}

export function loadGuardEnvironmentStatement(path: string): GuardEnvironmentStatement {
  let parsed: unknown;
  try { parsed = JSON.parse(readRegularUtf8(resolve(path), MAX_STATEMENT_BYTES, "guard environment statement")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("guard environment statement must contain valid JSON");
    throw error;
  }
  return validateGuardEnvironmentStatement(parsed);
}

export function verifyGuardEnvironment(input: {
  statement: unknown;
  publicKeyPath: string;
  host: GuardHost;
  profileHome: string;
  observedAt: string;
}): VerifiedGuardEnvironment {
  const statement = validateGuardEnvironmentStatement(input.statement);
  if (statement.host !== input.host) throw new Error("guard environment host does not match the route host");
  const observedAt = timestamp(input.observedAt, "guard environment observedAt");
  if (Date.parse(observedAt) < Date.parse(statement.issuedAt) || Date.parse(observedAt) > Date.parse(statement.validUntil)) {
    throw new Error("guard environment statement is not valid at the route observation time");
  }
  const embedded = createPublicKey({
    key: Buffer.from(statement.signature.publicKey, "base64"),
    type: "spki",
    format: "der",
  });
  const pinnedBytes = readRegularFileSnapshot(resolve(input.publicKeyPath), MAX_KEY_BYTES, "guard environment public key").bytes;
  const pinned = createPublicKey(pinnedBytes);
  if (embedded.asymmetricKeyType !== "ed25519" || pinned.asymmetricKeyType !== "ed25519") {
    throw new Error("guard environment public keys must be Ed25519");
  }
  const embeddedId = signingKeyId(publicKeyDer(embedded));
  const pinnedId = signingKeyId(publicKeyDer(pinned));
  if (embeddedId !== statement.signature.keyId || pinnedId !== statement.signature.keyId) {
    throw new Error("guard environment signer does not match the pinned public key");
  }
  const binding = statementReceiptBinding(statement);
  if (!verify(null, Buffer.from(binding.bindingHash, "utf8"), pinned, Buffer.from(statement.signature.value, "base64"))) {
    throw new Error("guard environment signature is invalid");
  }
  const profile = validateProfileBinding(input.profileHome);
  if (profile.sha256 !== statement.profileIdentitySha256) throw new Error("guard environment profile identity does not match the route profile");
  const snapshots: VerifiedGuardEnvironment["snapshots"] = [
    { label: "profile-identity", path: profile.path, snapshot: profile.snapshot },
  ];
  for (const policy of statement.policies) {
    const snapshot = readRegularFileSnapshot(policy.path, MAX_POLICY_BYTES, `guard policy ${policy.label}`);
    if (fileSha256(snapshot) !== policy.sha256) throw new Error(`guard policy ${policy.label} does not match the signed environment statement`);
    snapshots.push({ label: policy.label, path: policy.path, snapshot });
  }
  return {
    statement,
    binding,
    snapshots,
  };
}

export function assertGuardEnvironmentUnchanged(value: VerifiedGuardEnvironment): void {
  for (const entry of value.snapshots) {
    const current = readRegularFileSnapshot(entry.path, entry.label === "profile-identity" ? 256 : MAX_POLICY_BYTES, `guard environment ${entry.label}`);
    if (current.identity !== entry.snapshot.identity || fileSha256(current) !== fileSha256(entry.snapshot)) {
      throw new Error(`guard environment ${entry.label} changed during the live-host route check`);
    }
  }
}

export function guardEnvironmentBindingHash(binding: GuardEnvironmentReceiptBinding): string {
  const { bindingHash: _bindingHash, signature: _signature, ...unsigned } = binding;
  return guardDigest(unsigned);
}

export function verifyGuardEnvironmentReceiptBinding(
  binding: GuardEnvironmentReceiptBinding,
  trustedPublicKey: string | Buffer | KeyObject,
): boolean {
  try {
    if (binding.schemaVersion !== GUARD_ENVIRONMENT_BINDING_SCHEMA) return false;
    if (guardEnvironmentBindingHash(binding) !== binding.bindingHash) return false;
    const key: KeyObject = Buffer.isBuffer(trustedPublicKey) || typeof trustedPublicKey === "string"
      ? createPublicKey(trustedPublicKey)
      : trustedPublicKey as KeyObject;
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return false;
    if (signingKeyId(publicKeyDer(key)) !== binding.signerKeyId) return false;
    return verify(
      null,
      Buffer.from(binding.bindingHash, "utf8"),
      key,
      Buffer.from(binding.signature.value, "base64"),
    );
  } catch {
    return false;
  }
}
