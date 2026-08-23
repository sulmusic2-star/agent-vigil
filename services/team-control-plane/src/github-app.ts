import type { AuthContext } from "./auth.ts";
import { requireRole } from "./auth.ts";
import { sha256Hex, verifyHmacHex } from "./crypto.ts";
import { auditStatement, newId, nowIso } from "./db.ts";
import { ApiError, jsonResponse, parseJsonObject, readBoundedText, readJsonObject } from "./http.ts";
import {
  assertExactKeys,
  requireEnum,
  requireInteger,
  requireIsoDate,
  requireObject,
  requireOpaqueId,
  requireString
} from "./validation.ts";

const GITHUB_WEBHOOK_BODY_LIMIT = 1_048_576;
const GITHUB_RECONCILIATION_BODY_LIMIT = 262_144;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_REPOSITORIES = 1000;

type GitHubEventName = "installation" | "installation_repositories";
type GitHubAction = "created" | "deleted" | "suspend" | "unsuspend" | "added" | "removed";
type GitHubInstallationState = "pending_reconciliation" | "active" | "suspended" | "deleted";
type RepositorySelection = "all" | "selected";

interface GitHubSummary {
  eventName: GitHubEventName;
  action: GitHubAction;
  appId: number;
  installationId: number;
  accountNodeId: string;
  repositorySelection: RepositorySelection;
  addedRepositoryNodeIds: string[];
  removedRepositoryNodeIds: string[];
  eventCreatedAt: number;
  eventCreatedIso: string;
}

interface ClaimRow {
  installation_id: number;
  github_account_node_id: string;
  org_id: string;
  status: "claimed" | "bound" | "revoked";
  organization_status: "active" | "deletion_pending" | "deleted";
}

interface InstallationRow {
  installation_id: number;
  app_id: number;
  github_account_node_id: string;
  org_id: string;
  state: GitHubInstallationState;
  repository_selection: RepositorySelection;
  last_event_created_at: number;
  last_delivery_id: string;
  last_reconciliation_id: string | null;
  installed_at: string;
  suspended_at: string | null;
  deleted_at: string | null;
  reconciled_at: string | null;
  updated_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  payload_sha256: string;
  event_name: GitHubEventName;
  action: GitHubAction;
  installation_id: number;
  org_id: string | null;
  event_created_at: number;
  result: "unclaimed" | "pending_reconciliation" | "applied" | "revoked" | "stale" | "rejected";
}

interface ReconciliationSnapshot {
  reconciliationId: string;
  sourceDeliveryId: string;
  observedAt: string;
  appId: number;
  installationId: number;
  accountNodeId: string;
  providerStatus: "active";
  repositorySelection: RepositorySelection;
  repositoryNodeIds: string[];
}

function configuredAppId(env: Env): number {
  const raw: string = env.GITHUB_APP_ID;
  if (!/^\d{1,15}$/u.test(raw)) {
    throw new Error("GITHUB_APP_ID is not configured");
  }
  const appId = Number(raw);
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new Error("GITHUB_APP_ID is not configured");
  }
  return appId;
}

function requireDeliveryId(value: unknown, field = "X-GitHub-Delivery"): string {
  return requireString(value, field, {
    min: 36,
    max: 36,
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  });
}

function requireNodeId(value: unknown, field: string): string {
  return requireString(value, field, {
    min: 8,
    max: 128,
    pattern: /^[A-Za-z0-9_-]{8,128}={0,2}$/u
  });
}

function requireGitHubTimestamp(value: unknown, field: string): { seconds: number; iso: string } {
  const raw = requireString(value, field, { min: 20, max: 40 });
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) {
    throw new ApiError(400, "invalid_github_event", `${field} must be a valid timestamp.`);
  }
  return { seconds: Math.floor(milliseconds / 1000), iso: new Date(milliseconds).toISOString() };
}

function parseRepositoryNodeIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REPOSITORIES) {
    throw new ApiError(400, "invalid_github_event", `${field} must contain at most ${MAX_REPOSITORIES} records.`);
  }
  const ids = value.map((entry, index) => {
    const repository = requireObject(entry, `${field}[${index}]`);
    return requireNodeId(repository.node_id, `${field}[${index}].node_id`);
  });
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(400, "duplicate_repository_node_id", `${field} contains duplicate node identifiers.`);
  }
  return ids;
}

function parseNodeIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REPOSITORIES) {
    throw new ApiError(400, "invalid_field", `${field} must contain at most ${MAX_REPOSITORIES} identifiers.`);
  }
  const ids = value.map((entry, index) => requireNodeId(entry, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(400, "duplicate_repository_node_id", `${field} contains duplicate node identifiers.`);
  }
  return ids;
}

function parseGitHubPayload(eventName: GitHubEventName, body: Record<string, unknown>): GitHubSummary {
  const action = requireEnum(body.action, "action", [
    "created",
    "deleted",
    "suspend",
    "unsuspend",
    "added",
    "removed"
  ] as const);
  if (
    (eventName === "installation" && !(["created", "deleted", "suspend", "unsuspend"] as const).includes(
      action as "created" | "deleted" | "suspend" | "unsuspend"
    )) ||
    (eventName === "installation_repositories" && !(["added", "removed"] as const).includes(
      action as "added" | "removed"
    ))
  ) {
    throw new ApiError(400, "unsupported_github_lifecycle", "GitHub event/action combination is not allowed.");
  }

  const installation = requireObject(body.installation, "installation");
  const account = requireObject(installation.account, "installation.account");
  const installationId = requireInteger(installation.id, "installation.id", { min: 1 });
  const appId = requireInteger(installation.app_id, "installation.app_id", { min: 1 });
  const accountNodeId = requireNodeId(account.node_id, "installation.account.node_id");
  const repositorySelection = requireEnum(
    eventName === "installation_repositories" ? body.repository_selection : installation.repository_selection,
    "repository_selection",
    ["all", "selected"] as const
  );
  const eventTime = requireGitHubTimestamp(
    action === "created" ? installation.created_at : installation.updated_at,
    action === "created" ? "installation.created_at" : "installation.updated_at"
  );

  let addedRepositoryNodeIds: string[] = [];
  let removedRepositoryNodeIds: string[] = [];
  if (eventName === "installation" && action === "created") {
    addedRepositoryNodeIds = body.repositories === undefined ? [] : parseRepositoryNodeIds(body.repositories, "repositories");
  } else if (eventName === "installation_repositories") {
    addedRepositoryNodeIds = parseRepositoryNodeIds(body.repositories_added, "repositories_added");
    removedRepositoryNodeIds = parseRepositoryNodeIds(body.repositories_removed, "repositories_removed");
    const removed = new Set(removedRepositoryNodeIds);
    if (addedRepositoryNodeIds.some((id) => removed.has(id))) {
      throw new ApiError(400, "repository_selection_conflict", "A repository cannot be both added and removed.");
    }
  }
  return {
    eventName,
    action,
    appId,
    installationId,
    accountNodeId,
    repositorySelection,
    addedRepositoryNodeIds,
    removedRepositoryNodeIds,
    eventCreatedAt: eventTime.seconds,
    eventCreatedIso: eventTime.iso
  };
}

async function verifyGitHubWebhookSignature(header: string | null, rawBody: string, secret: string): Promise<void> {
  if (!header || header.length !== 71 || !header.startsWith("sha256=")) {
    throw new ApiError(401, "invalid_github_signature", "A valid GitHub webhook signature is required.");
  }
  if (!(await verifyHmacHex(secret, rawBody, header.slice("sha256=".length)))) {
    throw new ApiError(401, "invalid_github_signature", "GitHub webhook signature verification failed.");
  }
}

function parseTimestampedSignature(header: string | null): { timestamp: number; signatures: string[] } {
  if (!header || header.length > 4096) {
    throw new ApiError(401, "invalid_reconciliation_signature", "A reconciliation signature is required.");
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
    throw new ApiError(401, "invalid_reconciliation_signature", "Reconciliation signature is invalid.");
  }
  return { timestamp, signatures };
}

async function verifyReconciliationSignature(header: string | null, rawBody: string, secret: string): Promise<void> {
  const parsed = parseTimestampedSignature(header);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new ApiError(401, "stale_reconciliation_signature", "Reconciliation signature is outside its allowed window.");
  }
  const signed = `${parsed.timestamp}.${rawBody}`;
  for (const signature of parsed.signatures) {
    if (await verifyHmacHex(secret, signed, signature)) return;
  }
  throw new ApiError(401, "invalid_reconciliation_signature", "Reconciliation signature verification failed.");
}

