import { createHash } from "node:crypto";
import { canonical } from "./report.ts";

export type ExactCostEvidence = {
  schemaVersion: "agent-vigil-exact-cost-evidence/v1";
  source: "cursor-admin-usage-export";
  transcriptSha256: string;
  sourceExportSha256: string;
  sessionIdSha256: string;
  recordsObserved: number;
  chargeableRecords: number;
  amountUsd: number;
  exportPeriodStartedAt: string;
  exportPeriodEndedAt: string;
  startedAt: string;
  endedAt: string;
  evidenceHash: string;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_USAGE_EVENTS = 100_000;
const MAX_SESSION_COST_USD = 1_000_000;

function hash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (canonical(actual) !== canonical([...expected].sort())) throw new Error(`${label} fields must be exactly: ${[...expected].sort().join(", ")}`);
}

function safeSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Cursor usage event conversationId is invalid");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Cursor usage event timestamp is invalid");
  }
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const parsed = new Date(numeric);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Cursor usage event timestamp is invalid");
  return parsed.toISOString();
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`exact cost evidence ${label} is invalid`);
  const parsed = timestamp(value);
  if (parsed !== value) throw new Error(`exact cost evidence ${label} must be a canonical timestamp`);
  return parsed;
}

function chargeMicocents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000_000) {
    throw new Error("Cursor usage event chargedCents must be a bounded non-negative number");
  }
  const microcents = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(microcents)) throw new Error("Cursor usage event chargedCents exceeds safe accounting precision");
  return microcents;
}

function evidencePayload(value: Omit<ExactCostEvidence, "evidenceHash">): string {
  return canonical(value);
}

function structuredConversationIds(raw: string): Set<string> {
  const roots: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { roots.push(JSON.parse(line)); } catch { /* A narrative line is not structured identity evidence. */ }
  }
  if (!roots.length) {
    try { roots.push(JSON.parse(raw)); } catch { /* handled by the empty result */ }
  }
  const records = roots.flatMap((value) => Array.isArray(value) ? value : [value]);
  if (records.length > 100_000) throw new Error("Cursor transcript contains too many structured records");
  const found = new Set<string>();
  for (const value of records) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.type !== "system" || !Object.hasOwn(row, "conversationId")) continue;
    found.add(safeSessionId(row.conversationId));
  }
  return found;
}

export function recomputeExactCostEvidenceHash(value: ExactCostEvidence): string {
  const { evidenceHash: _evidenceHash, ...payload } = value;
  return hash(evidencePayload(payload));
}

export function validateExactCostEvidence(value: unknown): ExactCostEvidence {
  const selected = record(value, "exact cost evidence");
  exactKeys(selected, [
    "schemaVersion", "source", "transcriptSha256", "sourceExportSha256", "sessionIdSha256",
    "recordsObserved", "chargeableRecords", "amountUsd", "exportPeriodStartedAt", "exportPeriodEndedAt",
    "startedAt", "endedAt", "evidenceHash",
  ], "exact cost evidence");
  if (selected.schemaVersion !== "agent-vigil-exact-cost-evidence/v1") throw new Error("exact cost evidence schema is unsupported");
  if (selected.source !== "cursor-admin-usage-export") throw new Error("exact cost evidence source is unsupported");
  for (const field of ["transcriptSha256", "sourceExportSha256", "sessionIdSha256", "evidenceHash"] as const) {
    if (typeof selected[field] !== "string" || !SHA256.test(selected[field] as string)) throw new Error(`exact cost evidence ${field} is invalid`);
  }
  for (const field of ["recordsObserved", "chargeableRecords"] as const) {
    if (!Number.isSafeInteger(selected[field]) || Number(selected[field]) < 0 || Number(selected[field]) > MAX_USAGE_EVENTS) {
      throw new Error(`exact cost evidence ${field} is invalid`);
    }
  }
  if (Number(selected.recordsObserved) === 0) throw new Error("exact cost evidence must contain at least one observed record");
  if (Number(selected.chargeableRecords) > Number(selected.recordsObserved)) throw new Error("exact cost evidence chargeable record count exceeds observed records");
  if (typeof selected.amountUsd !== "number" || !Number.isFinite(selected.amountUsd) || selected.amountUsd < 0 || selected.amountUsd > MAX_SESSION_COST_USD) {
    throw new Error("exact cost evidence amountUsd is invalid");
  }
  const exportPeriodStartedAt = canonicalTimestamp(selected.exportPeriodStartedAt, "exportPeriodStartedAt");
  const exportPeriodEndedAt = canonicalTimestamp(selected.exportPeriodEndedAt, "exportPeriodEndedAt");
  if (exportPeriodStartedAt > exportPeriodEndedAt) throw new Error("exact cost evidence export period is invalid");
  const startedAt = canonicalTimestamp(selected.startedAt, "startedAt");
  const endedAt = canonicalTimestamp(selected.endedAt, "endedAt");
  if (startedAt > endedAt) throw new Error("exact cost evidence time range is invalid");
  if (startedAt < exportPeriodStartedAt || endedAt > exportPeriodEndedAt) throw new Error("exact cost evidence events fall outside the export period");
  const result = selected as unknown as ExactCostEvidence;
  if (recomputeExactCostEvidenceHash(result) !== result.evidenceHash) throw new Error("exact cost evidence hash is invalid");
  return result;
}

