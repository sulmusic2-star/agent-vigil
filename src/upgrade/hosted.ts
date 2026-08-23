import { createHash, createHmac, randomUUID } from "node:crypto";
import type { CompatibilityResolution } from "./network.ts";
import type { PublicCompatibilityEntry } from "./receipt.ts";

const ENTRY_SCHEMA = "agent-vigil-compatibility-entry/v1";
const RESOLUTION_SCHEMA = "agent-vigil-compatibility-resolution/v1";
const LIFECYCLE_SCHEMA = "agent-vigil-lifecycle-event/v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]*$/;

const EVENT_NAMES = new Set([
  "distribution_exposure_recorded_v1", "integration_installed_v1", "update_plan_created_v1",
  "artifact_pair_materialized_v1", "preflight_started_v1", "preflight_completed_v1",
  "update_disposition_recorded_v1", "preflight_repeated_v1", "proof_contribution_opted_in_v1",
  "proof_artifact_generated_v1", "proof_published_v1", "proof_consumed_v1",
  "maintainer_packet_generated_v1", "maintainer_link_recorded_v1", "maintainer_resolution_recorded_v1",
  "shared_policy_enabled_v1", "required_gate_enabled_v1", "organization_pql_qualified_v1",
  "team_offer_shown_v1", "checkout_started_v1", "payment_succeeded_v1", "entitlement_activated_v1",
  "payment_failed_v1", "refund_issued_v1", "subscription_renewed_v1", "subscription_canceled_v1",
  "entitlement_expired_v1", "fleet_signal_qualified_v1", "support_case_opened_v1", "support_case_closed_v1",
]);

const ORGANIZATION_EVENTS = new Set([
  "shared_policy_enabled_v1", "required_gate_enabled_v1", "organization_pql_qualified_v1", "team_offer_shown_v1",
  "checkout_started_v1", "payment_succeeded_v1", "entitlement_activated_v1", "payment_failed_v1",
  "refund_issued_v1", "subscription_renewed_v1", "subscription_canceled_v1", "entitlement_expired_v1",
  "fleet_signal_qualified_v1",
]);

const CHANNELS = new Set([
  "apm", "skills", "agent-plugin", "github-action", "github-app", "proof-page", "badge", "registry-api",
  "mcp-registry", "maintainer-link", "direct", "internal",
]);

const LIFECYCLE_KEYS = [
  "schema_version", "event_id", "event_name", "event_day", "release_version", "channel", "external", "demo",
  "entity_scope", "installation_pseudo_id", "organization_pseudo_id", "first_touch_ref_token", "activation_channel",
  "assisted_channels", "public_component", "opaque_pair_token", "artifact_class", "verdict", "hold_reason_class",
  "canary_count_bucket", "duration_bucket", "disposition", "shared_policy", "required_gate", "public_contribution",
  "organization_context",
] as const;

const REQUIRED_LIFECYCLE_KEYS = [
  "schema_version", "event_id", "event_name", "event_day", "release_version", "channel", "external", "demo",
  "entity_scope", "installation_pseudo_id", "shared_policy", "required_gate", "public_contribution",
  "organization_context",
] as const;

export type LifecycleCredential = {
  schemaVersion: "agent-vigil-lifecycle-installation-credential/v1";
  installationId: string;
  installationSecret: string;
  channel: string;
  external: boolean;
  demo: boolean;
  registeredAt: string;
  measurementClass: "UNVERIFIED_TELEMETRY";
  gateEligible: false;
  sybilSusceptible: true;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function boundedText(value: unknown, label: string, minimum: number, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")
    || (pattern !== undefined && !pattern.test(value))) throw new Error(`${label} is invalid`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error(`${label} is invalid`);
  return result;
}

function endpointOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("hosted endpoint must be an origin without credentials, path, query, or fragment");
  }
  if (url.protocol === "http:") {
    if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname)) {
      throw new Error("hosted endpoint must use HTTPS except on loopback");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("hosted endpoint protocol is unsupported");
  }
  return url.origin;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("hosted response is not JSON");
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("hosted response exceeds the size limit");
  }
  if (!response.body) throw new Error("hosted response body is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("hosted response exceeds the size limit");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error("hosted response is invalid JSON");
  }
}

