import { base64UrlDecode, verifyHmacBase64Url } from "./crypto.ts";
import { ApiError } from "./http.ts";
import { assertExactKeys, requireInteger, requireOpaqueId, requireOrgId, requireString } from "./validation.ts";

export type OrgRole = "owner" | "admin" | "billing" | "member";

export interface AuthContext {
  userId: string;
  orgId: string;
  role: OrgRole;
  identityKind: "human" | "service";
  sessionId: string;
}

interface MembershipRow {
  role: OrgRole;
  identity_kind: "human" | "service";
  active: number;
  organization_status: "active" | "deletion_pending" | "deleted";
}

function parseSessionPayload(raw: string): {
  sub: string;
  orgId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }
  const payload = value as Record<string, unknown>;
  try {
    assertExactKeys(payload, ["schema_version", "kid", "sub", "org_id", "jti", "iat", "exp"]);
    if (payload.schema_version !== "team-session-v1") {
      throw new Error("schema");
    }
    return {
      sub: requireOpaqueId(payload.sub, "sub"),
      orgId: requireOrgId(requireString(payload.org_id, "org_id", { max: 64 })),
      sessionId: requireOpaqueId(payload.jti, "jti"),
      issuedAt: requireInteger(payload.iat, "iat", { min: 0 }),
      expiresAt: requireInteger(payload.exp, "exp", { min: 0 })
    };
  } catch {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }
}

export async function authenticate(
  request: Request,
  env: Env,
  routeOrgId: string,
  options: { allowDeletionPending?: boolean } = {}
): Promise<AuthContext> {
  const authorization = request.headers.get("Authorization");
  if (!authorization || authorization.length > 4096 || !authorization.startsWith("Bearer ")) {
    throw new ApiError(401, "authentication_required", "A bearer session is required.");
  }
  const token = authorization.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "avteam_v1") {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }
  const payloadSegment = parts[1];
  const signatureSegment = parts[2];
  if (!payloadSegment || !signatureSegment) {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }
  const payloadJson = base64UrlDecode(payloadSegment);
  if (!payloadJson) {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }
  let rawPayload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("shape");
    }
    rawPayload = parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }
  if (rawPayload.kid !== env.TEAM_SESSION_KEY_ID) {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }
  const signatureValid = await verifyHmacBase64Url(
    env.TEAM_SESSION_HMAC_SECRET,
    `${parts[0]}.${payloadSegment}`,
    signatureSegment
  );
  if (!signatureValid) {
    throw new ApiError(401, "invalid_session", "Session token is invalid.");
  }

  const payload = parseSessionPayload(payloadJson);
  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt <= now || payload.issuedAt > now + 60 || payload.expiresAt - payload.issuedAt > 86_400) {
    throw new ApiError(401, "expired_session", "Session token is expired or outside its allowed lifetime.");
  }
  if (payload.orgId !== routeOrgId) {
    throw new ApiError(403, "tenant_mismatch", "The session is not valid for this organization.");
  }

  const membership = await env.TEAM_CONTROL_DB.prepare(
    `SELECT m.role, m.identity_kind, m.active, o.status AS organization_status
       FROM organization_members m
       JOIN organizations o ON o.id = m.org_id
      WHERE m.org_id = ?1 AND m.user_id = ?2`
  )
    .bind(routeOrgId, payload.sub)
    .first<MembershipRow>();
  const allowedOrganization =
    membership?.organization_status === "active" ||
    (options.allowDeletionPending === true && membership?.organization_status === "deletion_pending");
  if (!membership || membership.active !== 1 || !allowedOrganization) {
    throw new ApiError(403, "membership_inactive", "Active organization membership is required.");
  }
  return {
    userId: payload.sub,
    orgId: routeOrgId,
    role: membership.role,
    identityKind: membership.identity_kind,
    sessionId: payload.sessionId
  };
}

export function requireRole(auth: AuthContext, allowed: readonly OrgRole[]): void {
  if (!allowed.includes(auth.role)) {
    throw new ApiError(403, "insufficient_role", "This operation is not allowed for the current role.");
  }
}
