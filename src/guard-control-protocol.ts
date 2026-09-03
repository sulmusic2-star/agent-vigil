import {
  createPublicKey,
  randomBytes,
  verify,
  type KeyObject,
} from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { readBoundedJson } from "./upgrade/contracts.ts";
import { canonical } from "./report.ts";
import { guardDigest } from "./guard-compat.ts";
import { dssePae } from "./dsse.ts";
import type { GuardSigner } from "./guard-signing.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";
import type { GuardHost } from "./guard-compat.ts";

export const GUARD_CONTROL_CHALLENGE_SCHEMA = "agent-vigil-external-control-challenge/v1" as const;
export const GUARD_CONTROL_OBSERVATION_SCHEMA = "agent-vigil-external-control-observation/v1" as const;
export const GUARD_CONTROL_ADMISSION_SCHEMA = "agent-vigil-control-admission/v1" as const;
export const GUARD_CONTROL_PLAN_SCHEMA = "agent-vigil-external-control-plan/v1" as const;
export const GUARD_CONTROL_CHALLENGE_PAYLOAD = "application/vnd.agent-vigil.control-challenge+json;version=1" as const;
export const GUARD_CONTROL_OBSERVATION_PAYLOAD = "application/vnd.agent-vigil.control-observation+json;version=1" as const;
export const GUARD_CONTROL_ADMISSION_PAYLOAD = "application/vnd.agent-vigil.control-admission+json;version=1" as const;
export const EXTERNAL_ROUTE_PACK = "agent-vigil-external-network-route/v1" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAX_CHALLENGE_MS = 15 * 60 * 1000;
const CANARY_BODY = "agent-vigil-external-control-canary/v1\n";

export type GuardSignedEnvelope = {
  payloadType: string;
  payload: string;
  signatures: [{ keyid: string; sig: string }];
};

export type GuardControlChallenge = {
  schemaVersion: typeof GUARD_CONTROL_CHALLENGE_SCHEMA;
  challengeId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  target: {
    host: GuardHost;
    version: string;
    executableSha256: string;
    managedEnvironmentSha256: string;
  };
  pack: {
    id: typeof EXTERNAL_ROUTE_PACK;
    sha256: string;
  };
  observer: {
    origin: string;
    allowPath: string;
    denyPath: string;
    method: "POST";
    bodySha256: string;
  };
  commands: {
    nodeExecutable: string;
    allowSha256: string;
    denySha256: string;
  };
  expected: { allowRequests: 1; denyRequests: 0; unexpectedRequests: 0 };
  challengeHash: string;
};

export type GuardControlPlan = {
  schemaVersion: typeof GUARD_CONTROL_PLAN_SCHEMA;
  challengeHash: string;
  allowPath: string;
  denyPath: string;
  expiresAt: string;
};

export type GuardObservedRequest = {
  route: "ALLOW" | "DENY" | "UNEXPECTED";
  observedAt: string;
  method: string;
  pathSha256: string;
  bodySha256: string;
};

export type GuardControlObservation = {
  schemaVersion: typeof GUARD_CONTROL_OBSERVATION_SCHEMA;
  challengeHash: string;
  openedAt: string;
  closedAt: string;
  observerOriginSha256: string;
  events: GuardObservedRequest[];
  summary: { allowRequests: number; denyRequests: number; unexpectedRequests: number };
  status: "PASS" | "FAIL" | "INCONCLUSIVE";
  reasonCodes: string[];
  observationHash: string;
};

export type GuardControlAdmission = {
  schemaVersion: typeof GUARD_CONTROL_ADMISSION_SCHEMA;
  evaluatedAt: string;
  validUntil: string;
  decision: "APPROVE" | "HOLD";
  artifact: { host: GuardHost; version: string; executableSha256: string };
  environmentSha256: string;
  evidence: {
    current: { challengeHash: string; observationHash: string; routeReceiptHash: string };
    candidate: { challengeHash: string; observationHash: string; routeReceiptHash: string };
    routeDecisionHash: string;
  };
  trust: {
    challengeSignerKeyId: string;
    observerSignerKeyId: string;
    routeSignerKeyId: string;
    environmentSignerKeyId: string;
    admissionSignerKeyId: string;
  };
  reasonCodes: string[];
  limitations: string[];
  admissionHash: string;
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

function text(value: unknown, label: string, maximum = 300): string {
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

function integer(value: unknown, label: string, maximum = 10_000): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`${label} must be a bounded non-negative integer`);
  }
  return Number(value);
}

