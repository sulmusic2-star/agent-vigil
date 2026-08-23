import type { AuthContext } from "./auth.ts";
import { requireRole } from "./auth.ts";
import { hmacHex, sha256Hex, verifyHmacHex } from "./crypto.ts";
import { auditStatement, newId, nowIso, userAudit } from "./db.ts";
import { ApiError, jsonResponse, parseJsonObject, readBoundedText, readJsonObject } from "./http.ts";
import {
  assertExactKeys,
  requireBoolean,
  requireEnum,
  requireInteger,
  requireIsoDate,
  requireOpaqueId,
  requireString
} from "./validation.ts";

const BODY_LIMIT = 32_768;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const REPEAT_MATURITY_DAYS = 60;
const PQL_WINDOW_DAYS = 30;
const PQL_OFFER_MATURITY_DAYS = 30;
const TEAM_OFFER_CONTRACT_ID = "team_v1_299_monthly_2990_annual";

type Classification = "external" | "internal" | "demo" | "test";
type ClassificationBasis =
  | "provider_confirmed_non_operator"
  | "operator_identity_registry"
  | "demo_registry"
  | "test_environment_registry";
type MessageKind =
  | "r0_boundary_v1"
  | "organization_subject_attestation_v1"
  | "organization_activation_v1"
  | "team_offer_presented_v1";

interface MeasurementConfig {
  releaseVersion: string;
  releaseCommitSha: string;
  releaseChannel: "github_app";
  deploymentEnvironment: "production";
  releasePublishedAt: string;
  r0StartedAt: string;
  githubAppId: number;
}

interface BoundaryRow {
  release_version: string;
  release_commit_sha: string;
  release_channel: "github_app";
  deployment_environment: "production";
  release_published_at: string;
  r0_started_at: string;
  github_app_id: number;
  initialized_message_id: string;
  initialized_at: string;
}

interface ExistingMessage {
  payload_sha256: string;
  message_kind: MessageKind;
  result: "applied" | "ignored_duplicate_day";
}

interface ActiveInstallation {
  installation_id: number;
  app_id: number;
  org_id: string;
  state: "active";
  installed_at: string;
  reconciled_at: string;
  organization_status: "active";
}

interface EligibleSubject {
  subject_token: string;
  org_id: string;
  installation_id: number;
  eligible_at: string;
}

interface BridgeBase {
  messageId: string;
  messageKind: MessageKind;
  observedAt: string;
}

function requireEnabled(env: Env): void {
  const enabled: string = env.R0_MEASUREMENT_ENABLED;
  if (enabled !== "true") {
    throw new ApiError(503, "r0_measurement_disabled", "R0 measurement ingestion is disabled.");
  }
}

function parseConfiguredAppId(value: string): number {
  if (!/^\d{1,15}$/u.test(value)) {
    throw new Error("GITHUB_APP_ID is not configured for R0 measurement");
  }
  const appId = Number(value);
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new Error("GITHUB_APP_ID is not configured for R0 measurement");
  }
  return appId;
}

