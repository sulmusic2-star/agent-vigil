import { hmacHex, verifyHmacHex } from "../crypto.ts";
import { dutySecretsAreSeparated, type DutySecret } from "../duty-secrets.ts";

import { INVOCATION_TOLERANCE_SECONDS, type InternalPriceId } from "./contracts.ts";

const MAX_INVOCATION_BYTES = 16_384;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export class AdapterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export function assertAdapterDutySecretSeparation(secrets: readonly DutySecret[]): void {
  if (!dutySecretsAreSeparated(secrets)) {
    throw new AdapterError(503, "adapter_secret_configuration_invalid", "Adapter duty-secret configuration is invalid.");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AdapterError(400, "invalid_contract", `${field} must be an object.`);
  return value;
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new AdapterError(400, "invalid_contract", `${field} has unexpected fields.`);
  }
}

export function string(value: unknown, field: string, max = 255): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new AdapterError(400, "invalid_contract", `${field} is invalid.`);
  }
  return value;
}

export function opaqueId(value: unknown, field: string, max = 255): string {
  const parsed = string(value, field, max);
  if (!OPAQUE_ID.test(parsed)) throw new AdapterError(400, "invalid_contract", `${field} is invalid.`);
  return parsed;
}

export function orgId(value: unknown, field = "org_id"): string {
  const parsed = string(value, field, 64);
  if (!ORG_ID.test(parsed)) throw new AdapterError(400, "invalid_contract", `${field} is invalid.`);
  return parsed;
}

export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new AdapterError(400, "invalid_contract", `${field} is invalid.`);
  }
  return value as number;
}

export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AdapterError(400, "invalid_contract", `${field} is invalid.`);
  return value;
}

export function internalPriceId(value: unknown): InternalPriceId {
  if (value !== "team_monthly_usd_v1" && value !== "team_annual_usd_v1") {
    throw new AdapterError(400, "invalid_contract", "internal_price_id is invalid.");
  }
  return value;
}

export function parseJson(raw: string, field = "body"): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AdapterError(400, "invalid_json", `${field} must be valid JSON.`);
  }
  return record(parsed, field);
}

export async function readBoundedBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_INVOCATION_BYTES) {
    throw new AdapterError(413, "body_too_large", "Request body is too large.");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let received = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAX_INVOCATION_BYTES) {
        await reader.cancel("body limit exceeded");
        throw new AdapterError(413, "body_too_large", "Request body is too large.");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(400, "invalid_body", "Request body must be valid UTF-8.");
  } finally {
    reader.releaseLock();
  }
  return body;
}

function parseSignature(header: string | null): { timestamp: number; signatures: string[] } {
  if (!header || header.length > 4096) {
    throw new AdapterError(401, "invalid_signature", "A valid invocation signature is required.");
  }
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [name, value, ...rest] = part.trim().split("=");
    if (rest.length > 0 || !name || !value) continue;
    if (name === "t" && /^\d{1,12}$/u.test(value)) timestamp = Number(value);
    if (name === "v1" && /^[a-f0-9]{64}$/u.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) {
    throw new AdapterError(401, "invalid_signature", "A valid invocation signature is required.");
  }
  return { timestamp, signatures };
}

export async function verifyInvocation(
  request: Request,
  rawBody: string,
  secret: string,
  now = Date.now()
): Promise<void> {
  if (secret.length < 32) throw new AdapterError(503, "adapter_not_configured", "Adapter is not configured.");
  const parsed = parseSignature(request.headers.get("Agent-Vigil-Adapter-Signature"));
  if (Math.abs(Math.floor(now / 1000) - parsed.timestamp) > INVOCATION_TOLERANCE_SECONDS) {
    throw new AdapterError(401, "stale_signature", "Invocation signature is outside the allowed window.");
  }
  const signed = `${parsed.timestamp}.${rawBody}`;
  for (const signature of parsed.signatures) {
    if (await verifyHmacHex(secret, signed, signature)) return;
  }
  throw new AdapterError(401, "invalid_signature", "Invocation signature is invalid.");
}

export async function signatureHeader(secret: string, rawBody: string, now = Date.now()): Promise<string> {
  const timestamp = Math.floor(now / 1000);
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

export function noStoreJson(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export function adapterErrorResponse(error: unknown): Response {
  if (error instanceof AdapterError) {
    return noStoreJson({ error: { code: error.code, message: error.message } }, error.status);
  }
  return noStoreJson(
    { error: { code: "adapter_failure", message: "The Stripe adapter could not complete the request." } },
    500
  );
}

export function liveMode(value: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new AdapterError(503, "adapter_not_configured", "Adapter live mode is not configured.");
  }
  return value === "true";
}

export function configuredPrice(
  env: { STRIPE_PRICE_TEAM_MONTHLY: string; STRIPE_PRICE_TEAM_ANNUAL: string },
  id: InternalPriceId
): string {
  const price = id === "team_monthly_usd_v1" ? env.STRIPE_PRICE_TEAM_MONTHLY : env.STRIPE_PRICE_TEAM_ANNUAL;
  if (!/^price_[A-Za-z0-9_]+$/u.test(price) || price === "CONFIGURE_BEFORE_DEPLOYMENT") {
    throw new AdapterError(503, "adapter_not_configured", "Stripe price catalog is not configured.");
  }
  return price;
}

export function listAmountCents(id: InternalPriceId): number {
  return id === "team_monthly_usd_v1" ? 29_900 : 299_000;
}

export function interval(id: InternalPriceId): "month" | "year" {
  return id === "team_monthly_usd_v1" ? "month" : "year";
}