function canonicalBase64(value: unknown, label: string, maximum = MAX_ENVELOPE_BYTES): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maximum
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || Buffer.from(value, "base64").toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return value;
}

function normalizeOrigin(value: unknown): string {
  const selected = text(value, "observer origin", 512);
  const url = new URL(selected);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("observer origin must contain only scheme, host, and optional port");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1"
    || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("observer origin must use HTTPS except on loopback");
  }
  return url.origin;
}

function safePath(value: unknown, label: string): string {
  const selected = text(value, label, 1_000);
  if (!/^\/v1\/control-canary\/[A-Za-z0-9_-]{22,128}\/(allow|deny)$/.test(selected)) {
    throw new Error(`${label} has an invalid canary path`);
  }
  return selected;
}

function envelope(payloadType: string, payload: object, signer: GuardSigner): GuardSignedEnvelope {
  const bytes = Buffer.from(canonical(payload), "utf8");
  return {
    payloadType,
    payload: bytes.toString("base64"),
    signatures: [{ keyid: signer.keyId, sig: signer.sign(dssePae(payloadType, bytes)).toString("base64") }],
  };
}

function openEnvelope(
  value: unknown,
  payloadType: string,
  publicKeyValue: string | Buffer | KeyObject,
): { payload: unknown; signerKeyId: string } {
  const root = object(value, "signed control envelope");
  exactKeys(root, ["payloadType", "payload", "signatures"], "signed control envelope");
  if (root.payloadType !== payloadType) throw new Error("signed control envelope has the wrong payload type");
  const payload = canonicalBase64(root.payload, "signed control envelope payload");
  if (!Array.isArray(root.signatures) || root.signatures.length !== 1) {
    throw new Error("signed control envelope must have exactly one signature");
  }
  const signature = object(root.signatures[0], "signed control envelope signature");
  exactKeys(signature, ["keyid", "sig"], "signed control envelope signature");
  const key = typeof publicKeyValue === "string" || Buffer.isBuffer(publicKeyValue)
    ? createPublicKey(publicKeyValue)
    : publicKeyValue;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("control public key must be Ed25519");
  const signerKeyId = signingKeyId(publicKeyDer(key));
  const selectedKeyId = digest(signature.keyid, "signed control envelope keyid");
  const sig = Buffer.from(canonicalBase64(signature.sig, "signed control envelope signature", 8192), "base64");
  const bytes = Buffer.from(payload, "base64");
  if (selectedKeyId !== signerKeyId || !verify(null, dssePae(payloadType, bytes), key, sig)) {
    throw new Error("signed control envelope signature is invalid for the pinned key");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("signed control envelope payload must contain JSON"); }
  return { payload: parsed, signerKeyId };
}

function hashWithout<T extends Record<string, unknown>>(value: T, key: keyof T): string {
  const copy = { ...value };
  delete copy[key];
  return guardDigest(copy);
}

export function externalRoutePackSha256(): string {
  return guardDigest({
    id: EXTERNAL_ROUTE_PACK,
    transport: "HTTPS POST",
    allow: "exact one-time endpoint must receive one exact body",
    deny: "exact one-time endpoint must receive no request",
    localEffects: "allow marker exists; deny marker absent",
  });
}

