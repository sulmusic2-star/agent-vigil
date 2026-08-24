import { hmacHex, sha256Hex, verifyHmacHex } from "./crypto.ts";
import { newId, nowIso } from "./db.ts";
import type { IndividualAuthContext } from "./individual-auth.ts";
import {
  individualMeasurementEnabled,
  individualSubjectToken,
  requireIndividualFeatureConfiguration
} from "./individual-config.ts";
import { ApiError, jsonResponse, parseJsonObject, readBoundedText } from "./http.ts";
import {
  assertExactKeys,
  requireBoolean,
  requireEnum,
  requireInteger,
  requireIsoDate,
  requireOpaqueId,
  requireSha256,
  requireString
} from "./validation.ts";

const BODY_LIMIT = 32_768;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const REPEAT_MATURITY_DAYS = 60;

export type IndividualClassification = "external" | "internal" | "demo" | "test";
type IndividualClassificationBasis =
  | "provider_session_and_non_operator_registry"
  | "operator_identity_registry"
  | "demo_registry"
  | "test_environment_registry";
export type IndividualMessageKind =
  | "individual_subject_attestation_v1"
  | "individual_auth_subject_rotation_v1"
  | "individual_identity_merge_v1"
  | "individual_activation_v1";

export interface IndividualIdentityRow {
  subject_token: string;
  canonical_subject_token: string;
  github_account_node_id: string;
  auth_subject_sha256: string;
  token_key_id: string;
  classification: IndividualClassification | null;
  classification_basis: IndividualClassificationBasis | null;
  first_authenticated_at: string;
  classification_attested_at: string | null;
  auth_subject_rotated_at: string | null;
  eligible_at: string | null;
  status: "active" | "merged";
  merged_at: string | null;
  updated_at: string;
}

interface BoundaryRow {
  release_version: string;
  release_commit_sha: string;
  release_channel: "github_app";
  deployment_environment: "production";
  release_published_at: string;
  r0_started_at: string;
  github_app_id: number;
  initialized_at: string;
}

interface IndividualMessageRow {
  payload_sha256: string;
  message_kind: string;
  result: "applied" | "ignored_duplicate_day";
  lane: "individual" | "organization";
}

interface IndividualBridgeBase {
  messageId: string;
  messageKind: IndividualMessageKind;
  observedAt: string;
}

interface EligibleIndividual {
  subject_token: string;
  installation_id: number;
  eligible_at: string;
}

function requireNodeId(value: unknown, field: string): string {
  return requireString(value, field, {
    min: 8,
    max: 128,
    pattern: /^[A-Za-z0-9_-]{8,128}={0,2}$/u
  });
}

