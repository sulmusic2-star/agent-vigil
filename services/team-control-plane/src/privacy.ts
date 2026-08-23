import type { AuthContext } from "./auth.ts";
import { requireRole } from "./auth.ts";
import { randomOpaqueToken, sha256Hex, timingSafeHexEqual } from "./crypto.ts";
import { auditStatement, newId, nowIso, userAudit } from "./db.ts";
import { ApiError, jsonResponse } from "./http.ts";

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
    entitlement,
    cash,
    revenue,
    audit,
    githubClaim,
    githubInstallation,
    githubRepositories
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
      )
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
    entitlement,
    cash_ledger: cash,
    recognized_mrr_ledger: revenue,
    github_app: {
      claim: githubClaim,
      installation: githubInstallation,
      repositories: githubRepositories,
      stores_repository_names_or_source: false
    },
    audit_events: audit,
    retained_outside_deletion: [
      "provider-confirmed billing records required for accounting, chargeback, fraud, and legal obligations"
    ]
  });
}

export async function requestOrganizationDeletion(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner"]);
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
  const confirmation = randomOpaqueToken();
  const confirmationHash = await sha256Hex(confirmation);
  const requestId = newId("deletion");
  const at = nowIso();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO privacy_deletion_requests
        (id, org_id, confirmation_sha256, status, requested_by, requested_at, expires_at)
       VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6)`
    ).bind(requestId, auth.orgId, confirmationHash, auth.userId, at, expiresAt),
    userAudit(db, auth, "privacy.deletion.requested", "privacy_deletion_request", requestId, at)
  ]);
  return jsonResponse(
    {
      request_id: requestId,
      confirmation,
      expires_at: expiresAt,
      warning: "This confirmation is shown once. Confirming removes private product data and revokes access. Minimal commercial records remain under documented retention."
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
  const activeProviderState = await db
    .prepare(
      `SELECT commercial_state FROM billing_accounts
        WHERE org_id = ?1 AND provider_subscription_id IS NOT NULL
          AND commercial_state NOT IN ('expired', 'refunded')
       UNION ALL
       SELECT status AS commercial_state FROM checkout_intents
        WHERE org_id = ?1 AND status = 'provider_created'
       LIMIT 1`
    )
    .bind(auth.orgId)
    .first<{ commercial_state: string }>();
  if (activeProviderState) {
    throw new ApiError(
      409,
      "active_subscription_requires_cancellation",
      "Cancel the active provider subscription before confirming data deletion."
    );
  }
  const at = nowIso();
  const tombstone = (await sha256Hex(auth.orgId)).slice(0, 16);
  const deletedGitHubAccount = `deleted-${tombstone}`;
  await db.batch([
    db.prepare(
      `UPDATE checkout_intents SET status = 'canceled'
        WHERE org_id = ?1 AND status = 'prepared'`
    ).bind(auth.orgId),
    db.prepare(
      `UPDATE billing_commands SET status = 'provider_rejected'
        WHERE org_id = ?1 AND status = 'prepared'`
    ).bind(auth.orgId),
    db.prepare(
      `DELETE FROM github_installation_repositories
        WHERE installation_id IN (
          SELECT installation_id FROM github_installations WHERE org_id = ?1
        )`
    ).bind(auth.orgId),
    db.prepare(
      `UPDATE github_installations SET state = 'deleted', deleted_at = ?1,
        github_account_node_id = ?2, suspended_at = NULL, reconciled_at = NULL, updated_at = ?1
        WHERE org_id = ?3`
    ).bind(at, deletedGitHubAccount, auth.orgId),
    db.prepare(
      `UPDATE github_installation_claims SET status = 'revoked', github_account_node_id = ?2,
        claimed_by = 'deleted_user', updated_at = ?1 WHERE org_id = ?3`
    ).bind(at, deletedGitHubAccount, auth.orgId),
    db.prepare(`DELETE FROM policy_heads WHERE org_id = ?1`).bind(auth.orgId),
    db.prepare(`DELETE FROM policy_revisions WHERE org_id = ?1`).bind(auth.orgId),
    db.prepare(`DELETE FROM update_history WHERE org_id = ?1`).bind(auth.orgId),
    db.prepare(`DELETE FROM exception_records WHERE org_id = ?1`).bind(auth.orgId),
    db.prepare(`DELETE FROM rollback_records WHERE org_id = ?1`).bind(auth.orgId),
    db.prepare(`DELETE FROM organization_members WHERE org_id = ?1`).bind(auth.orgId),
    db.prepare(
      `UPDATE audit_events SET actor_id = 'deleted_user', metadata_json = '{}'
        WHERE org_id = ?1 AND actor_type = 'user'`
    ).bind(auth.orgId),
    db.prepare(
      `UPDATE organizations SET slug = ?1, display_name = 'Deleted organization', status = 'deleted', deleted_at = ?2
        WHERE id = ?3`
    ).bind(`deleted-${tombstone}`, at, auth.orgId),
    db.prepare(
      `UPDATE privacy_deletion_requests SET status = 'completed', completed_at = ?1,
        confirmation_sha256 = ?2 WHERE id = ?3`
    ).bind(at, "0".repeat(64), pending.id),
    auditStatement(db, {
      orgId: auth.orgId,
      actorType: "system",
      actorId: "deleted_user",
      action: "privacy.deletion.completed",
      resourceType: "privacy_deletion_request",
      resourceId: pending.id,
      metadata: { commercial_records_retained: true },
      at
    })
  ]);
  return jsonResponse(
    {
      deleted: true,
      access_revoked: true,
      retained: "Minimal commercial records remain isolated for accounting, refunds, chargebacks, fraud, and legal retention."
    },
    202
  );
}
