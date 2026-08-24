import {
  ENTRY_SCHEMA,
  RESOLUTION_SCHEMA,
  assertResolutionBinding,
  canonical,
  hmacPseudonym,
  lifecycleInstallationSecret,
  publicKeyIdFromBase64,
  sanitizeLifecycleEvent,
  sha256,
  validateCompatibilityResolution,
  validateLifecycleEvent,
  validatePublicCompatibilityEntry,
  verifyCompatibilityResolution,
  verifyDetachedEd25519,
  verifyLifecycleRequestHmac,
  verifyPublicCompatibilityEntry,
  type CompatibilityResolution,
  type PublicCompatibilityEntry,
  type Verdict,
} from "./contracts";
import {
  exportLifecycleEvents,
  getEntryRow,
  getPublicEntryRow,
  getPublicResolutionRow,
  getLifecycleInstallation,
  getModerationState,
  getPublisher,
  getResolutionForBroken,
  getResolutionRow,
  moderateRecord,
  registerPublisher,
  registerLifecycleInstallation,
  searchEntries,
  storeEntry,
  storeLifecycleEvent,
  storeResolution,
  updatePublisherStatus,
  updateLifecycleInstallationStatus,
  type ModerationState,
  type PublisherRow,
  type PublisherStatus,
} from "./db";
import {
  buildFirst100SignedExport,
  exportFirst100Bundle,
  exportFirst100Entries,
  first100Jsonl,
  first100ProvenanceJsonl,
  getFrequencyAdapter,
  grantFirst100ArtifactAccess,
  registerFrequencyAdapter,
  registerFirst100Pair,
  revokeFrequencyAdapter,
  storeFirst100Evaluation,
  validateFirst100AccessGrantRequest,
  validateFirst100Evaluation,
  validateFirst100Proposal,
} from "./frequency";
import { badgePayload, renderProofPage, renderResolutionPage, renderSearchPage } from "./render";

const JSON_BODY_MAX = 512 * 1024;
const LIFECYCLE_BODY_MAX = 32 * 1024;
const ADMIN_BODY_MAX = 64 * 1024;
const HASH = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALLATION_CHANNELS = new Set(["apm", "skills", "agent-plugin", "github-action", "github-app"]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type ParsedBody = { value: unknown; bytes: Uint8Array; bodySha256: string };

function securityHeaders(contentType: string): Headers {
  return new Headers({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-site",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  });
}

function jsonResponse(value: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = securityHeaders("application/json; charset=utf-8");
  if (extra) new Headers(extra).forEach((item, key) => headers.set(key, item));
  return new Response(`${JSON.stringify(value)}\n`, { status, headers });
}

function htmlResponse(value: string, status = 200, extra?: HeadersInit): Response {
  const headers = securityHeaders("text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (extra) new Headers(extra).forEach((item, key) => headers.set(key, item));
  return new Response(value, { status, headers });
}

function textResponse(value: string, contentType: string, extra?: HeadersInit): Response {
  const headers = securityHeaders(contentType);
  if (extra) new Headers(extra).forEach((item, key) => headers.set(key, item));
  return new Response(value, { headers });
}

function publicApiResponse(value: unknown, cacheControl: string, etag?: string): Response {
  return jsonResponse(value, 200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": cacheControl,
    ...(etag === undefined ? {} : { ETag: `"${etag}"` }),
  });
}

function exactObject(value: unknown, keys: string[], label: string, optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_REQUEST", `${label} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = [...keys, ...optional];
  if (Object.keys(record).some((key) => !allowed.includes(key)) || keys.some((key) => !(key in record))) {
    throw new HttpError(400, "INVALID_REQUEST", `${label} has missing or unknown fields`);
  }
  return record;
}

function boundedString(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")
    || (pattern !== undefined && !pattern.test(value))) throw new HttpError(400, "INVALID_REQUEST", `${label} is invalid`);
  return value;
}

function exactTimestamp(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new HttpError(400, "INVALID_REQUEST", `${label} must be an exact UTC timestamp`);
  }
  return result;
}

async function readBoundedJson(request: Request, maximum: number): Promise<ParsedBody> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "CONTENT_TYPE_REQUIRED", "Content-Type must be application/json");
  const encoding = request.headers.get("Content-Encoding");
  if (encoding && encoding.toLowerCase() !== "identity") throw new HttpError(415, "CONTENT_ENCODING_UNSUPPORTED", "Compressed request bodies are not accepted");
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds the route limit");
  }
  if (!request.body) throw new HttpError(400, "EMPTY_BODY", "A JSON request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new HttpError(413, "BODY_TOO_LARGE", "Request body exceeds the route limit");
    }
    chunks.push(result.value);
  }
  if (size === 0) throw new HttpError(400, "EMPTY_BODY", "A JSON request body is required");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid UTF-8 JSON");
  }
  return { value, bytes, bodySha256: await sha256(bytes) };
}