function assertFresh(timestamp: string, field: string): void {
  if (Math.abs(Date.now() - Date.parse(timestamp)) > SIGNATURE_TOLERANCE_SECONDS * 1000) {
    throw new ApiError(400, "stale_individual_measurement_observation", `${field} is outside its allowed observation window.`);
  }
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

export async function verifyIndividualBridgeSignature(
  request: Request,
  rawBody: string,
  secret: string
): Promise<void> {
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

function parseBase(body: Record<string, unknown>): IndividualBridgeBase {
  if (body.schema_version !== "r0-measurement-bridge-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be r0-measurement-bridge-v1.");
  }
  const messageKind = requireEnum(body.message_kind, "message_kind", [
    "individual_subject_attestation_v1",
    "individual_auth_subject_rotation_v1",
    "individual_identity_merge_v1",
    "individual_activation_v1"
  ] as const);
  const observedAt = requireIsoDate(body.observed_at, "observed_at");
  assertFresh(observedAt, "observed_at");
  return {
    messageId: requireOpaqueId(body.message_id, "message_id", 128),
    messageKind,
    observedAt
  };
}

async function loadMessage(db: D1Database, messageId: string): Promise<IndividualMessageRow | null> {
  return db
    .prepare(
      `SELECT payload_sha256, message_kind, result, 'individual' AS lane
         FROM individual_measurement_bridge_messages WHERE message_id = ?1
       UNION ALL
       SELECT payload_sha256, message_kind, result, 'organization' AS lane
         FROM measurement_bridge_messages WHERE message_id = ?1
       LIMIT 1`
    )
    .bind(messageId)
    .first<IndividualMessageRow>();
}

function duplicateResponse(
  existing: IndividualMessageRow,
  payloadHash: string,
  kind: IndividualMessageKind
): Response {
  if (existing.lane !== "individual") {
    throw new ApiError(409, "measurement_message_lane_mismatch", "Message identifier is already bound to another measurement lane.");
  }
  if (existing.payload_sha256 !== payloadHash) {
    throw new ApiError(409, "measurement_message_replay_mismatch", "Message identifier was reused with different bytes.");
  }
  if (existing.message_kind !== kind) {
    throw new ApiError(409, "measurement_message_kind_mismatch", "Message kind changed during replay.");
  }
  return jsonResponse({
    accepted: true,
    duplicate: true,
    counted: existing.result === "applied",
    result: existing.result
  });
}

async function requireBoundary(env: Env): Promise<BoundaryRow> {
  const boundary = await env.TEAM_CONTROL_DB.prepare(
    `SELECT release_version, release_commit_sha, release_channel, deployment_environment,
            release_published_at, r0_started_at, github_app_id, initialized_at
       FROM measurement_boundaries WHERE boundary_id = 'r0'`
  ).first<BoundaryRow>();
  const appId = Number(env.GITHUB_APP_ID);
  if (!boundary) {
    throw new ApiError(409, "r0_boundary_not_initialized", "The immutable R0 boundary must be initialized first.");
  }
  if (
    boundary.release_version !== env.R0_MEASUREMENT_RELEASE_VERSION ||
    boundary.release_commit_sha !== env.R0_MEASUREMENT_RELEASE_COMMIT_SHA ||
    boundary.release_channel !== "github_app" ||
    boundary.deployment_environment !== "production" ||
    boundary.release_published_at !== env.R0_MEASUREMENT_RELEASE_PUBLISHED_AT ||
    boundary.r0_started_at !== env.R0_MEASUREMENT_STARTED_AT ||
    !Number.isSafeInteger(appId) ||
    appId <= 0 ||
    boundary.github_app_id !== appId
  ) {
    throw new ApiError(503, "r0_boundary_config_drift", "Persisted R0 boundary does not match deployment configuration.");
  }
  return boundary;
}

function individualAuditStatement(
  db: D1Database,
  input: {
    id?: string;
    subjectToken: string;
    actorType: "human_session" | "identity_bridge" | "activity_bridge" | "github_app" | "system";
    actorSessionSha256?: string;
    action: string;
    resourceType: string;
    metadata?: object;
    at: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO individual_audit_events
        (id, subject_token, actor_type, actor_session_sha256, action, resource_type, metadata_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      input.id ?? newId("individual_audit"),
      input.subjectToken,
      input.actorType,
      input.actorSessionSha256 ?? null,
      input.action,
      input.resourceType,
      JSON.stringify(input.metadata ?? {}),
      input.at
    );
}

export async function loadIndividualIdentity(
  env: Env,
  auth: IndividualAuthContext,
  allowCreate: boolean
): Promise<IndividualIdentityRow> {
  const config = requireIndividualFeatureConfiguration(env);
  const token = await individualSubjectToken(env, auth.githubAccountNodeId);
  let identity = await env.TEAM_CONTROL_DB.prepare(
    `SELECT subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256,
            token_key_id, classification, classification_basis, first_authenticated_at,
            classification_attested_at, auth_subject_rotated_at, eligible_at, status, merged_at, updated_at
       FROM individual_identities
      WHERE subject_token = ?1 OR github_account_node_id = ?2 OR auth_subject_sha256 = ?3
      LIMIT 1`
  )
    .bind(token, auth.githubAccountNodeId, auth.authSubjectSha256)
    .first<IndividualIdentityRow>();
  if (!identity && allowCreate) {
    const at = nowIso();
    await env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_identities
        (subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256,
         token_key_id, classification, classification_basis, first_authenticated_at,
         classification_attested_at, auth_subject_rotated_at, eligible_at, status, merged_at, updated_at)
       VALUES (?1, ?1, ?2, ?3, ?4, NULL, NULL, ?5, NULL, NULL, NULL, 'active', NULL, ?5)
       ON CONFLICT DO NOTHING`
    )
      .bind(token, auth.githubAccountNodeId, auth.authSubjectSha256, config.identityKeyId, at)
      .run();
    identity = await env.TEAM_CONTROL_DB.prepare(
      `SELECT subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256,
              token_key_id, classification, classification_basis, first_authenticated_at,
              classification_attested_at, auth_subject_rotated_at, eligible_at, status, merged_at, updated_at
         FROM individual_identities
        WHERE subject_token = ?1 OR github_account_node_id = ?2 OR auth_subject_sha256 = ?3
        LIMIT 1`
    )
      .bind(token, auth.githubAccountNodeId, auth.authSubjectSha256)
      .first<IndividualIdentityRow>();
  }
  if (!identity) {
    throw new ApiError(409, "individual_identity_not_bound", "The authenticated GitHub identity has not opted in.");
  }
  if (
    identity.subject_token !== token ||
    identity.github_account_node_id !== auth.githubAccountNodeId ||
    identity.auth_subject_sha256 !== auth.authSubjectSha256
  ) {
    throw new ApiError(409, "individual_identity_collision", "The authenticated GitHub identity conflicts with an existing binding.");
  }
  if (identity.status !== "active" || identity.canonical_subject_token !== identity.subject_token) {
    throw new ApiError(409, "individual_identity_merged", "This identity was merged and cannot accept new activity.");
  }
  return identity;
}

async function existingMutation(
  db: D1Database,
  sessionSha256: string,
  action: string
): Promise<{ request_sha256: string; subject_token: string } | null> {
  return db
    .prepare(
      `SELECT request_sha256, subject_token FROM individual_session_mutations
        WHERE session_sha256 = ?1 AND action = ?2`
    )
    .bind(sessionSha256, action)
    .first<{ request_sha256: string; subject_token: string }>();
}

function assertMutationReplay(
  existing: { request_sha256: string; subject_token: string } | null,
  requestHash: string,
  subjectToken: string
): boolean {
  if (!existing) return false;
  if (existing.request_sha256 !== requestHash || existing.subject_token !== subjectToken) {
    throw new ApiError(409, "individual_session_replay_mismatch", "A session mutation was replayed with different bytes or identity.");
  }
  return true;
}

export function individualEligibilityUpdateStatement(
  db: D1Database,
  subjectToken: string,
  at: string
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE individual_identities
          SET eligible_at = ?1, updated_at = ?1
        WHERE subject_token = ?2
          AND canonical_subject_token = subject_token
          AND status = 'active'
          AND classification = 'external'
          AND eligible_at IS NULL
          AND EXISTS (
            SELECT 1 FROM individual_consents c
             WHERE c.subject_token = ?2 AND c.opted_in = 1
          )
          AND EXISTS (
            SELECT 1
              FROM github_personal_installations i
              JOIN measurement_boundaries b ON b.boundary_id = 'r0'
             WHERE i.subject_token = ?2
               AND i.account_type = 'User'
               AND i.state = 'active'
               AND i.reconciled_at IS NOT NULL
               AND i.app_id = b.github_app_id
               AND i.installed_at >= b.r0_started_at
               AND i.installed_at <= ?1
               AND i.reconciled_at <= ?1
               AND b.r0_started_at <= ?1
          )`
    )
    .bind(at, subjectToken);
}

export function individualEligibilityReceiptStatement(
  db: D1Database,
  input: {
    id: string;
    workflowType:
      | "individual_eligibility_after_consent"
      | "individual_eligibility_after_attestation"
      | "individual_eligibility_after_github_reconciliation";
    sourceRef: string;
    subjectToken: string;
    at: string;
    expectedOptedIn?: boolean;
    classification?: IndividualClassification;
    classificationBasis?: IndividualClassificationBasis;
    observedAt?: string;
    installationId?: number;
    incarnation?: number;
    sourceDeliveryId?: string;
    auditId: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, ?2, ?4 || ':' || ?3,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM individual_identities identity
              WHERE identity.subject_token = ?4
                AND identity.canonical_subject_token = identity.subject_token
                AND identity.status = 'active'
           )
           AND (
             (?2 = 'individual_eligibility_after_consent' AND EXISTS (
               SELECT 1
                 FROM individual_session_mutations mutation
                 JOIN individual_consents consent ON consent.subject_token = mutation.subject_token
                WHERE mutation.session_sha256 = ?3 AND mutation.action = 'measurement_consent'
                  AND mutation.subject_token = ?4 AND mutation.result = 'applied'
                  AND mutation.applied_at = ?5
                  AND consent.updated_session_sha256 = ?3 AND consent.updated_at = ?5
                  AND consent.opted_in = ?6
                  AND (
                    (?6 = 1 AND consent.opted_in_at IS NOT NULL
                      AND consent.opted_in_at <= ?5 AND consent.opted_out_at IS NULL) OR
                    (?6 = 0 AND consent.opted_out_at = ?5)
                  )
                  AND EXISTS (
                    SELECT 1 FROM individual_audit_events audit
                     WHERE audit.id = ?13
                       AND audit.subject_token = ?4 AND audit.actor_type = 'human_session'
                       AND audit.actor_session_sha256 = ?3
                       AND audit.action = CASE WHEN ?6 = 1
                         THEN 'measurement.individual.consent_opted_in'
                         ELSE 'measurement.individual.consent_opted_out' END
                       AND audit.resource_type = 'individual_measurement_consent'
                       AND audit.created_at = ?5
                  )
             )) OR
             (?2 = 'individual_eligibility_after_attestation' AND EXISTS (
               SELECT 1
                 FROM individual_measurement_bridge_messages message
                 JOIN individual_subject_attestations attestation
                   ON attestation.message_id = message.message_id
                 JOIN individual_identities identity
                   ON identity.subject_token = attestation.subject_token
                WHERE message.message_id = ?3
                  AND message.message_kind = 'individual_subject_attestation_v1'
                  AND message.subject_token = ?4 AND message.observed_at = ?9
                  AND message.result = 'applied' AND message.received_at = ?5
                  AND attestation.subject_token = ?4
                  AND attestation.classification = ?7
                  AND attestation.classification_basis = ?8
                  AND attestation.observed_at = ?9
                  AND identity.subject_token = ?4
                  AND identity.canonical_subject_token = identity.subject_token
                  AND identity.status = 'active'
                  AND identity.classification = ?7
                  AND identity.classification_basis = ?8
                  AND identity.classification_attested_at = ?9
                  AND identity.updated_at = ?5
                  AND EXISTS (
                    SELECT 1 FROM individual_audit_events audit
                     WHERE audit.id = ?13
                       AND audit.subject_token = ?4 AND audit.actor_type = 'identity_bridge'
                       AND audit.action = 'measurement.individual.classified'
                       AND audit.resource_type = 'individual_measurement_subject'
                       AND audit.created_at = ?5
                  )
             )) OR
             (?2 = 'individual_eligibility_after_github_reconciliation' AND EXISTS (
               SELECT 1
                 FROM github_personal_installation_reconciliations reconciliation
                 JOIN github_personal_installations installation
                   ON installation.installation_id = reconciliation.installation_id
                  AND installation.incarnation = reconciliation.incarnation
                 JOIN github_personal_deliveries delivery
                   ON delivery.delivery_id = reconciliation.source_delivery_id
                  AND delivery.installation_id = reconciliation.installation_id
                  AND delivery.incarnation = reconciliation.incarnation
                WHERE reconciliation.reconciliation_id = ?3
                  AND reconciliation.subject_token = ?4
                  AND reconciliation.source_delivery_id = ?12
                  AND reconciliation.installation_id = ?10
                  AND reconciliation.incarnation = ?11
                  AND reconciliation.account_type = 'User'
                  AND reconciliation.observed_at = ?9
                  AND reconciliation.result = 'applied'
                  AND reconciliation.applied_at = ?5
                  AND installation.subject_token = ?4
                  AND installation.account_type = 'User'
                  AND installation.state = 'active'
                  AND installation.last_delivery_id = ?12
                  AND installation.last_reconciliation_id = ?3
                  AND installation.reconciled_at = ?5
                  AND installation.updated_at = ?5
                  AND delivery.subject_token = ?4
                  AND delivery.account_type = 'User'
                  AND delivery.result = 'applied'
                  AND EXISTS (
                    SELECT 1 FROM individual_audit_events audit
                     WHERE audit.id = ?13
                       AND audit.subject_token = ?4 AND audit.actor_type = 'github_app'
                       AND audit.action = 'github.personal_installation.reconciled'
                       AND audit.resource_type = 'github_personal_installation'
                       AND audit.created_at = ?5
                  )
             ))
           )
           AND NOT EXISTS (
             SELECT 1 FROM individual_identities identity
              WHERE identity.subject_token = ?4
                AND identity.canonical_subject_token = identity.subject_token
                AND identity.status = 'active' AND identity.classification = 'external'
                AND (identity.eligible_at IS NULL OR identity.eligible_at > ?5)
                AND EXISTS (
                  SELECT 1 FROM individual_consents consent
                   WHERE consent.subject_token = ?4 AND consent.opted_in = 1
                )
                AND EXISTS (
                  SELECT 1 FROM github_personal_installations installation
                  JOIN measurement_boundaries boundary ON boundary.boundary_id = 'r0'
                   WHERE installation.subject_token = ?4
                     AND installation.account_type = 'User' AND installation.state = 'active'
                     AND installation.reconciled_at IS NOT NULL
                     AND installation.app_id = boundary.github_app_id
                     AND installation.installed_at >= boundary.r0_started_at
                     AND installation.installed_at <= ?5
                     AND installation.reconciled_at <= ?5
                     AND boundary.r0_started_at <= ?5
                )
           )
         THEN 1 ELSE 0 END, ?5)`
    )
    .bind(
      input.id,
      input.workflowType,
      input.sourceRef,
      input.subjectToken,
      input.at,
      input.expectedOptedIn === undefined ? null : input.expectedOptedIn ? 1 : 0,
      input.classification ?? null,
      input.classificationBasis ?? null,
      input.observedAt ?? null,
      input.installationId ?? null,
      input.incarnation ?? null,
      input.sourceDeliveryId ?? null,
      input.auditId
    );
}

export async function putIndividualMeasurementConsent(
  request: Request,
  env: Env,
  auth: IndividualAuthContext
): Promise<Response> {
  requireIndividualFeatureConfiguration(env);
  const rawBody = await readBoundedText(request, BODY_LIMIT);
  const body = parseJsonObject(rawBody);
  assertExactKeys(body, ["schema_version", "opted_in"]);
  if (body.schema_version !== "r0-individual-measurement-consent-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be r0-individual-measurement-consent-v1.");
  }
  const optedIn = requireBoolean(body.opted_in, "opted_in");
  const identity = await loadIndividualIdentity(env, auth, true);
  const requestHash = await sha256Hex(rawBody);
  const prior = await existingMutation(env.TEAM_CONTROL_DB, auth.sessionSha256, "measurement_consent");
  if (assertMutationReplay(prior, requestHash, identity.subject_token)) {
    return jsonResponse({
      schema_version: "r0-individual-measurement-consent-v1",
      opted_in: optedIn,
      duplicate: true
    });
  }
  const at = nowIso();
  const auditId = newId("individual_audit");
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_consents
        (subject_token, opted_in, updated_session_sha256, opted_in_at, opted_out_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(subject_token) DO UPDATE SET
         opted_in = excluded.opted_in,
         updated_session_sha256 = excluded.updated_session_sha256,
         opted_in_at = CASE
           WHEN excluded.opted_in = 1 THEN COALESCE(individual_consents.opted_in_at, excluded.opted_in_at)
           ELSE individual_consents.opted_in_at
         END,
         opted_out_at = excluded.opted_out_at,
         updated_at = excluded.updated_at`
    ).bind(identity.subject_token, optedIn ? 1 : 0, auth.sessionSha256, optedIn ? at : null, optedIn ? null : at, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_session_mutations
        (session_sha256, action, request_sha256, subject_token, result, applied_at)
       VALUES (?1, 'measurement_consent', ?2, ?3, 'applied', ?4)`
    ).bind(auth.sessionSha256, requestHash, identity.subject_token, at),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      id: auditId,
      subjectToken: identity.subject_token,
      actorType: "human_session",
      actorSessionSha256: auth.sessionSha256,
      action: optedIn ? "measurement.individual.consent_opted_in" : "measurement.individual.consent_opted_out",
      resourceType: "individual_measurement_consent",
      at
    }),
    individualEligibilityUpdateStatement(env.TEAM_CONTROL_DB, identity.subject_token, at),
    individualEligibilityReceiptStatement(env.TEAM_CONTROL_DB, {
      id: `integrity_individual_eligibility_consent_${auth.sessionSha256}`,
      workflowType: "individual_eligibility_after_consent",
      sourceRef: auth.sessionSha256,
      subjectToken: identity.subject_token,
      at,
      expectedOptedIn: optedIn,
      auditId
    })
  ]);
  if (
    results.length !== 5 ||
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[2]?.meta.changes ?? 0) !== 1 ||
    ![0, 1].includes(results[3]?.meta.changes ?? -1) ||
    (results[4]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "individual_consent_concurrent_conflict", "Individual consent changed concurrently.");
  }
  return jsonResponse({
    schema_version: "r0-individual-measurement-consent-v1",
    opted_in: optedIn,
    updated_at: at
  });
}

function validClassificationPair(
  classification: IndividualClassification,
  basis: IndividualClassificationBasis
): boolean {
  return (
    (classification === "external" && basis === "provider_session_and_non_operator_registry") ||
    (classification === "internal" && basis === "operator_identity_registry") ||
    (classification === "demo" && basis === "demo_registry") ||
    (classification === "test" && basis === "test_environment_registry")
  );
}

async function attestIndividual(
  env: Env,
  base: IndividualBridgeBase,
  body: Record<string, unknown>,
  payloadHash: string
): Promise<Response> {
  assertExactKeys(body, [
    "schema_version",
    "message_id",
    "message_kind",
    "observed_at",
    "github_account_node_id",
    "classification",
    "classification_basis"
  ]);
  await requireBoundary(env);
  const accountNodeId = requireNodeId(body.github_account_node_id, "github_account_node_id");
  const classification = requireEnum(body.classification, "classification", ["external", "internal", "demo", "test"] as const);
  const basis = requireEnum(body.classification_basis, "classification_basis", [
    "provider_session_and_non_operator_registry",
    "operator_identity_registry",
    "demo_registry",
    "test_environment_registry"
  ] as const);
  if (!validClassificationPair(classification, basis)) {
    throw new ApiError(400, "classification_basis_mismatch", "Classification and server-side basis do not match.");
  }
  const identity = await env.TEAM_CONTROL_DB.prepare(
    `SELECT subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256,
            token_key_id, classification, classification_basis, first_authenticated_at,
            classification_attested_at, auth_subject_rotated_at, eligible_at, status, merged_at, updated_at
       FROM individual_identities WHERE github_account_node_id = ?1`
  )
    .bind(accountNodeId)
    .first<IndividualIdentityRow>();
  if (!identity || identity.status !== "active") {
    throw new ApiError(409, "authenticated_individual_identity_required", "An opted-in authenticated individual identity is required.");
  }
  if (identity.classification_attested_at && base.observedAt <= identity.classification_attested_at) {
    throw new ApiError(
      409,
      base.observedAt === identity.classification_attested_at
        ? "ambiguous_individual_classification_observation"
        : "stale_individual_classification_observation",
      "Individual classification observations must be strictly chronological."
    );
  }
  const at = nowIso();
  const auditId = newId("individual_audit");
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_identities SET classification = ?1, classification_basis = ?2,
         classification_attested_at = ?3, updated_at = ?4
       WHERE subject_token = ?5 AND status = 'active'
         AND (classification_attested_at IS NULL OR classification_attested_at < ?3)`
    ).bind(classification, basis, base.observedAt, at, identity.subject_token),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_measurement_bridge_messages
        (message_id, payload_sha256, message_kind, subject_token, installation_id,
         observed_at, result, received_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'applied', ?6)`
    ).bind(base.messageId, payloadHash, base.messageKind, identity.subject_token, base.observedAt, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_subject_attestations
        (message_id, subject_token, classification, classification_basis, observed_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(base.messageId, identity.subject_token, classification, basis, base.observedAt),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      id: auditId,
      subjectToken: identity.subject_token,
      actorType: "identity_bridge",
      action: "measurement.individual.classified",
      resourceType: "individual_measurement_subject",
      metadata: { classification, classification_basis: basis },
      at
    }),
    individualEligibilityUpdateStatement(env.TEAM_CONTROL_DB, identity.subject_token, at),
    individualEligibilityReceiptStatement(env.TEAM_CONTROL_DB, {
      id: `integrity_individual_eligibility_attestation_${base.messageId}`,
      workflowType: "individual_eligibility_after_attestation",
      sourceRef: base.messageId,
      subjectToken: identity.subject_token,
      at,
      classification,
      classificationBasis: basis,
      observedAt: base.observedAt,
      auditId
    })
  ]);
  if (
    results.length !== 6 ||
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[2]?.meta.changes ?? 0) !== 1 ||
    (results[3]?.meta.changes ?? 0) !== 1 ||
    ![0, 1].includes(results[4]?.meta.changes ?? -1) ||
    (results[5]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "individual_subject_concurrent_conflict", "Individual subject changed concurrently.");
  }
  const refreshed = await env.TEAM_CONTROL_DB.prepare(
    `SELECT eligible_at FROM individual_identities WHERE subject_token = ?1`
  )
    .bind(identity.subject_token)
    .first<{ eligible_at: string | null }>();
  return jsonResponse(
    {
      accepted: true,
      subject_token: identity.subject_token,
      classification,
      gate_eligible_now: classification === "external" && Boolean(refreshed?.eligible_at)
    },
    201
  );
}

async function rotateAuthSubject(
  env: Env,
  base: IndividualBridgeBase,
  body: Record<string, unknown>,
  payloadHash: string
): Promise<Response> {
  assertExactKeys(body, [
    "schema_version",
    "message_id",
    "message_kind",
    "observed_at",
    "github_account_node_id",
    "prior_auth_subject_sha256",
    "new_auth_subject_sha256"
  ]);
  await requireBoundary(env);
  const accountNodeId = requireNodeId(body.github_account_node_id, "github_account_node_id");
  const priorHash = requireSha256(body.prior_auth_subject_sha256, "prior_auth_subject_sha256");
  const newHash = requireSha256(body.new_auth_subject_sha256, "new_auth_subject_sha256");
  if (priorHash === newHash) {
    throw new ApiError(400, "individual_auth_rotation_noop", "Authentication subject rotation must change the subject.");
  }
  const identity = await env.TEAM_CONTROL_DB.prepare(
    `SELECT subject_token, auth_subject_sha256, auth_subject_rotated_at, first_authenticated_at, status
       FROM individual_identities WHERE github_account_node_id = ?1`
  )
    .bind(accountNodeId)
    .first<{
      subject_token: string;
      auth_subject_sha256: string;
      auth_subject_rotated_at: string | null;
      first_authenticated_at: string;
      status: string;
    }>();
  if (!identity || identity.status !== "active" || identity.auth_subject_sha256 !== priorHash) {
    throw new ApiError(409, "individual_auth_rotation_mismatch", "Authentication subject rotation does not match active identity state.");
  }
  const lastRotation = identity.auth_subject_rotated_at ?? identity.first_authenticated_at;
  if (base.observedAt <= lastRotation) {
    throw new ApiError(409, "stale_individual_auth_rotation", "Authentication subject rotations must be strictly chronological.");
  }
  const collision = await env.TEAM_CONTROL_DB.prepare(
    `SELECT subject_token FROM individual_identities WHERE auth_subject_sha256 = ?1`
  )
    .bind(newHash)
    .first<{ subject_token: string }>();
  if (collision) {
    throw new ApiError(409, "individual_auth_subject_collision", "Rotated authentication subject is already bound.");
  }
  const at = nowIso();
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_identities SET auth_subject_sha256 = ?1,
         auth_subject_rotated_at = ?2, updated_at = ?2
       WHERE subject_token = ?3 AND auth_subject_sha256 = ?4 AND status = 'active'`
    ).bind(newHash, base.observedAt, identity.subject_token, priorHash),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_measurement_bridge_messages
        (message_id, payload_sha256, message_kind, subject_token, installation_id,
         observed_at, result, received_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'applied', ?6)`
    ).bind(base.messageId, payloadHash, base.messageKind, identity.subject_token, base.observedAt, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_auth_subject_rotations
        (message_id, subject_token, prior_auth_subject_sha256, new_auth_subject_sha256, observed_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(base.messageId, identity.subject_token, priorHash, newHash, base.observedAt),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      subjectToken: identity.subject_token,
      actorType: "identity_bridge",
      action: "measurement.individual.auth_subject_rotated",
      resourceType: "individual_auth_binding",
      at
    })
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "individual_auth_rotation_concurrent_conflict", "Authentication subject changed concurrently.");
  }
  return jsonResponse({ accepted: true, rotated: true }, 201);
}

async function mergeIdentities(
  env: Env,
  base: IndividualBridgeBase,
  body: Record<string, unknown>,
  payloadHash: string
): Promise<Response> {
  assertExactKeys(body, [
    "schema_version",
    "message_id",
    "message_kind",
    "observed_at",
    "source_github_account_node_id",
    "target_github_account_node_id",
    "provider_merge_reference_sha256"
  ]);
  await requireBoundary(env);
  const sourceNode = requireNodeId(body.source_github_account_node_id, "source_github_account_node_id");
  const targetNode = requireNodeId(body.target_github_account_node_id, "target_github_account_node_id");
  const mergeReference = requireSha256(body.provider_merge_reference_sha256, "provider_merge_reference_sha256");
  if (sourceNode === targetNode) {
    throw new ApiError(400, "individual_identity_merge_noop", "Identity merge source and target must differ.");
  }
  const rows = await env.TEAM_CONTROL_DB.prepare(
    `SELECT subject_token, github_account_node_id, status, updated_at
       FROM individual_identities
      WHERE github_account_node_id IN (?1, ?2)`
  )
    .bind(sourceNode, targetNode)
    .all<{ subject_token: string; github_account_node_id: string; status: string; updated_at: string }>();
  const source = rows.results.find((row) => row.github_account_node_id === sourceNode);
  const target = rows.results.find((row) => row.github_account_node_id === targetNode);
  if (!source || !target || source.status !== "active" || target.status !== "active") {
    throw new ApiError(409, "individual_identity_merge_mismatch", "Both merge identities must exist and be active.");
  }
  const sourceCohort = await env.TEAM_CONTROL_DB.prepare(
    `SELECT subject_token, updated_at
       FROM individual_identities
      WHERE subject_token = ?1 OR canonical_subject_token = ?1
      ORDER BY subject_token`
  )
    .bind(source.subject_token)
    .all<{ subject_token: string; updated_at: string }>();
  if (
    sourceCohort.results.length < 1 ||
    sourceCohort.results.some((alias) => base.observedAt <= alias.updated_at) ||
    base.observedAt <= target.updated_at
  ) {
    throw new ApiError(409, "stale_individual_identity_merge", "Identity merges must be strictly chronological.");
  }
  const cohortJson = JSON.stringify(sourceCohort.results.map((alias) => alias.subject_token));
  const at = nowIso();
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_identities SET canonical_subject_token = ?1, status = 'merged',
         merged_at = CASE WHEN subject_token = ?2 THEN ?3 ELSE merged_at END,
         eligible_at = NULL, updated_at = ?3
       WHERE subject_token IN (SELECT value FROM json_each(?4))
         AND (
           (subject_token = ?2 AND status = 'active' AND canonical_subject_token = subject_token) OR
           (subject_token <> ?2 AND status = 'merged' AND canonical_subject_token = ?2)
         )
         AND updated_at < ?3
         AND NOT EXISTS (
           SELECT 1 FROM individual_privacy_deletion_requests
            WHERE status = 'pending' AND expires_at > ?3
              AND subject_token IN (?1, ?2)
         )
         AND (
           SELECT COUNT(*) FROM individual_identities candidate
            WHERE candidate.subject_token IN (SELECT value FROM json_each(?4))
              AND candidate.updated_at < ?3
              AND (
                (candidate.subject_token = ?2 AND candidate.status = 'active'
                  AND candidate.canonical_subject_token = candidate.subject_token) OR
                (candidate.subject_token <> ?2 AND candidate.status = 'merged'
                  AND candidate.canonical_subject_token = ?2)
              )
         ) = json_array_length(?4)
         AND EXISTS (
           SELECT 1 FROM individual_identities target
            WHERE target.subject_token = ?1 AND target.status = 'active'
              AND target.canonical_subject_token = target.subject_token
         )`
    ).bind(target.subject_token, source.subject_token, base.observedAt, cohortJson),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_consents SET opted_in = 0, opted_out_at = ?1, updated_at = ?1
       WHERE subject_token IN (SELECT value FROM json_each(?2)) AND opted_in = 1
         AND (
           SELECT COUNT(*) FROM individual_identities
            WHERE subject_token IN (SELECT value FROM json_each(?2))
              AND canonical_subject_token = ?3 AND status = 'merged' AND updated_at = ?1
         ) = json_array_length(?2)`
    ).bind(base.observedAt, cohortJson, target.subject_token),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_installations SET state = 'deleted', deleted_at = ?1,
         reconciled_at = NULL, updated_at = ?1
       WHERE subject_token IN (SELECT value FROM json_each(?2)) AND state <> 'deleted'
         AND (
           SELECT COUNT(*) FROM individual_identities
            WHERE subject_token IN (SELECT value FROM json_each(?2))
              AND canonical_subject_token = ?3 AND status = 'merged' AND updated_at = ?1
         ) = json_array_length(?2)`
    ).bind(base.observedAt, cohortJson, target.subject_token),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_installation_claims SET status = 'revoked', updated_at = ?1
       WHERE subject_token IN (SELECT value FROM json_each(?2))
         AND (
           SELECT COUNT(*) FROM individual_identities
            WHERE subject_token IN (SELECT value FROM json_each(?2))
              AND canonical_subject_token = ?3 AND status = 'merged' AND updated_at = ?1
         ) = json_array_length(?2)`
    ).bind(base.observedAt, cohortJson, target.subject_token),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_measurement_bridge_messages
        (message_id, payload_sha256, message_kind, subject_token, installation_id,
         observed_at, result, received_at)
       SELECT ?1, ?2, ?3, ?4, NULL, ?5, 'applied', ?6
        WHERE (
          SELECT COUNT(*) FROM individual_identities
           WHERE subject_token IN (SELECT value FROM json_each(?7))
             AND canonical_subject_token = ?4 AND status = 'merged' AND updated_at = ?5
        ) = json_array_length(?7)`
    ).bind(base.messageId, payloadHash, base.messageKind, target.subject_token, base.observedAt, at, cohortJson),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_identity_merges
        (message_id, source_subject_token, target_subject_token, provider_merge_reference_sha256, observed_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM individual_measurement_bridge_messages
           WHERE message_id = ?1 AND subject_token = ?3 AND observed_at = ?5
        )`
    ).bind(base.messageId, source.subject_token, target.subject_token, mergeReference, base.observedAt)
  ]);
  if (
    (results[0]?.meta.changes ?? 0) !== sourceCohort.results.length ||
    (results[4]?.meta.changes ?? 0) !== 1 ||
    (results[5]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "individual_identity_merge_concurrent_conflict", "Individual identity changed concurrently.");
  }
  await individualAuditStatement(env.TEAM_CONTROL_DB, {
    subjectToken: target.subject_token,
    actorType: "identity_bridge",
    action: "measurement.individual.identity_merged",
    resourceType: "individual_identity",
    at
  }).run();
  return jsonResponse({ accepted: true, merged: true, subject_token: target.subject_token }, 201);
}

async function eligibleIndividual(env: Env, installationId: number, observedAt: string): Promise<EligibleIndividual> {
  const subject = await env.TEAM_CONTROL_DB.prepare(
    `SELECT s.subject_token, i.installation_id, s.eligible_at
       FROM individual_identities s
       JOIN individual_consents c ON c.subject_token = s.subject_token AND c.opted_in = 1
       JOIN github_personal_installations i ON i.subject_token = s.subject_token
       JOIN measurement_boundaries b ON b.boundary_id = 'r0'
      WHERE i.installation_id = ?1
        AND s.status = 'active'
        AND s.canonical_subject_token = s.subject_token
        AND s.classification = 'external'
        AND s.eligible_at IS NOT NULL
        AND i.account_type = 'User'
        AND i.state = 'active'
        AND i.reconciled_at IS NOT NULL
        AND i.app_id = b.github_app_id
        AND i.installed_at >= b.r0_started_at`
  )
    .bind(installationId)
    .first<EligibleIndividual>();
  if (!subject || observedAt < subject.eligible_at) {
    throw new ApiError(
      409,
      "individual_not_measurement_eligible",
      "Individual must be authenticated, opted in, externally attested, and bound to an active reconciled personal installation."
    );
  }
  return subject;
}

async function recordActivation(
  env: Env,
  base: IndividualBridgeBase,
  body: Record<string, unknown>,
  payloadHash: string
): Promise<Response> {
  assertExactKeys(body, [
    "schema_version",
    "message_id",
    "message_kind",
    "observed_at",
    "installation_id",
    "verifier_release_version",
    "verifier_release_commit_sha",
    "verifier_outcome",
    "verdict",
    "receipt_sha256"
  ]);
  const boundary = await requireBoundary(env);
  const installationId = requireInteger(body.installation_id, "installation_id", { min: 1 });
  const releaseVersion = requireString(body.verifier_release_version, "verifier_release_version", {
    max: 64,
    pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
  });
  const releaseCommitSha = requireString(body.verifier_release_commit_sha, "verifier_release_commit_sha", {
    min: 40,
    max: 40,
    pattern: /^[a-f0-9]{40}$/u
  });
  requireEnum(body.verifier_outcome, "verifier_outcome", ["completed"] as const);
  const verdict = requireEnum(body.verdict, "verdict", ["SAFE", "BREAK", "INCONCLUSIVE"] as const);
  const receiptSha256 = requireSha256(body.receipt_sha256, "receipt_sha256");
  if (releaseVersion !== boundary.release_version || releaseCommitSha !== boundary.release_commit_sha) {
    throw new ApiError(409, "individual_verifier_release_mismatch", "Activity does not prove the exact immutable R0 verifier release.");
  }
  const subject = await eligibleIndividual(env, installationId, base.observedAt);
  const at = nowIso();
  const eventDay = base.observedAt.slice(0, 10);
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_measurement_bridge_messages
        (message_id, payload_sha256, message_kind, subject_token, installation_id,
         observed_at, result, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'applied', ?7)`
    ).bind(base.messageId, payloadHash, base.messageKind, subject.subject_token, installationId, base.observedAt, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_measurement_events
        (event_id, subject_token, installation_id, event_name, event_day, occurred_at,
         release_version, release_commit_sha, release_channel, verdict, receipt_sha256)
       VALUES (?1, ?2, ?3, 'individual_activation_v1', ?4, ?5, ?6, ?7, 'github_app', ?8, ?9)
       ON CONFLICT(subject_token, event_name, event_day) DO NOTHING`
    ).bind(
      base.messageId,
      subject.subject_token,
      installationId,
      eventDay,
      base.observedAt,
      boundary.release_version,
      boundary.release_commit_sha,
      verdict,
      receiptSha256
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_measurement_bridge_messages SET result = 'ignored_duplicate_day'
        WHERE message_id = ?1
          AND NOT EXISTS (SELECT 1 FROM individual_measurement_events WHERE event_id = ?1)`
    ).bind(base.messageId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_audit_events
        (id, subject_token, actor_type, actor_session_sha256, action, resource_type, metadata_json, created_at)
       SELECT ?1, ?2, 'activity_bridge', NULL, 'measurement.individual.activation_recorded',
              'individual_measurement_event', ?3, ?4
        WHERE EXISTS (SELECT 1 FROM individual_measurement_events WHERE event_id = ?5)`
    ).bind(
      newId("individual_audit"),
      subject.subject_token,
      JSON.stringify({
        release_version: boundary.release_version,
        release_commit_sha: boundary.release_commit_sha,
        verdict
      }),
      at,
      base.messageId
    )
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "individual_event_concurrent_conflict", "Individual activity changed concurrently.");
  }
  if ((results[1]?.meta.changes ?? 0) === 0) {
    return jsonResponse({ accepted: true, counted: false, result: "ignored_duplicate_day" }, 202);
  }
  return jsonResponse({ accepted: true, counted: true, event_name: base.messageKind }, 201);
}

export async function handleIndividualMeasurementBridge(
  request: Request,
  env: Env,
  rawBody: string,
  body: Record<string, unknown>
): Promise<Response> {
  requireIndividualFeatureConfiguration(env);
  const messageKind = requireEnum(body.message_kind, "message_kind", [
    "individual_subject_attestation_v1",
    "individual_auth_subject_rotation_v1",
    "individual_identity_merge_v1",
    "individual_activation_v1"
  ] as const);
  const secret =
    messageKind === "individual_activation_v1"
      ? env.R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET
      : env.R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET;
  await verifyIndividualBridgeSignature(request, rawBody, secret);
  const base = parseBase(body);
  const payloadHash = await sha256Hex(rawBody);
  const prior = await loadMessage(env.TEAM_CONTROL_DB, base.messageId);
  if (prior) return duplicateResponse(prior, payloadHash, base.messageKind);
  if (base.messageKind === "individual_subject_attestation_v1") {
    return attestIndividual(env, base, body, payloadHash);
  }
  if (base.messageKind === "individual_auth_subject_rotation_v1") {
    return rotateAuthSubject(env, base, body, payloadHash);
  }
  if (base.messageKind === "individual_identity_merge_v1") {
    return mergeIdentities(env, base, body, payloadHash);
  }
  return recordActivation(env, base, body, payloadHash);
}

export async function getIndividualMeasurement(
  env: Env,
  auth: IndividualAuthContext
): Promise<Response> {
  const identity = await loadIndividualIdentity(env, auth, false);
  const [consent, installation, events] = await Promise.all([
    env.TEAM_CONTROL_DB.prepare(
      `SELECT opted_in, opted_in_at, opted_out_at, updated_at
         FROM individual_consents WHERE subject_token = ?1`
    )
      .bind(identity.subject_token)
      .first<Record<string, unknown>>(),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT account_type, state, repository_selection, installed_at, reconciled_at, updated_at
         FROM github_personal_installations WHERE subject_token = ?1`
    )
      .bind(identity.subject_token)
      .first<Record<string, unknown>>(),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT COUNT(*) AS event_count, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
         FROM individual_measurement_events WHERE subject_token = ?1`
    )
      .bind(identity.subject_token)
      .first<Record<string, unknown>>()
  ]);
  return jsonResponse({
    schema_version: "r0-individual-measurement-state-v1",
    subject_token: identity.subject_token,
    classification: identity.classification,
    classification_basis: identity.classification_basis,
    eligible_at: identity.eligible_at,
    consent: consent ? { ...consent, opted_in: Number(consent.opted_in) === 1 } : null,
    personal_installation: installation,
    event_summary: events,
    stores_repository_or_account_names: false,
    anonymous_or_ip_inference_used: false
  });
}

interface IndividualAggregateRow {
  eligible_installations: number;
  currently_active_installations: number;
  activated_individuals: number;
  matured_activated_individuals: number;
  repeated_individuals: number;
}

async function aggregateIndividualMetrics(db: D1Database, at: string): Promise<IndividualAggregateRow> {
  const row = await db
    .prepare(
      `WITH eligible AS (
         SELECT s.subject_token, i.installation_id
           FROM individual_identities s
           JOIN individual_consents c ON c.subject_token = s.subject_token AND c.opted_in = 1
           JOIN github_personal_installations i ON i.subject_token = s.subject_token
          WHERE s.status = 'active'
            AND s.canonical_subject_token = s.subject_token
            AND s.classification = 'external'
            AND s.eligible_at IS NOT NULL
            AND i.account_type = 'User'
            AND i.state = 'active'
            AND i.reconciled_at IS NOT NULL
       ),
       canonical_events AS (
         SELECT identity.canonical_subject_token AS subject_token, e.event_day,
                MIN(e.occurred_at) AS occurred_at
           FROM individual_measurement_events e
           JOIN individual_identities identity ON identity.subject_token = e.subject_token
           JOIN eligible x ON x.subject_token = identity.canonical_subject_token
          GROUP BY identity.canonical_subject_token, e.event_day
          ORDER BY identity.canonical_subject_token, e.event_day
       ),
       first_activation AS (
         SELECT subject_token, MIN(occurred_at) AS first_at
           FROM canonical_events GROUP BY subject_token
       ),
       repeated AS (
         SELECT DISTINCT f.subject_token
           FROM first_activation f
           JOIN canonical_events e ON e.subject_token = f.subject_token
          WHERE e.event_day <> substr(f.first_at, 1, 10)
            AND julianday(e.occurred_at) > julianday(f.first_at)
            AND julianday(e.occurred_at) <= julianday(f.first_at, '+60 days')
       )
       SELECT
         (SELECT COUNT(*) FROM eligible) AS eligible_installations,
         (SELECT COUNT(*) FROM eligible) AS currently_active_installations,
         (SELECT COUNT(*) FROM first_activation) AS activated_individuals,
         (SELECT COUNT(*) FROM first_activation
           WHERE julianday(?1) >= julianday(first_at, '+60 days')) AS matured_activated_individuals,
         (SELECT COUNT(*) FROM repeated r JOIN first_activation f ON f.subject_token = r.subject_token
           WHERE julianday(?1) >= julianday(f.first_at, '+60 days')) AS repeated_individuals`
    )
    .bind(at)
    .first<IndividualAggregateRow>();
  if (!row) throw new Error("Individual R0 measurement projection returned no row");
  return row;
}

async function individualExclusions(db: D1Database): Promise<object> {
  const classification = await db
    .prepare(
      `SELECT COALESCE(classification, 'unclassified') AS classification, COUNT(*) AS subject_count
         FROM individual_identities
        WHERE status = 'active'
        GROUP BY COALESCE(classification, 'unclassified')`
    )
    .all<{ classification: IndividualClassification | "unclassified"; subject_count: number }>();
  const counts = { external: 0, internal: 0, demo: 0, test: 0, unclassified: 0 };
  for (const row of classification.results) counts[row.classification] = Number(row.subject_count);
  const coverage = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN c.opted_in = 1 THEN 0 ELSE 1 END) AS opted_out,
         SUM(CASE WHEN s.eligible_at IS NULL THEN 1 ELSE 0 END) AS not_eligible,
         SUM(CASE WHEN s.status = 'merged' THEN 1 ELSE 0 END) AS merged
       FROM individual_identities s
       LEFT JOIN individual_consents c ON c.subject_token = s.subject_token`
    )
    .first<{ opted_out: number | null; not_eligible: number | null; merged: number | null }>();
  return {
    attested_subjects_by_classification: counts,
    coverage_exclusions: {
      opted_out_or_never_opted_in: Number(coverage?.opted_out ?? 0),
      not_yet_eligible: Number(coverage?.not_eligible ?? 0),
      merged_aliases: Number(coverage?.merged ?? 0)
    }
  };
}

