import { newId, nowIso } from "./db.ts";
import type { IndividualAuthContext } from "./individual-auth.ts";
import { requireIndividualFeatureConfiguration } from "./individual-config.ts";
import {
  individualAuditStatement,
  loadIndividualIdentity,
  refreshIndividualEligibility,
  requestMutationHash,
  sessionMutationReplay
} from "./individual-measurement.ts";
import { ApiError, jsonResponse, parseJsonObject } from "./http.ts";
import { isGitHubLifecycleAdvance, recordGitHubProviderProof } from "./github-provider-proof.ts";
import { assertExactKeys, requireInteger, requireString } from "./validation.ts";

export type PersonalGitHubEventName = "installation" | "installation_repositories";
export type PersonalGitHubAction = "created" | "deleted" | "suspend" | "unsuspend" | "added" | "removed";
export type PersonalGitHubState = "pending_reconciliation" | "active" | "suspended" | "deleted";
export type PersonalRepositorySelection = "all" | "selected";

export interface PersonalGitHubSummary {
  eventName: PersonalGitHubEventName;
  action: PersonalGitHubAction;
  appId: number;
  installationId: number;
  accountNodeId: string;
  accountType: "User";
  repositorySelection: PersonalRepositorySelection;
  eventCreatedAt: number;
  eventCreatedIso: string;
}

export interface PersonalReconciliationSnapshot {
  reconciliationId: string;
  sourceDeliveryId: string;
  observedAt: string;
  appId: number;
  installationId: number;
  accountNodeId: string;
  accountType: "User";
  providerStatus: "active" | "not_found";
  repositorySelection: PersonalRepositorySelection;
}

export interface PersonalDeliveryRow {
  delivery_id: string;
  payload_sha256: string;
  event_name: PersonalGitHubEventName;
  action: PersonalGitHubAction;
  installation_id: number;
  incarnation: number;
  subject_token: string | null;
  account_type: "User";
  event_created_at: number;
  result: "unclaimed" | "pending_reconciliation" | "applied" | "revoked" | "stale" | "rejected";
}

interface PersonalClaimRow {
  installation_id: number;
  incarnation: number;
  github_account_node_id: string;
  subject_token: string;
  account_type: "User";
  status: "claimed" | "bound" | "revoked";
  provider_proof_delivery_id: string | null;
  claim_expires_at: string | null;
  claimed_session_sha256: string;
  identity_status: "active" | "merged";
}

interface PersonalInstallationRow {
  installation_id: number;
  incarnation: number;
  app_id: number;
  github_account_node_id: string;
  subject_token: string;
  account_type: "User";
  state: PersonalGitHubState;
  repository_selection: PersonalRepositorySelection;
  last_event_created_at: number;
  last_delivery_id: string;
  last_reconciliation_id: string | null;
  installed_at: string;
  suspended_at: string | null;
  deleted_at: string | null;
  reconciled_at: string | null;
  updated_at: string;
}

async function personalClaim(db: D1Database, installationId: number): Promise<PersonalClaimRow | null> {
  return db
    .prepare(
      `SELECT c.installation_id, c.incarnation, c.github_account_node_id, c.subject_token, c.account_type,
              c.status, c.provider_proof_delivery_id, c.claim_expires_at,
              c.claimed_session_sha256, i.status AS identity_status
         FROM github_personal_installation_claims c
         JOIN individual_identities i ON i.subject_token = c.subject_token
        WHERE c.installation_id = ?1`
    )
    .bind(installationId)
    .first<PersonalClaimRow>();
}

async function personalInstallation(
  db: D1Database,
  installationId: number
): Promise<PersonalInstallationRow | null> {
  return db
    .prepare(
      `SELECT installation_id, incarnation, app_id, github_account_node_id, subject_token, account_type,
              state, repository_selection, last_event_created_at, last_delivery_id,
              last_reconciliation_id, installed_at, suspended_at, deleted_at,
              reconciled_at, updated_at
         FROM github_personal_installations WHERE installation_id = ?1`
    )
    .bind(installationId)
    .first<PersonalInstallationRow>();
}

export async function loadPersonalDelivery(
  db: D1Database,
  deliveryId: string
): Promise<PersonalDeliveryRow | null> {
  return db
    .prepare(
      `SELECT delivery_id, payload_sha256, event_name, action, installation_id, incarnation,
              subject_token, account_type, event_created_at, result
         FROM github_personal_deliveries WHERE delivery_id = ?1`
    )
    .bind(deliveryId)
    .first<PersonalDeliveryRow>();
}