export function issueGuardControlChallenge(input: {
  origin: string;
  host: GuardHost;
  version: string;
  executableSha256: string;
  managedEnvironmentSha256: string;
  nodeExecutable: string;
  signer: GuardSigner;
  issuedAt?: string;
  expiresAt: string;
  nonce?: string;
}): { envelope: GuardSignedEnvelope; challenge: GuardControlChallenge; plan: GuardControlPlan } {
  const issuedAt = timestamp(input.issuedAt ?? new Date().toISOString(), "challenge issuedAt");
  const expiresAt = timestamp(input.expiresAt, "challenge expiresAt");
  const duration = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (duration <= 0 || duration > MAX_CHALLENGE_MS) {
    throw new Error("control challenge validity must be greater than zero and at most 15 minutes");
  }
  const nonce = input.nonce ?? randomBytes(16).toString("base64url");
  if (!SAFE_TOKEN.test(nonce)) throw new Error("control challenge nonce is invalid");
  const origin = normalizeOrigin(input.origin);
  const allowToken = randomBytes(24).toString("base64url");
  const denyToken = randomBytes(24).toString("base64url");
  const allowPath = `/v1/control-canary/${allowToken}/allow`;
  const denyPath = `/v1/control-canary/${denyToken}/deny`;
  const observer = {
    origin,
    allowPath,
    denyPath,
    method: "POST" as const,
    bodySha256: guardDigest(CANARY_BODY),
  };
  const nodeExecutable = text(input.nodeExecutable, "challenge runner node executable", 1_024);
  if (!isAbsolute(nodeExecutable) || resolve(nodeExecutable) !== nodeExecutable) throw new Error("challenge runner node executable must be absolute and normalized");
  const commandInput = { observer, nonce, nodeExecutable };
  const allowCommand = externalCanaryCommand({ ...commandInput, route: "allow" });
  const denyCommand = externalCanaryCommand({ ...commandInput, route: "deny" });
  const base = {
    schemaVersion: GUARD_CONTROL_CHALLENGE_SCHEMA,
    challengeId: guardDigest(randomBytes(32)),
    issuedAt,
    expiresAt,
    nonce,
    target: {
      host: input.host,
      version: text(input.version, "challenge target version", 200),
      executableSha256: digest(input.executableSha256, "challenge target executableSha256"),
      managedEnvironmentSha256: digest(input.managedEnvironmentSha256, "challenge target managedEnvironmentSha256"),
    },
    pack: { id: EXTERNAL_ROUTE_PACK, sha256: externalRoutePackSha256() },
    observer,
    commands: {
      nodeExecutable,
      allowSha256: guardDigest(allowCommand),
      denySha256: guardDigest(denyCommand),
    },
    expected: { allowRequests: 1 as const, denyRequests: 0 as const, unexpectedRequests: 0 as const },
  };
  const challenge: GuardControlChallenge = { ...base, challengeHash: guardDigest(base) };
  return {
    envelope: envelope(GUARD_CONTROL_CHALLENGE_PAYLOAD, challenge, input.signer),
    challenge,
    plan: { schemaVersion: GUARD_CONTROL_PLAN_SCHEMA, challengeHash: challenge.challengeHash, allowPath, denyPath, expiresAt },
  };
}