function serviceUserId(installationId: number): string {
  return `github-installation:${installationId}`;
}

async function claimForInstallation(db: D1Database, installationId: number): Promise<ClaimRow | null> {
  return db
    .prepare(
      `SELECT c.installation_id, c.github_account_node_id, c.org_id, c.status,
              o.status AS organization_status
         FROM github_installation_claims c
         JOIN organizations o ON o.id = c.org_id
        WHERE c.installation_id = ?1`
    )
    .bind(installationId)
    .first<ClaimRow>();
}

async function installationById(db: D1Database, installationId: number): Promise<InstallationRow | null> {
  return db
    .prepare(
      `SELECT installation_id, app_id, github_account_node_id, org_id, state, repository_selection,
              last_event_created_at, last_delivery_id, last_reconciliation_id, installed_at,
              suspended_at, deleted_at, reconciled_at, updated_at
         FROM github_installations WHERE installation_id = ?1`
    )
    .bind(installationId)
    .first<InstallationRow>();
}

async function rejectServiceIdentityCollision(db: D1Database, orgId: string, installationId: number): Promise<void> {
  const member = await db
    .prepare(
      `SELECT role, identity_kind FROM organization_members
        WHERE org_id = ?1 AND user_id = ?2`
    )
    .bind(orgId, serviceUserId(installationId))
    .first<{ role: string; identity_kind: string }>();
  if (member && (member.role !== "member" || member.identity_kind !== "service")) {
    throw new ApiError(409, "github_service_identity_collision", "Installation service identity conflicts with a human or privileged member.");
  }
}