export async function claimPersonalInstallation(
  request: Request,
  env: Env,
  auth: IndividualAuthContext
): Promise<Response> {
  requireIndividualFeatureConfiguration(env);
  const { rawBody, hash } = await requestMutationHash(request);
  const body = parseJsonObject(rawBody);
  assertExactKeys(body, ["schema_version", "installation_id", "provider_delivery_id"]);
  if (body.schema_version !== "github-personal-installation-claim-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be github-personal-installation-claim-v1.");
  }
  const installationId = requireInteger(body.installation_id, "installation_id", { min: 1 });
  const providerDeliveryId = requireString(body.provider_delivery_id, "provider_delivery_id", {
    min: 36,
    max: 36,
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  });
  const identity = await loadIndividualIdentity(env, auth, false);
  const consent = await env.TEAM_CONTROL_DB.prepare(
    `SELECT opted_in FROM individual_consents WHERE subject_token = ?1`
  )
    .bind(identity.subject_token)
    .first<{ opted_in: number }>();
  if (consent?.opted_in !== 1) {
    throw new ApiError(409, "individual_consent_required", "Explicit individual measurement opt-in is required before claiming an installation.");
  }
  const priorMutation = await sessionMutationReplay(
    env.TEAM_CONTROL_DB,
    auth,
    "installation_claim",
    hash,
    identity.subject_token
  );
  if (priorMutation) {
    return jsonResponse({ claimed: true, duplicate: true, installation_id: installationId });
  }
  const at = nowIso();
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `DELETE FROM github_personal_installation_claims
        WHERE status = 'claimed' AND claim_expires_at <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM github_personal_installations
             WHERE installation_id = github_personal_installation_claims.installation_id
          )`
    ).bind(at),
    env.TEAM_CONTROL_DB.prepare(
      `DELETE FROM github_installation_claims
        WHERE status = 'claimed' AND claim_expires_at <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM github_installations
             WHERE installation_id = github_installation_claims.installation_id
          )`
    ).bind(at),
    env.TEAM_CONTROL_DB.prepare(
      `DELETE FROM github_installation_provider_proofs
        WHERE expires_at <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM github_installation_claims
             WHERE provider_proof_delivery_id = github_installation_provider_proofs.delivery_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM github_personal_installation_claims
             WHERE provider_proof_delivery_id = github_installation_provider_proofs.delivery_id
          )`
    ).bind(at)
  ]);
  const proof = await env.TEAM_CONTROL_DB.prepare(
    `SELECT p.delivery_id, p.expires_at, p.incarnation
       FROM github_installation_provider_proofs p
       JOIN github_installation_lifecycle_heads h
         ON h.installation_id = p.installation_id
        AND h.github_account_node_id = p.github_account_node_id
        AND h.account_type = p.account_type
      WHERE p.delivery_id = ?1 AND p.installation_id = ?2 AND p.github_account_node_id = ?3
        AND p.account_type = 'User' AND p.consumed_at IS NULL
        AND p.invalidated_at IS NULL AND p.expires_at > ?4
        AND h.creation_delivery_id = p.delivery_id AND h.latest_delivery_id = p.delivery_id
        AND h.latest_action = 'created' AND h.terminal = 0
        AND h.incarnation = p.incarnation`
  )
    .bind(providerDeliveryId, installationId, identity.github_account_node_id, at)
    .first<{ delivery_id: string; expires_at: string; incarnation: number }>();
  if (!proof) {
    const duplicate = await env.TEAM_CONTROL_DB.prepare(
      `SELECT 1 AS found FROM github_personal_installation_claims
        WHERE installation_id = ?1 AND github_account_node_id = ?2 AND subject_token = ?3
          AND provider_proof_delivery_id = ?4 AND status <> 'revoked'`
    )
      .bind(installationId, identity.github_account_node_id, identity.subject_token, providerDeliveryId)
      .first<{ found: number }>();
    if (duplicate) {
      return jsonResponse({ claimed: true, duplicate: true, installation_id: installationId });
    }
    throw new ApiError(409, "github_provider_proof_required", "A recent verified GitHub creation delivery is required.");
  }
  const collision = await env.TEAM_CONTROL_DB.prepare(
    `SELECT 'personal' AS lane, installation_id, github_account_node_id
       FROM github_personal_installation_claims
      WHERE installation_id = ?1 OR github_account_node_id = ?2 OR subject_token = ?3
     UNION ALL
     SELECT 'organization' AS lane, installation_id, github_account_node_id
       FROM github_installation_claims
      WHERE installation_id = ?1 OR github_account_node_id = ?2
     LIMIT 1`
  )
    .bind(installationId, identity.github_account_node_id, identity.subject_token)
    .first<{ lane: string; installation_id: number; github_account_node_id: string }>();
  if (collision) {
    if (
      collision.lane === "personal" &&
      collision.installation_id === installationId &&
      collision.github_account_node_id === identity.github_account_node_id
    ) {
      throw new ApiError(409, "individual_claim_requires_new_session", "Existing claim must be replayed with its original authenticated session.");
    }
    throw new ApiError(409, "github_installation_claim_collision", "Installation or account identity is already bound.");
  }
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_personal_installation_claims
        (installation_id, incarnation, github_account_node_id, subject_token, account_type, status,
         claimed_session_sha256, claimed_at, updated_at, provider_proof_delivery_id,
         claim_expires_at, bound_at)
       SELECT ?1, ?8, ?2, ?3, 'User', 'claimed', ?4, ?5, ?5, ?6, ?7, NULL
        WHERE EXISTS (
          SELECT 1 FROM github_installation_provider_proofs
           WHERE delivery_id = ?6 AND installation_id = ?1 AND incarnation = ?8 AND github_account_node_id = ?2
             AND account_type = 'User' AND consumed_at IS NULL
             AND invalidated_at IS NULL AND expires_at > ?5
             AND EXISTS (
               SELECT 1 FROM github_installation_lifecycle_heads
                WHERE installation_id = ?1 AND incarnation = ?8 AND github_account_node_id = ?2
                  AND account_type = 'User' AND creation_delivery_id = ?6
                  AND latest_delivery_id = ?6 AND latest_action = 'created' AND terminal = 0
             )
        )`
    ).bind(
      installationId,
      identity.github_account_node_id,
      identity.subject_token,
      auth.sessionSha256,
      at,
      providerDeliveryId,
      proof.expires_at,
      proof.incarnation
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installation_provider_proofs
          SET consumed_at = ?1, consumed_by_lane = 'personal'
        WHERE delivery_id = ?2 AND installation_id = ?3 AND incarnation = ?6 AND github_account_node_id = ?4
          AND account_type = 'User' AND consumed_at IS NULL
          AND invalidated_at IS NULL AND expires_at > ?1
          AND EXISTS (
            SELECT 1 FROM github_installation_lifecycle_heads
             WHERE installation_id = ?3 AND incarnation = ?6 AND github_account_node_id = ?4
               AND account_type = 'User' AND creation_delivery_id = ?2
               AND latest_delivery_id = ?2 AND latest_action = 'created' AND terminal = 0
          )
          AND EXISTS (
            SELECT 1 FROM github_personal_installation_claims
             WHERE installation_id = ?3 AND incarnation = ?6 AND github_account_node_id = ?4 AND subject_token = ?5
               AND status = 'claimed' AND provider_proof_delivery_id = ?2
          )`
    ).bind(at, providerDeliveryId, installationId, identity.github_account_node_id, identity.subject_token, proof.incarnation),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_session_mutations
        (session_sha256, action, request_sha256, subject_token, result, applied_at)
       SELECT ?1, 'installation_claim', ?2, ?3, 'applied', ?4
        WHERE EXISTS (
          SELECT 1 FROM github_personal_installation_claims c
          JOIN github_installation_provider_proofs p
            ON p.delivery_id = c.provider_proof_delivery_id
         WHERE c.installation_id = ?5 AND c.github_account_node_id = ?6
           AND c.subject_token = ?3 AND c.status = 'claimed'
           AND c.incarnation = p.incarnation AND p.consumed_at = ?4 AND p.consumed_by_lane = 'personal'
        )`
    ).bind(
      auth.sessionSha256,
      hash,
      identity.subject_token,
      at,
      installationId,
      identity.github_account_node_id
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_audit_events
        (id, subject_token, actor_type, actor_session_sha256, action, resource_type, metadata_json, created_at)
       SELECT ?1, ?2, 'human_session', ?3, 'github.personal_installation.claimed',
              'github_personal_installation', '{}', ?4
        WHERE EXISTS (
          SELECT 1 FROM individual_session_mutations
           WHERE session_sha256 = ?3 AND action = 'installation_claim'
             AND request_sha256 = ?5 AND subject_token = ?2
        )`
    ).bind(newId("individual_audit"), identity.subject_token, auth.sessionSha256, at, hash)
  ]);
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[2]?.meta.changes ?? 0) !== 1 ||
    (results[3]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "github_personal_claim_concurrent_conflict", "Personal installation claim changed concurrently.");
  }
  return jsonResponse({ claimed: true, installation_id: installationId }, 201);
}