export function buildCursorExactCostEvidence(input: {
  transcript: Buffer;
  usageExport: Buffer;
}): ExactCostEvidence {
  let parsed: unknown;
  try { parsed = JSON.parse(input.usageExport.toString("utf8")); }
  catch { throw new Error("Cursor usage export is not valid JSON"); }
  const root = record(parsed, "Cursor usage export");
  const events = root.usageEvents;
  if (!Array.isArray(events) || !events.length) throw new Error("Cursor usage export contains no usageEvents");
  if (events.length > MAX_USAGE_EVENTS) throw new Error(`Cursor usage export exceeds ${MAX_USAGE_EVENTS} events`);
  const totalUsageEventsCount = root.totalUsageEventsCount;
  if (!Number.isSafeInteger(totalUsageEventsCount) || totalUsageEventsCount !== events.length) {
    throw new Error("Cursor usage export is incomplete; request a narrow period whose complete result fits one response");
  }
  const pagination = record(root.pagination, "Cursor usage export pagination");
  if (pagination.hasNextPage !== false || pagination.hasPreviousPage !== false) {
    throw new Error("Cursor usage export is paginated; request a narrow period whose complete result fits one response");
  }
  const period = record(root.period, "Cursor usage export period");
  const exportPeriodStartedAt = timestamp(period.startDate);
  const exportPeriodEndedAt = timestamp(period.endDate);
  if (exportPeriodStartedAt > exportPeriodEndedAt) throw new Error("Cursor usage export period is invalid");

  const transcriptSessions = structuredConversationIds(input.transcript.toString("utf8"));
  const normalized = events.map((value, index) => {
    const event = record(value, `Cursor usage event ${index + 1}`);
    const conversationId = event.conversationId === undefined ? undefined : safeSessionId(event.conversationId);
    return {
      event,
      conversationId,
      timestamp: timestamp(event.timestamp),
      fingerprint: hash(canonical(event)),
    };
  });
  if (new Set(normalized.map((item) => item.fingerprint)).size !== normalized.length) {
    throw new Error("Cursor usage export contains duplicate events; refusing to double-count cost");
  }

  const shared = [...new Set(normalized.map((item) => item.conversationId).filter((id): id is string => typeof id === "string" && transcriptSessions.has(id)))];
  if (shared.length === 0) throw new Error("Cursor usage export has no conversationId bound to the transcript");
  if (shared.length > 1) throw new Error("Cursor usage export matches more than one transcript conversation; split the transcript before importing cost");
  const sessionId = shared[0];
  const matched = normalized.filter((item) => item.conversationId === sessionId);
  let totalMicrocents = 0;
  let chargeableRecords = 0;
  for (const { event } of matched) {
    if (typeof event.isChargeable !== "boolean") throw new Error("Cursor usage event isChargeable must be explicit");
    if (!event.isChargeable) continue;
    totalMicrocents += chargeMicocents(event.chargedCents);
    if (!Number.isSafeInteger(totalMicrocents)) throw new Error("Cursor usage export total exceeds safe accounting precision");
    chargeableRecords += 1;
  }
  const times = matched.map((item) => item.timestamp).sort();
  if (times[0] < exportPeriodStartedAt || times.at(-1)! > exportPeriodEndedAt) {
    throw new Error("Cursor usage event falls outside the export period");
  }
  const withoutHash: Omit<ExactCostEvidence, "evidenceHash"> = {
    schemaVersion: "agent-vigil-exact-cost-evidence/v1",
    source: "cursor-admin-usage-export",
    transcriptSha256: hash(input.transcript),
    sourceExportSha256: hash(input.usageExport),
    sessionIdSha256: hash(sessionId),
    recordsObserved: matched.length,
    chargeableRecords,
    amountUsd: totalMicrocents / 100_000_000,
    exportPeriodStartedAt,
    exportPeriodEndedAt,
    startedAt: times[0],
    endedAt: times.at(-1)!,
  };
  return { ...withoutHash, evidenceHash: hash(evidencePayload(withoutHash)) };
}