function requireConfiguredIso(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${name} is not configured for R0 measurement`);
  }
  return value;
}

function measurementConfig(env: Env): MeasurementConfig {
  const releaseVersion: string = env.R0_MEASUREMENT_RELEASE_VERSION;
  const releaseCommitSha: string = env.R0_MEASUREMENT_RELEASE_COMMIT_SHA;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseVersion)) {
    throw new Error("R0_MEASUREMENT_RELEASE_VERSION is not configured");
  }
  if (!/^[a-f0-9]{40}$/u.test(releaseCommitSha)) {
    throw new Error("R0_MEASUREMENT_RELEASE_COMMIT_SHA is not configured");
  }
  const releaseChannel: string = env.R0_MEASUREMENT_RELEASE_CHANNEL;
  if (releaseChannel !== "github_app") {
    throw new Error("R0_MEASUREMENT_RELEASE_CHANNEL must be github_app");
  }
  const deploymentEnvironment: string = env.R0_MEASUREMENT_ENVIRONMENT;
  if (deploymentEnvironment !== "production") {
    throw new Error("R0_MEASUREMENT_ENVIRONMENT must be production");
  }
  const releasePublishedAt = requireConfiguredIso(
    env.R0_MEASUREMENT_RELEASE_PUBLISHED_AT,
    "R0_MEASUREMENT_RELEASE_PUBLISHED_AT"
  );
  const r0StartedAt = requireConfiguredIso(env.R0_MEASUREMENT_STARTED_AT, "R0_MEASUREMENT_STARTED_AT");
  if (Date.parse(r0StartedAt) < Date.parse(releasePublishedAt)) {
    throw new Error("R0 measurement cannot start before the configured release publication");
  }
  return {
    releaseVersion,
    releaseCommitSha,
    releaseChannel: "github_app",
    deploymentEnvironment: "production",
    releasePublishedAt,
    r0StartedAt,
    githubAppId: parseConfiguredAppId(env.GITHUB_APP_ID)
  };
}

function parseSignature(header: string | null): { timestamp: number; signatures: string[] } {
  if (!header || header.length > 4096) {
    throw new ApiError(401, "invalid_measurement_signature", "A measurement bridge signature is required.");
  }
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^\d{1,12}$/u.test(value)) timestamp = Number(value);
    if (key === "v1") signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) {
    throw new ApiError(401, "invalid_measurement_signature", "Measurement bridge signature is invalid.");
  }
  return { timestamp, signatures };
}

async function verifyBridgeSignature(request: Request, rawBody: string, secret: string): Promise<void> {
  const parsed = parseSignature(request.headers.get("Agent-Vigil-Measurement-Signature"));
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new ApiError(401, "stale_measurement_signature", "Measurement bridge signature is outside its allowed window.");
  }
  const signed = `${parsed.timestamp}.${rawBody}`;
  for (const signature of parsed.signatures) {
    if (await verifyHmacHex(secret, signed, signature)) return;
  }
  throw new ApiError(401, "invalid_measurement_signature", "Measurement bridge signature verification failed.");
}

function assertFresh(timestamp: string, field: string): void {
  if (Math.abs(Date.now() - Date.parse(timestamp)) > SIGNATURE_TOLERANCE_SECONDS * 1000) {
    throw new ApiError(400, "stale_measurement_observation", `${field} is outside its allowed observation window.`);
  }
}

function parseBase(body: Record<string, unknown>): BridgeBase {
  if (body.schema_version !== "r0-measurement-bridge-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be r0-measurement-bridge-v1.");
  }
  const messageKind = requireEnum(body.message_kind, "message_kind", [
    "r0_boundary_v1",
    "organization_subject_attestation_v1",
    "organization_activation_v1",
    "team_offer_presented_v1"
  ] as const);
  const observedAt = requireIsoDate(body.observed_at, "observed_at");
  assertFresh(observedAt, "observed_at");
  return {
    messageId: requireOpaqueId(body.message_id, "message_id", 128),
    messageKind,
    observedAt
  };
}

async function existingMessage(db: D1Database, messageId: string): Promise<ExistingMessage | null> {
  return db
    .prepare(
      `SELECT payload_sha256, message_kind, result
         FROM measurement_bridge_messages WHERE message_id = ?1`
    )
    .bind(messageId)
    .first<ExistingMessage>();
}

function duplicateResponse(existing: ExistingMessage, payloadHash: string, kind: MessageKind): Response {
  if (existing.payload_sha256 !== payloadHash) {
    throw new ApiError(409, "measurement_message_replay_mismatch", "Message identifier was reused with different bytes.");
  }
  if (existing.message_kind !== kind) {
    throw new ApiError(409, "measurement_message_kind_mismatch", "Message kind changed during replay.");
  }
  return jsonResponse({ accepted: true, duplicate: true, counted: existing.result === "applied", result: existing.result });
}

async function loadBoundary(db: D1Database): Promise<BoundaryRow | null> {
  return db
    .prepare(
      `SELECT release_version, release_commit_sha, release_channel, deployment_environment,
              release_published_at, r0_started_at, github_app_id,
              initialized_message_id, initialized_at
         FROM measurement_boundaries WHERE boundary_id = 'r0'`
    )
    .first<BoundaryRow>();
}

function assertBoundaryMatchesConfig(boundary: BoundaryRow, config: MeasurementConfig): void {
  if (
    boundary.release_version !== config.releaseVersion ||
    boundary.release_commit_sha !== config.releaseCommitSha ||
    boundary.release_channel !== config.releaseChannel ||
    boundary.deployment_environment !== config.deploymentEnvironment ||
    boundary.release_published_at !== config.releasePublishedAt ||
    boundary.r0_started_at !== config.r0StartedAt ||
    boundary.github_app_id !== config.githubAppId
  ) {
    throw new ApiError(503, "r0_boundary_config_drift", "Persisted R0 boundary does not match deployment configuration.");
  }
}

async function requireBoundary(env: Env): Promise<BoundaryRow> {
  const boundary = await loadBoundary(env.TEAM_CONTROL_DB);
  if (!boundary) {
    throw new ApiError(409, "r0_boundary_not_initialized", "The immutable R0 boundary must be initialized first.");
  }
  assertBoundaryMatchesConfig(boundary, measurementConfig(env));
  return boundary;
}

async function stableSubjectToken(env: Env, installationId: number, orgId: string): Promise<string> {
  const digest = await hmacHex(
    env.R0_MEASUREMENT_IDENTITY_HMAC_SECRET,
    `agent-vigil:r0:organization:v1:${installationId}:${orgId}`
  );
  return `morg_${digest}`;
}

async function activeInstallation(env: Env, installationId: number): Promise<ActiveInstallation> {
  const installation = await env.TEAM_CONTROL_DB.prepare(
    `SELECT i.installation_id, i.app_id, i.org_id, i.state, i.installed_at, i.reconciled_at,
            o.status AS organization_status
       FROM github_installations i
       JOIN organizations o ON o.id = i.org_id
      WHERE i.installation_id = ?1`
  )
    .bind(installationId)
    .first<ActiveInstallation>();
  if (
    !installation ||
    installation.state !== "active" ||
    installation.organization_status !== "active" ||
    !installation.reconciled_at
  ) {
    throw new ApiError(
      409,
      "authenticated_organization_installation_required",
      "An active independently reconciled GitHub App organization installation is required."
    );
  }
  return installation;
}

async function refreshEligibility(db: D1Database, orgId: string, at: string): Promise<void> {
  await db
    .prepare(
      `UPDATE measurement_subjects
          SET eligible_at = COALESCE(eligible_at, ?1), updated_at = ?1
        WHERE org_id = ?2
          AND classification = 'external'
          AND EXISTS (
            SELECT 1 FROM measurement_consents c
             WHERE c.org_id = ?2 AND c.opted_in = 1
          )
          AND EXISTS (
            SELECT 1
              FROM github_installations i
              JOIN measurement_boundaries b ON b.boundary_id = 'r0'
             WHERE i.installation_id = measurement_subjects.installation_id
               AND i.org_id = ?2
               AND i.state = 'active'
               AND i.reconciled_at IS NOT NULL
               AND i.app_id = b.github_app_id
               AND i.installed_at >= b.r0_started_at
               AND i.installed_at <= ?1
               AND i.reconciled_at <= ?1
               AND b.r0_started_at <= ?1
          )`
    )
    .bind(at, orgId)
    .run();
}

async function initializeBoundary(
  env: Env,
  base: BridgeBase,
  body: Record<string, unknown>,
  payloadHash: string
): Promise<Response> {
  assertExactKeys(body, [
    "schema_version",
    "message_id",
    "message_kind",
    "observed_at",
    "release_version",
    "release_commit_sha",
    "release_channel",
    "deployment_environment",
    "release_published_at",
    "r0_started_at",
    "github_app_id"
  ]);
  const config = measurementConfig(env);
  const proposed = {
    releaseVersion: requireString(body.release_version, "release_version", {
      max: 64,
      pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
    }),
    releaseCommitSha: requireString(body.release_commit_sha, "release_commit_sha", {
      min: 40,
      max: 40,
      pattern: /^[a-f0-9]{40}$/u
    }),
    releaseChannel: requireEnum(body.release_channel, "release_channel", ["github_app"] as const),
    deploymentEnvironment: requireEnum(body.deployment_environment, "deployment_environment", ["production"] as const),
    releasePublishedAt: requireIsoDate(body.release_published_at, "release_published_at"),
    r0StartedAt: requireIsoDate(body.r0_started_at, "r0_started_at"),
    githubAppId: requireInteger(body.github_app_id, "github_app_id", { min: 1 })
  };
  if (JSON.stringify(proposed) !== JSON.stringify(config)) {
    throw new ApiError(409, "r0_boundary_config_mismatch", "Boundary message does not exactly match deployment configuration.");
  }
  if (Date.parse(proposed.r0StartedAt) < Date.parse(proposed.releasePublishedAt)) {
    throw new ApiError(400, "invalid_r0_boundary", "R0 cannot start before release publication.");
  }
  if (Date.parse(proposed.r0StartedAt) > Date.parse(base.observedAt)) {
    throw new ApiError(400, "invalid_r0_boundary", "R0 cannot be initialized before its configured start.");
  }
  const prior = await loadBoundary(env.TEAM_CONTROL_DB);
  if (prior) {
    throw new ApiError(409, "r0_boundary_already_initialized", "The R0 boundary is immutable and already initialized.");
  }
  const at = nowIso();
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO measurement_boundaries
        (boundary_id, schema_version, release_version, release_commit_sha, release_channel,
         deployment_environment, release_published_at, r0_started_at, github_app_id,
         initialized_message_id, initialized_at)
       VALUES ('r0', 'r0-measurement-boundary-v1', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(
      config.releaseVersion,
      config.releaseCommitSha,
      config.releaseChannel,
      config.deploymentEnvironment,
      config.releasePublishedAt,
      config.r0StartedAt,
      config.githubAppId,
      base.messageId,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO measurement_bridge_messages
        (message_id, payload_sha256, message_kind, org_id, installation_id, subject_token,
         observed_at, result, received_at)
       VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, 'applied', ?5)`
    ).bind(base.messageId, payloadHash, base.messageKind, base.observedAt, at),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: null,
      actorType: "system",
      actorId: "r0-measurement-bridge",
      action: "measurement.r0_boundary.initialized",
      resourceType: "measurement_boundary",
      resourceId: "r0",
      metadata: {
        release_version: config.releaseVersion,
        release_commit_sha: config.releaseCommitSha,
        release_channel: config.releaseChannel
      },
      at
    })
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "r0_boundary_concurrent_conflict", "R0 boundary was initialized concurrently.");
  }
  return jsonResponse({ accepted: true, boundary_initialized: true, boundary_id: "r0" }, 201);
}

