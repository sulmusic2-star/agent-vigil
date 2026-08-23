import { randomOpaqueToken, sha256Hex, timingSafeHexEqual } from "./crypto.ts";
import { newId, nowIso } from "./db.ts";
import type { IndividualAuthContext } from "./individual-auth.ts";
import {
  exportIndividualMeasurement,
  individualAuditStatement,
  loadIndividualIdentity,
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

export async function exportIndividualData(
  env: Env,
  auth: IndividualAuthContext
): Promise<Response> {
  const identity = await loadIndividualIdentity(env, auth, false);
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
  const identity = await loadIndividualIdentity(env, auth, false);
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
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_privacy_deletion_requests
        (id, subject_token, confirmation_sha256, status, requested_session_sha256,
         requested_at, expires_at)
       VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6)`
    ).bind(requestId, identity.canonical_subject_token, confirmationHash, auth.sessionSha256, at, expiresAt),
    sessionMutationStatement(
      env.TEAM_CONTROL_DB,
      auth,
      "deletion_request",
      hash,
      identity.subject_token,
      at
    ),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      subjectToken: identity.subject_token,
      actorType: "human_session",
      actorSessionSha256: auth.sessionSha256,
      action: "privacy.individual_deletion.requested",
      resourceType: "individual_privacy_deletion_request",
      at
    })
  ]);
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
  const identity = await loadIndividualIdentity(env, auth, false);
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
        ) OR installation_id IN (
          SELECT c.installation_id FROM github_personal_installation_claims c
          JOIN individual_identities i ON i.subject_token = c.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1
        )`
    ).bind(identity.canonical_subject_token),
    db.prepare(
      `DELETE FROM github_deliveries
        WHERE installation_id IN (
          SELECT c.installation_id FROM github_personal_installation_claims c
          JOIN individual_identities i ON i.subject_token = c.subject_token
          WHERE i.subject_token = ?1 OR i.canonical_subject_token = ?1
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
      `DELETE FROM github_personal_installation_claims
        WHERE subject_token IN (
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
    202
  );
}
