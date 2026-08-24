import type { AuthContext } from "./auth.ts";
import { requireRole } from "./auth.ts";
import { randomOpaqueToken, sha256Hex, timingSafeHexEqual } from "./crypto.ts";
import { commercialActorPseudonym } from "./commercial-privacy.ts";
import { auditStatement, newId, nowIso, userAudit } from "./db.ts";
import { ApiError, jsonResponse } from "./http.ts";
import { exportOrganizationMeasurement } from "./measurement.ts";
import { assertBillingDutySecretSeparation } from "./measurement-security.ts";

interface DeletionRequestRow {
  id: string;
  confirmation_sha256: string;
  status: string;
  expires_at: string;
}

async function allRows(db: D1Database, sql: string, orgId: string): Promise<unknown[]> {
  return (await db.prepare(sql).bind(orgId).all()).results;
}

export async function exportOrganizationData(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner"]);
  const db = env.TEAM_CONTROL_DB;
  const [
    organization,
    members,
    policies,
    history,
    exceptions,
    rollbacks,
    checkoutIntents,
    billingCommands,
    deletionRequests,
    entitlement,
    cash,
    revenue,
    audit,
    githubClaim,
    githubInstallation,
    githubRepositories,
    measurement
  ] =
    await Promise.all([
      db.prepare(`SELECT id, slug, display_name, status, created_at, deleted_at FROM organizations WHERE id = ?1`)
        .bind(auth.orgId)
        .first(),
      allRows(db, `SELECT user_id, role, identity_kind, active, created_at, updated_at FROM organization_members WHERE org_id = ?1`, auth.orgId),
      allRows(db, `SELECT revision, policy_json, canary_metadata_json, required_gate_enabled, created_by, created_at FROM policy_revisions WHERE org_id = ?1 ORDER BY revision`, auth.orgId),
      allRows(db, `SELECT id, pair_token, verdict, disposition, receipt_sha256, actor_user_id, created_at FROM update_history WHERE org_id = ?1 ORDER BY created_at`, auth.orgId),
      allRows(db, `SELECT id, pair_token, reason, state, expires_at, created_by, created_at, updated_at FROM exception_records WHERE org_id = ?1 ORDER BY created_at`, auth.orgId),
      allRows(db, `SELECT id, pair_token, from_ref_token, to_ref_token, reason, created_by, created_at FROM rollback_records WHERE org_id = ?1 ORDER BY created_at`, auth.orgId),
      allRows(
        db,
        `SELECT id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
                contributor_limit, status, provider_session_id, created_by AS actor_pseudonym,
                created_at, expires_at, compensated_at
           FROM checkout_intents WHERE org_id = ?1 ORDER BY created_at`,
        auth.orgId
      ),
      allRows(
        db,
        `SELECT id, command_type, idempotency_key, status, created_by AS actor_pseudonym,
                created_at, compensated_at
           FROM billing_commands WHERE org_id = ?1 ORDER BY created_at`,
        auth.orgId
      ),
      allRows(
        db,
        `SELECT id, status, requested_by AS actor_pseudonym, requested_at, expires_at, completed_at
           FROM privacy_deletion_requests WHERE org_id = ?1 ORDER BY requested_at`,
        auth.orgId
      ),
      db.prepare(`SELECT * FROM entitlements WHERE org_id = ?1`).bind(auth.orgId).first(),
      allRows(db, `SELECT id, source_event_id, entry_type, amount_cents, currency, occurred_at FROM cash_ledger WHERE org_id = ?1 ORDER BY occurred_at`, auth.orgId),
      allRows(db, `SELECT id, source_event_id, entry_type, recognized_mrr_delta_micros, currency, recognized_period_start, recognized_period_end, occurred_at FROM revenue_ledger WHERE org_id = ?1 ORDER BY occurred_at`, auth.orgId),
      allRows(db, `SELECT id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at FROM audit_events WHERE org_id = ?1 ORDER BY created_at`, auth.orgId),
      db.prepare(
        `SELECT installation_id, github_account_node_id, status, claimed_by, claimed_at, updated_at
           FROM github_installation_claims WHERE org_id = ?1`
      )
        .bind(auth.orgId)
        .first(),
      db.prepare(
        `SELECT installation_id, app_id, github_account_node_id, state, repository_selection,
                last_event_created_at, last_delivery_id, last_reconciliation_id, installed_at,
                suspended_at, deleted_at, reconciled_at, updated_at
           FROM github_installations WHERE org_id = ?1`
      )
        .bind(auth.orgId)
        .first(),
      allRows(
        db,
        `SELECT r.installation_id, r.repository_node_id, r.selected, r.updated_at
           FROM github_installation_repositories r
           JOIN github_installations i ON i.installation_id = r.installation_id
          WHERE i.org_id = ?1 ORDER BY r.repository_node_id`,
        auth.orgId
      ),
      exportOrganizationMeasurement(db, auth.orgId)
    ]);
  const generatedAt = nowIso();
  const exportId = newId("privacy_export");
  await userAudit(db, auth, "privacy.export.generated", "privacy_export", exportId, generatedAt).run();
  return jsonResponse({
    schema_version: "team-privacy-export-v1",
    export_id: exportId,
    generated_at: generatedAt,
    organization,
    members,
    policy_revisions: policies,
    private_history: history,
    exceptions,
    rollbacks,
    checkout_intents: checkoutIntents,
    billing_commands: billingCommands,
    deletion_requests: deletionRequests,
    entitlement,
    cash_ledger: cash,
    recognized_mrr_ledger: revenue,
    github_app: {
      claim: githubClaim,
      installation: githubInstallation,
      repositories: githubRepositories,
      stores_repository_names_or_source: false
    },
    r0_measurement: measurement,
    audit_events: audit,
    retained_outside_deletion: [
      "provider-confirmed billing records required for accounting, chargeback, fraud, and legal obligations",
      "terminal pre-provider command records retained without raw user identifiers"
    ],
    commercial_actor_identity: "HMAC-pseudonymous per organization; raw authenticated user IDs are not written to retained billing or deletion-request rows"
  });
}

