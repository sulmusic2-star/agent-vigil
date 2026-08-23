import type { AuthContext, OrgRole } from "./auth.ts";
import { requireRole } from "./auth.ts";
import { getEntitlement, newId, nowIso, requireTeamEntitlement, userAudit } from "./db.ts";
import { ApiError, jsonResponse, readJsonObject } from "./http.ts";
import {
  assertExactKeys,
  requireBoolean,
  requireEnum,
  requireInteger,
  requireIsoDate,
  requireObject,
  requireOpaqueId,
  requireSha256,
  requireString,
  requireStringArray
} from "./validation.ts";

interface PolicyHeadRow {
  revision: number;
  policy_json: string;
  canary_metadata_json: string;
  required_gate_enabled: number;
  created_by: string;
  created_at: string;
}

interface CountRow {
  count: number;
}

interface MemberRow {
  user_id: string;
  role: OrgRole;
  identity_kind: "human" | "service";
  active: number;
  created_at: string;
  updated_at: string;
}

function parsePolicyBody(body: Record<string, unknown>): {
  baseRevision: number;
  requiredGateEnabled: boolean;
  policyJson: string;
  canaryMetadataJson: string;
} {
  assertExactKeys(body, ["schema_version", "base_revision", "required_gate_enabled", "policy", "canaries"]);
  if (body.schema_version !== "team-policy-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be team-policy-v1.");
  }
  const baseRevision = requireInteger(body.base_revision, "base_revision", { min: 0 });
  const requiredGateEnabled = requireBoolean(body.required_gate_enabled, "required_gate_enabled");
  const policy = requireObject(body.policy, "policy");
  assertExactKeys(policy, ["allowed_version_tokens", "denied_version_tokens", "required_canary_ids"]);
  const normalizedPolicy = {
    allowed_version_tokens: requireStringArray(policy.allowed_version_tokens, "allowed_version_tokens"),
    denied_version_tokens: requireStringArray(policy.denied_version_tokens, "denied_version_tokens"),
    required_canary_ids: requireStringArray(policy.required_canary_ids, "required_canary_ids")
  };
  if (!Array.isArray(body.canaries) || body.canaries.length > 64) {
    throw new ApiError(400, "invalid_field", "canaries must contain at most 64 metadata records.");
  }
  const seenCanaries = new Set<string>();
  const canaries = body.canaries.map((entry, index) => {
    const canary = requireObject(entry, `canaries[${index}]`);
    assertExactKeys(canary, ["id", "artifact_class", "description"]);
    const id = requireOpaqueId(canary.id, `canaries[${index}].id`);
    if (seenCanaries.has(id)) {
      throw new ApiError(400, "duplicate_canary", "Canary identifiers must be unique.");
    }
    seenCanaries.add(id);
    return {
      id,
      artifact_class: requireEnum(canary.artifact_class, `canaries[${index}].artifact_class`, [
        "manifest",
        "skill",
        "plugin",
        "mcp",
        "behavioral"
      ] as const),
      description: requireString(canary.description, `canaries[${index}].description`, { max: 240 })
    };
  });
  for (const canaryId of normalizedPolicy.required_canary_ids) {
    if (!seenCanaries.has(canaryId)) {
      throw new ApiError(400, "unknown_canary", "Every required canary must have a metadata record.");
    }
  }
  return {
    baseRevision,
    requiredGateEnabled,
    policyJson: JSON.stringify(normalizedPolicy),
    canaryMetadataJson: JSON.stringify(canaries)
  };
}

async function currentPolicy(db: D1Database, orgId: string): Promise<PolicyHeadRow | null> {
  return db
    .prepare(
      `SELECT h.revision, r.policy_json, r.canary_metadata_json, r.required_gate_enabled,
              r.created_by, r.created_at
         FROM policy_heads h
         JOIN policy_revisions r ON r.org_id = h.org_id AND r.revision = h.revision
        WHERE h.org_id = ?1`
    )
    .bind(orgId)
    .first<PolicyHeadRow>();
}