function repositoryUpsertStatement(
  db: D1Database,
  installationId: number,
  repositoryNodeIds: string[],
  selected: boolean,
  at: string,
  deliveryId: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO github_installation_repositories
        (installation_id, repository_node_id, selected, updated_at)
       SELECT ?1, value, ?2, ?3 FROM json_each(?4)
        WHERE EXISTS (
          SELECT 1 FROM github_installations
           WHERE installation_id = ?1 AND last_delivery_id = ?5
        )
       ON CONFLICT(installation_id, repository_node_id) DO UPDATE SET
         selected = excluded.selected, updated_at = excluded.updated_at`
    )
    .bind(installationId, selected ? 1 : 0, at, JSON.stringify(repositoryNodeIds), deliveryId);
}

function deliveryStatement(
  db: D1Database,
  existing: DeliveryRow | null,
  deliveryId: string,
  payloadHash: string,
  summary: GitHubSummary,
  orgId: string,
  result: DeliveryRow["result"],
  at: string,
  requireCurrentInstallation: boolean
): D1PreparedStatement {
  const current = requireCurrentInstallation
    ? `AND EXISTS (
         SELECT 1 FROM github_installations
          WHERE installation_id = ?4 AND last_delivery_id = ?1
       )`
    : "";
  if (existing) {
    return db
      .prepare(
        `UPDATE github_deliveries SET org_id = ?2, result = ?3, received_at = ?5
          WHERE delivery_id = ?1 ${current}`
      )
      .bind(deliveryId, orgId, result, summary.installationId, at);
  }
  return db
    .prepare(
      `INSERT INTO github_deliveries
        (delivery_id, payload_sha256, event_name, action, installation_id, org_id,
         event_created_at, result, received_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE 1 = 1 ${
          requireCurrentInstallation
            ? `AND EXISTS (
                 SELECT 1 FROM github_installations
                  WHERE installation_id = ?5 AND last_delivery_id = ?1
               )`
            : ""
        }`
    )
    .bind(
      deliveryId,
      payloadHash,
      summary.eventName,
      summary.action,
      summary.installationId,
      orgId,
      summary.eventCreatedAt,
      result,
      at
    );
}

async function recordUnclaimedDelivery(
  env: Env,
  existing: DeliveryRow | null,
  deliveryId: string,
  payloadHash: string,
  summary: GitHubSummary
): Promise<void> {
  const at = nowIso();
  if (existing) {
    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_deliveries SET result = 'unclaimed', received_at = ?1 WHERE delivery_id = ?2`
    )
      .bind(at, deliveryId)
      .run();
    return;
  }
  await env.TEAM_CONTROL_DB.prepare(
    `INSERT INTO github_deliveries
      (delivery_id, payload_sha256, event_name, action, installation_id, org_id,
       event_created_at, result, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'unclaimed', ?7)`
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

export async function claimGitHubInstallation(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner"]);
  if (auth.identityKind !== "human") {
    throw new ApiError(403, "human_owner_required", "Only a human organization owner can claim an installation.");
  }
  const body = await readJsonObject(request);
  assertExactKeys(body, ["schema_version", "installation_id", "account_node_id"]);
  if (body.schema_version !== "github-installation-claim-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be github-installation-claim-v1.");
  }
  const installationId = requireInteger(body.installation_id, "installation_id", { min: 1 });
  const accountNodeId = requireNodeId(body.account_node_id, "account_node_id");
  const existing = await env.TEAM_CONTROL_DB.prepare(
    `SELECT installation_id, github_account_node_id, org_id, status
       FROM github_installation_claims
      WHERE installation_id = ?1 OR github_account_node_id = ?2 OR org_id = ?3
      LIMIT 1`
  )
    .bind(installationId, accountNodeId, auth.orgId)
    .first<{ installation_id: number; github_account_node_id: string; org_id: string; status: string }>();
  if (existing) {
    if (
      existing.installation_id === installationId &&
      existing.github_account_node_id === accountNodeId &&
      existing.org_id === auth.orgId &&
      existing.status !== "revoked"
    ) {
      return jsonResponse({ claimed: true, duplicate: true, installation_id: installationId });
    }
    throw new ApiError(409, "github_installation_claim_collision", "Installation, account, or organization is already bound.");
  }
  const at = nowIso();
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_installation_claims
        (installation_id, github_account_node_id, org_id, status, claimed_by, claimed_at, updated_at)
       VALUES (?1, ?2, ?3, 'claimed', ?4, ?5, ?5)`
    ).bind(installationId, accountNodeId, auth.orgId, auth.userId, at),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: auth.orgId,
      actorType: "user",
      actorId: auth.userId,
      action: "github.installation.claimed",
      resourceType: "github_installation",
      resourceId: String(installationId),
      metadata: { account_node_id: accountNodeId },
      at
    })
  ]);
  return jsonResponse({ claimed: true, installation_id: installationId }, 201);
}

export async function getGitHubInstallation(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "admin"]);
  const claim = await env.TEAM_CONTROL_DB.prepare(
    `SELECT installation_id, github_account_node_id, status, claimed_at, updated_at
       FROM github_installation_claims WHERE org_id = ?1`
  )
    .bind(auth.orgId)
    .first();
  if (!claim) {
    throw new ApiError(404, "github_installation_not_claimed", "No GitHub installation is claimed for this organization.");
  }
  const installation = await env.TEAM_CONTROL_DB.prepare(
    `SELECT installation_id, app_id, github_account_node_id, state, repository_selection,
            last_event_created_at, last_delivery_id, last_reconciliation_id, installed_at,
            suspended_at, deleted_at, reconciled_at, updated_at
       FROM github_installations WHERE org_id = ?1`
  )
    .bind(auth.orgId)
    .first();
  const repositories = installation
    ? await env.TEAM_CONTROL_DB.prepare(
        `SELECT repository_node_id, selected, updated_at
           FROM github_installation_repositories
          WHERE installation_id = ?1 ORDER BY repository_node_id`
      )
        .bind(Number(installation.installation_id))
        .all()
    : { results: [] };
  return jsonResponse({
    schema_version: "github-installation-state-v1",
    claim,
    installation,
    repositories: repositories.results.map((row) => ({ ...row, selected: Number(row.selected) === 1 })),
    stores_repository_names_or_source: false
  });
}

export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await readBoundedText(request, GITHUB_WEBHOOK_BODY_LIMIT);
  await verifyGitHubWebhookSignature(request.headers.get("X-Hub-Signature-256"), rawBody, env.GITHUB_WEBHOOK_SECRET);

  const deliveryId = requireDeliveryId(request.headers.get("X-GitHub-Delivery"));
  const eventName = requireEnum(request.headers.get("X-GitHub-Event"), "X-GitHub-Event", [
    "installation",
    "installation_repositories"
  ] as const);
  const payloadHash = await sha256Hex(rawBody);
  const existingDelivery = await env.TEAM_CONTROL_DB.prepare(
    `SELECT delivery_id, payload_sha256, event_name, action, installation_id, org_id,
            event_created_at, result
       FROM github_deliveries WHERE delivery_id = ?1`
  )
    .bind(deliveryId)
    .first<DeliveryRow>();
  if (existingDelivery) {
    if (existingDelivery.payload_sha256 !== payloadHash) {
      throw new ApiError(409, "github_delivery_replay_mismatch", "GitHub delivery identifier was reused with different bytes.");
    }
    if (existingDelivery.event_name !== eventName) {
      throw new ApiError(409, "github_delivery_header_mismatch", "GitHub delivery event header changed during replay.");
    }
    if (existingDelivery.result !== "unclaimed") {
      return jsonResponse({ received: true, duplicate: true, result: existingDelivery.result });
    }
  }
  const body = parseJsonObject(rawBody);
  const summary = parseGitHubPayload(eventName, body);
  if (summary.appId !== configuredAppId(env)) {
    throw new ApiError(409, "github_app_id_mismatch", "Webhook installation belongs to a different GitHub App.");
  }

  const claim = await claimForInstallation(env.TEAM_CONTROL_DB, summary.installationId);
  if (
    !claim ||
    claim.organization_status !== "active" ||
    claim.status === "revoked" ||
    claim.github_account_node_id !== summary.accountNodeId
  ) {
    await recordUnclaimedDelivery(env, existingDelivery, deliveryId, payloadHash, summary);
    throw new ApiError(409, "github_installation_claim_required", "A matching active organization claim is required.");
  }
  await rejectServiceIdentityCollision(env.TEAM_CONTROL_DB, claim.org_id, summary.installationId);
  const installation = await installationById(env.TEAM_CONTROL_DB, summary.installationId);
  if (installation) {
    if (
      installation.org_id !== claim.org_id ||
      installation.github_account_node_id !== summary.accountNodeId ||
      installation.app_id !== summary.appId
    ) {
      throw new ApiError(409, "github_installation_binding_mismatch", "Installation binding does not match its claimed tenant.");
    }
    if (
      summary.eventCreatedAt < installation.last_event_created_at ||
      (summary.eventCreatedAt === installation.last_event_created_at && deliveryId !== installation.last_delivery_id)
    ) {
      const at = nowIso();
      await env.TEAM_CONTROL_DB.batch([
        deliveryStatement(
          env.TEAM_CONTROL_DB,
          existingDelivery,
          deliveryId,
          payloadHash,
          summary,
          claim.org_id,
          "stale",
          at,
          false
        ),
        auditStatement(env.TEAM_CONTROL_DB, {
          orgId: claim.org_id,
          actorType: "system",
          actorId: "github-app:webhook",
          action: "github.delivery.stale",
          resourceType: "github_delivery",
          resourceId: deliveryId,
          at
        })
      ]);
      throw new ApiError(409, "stale_github_delivery", "Older or ambiguously ordered GitHub delivery was rejected.");
    }
  }

  if (summary.action === "created") {
    if (installation) {
      throw new ApiError(409, "github_installation_already_exists", "Installation creation cannot replace existing state.");
    }
    const at = nowIso();
    const serviceId = serviceUserId(summary.installationId);
    const results = await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO github_installations
          (installation_id, app_id, github_account_node_id, org_id, state, repository_selection,
           last_event_created_at, last_delivery_id, installed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending_reconciliation', ?5, ?6, ?7, ?8, ?9)`
      ).bind(
        summary.installationId,
        summary.appId,
        summary.accountNodeId,
        claim.org_id,
        summary.repositorySelection,
        summary.eventCreatedAt,
        deliveryId,
        summary.eventCreatedIso,
        at
      ),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE github_installation_claims SET status = 'bound', updated_at = ?1
          WHERE installation_id = ?2 AND org_id = ?3 AND github_account_node_id = ?4`
      ).bind(at, summary.installationId, claim.org_id, summary.accountNodeId),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO organization_members
          (org_id, user_id, role, identity_kind, active, created_at, updated_at)
         VALUES (?1, ?2, 'member', 'service', 0, ?3, ?3)
         ON CONFLICT(org_id, user_id) DO UPDATE SET active = 0, updated_at = excluded.updated_at
         WHERE organization_members.role = 'member' AND organization_members.identity_kind = 'service'`
      ).bind(claim.org_id, serviceId, at),
      repositoryUpsertStatement(
        env.TEAM_CONTROL_DB,
        summary.installationId,
        summary.addedRepositoryNodeIds,
        true,
        at,
        deliveryId
      ),
      deliveryStatement(
        env.TEAM_CONTROL_DB,
        existingDelivery,
        deliveryId,
        payloadHash,
        summary,
        claim.org_id,
        "pending_reconciliation",
        at,
        true
      ),
      auditStatement(env.TEAM_CONTROL_DB, {
        orgId: claim.org_id,
        actorType: "system",
        actorId: "github-app:webhook",
        action: "github.installation.created_pending_reconciliation",
        resourceType: "github_installation",
        resourceId: String(summary.installationId),
        metadata: { repository_selection: summary.repositorySelection },
        at
      })
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, "github_installation_concurrent_conflict", "Installation could not be safely initialized.");
    }
    return jsonResponse({ received: true, state: "pending_reconciliation" }, 202);
  }

  if (!installation) {
    throw new ApiError(409, "github_installation_missing", "Installation lifecycle must begin with a claimed creation event.");
  }
  if (installation.state === "deleted") {
    throw new ApiError(409, "github_installation_deleted", "Deleted installation cannot accept additional lifecycle events.");
  }

  const at = nowIso();
  let nextState: GitHubInstallationState = installation.state;
  let deliveryResult: DeliveryRow["result"] = "applied";
  let suspendedAt = installation.suspended_at;
  let deletedAt = installation.deleted_at;
  let requiresDeactivation = false;
  const selectionChanged = summary.repositorySelection !== installation.repository_selection;
  if (summary.action === "suspend") {
    nextState = "suspended";
    deliveryResult = "revoked";
    suspendedAt = summary.eventCreatedIso;
    requiresDeactivation = true;
  } else if (summary.action === "deleted") {
    nextState = "deleted";
    deliveryResult = "revoked";
    deletedAt = summary.eventCreatedIso;
    requiresDeactivation = true;
  } else if (summary.action === "unsuspend" || selectionChanged) {
    nextState = "pending_reconciliation";
    deliveryResult = "pending_reconciliation";
    suspendedAt = null;
    requiresDeactivation = true;
  } else if (installation.state === "pending_reconciliation") {
    deliveryResult = "pending_reconciliation";
    requiresDeactivation = true;
  }

  const statements: D1PreparedStatement[] = [
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installations SET state = ?1, repository_selection = ?2,
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
    deliveryStatement(
      env.TEAM_CONTROL_DB,
      existingDelivery,
      deliveryId,
      payloadHash,
      summary,
      claim.org_id,
      deliveryResult,
      at,
      true
    ),
    repositoryUpsertStatement(
      env.TEAM_CONTROL_DB,
      summary.installationId,
      summary.addedRepositoryNodeIds,
      true,
      at,
      deliveryId
    ),
    repositoryUpsertStatement(
      env.TEAM_CONTROL_DB,
      summary.installationId,
      summary.removedRepositoryNodeIds,
      false,
      at,
      deliveryId
    )
  ];
  if (summary.action === "deleted") {
    statements.push(
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE github_installation_repositories SET selected = 0, updated_at = ?1
          WHERE installation_id = ?2
            AND EXISTS (
              SELECT 1 FROM github_installations
               WHERE installation_id = ?2 AND last_delivery_id = ?3
            )`
      ).bind(at, summary.installationId, deliveryId),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE github_installation_claims SET status = 'revoked', updated_at = ?1
          WHERE installation_id = ?2
            AND EXISTS (
              SELECT 1 FROM github_installations
               WHERE installation_id = ?2 AND last_delivery_id = ?3
            )`
      ).bind(at, summary.installationId, deliveryId)
    );
  }
  if (requiresDeactivation) {
    statements.push(
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE organization_members SET active = 0, updated_at = ?1
          WHERE org_id = ?2 AND user_id = ?3 AND role = 'member' AND identity_kind = 'service'`
      ).bind(at, claim.org_id, serviceUserId(summary.installationId))
    );
  }
  statements.push(
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'system', 'github-app:webhook', ?3, 'github_installation', ?4, ?5, ?6
        WHERE EXISTS (
          SELECT 1 FROM github_installations
           WHERE installation_id = ?7 AND last_delivery_id = ?8
        )`
    ).bind(
      newId("audit"),
      claim.org_id,
      `github.installation.${summary.action}`,
      String(summary.installationId),
      JSON.stringify({ state: nextState, repository_selection: summary.repositorySelection }),
      at,
      summary.installationId,
      deliveryId
    )
  );
  const results = await env.TEAM_CONTROL_DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "github_installation_concurrent_conflict", "Installation changed concurrently.");
  }
  return jsonResponse({ received: true, state: nextState }, deliveryResult === "applied" ? 200 : 202);
}