function validClassificationPair(classification: Classification, basis: ClassificationBasis): boolean {
  return (
    (classification === "external" && basis === "provider_confirmed_non_operator") ||
    (classification === "internal" && basis === "operator_identity_registry") ||
    (classification === "demo" && basis === "demo_registry") ||
    (classification === "test" && basis === "test_environment_registry")
  );
}

async function attestSubject(
  env: Env,
  base: BridgeBase,
  body: Record<string, unknown>,
  payloadHash: string
): Promise<Response> {
  assertExactKeys(body, [
    "schema_version",
    "message_id",
    "message_kind",
    "observed_at",
    "installation_id",
    "classification",
    "classification_basis"
  ]);
  const boundary = await requireBoundary(env);
  const installationId = requireInteger(body.installation_id, "installation_id", { min: 1 });
  const classification = requireEnum(body.classification, "classification", ["external", "internal", "demo", "test"] as const);
  const classificationBasis = requireEnum(body.classification_basis, "classification_basis", [
    "provider_confirmed_non_operator",
    "operator_identity_registry",
    "demo_registry",
    "test_environment_registry"
  ] as const);
  if (!validClassificationPair(classification, classificationBasis)) {
    throw new ApiError(400, "classification_basis_mismatch", "Classification and server-side basis do not match.");
  }
  const installation = await activeInstallation(env, installationId);
  if (installation.app_id !== boundary.github_app_id) {
    throw new ApiError(409, "measurement_app_mismatch", "Installation belongs to a different GitHub App.");
  }
  const subjectToken = await stableSubjectToken(env, installationId, installation.org_id);
  const collision = await env.TEAM_CONTROL_DB.prepare(
    `SELECT subject_token, org_id, installation_id FROM measurement_subjects
      WHERE subject_token = ?1 OR org_id = ?2 OR installation_id = ?3 LIMIT 1`
  )
    .bind(subjectToken, installation.org_id, installationId)
    .first<{ subject_token: string; org_id: string; installation_id: number }>();
  if (
    collision &&
    (collision.subject_token !== subjectToken ||
      collision.org_id !== installation.org_id ||
      collision.installation_id !== installationId)
  ) {
    throw new ApiError(409, "measurement_subject_collision", "Organization measurement identity is already bound.");
  }
  const at = nowIso();
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO measurement_subjects
        (subject_token, org_id, installation_id, classification, classification_basis,
         first_attested_at, classification_attested_at, eligible_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL, ?7)
       ON CONFLICT(subject_token) DO UPDATE SET
         classification = excluded.classification,
         classification_basis = excluded.classification_basis,
         classification_attested_at = excluded.classification_attested_at,
         updated_at = excluded.updated_at
       WHERE measurement_subjects.org_id = excluded.org_id
         AND measurement_subjects.installation_id = excluded.installation_id`
    ).bind(
      subjectToken,
      installation.org_id,
      installationId,
      classification,
      classificationBasis,
      base.observedAt,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO measurement_bridge_messages
        (message_id, payload_sha256, message_kind, org_id, installation_id, subject_token,
         observed_at, result, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'applied', ?8)`
    ).bind(
      base.messageId,
      payloadHash,
      base.messageKind,
      installation.org_id,
      installationId,
      subjectToken,
      base.observedAt,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO measurement_subject_attestations
        (message_id, subject_token, classification, classification_basis, observed_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(base.messageId, subjectToken, classification, classificationBasis, base.observedAt),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: installation.org_id,
      actorType: "system",
      actorId: "r0-measurement-identity-bridge",
      action: "measurement.organization.classified",
      resourceType: "measurement_subject",
      resourceId: subjectToken,
      metadata: { classification, classification_basis: classificationBasis },
      at
    })
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "measurement_subject_concurrent_conflict", "Measurement subject changed concurrently.");
  }
  await refreshEligibility(env.TEAM_CONTROL_DB, installation.org_id, at);
  const subject = await env.TEAM_CONTROL_DB.prepare(
    `SELECT eligible_at FROM measurement_subjects WHERE subject_token = ?1`
  )
    .bind(subjectToken)
    .first<{ eligible_at: string | null }>();
  return jsonResponse(
    {
      accepted: true,
      subject_token: subjectToken,
      classification,
      gate_eligible_now: Boolean(subject?.eligible_at) && classification === "external"
    },
    201
  );
}

