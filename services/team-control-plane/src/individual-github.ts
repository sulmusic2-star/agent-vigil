import { nowIso } from "./db.ts";
import type { IndividualAuthContext } from "./individual-auth.ts";
import { requireIndividualFeatureConfiguration } from "./individual-config.ts";
import {
  individualAuditStatement,
  loadIndividualIdentity,
  refreshIndividualEligibility,
  requestMutationHash,
  sessionMutationReplay,
  sessionMutationStatement
} from "./individual-measurement.ts";
import { ApiError, jsonResponse, parseJsonObject } from "./http.ts";
import { assertExactKeys, requireInteger } from "./validation.ts";

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
  providerStatus: "active";
  repositorySelection: PersonalRepositorySelection;
}

export interface PersonalDeliveryRow {
  delivery_id: string;
  payload_sha256: string;
  event_name: PersonalGitHubEventName;
  action: PersonalGitHubAction;
  installation_id: number;
  subject_token: string | null;
  account_type: "User";
  event_created_at: number;
  result: "unclaimed" | "pending_reconciliation" | "applied" | "revoked" | "stale" | "rejected";
}

interface PersonalClaimRow {
  installation_id: number;
  github_account_node_id: string;
  subject_token: string;
  account_type: "User";
  status: "claimed" | "bound" | "revoked";
  identity_status: "active" | "merged";
}