export async function getPersonalInstallation(
  env: Env,
  auth: IndividualAuthContext
): Promise<Response> {
  const identity = await loadIndividualIdentity(env, auth, false);
  const claim = await env.TEAM_CONTROL_DB.prepare(
    `SELECT account_type, status, claimed_at, updated_at
       FROM github_personal_installation_claims WHERE subject_token = ?1`
  )
    .bind(identity.subject_token)
    .first();
  if (!claim) {
    throw new ApiError(404, "github_personal_installation_not_claimed", "No personal installation is claimed for this identity.");
  }
  const installation = await env.TEAM_CONTROL_DB.prepare(
    `SELECT account_type, state, repository_selection, installed_at, suspended_at,
            deleted_at, reconciled_at, updated_at
       FROM github_personal_installations WHERE subject_token = ?1`
  )
    .bind(identity.subject_token)
    .first();
  return jsonResponse({
    schema_version: "github-personal-installation-state-v1",
    claim,
    installation,
    stores_installation_id_in_response: false,
    stores_repository_names_or_source: false
  });
}

async function recordUnclaimed(
  env: Env,
  existing: PersonalDeliveryRow | null,
  deliveryId: string,
  payloadHash: string,
  summary: PersonalGitHubSummary
): Promise<void> {
  const at = nowIso();
  if (existing) {
    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_deliveries SET result = 'unclaimed', received_at = ?1
        WHERE delivery_id = ?2`
    )
      .bind(at, deliveryId)
      .run();
    return;
  }
  await env.TEAM_CONTROL_DB.prepare(
    `INSERT INTO github_personal_deliveries
      (delivery_id, payload_sha256, event_name, action, installation_id, incarnation, subject_token,
       account_type, event_created_at, result, received_at)
     SELECT ?1, ?2, ?3, ?4, ?5, incarnation, NULL, 'User', ?6, 'unclaimed', ?7
       FROM github_installation_lifecycle_heads
      WHERE installation_id = ?5 AND latest_delivery_id = ?1`
  )
    .bind(
      deliveryId,
      payloadHash,
      summary.eventName,
      summary.action,
      summary.installationId,
      summary.eventCreatedAt,
      at
    )
    .run();
}

export async function handlePersonalGitHubWebhook(
  env: Env,
  input: {
    deliveryId: string;
    payloadHash: string;
    summary: PersonalGitHubSummary;
    existingDelivery: PersonalDeliveryRow | null;
  }
): Promise<Response> {
  requireIndividualFeatureConfiguration(env);
  const { deliveryId, payloadHash, summary, existingDelivery } = input;
  if (existingDelivery) {
    if (existingDelivery.payload_sha256 !== payloadHash) {
      throw new ApiError(409, "github_delivery_replay_mismatch", "GitHub delivery identifier was reused with different bytes.");
    }
    if (existingDelivery.event_name !== summary.eventName || existingDelivery.account_type !== "User") {
      throw new ApiError(409, "github_delivery_header_mismatch", "GitHub delivery identity changed during replay.");
    }
    if (existingDelivery.result !== "unclaimed") {
      return jsonResponse({ received: true, duplicate: true, result: existingDelivery.result });
    }
  }
  const claim = await personalClaim(env.TEAM_CONTROL_DB, summary.installationId);
  if (
    !claim ||
    claim.status === "revoked" ||
    claim.identity_status !== "active" ||
    claim.github_account_node_id !== summary.accountNodeId ||
    claim.account_type !== "User" ||
    (claim.status === "claimed" && (!claim.claim_expires_at || claim.claim_expires_at <= nowIso())) ||
    (summary.action === "created" && claim.provider_proof_delivery_id !== deliveryId) ||
    (summary.action !== "created" && claim.status !== "bound")
  ) {
    await recordGitHubProviderProof(env.TEAM_CONTROL_DB, {
      deliveryId,
      installationId: summary.installationId,
      accountNodeId: summary.accountNodeId,
      accountType: "User",
      action: summary.action,
      eventCreatedAt: summary.eventCreatedAt
    });
    await recordUnclaimed(env, existingDelivery, deliveryId, payloadHash, summary);
    throw new ApiError(409, "github_personal_installation_claim_required", "A matching authenticated personal claim is required.");
  }
  const installation = await personalInstallation(env.TEAM_CONTROL_DB, summary.installationId);
  const materializedDelivery = installation
    ? await env.TEAM_CONTROL_DB.prepare(
        `SELECT delivery_id, action, event_created_at FROM github_personal_deliveries
          WHERE delivery_id = ?1 AND installation_id = ?2 AND incarnation = ?4 AND subject_token = ?3`
      )
        .bind(installation.last_delivery_id, installation.installation_id, installation.subject_token, installation.incarnation)
        .first<{ delivery_id: string; action: PersonalGitHubAction; event_created_at: number }>()
    : null;
  if (installation) {
    if (
      installation.subject_token !== claim.subject_token ||
      installation.incarnation !== claim.incarnation ||
      installation.github_account_node_id !== summary.accountNodeId ||
      installation.app_id !== summary.appId ||
      installation.account_type !== "User"
    ) {
      throw new ApiError(409, "github_personal_installation_binding_mismatch", "Personal installation binding does not match its claim.");
    }
    if (
      !materializedDelivery ||
      materializedDelivery.event_created_at !== installation.last_event_created_at ||
      !isGitHubLifecycleAdvance(
        { deliveryId, eventCreatedAt: summary.eventCreatedAt, action: summary.action },
        {
          deliveryId: materializedDelivery.delivery_id,
          eventCreatedAt: materializedDelivery.event_created_at,
          action: materializedDelivery.action
        }
      )
    ) {
      const at = nowIso();
      await env.TEAM_CONTROL_DB.batch([
        existingDelivery
          ? env.TEAM_CONTROL_DB.prepare(
              `UPDATE github_personal_deliveries SET subject_token = ?1, result = 'stale', received_at = ?2
                WHERE delivery_id = ?3 AND incarnation = ?4`
            ).bind(claim.subject_token, at, deliveryId, installation.incarnation)
          : env.TEAM_CONTROL_DB.prepare(
              `INSERT INTO github_personal_deliveries
                (delivery_id, payload_sha256, event_name, action, installation_id, incarnation, subject_token,
                 account_type, event_created_at, result, received_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?9, ?6, 'User', ?7, 'stale', ?8)`
            ).bind(
              deliveryId,
              payloadHash,
              summary.eventName,
              summary.action,
              summary.installationId,
              claim.subject_token,
              summary.eventCreatedAt,
              at,
              installation.incarnation
            ),
        individualAuditStatement(env.TEAM_CONTROL_DB, {
          subjectToken: claim.subject_token,
          actorType: "github_app",
          action: "github.personal_delivery.stale",
          resourceType: "github_personal_delivery",
          at
        })
      ]);
      throw new ApiError(409, "stale_github_delivery", "Older or ambiguously ordered GitHub delivery was rejected.");
    }
  }

  if (summary.action === "created") {
    if (installation) {
      throw new ApiError(409, "github_personal_installation_already_exists", "Personal installation creation cannot replace existing state.");
    }
    const at = nowIso();
    const materializationStatements: D1PreparedStatement[] = [
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO github_personal_installations
          (installation_id, incarnation, app_id, github_account_node_id, subject_token, account_type, state,
           repository_selection, last_event_created_at, last_delivery_id, installed_at, updated_at)
         SELECT ?1, ?10, ?2, ?3, ?4, 'User', 'pending_reconciliation', ?5, ?6, ?7, ?8, ?9
          WHERE EXISTS (
            SELECT 1 FROM github_personal_installation_claims
             WHERE installation_id = ?1 AND incarnation = ?10 AND github_account_node_id = ?3 AND subject_token = ?4
               AND status = 'claimed' AND provider_proof_delivery_id = ?7
               AND claim_expires_at > ?9
               AND EXISTS (
                 SELECT 1 FROM github_installation_lifecycle_heads
                  WHERE installation_id = ?1 AND incarnation = ?10 AND github_account_node_id = ?3
                    AND account_type = 'User' AND creation_delivery_id = ?7
                    AND latest_delivery_id = ?7 AND latest_action = 'created' AND terminal = 0
               )
          )`
      ).bind(
        summary.installationId,
        summary.appId,
        summary.accountNodeId,
        claim.subject_token,
        summary.repositorySelection,
        summary.eventCreatedAt,
        deliveryId,
        summary.eventCreatedIso,
        at,
        claim.incarnation
      ),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE github_personal_installation_claims SET status = 'bound', bound_at = ?1,
           claim_expires_at = '9999-12-31T23:59:59.999Z', updated_at = ?1
          WHERE installation_id = ?2 AND incarnation = ?6 AND subject_token = ?3 AND github_account_node_id = ?4
            AND status = 'claimed' AND provider_proof_delivery_id = ?5 AND claim_expires_at > ?1`
      ).bind(at, summary.installationId, claim.subject_token, summary.accountNodeId, deliveryId, claim.incarnation),
      existingDelivery
        ? env.TEAM_CONTROL_DB.prepare(
            `UPDATE github_personal_deliveries SET subject_token = ?1,
               result = 'pending_reconciliation', received_at = ?2
              WHERE delivery_id = ?3 AND incarnation = ?5
                AND EXISTS (
                  SELECT 1 FROM github_personal_installations
                   WHERE installation_id = ?4 AND incarnation = ?5 AND last_delivery_id = ?3
                )`
          ).bind(claim.subject_token, at, deliveryId, summary.installationId, claim.incarnation)
        : env.TEAM_CONTROL_DB.prepare(
            `INSERT INTO github_personal_deliveries
              (delivery_id, payload_sha256, event_name, action, installation_id, incarnation, subject_token,
               account_type, event_created_at, result, received_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?9, ?6, 'User', ?7, 'pending_reconciliation', ?8
              WHERE EXISTS (
                SELECT 1 FROM github_personal_installations
                 WHERE installation_id = ?5 AND incarnation = ?9 AND last_delivery_id = ?1
              )`
          ).bind(
            deliveryId,
            payloadHash,
            summary.eventName,
            summary.action,
            summary.installationId,
            claim.subject_token,
            summary.eventCreatedAt,
            at,
            claim.incarnation
          ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO individual_audit_events
          (id, subject_token, actor_type, actor_session_sha256, action, resource_type, metadata_json, created_at)
         SELECT ?1, ?2, 'github_app', NULL,
                'github.personal_installation.created_pending_reconciliation',
                'github_personal_installation', ?3, ?4
          WHERE EXISTS (
            SELECT 1 FROM github_personal_installations i
            JOIN github_personal_installation_claims c ON c.installation_id = i.installation_id AND c.incarnation = i.incarnation
             WHERE i.installation_id = ?5 AND i.incarnation = ?7 AND i.subject_token = ?2 AND i.last_delivery_id = ?6
               AND c.status = 'bound' AND c.provider_proof_delivery_id = ?6
          )`
      ).bind(
        newId("individual_audit"),
        claim.subject_token,
        JSON.stringify({ account_type: "User", repository_selection: summary.repositorySelection }),
        at,
        summary.installationId,
        deliveryId,
        claim.incarnation
      ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
         VALUES (?1, 'github_personal_lifecycle_materialized', ?2,
           CASE WHEN
             EXISTS (
               SELECT 1 FROM github_personal_installations
                WHERE installation_id = ?3 AND incarnation = ?6 AND subject_token = ?4
                  AND state = 'pending_reconciliation' AND last_delivery_id = ?2
             )
             AND EXISTS (
               SELECT 1 FROM github_personal_installation_claims
                WHERE installation_id = ?3 AND incarnation = ?6 AND subject_token = ?4 AND status = 'bound'
                  AND provider_proof_delivery_id = ?2
             )
             AND EXISTS (
               SELECT 1 FROM github_personal_deliveries
                WHERE delivery_id = ?2 AND installation_id = ?3 AND incarnation = ?6 AND subject_token = ?4
                  AND result = 'pending_reconciliation'
             )
           THEN 1 ELSE 0 END, ?5)`
      ).bind(newId("integrity"), deliveryId, summary.installationId, claim.subject_token, at, claim.incarnation)
    ];
    const results = await recordGitHubProviderProof(
      env.TEAM_CONTROL_DB,
      {
        deliveryId,
        installationId: summary.installationId,
        accountNodeId: summary.accountNodeId,
        accountType: "User",
        action: summary.action,
        eventCreatedAt: summary.eventCreatedAt
      },
      materializationStatements
    );
    const materializationOffset = 6;
    if (
      (results[materializationOffset]?.meta.changes ?? 0) !== 1 ||
      (results[materializationOffset + 1]?.meta.changes ?? 0) !== 1 ||
      (results[materializationOffset + 2]?.meta.changes ?? 0) !== 1 ||
      (results[materializationOffset + 3]?.meta.changes ?? 0) !== 1 ||
      (results[materializationOffset + 4]?.meta.changes ?? 0) !== 1
    ) {
      throw new ApiError(409, "github_personal_installation_concurrent_conflict", "Personal installation could not be safely initialized.");
    }
    return jsonResponse({ received: true, account_type: "User", state: "pending_reconciliation" }, 202);
  }

  if (!installation) {
    throw new ApiError(409, "github_personal_installation_missing", "Personal installation lifecycle must begin with a claimed creation event.");
  }
  if (installation.state === "deleted") {
    throw new ApiError(409, "github_personal_installation_deleted", "Deleted personal installation cannot accept lifecycle events.");
  }
  const at = nowIso();
  let nextState: PersonalGitHubState = installation.state;
  let result: PersonalDeliveryRow["result"] = "applied";
  let suspendedAt = installation.suspended_at;
  let deletedAt = installation.deleted_at;
  if (summary.action === "suspend") {
    nextState = "suspended";
    result = "revoked";
    suspendedAt = summary.eventCreatedIso;
  } else if (summary.action === "deleted") {
    nextState = "deleted";
    result = "revoked";
    deletedAt = summary.eventCreatedIso;
  } else if (
    summary.action === "unsuspend" ||
    summary.repositorySelection !== installation.repository_selection ||
    installation.state === "pending_reconciliation"
  ) {
    nextState = "pending_reconciliation";
    result = "pending_reconciliation";
    suspendedAt = null;
  }
  const materializationStatements: D1PreparedStatement[] = [
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_installations SET state = ?1, repository_selection = ?2,
         last_event_created_at = ?3, last_delivery_id = ?4, last_reconciliation_id = NULL,
         suspended_at = ?5, deleted_at = ?6, reconciled_at = NULL, updated_at = ?7
       WHERE installation_id = ?8 AND incarnation = ?11 AND last_event_created_at = ?9 AND last_delivery_id = ?10`
    ).bind(
      nextState,
      summary.repositorySelection,
      summary.eventCreatedAt,
      deliveryId,
      suspendedAt,
      deletedAt,
      at,
      summary.installationId,
      installation.last_event_created_at,
      installation.last_delivery_id,
      installation.incarnation
    ),
    existingDelivery
      ? env.TEAM_CONTROL_DB.prepare(
          `UPDATE github_personal_deliveries SET subject_token = ?1, result = ?2, received_at = ?3
            WHERE delivery_id = ?4 AND incarnation = ?5`
        ).bind(claim.subject_token, result, at, deliveryId, installation.incarnation)
      : env.TEAM_CONTROL_DB.prepare(
          `INSERT INTO github_personal_deliveries
            (delivery_id, payload_sha256, event_name, action, installation_id, incarnation, subject_token,
             account_type, event_created_at, result, received_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?10, ?6, 'User', ?7, ?8, ?9)`
        ).bind(
          deliveryId,
          payloadHash,
          summary.eventName,
          summary.action,
          summary.installationId,
          claim.subject_token,
          summary.eventCreatedAt,
          result,
          at,
          installation.incarnation
        ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_installation_claims SET status = 'revoked', updated_at = ?1
        WHERE installation_id = ?2 AND incarnation = ?4 AND ?3 = 'deleted'`
    ).bind(at, summary.installationId, nextState, installation.incarnation),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_identities
          SET eligible_at = CASE WHEN ?3 = 'active' THEN eligible_at ELSE NULL END,
              updated_at = CASE WHEN ?3 = 'active' THEN updated_at ELSE ?1 END
        WHERE subject_token = ?2 AND status = 'active'`
    ).bind(at, claim.subject_token, nextState),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      subjectToken: claim.subject_token,
      actorType: "github_app",
      action: `github.personal_installation.${summary.action}`,
      resourceType: "github_personal_installation",
      metadata: { state: nextState, repository_selection: summary.repositorySelection },
      at
    }),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'github_personal_lifecycle_materialized', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM github_installation_lifecycle_heads
              WHERE installation_id = ?3 AND incarnation = ?12 AND github_account_node_id = ?4
                AND account_type = 'User' AND latest_delivery_id = ?2
                AND latest_event_created_at = ?5 AND latest_action = ?6 AND terminal = ?7
           )
           AND EXISTS (
             SELECT 1 FROM github_personal_installations
              WHERE installation_id = ?3 AND incarnation = ?12 AND subject_token = ?8 AND state = ?9 AND last_delivery_id = ?2
           )
           AND EXISTS (
             SELECT 1 FROM github_personal_deliveries
              WHERE delivery_id = ?2 AND installation_id = ?3 AND incarnation = ?12 AND subject_token = ?8 AND result = ?10
           )
           AND (
             ?6 <> 'deleted' OR EXISTS (
               SELECT 1 FROM github_personal_installation_claims
                WHERE installation_id = ?3 AND incarnation = ?12 AND subject_token = ?8 AND status = 'revoked'
             )
           )
           AND (
             ?9 = 'active' OR EXISTS (
               SELECT 1 FROM individual_identities
                WHERE subject_token = ?8 AND status = 'active' AND eligible_at IS NULL
             )
           )
         THEN 1 ELSE 0 END, ?11)`
    ).bind(
      newId("integrity"),
      deliveryId,
      summary.installationId,
      summary.accountNodeId,
      summary.eventCreatedAt,
      summary.action,
      summary.action === "deleted" || summary.action === "suspend" ? 1 : 0,
      claim.subject_token,
      nextState,
      result,
      at,
      installation.incarnation
    )
  ];
  const results = await recordGitHubProviderProof(
    env.TEAM_CONTROL_DB,
    {
      deliveryId,
      installationId: summary.installationId,
      accountNodeId: summary.accountNodeId,
      accountType: "User",
      action: summary.action,
      eventCreatedAt: summary.eventCreatedAt
    },
    materializationStatements
  );
  const materializationOffset = 6;
  if (
    (results[materializationOffset]?.meta.changes ?? 0) !== 1 ||
    (results[materializationOffset + 1]?.meta.changes ?? 0) !== 1 ||
    (results[materializationOffset + 2]?.meta.changes ?? 0) !== (summary.action === "deleted" ? 1 : 0) ||
    (results[materializationOffset + 3]?.meta.changes ?? 0) !== 1 ||
    (results[materializationOffset + 4]?.meta.changes ?? 0) !== 1 ||
    (results[materializationOffset + materializationStatements.length - 1]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "github_personal_installation_concurrent_conflict", "Personal installation changed concurrently.");
  }
  return jsonResponse({ received: true, account_type: "User", state: nextState }, result === "applied" ? 200 : 202);
}

export async function reconcilePersonalInstallation(
  env: Env,
  snapshot: PersonalReconciliationSnapshot,
  payloadHash: string
): Promise<Response> {
  requireIndividualFeatureConfiguration(env);
  const priorRelease = await env.TEAM_CONTROL_DB.prepare(
    `SELECT payload_sha256, result FROM github_installation_release_reconciliations
      WHERE reconciliation_id = ?1 AND lane = 'personal'`
  )
    .bind(snapshot.reconciliationId)
    .first<{ payload_sha256: string; result: string }>();
  if (priorRelease) {
    if (priorRelease.payload_sha256 !== payloadHash) {
      throw new ApiError(409, "github_reconciliation_replay_mismatch", "Reconciliation identifier was reused with different bytes.");
    }
    return jsonResponse({ reconciled: false, released: true, duplicate: true, result: priorRelease.result });
  }
  if (snapshot.providerStatus === "not_found") {
    return releasePersonalInstallation(env, snapshot, payloadHash);
  }
  const prior = await env.TEAM_CONTROL_DB.prepare(
    `SELECT payload_sha256, result FROM github_personal_installation_reconciliations
      WHERE reconciliation_id = ?1`
  )
    .bind(snapshot.reconciliationId)
    .first<{ payload_sha256: string; result: string }>();
  if (prior) {
    if (prior.payload_sha256 !== payloadHash) {
      throw new ApiError(409, "github_reconciliation_replay_mismatch", "Reconciliation identifier was reused with different bytes.");
    }
    return jsonResponse({ reconciled: prior.result === "applied", duplicate: true, result: prior.result });
  }
  const [installation, delivery, claim] = await Promise.all([
    personalInstallation(env.TEAM_CONTROL_DB, snapshot.installationId),
    loadPersonalDelivery(env.TEAM_CONTROL_DB, snapshot.sourceDeliveryId),
    personalClaim(env.TEAM_CONTROL_DB, snapshot.installationId)
  ]);
  if (
    !installation ||
    !delivery ||
    !claim ||
    delivery.result !== "pending_reconciliation" ||
    delivery.installation_id !== snapshot.installationId ||
    delivery.incarnation !== installation.incarnation ||
    installation.state !== "pending_reconciliation" ||
    installation.last_delivery_id !== snapshot.sourceDeliveryId ||
    installation.app_id !== snapshot.appId ||
    installation.github_account_node_id !== snapshot.accountNodeId ||
    installation.account_type !== "User" ||
    installation.repository_selection !== snapshot.repositorySelection ||
    claim.identity_status !== "active" ||
    claim.status === "revoked" ||
    claim.subject_token !== installation.subject_token ||
    claim.incarnation !== installation.incarnation ||
    claim.github_account_node_id !== snapshot.accountNodeId ||
    snapshot.accountType !== "User"
  ) {
    throw new ApiError(409, "github_personal_reconciliation_mismatch", "Snapshot does not match current pending personal installation state.");
  }
  const at = nowIso();
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_installations SET state = 'active', last_reconciliation_id = ?1,
         reconciled_at = ?2, suspended_at = NULL, updated_at = ?2
       WHERE installation_id = ?3 AND incarnation = ?5 AND state = 'pending_reconciliation' AND last_delivery_id = ?4`
    ).bind(snapshot.reconciliationId, at, snapshot.installationId, snapshot.sourceDeliveryId, installation.incarnation),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_personal_installation_reconciliations
        (reconciliation_id, payload_sha256, source_delivery_id, installation_id, incarnation,
         subject_token, account_type, observed_at, result, applied_at)
       SELECT ?1, ?2, ?3, ?4, ?8, ?5, 'User', ?6, 'applied', ?7
        WHERE EXISTS (
          SELECT 1 FROM github_personal_installations
           WHERE installation_id = ?4 AND incarnation = ?8 AND last_reconciliation_id = ?1 AND state = 'active'
        )`
    ).bind(
      snapshot.reconciliationId,
      payloadHash,
      snapshot.sourceDeliveryId,
      snapshot.installationId,
      installation.subject_token,
      snapshot.observedAt,
      at,
      installation.incarnation
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_deliveries SET result = 'applied'
        WHERE delivery_id = ?1
          AND EXISTS (
            SELECT 1 FROM github_personal_installations
             WHERE installation_id = ?2 AND incarnation = ?4 AND last_reconciliation_id = ?3 AND state = 'active'
          )`
    ).bind(snapshot.sourceDeliveryId, snapshot.installationId, snapshot.reconciliationId, installation.incarnation),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      subjectToken: installation.subject_token,
      actorType: "github_app",
      action: "github.personal_installation.reconciled",
      resourceType: "github_personal_installation",
      metadata: { account_type: "User", repository_selection: snapshot.repositorySelection },
      at
    })
  ]);
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[2]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "github_personal_reconciliation_concurrent_conflict", "Personal installation changed before reconciliation could apply.");
  }
  await refreshIndividualEligibility(env.TEAM_CONTROL_DB, installation.subject_token, at);
  return jsonResponse({ reconciled: true, account_type: "User", state: "active" });
}

