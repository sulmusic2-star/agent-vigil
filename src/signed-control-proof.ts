import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical } from "./report.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";

export const SIGNED_CONTROL_PROOF_SCHEMA = "control-proof/signed-challenge-v1" as const;

export type SignedChallenge = {
  id: string;
  expected: "PASS" | "BLOCK" | "HOLD";
  actual: "PASS" | "BLOCK" | "HOLD" | "ERROR";
  passed: boolean;
  evidenceHash: string;
};

export type SignedControlProofPayload = {
  control: { vendor: string; product: string; version: string };
  sourceCommit: string;
  generatedAt: string;
  status: "PASS" | "HOLD";
  challenges: SignedChallenge[];
  summary: { passed: number; total: number };
  limits: string[];
};

export type SignedControlProof = {
  schemaVersion: typeof SIGNED_CONTROL_PROOF_SCHEMA;
  payload: SignedControlProofPayload;
  payloadHash: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
    value: string;
  };
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const expected = [...keys].sort();
  if (canonical(Object.keys(value).sort()) !== canonical(expected)) throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
}

function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} must be plain text between 1 and ${maximum} characters`);
  }
  return value.trim();
}

function name(value: unknown, label: string): string {
  const parsed = text(value, label, 80);
  if (!/^[A-Za-z0-9_.-]+$/.test(parsed)) throw new Error(`${label} must contain only letters, numbers, dot, underscore, or hyphen`);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  }
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const parsed = text(value, label, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label} must be sha256:<64 lowercase hex characters>`);
  return parsed;
}

function commitSha(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^[a-f0-9]{40}$/.test(parsed)) throw new Error(`${label} must be a full lowercase Git commit SHA`);
  return parsed;
}

function base64(value: unknown, label: string, expectedBytes?: number): Buffer {
  const parsed = text(value, label, 8192);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed)) throw new Error(`${label} must be canonical base64`);
  const decoded = Buffer.from(parsed, "base64");
  if (decoded.toString("base64") !== parsed || (expectedBytes !== undefined && decoded.length !== expectedBytes)) throw new Error(`${label} has an invalid length or encoding`);
  return decoded;
}