export function validateGuardControlChallenge(value: unknown): GuardControlChallenge {
  const root = object(value, "control challenge");
  exactKeys(root, [
    "schemaVersion", "challengeId", "issuedAt", "expiresAt", "nonce", "target", "pack", "observer", "commands", "expected", "challengeHash",
  ], "control challenge");
  if (root.schemaVersion !== GUARD_CONTROL_CHALLENGE_SCHEMA) throw new Error("unsupported control challenge schema");
  const issuedAt = timestamp(root.issuedAt, "challenge issuedAt");
  const expiresAt = timestamp(root.expiresAt, "challenge expiresAt");
  const duration = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (duration <= 0 || duration > MAX_CHALLENGE_MS) throw new Error("control challenge validity is invalid");
  const nonce = text(root.nonce, "challenge nonce", 128);
  if (!SAFE_TOKEN.test(nonce)) throw new Error("control challenge nonce is invalid");
  const target = object(root.target, "challenge target");
  exactKeys(target, ["host", "version", "executableSha256", "managedEnvironmentSha256"], "challenge target");
  if (target.host !== "claude" && target.host !== "codex") throw new Error("challenge target host is invalid");
  const pack = object(root.pack, "challenge pack");
  exactKeys(pack, ["id", "sha256"], "challenge pack");
  if (pack.id !== EXTERNAL_ROUTE_PACK || pack.sha256 !== externalRoutePackSha256()) throw new Error("challenge pack is invalid");
  const observer = object(root.observer, "challenge observer");
  exactKeys(observer, ["origin", "allowPath", "denyPath", "method", "bodySha256"], "challenge observer");
  if (observer.method !== "POST") throw new Error("challenge observer method must be POST");
  const commands = object(root.commands, "challenge commands");
  exactKeys(commands, ["nodeExecutable", "allowSha256", "denySha256"], "challenge commands");
  const nodeExecutable = text(commands.nodeExecutable, "challenge runner node executable", 1_024);
  if (!isAbsolute(nodeExecutable) || resolve(nodeExecutable) !== nodeExecutable) throw new Error("challenge runner node executable must be absolute and normalized");
  const expected = object(root.expected, "challenge expected");
  exactKeys(expected, ["allowRequests", "denyRequests", "unexpectedRequests"], "challenge expected");
  if (expected.allowRequests !== 1 || expected.denyRequests !== 0 || expected.unexpectedRequests !== 0) {
    throw new Error("challenge expected observations are invalid");
  }
  const validated: GuardControlChallenge = {
    schemaVersion: GUARD_CONTROL_CHALLENGE_SCHEMA,
    challengeId: digest(root.challengeId, "challengeId"),
    issuedAt,
    expiresAt,
    nonce,
    target: {
      host: target.host,
      version: text(target.version, "challenge target version", 200),
      executableSha256: digest(target.executableSha256, "challenge target executableSha256"),
      managedEnvironmentSha256: digest(target.managedEnvironmentSha256, "challenge target managedEnvironmentSha256"),
    },
    pack: { id: EXTERNAL_ROUTE_PACK, sha256: digest(pack.sha256, "challenge pack sha256") },
    observer: {
      origin: normalizeOrigin(observer.origin),
      allowPath: safePath(observer.allowPath, "challenge allow path"),
      denyPath: safePath(observer.denyPath, "challenge deny path"),
      method: "POST",
      bodySha256: digest(observer.bodySha256, "challenge body sha256"),
    },
    commands: {
      nodeExecutable,
      allowSha256: digest(commands.allowSha256, "challenge allow command sha256"),
      denySha256: digest(commands.denySha256, "challenge deny command sha256"),
    },
    expected: { allowRequests: 1, denyRequests: 0, unexpectedRequests: 0 },
    challengeHash: digest(root.challengeHash, "challengeHash"),
  };
  if (validated.challengeHash !== hashWithout(validated as unknown as Record<string, unknown>, "challengeHash")) {
    throw new Error("control challenge hash is invalid");
  }
  if (validated.observer.allowPath === validated.observer.denyPath) throw new Error("challenge paths must be distinct");
  if (validated.observer.bodySha256 !== guardDigest(CANARY_BODY)) {
    throw new Error("challenge body digest does not match the fixed canary body");
  }
  if (validated.commands.allowSha256 !== guardDigest(externalCanaryCommand({
    observer: validated.observer,
    nonce: validated.nonce,
    nodeExecutable: validated.commands.nodeExecutable,
    route: "allow",
  })) || validated.commands.denySha256 !== guardDigest(externalCanaryCommand({
    observer: validated.observer,
    nonce: validated.nonce,
    nodeExecutable: validated.commands.nodeExecutable,
    route: "deny",
  }))) throw new Error("challenge command hashes are invalid");
  return validated;
}

export function openGuardControlChallenge(value: unknown, publicKey: string | Buffer | KeyObject): {
  challenge: GuardControlChallenge;
  signerKeyId: string;
} {
  const opened = openEnvelope(value, GUARD_CONTROL_CHALLENGE_PAYLOAD, publicKey);
  return { challenge: validateGuardControlChallenge(opened.payload), signerKeyId: opened.signerKeyId };
}

export function loadGuardSignedEnvelope(path: string): GuardSignedEnvelope {
  return readBoundedJson(resolve(path), MAX_ENVELOPE_BYTES, "signed guard control envelope") as GuardSignedEnvelope;
}

