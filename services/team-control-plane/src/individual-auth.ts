import { base64UrlDecode, sha256Hex, verifyHmacBase64Url } from "./crypto.ts";
import { requireIndividualSessionConfiguration } from "./individual-config.ts";
import { ApiError } from "./http.ts";
import { assertExactKeys, requireEnum, requireInteger, requireOpaqueId, requireString } from "./validation.ts";

const MAX_SESSION_SECONDS = 900;

export interface IndividualAuthContext {
  authSubjectSha256: string;
  githubAccountNodeId: string;
  sessionId: string;
  sessionSha256: string;
  issuedAt: number;
}

function requireNodeId(value: unknown, field: string): string {
  return requireString(value, field, {
    min: 8,
    max: 128,
    pattern: /^[A-Za-z0-9_-]{8,128}={0,2}$/u
  });
}

function invalidSession(): ApiError {
  return new ApiError(401, "invalid_individual_session", "Individual session token is invalid.");
}

export async function authenticateIndividual(request: Request, env: Env): Promise<IndividualAuthContext> {
  const config = requireIndividualSessionConfiguration(env);
  const authorization = request.headers.get("Authorization");
  if (!authorization || authorization.length > 8192 || !authorization.startsWith("Bearer ")) {
    throw new ApiError(401, "individual_authentication_required", "A GitHub/OIDC-bound human session is required.");
  }
  const token = authorization.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "avindividual_v1") throw invalidSession();
  const payloadSegment = parts[1];
  const signatureSegment = parts[2];
  if (!payloadSegment || !signatureSegment) throw invalidSession();
  const payloadJson = base64UrlDecode(payloadSegment);
  if (!payloadJson) throw invalidSession();
  if (
    !(await verifyHmacBase64Url(
      env.INDIVIDUAL_SESSION_HMAC_SECRET,
      `${parts[0]}.${payloadSegment}`,
      signatureSegment
    ))
  ) {
    throw invalidSession();
  }

  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw invalidSession();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSession();
  const payload = value as Record<string, unknown>;
  try {
    assertExactKeys(payload, [
      "schema_version",
      "kid",
      "iss",
      "aud",
      "sub",
      "github_account_node_id",
      "identity_kind",
      "jti",
      "iat",
      "exp"
    ]);
    if (payload.schema_version !== "individual-session-v1") throw new Error("schema");
    const kid = requireString(payload.kid, "kid", { max: 128 });
    const issuer = requireString(payload.iss, "iss", { max: 512 });
    const audience = requireString(payload.aud, "aud", { max: 256 });
    if (
      kid !== config.sessionKeyId ||
      issuer !== config.sessionIssuer ||
      audience !== config.sessionAudience
    ) {
      throw new Error("boundary");
    }
    requireEnum(payload.identity_kind, "identity_kind", ["human"] as const);
    const subject = requireOpaqueId(payload.sub, "sub", 255);
    const accountNodeId = requireNodeId(payload.github_account_node_id, "github_account_node_id");
    const sessionId = requireOpaqueId(payload.jti, "jti", 255);
    const issuedAt = requireInteger(payload.iat, "iat", { min: 0 });
    const expiresAt = requireInteger(payload.exp, "exp", { min: 0 });
    const now = Math.floor(Date.now() / 1000);
    if (
      issuedAt > now + 60 ||
      expiresAt <= now ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_SESSION_SECONDS
    ) {
      throw new Error("lifetime");
    }
    return {
      authSubjectSha256: await sha256Hex(`${issuer}:${subject}`),
      githubAccountNodeId: accountNodeId,
      sessionId,
      sessionSha256: await sha256Hex(`${issuer}:${sessionId}`),
      issuedAt
    };
  } catch (error) {
    if (error instanceof ApiError) throw invalidSession();
    throw invalidSession();
  }
}
