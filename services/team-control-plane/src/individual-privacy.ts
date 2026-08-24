import { randomOpaqueToken, sha256Hex, timingSafeHexEqual } from "./crypto.ts";
import { newId, nowIso } from "./db.ts";
import type { IndividualAuthContext } from "./individual-auth.ts";
import {
  exportIndividualMeasurement,
  individualAuditStatement,
  requestMutationHash,
  sessionMutationReplay,
  sessionMutationStatement
} from "./individual-measurement.ts";
import { ApiError, jsonResponse, parseJsonObject } from "./http.ts";
import { assertExactKeys } from "./validation.ts";

interface IndividualDeletionRequestRow {
  id: string;
  confirmation_sha256: string;
  status: string;
  expires_at: string;
}

interface PrivacyIdentityRow {
  subject_token: string;
  canonical_subject_token: string;
  github_account_node_id: string;
  auth_subject_sha256: string;
  status: "active" | "merged";
}

async function loadPrivacyIdentity(
  db: D1Database,
  auth: IndividualAuthContext
): Promise<PrivacyIdentityRow> {
  const matches = await db.prepare(
    `SELECT subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256, status
       FROM individual_identities
      WHERE github_account_node_id = ?1 OR auth_subject_sha256 = ?2`
  )
    .bind(auth.githubAccountNodeId, auth.authSubjectSha256)
    .all<PrivacyIdentityRow>();
  const identity = matches.results[0];
  if (!identity) {
    throw new ApiError(409, "individual_identity_not_bound", "The authenticated GitHub identity has not opted in.");
  }
  if (
    matches.results.length !== 1 ||
    identity.github_account_node_id !== auth.githubAccountNodeId ||
    identity.auth_subject_sha256 !== auth.authSubjectSha256
  ) {
    throw new ApiError(409, "individual_identity_collision", "The authenticated GitHub identity conflicts with an existing binding.");
  }
  const canonical = await db.prepare(
    `SELECT subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256, status
       FROM individual_identities
      WHERE subject_token = ?1
        AND canonical_subject_token = subject_token
        AND status = 'active'`
  )
    .bind(identity.canonical_subject_token)
    .first<PrivacyIdentityRow>();
  if (!canonical) {
    throw new ApiError(409, "individual_identity_chain_invalid", "The identity does not resolve to one active canonical subject.");
  }
  return { ...identity, canonical_subject_token: canonical.subject_token };
}

export async function exportIndividualData(
  env: Env,
  auth: IndividualAuthContext
): Promise<Response> {
  const identity = await loadPrivacyIdentity(env.TEAM_CONTROL_DB, auth);
  const measurement = await exportIndividualMeasurement(env.TEAM_CONTROL_DB, identity.canonical_subject_token);
  return jsonResponse({
    schema_version: "individual-privacy-export-v1",
    export_id: newId("individual_privacy_export"),
    generated_at: nowIso(),
    r0_measurement: measurement,
    retained_outside_deletion: [],
    provider_account_or_repository_names_stored: false
  });
}