interface PersonalInstallationRow {
  installation_id: number;
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
      `SELECT c.installation_id, c.github_account_node_id, c.subject_token, c.account_type,
              c.status, i.status AS identity_status
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
      `SELECT installation_id, app_id, github_account_node_id, subject_token, account_type,
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
      `SELECT delivery_id, payload_sha256, event_name, action, installation_id,
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
  assertExactKeys(body, ["schema_version", "installation_id"]);
  if (body.schema_version !== "github-personal-installation-claim-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be github-personal-installation-claim-v1.");
  }
  const installationId = requireInteger(body.installation_id, "installation_id", { min: 1 });
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
  const at = nowIso();
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_personal_installation_claims
        (installation_id, github_account_node_id, subject_token, account_type, status,
         claimed_session_sha256, claimed_at, updated_at)
       VALUES (?1, ?2, ?3, 'User', 'claimed', ?4, ?5, ?5)`
    ).bind(installationId, identity.github_account_node_id, identity.subject_token, auth.sessionSha256, at),
    sessionMutationStatement(env.TEAM_CONTROL_DB, auth, "installation_claim", hash, identity.subject_token, at),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      subjectToken: identity.subject_token,
      actorType: "human_session",
      actorSessionSha256: auth.sessionSha256,
      action: "github.personal_installation.claimed",
      resourceType: "github_personal_installation",
      at
    })
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
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
      (delivery_id, payload_sha256, event_name, action, installation_id, subject_token,
       account_type, event_created_at, result, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'User', ?6, 'unclaimed', ?7)`
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
    claim.account_type !== "User"
  ) {
    await recordUnclaimed(env, existingDelivery, deliveryId, payloadHash, summary);
    throw new ApiError(409, "github_personal_installation_claim_required", "A matching authenticated personal claim is required.");
  }
  const installation = await personalInstallation(env.TEAM_CONTROL_DB, summary.installationId);
  if (installation) {
    if (
      installation.subject_token !== claim.subject_token ||
      installation.github_account_node_id !== summary.accountNodeId ||
      installation.app_id !== summary.appId ||
      installation.account_type !== "User"
    ) {
      throw new ApiError(409, "github_personal_installation_binding_mismatch", "Personal installation binding does not match its claim.");
    }
    if (
      summary.eventCreatedAt < installation.last_event_created_at ||
      (summary.eventCreatedAt === installation.last_event_created_at && deliveryId !== installation.last_delivery_id)
    ) {
      const at = nowIso();
      await env.TEAM_CONTROL_DB.batch([
        existingDelivery
          ? env.TEAM_CONTROL_DB.prepare(
              `UPDATE github_personal_deliveries SET subject_token = ?1, result = 'stale', received_at = ?2
                WHERE delivery_id = ?3`
            ).bind(claim.subject_token, at, deliveryId)
          : env.TEAM_CONTROL_DB.prepare(
              `INSERT INTO github_personal_deliveries
                (delivery_id, payload_sha256, event_name, action, installation_id, subject_token,
                 account_type, event_created_at, result, received_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'User', ?7, 'stale', ?8)`
            ).bind(
              deliveryId,
              payloadHash,
              summary.eventName,
              summary.action,
              summary.installationId,
              claim.subject_token,
              summary.eventCreatedAt,
              at
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
    const results = await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO github_personal_installations
          (installation_id, app_id, github_account_node_id, subject_token, account_type, state,
           repository_selection, last_event_created_at, last_delivery_id, installed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'User', 'pending_reconciliation', ?5, ?6, ?7, ?8, ?9)`
      ).bind(
        summary.installationId,
        summary.appId,
        summary.accountNodeId,
        claim.subject_token,
        summary.repositorySelection,
        summary.eventCreatedAt,
        deliveryId,
        summary.eventCreatedIso,
        at
      ),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE github_personal_installation_claims SET status = 'bound', updated_at = ?1
          WHERE installation_id = ?2 AND subject_token = ?3 AND github_account_node_id = ?4`
      ).bind(at, summary.installationId, claim.subject_token, summary.accountNodeId),
      existingDelivery
        ? env.TEAM_CONTROL_DB.prepare(
            `UPDATE github_personal_deliveries SET subject_token = ?1,
               result = 'pending_reconciliation', received_at = ?2 WHERE delivery_id = ?3`
          ).bind(claim.subject_token, at, deliveryId)
        : env.TEAM_CONTROL_DB.prepare(
            `INSERT INTO github_personal_deliveries
              (delivery_id, payload_sha256, event_name, action, installation_id, subject_token,
               account_type, event_created_at, result, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'User', ?7, 'pending_reconciliation', ?8)`
          ).bind(
            deliveryId,
            payloadHash,
            summary.eventName,
            summary.action,
            summary.installationId,
            claim.subject_token,
            summary.eventCreatedAt,
            at
          ),
      individualAuditStatement(env.TEAM_CONTROL_DB, {
        subjectToken: claim.subject_token,
        actorType: "github_app",
        action: "github.personal_installation.created_pending_reconciliation",
        resourceType: "github_personal_installation",
        metadata: { account_type: "User", repository_selection: summary.repositorySelection },
        at
      })
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) {
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
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_installations SET state = ?1, repository_selection = ?2,
         last_event_created_at = ?3, last_delivery_id = ?4, last_reconciliation_id = NULL,
         suspended_at = ?5, deleted_at = ?6, reconciled_at = NULL, updated_at = ?7
       WHERE installation_id = ?8 AND last_event_created_at = ?9 AND last_delivery_id = ?10`
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
      installation.last_delivery_id
    ),
    existingDelivery
      ? env.TEAM_CONTROL_DB.prepare(
          `UPDATE github_personal_deliveries SET subject_token = ?1, result = ?2, received_at = ?3
            WHERE delivery_id = ?4`
        ).bind(claim.subject_token, result, at, deliveryId)
      : env.TEAM_CONTROL_DB.prepare(
          `INSERT INTO github_personal_deliveries
            (delivery_id, payload_sha256, event_name, action, installation_id, subject_token,
             account_type, event_created_at, result, received_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'User', ?7, ?8, ?9)`
        ).bind(
          deliveryId,
          payloadHash,
          summary.eventName,
          summary.action,
          summary.installationId,
          claim.subject_token,
          summary.eventCreatedAt,
          result,
          at
        ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_installation_claims SET status = 'revoked', updated_at = ?1
        WHERE installation_id = ?2 AND ?3 = 'deleted'`
    ).bind(at, summary.installationId, nextState),
    individualAuditStatement(env.TEAM_CONTROL_DB, {
      subjectToken: claim.subject_token,
      actorType: "github_app",
      action: `github.personal_installation.${summary.action}`,
      resourceType: "github_personal_installation",
      metadata: { state: nextState, repository_selection: summary.repositorySelection },
      at
    })
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
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
    installation.state !== "pending_reconciliation" ||
    installation.last_delivery_id !== snapshot.sourceDeliveryId ||
    installation.app_id !== snapshot.appId ||
    installation.github_account_node_id !== snapshot.accountNodeId ||
    installation.account_type !== "User" ||
    installation.repository_selection !== snapshot.repositorySelection ||
    claim.identity_status !== "active" ||
    claim.status === "revoked" ||
    claim.subject_token !== installation.subject_token ||
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
       WHERE installation_id = ?3 AND state = 'pending_reconciliation' AND last_delivery_id = ?4`
    ).bind(snapshot.reconciliationId, at, snapshot.installationId, snapshot.sourceDeliveryId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_personal_installation_reconciliations
        (reconciliation_id, payload_sha256, source_delivery_id, installation_id,
         subject_token, account_type, observed_at, result, applied_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'User', ?6, 'applied', ?7
        WHERE EXISTS (
          SELECT 1 FROM github_personal_installations
           WHERE installation_id = ?4 AND last_reconciliation_id = ?1 AND state = 'active'
        )`
    ).bind(
      snapshot.reconciliationId,
      payloadHash,
      snapshot.sourceDeliveryId,
      snapshot.installationId,
      installation.subject_token,
      snapshot.observedAt,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_personal_deliveries SET result = 'applied'
        WHERE delivery_id = ?1
          AND EXISTS (
            SELECT 1 FROM github_personal_installations
             WHERE installation_id = ?2 AND last_reconciliation_id = ?3 AND state = 'active'
          )`
    ).bind(snapshot.sourceDeliveryId, snapshot.installationId, snapshot.reconciliationId),
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