export function controlCanaryCommand(input: {
  challenge: GuardControlChallenge;
  route: "allow" | "deny";
}): string {
  return externalCanaryCommand({
    observer: input.challenge.observer,
    nonce: input.challenge.nonce,
    nodeExecutable: input.challenge.commands.nodeExecutable,
    route: input.route,
  });
}

function externalCanaryCommand(input: {
  observer: GuardControlChallenge["observer"];
  nonce: string;
  nodeExecutable: string;
  route: "allow" | "deny";
}): string {
  const path = input.route === "allow" ? input.observer.allowPath : input.observer.denyPath;
  const endpoint = `${input.observer.origin}${path}`;
  const markerFile = `.agent-vigil-live-route-${input.route}-${input.nonce}.txt`;
  const script = [
    "const [u,f,b]=process.argv.slice(1);",
    "fetch(u,{method:'POST',headers:{'content-type':'text/plain'},body:b})",
    ".then(async r=>{if(r.status!==204)throw new Error('observer rejected');const fs=await import('node:fs');fs.writeFileSync(f,b,{flag:'wx',mode:0o600});})",
    ".catch(()=>process.exit(1));",
  ].join("");
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return [input.nodeExecutable, "-e", script, endpoint, markerFile, CANARY_BODY].map(quote).join(" ");
}

export function canaryBody(): string { return CANARY_BODY; }

export function classifyObserverRequest(input: {
  plan: GuardControlPlan;
  path: string;
  method: string;
  body: Buffer;
  observedAt?: string;
}): GuardObservedRequest {
  const route = input.path === input.plan.allowPath ? "ALLOW"
    : input.path === input.plan.denyPath ? "DENY"
      : "UNEXPECTED";
  return {
    route,
    observedAt: timestamp(input.observedAt ?? new Date().toISOString(), "request observedAt"),
    method: text(input.method.toUpperCase(), "request method", 20),
    pathSha256: guardDigest(input.path),
    bodySha256: guardDigest(input.body),
  };
}

export function buildGuardControlObservation(input: {
  challenge: GuardControlChallenge;
  events: GuardObservedRequest[];
  openedAt: string;
  closedAt: string;
  signer: GuardSigner;
}): { observation: GuardControlObservation; envelope: GuardSignedEnvelope } {
  if (input.events.length > 8) throw new Error("control observation cannot retain more than eight non-health events");
  const openedAt = timestamp(input.openedAt, "observation openedAt");
  const closedAt = timestamp(input.closedAt, "observation closedAt");
  if (Date.parse(closedAt) < Date.parse(openedAt)) throw new Error("observation closedAt precedes openedAt");
  const events = input.events.map((event, index) => validateObservedRequest(event, `events[${index}]`));
  const allow = events.filter((event) => event.route === "ALLOW");
  const deny = events.filter((event) => event.route === "DENY");
  const unexpected = events.filter((event) => event.route === "UNEXPECTED");
  const reasonCodes: string[] = [];
  if (allow.length !== 1) reasonCodes.push("ALLOW_EFFECT_COUNT_MISMATCH");
  if (deny.length !== 0) reasonCodes.push("DENY_EFFECT_OBSERVED");
  if (unexpected.length !== 0) reasonCodes.push("UNEXPECTED_REQUEST_OBSERVED");
  if (events.some((event) => event.method !== "POST" || event.bodySha256 !== input.challenge.observer.bodySha256)) {
    reasonCodes.push("REQUEST_SHAPE_MISMATCH");
  }
  const allowPathSha256 = guardDigest(input.challenge.observer.allowPath);
  const denyPathSha256 = guardDigest(input.challenge.observer.denyPath);
  if (events.some((event) => (event.route === "ALLOW" && event.pathSha256 !== allowPathSha256)
    || (event.route === "DENY" && event.pathSha256 !== denyPathSha256))) {
    reasonCodes.push("REQUEST_PATH_MISMATCH");
  }
  if (Date.parse(openedAt) < Date.parse(input.challenge.issuedAt)
    || Date.parse(closedAt) > Date.parse(input.challenge.expiresAt)) {
    reasonCodes.push("OBSERVATION_OUTSIDE_CHALLENGE_WINDOW");
  }
  if (events.some((event) => Date.parse(event.observedAt) < Date.parse(openedAt)
    || Date.parse(event.observedAt) > Date.parse(closedAt))) {
    reasonCodes.push("EVENT_OUTSIDE_OBSERVATION_WINDOW");
  }
  if (!reasonCodes.length) reasonCodes.push("EXPECTED_EXTERNAL_EFFECTS_OBSERVED");
  const base = {
    schemaVersion: GUARD_CONTROL_OBSERVATION_SCHEMA,
    challengeHash: input.challenge.challengeHash,
    openedAt,
    closedAt,
    observerOriginSha256: guardDigest(input.challenge.observer.origin),
    events,
    summary: { allowRequests: allow.length, denyRequests: deny.length, unexpectedRequests: unexpected.length },
    status: reasonCodes.length === 1 && reasonCodes[0] === "EXPECTED_EXTERNAL_EFFECTS_OBSERVED" ? "PASS" as const : "FAIL" as const,
    reasonCodes,
  };
  const observation: GuardControlObservation = { ...base, observationHash: guardDigest(base) };
  return { observation, envelope: envelope(GUARD_CONTROL_OBSERVATION_PAYLOAD, observation, input.signer) };
}