export async function requestIndividualDeletion(
  request: Request,
  env: Env,
  auth: IndividualAuthContext
): Promise<Response> {
  const identity = await loadPrivacyIdentity(env.TEAM_CONTROL_DB, auth);
  const { rawBody, hash } = await requestMutationHash(request);
  const body = parseJsonObject(rawBody);
  assertExactKeys(body, ["schema_version"]);
  if (body.schema_version !== "individual-deletion-request-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be individual-deletion-request-v1.");
  }
  if (
    await sessionMutationReplay(
      env.TEAM_CONTROL_DB,
      auth,
      "deletion_request",
      hash,
      identity.subject_token
    )
  ) {
    throw new ApiError(409, "individual_deletion_request_replayed", "Deletion confirmation is only issued once per session.");
  }
  const existing = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, confirmation_sha256, status, expires_at
       FROM individual_privacy_deletion_requests
      WHERE subject_token = ?1 AND status = 'pending' AND expires_at > ?2
      ORDER BY requested_at DESC LIMIT 1`
  )
    .bind(identity.canonical_subject_token, nowIso())
    .first<IndividualDeletionRequestRow>();
  if (existing) {
    throw new ApiError(409, "individual_deletion_already_pending", "An individual deletion request is already pending.");
  }
  const confirmation = randomOpaqueToken();
  const confirmationHash = await sha256Hex(confirmation);
  const requestId = newId("individual_deletion");
  const at = nowIso();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  let results: D1Result[];
  try {
    results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_privacy_deletion_requests
        (id, subject_token, confirmation_sha256, status, requested_session_sha256,
         requested_at, expires_at)
       SELECT ?1, ?2, ?3, 'pending', ?4, ?5, ?6
        WHERE EXISTS (
          SELECT 1 FROM individual_identities anchor
          JOIN individual_identities canonical ON canonical.subject_token = ?2
         WHERE anchor.subject_token = ?7 AND anchor.canonical_subject_token = ?2
           AND canonical.status = 'active'
           AND canonical.canonical_subject_token = canonical.subject_token
        )`
    ).bind(
      requestId,
      identity.canonical_subject_token,
      confirmationHash,
      auth.sessionSha256,
      at,
      expiresAt,
      identity.subject_token
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_session_mutations
        (session_sha256, action, request_sha256, subject_token, result, applied_at)
       SELECT ?1, 'deletion_request', ?2, ?3, 'applied', ?4
        WHERE EXISTS (
          SELECT 1 FROM individual_privacy_deletion_requests
           WHERE id = ?5 AND subject_token = ?6 AND status = 'pending'
        )`
    ).bind(auth.sessionSha256, hash, identity.subject_token, at, requestId, identity.canonical_subject_token),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_audit_events
        (id, subject_token, actor_type, actor_session_sha256, action, resource_type, metadata_json, created_at)
       SELECT ?1, ?2, 'human_session', ?3, 'privacy.individual_deletion.requested',
              'individual_privacy_deletion_request', '{}', ?4
        WHERE EXISTS (
          SELECT 1 FROM individual_session_mutations
           WHERE session_sha256 = ?3 AND action = 'deletion_request'
             AND request_sha256 = ?5 AND subject_token = ?2
        )`
    ).bind(newId("individual_audit"), identity.subject_token, auth.sessionSha256, at, hash)
    ]);
  } catch (error) {
    const competing = await env.TEAM_CONTROL_DB.prepare(
      `SELECT 1 AS found FROM individual_privacy_deletion_requests
        WHERE subject_token = ?1 AND status = 'pending' LIMIT 1`
    )
      .bind(identity.canonical_subject_token)
      .first<{ found: number }>();
    if (competing) {
      throw new ApiError(409, "individual_deletion_concurrent_conflict", "Individual identity or deletion state changed concurrently.");
    }
    throw error;
  }
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[2]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "individual_deletion_concurrent_conflict", "Individual identity or deletion state changed concurrently.");
  }
  return jsonResponse(
    {
      request_id: requestId,
      confirmation,
      expires_at: expiresAt,
      warning: "This confirmation is shown once. Confirming permanently removes individual measurement and personal-installation identity data."
    },
    202
  );
}