export async function getOrganization(env: Env, auth: AuthContext): Promise<Response> {
  const organization = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, slug, display_name, status, created_at FROM organizations WHERE id = ?1`
  )
    .bind(auth.orgId)
    .first();
  const entitlement = await getEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  return jsonResponse({ organization, membership: { role: auth.role, identity_kind: auth.identityKind }, entitlement });
}

export async function getPolicy(env: Env, auth: AuthContext): Promise<Response> {
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId, { allowReadOnly: true });
  const policy = await currentPolicy(env.TEAM_CONTROL_DB, auth.orgId);
  if (!policy) {
    throw new ApiError(404, "policy_not_found", "No Team policy has been created.");
  }
  return jsonResponse(
    {
      schema_version: "team-policy-v1",
      revision: policy.revision,
      required_gate_enabled: policy.required_gate_enabled === 1,
      policy: JSON.parse(policy.policy_json),
      canaries: JSON.parse(policy.canary_metadata_json),
      created_by: policy.created_by,
      created_at: policy.created_at
    },
    200,
    { ETag: `"${policy.revision}"` }
  );
}

export async function putPolicy(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "admin"]);
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  const parsed = parsePolicyBody(await readJsonObject(request));
  const expectedEtag = `"${parsed.baseRevision}"`;
  if (request.headers.get("If-Match") !== expectedEtag) {
    throw new ApiError(428, "revision_precondition_required", `If-Match must be ${expectedEtag}.`);
  }
  const head = await currentPolicy(env.TEAM_CONTROL_DB, auth.orgId);
  const currentRevision = head?.revision ?? 0;
  if (currentRevision !== parsed.baseRevision) {
    throw new ApiError(409, "policy_revision_conflict", "The policy was changed by another administrator.");
  }
  const revision = currentRevision + 1;
  const at = nowIso();
  const activeHumans = await env.TEAM_CONTROL_DB.prepare(
    `SELECT COUNT(*) AS count FROM organization_members
      WHERE org_id = ?1 AND active = 1 AND identity_kind = 'human'`
  )
    .bind(auth.orgId)
    .first<CountRow>();
  const conditional =
    currentRevision === 0
      ? "NOT EXISTS (SELECT 1 FROM policy_heads WHERE org_id = ?1)"
      : "EXISTS (SELECT 1 FROM policy_heads WHERE org_id = ?1 AND revision = ?7)";
  const statements: D1PreparedStatement[] = [
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO policy_revisions
        (org_id, revision, policy_json, canary_metadata_json, required_gate_enabled, created_by, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?8 WHERE ${conditional}`
    ).bind(
      auth.orgId,
      revision,
      parsed.policyJson,
      parsed.canaryMetadataJson,
      parsed.requiredGateEnabled ? 1 : 0,
      auth.userId,
      currentRevision,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO policy_heads (org_id, revision, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(org_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
       WHERE policy_heads.revision = ?4`
    ).bind(auth.orgId, revision, at, currentRevision),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'user', ?3, 'team.policy.updated', 'policy', ?4, ?5, ?6
        WHERE EXISTS (
          SELECT 1 FROM policy_revisions
           WHERE org_id = ?2 AND revision = ?7 AND created_by = ?3 AND created_at = ?6
        )`
    ).bind(
      newId("audit"),
      auth.orgId,
      auth.userId,
      String(revision),
      JSON.stringify({ required_gate_enabled: parsed.requiredGateEnabled }),
      at,
      revision
    )
  ];
  if ((activeHumans?.count ?? 0) >= 2) {
    statements.push(
      env.TEAM_CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO lifecycle_events
          (event_id, org_id, event_name, source_ref, event_day, created_at)
         SELECT ?1, ?2, 'shared_policy_enabled_v1', ?3, ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM policy_revisions
             WHERE org_id = ?2 AND revision = ?6 AND created_by = ?7 AND created_at = ?5
          )`
      ).bind(newId("life"), auth.orgId, `policy:${revision}`, at.slice(0, 10), at, revision, auth.userId)
    );
  }
  if (parsed.requiredGateEnabled) {
    statements.push(
      env.TEAM_CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO lifecycle_events
          (event_id, org_id, event_name, source_ref, event_day, created_at)
         SELECT ?1, ?2, 'required_gate_enabled_v1', ?3, ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM policy_revisions
             WHERE org_id = ?2 AND revision = ?6 AND created_by = ?7 AND created_at = ?5
          )`
      ).bind(newId("life"), auth.orgId, `policy:${revision}`, at.slice(0, 10), at, revision, auth.userId)
    );
  }
  const results = await env.TEAM_CONTROL_DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "policy_revision_conflict", "The policy was changed by another administrator.");
  }
  return jsonResponse({ schema_version: "team-policy-v1", revision }, 201, { ETag: `"${revision}"` });
}

export async function getGateState(env: Env, auth: AuthContext): Promise<Response> {
  const entitlement = await getEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  const policy = await currentPolicy(env.TEAM_CONTROL_DB, auth.orgId);
  const now = Date.now();
  const active = entitlement?.status === "active" && Date.parse(entitlement.ends_at) > now;
  const grace =
    entitlement?.status === "grace" && entitlement.grace_until !== null && Date.parse(entitlement.grace_until) > now;
  if (!active && !grace) {
    return jsonResponse({ decision: "BLOCK", reason: "trusted_team_entitlement_unavailable" }, 409);
  }
  if (!policy || policy.required_gate_enabled !== 1) {
    return jsonResponse({ decision: "BLOCK", reason: "required_gate_not_configured" }, 409);
  }
  return jsonResponse({
    decision: "ALLOW",
    policy_revision: policy.revision,
    required_gate_enabled: true,
    entitlement_status: entitlement.status
  });
}