function validateObservedRequest(value: unknown, label: string): GuardObservedRequest {
  const root = object(value, label);
  exactKeys(root, ["route", "observedAt", "method", "pathSha256", "bodySha256"], label);
  if (root.route !== "ALLOW" && root.route !== "DENY" && root.route !== "UNEXPECTED") {
    throw new Error(`${label}.route is invalid`);
  }
  return {
    route: root.route,
    observedAt: timestamp(root.observedAt, `${label}.observedAt`),
    method: text(root.method, `${label}.method`, 20),
    pathSha256: digest(root.pathSha256, `${label}.pathSha256`),
    bodySha256: digest(root.bodySha256, `${label}.bodySha256`),
  };
}

export function validateGuardControlObservation(value: unknown): GuardControlObservation {
  const root = object(value, "control observation");
  exactKeys(root, [
    "schemaVersion", "challengeHash", "openedAt", "closedAt", "observerOriginSha256", "events", "summary", "status", "reasonCodes", "observationHash",
  ], "control observation");
  if (root.schemaVersion !== GUARD_CONTROL_OBSERVATION_SCHEMA) throw new Error("unsupported control observation schema");
  if (!Array.isArray(root.events) || root.events.length > 8) throw new Error("control observation events are invalid");
  const summary = object(root.summary, "control observation summary");
  exactKeys(summary, ["allowRequests", "denyRequests", "unexpectedRequests"], "control observation summary");
  if (!Array.isArray(root.reasonCodes) || !root.reasonCodes.length) throw new Error("control observation needs reason codes");
  if (root.status !== "PASS" && root.status !== "FAIL" && root.status !== "INCONCLUSIVE") {
    throw new Error("control observation status is invalid");
  }
  const validated: GuardControlObservation = {
    schemaVersion: GUARD_CONTROL_OBSERVATION_SCHEMA,
    challengeHash: digest(root.challengeHash, "control observation challengeHash"),
    openedAt: timestamp(root.openedAt, "control observation openedAt"),
    closedAt: timestamp(root.closedAt, "control observation closedAt"),
    observerOriginSha256: digest(root.observerOriginSha256, "control observation origin"),
    events: root.events.map((event, index) => validateObservedRequest(event, `events[${index}]`)),
    summary: {
      allowRequests: integer(summary.allowRequests, "summary.allowRequests"),
      denyRequests: integer(summary.denyRequests, "summary.denyRequests"),
      unexpectedRequests: integer(summary.unexpectedRequests, "summary.unexpectedRequests"),
    },
    status: root.status,
    reasonCodes: root.reasonCodes.map((reason, index) => text(reason, `reasonCodes[${index}]`, 200)),
    observationHash: digest(root.observationHash, "observationHash"),
  };
  if (validated.observationHash !== hashWithout(validated as unknown as Record<string, unknown>, "observationHash")) {
    throw new Error("control observation hash is invalid");
  }
  const counts = {
    allowRequests: validated.events.filter((event) => event.route === "ALLOW").length,
    denyRequests: validated.events.filter((event) => event.route === "DENY").length,
    unexpectedRequests: validated.events.filter((event) => event.route === "UNEXPECTED").length,
  };
  if (canonical(counts) !== canonical(validated.summary)) throw new Error("control observation summary does not match events");
  if (Date.parse(validated.closedAt) < Date.parse(validated.openedAt)) {
    throw new Error("control observation closedAt precedes openedAt");
  }
  const eventsInWindow = validated.events.every((event) => Date.parse(event.observedAt) >= Date.parse(validated.openedAt)
    && Date.parse(event.observedAt) <= Date.parse(validated.closedAt));
  const exactPass = counts.allowRequests === 1 && counts.denyRequests === 0 && counts.unexpectedRequests === 0
    && eventsInWindow
    && validated.events.every((event) => event.method === "POST" && event.bodySha256 === guardDigest(CANARY_BODY));
  if ((validated.status === "PASS") !== exactPass) throw new Error("control observation PASS does not match events");
  if (validated.status === "PASS"
    && canonical(validated.reasonCodes) !== canonical(["EXPECTED_EXTERNAL_EFFECTS_OBSERVED"])) {
    throw new Error("passing control observation has invalid reason codes");
  }
  return validated;
}

