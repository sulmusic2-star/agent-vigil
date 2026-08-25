import { execFileSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { canonical } from "../report.ts";

export const CONTINUITY_EVENT_KINDS = [
  "merge_observed",
  "deployment_observed",
  "revert_observed",
  "hotfix_observed",
  "incident_linked",
  "verification_refreshed",
  "policy_superseded",
  "authority_changed",
  "agent_upgrade_changed",
  "security_advisory_observed",
  "credential_revoked",
  "attestation_invalid",
  "monitor_checkpoint",
  "coverage_gap",
  "exception_granted",
  "remediation_verified",
] as const;

export const CONTINUITY_DISPOSITIONS = ["affirm", "hold", "revoke", "observe"] as const;
export const CONTINUITY_PRIVACY_TIERS = ["receipt", "metadata", "full-local"] as const;
export const CONTINUITY_STATES = ["CURRENT", "HOLD", "EXPIRED", "REVOKED"] as const;

export type ContinuityEventKind = typeof CONTINUITY_EVENT_KINDS[number];
export type ContinuityDisposition = typeof CONTINUITY_DISPOSITIONS[number];
export type ContinuityPrivacyTier = typeof CONTINUITY_PRIVACY_TIERS[number];
export type ContinuityState = typeof CONTINUITY_STATES[number];

export type ContinuitySubject = {
  episodeReceiptHash: string;
  repositoryHash: string;
  baseSha: string;
  headSha: string;
};

export type ContinuityEventDraft = {
  schemaVersion: "agent-vigil-continuity-event/v1";
  eventId: string;
  subject: ContinuitySubject;
  source: {
    kind: string;
    issuer: string;
    evidenceHash: string;
    deliveryIdHash: string | null;
  };
  event: {
    kind: ContinuityEventKind;
    disposition: ContinuityDisposition;
    reasonCode: string;
    targetHash: string | null;
    freshUntil: string | null;
    supersedesEventId: string | null;
  };
  observedAt: string;
  effectiveAt: string;
  privacyTier: ContinuityPrivacyTier;
};

export type ContinuitySignature = {
  algorithm: "Ed25519";
  keyId: string;
  publicKey: string;
  value: string;
};

export type ContinuityEvent = ContinuityEventDraft & {
  sequence: number;
  predecessorHash: string;
  eventHash: string;
  signature: ContinuitySignature | null;
};

export type ContinuityRoot = {
  schemaVersion: "agent-vigil-continuity-root/v1";
  receiptFileSha256: string;
  receiptHash: string;
  rootHash: string;
  subject: ContinuitySubject;
  historicalVerification: "PASS" | "FAIL" | "INCONCLUSIVE";
  createdAt: string;
};

export type ContinuityPolicy = {
  schemaVersion: "agent-vigil-continuity-policy/v1";
  requiredSources: string[];
  maxAgeSeconds: Record<string, number>;
  denyOn: ContinuityEventKind[];
  allowRemediation: boolean;
  requireSignedRoot: boolean;
  requireSignedEvents: boolean;
  trustedRootKeyIds: string[];
  trustedIssuerKeyIds: string[];
  protectedEnvironments: string[];
  maxClockSkewSeconds: number;
};

export type LoadedContinuityPolicy = {
  value: ContinuityPolicy;
  source: string;
  sha256: string;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_URN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SAFE_SOURCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CREDENTIAL_LIKE_IDENTIFIER = /^(?:gh[pousr]_|github_pat_|sk_(?:live|test)_|xox[baprs]-)/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 1024 * 1024;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function string(value: unknown, label: string, maximum = 240): string {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  if (/\p{C}/u.test(value)) throw new Error(`${label} contains control or format characters`);
  return value;
}

function digest(value: unknown, label: string): string {
  const selected = string(value, label, 71);
  if (!SHA256.test(selected)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return selected;
}

function gitSha(value: unknown, label: string): string {
  const selected = string(value, label, 64);
  if (!GIT_SHA.test(selected)) throw new Error(`${label} must be a full lowercase Git object ID`);
  return selected;
}

function timestamp(value: unknown, label: string): string {
  const selected = string(value, label, 40);
  const parsed = Date.parse(selected);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== selected) throw new Error(`${label} must be canonical RFC3339 UTC`);
  return selected;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function nullableUuid(value: unknown, label: string): string | null {
  if (value === null) return null;
  const selected = string(value, label, 45);
  if (!UUID_URN.test(selected)) throw new Error(`${label} must be a lowercase UUID URN`);
  return selected;
}

function safeIdentifier(value: unknown, label: string): string {
  const selected = string(value, label, 80);
  if (!SAFE_IDENTIFIER.test(selected)) throw new Error(`${label} must be a privacy-safe machine identifier`);
  if (CREDENTIAL_LIKE_IDENTIFIER.test(selected)) throw new Error(`${label} must not contain a credential-like value`);
  return selected;
}

export function validateProtectedEnvironment(value: unknown): string {
  return safeIdentifier(value, "protected environment");
}

function safeSource(value: unknown, label: string): string {
  const selected = string(value, label, 64);
  if (!SAFE_SOURCE.test(selected)) throw new Error(`${label} must be a privacy-safe source identifier`);
  return selected;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const selected = string(value, label) as T;
  if (!allowed.includes(selected)) throw new Error(`${label} is unsupported`);
  return selected;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function stringArray(value: unknown, label: string, validator: (item: unknown, label: string) => string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > 64) throw new Error(`${label} exceeds 64 entries`);
  const selected = value.map((item, index) => validator(item, `${label}[${index}]`));
  if (new Set(selected).size !== selected.length) throw new Error(`${label} contains duplicate entries`);
  return selected;
}

export function validateContinuitySubject(value: unknown): ContinuitySubject {
  const selected = object(value, "subject");
  exactKeys(selected, ["episodeReceiptHash", "repositoryHash", "baseSha", "headSha"], "subject");
  return {
    episodeReceiptHash: digest(selected.episodeReceiptHash, "subject.episodeReceiptHash"),
    repositoryHash: digest(selected.repositoryHash, "subject.repositoryHash"),
    baseSha: gitSha(selected.baseSha, "subject.baseSha"),
    headSha: gitSha(selected.headSha, "subject.headSha"),
  };
}

export function validateEventDraft(value: unknown): ContinuityEventDraft {
  const selected = object(value, "continuity event draft");
  exactKeys(selected, ["schemaVersion", "eventId", "subject", "source", "event", "observedAt", "effectiveAt", "privacyTier"], "continuity event draft");
  if (selected.schemaVersion !== "agent-vigil-continuity-event/v1") throw new Error("unsupported continuity event schema");
  const eventId = string(selected.eventId, "eventId", 45);
  if (!UUID_URN.test(eventId)) throw new Error("eventId must be a lowercase UUID URN");

  const source = object(selected.source, "source");
  exactKeys(source, ["kind", "issuer", "evidenceHash", "deliveryIdHash"], "source");
  const deliveryIdHash = nullableDigest(source.deliveryIdHash, "source.deliveryIdHash");

  const event = object(selected.event, "event");
  exactKeys(event, ["kind", "disposition", "reasonCode", "targetHash", "freshUntil", "supersedesEventId"], "event");
  const eventKind = oneOf(event.kind, CONTINUITY_EVENT_KINDS, "event.kind");
  const eventDisposition = oneOf(event.disposition, CONTINUITY_DISPOSITIONS, "event.disposition");

  return {
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId,
    subject: validateContinuitySubject(selected.subject),
    source: {
      kind: safeSource(source.kind, "source.kind"),
      issuer: digest(source.issuer, "source.issuer"),
      evidenceHash: digest(source.evidenceHash, "source.evidenceHash"),
      deliveryIdHash,
    },
    event: {
      kind: eventKind,
      disposition: eventDisposition,
      reasonCode: safeIdentifier(event.reasonCode, "event.reasonCode"),
      targetHash: nullableDigest(event.targetHash, "event.targetHash"),
      freshUntil: nullableTimestamp(event.freshUntil, "event.freshUntil"),
      supersedesEventId: nullableUuid(event.supersedesEventId, "event.supersedesEventId"),
    },
    observedAt: timestamp(selected.observedAt, "observedAt"),
    effectiveAt: timestamp(selected.effectiveAt, "effectiveAt"),
    privacyTier: oneOf(selected.privacyTier, CONTINUITY_PRIVACY_TIERS, "privacyTier"),
  };
}

function validateSignature(value: unknown): ContinuitySignature | null {
  if (value === null) return null;
  const selected = object(value, "signature");
  exactKeys(selected, ["algorithm", "keyId", "publicKey", "value"], "signature");
  if (selected.algorithm !== "Ed25519") throw new Error("signature.algorithm must be Ed25519");
  const publicKey = string(selected.publicKey, "signature.publicKey", 256);
  const signatureValue = string(selected.value, "signature.value", 128);
  if (!BASE64.test(publicKey) || !BASE64.test(signatureValue)) throw new Error("signature material must be canonical base64");
  return {
    algorithm: "Ed25519",
    keyId: digest(selected.keyId, "signature.keyId"),
    publicKey,
    value: signatureValue,
  };
}

export function validateStoredEvent(value: unknown): ContinuityEvent {
  const selected = object(value, "stored continuity event");
  exactKeys(selected, [
    "schemaVersion", "eventId", "subject", "source", "event", "observedAt", "effectiveAt", "privacyTier",
    "sequence", "predecessorHash", "eventHash", "signature",
  ], "stored continuity event");
  const draft = validateEventDraft(Object.fromEntries(Object.entries(selected).filter(([key]) => !["sequence", "predecessorHash", "eventHash", "signature"].includes(key))));
  return {
    ...draft,
    sequence: integer(selected.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
    predecessorHash: digest(selected.predecessorHash, "predecessorHash"),
    eventHash: digest(selected.eventHash, "eventHash"),
    signature: validateSignature(selected.signature),
  };
}

export function validateContinuityRoot(value: unknown): ContinuityRoot {
  const selected = object(value, "continuity root");
  exactKeys(selected, ["schemaVersion", "receiptFileSha256", "receiptHash", "rootHash", "subject", "historicalVerification", "createdAt"], "continuity root");
  if (selected.schemaVersion !== "agent-vigil-continuity-root/v1") throw new Error("unsupported continuity root schema");
  return {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: digest(selected.receiptFileSha256, "receiptFileSha256"),
    receiptHash: digest(selected.receiptHash, "receiptHash"),
    rootHash: digest(selected.rootHash, "rootHash"),
    subject: validateContinuitySubject(selected.subject),
    historicalVerification: oneOf(selected.historicalVerification, ["PASS", "FAIL", "INCONCLUSIVE"] as const, "historicalVerification"),
    createdAt: timestamp(selected.createdAt, "createdAt"),
  };
}

export function validateContinuityPolicy(value: unknown): ContinuityPolicy {
  const selected = object(value, "continuity policy");
  exactKeys(selected, [
    "schemaVersion", "requiredSources", "maxAgeSeconds", "denyOn", "allowRemediation",
    "requireSignedRoot", "requireSignedEvents", "trustedRootKeyIds", "trustedIssuerKeyIds",
    "protectedEnvironments", "maxClockSkewSeconds",
  ], "continuity policy");
  if (selected.schemaVersion !== "agent-vigil-continuity-policy/v1") throw new Error("unsupported continuity policy schema");
  const requiredSources = stringArray(selected.requiredSources, "requiredSources", safeSource);
  const ages = object(selected.maxAgeSeconds, "maxAgeSeconds");
  if (Object.keys(ages).length > 64) throw new Error("maxAgeSeconds exceeds 64 entries");
  const maxAgeSeconds: Record<string, number> = {};
  for (const [key, value] of Object.entries(ages)) {
    const source = safeSource(key, "maxAgeSeconds key");
    maxAgeSeconds[source] = integer(value, `maxAgeSeconds.${source}`, 1, 31_536_000);
  }
  const denyOn = stringArray(selected.denyOn, "denyOn", (item, label) => oneOf(item, CONTINUITY_EVENT_KINDS, label)) as ContinuityEventKind[];
  return {
    schemaVersion: "agent-vigil-continuity-policy/v1",
    requiredSources,
    maxAgeSeconds,
    denyOn,
    allowRemediation: boolean(selected.allowRemediation, "allowRemediation"),
    requireSignedRoot: boolean(selected.requireSignedRoot, "requireSignedRoot"),
    requireSignedEvents: boolean(selected.requireSignedEvents, "requireSignedEvents"),
    trustedRootKeyIds: stringArray(selected.trustedRootKeyIds, "trustedRootKeyIds", digest),
    trustedIssuerKeyIds: stringArray(selected.trustedIssuerKeyIds, "trustedIssuerKeyIds", digest),
    protectedEnvironments: stringArray(selected.protectedEnvironments, "protectedEnvironments", safeIdentifier),
    maxClockSkewSeconds: integer(selected.maxClockSkewSeconds, "maxClockSkewSeconds", 0, 86_400),
  };
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalSha256(value: unknown): string {
  return sha256(canonical(value));
}

export function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Buffer {
  const absolute = resolve(path);
  const expected = lstatSync(absolute, { bigint: true });
  if (expected.isSymbolicLink() || !expected.isFile()) throw new Error(`${label} must be a regular file, not a symbolic link`);
  if (expected.size > BigInt(maximumBytes)) throw new Error(`${label} exceeds the ${maximumBytes} byte limit`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  const descriptor = openSync(absolute, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size
      || opened.mtimeNs !== expected.mtimeNs || opened.ctimeNs !== expected.ctimeNs) {
      throw new Error(`${label} changed while being read`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed while being read`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    let finalPath: ReturnType<typeof lstatSync>;
    try {
      finalPath = lstatSync(absolute, { bigint: true });
    } catch {
      throw new Error(`${label} changed while being read`);
    }
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || finalPath.isSymbolicLink() || !finalPath.isFile()
      || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino || finalPath.size !== opened.size
      || finalPath.mtimeNs !== opened.mtimeNs || finalPath.ctimeNs !== opened.ctimeNs) {
      throw new Error(`${label} changed while being read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedJson(path: string, maximumBytes: number, label: string): unknown {
  const bytes = readBoundedRegularFile(path, maximumBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function loadEventDraft(path: string): ContinuityEventDraft {
  return validateEventDraft(readBoundedJson(path, MAX_EVENT_BYTES, "continuity event"));
}

export function loadContinuityPolicy(options: { path: string; repo?: string; ref?: string }): LoadedContinuityPolicy {
  let raw: string;
  let source: string;
  if (options.ref) {
    if (!options.repo) throw new Error("--policy-ref requires --repo");
    if (!GIT_SHA.test(options.ref)) throw new Error("--policy-ref must be a full lowercase Git object ID");
    const pathParts = options.path.split("/");
    if (isAbsolute(options.path) || options.path.includes("\\") || pathParts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("a Git-anchored continuity policy must use a repository-relative POSIX path");
    }
    const repo = resolve(options.repo);
    try {
      raw = execFileSync("git", ["show", `${options.ref}:${options.path}`], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_POLICY_BYTES,
      });
    } catch {
      throw new Error(`continuity policy could not be loaded from ${options.path}@${options.ref}`);
    }
    source = `${options.path}@${options.ref}`;
  } else {
    raw = readBoundedRegularFile(options.path, MAX_POLICY_BYTES, "continuity policy").toString("utf8");
    source = resolve(options.path);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("continuity policy is not valid JSON"); }
  const value = validateContinuityPolicy(parsed);
  return { value, source, sha256: sha256(raw) };
}