export async function requestOrganizationDeletion(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner"]);
  assertBillingDutySecretSeparation(env);
  const db = env.TEAM_CONTROL_DB;
  const existing = await db
    .prepare(
      `SELECT id, confirmation_sha256, status, expires_at FROM privacy_deletion_requests
        WHERE org_id = ?1 AND status = 'pending' AND expires_at > ?2 ORDER BY requested_at DESC LIMIT 1`
    )
    .bind(auth.orgId, nowIso())
    .first<DeletionRequestRow>();
  if (existing) {
    throw new ApiError(409, "deletion_already_pending", "A deletion request is already pending.");
  }
  const activeSubscription = await db.prepare(
    `SELECT 1 FROM billing_accounts
      WHERE org_id = ?1 AND provider_subscription_id IS NOT NULL
        AND commercial_state NOT IN ('expired', 'refunded')`
  )
    .bind(auth.orgId)
    .first();
  if (activeSubscription) {
    throw new ApiError(
      409,
      "active_subscription_requires_cancellation",
      "Cancel and reconcile the active provider subscription before requesting data deletion."
    );
  }
  const confirmation = randomOpaqueToken();
  const confirmationHash = await sha256Hex(confirmation);
  const requestId = newId("deletion");
  const at = nowIso();
  const actorPseudonym = await commercialActorPseudonym(env, auth.orgId, auth.userId);
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const compensationLeaseId = newId("checkout_compensation_lease");
  const compensationLeaseExpiresAt = at;
  let results: D1Result[];
  try {
    results = await db.batch([
    db.prepare(
      `INSERT INTO privacy_deletion_requests
        (id, org_id, confirmation_sha256, status, requested_by, requested_at, expires_at)
       SELECT ?1, ?2, ?3, 'pending', ?4, ?5, ?6
        WHERE EXISTS (SELECT 1 FROM organizations WHERE id = ?2 AND status = 'active')
          AND NOT EXISTS (
            SELECT 1 FROM billing_accounts
             WHERE org_id = ?2 AND provider_subscription_id IS NOT NULL
               AND commercial_state NOT IN ('expired', 'refunded')
          )`
    ).bind(requestId, auth.orgId, confirmationHash, actorPseudonym, at, expiresAt),
    db.prepare(
      `UPDATE organizations SET status = 'deletion_pending'
        WHERE id = ?1 AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM privacy_deletion_requests
             WHERE id = ?2 AND org_id = ?1 AND status = 'pending'
          )`
    ).bind(auth.orgId, requestId),
    db.prepare(
      `UPDATE checkout_intents
          SET status = 'canceled', execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE org_id = ?1 AND status = 'prepared'
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deletion_pending')
          AND EXISTS (SELECT 1 FROM privacy_deletion_requests WHERE id = ?2 AND status = 'pending')`
    ).bind(auth.orgId, requestId),
    db.prepare(
      `UPDATE billing_commands
          SET status = 'canceled', execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE org_id = ?1 AND status = 'prepared'
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deletion_pending')
          AND EXISTS (SELECT 1 FROM privacy_deletion_requests WHERE id = ?2 AND status = 'pending')`
    ).bind(auth.orgId, requestId),
    db.prepare(
      `UPDATE checkout_intents
          SET status = 'compensating', execution_lease_id = ?1, execution_lease_expires_at = ?2
        WHERE org_id = ?3 AND status = 'provider_created' AND provider_session_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?3 AND status = 'deletion_pending')
          AND EXISTS (SELECT 1 FROM privacy_deletion_requests WHERE id = ?4 AND status = 'pending')`
    ).bind(compensationLeaseId, compensationLeaseExpiresAt, auth.orgId, requestId),
    db.prepare(
      `UPDATE billing_commands
          SET status = 'compensating', execution_lease_id = ?1, execution_lease_expires_at = ?2
        WHERE org_id = ?3 AND command_type = 'create_checkout_session' AND status = 'provider_accepted'
          AND EXISTS (
            SELECT 1 FROM checkout_intents i
             WHERE i.org_id = ?3 AND i.status = 'compensating'
               AND i.id = json_extract(billing_commands.command_json, '$.parameters.metadata.checkout_intent_id')
          )
          AND EXISTS (SELECT 1 FROM privacy_deletion_requests WHERE id = ?4 AND status = 'pending')`
    ).bind(compensationLeaseId, compensationLeaseExpiresAt, auth.orgId, requestId),
    db.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'user', ?3, 'privacy.deletion.requested',
              'privacy_deletion_request', ?4, '{}', ?5
        WHERE EXISTS (SELECT 1 FROM privacy_deletion_requests WHERE id = ?4 AND status = 'pending')`
    ).bind(newId("audit"), auth.orgId, auth.userId, requestId, at)
    ]);
  } catch (error) {
    const competing = await db.prepare(
      `SELECT 1 AS found FROM privacy_deletion_requests
        WHERE org_id = ?1 AND status = 'pending' LIMIT 1`
    )
      .bind(auth.orgId)
      .first<{ found: number }>();
    if (competing) {
      throw new ApiError(409, "deletion_state_conflict", "Organization deletion state changed concurrently.");
    }
    throw error;
  }
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[6]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "deletion_state_conflict", "Organization deletion state changed concurrently.");
  }
  return jsonResponse(
    {
      request_id: requestId,
      confirmation,
      expires_at: expiresAt,
      warning: "This confirmation is shown once. Billing execution is frozen. Confirm only after any in-flight checkout reports terminal compensation."
    },
    202
  );
}

export async function confirmOrganizationDeletion(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner"]);
  const confirmation = request.headers.get("X-Deletion-Confirmation");
  if (!confirmation || confirmation.length > 256) {
    throw new ApiError(428, "deletion_confirmation_required", "X-Deletion-Confirmation is required.");
  }
  const db = env.TEAM_CONTROL_DB;
  const pending = await db
    .prepare(
      `SELECT id, confirmation_sha256, status, expires_at FROM privacy_deletion_requests
        WHERE org_id = ?1 AND status = 'pending' ORDER BY requested_at DESC LIMIT 1`
    )
    .bind(auth.orgId)
    .first<DeletionRequestRow>();
  const providedHash = await sha256Hex(confirmation);
  if (!pending || Date.parse(pending.expires_at) <= Date.now() || !timingSafeHexEqual(pending.confirmation_sha256, providedHash)) {
    throw new ApiError(403, "invalid_deletion_confirmation", "Deletion confirmation is invalid or expired.");
  }
  const organization = await db.prepare(`SELECT status FROM organizations WHERE id = ?1`)
    .bind(auth.orgId)
    .first<{ status: string }>();
  if (organization?.status !== "deletion_pending") {
    throw new ApiError(409, "deletion_state_conflict", "Organization is not frozen for deletion.");
  }
  const activeProviderState = await db
    .prepare(
      `SELECT commercial_state FROM billing_accounts
        WHERE org_id = ?1 AND provider_subscription_id IS NOT NULL
          AND commercial_state NOT IN ('expired', 'refunded')
       UNION ALL
       SELECT status AS commercial_state FROM checkout_intents
        WHERE org_id = ?1 AND status IN ('executing', 'provider_created', 'compensating')
       UNION ALL
       SELECT status AS commercial_state FROM billing_commands
        WHERE org_id = ?1 AND status IN ('executing', 'compensating')
       LIMIT 1`
    )
    .bind(auth.orgId)
    .first<{ commercial_state: string }>();
  if (activeProviderState) {
    throw new ApiError(
      409,
      "provider_cleanup_incomplete",
      "Provider subscription cancellation or checkout compensation is not terminal."
    );
  }
  const at = nowIso();
  const tombstone = (await sha256Hex(auth.orgId)).slice(0, 16);
  const results = await db.batch([
    db.prepare(
      `UPDATE organizations
          SET slug = ?1, display_name = 'Deleted organization', status = 'deleted', deleted_at = ?2
        WHERE id = ?3 AND status = 'deletion_pending'
          AND NOT EXISTS (
            SELECT 1 FROM billing_accounts
             WHERE org_id = ?3 AND provider_subscription_id IS NOT NULL
               AND commercial_state NOT IN ('expired', 'refunded')
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE org_id = ?3 AND status IN ('executing', 'provider_created', 'compensating')
          )
          AND NOT EXISTS (
            SELECT 1 FROM billing_commands
             WHERE org_id = ?3 AND status IN ('executing', 'compensating')
          )`
    ).bind(`deleted-${tombstone}`, at, auth.orgId),
    db.prepare(
      `UPDATE checkout_intents SET status = 'canceled'
        WHERE org_id = ?1 AND status = 'prepared'
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `UPDATE billing_commands SET status = 'canceled'
        WHERE org_id = ?1 AND status = 'prepared'
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM measurement_events WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM measurement_subject_attestations
        WHERE subject_token IN (
          SELECT subject_token FROM measurement_subjects WHERE org_id = ?1
        ) AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM measurement_bridge_messages WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM measurement_subjects WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM measurement_consents WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM github_installation_reconciliations WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM github_deliveries
        WHERE (org_id = ?1 OR installation_id IN (
          SELECT installation_id FROM github_installations WHERE org_id = ?1
        )) AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM github_installation_repositories
        WHERE installation_id IN (
          SELECT installation_id FROM github_installations WHERE org_id = ?1
        ) AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM github_installations WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM github_installation_provider_proofs
        WHERE delivery_id IN (
          SELECT provider_proof_delivery_id FROM github_installation_claims WHERE org_id = ?1
        ) AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM github_installation_claims WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM policy_heads WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM policy_revisions WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM update_history WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM exception_records WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM rollback_records WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM organization_members WHERE org_id = ?1
        AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `DELETE FROM audit_events
        WHERE org_id = ?1
          AND (
            action GLOB 'measurement.*' OR
            resource_type GLOB 'measurement_*' OR
            actor_id GLOB 'r0-measurement-*' OR
            resource_id GLOB 'morg_*' OR
            instr(metadata_json, 'morg_') > 0 OR
            action GLOB 'github.*' OR
            resource_type GLOB 'github_*' OR
            actor_id GLOB 'github-app:*'
          )
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `UPDATE audit_events SET actor_id = 'deleted_user', metadata_json = '{}'
        WHERE org_id = ?1 AND actor_type = 'user'
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'deleted' AND deleted_at = ?2)`
    ).bind(auth.orgId, at),
    db.prepare(
      `UPDATE privacy_deletion_requests SET status = 'completed', completed_at = ?1,
        confirmation_sha256 = ?2 WHERE id = ?3 AND status = 'pending'
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?4 AND status = 'deleted' AND deleted_at = ?1)`
    ).bind(at, "0".repeat(64), pending.id, auth.orgId),
    db.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'system', 'deleted_user', 'privacy.deletion.completed',
              'privacy_deletion_request', ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM organizations WHERE id = ?2 AND status = 'deleted' AND deleted_at = ?5
        ) AND EXISTS (
          SELECT 1 FROM privacy_deletion_requests
           WHERE id = ?3 AND status = 'completed' AND completed_at = ?5
        )`
    ).bind(
      newId("audit"),
      auth.orgId,
      pending.id,
      JSON.stringify({ commercial_records_retained: true }),
      at
    )
  ]);
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[22]?.meta.changes ?? 0) !== 1 ||
    (results[23]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "provider_cleanup_incomplete", "Provider cleanup changed before deletion could commit.");
  }
  return jsonResponse(
    {
      deleted: true,
      access_revoked: true,
      retained: "Minimal commercial records remain isolated for accounting, refunds, chargebacks, fraud, and legal retention."
    },
    202
  );
}