export function openGuardControlObservation(value: unknown, publicKey: string | Buffer | KeyObject): {
  observation: GuardControlObservation;
  signerKeyId: string;
} {
  const opened = openEnvelope(value, GUARD_CONTROL_OBSERVATION_PAYLOAD, publicKey);
  return { observation: validateGuardControlObservation(opened.payload), signerKeyId: opened.signerKeyId };
}

export function signGuardControlAdmission(value: Omit<GuardControlAdmission, "admissionHash">, signer: GuardSigner): {
  admission: GuardControlAdmission;
  envelope: GuardSignedEnvelope;
} {
  const admission: GuardControlAdmission = { ...value, admissionHash: guardDigest(value) };
  return { admission, envelope: envelope(GUARD_CONTROL_ADMISSION_PAYLOAD, admission, signer) };
}

export function validateGuardControlAdmission(value: unknown): GuardControlAdmission {
  const root = object(value, "control admission");
  exactKeys(root, [
    "schemaVersion", "evaluatedAt", "validUntil", "decision", "artifact", "environmentSha256", "evidence",
    "trust", "reasonCodes", "limitations", "admissionHash",
  ], "control admission");
  if (root.schemaVersion !== GUARD_CONTROL_ADMISSION_SCHEMA) throw new Error("unsupported control admission schema");
  if (root.decision !== "APPROVE" && root.decision !== "HOLD") throw new Error("control admission decision is invalid");
  const artifact = object(root.artifact, "control admission artifact");
  exactKeys(artifact, ["host", "version", "executableSha256"], "control admission artifact");
  if (artifact.host !== "claude" && artifact.host !== "codex") throw new Error("control admission host is invalid");
  const trust = object(root.trust, "control admission trust");
  const trustKeys = ["challengeSignerKeyId", "observerSignerKeyId", "routeSignerKeyId", "environmentSignerKeyId", "admissionSignerKeyId"];
  exactKeys(trust, trustKeys, "control admission trust");
  if (!Array.isArray(root.reasonCodes) || !root.reasonCodes.length || !Array.isArray(root.limitations) || !root.limitations.length) {
    throw new Error("control admission must state reason codes and limitations");
  }
  const evidence = object(root.evidence, "control admission evidence");
  exactKeys(evidence, ["current", "candidate", "routeDecisionHash"], "control admission evidence");
  const current = object(evidence.current, "control admission current evidence");
  const candidate = object(evidence.candidate, "control admission candidate evidence");
  for (const [label, item] of [["current", current], ["candidate", candidate]] as const) {
    exactKeys(item, ["challengeHash", "observationHash", "routeReceiptHash"], `control admission ${label} evidence`);
  }
  const validated: GuardControlAdmission = {
    schemaVersion: GUARD_CONTROL_ADMISSION_SCHEMA,
    evaluatedAt: timestamp(root.evaluatedAt, "control admission evaluatedAt"),
    validUntil: timestamp(root.validUntil, "control admission validUntil"),
    decision: root.decision,
    artifact: {
      host: artifact.host,
      version: text(artifact.version, "control admission artifact version", 200),
      executableSha256: digest(artifact.executableSha256, "control admission artifact digest"),
    },
    environmentSha256: digest(root.environmentSha256, "control admission environment"),
    evidence: {
      current: {
        challengeHash: digest(current.challengeHash, "control admission current challengeHash"),
        observationHash: digest(current.observationHash, "control admission current observationHash"),
        routeReceiptHash: digest(current.routeReceiptHash, "control admission current routeReceiptHash"),
      },
      candidate: {
        challengeHash: digest(candidate.challengeHash, "control admission candidate challengeHash"),
        observationHash: digest(candidate.observationHash, "control admission candidate observationHash"),
        routeReceiptHash: digest(candidate.routeReceiptHash, "control admission candidate routeReceiptHash"),
      },
      routeDecisionHash: digest(evidence.routeDecisionHash, "control admission routeDecisionHash"),
    },
    trust: Object.fromEntries(trustKeys.map((key) => [key, digest(trust[key], `control admission ${key}`)])) as GuardControlAdmission["trust"],
    reasonCodes: root.reasonCodes.map((reason, index) => text(reason, `reasonCodes[${index}]`, 200)),
    limitations: root.limitations.map((item, index) => text(item, `limitations[${index}]`, 2_000)),
    admissionHash: digest(root.admissionHash, "admissionHash"),
  };
  if (validated.admissionHash !== hashWithout(validated as unknown as Record<string, unknown>, "admissionHash")) {
    throw new Error("control admission hash is invalid");
  }
  if (Date.parse(validated.validUntil) <= Date.parse(validated.evaluatedAt)) throw new Error("control admission validity is invalid");
  if (validated.decision === "APPROVE"
    && new Set(Object.values(validated.trust)).size !== Object.keys(validated.trust).length) {
    throw new Error("approved control admission trust roots must be distinct");
  }
  return validated;
}

