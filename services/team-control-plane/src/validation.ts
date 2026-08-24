import { ApiError } from "./http.ts";

export function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "unexpected_field", `Unexpected field: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new ApiError(400, "missing_field", `Missing required field: ${key}`);
    }
  }
}

export function requireString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {}
): string {
  const min = options.min ?? 1;
  const max = options.max ?? 512;
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ApiError(400, "invalid_field", `${field} must be a string between ${min} and ${max} characters.`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new ApiError(400, "invalid_field", `${field} has an invalid format.`);
  }
  return value;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ApiError(400, "invalid_field", `${field} must be a boolean.`);
  }
  return value;
}

export function requireInteger(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {}
): number {
  if (!Number.isSafeInteger(value)) {
    throw new ApiError(400, "invalid_field", `${field} must be a safe integer.`);
  }
  const integer = value as number;
  if (options.min !== undefined && integer < options.min) {
    throw new ApiError(400, "invalid_field", `${field} is below the minimum.`);
  }
  if (options.max !== undefined && integer > options.max) {
    throw new ApiError(400, "invalid_field", `${field} is above the maximum.`);
  }
  return integer;
}

export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(400, "invalid_field", `${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function requireIsoDate(value: unknown, field: string): string {
  const text = requireString(value, field, { max: 40 });
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new ApiError(400, "invalid_field", `${field} must be an ISO-8601 UTC timestamp.`);
  }
  return text;
}

export function requireSha256(value: unknown, field: string): string {
  return requireString(value, field, { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/u });
}

export function requireOpaqueId(value: unknown, field: string, max = 128): string {
  return requireString(value, field, { min: 3, max, pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u });
}

export function requireOrgId(value: string): string {
  return requireString(value, "org_id", { min: 3, max: 64, pattern: /^[a-z0-9][a-z0-9_-]*$/u });
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_field", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireStringArray(value: unknown, field: string, maxItems = 64): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ApiError(400, "invalid_field", `${field} must be an array with at most ${maxItems} items.`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`, { max: 128 }));
}