async function loadEligibleSubject(env: Env, installationId: number, observedAt: string): Promise<EligibleSubject> {
  const subject = await env.TEAM_CONTROL_DB.prepare(
    `SELECT s.subject_token, s.org_id, s.installation_id, s.eligible_at
       FROM measurement_subjects s
       JOIN measurement_consents c ON c.org_id = s.org_id AND c.opted_in = 1
       JOIN organizations o ON o.id = s.org_id AND o.status = 'active'
       JOIN github_installations i
         ON i.installation_id = s.installation_id AND i.org_id = s.org_id
       JOIN measurement_boundaries b ON b.boundary_id = 'r0'
      WHERE s.installation_id = ?1
        AND s.classification = 'external'
        AND s.eligible_at IS NOT NULL
        AND i.state = 'active'
        AND i.reconciled_at IS NOT NULL
        AND i.app_id = b.github_app_id
        AND i.installed_at >= b.r0_started_at`
  )
    .bind(installationId)
    .first<EligibleSubject>();
  if (!subject || observedAt < subject.eligible_at) {
    throw new ApiError(
      409,
      "organization_not_measurement_eligible",
      "Organization must be opted in, externally attested, and bound to an active reconciled post-R0 installation."
    );
  }
  return subject;
}

async function organizationIsPql(db: D1Database, subjectToken: string): Promise<boolean> {
  const row = await db
    .prepare(
      `WITH first_activation AS (
         SELECT MIN(occurred_at) AS first_at
           FROM measurement_events
          WHERE subject_token = ?1 AND event_name = 'organization_activation_v1'
       )
       SELECT 1 AS qualified
         FROM measurement_events e, first_activation f
        WHERE e.subject_token = ?1
          AND e.event_name = 'organization_activation_v1'
          AND f.first_at IS NOT NULL
          AND e.event_day <> substr(f.first_at, 1, 10)
          AND julianday(e.occurred_at) > julianday(f.first_at)
          AND julianday(e.occurred_at) <= julianday(f.first_at, '+30 days')
        LIMIT 1`
    )
    .bind(subjectToken)
    .first<{ qualified: number }>();
  return row?.qualified === 1;
}