async function secretEqual(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

async function requireAdmin(request: Request, env: Env): Promise<void> {
  const edgeAddress = request.headers.get("CF-Connecting-IP") ?? "edge-address-unavailable";
  const limiterKey = await hmacPseudonym(`admin-edge\0${edgeAddress}`, env.TELEMETRY_HMAC_KEY);
  const limited = await env.PROOF_WRITE_LIMITER.limit({ key: limiterKey });
  if (!limited.success) throw new HttpError(429, "RATE_LIMITED", "Write rate limit exceeded");
  const header = request.headers.get("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (env.ADMIN_TOKEN.length < 32 || !(await secretEqual(provided, env.ADMIN_TOKEN))) {
    throw new HttpError(401, "ADMIN_AUTH_REQUIRED", "Administrator authorization is required");
  }
}

function enabled(value: string): boolean {
  return value === "true";
}

function requireEnabled(value: string, code: string): void {
  if (!enabled(value)) throw new HttpError(503, code, "This opt-in ingestion lane is disabled");
}

function assertFresh(timestamp: string, maximumAgeDays: number, now: Date): void {
  const observed = Date.parse(timestamp);
  if (observed > now.getTime() + 5 * 60_000) throw new HttpError(422, "FUTURE_RECORD", "Record timestamp is too far in the future");
  if (observed < now.getTime() - maximumAgeDays * 86_400_000) throw new HttpError(422, "STALE_RECORD", "Record is outside the configured replay window");
}

function positiveInteger(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new HttpError(400, "INVALID_REQUEST", `${label} is invalid`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new HttpError(400, "INVALID_REQUEST", `${label} is invalid`);
  return result;
}

async function activePublisher(env: Env, keyId: string, publicKey?: string): Promise<PublisherRow> {
  const publisher = await getPublisher(env.PROOF_DB, keyId);
  if (!publisher || publisher.status !== "ACTIVE") throw new HttpError(403, "PUBLISHER_NOT_ACTIVE", "Publisher key is not active");
  if (publicKey !== undefined && publisher.public_key_b64 !== publicKey) throw new HttpError(403, "PUBLISHER_KEY_MISMATCH", "Publisher key material does not match registration");
  return publisher;
}

async function proofWriteLimit(env: Env, keyId: string): Promise<void> {
  const result = await env.PROOF_WRITE_LIMITER.limit({ key: keyId });
  if (!result.success) throw new HttpError(429, "RATE_LIMITED", "Write rate limit exceeded");
}

async function edgeWriteLimit(request: Request, env: Env, routeClass: string, limiter: RateLimit): Promise<void> {
  const edgeAddress = request.headers.get("CF-Connecting-IP") ?? "edge-address-unavailable";
  const key = await hmacPseudonym(`${routeClass}\0${edgeAddress}`, env.TELEMETRY_HMAC_KEY);
  const result = await limiter.limit({ key });
  if (!result.success) throw new HttpError(429, "RATE_LIMITED", "Write rate limit exceeded");
}

async function publicReadLimit(env: Env, request: Request, routeClass: string): Promise<void> {
  // Do not let a caller rotate a self-chosen token to bypass the limiter. The
  // edge address is used ephemerally and is never persisted as analytics.
  const edgeAddress = request.headers.get("CF-Connecting-IP") ?? "edge-address-unavailable";
  const key = await hmacPseudonym(`${routeClass}\0${edgeAddress}`, env.TELEMETRY_HMAC_KEY);
  const result = await env.PUBLIC_READ_LIMITER.limit({ key });
  if (!result.success) throw new HttpError(429, "RATE_LIMITED", "Public API rate limit exceeded");
}

function moderationUnavailable(state: ModerationState | null): boolean {
  return state !== null && (state.action === "CORRECT" || state.action === "TAKEDOWN" || state.action === "REVOKE");
}

function revokedResponse(state: ModerationState): Response {
  return jsonResponse({
    error: {
      code: "RECORD_UNAVAILABLE",
      message: "This record is unavailable under append-only moderation state",
      action: state.action,
      reasonClass: state.reason_class,
      replacementHash: state.replacement_hash,
      updatedAt: state.updated_at,
    },
  }, 410, { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
}

function parseEntryRow(row: { body_json: string }): PublicCompatibilityEntry {
  try { return validatePublicCompatibilityEntry(JSON.parse(row.body_json)); }
  catch { throw new HttpError(500, "STORED_RECORD_INVALID", "Stored compatibility entry failed validation"); }
}

function parseResolutionRow(row: { body_json: string }): CompatibilityResolution {
  try { return validateCompatibilityResolution(JSON.parse(row.body_json)); }
  catch { throw new HttpError(500, "STORED_RECORD_INVALID", "Stored compatibility resolution failed validation"); }
}

function errorHasMarker(error: unknown, marker: string): boolean {
  return error instanceof Error && error.message.includes(marker);
}

async function handleRegisterPublisher(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { value } = await readBoundedJson(request, ADMIN_BODY_MAX);
  const body = exactObject(value, ["eventId", "keyId", "publicKey"], "publisher registration");
  const eventId = boundedString(body.eventId, "publisher event ID", 36, UUID_V4);
  const keyId = boundedString(body.keyId, "publisher key ID", 71, HASH);
  const publicKey = boundedString(body.publicKey, "publisher public key", 512);
  if (await publicKeyIdFromBase64(publicKey) !== keyId) throw new HttpError(422, "PUBLISHER_KEY_INVALID", "Publisher key ID does not match the submitted public key");
  if (keyId === env.FREQUENCY_OPERATOR_KEY_ID || await getFrequencyAdapter(env.PROOF_DB, keyId)) {
    throw new HttpError(409, "KEY_DUTY_CONFLICT", "Publisher, adapter, and export-operator keys must be pairwise distinct");
  }
  const occurredAt = new Date().toISOString();
  const result = await registerPublisher(env.PROOF_DB, { eventId, keyId, publicKey, occurredAt });
  return jsonResponse({ schemaVersion: "agent-vigil-publisher-registration/v1", created: result.created, keyId, status: result.publisher.status, occurredAt }, result.created ? 201 : 200, { "Cache-Control": "no-store" });
}

async function handleRegisterFrequencyAdapter(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { value } = await readBoundedJson(request, ADMIN_BODY_MAX);
  const body = exactObject(value, ["eventId", "keyId", "publicKey", "version"], "frequency adapter registration");
  const eventId = boundedString(body.eventId, "frequency adapter event ID", 36, UUID_V4);
  const keyId = boundedString(body.keyId, "frequency adapter key ID", 71, HASH);
  const publicKey = boundedString(body.publicKey, "frequency adapter public key", 512);
  const version = boundedString(body.version, "frequency adapter version", 80, /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/);
  if (await publicKeyIdFromBase64(publicKey) !== keyId) {
    throw new HttpError(422, "FREQUENCY_ADAPTER_KEY_INVALID", "Frequency adapter key ID does not match its public key");
  }
  if (keyId === env.FREQUENCY_OPERATOR_KEY_ID || await getPublisher(env.PROOF_DB, keyId)) {
    throw new HttpError(409, "KEY_DUTY_CONFLICT", "Publisher, adapter, and export-operator keys must be pairwise distinct");
  }
  const occurredAt = new Date().toISOString();
  let result;
  try {
    result = await registerFrequencyAdapter(env.PROOF_DB, { eventId, keyId, publicKey, version, occurredAt });
  } catch (error) {
    if (errorHasMarker(error, "FREQUENCY_KEY_DUTY_CONFLICT")) {
      throw new HttpError(409, "KEY_DUTY_CONFLICT", "Publisher, adapter, and export-operator keys must be pairwise distinct");
    }
    throw error;
  }
  return jsonResponse({
    schemaVersion: "agent-vigil-frequency-adapter-registration/v1",
    created: result.created,
    keyId,
    version,
    status: result.adapter.status,
    occurredAt,
  }, result.created ? 201 : 200, { "Cache-Control": "no-store" });
}

async function handleFrequencyAdapterStatus(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { value } = await readBoundedJson(request, ADMIN_BODY_MAX);
  const body = exactObject(value, ["eventId", "keyId", "status", "reasonClass"], "frequency adapter status event");
  if (body.status !== "REVOKED" || typeof body.reasonClass !== "string"
    || !new Set(["COMPROMISED", "OPERATOR_REQUEST", "POLICY", "ABUSE"]).has(body.reasonClass)) {
    throw new HttpError(400, "INVALID_REQUEST", "Frequency adapter status or reason class is invalid");
  }
  let adapter;
  try {
    adapter = await revokeFrequencyAdapter(env.PROOF_DB, {
      eventId: boundedString(body.eventId, "frequency adapter event ID", 36, UUID_V4),
      keyId: boundedString(body.keyId, "frequency adapter key ID", 71, HASH),
      reasonClass: body.reasonClass,
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    if (errorHasMarker(error, "FREQUENCY_ADAPTER_STATUS_TERMINAL")) {
      throw new HttpError(409, "FREQUENCY_ADAPTER_STATUS_TERMINAL", "A revoked adapter key cannot be restored");
    }
    throw error;
  }
  return jsonResponse({
    schemaVersion: "agent-vigil-frequency-adapter-status/v1",
    keyId: adapter.key_id,
    version: adapter.version,
    status: adapter.status,
    updatedAt: adapter.updated_at,
  }, 200, { "Cache-Control": "no-store" });
}

async function handlePublisherStatus(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { value } = await readBoundedJson(request, ADMIN_BODY_MAX);
  const body = exactObject(value, ["eventId", "keyId", "status", "reasonClass"], "publisher status event");
  const statusSet = new Set(["ACTIVE", "SUSPENDED", "REVOKED"]);
  const reasonSet = new Set(["COMPROMISED", "OPERATOR_REQUEST", "POLICY", "ABUSE", "RESTORED"]);
  if (typeof body.status !== "string" || !statusSet.has(body.status) || typeof body.reasonClass !== "string" || !reasonSet.has(body.reasonClass)) {
    throw new HttpError(400, "INVALID_REQUEST", "Publisher status or reason class is invalid");
  }
  if ((body.status === "ACTIVE") !== (body.reasonClass === "RESTORED")
    || (body.reasonClass === "COMPROMISED" && body.status !== "REVOKED")) {
    throw new HttpError(400, "INVALID_REQUEST", "Publisher status transition and reason class conflict");
  }
  let publisher;
  try {
    publisher = await updatePublisherStatus(env.PROOF_DB, {
      eventId: boundedString(body.eventId, "publisher event ID", 36, UUID_V4),
      keyId: boundedString(body.keyId, "publisher key ID", 71, HASH),
      status: body.status as PublisherStatus,
      reasonClass: body.reasonClass,
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    if (errorHasMarker(error, "PUBLISHER_STATUS_TERMINAL")) {
      throw new HttpError(409, "PUBLISHER_STATUS_TERMINAL", "A revoked publisher key cannot be restored; register rotated key material");
    }
    if (errorHasMarker(error, "PUBLISHER_STATUS_TRANSITION_INVALID")) {
      throw new HttpError(409, "PUBLISHER_STATUS_TRANSITION_INVALID", "Publisher status transition is not permitted");
    }
    throw error;
  }
  return jsonResponse({ schemaVersion: "agent-vigil-publisher-status/v1", keyId: publisher.key_id, status: publisher.status, updatedAt: publisher.updated_at }, 200, { "Cache-Control": "no-store" });
}

async function handleLifecycleInstallationStatus(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { value } = await readBoundedJson(request, ADMIN_BODY_MAX);
  const body = exactObject(value, ["eventId", "installationId", "status", "reasonClass"], "lifecycle installation status event");
  const statusSet = new Set(["REVOKED"]);
  const reasonSet = new Set(["CONSENT_WITHDRAWN", "CREDENTIAL_COMPROMISED", "ABUSE", "OPERATOR_REQUEST"]);
  if (typeof body.status !== "string" || !statusSet.has(body.status)
    || typeof body.reasonClass !== "string" || !reasonSet.has(body.reasonClass)) {
    throw new HttpError(400, "INVALID_REQUEST", "Lifecycle installation status or reason class is invalid");
  }
  let installation;
  try {
    installation = await updateLifecycleInstallationStatus(env.PROOF_DB, {
      eventId: boundedString(body.eventId, "lifecycle installation status event ID", 36, UUID_V4),
      installationId: boundedString(body.installationId, "lifecycle installation ID", 36, UUID_V4),
      status: "REVOKED",
      reasonClass: body.reasonClass,
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    if (errorHasMarker(error, "LIFECYCLE_STATUS_TERMINAL")) {
      throw new HttpError(409, "LIFECYCLE_STATUS_TERMINAL", "A revoked lifecycle credential cannot be restored or revoked again");
    }
    if (errorHasMarker(error, "LIFECYCLE_STATUS_TRANSITION_INVALID")) {
      throw new HttpError(409, "LIFECYCLE_STATUS_TRANSITION_INVALID", "Lifecycle credential status transition is not permitted");
    }
    throw error;
  }
  return jsonResponse({
    schemaVersion: "agent-vigil-lifecycle-installation-status/v1",
    installationId: installation.installation_id,
    status: installation.status,
    updatedAt: installation.updated_at,
  }, 200, { "Cache-Control": "no-store" });
}

async function handleEntryIngestion(request: Request, env: Env): Promise<Response> {
  requireEnabled(env.PROOF_INGESTION_ENABLED, "PROOF_INGESTION_DISABLED");
  await edgeWriteLimit(request, env, "entry-write", env.PROOF_WRITE_LIMITER);
  if (request.headers.get("X-Agent-Vigil-Public-Consent") !== "v1") throw new HttpError(428, "PUBLIC_CONSENT_REQUIRED", "Explicit public-proof consent is required");
  const { value } = await readBoundedJson(request, JSON_BODY_MAX);
  let entry: PublicCompatibilityEntry;
  try { entry = validatePublicCompatibilityEntry(value); }
  catch { throw new HttpError(422, "ENTRY_SCHEMA_INVALID", "Compatibility entry failed strict schema validation"); }
  if (!(await verifyPublicCompatibilityEntry(entry))) throw new HttpError(422, "ENTRY_SIGNATURE_INVALID", "Compatibility entry hash or signature is invalid");
  await activePublisher(env, entry.signature.keyId, entry.signature.publicKey);
  await proofWriteLimit(env, entry.signature.keyId);
  assertFresh(entry.generatedAt, positiveInteger(env.MAX_EVIDENCE_AGE_DAYS, "MAX_EVIDENCE_AGE_DAYS", 1, 3_650), new Date());
  const publishedAt = new Date().toISOString();
  let stored;
  try { stored = await storeEntry(env.PROOF_DB, entry, publishedAt); }
  catch (error) {
    if (errorHasMarker(error, "PUBLISHER_NOT_ACTIVE")) {
      throw new HttpError(403, "PUBLISHER_NOT_ACTIVE", "Publisher key became inactive before the entry was committed");
    }
    throw error;
  }
  return jsonResponse({
    schemaVersion: "agent-vigil-proof-ingestion/v1",
    recordType: "ENTRY",
    recordHash: entry.entryHash,
    created: stored.created,
    receivedAt: publishedAt,
    location: `/api/v1/entries/${entry.entryHash}`,
  }, stored.created ? 201 : 200, { "Cache-Control": "no-store", Location: `/api/v1/entries/${entry.entryHash}` });
}

async function handleResolutionIngestion(request: Request, env: Env): Promise<Response> {
  requireEnabled(env.PROOF_INGESTION_ENABLED, "PROOF_INGESTION_DISABLED");
  await edgeWriteLimit(request, env, "resolution-write", env.PROOF_WRITE_LIMITER);
  if (request.headers.get("X-Agent-Vigil-Public-Consent") !== "v1") throw new HttpError(428, "PUBLIC_CONSENT_REQUIRED", "Explicit public-proof consent is required");
  const { value } = await readBoundedJson(request, JSON_BODY_MAX);
  let resolution: CompatibilityResolution;
  try { resolution = validateCompatibilityResolution(value); }
  catch { throw new HttpError(422, "RESOLUTION_SCHEMA_INVALID", "Compatibility resolution failed strict schema validation"); }
  if (!(await verifyCompatibilityResolution(resolution))) throw new HttpError(422, "RESOLUTION_SIGNATURE_INVALID", "Compatibility resolution hash or signature is invalid");
  await activePublisher(env, resolution.signature.keyId, resolution.signature.publicKey);
  await proofWriteLimit(env, resolution.signature.keyId);
  assertFresh(resolution.generatedAt, positiveInteger(env.MAX_EVIDENCE_AGE_DAYS, "MAX_EVIDENCE_AGE_DAYS", 1, 3_650), new Date());
  const [brokenRow, fixedRow] = await Promise.all([
    getPublicEntryRow(env.PROOF_DB, resolution.broken.entryHash),
    getPublicEntryRow(env.PROOF_DB, resolution.fixed.entryHash),
  ]);
  if (!brokenRow || !fixedRow) {
    throw new HttpError(409, "RESOLUTION_REFERENCES_UNAVAILABLE", "Resolution requires active, unmoderated exact-pair evidence");
  }
  const broken = parseEntryRow(brokenRow);
  const fixed = parseEntryRow(fixedRow);
  try { assertResolutionBinding(resolution, broken, fixed); }
  catch { throw new HttpError(422, "RESOLUTION_BINDING_INVALID", "Resolution is inconsistent with its referenced exact-pair evidence"); }
  const publishedAt = new Date().toISOString();
  let stored;
  try { stored = await storeResolution(env.PROOF_DB, resolution, publishedAt); }
  catch (error) {
    if (errorHasMarker(error, "PUBLISHER_NOT_ACTIVE")) {
      throw new HttpError(403, "PUBLISHER_NOT_ACTIVE", "Publisher key became inactive before the resolution was committed");
    }
    if (errorHasMarker(error, "RESOLUTION_REFERENT_UNAVAILABLE")) {
      throw new HttpError(409, "RESOLUTION_REFERENCES_UNAVAILABLE", "Referenced evidence became unavailable before the resolution was committed");
    }
    throw error;
  }
  return jsonResponse({
    schemaVersion: "agent-vigil-proof-ingestion/v1",
    recordType: "RESOLUTION",
    recordHash: resolution.resolutionHash,
    created: stored.created,
    receivedAt: publishedAt,
    location: `/api/v1/resolutions/${resolution.resolutionHash}`,
  }, stored.created ? 201 : 200, { "Cache-Control": "no-store", Location: `/api/v1/resolutions/${resolution.resolutionHash}` });
}

async function lifecycleRegistrationLimit(request: Request, env: Env): Promise<void> {
  // Cloudflare supplies this header at the edge. It is used only as an ephemeral
  // abuse-control key; the raw address and its hash never enter analytics or D1.
  const edgeAddress = request.headers.get("CF-Connecting-IP") ?? "edge-address-unavailable";
  const key = await hmacPseudonym(`lifecycle-registration\0${edgeAddress}`, env.TELEMETRY_HMAC_KEY);
  const limited = await env.LIFECYCLE_REGISTRATION_LIMITER.limit({ key });
  if (!limited.success) throw new HttpError(429, "RATE_LIMITED", "Lifecycle registration rate limit exceeded");
}

function deriveLifecycleRegistration(
  requestedChannel: string,
  runClass: string,
  env: Env,
  now: Date,
): { channel: string; external: boolean; demo: boolean } {
  if (!INSTALLATION_CHANNELS.has(requestedChannel)) {
    throw new HttpError(422, "LIFECYCLE_REGISTRATION_INVALID", "Lifecycle installation channel is unsupported");
  }
  if (runClass === "INTERNAL") return { channel: "internal", external: false, demo: false };
  if (runClass === "DEMO") return { channel: requestedChannel, external: false, demo: true };
  if (runClass !== "EXTERNAL_STANDARD") {
    throw new HttpError(422, "LIFECYCLE_REGISTRATION_INVALID", "Lifecycle run class is unsupported");
  }
  const r0 = Date.parse(env.R0_RELEASED_AT);
  const releasedChannels = new Set(env.RELEASED_CHANNELS.split(",").map((item) => item.trim()).filter(Boolean));
  if (env.R0_RELEASED_AT === "UNSET" || !Number.isFinite(r0) || r0 > now.getTime() || !releasedChannels.has(requestedChannel)) {
    throw new HttpError(409, "LIFECYCLE_CHANNEL_NOT_RELEASED", "This external lifecycle channel is not released");
  }
  return { channel: requestedChannel, external: true, demo: false };
}

async function handleLifecycleRegistration(request: Request, env: Env): Promise<Response> {
  requireEnabled(env.LIFECYCLE_INGESTION_ENABLED, "LIFECYCLE_INGESTION_DISABLED");
  if (request.headers.get("X-Agent-Vigil-Lifecycle-Consent") !== "v1") {
    throw new HttpError(428, "LIFECYCLE_CONSENT_REQUIRED", "Explicit minimal lifecycle consent is required");
  }
  await lifecycleRegistrationLimit(request, env);
  const idempotencyKey = boundedString(
    request.headers.get("X-Agent-Vigil-Registration-Idempotency-Key"),
    "lifecycle registration idempotency key",
    36,
    UUID_V4,
  );
  const { value } = await readBoundedJson(request, 2 * 1024);
  const body = exactObject(value, ["schemaVersion", "requestedChannel", "runClass"], "lifecycle installation registration");
  if (body.schemaVersion !== "agent-vigil-lifecycle-installation-registration/v1") {
    throw new HttpError(422, "LIFECYCLE_REGISTRATION_INVALID", "Lifecycle installation registration schema is unsupported");
  }
  const requestedChannel = boundedString(body.requestedChannel, "lifecycle requested channel", 32);
  const runClass = boundedString(body.runClass, "lifecycle run class", 32);
  const now = new Date();
  const derived = deriveLifecycleRegistration(requestedChannel, runClass, env, now);
  const result = await registerLifecycleInstallation(env.PROOF_DB, {
    installationId: crypto.randomUUID(),
    idempotencyKey,
    ...derived,
    registeredAt: now.toISOString(),
  });
  if (result.installation.status !== "ACTIVE") {
    throw new HttpError(409, "LIFECYCLE_STATUS_TERMINAL", "A revoked lifecycle registration cannot reissue its deterministic credential");
  }
  const secret = await lifecycleInstallationSecret(result.installation.installation_id, env.LIFECYCLE_ISSUING_KEY);
  return jsonResponse({
    schemaVersion: "agent-vigil-lifecycle-installation-credential/v1",
    installationId: result.installation.installation_id,
    installationSecret: secret,
    channel: result.installation.channel,
    external: result.installation.external === 1,
    demo: result.installation.demo === 1,
    registeredAt: result.installation.registered_at,
    measurementClass: "UNVERIFIED_TELEMETRY",
    gateEligible: false,
    sybilSusceptible: true,
    created: result.created,
  }, result.created ? 201 : 200, { "Cache-Control": "no-store" });
}

async function handleLifecycleIngestion(request: Request, env: Env): Promise<Response> {
  requireEnabled(env.LIFECYCLE_INGESTION_ENABLED, "LIFECYCLE_INGESTION_DISABLED");
  await edgeWriteLimit(request, env, "lifecycle-write", env.LIFECYCLE_WRITE_LIMITER);
  if (request.headers.get("X-Agent-Vigil-Lifecycle-Consent") !== "v1") throw new HttpError(428, "LIFECYCLE_CONSENT_REQUIRED", "Explicit minimal lifecycle consent is required");
  const { value, bodySha256 } = await readBoundedJson(request, LIFECYCLE_BODY_MAX);
  let event;
  try { event = validateLifecycleEvent(value); }
  catch { throw new HttpError(422, "LIFECYCLE_SCHEMA_INVALID", "Lifecycle event failed strict privacy-minimal validation"); }
  if (event.entity_scope !== "INDIVIDUAL_INSTALLATION" || event.organization_context || event.organization_pseudo_id !== undefined) {
    throw new HttpError(403, "ORGANIZATION_AUTH_REQUIRED", "Organization events require a future authenticated tenant adapter");
  }
  const installationId = boundedString(request.headers.get("X-Agent-Vigil-Installation"), "lifecycle installation ID", 36, UUID_V4);
  const requestId = boundedString(request.headers.get("X-Agent-Vigil-Request-Id"), "lifecycle request ID", 36, UUID_V4);
  const timestamp = exactTimestamp(request.headers.get("X-Agent-Vigil-Timestamp"), "lifecycle request timestamp");
  const signature = boundedString(request.headers.get("X-Agent-Vigil-Signature"), "lifecycle request signature", 64);
  if (requestId !== event.event_id) throw new HttpError(422, "LIFECYCLE_REQUEST_ID_MISMATCH", "Lifecycle request and event IDs must match");
  if (Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60_000) {
    throw new HttpError(422, "LIFECYCLE_REQUEST_REPLAY_WINDOW", "Lifecycle request timestamp is outside the five-minute replay window");
  }
  const installation = await getLifecycleInstallation(env.PROOF_DB, installationId);
  if (!installation || installation.status !== "ACTIVE") {
    throw new HttpError(401, "LIFECYCLE_INSTALLATION_INVALID", "Lifecycle installation credential is invalid or revoked");
  }
  const installationSecret = await lifecycleInstallationSecret(installationId, env.LIFECYCLE_ISSUING_KEY);
  const message = `agent-vigil-lifecycle-request/v1\n${request.method}\n${new URL(request.url).pathname}\n${requestId}\n${timestamp}\n${bodySha256}`;
  if (!(await verifyLifecycleRequestHmac(installationSecret, signature, message))) {
    throw new HttpError(401, "LIFECYCLE_REQUEST_SIGNATURE_INVALID", "Lifecycle request signature is invalid");
  }
  if (event.installation_pseudo_id !== installationId || event.channel !== installation.channel
    || event.external !== (installation.external === 1) || event.demo !== (installation.demo === 1)) {
    throw new HttpError(422, "LIFECYCLE_REGISTRATION_BINDING_INVALID", "Lifecycle event does not match its server-issued installation registration");
  }
  const now = new Date();
  const eventTime = new Date(`${event.event_day}T00:00:00.000Z`);
  const maximumAgeDays = positiveInteger(env.MAX_LIFECYCLE_AGE_DAYS, "MAX_LIFECYCLE_AGE_DAYS", 1, 366);
  if (eventTime.getTime() > now.getTime() + 86_400_000 || eventTime.getTime() < now.getTime() - maximumAgeDays * 86_400_000) {
    throw new HttpError(422, "LIFECYCLE_REPLAY_WINDOW", "Lifecycle event day is outside the configured replay window");
  }
  const sanitized = await sanitizeLifecycleEvent(event, env.TELEMETRY_HMAC_KEY);
  const limited = await env.LIFECYCLE_WRITE_LIMITER.limit({ key: installationId });
  if (!limited.success) throw new HttpError(429, "RATE_LIMITED", "Lifecycle write rate limit exceeded");
  const receivedAt = now.toISOString();
  let result;
  try { result = await storeLifecycleEvent(env.PROOF_DB, sanitized, receivedAt, installationId); }
  catch (error) {
    if (errorHasMarker(error, "LIFECYCLE_CREDENTIAL_NOT_ACTIVE")) {
      throw new HttpError(401, "LIFECYCLE_CREDENTIAL_REVOKED", "Lifecycle credential became inactive before the event was committed");
    }
    throw error;
  }
  return jsonResponse({
    schemaVersion: "agent-vigil-lifecycle-ingestion-receipt/v1",
    eventId: event.event_id,
    created: result.created,
    receivedAt: result.receivedAt,
    ingestionSequence: result.ingestionSequence,
    entityScope: event.entity_scope,
    measurementClass: "UNVERIFIED_TELEMETRY",
    gateEligible: false,
    sybilSusceptible: true,
  }, result.created ? 202 : 200, { "Cache-Control": "no-store" });
}

async function verifyPublisherRequest(request: Request, env: Env, bodySha256: string): Promise<{ publisher: PublisherRow; requestId: string }> {
  const keyId = boundedString(request.headers.get("X-Agent-Vigil-Publisher-Key"), "publisher request key", 71, HASH);
  const requestId = boundedString(request.headers.get("X-Agent-Vigil-Request-Id"), "publisher request ID", 36, UUID_V4);
  const timestamp = exactTimestamp(request.headers.get("X-Agent-Vigil-Timestamp"), "publisher request timestamp");
  const signature = boundedString(request.headers.get("X-Agent-Vigil-Signature"), "publisher request signature", 512);
  assertFresh(timestamp, 1, new Date());
  if (Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60_000) throw new HttpError(422, "REQUEST_REPLAY_WINDOW", "Publisher request timestamp is outside the five-minute replay window");
  const publisher = await activePublisher(env, keyId);
  const path = new URL(request.url).pathname;
  const message = `agent-vigil-hosted-request/v1\n${request.method}\n${path}\n${requestId}\n${timestamp}\n${bodySha256}`;
  if (!(await verifyDetachedEd25519(publisher.public_key_b64, signature, message))) {
    throw new HttpError(401, "PUBLISHER_REQUEST_SIGNATURE_INVALID", "Publisher request signature is invalid");
  }
  await proofWriteLimit(env, keyId);
  return { publisher, requestId };
}

async function handleFirst100Proposal(request: Request, env: Env): Promise<Response> {
  requireEnabled(env.FREQUENCY_INGESTION_ENABLED, "FREQUENCY_INGESTION_DISABLED");
  await edgeWriteLimit(request, env, "first-100-write", env.PROOF_WRITE_LIMITER);
  const body = await readBoundedJson(request, ADMIN_BODY_MAX);
  const auth = await verifyPublisherRequest(request, env, body.bodySha256);
  let proposal;
  try { proposal = validateFirst100Proposal(body.value); }
  catch { throw new HttpError(422, "FIRST_100_PROPOSAL_INVALID", "First-100 proposal failed the frozen pre-inspection contract"); }
  const receivedAt = new Date().toISOString();
  let entry;
  try {
    entry = await registerFirst100Pair(env.PROOF_DB, proposal, {
      r0ReleasedAt: env.R0_RELEASED_AT,
      releasedChannels: env.RELEASED_CHANNELS,
      receivedAt,
      publisherKeyId: auth.publisher.key_id,
      requestId: auth.requestId,
      operatorKeyId: env.FREQUENCY_OPERATOR_KEY_ID,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "first-100 sample is closed") throw new HttpError(409, "FIRST_100_SAMPLE_CLOSED", "The frozen first-100 sample is complete");
    if (errorHasMarker(error, "PUBLISHER_NOT_ACTIVE")) {
      throw new HttpError(403, "PUBLISHER_NOT_ACTIVE", "Publisher key became inactive before the chronological record was committed");
    }
    if (errorHasMarker(error, "KEY_DUTY_CONFLICT")) {
      throw new HttpError(409, "KEY_DUTY_CONFLICT", "Publisher, adapter, and export-operator keys must be pairwise distinct");
    }
    if (errorHasMarker(error, "ADAPTER")) {
      throw new HttpError(422, "FIRST_100_ADAPTER_ATTESTATION_INVALID", "The separately trusted adapter attestation is invalid or inactive");
    }
    if (error instanceof Error && error.message.includes("row cap reached")) {
      throw new HttpError(409, "FIRST_100_ROW_CAP_REACHED", "The bounded chronological lane is stopped at its signed row ceiling");
    }
    throw error;
  }
  return jsonResponse(entry, 201, { "Cache-Control": "no-store" });
}

async function handleFirst100AccessGrant(request: Request, env: Env, acquisitionHandle: string): Promise<Response> {
  requireEnabled(env.FREQUENCY_INGESTION_ENABLED, "FREQUENCY_INGESTION_DISABLED");
  await edgeWriteLimit(request, env, "first-100-access-grant", env.PROOF_WRITE_LIMITER);
  const body = await readBoundedJson(request, ADMIN_BODY_MAX);
  const auth = await verifyPublisherRequest(request, env, body.bodySha256);
  let value;
  try { value = validateFirst100AccessGrantRequest(body.value); }
  catch { throw new HttpError(422, "FIRST_100_ACCESS_GRANT_INVALID", "Artifact access grant request is invalid"); }
  if (value.acquisitionHandle !== acquisitionHandle) {
    throw new HttpError(422, "FIRST_100_ACCESS_GRANT_INVALID", "Artifact access handle does not match the route");
  }
  let result;
  try {
    result = await grantFirst100ArtifactAccess(env.PROOF_DB, value, {
      publisherKeyId: auth.publisher.key_id,
      operatorKeyId: env.FREQUENCY_OPERATOR_KEY_ID,
      grantedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (errorHasMarker(error, "KEY_DUTY_CONFLICT")) {
      throw new HttpError(409, "KEY_DUTY_CONFLICT", "Publisher, adapter, and export-operator keys must be pairwise distinct");
    }
    if (errorHasMarker(error, "ADAPTER_NOT_ACTIVE")) {
      throw new HttpError(409, "FIRST_100_ADAPTER_NOT_ACTIVE", "The acquisition adapter is no longer active");
    }
    if (errorHasMarker(error, "ACCESS_GRANT_REPLAY_EXPIRED")) {
      throw new HttpError(409, "FIRST_100_ACCESS_GRANT_EXPIRED", "The historical artifact access grant cannot authorize a new acquisition");
    }
    throw new HttpError(422, "FIRST_100_ACCESS_GRANT_INVALID", "Artifact access cannot be granted for this acquisition");
  }
  return jsonResponse({
    schemaVersion: "agent-vigil-first-100-artifact-access-grant/v1",
    created: result.created,
    acquisitionHandle,
    ingestionSequence: result.ingestionSequence,
    grantedAt: result.grantedAt,
    artifactAccess: result.artifactAccess,
  }, result.created ? 201 : 200, { "Cache-Control": "no-store" });
}

async function handleFirst100Evaluation(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { value } = await readBoundedJson(request, ADMIN_BODY_MAX);
  let evaluation;
  try { evaluation = validateFirst100Evaluation(value); }
  catch { throw new HttpError(422, "FIRST_100_EVALUATION_INVALID", "First-100 evaluation failed the frozen contract"); }
  let result;
  try { result = await storeFirst100Evaluation(env.PROOF_DB, evaluation, new Date().toISOString()); }
  catch (error) {
    if (errorHasMarker(error, "FIRST_100_PUBLISHER_NOT_ACTIVE")) {
      throw new HttpError(409, "FIRST_100_PUBLISHER_NOT_ACTIVE", "Quarantined publisher evidence cannot receive a new evaluation");
    }
    if (errorHasMarker(error, "FIRST_100_ARTIFACT_ACCESS_NOT_GRANTED")) {
      throw new HttpError(409, "FIRST_100_ARTIFACT_ACCESS_NOT_GRANTED", "Evaluation cannot start before the trusted adapter access grant");
    }
    throw error;
  }
  return jsonResponse({ schemaVersion: "diffwitness-first-100-evaluation-receipt/v1", ingestionSequence: evaluation.ingestionSequence, created: result.created }, result.created ? 201 : 200, { "Cache-Control": "no-store" });
}

async function handleModeration(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const { value } = await readBoundedJson(request, ADMIN_BODY_MAX);
  const body = exactObject(value, ["eventId", "recordType", "recordHash", "action", "reasonClass"], "moderation event", ["replacementHash"]);
  const recordTypes = new Set(["ENTRY", "RESOLUTION"]);
  const actions = new Set(["CORRECT", "TAKEDOWN", "REVOKE", "RESTORE"]);
  const reasons = new Set(["PRIVACY", "INVALID_EVIDENCE", "KEY_COMPROMISE", "DUPLICATE", "PUBLISHER_REQUEST", "LEGAL", "OTHER", "RESTORED"]);
  if (typeof body.recordType !== "string" || !recordTypes.has(body.recordType) || typeof body.action !== "string" || !actions.has(body.action)
    || typeof body.reasonClass !== "string" || !reasons.has(body.reasonClass)) throw new HttpError(400, "INVALID_REQUEST", "Moderation state is invalid");
  const recordHash = boundedString(body.recordHash, "moderation record hash", 71, HASH);
  const replacementHash = body.replacementHash === undefined ? undefined : boundedString(body.replacementHash, "moderation replacement hash", 71, HASH);
  if ((body.action === "CORRECT") !== (replacementHash !== undefined)) throw new HttpError(400, "INVALID_REQUEST", "Correction requires exactly one replacement hash");
  if (replacementHash === recordHash) throw new HttpError(400, "INVALID_REQUEST", "Correction replacement must be distinct");
  const existing = body.recordType === "ENTRY" ? await getEntryRow(env.PROOF_DB, recordHash) : await getResolutionRow(env.PROOF_DB, recordHash);
  if (!existing) throw new HttpError(404, "RECORD_NOT_FOUND", "Moderation target is not present");
  if (replacementHash !== undefined) {
    const replacement = body.recordType === "ENTRY" ? await getEntryRow(env.PROOF_DB, replacementHash) : await getResolutionRow(env.PROOF_DB, replacementHash);
    if (!replacement) throw new HttpError(409, "REPLACEMENT_NOT_FOUND", "Correction replacement is not present");
    const originalRecord = body.recordType === "ENTRY" ? parseEntryRow(existing) : parseResolutionRow(existing);
    const replacementRecord = body.recordType === "ENTRY" ? parseEntryRow(replacement) : parseResolutionRow(replacement);
    if (originalRecord.component.ecosystem !== replacementRecord.component.ecosystem
      || originalRecord.component.name !== replacementRecord.component.name) {
      throw new HttpError(422, "REPLACEMENT_BINDING_INVALID", "Correction replacement must describe the same component");
    }
  }
  const state = await moderateRecord(env.PROOF_DB, {
    eventId: boundedString(body.eventId, "moderation event ID", 36, UUID_V4),
    recordType: body.recordType as "ENTRY" | "RESOLUTION",
    recordHash,
    action: body.action as "CORRECT" | "TAKEDOWN" | "REVOKE" | "RESTORE",
    reasonClass: body.reasonClass,
    ...(replacementHash === undefined ? {} : { replacementHash }),
    occurredAt: new Date().toISOString(),
  });
  return jsonResponse({ schemaVersion: "agent-vigil-moderation-state/v1", recordType: body.recordType, recordHash, ...state }, 200, { "Cache-Control": "no-store" });
}

async function handleEntryGet(request: Request, env: Env, entryHash: string, html: boolean): Promise<Response> {
  await publicReadLimit(env, request, html ? "proof-page" : "entry-api");
  const [row, state] = await Promise.all([
    getEntryRow(env.PROOF_DB, entryHash),
    getModerationState(env.PROOF_DB, "ENTRY", entryHash),
  ]);
  if (!row) throw new HttpError(404, "ENTRY_NOT_FOUND", "Compatibility entry was not found");
  if (moderationUnavailable(state)) return revokedResponse(state!);
  const publisher = await getPublisher(env.PROOF_DB, row.key_id);
  if (!publisher || publisher.status !== "ACTIVE") return jsonResponse({ error: { code: "PUBLISHER_NOT_ACTIVE", message: "Record publisher is not active" } }, 410, { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
  const entry = parseEntryRow(row);
  const resolutionRow = await getResolutionForBroken(env.PROOF_DB, entryHash);
  const resolution = resolutionRow ? parseResolutionRow(resolutionRow) : undefined;
  const resolutionTrust = resolutionRow === null ? null : {
    resolutionHash: resolution?.resolutionHash,
    resolutionPublisherUpdatedAt: resolutionRow.resolution_publisher_updated_at,
    resolutionModerationUpdatedAt: resolutionRow.resolution_moderation_updated_at,
    brokenPublisherUpdatedAt: resolutionRow.broken_publisher_updated_at,
    brokenModerationUpdatedAt: resolutionRow.broken_moderation_updated_at,
    fixedPublisherUpdatedAt: resolutionRow.fixed_publisher_updated_at,
    fixedModerationUpdatedAt: resolutionRow.fixed_moderation_updated_at,
  };
  const representationTag = await sha256(canonical({ entryHash, publisherUpdatedAt: publisher.updated_at, moderation: state, resolutionTrust }));
  if (request.headers.get("If-None-Match") === `"${representationTag}"`) return new Response(null, { status: 304, headers: {
    ETag: `"${representationTag}"`,
    "Cache-Control": "public, no-cache",
    ...(html ? {} : { "Access-Control-Allow-Origin": "*" }),
  } });
  if (html) return htmlResponse(renderProofPage(entry, resolution, state ?? undefined), 200, { "Cache-Control": "public, no-cache", ETag: `"${representationTag}"` });
  return publicApiResponse({ schemaVersion: "agent-vigil-proof-api-entry/v1", entry, moderation: state, resolution: resolution ?? null }, "public, no-cache", representationTag);
}

async function handleResolutionGet(request: Request, env: Env, resolutionHash: string, html: boolean): Promise<Response> {
  await publicReadLimit(env, request, html ? "resolution-page" : "resolution-api");
  const [row, state] = await Promise.all([
    getResolutionRow(env.PROOF_DB, resolutionHash),
    getModerationState(env.PROOF_DB, "RESOLUTION", resolutionHash),
  ]);
  if (!row) throw new HttpError(404, "RESOLUTION_NOT_FOUND", "Compatibility resolution was not found");
  if (moderationUnavailable(state)) return revokedResponse(state!);
  const publisher = await getPublisher(env.PROOF_DB, row.key_id);
  if (!publisher || publisher.status !== "ACTIVE") return jsonResponse({ error: { code: "PUBLISHER_NOT_ACTIVE", message: "Record publisher is not active" } }, 410, { "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" });
  const publicRow = await getPublicResolutionRow(env.PROOF_DB, resolutionHash);
  if (!publicRow) return jsonResponse({
    error: {
      code: "RESOLUTION_EVIDENCE_UNAVAILABLE",
      message: "Resolution or referenced exact-pair evidence is not active and unmoderated",
    },
  }, 410, { "Cache-Control": "public, no-cache", "Access-Control-Allow-Origin": "*" });
  const resolution = parseResolutionRow(publicRow);
  const representationTag = await sha256(canonical({
    resolutionHash,
    publisherUpdatedAt: publicRow.resolution_publisher_updated_at,
    moderation: state,
    resolutionModerationUpdatedAt: publicRow.resolution_moderation_updated_at,
    brokenPublisherUpdatedAt: publicRow.broken_publisher_updated_at,
    brokenModerationUpdatedAt: publicRow.broken_moderation_updated_at,
    fixedPublisherUpdatedAt: publicRow.fixed_publisher_updated_at,
    fixedModerationUpdatedAt: publicRow.fixed_moderation_updated_at,
  }));
  if (request.headers.get("If-None-Match") === `"${representationTag}"`) return new Response(null, { status: 304, headers: {
    ETag: `"${representationTag}"`,
    "Cache-Control": "public, no-cache",
    ...(html ? {} : { "Access-Control-Allow-Origin": "*" }),
  } });
  if (html) return htmlResponse(renderResolutionPage(resolution), 200, { "Cache-Control": "public, no-cache", ETag: `"${representationTag}"` });
  return publicApiResponse({ schemaVersion: "agent-vigil-proof-api-resolution/v1", resolution, moderation: state }, "public, no-cache", representationTag);
}

async function handleSearch(request: Request, env: Env, html: boolean): Promise<Response> {
  await publicReadLimit(env, request, html ? "search-page" : "search-api");
  const url = new URL(request.url);
  const textParam = (name: string, maximum: number): string | undefined => {
    const value = url.searchParams.get(name);
    if (value === null || value === "") return undefined;
    if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, "INVALID_QUERY", "Search query is invalid");
    return value;
  };
  const verdictText = textParam("verdict", 7);
  if (verdictText !== undefined && !new Set(["SAFE", "CHANGED", "HOLD"]).has(verdictText)) throw new HttpError(400, "INVALID_QUERY", "Search verdict is invalid");
  const limitText = url.searchParams.get("limit") ?? (html ? "50" : "25");
  const entries = await searchEntries(env.PROOF_DB, {
    ...(textParam("ecosystem", 80) === undefined ? {} : { ecosystem: textParam("ecosystem", 80)! }),
    ...(textParam("component", 160) === undefined ? {} : { component: textParam("component", 160)! }),
    ...(textParam("current", 128) === undefined ? {} : { currentVersion: textParam("current", 128)! }),
    ...(textParam("candidate", 128) === undefined ? {} : { candidateVersion: textParam("candidate", 128)! }),
    ...(verdictText === undefined ? {} : { verdict: verdictText as Verdict }),
    ...(textParam("q", 160) === undefined ? {} : { query: textParam("q", 160)! }),
    limit: positiveInteger(limitText, "search limit", 1, 50),
  });
  if (html) return htmlResponse(renderSearchPage(entries, textParam("q", 160) ?? ""), 200, { "Cache-Control": "public, no-cache" });
  return publicApiResponse({ schemaVersion: "agent-vigil-proof-search/v1", entries, count: entries.length }, "public, no-cache");
}

async function handleBadge(request: Request, env: Env, entryHash: string): Promise<Response> {
  await publicReadLimit(env, request, "badge-api");
  const [row, state] = await Promise.all([getEntryRow(env.PROOF_DB, entryHash), getModerationState(env.PROOF_DB, "ENTRY", entryHash)]);
  if (row && state?.action === "CORRECT") {
    const representationTag = await sha256(canonical({ entryHash, moderation: state }));
    return publicApiResponse({
      schemaVersion: 1,
      label: "agent update",
      message: "corrected",
      color: "lightgrey",
      cacheSeconds: 60,
      ...(state.replacement_hash === null ? {} : { link: `/proof/${state.replacement_hash}` }),
    }, "public, no-cache", representationTag);
  }
  if (!row || moderationUnavailable(state)) return publicApiResponse({ schemaVersion: 1, label: "agent update", message: "unavailable", color: "lightgrey", cacheSeconds: 60 }, "public, max-age=60");
  const publisher = await getPublisher(env.PROOF_DB, row.key_id);
  if (!publisher || publisher.status !== "ACTIVE") return publicApiResponse({ schemaVersion: 1, label: "agent update", message: "revoked", color: "lightgrey", cacheSeconds: 60 }, "public, max-age=60");
  const entry = parseEntryRow(row);
  const origin = new URL(request.url).origin;
  return publicApiResponse(badgePayload(entry, `${origin}/proof/${entry.entryHash}`), "public, no-cache", entryHash);
}

async function handleLifecycleExport(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const after = positiveInteger(url.searchParams.get("after") ?? "0", "lifecycle export cursor", 0, Number.MAX_SAFE_INTEGER);
  const limit = positiveInteger(url.searchParams.get("limit") ?? "500", "lifecycle export limit", 1, 1_000);
  const records = await exportLifecycleEvents(env.PROOF_DB, after, limit);
  const headers = securityHeaders("application/x-ndjson; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(`${records.map((record) => JSON.stringify(record)).join("\n")}${records.length ? "\n" : ""}`, { headers });
}

async function handleFirst100Export(request: Request, env: Env): Promise<Response> {
  await publicReadLimit(env, request, "first-100-export");
  const entries = await exportFirst100Entries(env.PROOF_DB);
  const headers = securityHeaders("application/x-ndjson; charset=utf-8");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Agent-Vigil-Gate-Eligible", "false");
  headers.set("X-Agent-Vigil-Provenance-Required", "true");
  headers.set("Link", "</api/v1/frequency/first-100-provenance.jsonl>; rel=\"provenance\"; type=\"application/x-ndjson\", </api/v1/frequency/first-100/manifest.json>; rel=\"describedby\"; type=\"application/json\"");
  return new Response(first100Jsonl(entries), { headers });
}

async function handleFirst100ProvenanceExport(request: Request, env: Env): Promise<Response> {
  await publicReadLimit(env, request, "first-100-provenance-export");
  const bundle = await exportFirst100Bundle(env.PROOF_DB);
  const rawLedger = first100Jsonl(bundle.entries);
  const provenance = await first100ProvenanceJsonl(bundle.provenance, rawLedger);
  const headers = securityHeaders("application/x-ndjson; charset=utf-8");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Agent-Vigil-Chronology-Mutable", "false");
  return new Response(provenance, { headers });
}

function frequencySigning(env: Env): { keyId: string; privateKeyPkcs8Base64: string } {
  if (!HASH.test(env.FREQUENCY_OPERATOR_KEY_ID)
    || env.FREQUENCY_OPERATOR_KEY_ID === `sha256:${"0".repeat(64)}`
    || typeof env.FREQUENCY_OPERATOR_PRIVATE_KEY_PKCS8_B64 !== "string"
    || env.FREQUENCY_OPERATOR_PRIVATE_KEY_PKCS8_B64.length < 32) {
    throw new HttpError(503, "FREQUENCY_EXPORT_SIGNING_UNAVAILABLE", "Frequency export signing is not configured");
  }
  return {
    keyId: env.FREQUENCY_OPERATOR_KEY_ID,
    privateKeyPkcs8Base64: env.FREQUENCY_OPERATOR_PRIVATE_KEY_PKCS8_B64,
  };
}

function requestedExportIssuedAt(request: Request): string {
  const value = new URL(request.url).searchParams.get("issuedAt");
  if (value === null) throw new HttpError(400, "EXPORT_ISSUED_AT_REQUIRED", "Use the exact issuedAt from the signed manifest");
  const issuedAt = exactTimestamp(value, "frequency export issuedAt");
  const distance = Date.now() - Date.parse(issuedAt);
  if (distance < -5_000 || distance > 5 * 60_000) {
    throw new HttpError(410, "EXPORT_ISSUED_AT_EXPIRED", "The requested signed snapshot is future-dated or expired");
  }
  return issuedAt;
}

async function handleFirst100Manifest(request: Request, env: Env): Promise<Response> {
  await publicReadLimit(env, request, "first-100-manifest");
  const issuedAt = new Date().toISOString();
  const snapshot = await buildFirst100SignedExport(env.PROOF_DB, frequencySigning(env), issuedAt);
  return jsonResponse(snapshot.manifest, 200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Agent-Vigil-Head-Issued-At": issuedAt,
    Link: `</api/v1/frequency/first-100/head.json?issuedAt=${encodeURIComponent(issuedAt)}>; rel=\"current\"; type=\"application/json\"`,
  });
}

async function handleFirst100TrustedHead(request: Request, env: Env): Promise<Response> {
  await publicReadLimit(env, request, "first-100-trusted-head");
  const issuedAt = requestedExportIssuedAt(request);
  const snapshot = await buildFirst100SignedExport(env.PROOF_DB, frequencySigning(env), issuedAt);
  return jsonResponse(snapshot.trustedHead, 200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
}

async function handleFirst100Chunk(request: Request, env: Env, index: number): Promise<Response> {
  await publicReadLimit(env, request, "first-100-chunk");
  const issuedAt = requestedExportIssuedAt(request);
  const snapshot = await buildFirst100SignedExport(env.PROOF_DB, frequencySigning(env), issuedAt);
  const chunk = snapshot.chunks[index];
  if (!chunk) throw new HttpError(404, "FIRST_100_CHUNK_NOT_FOUND", "The signed export chunk does not exist");
  return jsonResponse(chunk.document, 200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Agent-Vigil-Chunk-Index": String(index),
  });
}

async function handleRobots(request: Request, env: Env): Promise<Response> {
  await publicReadLimit(env, request, "robots");
  const origin = new URL(request.url).origin;
  return textResponse(
    `User-agent: *\nAllow: /\nDisallow: /v1/\nSitemap: ${origin}/sitemap.xml\n`,
    "text/plain; charset=utf-8",
    { "Cache-Control": "public, max-age=3600" },
  );
}

async function handleSitemap(request: Request, env: Env): Promise<Response> {
  await publicReadLimit(env, request, "sitemap");
  const origin = new URL(request.url).origin;
  const entries = await searchEntries(env.PROOF_DB, { limit: 50 });
  const escapeXml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  const locations = [
    `${origin}/`,
    ...entries.flatMap((entry) => [
      `${origin}/proof/${entry.entryHash}`,
      ...(entry.resolutionHash === undefined ? [] : [`${origin}/resolution/${entry.resolutionHash}`]),
    ]),
  ];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations.map((location) => `  <url><loc>${escapeXml(location)}</loc></url>`).join("\n")}\n</urlset>\n`;
  return textResponse(body, "application/xml; charset=utf-8", { "Cache-Control": "public, no-cache" });
}

function corsPreflight(request: Request): Response {
  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  if (requestedMethod !== "GET") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Only public GET API requests support browser CORS");
  return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "If-None-Match",
    "Access-Control-Max-Age": "86400",
    Vary: "Access-Control-Request-Method, Access-Control-Request-Headers",
  } });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) return corsPreflight(request);
  if (request.method === "GET" && url.pathname === "/health") return jsonResponse({ status: "ok", schemaVersion: "agent-vigil-proof-health/v1" }, 200, { "Cache-Control": "no-store" });
  if (request.method === "GET" && url.pathname === "/robots.txt") return handleRobots(request, env);
  if (request.method === "GET" && url.pathname === "/sitemap.xml") return handleSitemap(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/publishers/register") return handleRegisterPublisher(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/publishers/status") return handlePublisherStatus(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/frequency/adapters/register") return handleRegisterFrequencyAdapter(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/frequency/adapters/status") return handleFrequencyAdapterStatus(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/lifecycle/installations/status") return handleLifecycleInstallationStatus(request, env);
  if (request.method === "POST" && url.pathname === "/v1/admin/moderation") return handleModeration(request, env);
  if (request.method === "POST" && url.pathname === "/v1/entries") return handleEntryIngestion(request, env);
  if (request.method === "POST" && url.pathname === "/v1/resolutions") return handleResolutionIngestion(request, env);
  if (request.method === "POST" && url.pathname === "/v1/lifecycle/installations") return handleLifecycleRegistration(request, env);
  if (request.method === "POST" && url.pathname === "/v1/lifecycle") return handleLifecycleIngestion(request, env);
  if (request.method === "POST" && url.pathname === "/v1/frequency/first-100/acquisitions") return handleFirst100Proposal(request, env);
  const accessGrant = url.pathname.match(/^\/v1\/frequency\/first-100\/acquisitions\/([0-9a-f-]{36})\/grant$/);
  if (request.method === "POST" && accessGrant) return handleFirst100AccessGrant(request, env, accessGrant[1]!);
  if (request.method === "POST" && url.pathname === "/v1/admin/frequency/first-100/evaluations") return handleFirst100Evaluation(request, env);
  if (request.method === "GET" && url.pathname === "/v1/admin/lifecycle/export") return handleLifecycleExport(request, env);
  if (request.method === "GET" && url.pathname === "/api/v1/frequency/first-100.jsonl") return handleFirst100Export(request, env);
  if (request.method === "GET" && url.pathname === "/api/v1/frequency/first-100-provenance.jsonl") return handleFirst100ProvenanceExport(request, env);
  if (request.method === "GET" && url.pathname === "/api/v1/frequency/first-100/manifest.json") return handleFirst100Manifest(request, env);
  if (request.method === "GET" && url.pathname === "/api/v1/frequency/first-100/head.json") return handleFirst100TrustedHead(request, env);
  const chunk = url.pathname.match(/^\/api\/v1\/frequency\/first-100\/chunks\/(\d+)\.json$/);
  if (request.method === "GET" && chunk) return handleFirst100Chunk(request, env, positiveInteger(chunk[1]!, "chunk index", 0, 9));
  if (request.method === "GET" && url.pathname === "/") return handleSearch(request, env, true);
  if (request.method === "GET" && url.pathname === "/api/v1/search") return handleSearch(request, env, false);
  const entryApi = url.pathname.match(/^\/api\/v1\/entries\/(sha256:[0-9a-f]{64})$/);
  if (request.method === "GET" && entryApi) return handleEntryGet(request, env, entryApi[1]!, false);
  const entryPage = url.pathname.match(/^\/proof\/(sha256:[0-9a-f]{64})$/);
  if (request.method === "GET" && entryPage) return handleEntryGet(request, env, entryPage[1]!, true);
  const resolutionApi = url.pathname.match(/^\/api\/v1\/resolutions\/(sha256:[0-9a-f]{64})$/);
  if (request.method === "GET" && resolutionApi) return handleResolutionGet(request, env, resolutionApi[1]!, false);
  const resolutionPage = url.pathname.match(/^\/resolution\/(sha256:[0-9a-f]{64})$/);
  if (request.method === "GET" && resolutionPage) return handleResolutionGet(request, env, resolutionPage[1]!, true);
  const badge = url.pathname.match(/^\/api\/v1\/badges\/(sha256:[0-9a-f]{64})$/);
  if (request.method === "GET" && badge) return handleBadge(request, env, badge[1]!);
  if (new Set(["/v1/admin/publishers/register", "/v1/admin/publishers/status", "/v1/admin/frequency/adapters/register", "/v1/admin/frequency/adapters/status", "/v1/admin/lifecycle/installations/status", "/v1/admin/moderation", "/v1/entries", "/v1/resolutions", "/v1/lifecycle/installations", "/v1/lifecycle", "/v1/frequency/first-100/acquisitions", "/v1/admin/frequency/first-100/evaluations"]).has(url.pathname)) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method is not allowed for this route");
  }
  throw new HttpError(404, "NOT_FOUND", "Route was not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const pathname = new URL(request.url).pathname;
    const fixedRoutes = new Set([
      "/health", "/robots.txt", "/sitemap.xml", "/", "/v1/admin/publishers/register", "/v1/admin/publishers/status",
      "/v1/admin/lifecycle/installations/status", "/v1/admin/moderation", "/v1/admin/frequency/adapters/register",
      "/v1/admin/frequency/adapters/status", "/v1/entries", "/v1/resolutions",
      "/v1/lifecycle/installations", "/v1/lifecycle", "/v1/frequency/first-100/acquisitions",
      "/v1/admin/frequency/first-100/evaluations", "/v1/admin/lifecycle/export",
      "/api/v1/frequency/first-100.jsonl", "/api/v1/frequency/first-100-provenance.jsonl",
      "/api/v1/frequency/first-100/manifest.json", "/api/v1/frequency/first-100/head.json", "/api/v1/search",
    ]);
    const routeClass = fixedRoutes.has(pathname) ? pathname
      : /^\/api\/v1\/entries\//.test(pathname) ? "/api/v1/entries/:hash"
      : /^\/proof\//.test(pathname) ? "/proof/:hash"
      : /^\/api\/v1\/resolutions\//.test(pathname) ? "/api/v1/resolutions/:hash"
      : /^\/resolution\//.test(pathname) ? "/resolution/:hash"
      : /^\/api\/v1\/badges\//.test(pathname) ? "/api/v1/badges/:hash"
      : /^\/v1\/frequency\/first-100\/acquisitions\//.test(pathname) ? "/v1/frequency/first-100/acquisitions/:handle/grant"
      : /^\/api\/v1\/frequency\/first-100\/chunks\//.test(pathname) ? "/api/v1/frequency/first-100/chunks/:index"
      : "unmatched";
    const methodClass = new Set(["GET", "POST", "OPTIONS"]).has(request.method) ? request.method : "OTHER";
    try {
      const response = await route(request, env);
      response.headers.set("X-Request-Id", requestId);
      console.log(JSON.stringify({ message: "request complete", requestId, method: methodClass, route: routeClass, status: response.status }));
      return response;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof HttpError ? error.message : "Internal server error";
      console.error(JSON.stringify({ message: "request failed", requestId, method: methodClass, route: routeClass, status, code }));
      return jsonResponse({ error: { code, message, requestId } }, status, { "Cache-Control": "no-store", "X-Request-Id": requestId });
    }
  },
} satisfies ExportedHandler<Env>;

export { ENTRY_SCHEMA, RESOLUTION_SCHEMA };
