import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { publicKeyDer, signingKeyId } from "../signature.ts";
import {
  CONTINUITY_STATES,
  canonicalSha256,
  readBoundedJson,
  readBoundedRegularFile,
  validateContinuitySubject,
  validateProtectedEnvironment,
  type ContinuitySignature,
  type ContinuityState,
  type ContinuitySubject,
} from "./contracts.ts";
import type { ChainVerification } from "./chain.ts";
import type { ContinuityDecision } from "./decision.ts";

export const CONTINUITY_STAPLE_SCHEMA = "agent-vigil-continuity-staple/v1" as const;
export const DEFAULT_STAPLE_TTL_SECONDS = 300;
export const MAX_STAPLE_TTL_SECONDS = 900;
export const STAPLE_CLOCK_SKEW_SECONDS = 60;

export type ContinuityStaplePayload = {
  schemaVersion: typeof CONTINUITY_STAPLE_SCHEMA;
  subject: ContinuitySubject;
  decision: {
    continuity: ContinuityState;
    allowsProtectedAction: boolean;
    evaluatedAt: string;
    decisionHash: string;
  };
  evidence: {
    rootHash: string;
    chainTip: string;
    sequence: number;
    eventCount: number;
  };
  policy: {
    sourceHash: string;
    sha256: string;
  };
  environment: string;
  issuedAt: string;
  expiresAt: string;
};

export type SignedContinuityStaple = {
  schemaVersion: typeof CONTINUITY_STAPLE_SCHEMA;
  payload: ContinuityStaplePayload;
  payloadHash: string;
  signature: ContinuitySignature;
};

export type ContinuityStapleVerification = {
  schemaVersion: "agent-vigil-continuity-staple-verification/v1";
  valid: true;
  fresh: boolean;
  signerPinned: true;
  embeddedContinuity: ContinuityState;
  effectiveContinuity: ContinuityState;
  allowsProtectedAction: boolean;
  subject: ContinuitySubject;
  environment: string;
  policySha256: string;
  chainTip: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  payloadHash: string;
  signerKeyId: string;
  limits: string[];
};

type VerifyStapleOptions = {
  publicKeyPath: string;
  expectedHead: string;
  expectedReceiptHash: string;
  expectedEnvironment: string;
  expectedPolicySha256: string;
  now?: Date;
  minimumSequence?: number;
  expectedChainTip?: string;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_STAPLE_BYTES = 256 * 1024;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return value;
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) throw new Error(`${label} must be a full lowercase Git object ID`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be canonical RFC3339 UTC`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} must be canonical RFC3339 UTC`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function base64(value: unknown, label: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !value || value.length > 8192 || !BASE64.test(value)) throw new Error(`${label} must be canonical base64`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new Error(`${label} has an invalid length or encoding`);
  }
  return decoded;
}

function state(value: unknown, label: string): ContinuityState {
  if (typeof value !== "string" || !CONTINUITY_STATES.includes(value as ContinuityState)) throw new Error(`${label} is unsupported`);
  return value as ContinuityState;
}