async function releasePersonalInstallation(
  env: Env,
  snapshot: PersonalReconciliationSnapshot,
  payloadHash: string
): Promise<Response> {
  const installation = await personalInstallation(env.TEAM_CONTROL_DB, snapshot.installationId);
  const [delivery, claim, head, proof, pendingDeliveries] = await Promise.all([
    loadPersonalDelivery(env.TEAM_CONTROL_DB, snapshot.sourceDeliveryId),
    personalClaim(env.TEAM_CONTROL_DB, snapshot.installationId),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT incarnation, github_account_node_id, account_type, creation_delivery_id, latest_delivery_id,
              latest_event_created_at, latest_action, terminal
         FROM github_installation_lifecycle_heads WHERE installation_id = ?1`
    )
      .bind(snapshot.installationId)
      .first<{
        incarnation: number;
        github_account_node_id: string;
        account_type: string;
        creation_delivery_id: string | null;
        latest_delivery_id: string;
        latest_event_created_at: number;
        latest_action: string;
        terminal: number;
      }>(),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT delivery_id, installation_id, incarnation, github_account_node_id, account_type,
              invalidated_at, invalidated_by_delivery_id
         FROM github_installation_provider_proofs
        WHERE delivery_id = (
          SELECT provider_proof_delivery_id FROM github_personal_installation_claims WHERE installation_id = ?1
        )`
    )
      .bind(snapshot.installationId)
      .first<{
        delivery_id: string;
        installation_id: number;
        incarnation: number;
        github_account_node_id: string;
        account_type: string;
        invalidated_at: string | null;
        invalidated_by_delivery_id: string | null;
      }>(),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM github_personal_deliveries
        WHERE installation_id = ?1 AND incarnation = ?2 AND result = 'pending_reconciliation'`
    )
      .bind(snapshot.installationId, installation?.incarnation ?? -1)
      .first<{ count: number }>()
  ]);
  if (
    !installation ||
    !delivery ||
    !claim ||
    !head ||
    !proof ||
    installation.state !== "pending_reconciliation" ||
    installation.last_delivery_id !== snapshot.sourceDeliveryId ||
    installation.app_id !== snapshot.appId ||
    installation.github_account_node_id !== snapshot.accountNodeId ||
    installation.repository_selection !== snapshot.repositorySelection ||
    delivery.installation_id !== snapshot.installationId ||
    delivery.incarnation !== installation.incarnation ||
    delivery.result !== "pending_reconciliation" ||
    claim.status !== "bound" ||
    claim.identity_status !== "active" ||
    claim.subject_token !== installation.subject_token ||
    claim.incarnation !== installation.incarnation ||
    claim.github_account_node_id !== snapshot.accountNodeId ||
    !claim.provider_proof_delivery_id ||
    proof.delivery_id !== claim.provider_proof_delivery_id ||
    proof.installation_id !== snapshot.installationId ||
    proof.incarnation !== installation.incarnation ||
    proof.github_account_node_id !== snapshot.accountNodeId ||
    proof.account_type !== "User" ||
    (proof.invalidated_at === null) !== (proof.invalidated_by_delivery_id === null) ||
    head.github_account_node_id !== snapshot.accountNodeId ||
    head.incarnation !== installation.incarnation ||
    head.account_type !== "User" ||
    head.creation_delivery_id !== claim.provider_proof_delivery_id ||
    head.latest_delivery_id !== snapshot.sourceDeliveryId ||
    head.latest_event_created_at !== delivery.event_created_at ||
    head.latest_action !== delivery.action ||
    !pendingDeliveries ||
    pendingDeliveries.count < 1 ||
    head.terminal !== 0
  ) {
    throw new ApiError(409, "github_personal_reconciliation_mismatch", "Missing-provider snapshot does not match the current pending personal installation.");
  }
  const at = nowIso();
  const expectedProofInvalidatedAt = proof.invalidated_at ?? at;
  const expectedProofInvalidatedBy = proof.invalidated_by_delivery_id ?? snapshot.sourceDeliveryId;
  const expectedProofChanges = proof.invalidated_at === null ? 1 : 0;
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_installation_release_reconciliations
        (reconciliation_id, payload_sha256, source_delivery_id, creation_delivery_id, installation_id,
         incarnation, github_account_node_id, lane, owner_ref, observed_at, result, applied_at)
       SELECT ?1, ?2, ?3, ?9, ?4, ?10, ?5, 'personal', ?6, ?7, 'released', ?8
        WHERE EXISTS (
          SELECT 1 FROM github_personal_installations
           WHERE installation_id = ?4 AND incarnation = ?10 AND subject_token = ?6 AND state = 'pending_reconciliation'
             AND last_delivery_id = ?3
        )`
    ).bind(
      snapshot.reconciliationId,
      payloadHash,
      snapshot.sourceDeliveryId,
      snapshot.installationId,
      snapshot.accountNodeId,
      installation.subject_token,
      snapshot.observedAt,
      at,
      claim.provider_proof_delivery_id,
      installation.incarnation
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installation_lifecycle_heads
          SET latest_action = 'provider_not_found', terminal = 1, updated_at = ?1
        WHERE installation_id = ?2 AND incarnation = ?9 AND github_account_node_id = ?3 AND account_type = 'User'
          AND creation_delivery_id = ?4 AND latest_delivery_id = ?5
          AND latest_event_created_at = ?6 AND latest_action = ?7
          AND terminal = 0
          AND EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations
             WHERE reconciliation_id = ?8 AND lane = 'personal' AND incarnation = ?9 AND result = 'released'
          )`
    ).bind(
      at,
      snapshot.installationId,
      snapshot.accountNodeId,
      claim.provider_proof_delivery_id,
      snapshot.sourceDeliveryId,
      delivery.event_created_at,
      delivery.action,
      snapshot.reconciliationId,
      installation.incarnation
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installation_provider_proofs
          SET invalidated_at = ?1, invalidated_by_delivery_id = ?2
        WHERE delivery_id = ?3 AND installation_id = ?4 AND incarnation = ?6 AND github_account_node_id = ?5
          AND account_type = 'User' AND invalidated_at IS NULL
          AND EXISTS (
            SELECT 1 FROM github_installation_lifecycle_heads
             WHERE installation_id = ?4 AND incarnation = ?6 AND latest_delivery_id = ?2
               AND latest_action = 'provider_not_found' AND terminal = 1
          )`
    ).bind(
      at,
      snapshot.sourceDeliveryId,
      claim.provider_proof_delivery_id,
      snapshot.installationId,
      snapshot.accountNodeId,
      installation.incarnation
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_deliveries SET result = 'rejected', received_at = ?1
        WHERE installation_id = ?2 AND incarnation = ?5 AND subject_token = ?3
          AND result = 'pending_reconciliation'
          AND EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations
             WHERE reconciliation_id = ?4 AND incarnation = ?5 AND result = 'released'
          )`
    ).bind(at, snapshot.installationId, installation.subject_token, snapshot.reconciliationId, installation.incarnation),
    env.TEAM_CONTROL_DB.prepare(
      `DELETE FROM github_personal_installations
        WHERE installation_id = ?1 AND incarnation = ?5 AND subject_token = ?2 AND state = 'pending_reconciliation'
          AND last_delivery_id = ?3
          AND EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations
             WHERE reconciliation_id = ?4 AND incarnation = ?5 AND result = 'released'
          )`
    ).bind(snapshot.installationId, installation.subject_token, snapshot.sourceDeliveryId, snapshot.reconciliationId, installation.incarnation),
    env.TEAM_CONTROL_DB.prepare(
      `DELETE FROM individual_session_mutations
        WHERE session_sha256 = ?1 AND action = 'installation_claim' AND subject_token = ?2
          AND EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations
             WHERE reconciliation_id = ?3 AND incarnation = ?4 AND result = 'released'
          )`
    ).bind(claim.claimed_session_sha256, installation.subject_token, snapshot.reconciliationId, installation.incarnation),
    env.TEAM_CONTROL_DB.prepare(
      `DELETE FROM github_personal_installation_claims
        WHERE installation_id = ?1 AND incarnation = ?6 AND subject_token = ?2 AND github_account_node_id = ?3
          AND status = 'bound' AND provider_proof_delivery_id = ?4
          AND NOT EXISTS (SELECT 1 FROM github_personal_installations WHERE installation_id = ?1)
          AND EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations
             WHERE reconciliation_id = ?5 AND incarnation = ?6 AND result = 'released'
          )`
    ).bind(
      snapshot.installationId,
      installation.subject_token,
      snapshot.accountNodeId,
      claim.provider_proof_delivery_id,
      snapshot.reconciliationId,
      installation.incarnation
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_identities SET eligible_at = NULL, updated_at = ?1
        WHERE subject_token = ?2 AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM github_installation_release_reconciliations
             WHERE reconciliation_id = ?3 AND lane = 'personal' AND incarnation = ?4 AND result = 'released'
          )`
    ).bind(at, installation.subject_token, snapshot.reconciliationId, installation.incarnation),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      subjectToken: installation.subject_token,
      actorType: "github_app",
      action: "github.personal_installation.provider_not_found_released",
      resourceType: "github_personal_installation",
      at
    }),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'github_personal_not_found_release', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM github_installation_release_reconciliations
              WHERE reconciliation_id = ?2 AND lane = 'personal' AND incarnation = ?10 AND result = 'released'
           )
           AND EXISTS (
             SELECT 1 FROM github_installation_lifecycle_heads
              WHERE installation_id = ?3 AND incarnation = ?10 AND latest_action = 'provider_not_found' AND terminal = 1
           )
           AND EXISTS (
             SELECT 1 FROM github_installation_provider_proofs
              WHERE delivery_id = ?4 AND incarnation = ?10 AND invalidated_at = ?5
                AND invalidated_by_delivery_id = ?6
           )
           AND EXISTS (
             SELECT 1 FROM github_personal_deliveries
              WHERE delivery_id = ?7 AND incarnation = ?10 AND result = 'rejected'
           )
           AND NOT EXISTS (
             SELECT 1 FROM github_personal_deliveries
              WHERE installation_id = ?3 AND incarnation = ?10 AND result = 'pending_reconciliation'
           )
           AND NOT EXISTS (SELECT 1 FROM github_personal_installations WHERE installation_id = ?3 AND incarnation = ?10)
           AND NOT EXISTS (SELECT 1 FROM github_personal_installation_claims WHERE installation_id = ?3 AND incarnation = ?10)
           AND NOT EXISTS (
             SELECT 1 FROM individual_session_mutations
              WHERE session_sha256 = ?8 AND action = 'installation_claim'
           )
           AND EXISTS (
             SELECT 1 FROM individual_identities
              WHERE subject_token = ?11 AND status = 'active' AND eligible_at IS NULL
           )
         THEN 1 ELSE 0 END, ?9)`
    ).bind(
      `integrity_${snapshot.reconciliationId}`,
      snapshot.reconciliationId,
      snapshot.installationId,
      claim.provider_proof_delivery_id,
      expectedProofInvalidatedAt,
      expectedProofInvalidatedBy,
      snapshot.sourceDeliveryId,
      claim.claimed_session_sha256,
      at,
      installation.incarnation,
      installation.subject_token
    )
  ]);
  const exactChanges = [1, 1, expectedProofChanges, pendingDeliveries.count, 1, 1, 1, 1, 1, 1];
  for (const [index, expectedChanges] of exactChanges.entries()) {
    if ((results[index]?.meta.changes ?? 0) !== expectedChanges) {
      throw new ApiError(409, "github_personal_reconciliation_concurrent_conflict", "Provider-not-found release changed concurrently.");
    }
  }
  return jsonResponse({ reconciled: false, released: true, account_type: "User" });
}