async function recordOrganizationEvent(
  env: Env,
  base: BridgeBase,
  body: Record<string, unknown>,
  payloadHash: string
): Promise<Response> {
  assertExactKeys(body, ["schema_version", "message_id", "message_kind", "observed_at", "installation_id"]);
  const boundary = await requireBoundary(env);
  const installationId = requireInteger(body.installation_id, "installation_id", { min: 1 });
  const subject = await loadEligibleSubject(env, installationId, base.observedAt);
  if (base.messageKind === "team_offer_presented_v1" && !(await organizationIsPql(env.TEAM_CONTROL_DB, subject.subject_token))) {
    throw new ApiError(409, "pql_qualification_required", "A server-derived PQL qualification is required before offer evidence.");
  }
  const eventDay = base.observedAt.slice(0, 10);
  const at = nowIso();
  const action =
    base.messageKind === "organization_activation_v1"
      ? "measurement.organization.activation_recorded"
      : "measurement.organization.offer_presented";
  const metadata = {
    release_version: boundary.release_version,
    release_commit_sha: boundary.release_commit_sha,
    release_channel: boundary.release_channel,
    ...(base.messageKind === "team_offer_presented_v1"
      ? { offer_contract_id: TEAM_OFFER_CONTRACT_ID }
      : {})
  };
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO measurement_bridge_messages
        (message_id, payload_sha256, message_kind, org_id, installation_id, subject_token,
         observed_at, result, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'applied', ?8)`
    ).bind(
      base.messageId,
      payloadHash,
      base.messageKind,
      subject.org_id,
      installationId,
      subject.subject_token,
      base.observedAt,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO measurement_events
        (event_id, subject_token, org_id, event_name, event_day, occurred_at,
         release_version, release_commit_sha, release_channel, offer_contract_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(subject_token, event_name, event_day) DO NOTHING`
    ).bind(
      base.messageId,
      subject.subject_token,
      subject.org_id,
      base.messageKind,
      eventDay,
      base.observedAt,
      boundary.release_version,
      boundary.release_commit_sha,
      boundary.release_channel,
      base.messageKind === "team_offer_presented_v1" ? TEAM_OFFER_CONTRACT_ID : null
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE measurement_bridge_messages SET result = 'ignored_duplicate_day'
        WHERE message_id = ?1
          AND NOT EXISTS (SELECT 1 FROM measurement_events WHERE event_id = ?1)`
    ).bind(base.messageId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'system', 'r0-measurement-activation-bridge', ?3,
              'measurement_event', ?4, ?5, ?6
        WHERE EXISTS (SELECT 1 FROM measurement_events WHERE event_id = ?4)`
    ).bind(newId("audit"), subject.org_id, action, base.messageId, JSON.stringify(metadata), at)
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "measurement_event_concurrent_conflict", "Measurement event changed concurrently.");
  }
  if ((results[1]?.meta.changes ?? 0) === 0) {
    return jsonResponse({ accepted: true, counted: false, result: "ignored_duplicate_day" }, 202);
  }
  return jsonResponse({ accepted: true, counted: true, event_name: base.messageKind }, 201);
}

