import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { resolve } from "node:path";
import { readBoundedJson, readBoundedRegularFile } from "./continuity/contracts.ts";
import { dssePae } from "./dsse.ts";
import { validateGuardRouteReport } from "./continuity/guard.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";
import type { GuardRouteReportV2 } from "./guard-route.ts";

export const GUARD_ROUTE_PAYLOAD_TYPE = "application/vnd.agent-vigil.live-host-route+json;version=2" as const;

const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type GuardRouteEnvelope = {
  payloadType: typeof GUARD_ROUTE_PAYLOAD_TYPE;
  payload: string;
  signatures: [{ keyid: string; sig: string }];
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

function canonicalBase64(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maximum
    || !BASE64.test(value) || Buffer.from(value, "base64").toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  }
  return value;
}

export { dssePae } from "./dsse.ts";

function normalizedPayload(report: unknown): { report: GuardRouteReportV2; bytes: Buffer } {
  const validated = validateGuardRouteReport(report);
  if (validated.schemaVersion !== "agent-vigil-live-host-route/v2") {
    throw new Error("only live-host route v2 receipts can be sealed");
  }
  const bytes = Buffer.from(JSON.stringify(validated), "utf8");
  return { report: validated, bytes };
}

export function sealGuardRoute(report: unknown, privateKeyPath: string): GuardRouteEnvelope {
  const { bytes } = normalizedPayload(report);
  const privateKey = createPrivateKey(readBoundedRegularFile(
    resolve(privateKeyPath),
    MAX_KEY_BYTES,
    "guard route sealing key",
  ));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("guard route sealing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  return {
    payloadType: GUARD_ROUTE_PAYLOAD_TYPE,
    payload: bytes.toString("base64"),
    signatures: [{
      keyid: signingKeyId(publicKeyDer(publicKey)),
      sig: sign(null, dssePae(GUARD_ROUTE_PAYLOAD_TYPE, bytes), privateKey).toString("base64"),
    }],
  };
}

export function validateGuardRouteEnvelope(value: unknown): GuardRouteEnvelope {
  const root = object(value, "guard route envelope");
  exactKeys(root, ["payloadType", "payload", "signatures"], "guard route envelope");
  if (root.payloadType !== GUARD_ROUTE_PAYLOAD_TYPE) throw new Error("unsupported guard route payload type");
  const payload = canonicalBase64(root.payload, "guard route envelope payload", MAX_ENVELOPE_BYTES);
  if (!Array.isArray(root.signatures) || root.signatures.length !== 1) {
    throw new Error("guard route envelope must contain exactly one signature");
  }
  const signature = object(root.signatures[0], "guard route envelope signature");
  exactKeys(signature, ["keyid", "sig"], "guard route envelope signature");
  return {
    payloadType: GUARD_ROUTE_PAYLOAD_TYPE,
    payload,
    signatures: [{
      keyid: digest(signature.keyid, "guard route envelope signature keyid"),
      sig: canonicalBase64(signature.sig, "guard route envelope signature", 8192),
    }],
  };
}

export function openGuardRouteEnvelope(
  value: unknown,
  trustedRoutePublicKey: string | Buffer | KeyObject,
): { envelope: GuardRouteEnvelope; report: GuardRouteReportV2; routeSignerKeyId: string } {
  const envelope = validateGuardRouteEnvelope(value);
  const bytes = Buffer.from(envelope.payload, "base64");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("guard route envelope payload must contain valid JSON"); }
  const normalized = normalizedPayload(parsed);
  if (!bytes.equals(normalized.bytes)) {
    throw new Error("guard route envelope payload is not the canonical validated receipt");
  }
  const publicKey = typeof trustedRoutePublicKey === "string" || Buffer.isBuffer(trustedRoutePublicKey)
    ? createPublicKey(trustedRoutePublicKey)
    : trustedRoutePublicKey;
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("guard route public key must be Ed25519");
  const routeSignerKeyId = signingKeyId(publicKeyDer(publicKey));
  const selected = envelope.signatures[0];
  if (selected.keyid !== routeSignerKeyId
    || !verify(null, dssePae(envelope.payloadType, bytes), publicKey, Buffer.from(selected.sig, "base64"))) {
    throw new Error("guard route envelope signature is invalid for the pinned key");
  }
  return { envelope, report: normalized.report, routeSignerKeyId };
}

export function loadGuardRouteEnvelope(path: string): GuardRouteEnvelope {
  return validateGuardRouteEnvelope(readBoundedJson(resolve(path), MAX_ENVELOPE_BYTES, "guard route envelope"));
}