function parsePayload(input: unknown): SignedControlProofPayload {
  const payload = record(input, "signed proof payload");
  exactKeys(payload, ["control", "sourceCommit", "generatedAt", "status", "challenges", "summary", "limits"], "signed proof payload");
  const control = record(payload.control, "signed proof payload.control");
  exactKeys(control, ["vendor", "product", "version"], "signed proof payload.control");
  if (payload.status !== "PASS" && payload.status !== "HOLD") throw new Error("signed proof payload.status must be PASS or HOLD");
  if (!Array.isArray(payload.challenges) || payload.challenges.length === 0 || payload.challenges.length > 100) throw new Error("signed proof payload.challenges must contain 1 to 100 items");
  const ids = new Set<string>();
  const challenges = payload.challenges.map((value, index): SignedChallenge => {
    const item = record(value, `signed proof payload.challenges[${index}]`);
    exactKeys(item, ["id", "expected", "actual", "passed", "evidenceHash"], `signed proof payload.challenges[${index}]`);
    if (!new Set(["PASS", "BLOCK", "HOLD"]).has(String(item.expected))) throw new Error(`signed proof payload.challenges[${index}].expected is invalid`);
    if (!new Set(["PASS", "BLOCK", "HOLD", "ERROR"]).has(String(item.actual))) throw new Error(`signed proof payload.challenges[${index}].actual is invalid`);
    if (typeof item.passed !== "boolean" || item.passed !== (item.actual === item.expected)) throw new Error(`signed proof payload.challenges[${index}] has inconsistent decision fields`);
    const id = name(item.id, `signed proof payload.challenges[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate signed proof challenge: ${id}`);
    ids.add(id);
    return {
      id,
      expected: item.expected as SignedChallenge["expected"],
      actual: item.actual as SignedChallenge["actual"],
      passed: item.passed,
      evidenceHash: sha256(item.evidenceHash, `signed proof payload.challenges[${index}].evidenceHash`),
    };
  });
  const summary = record(payload.summary, "signed proof payload.summary");
  exactKeys(summary, ["passed", "total"], "signed proof payload.summary");
  const passed = challenges.filter((item) => item.passed).length;
  if (summary.passed !== passed || summary.total !== challenges.length) throw new Error("signed proof payload.summary does not match its challenges");
  if (payload.status !== (passed === challenges.length ? "PASS" : "HOLD")) throw new Error("signed proof payload.status does not match its challenges");
  if (!Array.isArray(payload.limits) || payload.limits.length > 100) throw new Error("signed proof payload.limits must be an array with at most 100 items");
  return {
    control: {
      vendor: name(control.vendor, "signed proof payload.control.vendor"),
      product: name(control.product, "signed proof payload.control.product"),
      version: text(control.version, "signed proof payload.control.version", 160),
    },
    sourceCommit: commitSha(payload.sourceCommit, "signed proof payload.sourceCommit"),
    generatedAt: timestamp(payload.generatedAt, "signed proof payload.generatedAt"),
    status: payload.status,
    challenges,
    summary: { passed, total: challenges.length },
    limits: payload.limits.map((item, index) => text(item, `signed proof payload.limits[${index}]`, 1000)),
  };
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

export function signControlProof(payloadInput: unknown, privateKeyPath: string): SignedControlProof {
  const payload = parsePayload(payloadInput);
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signed proof private key must be Ed25519");
  const der = publicKeyDer(createPublicKey(privateKey));
  const payloadHash = digest(payload);
  return {
    schemaVersion: SIGNED_CONTROL_PROOF_SCHEMA,
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

export function verifySignedControlProof(input: unknown, pinnedPublicKeyPath?: string): SignedControlProof {
  const root = record(input, "signed control proof");
  exactKeys(root, ["schemaVersion", "payload", "payloadHash", "signature"], "signed control proof");
  if (root.schemaVersion !== SIGNED_CONTROL_PROOF_SCHEMA) throw new Error(`signed control proof schemaVersion must be ${SIGNED_CONTROL_PROOF_SCHEMA}`);
  const payload = parsePayload(root.payload);
  const payloadHash = sha256(root.payloadHash, "signed control proof payloadHash");
  if (digest(payload) !== payloadHash) throw new Error("signed control proof payload hash is invalid");
  const signature = record(root.signature, "signed control proof signature");
  exactKeys(signature, ["algorithm", "keyId", "publicKey", "value"], "signed control proof signature");
  if (signature.algorithm !== "Ed25519") throw new Error("signed control proof signature algorithm must be Ed25519");
  const embeddedDer = base64(signature.publicKey, "signed control proof signature.publicKey");
  const embedded = ed25519PublicKey(embeddedDer, "signed control proof embedded key");
  const embeddedId = signingKeyId(publicKeyDer(embedded));
  const keyId = sha256(signature.keyId, "signed control proof signature.keyId");
  if (embeddedId !== keyId) throw new Error("signed control proof key ID does not match its embedded key");
  let selected = embedded;
  if (pinnedPublicKeyPath) {
    selected = createPublicKey(readFileSync(pinnedPublicKeyPath));
    if (selected.asymmetricKeyType !== "ed25519") throw new Error("pinned signed proof public key must be Ed25519");
    if (signingKeyId(publicKeyDer(selected)) !== keyId) throw new Error("signed control proof signer does not match the pinned public key");
  }
  const value = base64(signature.value, "signed control proof signature.value", 64);
  if (!verify(null, Buffer.from(payloadHash), selected, value)) throw new Error("signed control proof signature is invalid");
  return {
    schemaVersion: SIGNED_CONTROL_PROOF_SCHEMA,
    payload,
    payloadHash,
    signature: { algorithm: "Ed25519", keyId, publicKey: embeddedDer.toString("base64"), value: value.toString("base64") },
  };
}

export function signedControlIdentity(proof: SignedControlProof): string {
  return `${proof.payload.control.vendor}/${proof.payload.control.product}@${proof.signature.keyId}`;
}