export async function handleMeasurementBridge(request: Request, env: Env): Promise<Response> {
  requireEnabled(env);
  const rawBody = await readBoundedText(request, BODY_LIMIT);
  const body = parseJsonObject(rawBody);
  const messageKind = requireEnum(body.message_kind, "message_kind", [
    "r0_boundary_v1",
    "organization_subject_attestation_v1",
    "organization_activation_v1",
    "team_offer_presented_v1"
  ] as const);
  const signingSecret =
    messageKind === "r0_boundary_v1"
      ? env.R0_MEASUREMENT_CONTROL_HMAC_SECRET
      : messageKind === "organization_subject_attestation_v1"
        ? env.R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET
        : env.R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET;
  await verifyBridgeSignature(request, rawBody, signingSecret);
  const base = parseBase(body);
  const payloadHash = await sha256Hex(rawBody);
  const prior = await existingMessage(env.TEAM_CONTROL_DB, base.messageId);
  if (prior) return duplicateResponse(prior, payloadHash, base.messageKind);
  if (base.messageKind === "r0_boundary_v1") {
    return initializeBoundary(env, base, body, payloadHash);
  }
  if (base.messageKind === "organization_subject_attestation_v1") {
    return attestSubject(env, base, body, payloadHash);
  }
  return recordOrganizationEvent(env, base, body, payloadHash);
}