function parseReconciliation(body: Record<string, unknown>): ReconciliationSnapshot {
  assertExactKeys(body, [
    "schema_version",
    "reconciliation_id",
    "source_delivery_id",
    "observed_at",
    "app_id",
    "installation_id",
    "account_node_id",
    "provider_status",
    "repository_selection",
    "repository_node_ids"
  ]);
  if (body.schema_version !== "github-installation-reconciliation-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be github-installation-reconciliation-v1.");
  }
  const repositorySelection = requireEnum(body.repository_selection, "repository_selection", ["all", "selected"] as const);
  const repositoryNodeIds = parseNodeIdList(body.repository_node_ids, "repository_node_ids");
  if (repositorySelection === "all" && repositoryNodeIds.length !== 0) {
    throw new ApiError(400, "invalid_repository_snapshot", "All-repository snapshots must omit repository identifiers.");
  }
  return {
    reconciliationId: requireOpaqueId(body.reconciliation_id, "reconciliation_id", 255),
    sourceDeliveryId: requireDeliveryId(body.source_delivery_id, "source_delivery_id"),
    observedAt: requireIsoDate(body.observed_at, "observed_at"),
    appId: requireInteger(body.app_id, "app_id", { min: 1 }),
    installationId: requireInteger(body.installation_id, "installation_id", { min: 1 }),
    accountNodeId: requireNodeId(body.account_node_id, "account_node_id"),
    providerStatus: requireEnum(body.provider_status, "provider_status", ["active"] as const),
    repositorySelection,
    repositoryNodeIds
  };
}