export async function listMembers(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "admin"]);
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId, { allowReadOnly: true });
  const rows = await env.TEAM_CONTROL_DB.prepare(
    `SELECT user_id, role, identity_kind, active, created_at, updated_at
       FROM organization_members WHERE org_id = ?1 ORDER BY user_id`
  )
    .bind(auth.orgId)
    .all<MemberRow>();
  return jsonResponse({ members: rows.results.map((row) => ({ ...row, active: row.active === 1 })) });
}

export async function putMember(
  request: Request,
  env: Env,
  auth: AuthContext,
  targetUserId: string
): Promise<Response> {
  requireRole(auth, ["owner", "admin"]);
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  const body = await readJsonObject(request);
  assertExactKeys(body, ["role", "identity_kind", "active"]);
  const role = requireEnum(body.role, "role", ["owner", "admin", "billing", "member"] as const);
  const identityKind = requireEnum(body.identity_kind, "identity_kind", ["human", "service"] as const);
  const active = requireBoolean(body.active, "active");
  requireOpaqueId(targetUserId, "user_id");
  if (role !== "member" && identityKind !== "human") {
    throw new ApiError(400, "human_privileged_role_required", "Privileged organization roles require a human identity.");
  }

  const existing = await env.TEAM_CONTROL_DB.prepare(
    `SELECT user_id, role, identity_kind, active, created_at, updated_at
       FROM organization_members WHERE org_id = ?1 AND user_id = ?2`
  )
    .bind(auth.orgId, targetUserId)
    .first<MemberRow>();
  if (auth.role === "admin" && (role !== "member" || (existing && existing.role !== "member"))) {
    throw new ApiError(403, "privileged_role_requires_owner", "Only an owner can manage privileged roles.");
  }
  if (existing?.role === "owner" && (!active || role !== "owner")) {
    const owners = await env.TEAM_CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM organization_members
        WHERE org_id = ?1 AND role = 'owner' AND active = 1`
    )
      .bind(auth.orgId)
      .first<CountRow>();
    if ((owners?.count ?? 0) <= 1) {
      throw new ApiError(409, "last_owner", "The last active owner cannot be removed or demoted.");
    }
  }
  if (active && identityKind === "human" && (!existing || existing.active !== 1 || existing.identity_kind !== "human")) {
    const humans = await env.TEAM_CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM organization_members
        WHERE org_id = ?1 AND active = 1 AND identity_kind = 'human'`
    )
      .bind(auth.orgId)
      .first<CountRow>();
    if ((humans?.count ?? 0) >= 15) {
      throw new ApiError(409, "contributor_limit_reached", "Team includes at most 15 active human contributors.");
    }
  }
  const at = nowIso();
  const removingOwner = existing?.role === "owner" && existing.active === 1 && (!active || role !== "owner");
  const addingHuman = active && identityKind === "human" && (!existing || existing.active !== 1 || existing.identity_kind !== "human");
  const mutation = existing
    ? env.TEAM_CONTROL_DB.prepare(
        `UPDATE organization_members
            SET role = ?1, identity_kind = ?2, active = ?3, updated_at = ?4
          WHERE org_id = ?5 AND user_id = ?6
            AND (
              ?7 = 0 OR (
                SELECT COUNT(*) FROM organization_members
                 WHERE org_id = ?5 AND role = 'owner' AND active = 1
              ) > 1
            )
            AND (
              ?8 = 0 OR (
                SELECT COUNT(*) FROM organization_members
                 WHERE org_id = ?5 AND active = 1 AND identity_kind = 'human'
              ) < 15
            )`
      ).bind(
        role,
        identityKind,
        active ? 1 : 0,
        at,
        auth.orgId,
        targetUserId,
        removingOwner ? 1 : 0,
        addingHuman ? 1 : 0
      )
    : env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO organization_members
          (org_id, user_id, role, identity_kind, active, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
          WHERE ?7 = 0 OR (
            SELECT COUNT(*) FROM organization_members
             WHERE org_id = ?1 AND active = 1 AND identity_kind = 'human'
          ) < 15`
      ).bind(auth.orgId, targetUserId, role, identityKind, active ? 1 : 0, at, addingHuman ? 1 : 0);
  const results = await env.TEAM_CONTROL_DB.batch([
    mutation,
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'user', ?3, 'team.member.updated', 'member', ?4, ?5, ?6
        WHERE EXISTS (
          SELECT 1 FROM organization_members
           WHERE org_id = ?2 AND user_id = ?4 AND role = ?7 AND identity_kind = ?8
             AND active = ?9 AND updated_at = ?6
        )`
    ).bind(
      newId("audit"),
      auth.orgId,
      auth.userId,
      targetUserId,
      JSON.stringify({ role, identity_kind: identityKind, active }),
      at,
      role,
      identityKind,
      active ? 1 : 0
    )
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "membership_concurrent_conflict", "Membership changed concurrently or a Team limit was reached.");
  }
  return jsonResponse({ user_id: targetUserId, role, identity_kind: identityKind, active });
}