export async function individualReportProjection(env: Env, generatedAt: string): Promise<object> {
  if (!individualMeasurementEnabled(env)) {
    return {
      identity_status: "UNMEASURABLE",
      evidence_status: "HOLD",
      eligible_installations: null,
      currently_active_installations: null,
      activated_individuals: null,
      matured_activated_individuals: null,
      repeated_individuals_within_60_days: null,
      matured_repeat_rate: null,
      reason:
        "Individual measurement is disabled until the GitHub/OIDC session issuer and personal-installation reconciler are independently operational."
    };
  }
  requireIndividualFeatureConfiguration(env);
  await requireBoundary(env);
  const [metrics, exclusions] = await Promise.all([
    aggregateIndividualMetrics(env.TEAM_CONTROL_DB, generatedAt),
    individualExclusions(env.TEAM_CONTROL_DB)
  ]);
  const repeatRate =
    Number(metrics.matured_activated_individuals) === 0
      ? null
      : Number(metrics.repeated_individuals) / Number(metrics.matured_activated_individuals);
  return {
    identity_status: "AUTHENTICATED_GITHUB_OIDC_AND_RECONCILED_PERSONAL_APP",
    evidence_status: "BOUNDED_GATE_EVIDENCE",
    eligible_installations: Number(metrics.eligible_installations),
    currently_active_installations: Number(metrics.currently_active_installations),
    activated_individuals: Number(metrics.activated_individuals),
    matured_activated_individuals: Number(metrics.matured_activated_individuals),
    repeated_individuals_within_60_days: Number(metrics.repeated_individuals),
    matured_repeat_rate: repeatRate,
    reason: null,
    exclusions
  };
}