async function postJson(input: {
  endpoint: string;
  path: string;
  body: string;
  headers: Record<string, string>;
  acceptedStatuses: ReadonlySet<number>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<unknown> {
  const origin = endpointOrigin(input.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${origin}${input.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...input.headers },
      body: input.body,
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new Error("hosted request failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!input.acceptedStatuses.has(response.status)) throw new Error("hosted request was rejected");
  return readBoundedResponse(response, 32 * 1024);
}

function validateProofReceipt(input: unknown, recordType: "ENTRY" | "RESOLUTION", recordHash: string): {
  recordType: "ENTRY" | "RESOLUTION";
  recordHash: string;
  created: boolean;
} {
  const root = object(input, "proof ingestion receipt");
  const keys = ["schemaVersion", "recordType", "recordHash", "created", "receivedAt", "location"];
  exact(root, keys, keys, "proof ingestion receipt");
  if (root.schemaVersion !== "agent-vigil-proof-ingestion/v1" || root.recordType !== recordType
    || root.recordHash !== recordHash || typeof root.created !== "boolean") {
    throw new Error("proof ingestion receipt does not match the submitted record");
  }
  exactTimestamp(root.receivedAt, "proof ingestion receipt timestamp");
  const expectedLocation = recordType === "ENTRY" ? `/api/v1/entries/${recordHash}` : `/api/v1/resolutions/${recordHash}`;
  if (root.location !== expectedLocation) throw new Error("proof ingestion receipt location is invalid");
  return { recordType, recordHash, created: root.created };
}

export async function publishCompatibilityRecord(input: {
  endpoint: string;
  record: PublicCompatibilityEntry | CompatibilityResolution;
  fetchImpl?: FetchLike;
}): Promise<{ recordType: "ENTRY" | "RESOLUTION"; recordHash: string; created: boolean }> {
  const schema = input.record.schemaVersion;
  const recordType = schema === ENTRY_SCHEMA ? "ENTRY" : schema === RESOLUTION_SCHEMA ? "RESOLUTION" : undefined;
  if (!recordType) throw new Error("hosted compatibility record schema is unsupported");
  const recordHash = recordType === "ENTRY"
    ? (input.record as PublicCompatibilityEntry).entryHash
    : (input.record as CompatibilityResolution).resolutionHash;
  boundedText(recordHash, "hosted compatibility record hash", 71, 71, SHA256);
  const response = await postJson({
    endpoint: input.endpoint,
    path: recordType === "ENTRY" ? "/v1/entries" : "/v1/resolutions",
    body: JSON.stringify(input.record),
    headers: { "X-Agent-Vigil-Public-Consent": "v1" },
    acceptedStatuses: new Set([200, 201]),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  return validateProofReceipt(response, recordType, recordHash);
}

function validateCredentialResponse(input: unknown): LifecycleCredential {
  const root = object(input, "lifecycle installation credential");
  const keys = [
    "schemaVersion", "installationId", "installationSecret", "channel", "external", "demo", "registeredAt",
    "measurementClass", "gateEligible", "sybilSusceptible", "created",
  ];
  exact(root, keys, keys, "lifecycle installation credential");
  if (root.schemaVersion !== "agent-vigil-lifecycle-installation-credential/v1"
    || root.measurementClass !== "UNVERIFIED_TELEMETRY" || root.gateEligible !== false
    || root.sybilSusceptible !== true || typeof root.created !== "boolean") {
    throw new Error("lifecycle installation credential has invalid measurement boundaries");
  }
  const installationSecret = boundedText(root.installationSecret, "lifecycle installation secret", 43, 43, BASE64URL_32);
  const secretBytes = Buffer.from(installationSecret, "base64url");
  if (secretBytes.length !== 32 || secretBytes.toString("base64url") !== installationSecret) {
    throw new Error("lifecycle installation secret is not canonical");
  }
  const channel = boundedText(root.channel, "lifecycle installation channel", 1, 32);
  if (!CHANNELS.has(channel)) throw new Error("lifecycle installation channel is invalid");
  return {
    schemaVersion: "agent-vigil-lifecycle-installation-credential/v1",
    installationId: boundedText(root.installationId, "lifecycle installation ID", 36, 36, UUID_V4),
    installationSecret,
    channel,
    external: bool(root.external, "lifecycle external state"),
    demo: bool(root.demo, "lifecycle demo state"),
    registeredAt: exactTimestamp(root.registeredAt, "lifecycle installation timestamp"),
    measurementClass: "UNVERIFIED_TELEMETRY",
    gateEligible: false,
    sybilSusceptible: true,
  };
}

export function validateLifecycleCredential(input: unknown): LifecycleCredential {
  const root = object(input, "lifecycle credential file");
  const keys = [
    "schemaVersion", "installationId", "installationSecret", "channel", "external", "demo", "registeredAt",
    "measurementClass", "gateEligible", "sybilSusceptible",
  ];
  exact(root, keys, keys, "lifecycle credential file");
  return validateCredentialResponse({ ...root, created: false });
}

export async function registerLifecycleInstallation(input: {
  endpoint: string;
  requestedChannel: "apm" | "skills" | "agent-plugin" | "github-action" | "github-app";
  runClass: "EXTERNAL_STANDARD" | "DEMO" | "INTERNAL";
  idempotencyKey?: string;
  fetchImpl?: FetchLike;
}): Promise<LifecycleCredential> {
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  boundedText(idempotencyKey, "lifecycle registration idempotency key", 36, 36, UUID_V4);
  const body = JSON.stringify({
    schemaVersion: "agent-vigil-lifecycle-installation-registration/v1",
    requestedChannel: input.requestedChannel,
    runClass: input.runClass,
  });
  const response = await postJson({
    endpoint: input.endpoint,
    path: "/v1/lifecycle/installations",
    body,
    headers: {
      "X-Agent-Vigil-Lifecycle-Consent": "v1",
      "X-Agent-Vigil-Registration-Idempotency-Key": idempotencyKey,
    },
    acceptedStatuses: new Set([200, 201]),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  return validateCredentialResponse(response);
}

export function validateLifecycleEventForUpload(input: unknown, credential: LifecycleCredential): Record<string, unknown> {
  const root = object(input, "lifecycle event");
  exact(root, LIFECYCLE_KEYS, REQUIRED_LIFECYCLE_KEYS, "lifecycle event");
  const eventName = boundedText(root.event_name, "lifecycle event name", 1, 64);
  if (root.schema_version !== LIFECYCLE_SCHEMA || !EVENT_NAMES.has(eventName)) throw new Error("lifecycle event schema or name is invalid");
  if (ORGANIZATION_EVENTS.has(eventName) || root.entity_scope !== "INDIVIDUAL_INSTALLATION"
    || root.organization_context !== false || root.organization_pseudo_id !== undefined) {
    throw new Error("organization events require an authenticated tenant adapter");
  }
  const channel = boundedText(root.channel, "lifecycle channel", 1, 32);
  if (!CHANNELS.has(channel) || channel !== credential.channel || root.external !== credential.external
    || root.demo !== credential.demo || root.installation_pseudo_id !== credential.installationId) {
    throw new Error("lifecycle event does not match its installation credential");
  }
  boundedText(root.event_id, "lifecycle event ID", 36, 36, UUID_V4);
  boundedText(root.event_day, "lifecycle event day", 10, 10, /^\d{4}-\d{2}-\d{2}$/);
  boundedText(root.release_version, "lifecycle release version", 1, 40, VERSION);
  for (const key of ["external", "demo", "shared_policy", "required_gate", "public_contribution", "organization_context"] as const) {
    bool(root[key], `lifecycle ${key}`);
  }
  if (root.public_component !== undefined) {
    const component = object(root.public_component, "lifecycle public component");
    exact(component, ["ecosystem", "name"], ["ecosystem", "name"], "lifecycle public component");
    boundedText(component.ecosystem, "lifecycle public component ecosystem", 1, 80, /^[a-z0-9][a-z0-9._-]*$/);
    boundedText(component.name, "lifecycle public component name", 1, 160, /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/);
  }
  if (root.opaque_pair_token !== undefined) boundedText(root.opaque_pair_token, "lifecycle pair token", 71, 71, SHA256);
  if (root.public_component !== undefined && root.opaque_pair_token !== undefined) {
    throw new Error("lifecycle event cannot contain public and opaque component identities together");
  }
  if (root.assisted_channels !== undefined) {
    if (!Array.isArray(root.assisted_channels) || root.assisted_channels.length > 3
      || root.assisted_channels.some((item) => typeof item !== "string" || !CHANNELS.has(item))
      || new Set(root.assisted_channels).size !== root.assisted_channels.length) {
      throw new Error("lifecycle assisted channels are invalid");
    }
  }
  if (root.activation_channel !== undefined && (typeof root.activation_channel !== "string" || !CHANNELS.has(root.activation_channel))) {
    throw new Error("lifecycle activation channel is invalid");
  }
  if (root.first_touch_ref_token !== undefined) {
    boundedText(root.first_touch_ref_token, "lifecycle first-touch token", 8, 64, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  }
  if (root.artifact_class !== undefined && !new Set([
    "manager-lock", "archive", "directory", "container", "plugin", "skill", "mcp-server", "other",
  ]).has(root.artifact_class as string)) throw new Error("lifecycle artifact class is invalid");
  if (root.hold_reason_class !== undefined && !new Set([
    "containment", "identity", "materialization", "configuration", "evidence", "timeout", "other",
  ]).has(root.hold_reason_class as string)) throw new Error("lifecycle HOLD reason is invalid");
  if (root.canary_count_bucket !== undefined && !new Set(["0", "1", "2-3", "4-7", "8-16", "17-32"])
    .has(root.canary_count_bucket as string)) throw new Error("lifecycle canary count bucket is invalid");
  if (root.duration_bucket !== undefined && !new Set(["lt-1m", "1-3m", "3-7m", "7-15m", "gt-15m"])
    .has(root.duration_bucket as string)) throw new Error("lifecycle duration bucket is invalid");
  if (root.disposition !== undefined && !new Set(["APPLY", "DEFER", "RESTORE", "NO_DECISION"])
    .has(root.disposition as string)) throw new Error("lifecycle disposition is invalid");
  if (eventName === "preflight_completed_v1" && !new Set(["SAFE", "CHANGED", "HOLD"]).has(root.verdict as string)) {
    throw new Error("preflight completion requires a verdict");
  }
  if (root.verdict !== undefined && !new Set(["SAFE", "CHANGED", "HOLD"]).has(root.verdict as string)) {
    throw new Error("lifecycle verdict is invalid");
  }
  if (root.verdict === "HOLD" && typeof root.hold_reason_class !== "string") throw new Error("HOLD requires a reason class");
  if (eventName === "update_disposition_recorded_v1"
    && !new Set(["APPLY", "DEFER", "RESTORE", "NO_DECISION"]).has(root.disposition as string)) {
    throw new Error("update disposition event requires a disposition");
  }
  if ((eventName === "proof_contribution_opted_in_v1" || eventName === "proof_published_v1")
    && root.public_contribution !== true) throw new Error("public proof event requires contribution consent");
  return root;
}

function lifecycleReceipt(input: unknown, eventId: string): { eventId: string; ingestionSequence: number; created: boolean } {
  const root = object(input, "lifecycle ingestion receipt");
  const keys = [
    "schemaVersion", "eventId", "created", "receivedAt", "ingestionSequence", "entityScope", "measurementClass",
    "gateEligible", "sybilSusceptible",
  ];
  exact(root, keys, keys, "lifecycle ingestion receipt");
  if (root.schemaVersion !== "agent-vigil-lifecycle-ingestion-receipt/v1" || root.eventId !== eventId
    || root.entityScope !== "INDIVIDUAL_INSTALLATION" || root.measurementClass !== "UNVERIFIED_TELEMETRY"
    || root.gateEligible !== false || root.sybilSusceptible !== true || typeof root.created !== "boolean"
    || !Number.isSafeInteger(root.ingestionSequence) || Number(root.ingestionSequence) < 1) {
    throw new Error("lifecycle ingestion receipt has invalid measurement boundaries");
  }
  exactTimestamp(root.receivedAt, "lifecycle ingestion timestamp");
  return { eventId, ingestionSequence: Number(root.ingestionSequence), created: root.created };
}

export async function uploadLifecycleEvent(input: {
  endpoint: string;
  credential: LifecycleCredential;
  event: unknown;
  timestamp?: string;
  fetchImpl?: FetchLike;
}): Promise<{ eventId: string; ingestionSequence: number; created: boolean }> {
  const event = validateLifecycleEventForUpload(input.event, input.credential);
  const eventId = event.event_id as string;
  const timestamp = input.timestamp ?? new Date().toISOString();
  exactTimestamp(timestamp, "lifecycle request timestamp");
  const body = JSON.stringify(event);
  const bodyHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const message = `agent-vigil-lifecycle-request/v1\nPOST\n/v1/lifecycle\n${eventId}\n${timestamp}\n${bodyHash}`;
  const key = Buffer.from(input.credential.installationSecret, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== input.credential.installationSecret) {
    throw new Error("lifecycle installation secret is invalid");
  }
  const signature = createHmac("sha256", key).update(message).digest("base64url");
  const response = await postJson({
    endpoint: input.endpoint,
    path: "/v1/lifecycle",
    body,
    headers: {
      "X-Agent-Vigil-Lifecycle-Consent": "v1",
      "X-Agent-Vigil-Installation": input.credential.installationId,
      "X-Agent-Vigil-Request-Id": eventId,
      "X-Agent-Vigil-Timestamp": timestamp,
      "X-Agent-Vigil-Signature": signature,
    },
    acceptedStatuses: new Set([200, 202]),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  return lifecycleReceipt(response, eventId);
}