export async function confirmIndividualDeletion(
  request: Request,
  env: Env,
  auth: IndividualAuthContext
): Promise<Response> {
  const identity = await loadPrivacyIdentity(env.TEAM_CONTROL_DB, auth);
  const confirmation = request.headers.get("X-Deletion-Confirmation");
  if (!confirmation || confirmation.length > 256) {
    throw new ApiError(428, "deletion_confirmation_required", "X-Deletion-Confirmation is required.");
  }
  const { rawBody, hash } = await requestMutationHash(request);
  const body = parseJsonObject(rawBody);
  assertExactKeys(body, ["schema_version"]);
  if (body.schema_version !== "individual-deletion-confirmation-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be individual-deletion-confirmation-v1.");
  }
  if (
    await sessionMutationReplay(
      env.TEAM_CONTROL_DB,
      auth,
      "deletion_confirmation",
      hash,
      identity.subject_token
    )
  ) {
    throw new ApiError(409, "individual_deletion_confirmation_replayed", "Deletion confirmation was already applied.");
  }
  const pending = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, confirmation_sha256, status, expires_at
       FROM individual_privacy_deletion_requests
      WHERE subject_token = ?1 AND status = 'pending'
      ORDER BY requested_at DESC LIMIT 1`
  )
    .bind(identity.canonical_subject_token)
    .first<IndividualDeletionRequestRow>();
  const providedHash = await sha256Hex(confirmation);
  if (
    !pending ||
    Date.parse(pending.expires_at) <= Date.now() ||
    !timingSafeHexEqual(pending.confirmation_sha256, providedHash)
  ) {
    throw new ApiError(403, "invalid_deletion_confirmation", "Deletion confirmation is invalid or expired.");
  }
  const at = nowIso();
  const tombstone = (await sha256Hex(identity.canonical_subject_token)).slice(0, 24);
  const db = env.TEAM_CONTROL_DB;
  await db.batch([
    sessionMutationStatement(db, auth, "deletion_confirmation", hash, identity.subject_token, at),
    db.prepare(
      `DELETE FROM individual_measurement_events
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM individual_subject_attestations
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM individual_auth_subject_rotations
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM individual_identity_merges
        WHERE source_subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        ) OR target_subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM individual_measurement_bridge_messages
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM workflow_integrity_receipts
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
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM github_personal_installation_reconciliations
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM github_personal_deliveries
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
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM github_personal_installations
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM github_installation_provider_proofs
        WHERE account_type = 'User' AND (
          EXISTS (
            SELECT 1 FROM github_personal_installation_claims c
            JOIN individual_identities i ON i.subject_token = c.subject_token
             WHERE (i.subject_token = ?1 OR i.canonical_subject_token = ?1)
               AND c.installation_id = github_installation_provider_proofs.installation_id
               AND c.incarnation = github_installation_provider_proofs.incarnation
          ) OR EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations r
             WHERE r.lane = 'personal' AND r.owner_ref IN (
               SELECT subject_token FROM individual_identities
                WHERE subject_token = ?1 OR canonical_subject_token = ?1
             ) AND r.installation_id = github_installation_provider_proofs.installation_id
               AND r.incarnation = github_installation_provider_proofs.incarnation
               AND r.creation_delivery_id = github_installation_provider_proofs.delivery_id
          )
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM github_installation_lifecycle_heads
        WHERE account_type = 'User' AND (
          EXISTS (
            SELECT 1 FROM github_personal_installation_claims c
            JOIN individual_identities i ON i.subject_token = c.subject_token
             WHERE (i.subject_token = ?1 OR i.canonical_subject_token = ?1)
               AND c.installation_id = github_installation_lifecycle_heads.installation_id
               AND c.incarnation = github_installation_lifecycle_heads.incarnation
          ) OR EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations r
             WHERE r.lane = 'personal' AND r.owner_ref IN (
               SELECT subject_token FROM individual_identities
                WHERE subject_token = ?1 OR canonical_subject_token = ?1
             ) AND r.installation_id = github_installation_lifecycle_heads.installation_id
               AND r.incarnation = github_installation_lifecycle_heads.incarnation
          )
        )
          AND NOT EXISTS (
            SELECT 1 FROM github_installations
             WHERE installation_id = github_installation_lifecycle_heads.installation_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM github_installation_claims
             WHERE installation_id = github_installation_lifecycle_heads.installation_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM github_personal_installations
             WHERE installation_id = github_installation_lifecycle_heads.installation_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM github_personal_installation_claims c
            JOIN individual_identities i ON i.subject_token = c.subject_token
             WHERE c.installation_id = github_installation_lifecycle_heads.installation_id
               AND c.incarnation = github_installation_lifecycle_heads.incarnation
               AND i.subject_token <> ?1 AND i.canonical_subject_token <> ?1
          )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM github_personal_installation_claims
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM github_installation_release_reconciliations
        WHERE lane = 'personal' AND owner_ref IN (
            SELECT subject_token FROM individual_identities
             WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM individual_audit_events
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM individual_session_mutations
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM individual_consents
        WHERE subject_token IN (
          SELECT subject_token FROM individual_identities
           WHERE subject_token = ?1 OR canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM individual_identities
        WHERE subject_token = ?1 OR canonical_subject_token = ?1`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `UPDATE individual_privacy_deletion_requests SET status = 'completed', completed_at = ?1,
         confirmation_sha256 = ?2, requested_session_sha256 = ?2, subject_token = ?3
       WHERE id = ?4`
    ).bind(at, "0".repeat(64), `deleted_${tombstone}`, pending.id)
  ]);
  return jsonResponse(
    {
      deleted: true,
      access_revoked: true,
      retained: "Only a non-identifying deletion-completion tombstone remains."
    },
    200
  );
}