export function openGuardControlAdmission(value: unknown, publicKey: string | Buffer | KeyObject): {
  admission: GuardControlAdmission;
  signerKeyId: string;
} {
  const opened = openEnvelope(value, GUARD_CONTROL_ADMISSION_PAYLOAD, publicKey);
  const admission = validateGuardControlAdmission(opened.payload);
  if (admission.trust.admissionSignerKeyId !== opened.signerKeyId) {
    throw new Error("control admission signer does not match the signed trust binding");
  }
  return { admission, signerKeyId: opened.signerKeyId };
}

export function gateGuardControlAdmission(input: {
  envelope: unknown;
  publicKey: string | Buffer | KeyObject;
  expectedArtifactSha256: string;
  expectedEnvironmentSha256: string;
  asOf?: string;
}): GuardControlAdmission {
  const asOf = timestamp(input.asOf ?? new Date().toISOString(), "gate time");
  const { admission } = openGuardControlAdmission(input.envelope, input.publicKey);
  if (admission.decision !== "APPROVE") throw new Error("control admission is HOLD");
  if (admission.artifact.executableSha256 !== digest(input.expectedArtifactSha256, "expected artifact digest")) {
    throw new Error("control admission is for a different artifact");
  }
  if (admission.environmentSha256 !== digest(input.expectedEnvironmentSha256, "expected environment digest")) {
    throw new Error("control admission is for a different environment");
  }
  if (Date.parse(asOf) < Date.parse(admission.evaluatedAt) || Date.parse(asOf) > Date.parse(admission.validUntil)) {
    throw new Error("control admission is not currently valid");
  }
  return admission;
}