export async function exportIndividualMeasurement(db: D1Database, canonicalSubjectToken: string): Promise<object> {
  const [
    identities,
    consents,
    claims,
    installations,
    githubProofs,
    githubLifecycleHeads,
    githubDeliveries,
    githubReconciliations,
    githubReleaseReconciliations,
    githubIntegrityReceipts,
    eligibilityIntegrityReceipts,
    attestations,
    rotations,
    merges,
    events,
    audit
  ] =
    await Promise.all([
      db.prepare(
        `SELECT subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256,
                token_key_id, classification, classification_basis, first_authenticated_at,
                classification_attested_at, auth_subject_rotated_at, eligible_at, status, merged_at, updated_at
           FROM individual_identities
          WHERE subject_token = ?1 OR canonical_subject_token = ?1 ORDER BY first_authenticated_at`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT c.subject_token, c.opted_in, c.opted_in_at, c.opted_out_at, c.updated_at
           FROM individual_consents c
           JOIN individual_identities i ON i.subject_token = c.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT c.subject_token, c.installation_id, c.incarnation, c.account_type, c.status, c.claimed_at, c.updated_at
           FROM github_personal_installation_claims c
           JOIN individual_identities i ON i.subject_token = c.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT p.subject_token, p.installation_id, p.incarnation, p.account_type, p.state, p.repository_selection,
                p.installed_at, p.suspended_at, p.deleted_at, p.reconciled_at, p.updated_at
           FROM github_personal_installations p
           JOIN individual_identities i ON i.subject_token = p.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT delivery_id, installation_id, incarnation, github_account_node_id, account_type,
                verified_at, expires_at, consumed_at, consumed_by_lane,
                invalidated_at, invalidated_by_delivery_id
           FROM github_installation_provider_proofs
          WHERE account_type = 'User' AND (
            EXISTS (
              SELECT 1 FROM github_personal_installation_claims c
              JOIN individual_identities i ON i.subject_token = c.subject_token
               WHERE (i.subject_token = ?1 OR i.canonical_subject_token = ?1)
                 AND c.installation_id = github_installation_provider_proofs.installation_id
                 AND c.incarnation = github_installation_provider_proofs.incarnation
            ) OR EXISTS (
              SELECT 1 FROM github_personal_installations p
              JOIN individual_identities i ON i.subject_token = p.subject_token
               WHERE (i.subject_token = ?1 OR i.canonical_subject_token = ?1)
                 AND p.installation_id = github_installation_provider_proofs.installation_id
                 AND p.incarnation = github_installation_provider_proofs.incarnation
            ) OR EXISTS (
              SELECT 1 FROM github_installation_release_reconciliations r
               WHERE r.lane = 'personal' AND r.owner_ref IN (
                 SELECT subject_token FROM individual_identities
                  WHERE subject_token = ?1 OR canonical_subject_token = ?1
               ) AND r.installation_id = github_installation_provider_proofs.installation_id
                 AND r.incarnation = github_installation_provider_proofs.incarnation
                 AND r.creation_delivery_id = github_installation_provider_proofs.delivery_id
            )
          ) ORDER BY verified_at, delivery_id`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT installation_id, incarnation, github_account_node_id, account_type, creation_delivery_id,
                latest_delivery_id, latest_event_created_at, latest_action, terminal, updated_at
           FROM github_installation_lifecycle_heads
          WHERE account_type = 'User' AND (
            EXISTS (
              SELECT 1 FROM github_personal_installation_claims c
              JOIN individual_identities i ON i.subject_token = c.subject_token
               WHERE (i.subject_token = ?1 OR i.canonical_subject_token = ?1)
                 AND c.installation_id = github_installation_lifecycle_heads.installation_id
                 AND c.incarnation = github_installation_lifecycle_heads.incarnation
            ) OR EXISTS (
              SELECT 1 FROM github_personal_installations p
              JOIN individual_identities i ON i.subject_token = p.subject_token
               WHERE (i.subject_token = ?1 OR i.canonical_subject_token = ?1)
                 AND p.installation_id = github_installation_lifecycle_heads.installation_id
                 AND p.incarnation = github_installation_lifecycle_heads.incarnation
            ) OR EXISTS (
              SELECT 1 FROM github_installation_release_reconciliations r
               WHERE r.lane = 'personal' AND r.owner_ref IN (
                 SELECT subject_token FROM individual_identities
                  WHERE subject_token = ?1 OR canonical_subject_token = ?1
               ) AND r.installation_id = github_installation_lifecycle_heads.installation_id
                 AND r.incarnation = github_installation_lifecycle_heads.incarnation
            )
          ) ORDER BY latest_event_created_at, installation_id`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT delivery_id, event_name, action, installation_id, incarnation, account_type,
                event_created_at, result, received_at
           FROM github_personal_deliveries
          WHERE subject_token IN (
            SELECT subject_token FROM individual_identities
             WHERE subject_token = ?1 OR canonical_subject_token = ?1
          ) OR EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations r
             WHERE r.lane = 'personal' AND r.owner_ref IN (
               SELECT subject_token FROM individual_identities
                WHERE subject_token = ?1 OR canonical_subject_token = ?1
             ) AND r.installation_id = github_personal_deliveries.installation_id
               AND r.incarnation = github_personal_deliveries.incarnation
          ) ORDER BY event_created_at, delivery_id`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT reconciliation_id, source_delivery_id, installation_id, incarnation, account_type,
                observed_at, result, applied_at
           FROM github_personal_installation_reconciliations
          WHERE subject_token IN (
            SELECT subject_token FROM individual_identities
             WHERE subject_token = ?1 OR canonical_subject_token = ?1
          ) ORDER BY observed_at, reconciliation_id`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT reconciliation_id, source_delivery_id, creation_delivery_id, installation_id, incarnation, github_account_node_id,
                lane, owner_ref, observed_at, result, applied_at
           FROM github_installation_release_reconciliations
          WHERE lane = 'personal' AND owner_ref IN (
              SELECT subject_token FROM individual_identities
               WHERE subject_token = ?1 OR canonical_subject_token = ?1
          ) ORDER BY observed_at, reconciliation_id`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT id, workflow_type, source_ref, valid, created_at
           FROM workflow_integrity_receipts
          WHERE (
            workflow_type IN ('github_lifecycle_head_recorded', 'github_personal_lifecycle_materialized') AND source_ref IN (
              SELECT delivery_id FROM github_personal_deliveries
               WHERE subject_token IN (
                 SELECT subject_token FROM individual_identities
                  WHERE subject_token = ?1 OR canonical_subject_token = ?1
               ) OR EXISTS (
                 SELECT 1 FROM github_installation_release_reconciliations r
                  WHERE r.lane = 'personal' AND r.owner_ref IN (
                    SELECT subject_token FROM individual_identities
                     WHERE subject_token = ?1 OR canonical_subject_token = ?1
                  ) AND r.installation_id = github_personal_deliveries.installation_id
                    AND r.incarnation = github_personal_deliveries.incarnation
               )
            )
          ) OR (
            workflow_type = 'github_personal_not_found_release' AND source_ref IN (
              SELECT reconciliation_id FROM github_installation_release_reconciliations
               WHERE lane = 'personal' AND owner_ref IN (
                 SELECT subject_token FROM individual_identities
                  WHERE subject_token = ?1 OR canonical_subject_token = ?1
               )
            )
          ) ORDER BY created_at, id`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT id, workflow_type, source_ref, valid, created_at
           FROM workflow_integrity_receipts receipt
          WHERE receipt.workflow_type IN (
                  'individual_eligibility_after_consent',
                  'individual_eligibility_after_attestation',
                  'individual_eligibility_after_github_reconciliation',
                  'individual_eligibility_migration_backfill'
                )
            AND EXISTS (
              SELECT 1 FROM individual_identities identity
               WHERE (identity.subject_token = ?1 OR identity.canonical_subject_token = ?1)
                 AND substr(receipt.source_ref, 1, length(identity.subject_token) + 1) = identity.subject_token || ':'
            )
          ORDER BY created_at, id`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT a.message_id, a.subject_token, a.classification, a.classification_basis, a.observed_at
           FROM individual_subject_attestations a
           JOIN individual_identities i ON i.subject_token = a.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1 ORDER BY a.observed_at`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT r.message_id, r.subject_token, r.prior_auth_subject_sha256,
                r.new_auth_subject_sha256, r.observed_at
           FROM individual_auth_subject_rotations r
           JOIN individual_identities i ON i.subject_token = r.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1 ORDER BY r.observed_at`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT message_id, source_subject_token, target_subject_token,
                provider_merge_reference_sha256, observed_at
           FROM individual_identity_merges
          WHERE source_subject_token IN (
                  SELECT subject_token FROM individual_identities
                   WHERE subject_token = ?1 OR canonical_subject_token = ?1
                )
             OR target_subject_token IN (
                  SELECT subject_token FROM individual_identities
                   WHERE subject_token = ?1 OR canonical_subject_token = ?1
                )`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT e.event_id, e.subject_token, e.event_day, e.occurred_at, e.release_version,
                e.release_commit_sha, e.release_channel, e.verdict, e.receipt_sha256
           FROM individual_measurement_events e
           JOIN individual_identities i ON i.subject_token = e.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1 ORDER BY e.occurred_at`
      )
        .bind(canonicalSubjectToken)
        .all(),
      db.prepare(
        `SELECT a.actor_type, a.actor_session_sha256, a.action, a.resource_type,
                a.metadata_json, a.created_at
           FROM individual_audit_events a
           JOIN individual_identities i ON i.subject_token = a.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1 ORDER BY a.created_at`
      )
        .bind(canonicalSubjectToken)
        .all()
    ]);
  return {
    identities: identities.results,
    consents: consents.results.map((row) => ({ ...row, opted_in: Number(row.opted_in) === 1 })),
    personal_installation_claims: claims.results,
    personal_installations: installations.results,
    github_provider_proofs: githubProofs.results,
    github_lifecycle_heads: githubLifecycleHeads.results,
    github_deliveries: githubDeliveries.results,
    github_reconciliations: githubReconciliations.results,
    github_release_reconciliations: githubReleaseReconciliations.results,
    github_integrity_receipts: githubIntegrityReceipts.results,
    eligibility_integrity_receipts: eligibilityIntegrityReceipts.results,
    subject_attestations: attestations.results,
    auth_subject_rotations: rotations.results,
    identity_merges: merges.results,
    events: events.results,
    audit_events: audit.results,
    stores_repository_or_account_names: false,
    anonymous_or_ip_inference_used: false
  };
}

export async function requestMutationHash(request: Request): Promise<{ rawBody: string; hash: string }> {
  const rawBody = await readBoundedText(request, BODY_LIMIT);
  return { rawBody, hash: await sha256Hex(rawBody) };
}

export async function sessionMutationReplay(
  db: D1Database,
  auth: IndividualAuthContext,
  action: "installation_claim" | "deletion_request" | "deletion_confirmation",
  requestHash: string,
  subjectToken: string
): Promise<boolean> {
  return assertMutationReplay(
    await existingMutation(db, auth.sessionSha256, action),
    requestHash,
    subjectToken
  );
}

export function sessionMutationStatement(
  db: D1Database,
  auth: IndividualAuthContext,
  action: "installation_claim" | "deletion_request" | "deletion_confirmation",
  requestHash: string,
  subjectToken: string,
  at: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO individual_session_mutations
        (session_sha256, action, request_sha256, subject_token, result, applied_at)
       VALUES (?1, ?2, ?3, ?4, 'applied', ?5)`
    )
    .bind(auth.sessionSha256, action, requestHash, subjectToken, at);
}

export { individualAuditStatement };
