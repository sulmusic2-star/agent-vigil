import type { AuthContext } from "./auth.ts";
import { ApiError } from "./http.ts";

export interface EntitlementRow {
  tier: "team";
  status: "active" | "grace" | "read_only" | "expired" | "refunded";
  contributor_limit: number;
  starts_at: string;
  ends_at: string;
  grace_until: string | null;
  source_event_id: string;
  updated_at: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function eventDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function auditStatement(
  db: D1Database,
  input: {
    orgId: string | null;
    actorType: "user" | "stripe" | "reconciler" | "system";
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: object;
    at: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      newId("audit"),
      input.orgId,
      input.actorType,
      input.actorId,
      input.action,
      input.resourceType,
      input.resourceId,
      JSON.stringify(input.metadata ?? {}),
      input.at
    );
}

export function lifecycleStatement(
  db: D1Database,
  input: {
    orgId: string;
    eventName:
      | "shared_policy_enabled_v1"
      | "required_gate_enabled_v1"
      | "team_offer_shown_v1"
      | "checkout_started_v1"
      | "payment_succeeded_v1"
      | "entitlement_activated_v1"
      | "payment_failed_v1"
      | "refund_issued_v1"
      | "subscription_renewed_v1"
      | "subscription_canceled_v1"
      | "entitlement_expired_v1";
    sourceRef: string;
    at: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO lifecycle_events
        (event_id, org_id, event_name, source_ref, event_day, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(newId("life"), input.orgId, input.eventName, input.sourceRef, eventDay(input.at), input.at);
}

export async function getEntitlement(db: D1Database, orgId: string): Promise<EntitlementRow | null> {
  return db
    .prepare(
      `SELECT tier, status, contributor_limit, starts_at, ends_at, grace_until, source_event_id, updated_at
         FROM entitlements
        WHERE org_id = ?1`
    )
    .bind(orgId)
    .first<EntitlementRow>();
}

export async function requireTeamEntitlement(
  db: D1Database,
  orgId: string,
  options: { allowReadOnly?: boolean } = {}
): Promise<EntitlementRow> {
  const entitlement = await getEntitlement(db, orgId);
  const now = Date.now();
  const active = entitlement?.status === "active" && Date.parse(entitlement.ends_at) > now;
  const grace =
    entitlement?.status === "grace" &&
    entitlement.grace_until !== null &&
    Date.parse(entitlement.grace_until) > now;
  const readable = options.allowReadOnly && entitlement?.status === "read_only";
  if (!entitlement || (!active && !grace && !readable)) {
    throw new ApiError(402, "team_entitlement_required", "An active Team entitlement is required.");
  }
  return entitlement;
}

export function userAudit(
  db: D1Database,
  auth: AuthContext,
  action: string,
  resourceType: string,
  resourceId: string,
  at: string,
  metadata?: object
): D1PreparedStatement {
  return auditStatement(db, {
    orgId: auth.orgId,
    actorType: "user",
    actorId: auth.userId,
    action,
    resourceType,
    resourceId,
    at,
    ...(metadata ? { metadata } : {})
  });
}