function ed25519PublicKey(der: Buffer, label: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, type: "spki", format: "der" });
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${label} must be Ed25519`);
  return key;
}

function parsePayload(value: unknown): ContinuityStaplePayload {
  const selected = object(value, "continuity staple payload");
  exactKeys(selected, ["schemaVersion", "subject", "decision", "evidence", "policy", "environment", "issuedAt", "expiresAt"], "continuity staple payload");
  if (selected.schemaVersion !== CONTINUITY_STAPLE_SCHEMA) throw new Error("unsupported continuity staple payload schema");

  const decision = object(selected.decision, "continuity staple decision");
  exactKeys(decision, ["continuity", "allowsProtectedAction", "evaluatedAt", "decisionHash"], "continuity staple decision");
  const continuity = state(decision.continuity, "continuity staple decision.continuity");
  const allowsProtectedAction = boolean(decision.allowsProtectedAction, "continuity staple decision.allowsProtectedAction");
  if (allowsProtectedAction !== (continuity === "CURRENT")) throw new Error("continuity staple decision fields are inconsistent");

  const evidence = object(selected.evidence, "continuity staple evidence");
  exactKeys(evidence, ["rootHash", "chainTip", "sequence", "eventCount"], "continuity staple evidence");
  const sequence = integer(evidence.sequence, "continuity staple evidence.sequence", 0, 100_000);
  const eventCount = integer(evidence.eventCount, "continuity staple evidence.eventCount", 0, 100_000);
  if (sequence !== eventCount) throw new Error("continuity staple evidence sequence must equal its complete event count");

  const policy = object(selected.policy, "continuity staple policy");
  exactKeys(policy, ["sourceHash", "sha256"], "continuity staple policy");
  const issuedAt = timestamp(selected.issuedAt, "continuity staple issuedAt");
  const evaluatedAt = timestamp(decision.evaluatedAt, "continuity staple decision.evaluatedAt");
  if (evaluatedAt !== issuedAt) throw new Error("continuity staple issue time must equal its evaluation time");
  const expiresAt = timestamp(selected.expiresAt, "continuity staple expiresAt");
  const lifetime = (Date.parse(expiresAt) - Date.parse(issuedAt)) / 1000;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_STAPLE_TTL_SECONDS) {
    throw new Error(`continuity staple lifetime must be from 1 through ${MAX_STAPLE_TTL_SECONDS} seconds`);
  }

  return {
    schemaVersion: CONTINUITY_STAPLE_SCHEMA,
    subject: validateContinuitySubject(selected.subject),
    decision: {
      continuity,
      allowsProtectedAction,
      evaluatedAt,
      decisionHash: digest(decision.decisionHash, "continuity staple decision.decisionHash"),
    },
    evidence: {
      rootHash: digest(evidence.rootHash, "continuity staple evidence.rootHash"),
      chainTip: digest(evidence.chainTip, "continuity staple evidence.chainTip"),
      sequence,
      eventCount,
    },
    policy: {
      sourceHash: digest(policy.sourceHash, "continuity staple policy.sourceHash"),
      sha256: digest(policy.sha256, "continuity staple policy.sha256"),
    },
    environment: validateProtectedEnvironment(selected.environment),
    issuedAt,
    expiresAt,
  };
}

export function issueContinuityStaple(options: {
  verification: ChainVerification;
  decision: ContinuityDecision;
  privateKeyPath: string;
  ttlSeconds?: number;
}): SignedContinuityStaple {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_STAPLE_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_STAPLE_TTL_SECONDS) {
    throw new Error(`continuity staple TTL must be from 1 through ${MAX_STAPLE_TTL_SECONDS} seconds`);
  }
  if (!options.decision.protectedEnvironment) throw new Error("continuity staple requires a protected environment");
  if (options.decision.rootHash !== options.verification.root.rootHash) throw new Error("continuity staple decision does not match the verified root");
  if (options.decision.chainTip !== options.verification.chainTip) throw new Error("continuity staple decision does not match the verified chain tip");
  if (options.decision.eventCount !== options.verification.events.length) throw new Error("continuity staple decision does not match the complete event history");

  const issuedAt = options.decision.evaluatedAt;
  const expiresAt = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString();
  const sequence = options.verification.events.at(-1)?.sequence ?? 0;
  const payload = parsePayload({
    schemaVersion: CONTINUITY_STAPLE_SCHEMA,
    subject: options.verification.root.subject,
    decision: {
      continuity: options.decision.continuity,
      allowsProtectedAction: options.decision.allowsProtectedAction,
      evaluatedAt: options.decision.evaluatedAt,
      decisionHash: options.decision.decisionHash,
    },
    evidence: {
      rootHash: options.decision.rootHash,
      chainTip: options.decision.chainTip,
      sequence,
      eventCount: options.decision.eventCount,
    },
    policy: options.decision.policy,
    environment: options.decision.protectedEnvironment,
    issuedAt,
    expiresAt,
  });
  const privateKey = createPrivateKey(readBoundedRegularFile(options.privateKeyPath, 64 * 1024, "continuity staple signing key"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("continuity staple signing key must be Ed25519");
  const der = publicKeyDer(createPublicKey(privateKey));
  const payloadHash = canonicalSha256(payload);
  return {
    schemaVersion: CONTINUITY_STAPLE_SCHEMA,
    payload,
    payloadHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(payloadHash), privateKey).toString("base64"),
    },
  };
}

export function loadContinuityStaple(path: string): unknown {
  return readBoundedJson(path, MAX_STAPLE_BYTES, "continuity staple");
}

export function verifyContinuityStaple(input: unknown, options: VerifyStapleOptions): ContinuityStapleVerification {
  const selected = object(input, "signed continuity staple");
  exactKeys(selected, ["schemaVersion", "payload", "payloadHash", "signature"], "signed continuity staple");
  if (selected.schemaVersion !== CONTINUITY_STAPLE_SCHEMA) throw new Error("unsupported signed continuity staple schema");
  const payload = parsePayload(selected.payload);
  const payloadHash = digest(selected.payloadHash, "continuity staple payloadHash");
  if (canonicalSha256(payload) !== payloadHash) throw new Error("continuity staple payload hash is invalid");

  const signature = object(selected.signature, "continuity staple signature");
  exactKeys(signature, ["algorithm", "keyId", "publicKey", "value"], "continuity staple signature");
  if (signature.algorithm !== "Ed25519") throw new Error("continuity staple signature algorithm must be Ed25519");
  const embeddedDer = base64(signature.publicKey, "continuity staple signature.publicKey");
  const embedded = ed25519PublicKey(embeddedDer, "continuity staple embedded key");
  const embeddedId = signingKeyId(publicKeyDer(embedded));
  const keyId = digest(signature.keyId, "continuity staple signature.keyId");
  if (embeddedId !== keyId) throw new Error("continuity staple key ID does not match its embedded key");

  const pinned = createPublicKey(readBoundedRegularFile(options.publicKeyPath, 64 * 1024, "pinned continuity staple public key"));
  if (pinned.asymmetricKeyType !== "ed25519") throw new Error("pinned continuity staple public key must be Ed25519");
  if (signingKeyId(publicKeyDer(pinned)) !== keyId) throw new Error("continuity staple signer does not match the pinned public key");
  const signatureValue = base64(signature.value, "continuity staple signature.value", 64);
  if (!verify(null, Buffer.from(payloadHash), pinned, signatureValue)) throw new Error("continuity staple signature is invalid");

  const expectedHead = gitSha(options.expectedHead, "expected continuity staple head");
  if (payload.subject.headSha !== expectedHead) throw new Error("continuity staple belongs to a different head commit");
  const expectedReceiptHash = digest(options.expectedReceiptHash, "expected continuity staple receipt hash");
  if (payload.subject.episodeReceiptHash !== expectedReceiptHash) throw new Error("continuity staple belongs to a different original receipt");
  const expectedEnvironment = validateProtectedEnvironment(options.expectedEnvironment);
  if (payload.environment !== expectedEnvironment) throw new Error("continuity staple belongs to a different protected environment");
  const expectedPolicy = digest(options.expectedPolicySha256, "expected continuity staple policy hash");
  if (payload.policy.sha256 !== expectedPolicy) throw new Error("continuity staple was evaluated under a different policy");
  if (options.expectedChainTip && payload.evidence.chainTip !== digest(options.expectedChainTip, "expected continuity staple chain tip")) {
    throw new Error("continuity staple does not match the expected chain tip");
  }
  if (options.minimumSequence !== undefined) {
    const minimumSequence = integer(options.minimumSequence, "minimum continuity staple sequence");
    if (payload.evidence.sequence < minimumSequence) throw new Error("continuity staple predates the minimum accepted evidence sequence");
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("continuity staple verification time is invalid");
  if (Date.parse(payload.issuedAt) - now.getTime() > STAPLE_CLOCK_SKEW_SECONDS * 1000) {
    throw new Error("continuity staple is implausibly future-dated");
  }
  const fresh = now.getTime() < Date.parse(payload.expiresAt);
  const effectiveContinuity = payload.decision.continuity === "REVOKED"
    ? "REVOKED"
    : fresh
      ? payload.decision.continuity
      : "EXPIRED";
  return {
    schemaVersion: "agent-vigil-continuity-staple-verification/v1",
    valid: true,
    fresh,
    signerPinned: true,
    embeddedContinuity: payload.decision.continuity,
    effectiveContinuity,
    allowsProtectedAction: fresh && effectiveContinuity === "CURRENT",
    subject: payload.subject,
    environment: payload.environment,
    policySha256: payload.policy.sha256,
    chainTip: payload.evidence.chainTip,
    sequence: payload.evidence.sequence,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    payloadHash,
    signerKeyId: keyId,
    limits: [
      "This is a short-lived point-in-time status statement, not proof that code is defect-free.",
      "An offline verifier cannot discover a newer status before this staple expires unless it also pins a newer chain tip or minimum sequence.",
    ],
  };
}