export async function putMeasurementConsent(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireEnabled(env);
  requireRole(auth, ["owner"]);
  if (auth.identityKind !== "human") {
    throw new ApiError(403, "human_owner_required", "Only a human organization owner can change measurement consent.");
  }
  const body = await readJsonObject(request);
  assertExactKeys(body, ["schema_version", "opted_in"]);
  if (body.schema_version !== "r0-measurement-consent-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be r0-measurement-consent-v1.");
  }
  const optedIn = requireBoolean(body.opted_in, "opted_in");
  const at = nowIso();
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO measurement_consents
        (org_id, opted_in, updated_by, opted_in_at, opted_out_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(org_id) DO UPDATE SET
         opted_in = excluded.opted_in,
         updated_by = excluded.updated_by,
         opted_in_at = CASE
           WHEN excluded.opted_in = 1 THEN COALESCE(measurement_consents.opted_in_at, excluded.opted_in_at)
           ELSE measurement_consents.opted_in_at
         END,
         opted_out_at = excluded.opted_out_at,
         updated_at = excluded.updated_at`
    ).bind(auth.orgId, optedIn ? 1 : 0, auth.userId, optedIn ? at : null, optedIn ? null : at, at),
    userAudit(
      env.TEAM_CONTROL_DB,
      auth,
      optedIn ? "measurement.consent.opted_in" : "measurement.consent.opted_out",
      "measurement_consent",
      auth.orgId,
      at
    )
  ]);
  if (optedIn && (await loadBoundary(env.TEAM_CONTROL_DB))) {
    await refreshEligibility(env.TEAM_CONTROL_DB, auth.orgId, at);
  }
  return jsonResponse({ schema_version: "r0-measurement-consent-v1", opted_in: optedIn, updated_at: at });
}

export async function getOrganizationMeasurement(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "admin"]);
  const [consent, subject, events] = await Promise.all([
    env.TEAM_CONTROL_DB.prepare(
      `SELECT opted_in, opted_in_at, opted_out_at, updated_at
         FROM measurement_consents WHERE org_id = ?1`
    )
      .bind(auth.orgId)
      .first<Record<string, unknown>>(),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT subject_token, classification, classification_basis,
              first_attested_at, classification_attested_at, eligible_at
         FROM measurement_subjects WHERE org_id = ?1`
    )
      .bind(auth.orgId)
      .first<Record<string, unknown>>(),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT event_name, COUNT(*) AS event_count, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
         FROM measurement_events WHERE org_id = ?1 GROUP BY event_name ORDER BY event_name`
    )
      .bind(auth.orgId)
      .all()
  ]);
  return jsonResponse({
    schema_version: "r0-organization-measurement-state-v1",
    consent: consent ? { ...consent, opted_in: Number(consent.opted_in) === 1 } : null,
    subject,
    event_summary: events.results,
    stores_repository_or_account_names: false,
    individual_measurement_status: "UNMEASURABLE"
  });
}

interface AggregateRow {
  eligible_installations: number;
  currently_active_installations: number;
  activated_organizations: number;
  matured_activated_organizations: number;
  repeated_organizations: number;
  pql_organizations: number;
  pql_offered_organizations: number;
  matured_pql_offered_organizations: number;
}

async function aggregateOrganizationMetrics(db: D1Database, at: string): Promise<AggregateRow> {
  const row = await db
    .prepare(
      `WITH eligible AS (
         SELECT s.subject_token, s.installation_id
           FROM measurement_subjects s
           JOIN measurement_consents c ON c.org_id = s.org_id AND c.opted_in = 1
          WHERE s.classification = 'external' AND s.eligible_at IS NOT NULL
       ),
       first_activation AS (
         SELECT e.subject_token, MIN(e.occurred_at) AS first_at
           FROM measurement_events e
           JOIN eligible x ON x.subject_token = e.subject_token
          WHERE e.event_name = 'organization_activation_v1'
          GROUP BY e.subject_token
       ),
       repeated AS (
         SELECT DISTINCT f.subject_token
           FROM first_activation f
           JOIN measurement_events e ON e.subject_token = f.subject_token
          WHERE e.event_name = 'organization_activation_v1'
            AND e.event_day <> substr(f.first_at, 1, 10)
            AND julianday(e.occurred_at) > julianday(f.first_at)
            AND julianday(e.occurred_at) <= julianday(f.first_at, '+60 days')
       ),
       pql AS (
         SELECT f.subject_token, MIN(e.occurred_at) AS pql_at
           FROM first_activation f
           JOIN measurement_events e ON e.subject_token = f.subject_token
          WHERE e.event_name = 'organization_activation_v1'
            AND e.event_day <> substr(f.first_at, 1, 10)
            AND julianday(e.occurred_at) > julianday(f.first_at)
            AND julianday(e.occurred_at) <= julianday(f.first_at, '+30 days')
          GROUP BY f.subject_token
       ),
       offered AS (
         SELECT p.subject_token, p.pql_at, MIN(e.occurred_at) AS offered_at
           FROM pql p
           JOIN measurement_events e ON e.subject_token = p.subject_token
          WHERE e.event_name = 'team_offer_presented_v1'
            AND julianday(e.occurred_at) >= julianday(p.pql_at)
          GROUP BY p.subject_token, p.pql_at
       )
       SELECT
         (SELECT COUNT(*) FROM eligible) AS eligible_installations,
         (SELECT COUNT(*) FROM eligible x JOIN github_installations i
           ON i.installation_id = x.installation_id WHERE i.state = 'active') AS currently_active_installations,
         (SELECT COUNT(*) FROM first_activation) AS activated_organizations,
         (SELECT COUNT(*) FROM first_activation
           WHERE julianday(?1) >= julianday(first_at, '+60 days')) AS matured_activated_organizations,
         (SELECT COUNT(*) FROM repeated r JOIN first_activation f ON f.subject_token = r.subject_token
           WHERE julianday(?1) >= julianday(f.first_at, '+60 days')) AS repeated_organizations,
         (SELECT COUNT(*) FROM pql) AS pql_organizations,
         (SELECT COUNT(*) FROM offered) AS pql_offered_organizations,
         (SELECT COUNT(*) FROM offered
           WHERE julianday(?1) >= julianday(offered_at, '+30 days')) AS matured_pql_offered_organizations`
    )
    .bind(at)
    .first<AggregateRow>();
  if (!row) throw new Error("R0 measurement projection returned no row");
  return row;
}

async function exclusionCounts(db: D1Database): Promise<object> {
  const rows = await db
    .prepare(
      `SELECT classification, COUNT(*) AS subject_count
         FROM measurement_subjects GROUP BY classification ORDER BY classification`
    )
    .all<{ classification: Classification; subject_count: number }>();
  const classificationCounts = { external: 0, internal: 0, demo: 0, test: 0 };
  for (const row of rows.results) classificationCounts[row.classification] = Number(row.subject_count);
  const consent = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN c.opted_in = 1 THEN 0 ELSE 1 END) AS opted_out,
         SUM(CASE WHEN s.eligible_at IS NULL THEN 1 ELSE 0 END) AS not_eligible
       FROM measurement_subjects s
       LEFT JOIN measurement_consents c ON c.org_id = s.org_id`
    )
    .first<{ opted_out: number | null; not_eligible: number | null }>();
  return {
    attested_subjects_by_classification: classificationCounts,
    coverage_exclusions: {
      opted_out_or_never_opted_in: Number(consent?.opted_out ?? 0),
      not_yet_eligible: Number(consent?.not_eligible ?? 0)
    }
  };
}