export async function handleGitHubReconciliation(request: Request, env: Env): Promise<Response> {
  const rawBody = await readBoundedText(request, GITHUB_RECONCILIATION_BODY_LIMIT);
  await verifyReconciliationSignature(
    request.headers.get("Agent-Vigil-GitHub-Reconciliation-Signature"),
    rawBody,
    env.GITHUB_RECONCILIATION_HMAC_SECRET
  );
  const snapshot = parseReconciliation(parseJsonObject(rawBody));
  if (Math.abs(Date.now() - Date.parse(snapshot.observedAt)) > SIGNATURE_TOLERANCE_SECONDS * 1000) {
    throw new ApiError(400, "stale_github_snapshot", "GitHub installation observation is outside its allowed window.");
  }
  if (snapshot.appId !== configuredAppId(env)) {
    throw new ApiError(409, "github_app_id_mismatch", "Reconciliation belongs to a different GitHub App.");
  }
  const payloadHash = await sha256Hex(rawBody);
  const prior = await env.TEAM_CONTROL_DB.prepare(
    `SELECT payload_sha256, result FROM github_installation_reconciliations
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
  const installation = await installationById(env.TEAM_CONTROL_DB, snapshot.installationId);
  const delivery = await env.TEAM_CONTROL_DB.prepare(
    `SELECT delivery_id, payload_sha256, event_name, action, installation_id, org_id,
            event_created_at, result
       FROM github_deliveries WHERE delivery_id = ?1`
  )
    .bind(snapshot.sourceDeliveryId)
    .first<DeliveryRow>();
  if (
    !installation ||
    !delivery ||
    delivery.result !== "pending_reconciliation" ||
    delivery.installation_id !== snapshot.installationId ||
    installation.state !== "pending_reconciliation" ||
    installation.last_delivery_id !== snapshot.sourceDeliveryId ||
    installation.app_id !== snapshot.appId ||
    installation.github_account_node_id !== snapshot.accountNodeId ||
    installation.repository_selection !== snapshot.repositorySelection
  ) {
    throw new ApiError(409, "github_reconciliation_mismatch", "Snapshot does not match current pending installation state.");
  }
  const claim = await claimForInstallation(env.TEAM_CONTROL_DB, snapshot.installationId);
  if (
    !claim ||
    claim.organization_status !== "active" ||
    claim.status === "revoked" ||
    claim.org_id !== installation.org_id ||
    claim.github_account_node_id !== snapshot.accountNodeId
  ) {
    throw new ApiError(409, "github_installation_claim_mismatch", "Installation claim is not eligible for reconciliation.");
  }
  await rejectServiceIdentityCollision(env.TEAM_CONTROL_DB, installation.org_id, snapshot.installationId);
  const at = nowIso();
  const serviceId = serviceUserId(snapshot.installationId);
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installations SET state = 'active', last_reconciliation_id = ?1,
        reconciled_at = ?2, suspended_at = NULL, updated_at = ?2
       WHERE installation_id = ?3 AND state = 'pending_reconciliation' AND last_delivery_id = ?4
         AND NOT EXISTS (
           SELECT 1 FROM organization_members
            WHERE org_id = ?5 AND user_id = ?6
              AND (role <> 'member' OR identity_kind <> 'service')
         )`
    ).bind(snapshot.reconciliationId, at, snapshot.installationId, snapshot.sourceDeliveryId, installation.org_id, serviceId),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installation_repositories SET selected = 0, updated_at = ?1
        WHERE installation_id = ?2
          AND EXISTS (
            SELECT 1 FROM github_installations
             WHERE installation_id = ?2 AND last_reconciliation_id = ?3 AND state = 'active'
          )`
    ).bind(at, snapshot.installationId, snapshot.reconciliationId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_installation_repositories
        (installation_id, repository_node_id, selected, updated_at)
       SELECT ?1, value, 1, ?2 FROM json_each(?3)
        WHERE EXISTS (
          SELECT 1 FROM github_installations
           WHERE installation_id = ?1 AND last_reconciliation_id = ?4 AND state = 'active'
        )
       ON CONFLICT(installation_id, repository_node_id) DO UPDATE SET
         selected = 1, updated_at = excluded.updated_at`
    ).bind(snapshot.installationId, at, JSON.stringify(snapshot.repositoryNodeIds), snapshot.reconciliationId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organization_members
        (org_id, user_id, role, identity_kind, active, created_at, updated_at)
       SELECT ?1, ?2, 'member', 'service', 1, ?3, ?3
        WHERE EXISTS (
          SELECT 1 FROM github_installations
           WHERE installation_id = ?4 AND last_reconciliation_id = ?5 AND state = 'active'
        )
       ON CONFLICT(org_id, user_id) DO UPDATE SET active = 1, updated_at = excluded.updated_at
       WHERE organization_members.role = 'member' AND organization_members.identity_kind = 'service'`
    ).bind(installation.org_id, serviceId, at, snapshot.installationId, snapshot.reconciliationId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_installation_reconciliations
        (reconciliation_id, payload_sha256, source_delivery_id, installation_id, org_id,
         observed_at, result, applied_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'applied', ?7
        WHERE EXISTS (
          SELECT 1 FROM github_installations
           WHERE installation_id = ?4 AND last_reconciliation_id = ?1 AND state = 'active'
        )`
    ).bind(
      snapshot.reconciliationId,
      payloadHash,
      snapshot.sourceDeliveryId,
      snapshot.installationId,
      installation.org_id,
      snapshot.observedAt,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_deliveries SET result = 'applied'
        WHERE delivery_id = ?1
          AND EXISTS (
            SELECT 1 FROM github_installations
             WHERE installation_id = ?2 AND last_reconciliation_id = ?3 AND state = 'active'
          )`
    ).bind(snapshot.sourceDeliveryId, snapshot.installationId, snapshot.reconciliationId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'system', 'github-app:reconciler', 'github.installation.reconciled',
              'github_installation', ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM github_installations
           WHERE installation_id = ?6 AND last_reconciliation_id = ?7 AND state = 'active'
        )`
    ).bind(
      newId("audit"),
      installation.org_id,
      String(snapshot.installationId),
      JSON.stringify({ repository_selection: snapshot.repositorySelection }),
      at,
      snapshot.installationId,
      snapshot.reconciliationId
    )
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[3]?.meta.changes ?? 0) !== 1 || (results[4]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "github_reconciliation_concurrent_conflict", "Installation changed before reconciliation could apply.");
  }
  return jsonResponse({ reconciled: true, installation_id: snapshot.installationId, state: "active" });
}