export async function listHistory(env: Env, auth: AuthContext): Promise<Response> {
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId, { allowReadOnly: true });
  const rows = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, pair_token, verdict, disposition, receipt_sha256, actor_user_id, created_at
       FROM update_history WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 200`
  )
    .bind(auth.orgId)
    .all();
  return jsonResponse({ history: rows.results });
}

export async function addHistory(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  const body = await readJsonObject(request);
  assertExactKeys(body, ["pair_token", "verdict", "disposition", "receipt_sha256"]);
  const id = newId("history");
  const at = nowIso();
  const pairToken = requireOpaqueId(body.pair_token, "pair_token");
  const verdict = requireEnum(body.verdict, "verdict", ["SAFE", "CHANGED", "HOLD"] as const);
  const disposition = requireEnum(body.disposition, "disposition", [
    "APPLY",
    "DEFER",
    "RESTORE",
    "NO_DECISION"
  ] as const);
  const receiptSha256 = requireSha256(body.receipt_sha256, "receipt_sha256");
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO update_history
        (id, org_id, pair_token, verdict, disposition, receipt_sha256, actor_user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(id, auth.orgId, pairToken, verdict, disposition, receiptSha256, auth.userId, at),
    userAudit(env.TEAM_CONTROL_DB, auth, "team.history.recorded", "update_history", id, at, {
      verdict,
      disposition
    })
  ]);
  return jsonResponse({ id }, 201);
}

export async function listExceptions(env: Env, auth: AuthContext): Promise<Response> {
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId, { allowReadOnly: true });
  const rows = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, pair_token, reason, state, expires_at, created_by, created_at, updated_at
       FROM exception_records WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 200`
  )
    .bind(auth.orgId)
    .all();
  return jsonResponse({ exceptions: rows.results });
}

export async function addException(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "admin"]);
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  const body = await readJsonObject(request);
  assertExactKeys(body, ["pair_token", "reason", "expires_at"]);
  const pairToken = requireOpaqueId(body.pair_token, "pair_token");
  const reason = requireString(body.reason, "reason", { max: 500 });
  const expiresAt = requireIsoDate(body.expires_at, "expires_at");
  if (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 30 * 86_400_000) {
    throw new ApiError(400, "invalid_expiration", "An exception must expire within 30 days.");
  }
  const id = newId("exception");
  const at = nowIso();
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO exception_records
        (id, org_id, pair_token, reason, state, expires_at, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?7)`
    ).bind(id, auth.orgId, pairToken, reason, expiresAt, auth.userId, at),
    userAudit(env.TEAM_CONTROL_DB, auth, "team.exception.created", "exception", id, at)
  ]);
  return jsonResponse({ id, state: "active" }, 201);
}

export async function listRollbacks(env: Env, auth: AuthContext): Promise<Response> {
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId, { allowReadOnly: true });
  const rows = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, pair_token, from_ref_token, to_ref_token, reason, created_by, created_at
       FROM rollback_records WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 200`
  )
    .bind(auth.orgId)
    .all();
  return jsonResponse({ rollbacks: rows.results });
}

export async function addRollback(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "admin"]);
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  const body = await readJsonObject(request);
  assertExactKeys(body, ["pair_token", "from_ref_token", "to_ref_token", "reason"]);
  const id = newId("rollback");
  const at = nowIso();
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO rollback_records
        (id, org_id, pair_token, from_ref_token, to_ref_token, reason, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      id,
      auth.orgId,
      requireOpaqueId(body.pair_token, "pair_token"),
      requireOpaqueId(body.from_ref_token, "from_ref_token"),
      requireOpaqueId(body.to_ref_token, "to_ref_token"),
      requireString(body.reason, "reason", { max: 500 }),
      auth.userId,
      at
    ),
    userAudit(env.TEAM_CONTROL_DB, auth, "team.rollback.recorded", "rollback", id, at)
  ]);
  return jsonResponse({ id }, 201);
}

export async function listAudit(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "admin"]);
  await requireTeamEntitlement(env.TEAM_CONTROL_DB, auth.orgId, { allowReadOnly: true });
  const rows = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at
       FROM audit_events WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 500`
  )
    .bind(auth.orgId)
    .all();
  return jsonResponse({
    audit_events: rows.results.map((row) => ({
      ...row,
      metadata: JSON.parse(String(row.metadata_json)),
      metadata_json: undefined
    }))
  });
}