export async function handleMeasurementReport(request: Request, env: Env): Promise<Response> {
  requireEnabled(env);
  const rawBody = await readBoundedText(request, BODY_LIMIT);
  await verifyBridgeSignature(request, rawBody, env.R0_MEASUREMENT_CONTROL_HMAC_SECRET);
  const body = parseJsonObject(rawBody);
  assertExactKeys(body, ["schema_version", "query_id", "observed_at"]);
  if (body.schema_version !== "r0-measurement-report-request-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be r0-measurement-report-request-v1.");
  }
  requireOpaqueId(body.query_id, "query_id", 128);
  const observedAt = requireIsoDate(body.observed_at, "observed_at");
  assertFresh(observedAt, "observed_at");
  const boundary = await requireBoundary(env);
  const generatedAt = nowIso();
  const [metrics, exclusions] = await Promise.all([
    aggregateOrganizationMetrics(env.TEAM_CONTROL_DB, generatedAt),
    exclusionCounts(env.TEAM_CONTROL_DB)
  ]);
  const repeatRate =
    metrics.matured_activated_organizations === 0
      ? null
      : metrics.repeated_organizations / metrics.matured_activated_organizations;
  return jsonResponse({
    schema_version: "r0-measurement-report-v1",
    generated_at: generatedAt,
    boundary: {
      release_version: boundary.release_version,
      release_commit_sha: boundary.release_commit_sha,
      release_channel: boundary.release_channel,
      deployment_environment: boundary.deployment_environment,
      release_published_at: boundary.release_published_at,
      r0_started_at: boundary.r0_started_at,
      initialized_at: boundary.initialized_at
    },
    organizations: {
      identity_status: "AUTHENTICATED_TEAM_AND_RECONCILED_GITHUB_APP",
      evidence_status: "BOUNDED_GATE_EVIDENCE",
      eligible_installations: Number(metrics.eligible_installations),
      currently_active_installations: Number(metrics.currently_active_installations),
      activated_organizations: Number(metrics.activated_organizations),
      matured_activated_organizations: Number(metrics.matured_activated_organizations),
      repeated_organizations_within_60_days: Number(metrics.repeated_organizations),
      matured_repeat_rate: repeatRate,
      pql_organizations: Number(metrics.pql_organizations),
      pql_offered_organizations: Number(metrics.pql_offered_organizations),
      matured_pql_offered_organizations: Number(metrics.matured_pql_offered_organizations),
      offer_contract: {
        id: TEAM_OFFER_CONTRACT_ID,
        monthly: { internal_price_id: "team_monthly_usd_v1", amount_usd: 299 },
        annual: { internal_price_id: "team_annual_usd_v1", amount_usd: 2990 },
        contributor_limit: 15
      },
      sample_floor_met:
        Number(metrics.matured_activated_organizations) >= 200 &&
        Number(metrics.matured_pql_offered_organizations) >= 40
    },
    individuals: {
      identity_status: "UNMEASURABLE",
      evidence_status: "HOLD",
      eligible_installations: null,
      activated_individuals: null,
      matured_repeat_rate: null,
      reason:
        "The current Team/GitHub App contract authenticates organization installations but does not bind an opted-in human identity to a personal installation."
    },
    exclusions,
    definitions: {
      activation: "One signed bridge observation per opted-in external organization and UTC day.",
      matured_repeat:
        `A second activation on another UTC day within ${REPEAT_MATURITY_DAYS} days; denominator first activated at least ${REPEAT_MATURITY_DAYS} days ago.`,
      pql: `A second activation on another UTC day within ${PQL_WINDOW_DAYS} days of first activation.`,
      matured_pql_offer:
        `A bridge-attested real offer presentation after server-derived PQL qualification, observed at least ${PQL_OFFER_MATURITY_DAYS} days ago.`
    },
    coverage_and_sybil_boundary: {
      opt_in_only: true,
      anonymous_telemetry_included: false,
      repository_or_account_names_stored: false,
      total_market_installations_covered: false,
      unique_company_identity_proven: false,
      sybil_resistant: false,
      note:
        "Counts are provider-installation identities, not proof of unique legal companies. External classification and offer presentation depend on separately authenticated bridge operations."
    }
  });
}

export async function exportOrganizationMeasurement(db: D1Database, orgId: string): Promise<object> {
  const [consent, subject, attestations, events] = await Promise.all([
    db.prepare(
      `SELECT opted_in, updated_by, opted_in_at, opted_out_at, updated_at
         FROM measurement_consents WHERE org_id = ?1`
    )
      .bind(orgId)
      .first(),
    db.prepare(
      `SELECT subject_token, classification, classification_basis, first_attested_at,
              classification_attested_at, eligible_at, updated_at
         FROM measurement_subjects WHERE org_id = ?1`
    )
      .bind(orgId)
      .first(),
    db.prepare(
      `SELECT a.message_id, a.subject_token, a.classification, a.classification_basis, a.observed_at
         FROM measurement_subject_attestations a
         JOIN measurement_subjects s ON s.subject_token = a.subject_token
        WHERE s.org_id = ?1 ORDER BY a.observed_at`
    )
      .bind(orgId)
      .all(),
    db.prepare(
      `SELECT event_id, subject_token, event_name, event_day, occurred_at,
              release_version, release_commit_sha, release_channel, offer_contract_id
         FROM measurement_events WHERE org_id = ?1 ORDER BY occurred_at`
    )
      .bind(orgId)
      .all()
  ]);
  return {
    consent: consent ? { ...consent, opted_in: Number(consent.opted_in) === 1 } : null,
    subject,
    subject_attestations: attestations.results,
    events: events.results,
    stores_repository_or_account_names: false
  };
}
