import { createHash } from "node:crypto";

export const VERSION = "0.21.1";

export const CLAIM_KINDS = [
  "tests_pass",
  "file_changed",
  "path_exists",
  "command_ran",
  "work_complete",
  "session_behavior",
  "integrity",
  "policy_attestation",
  "change_scope",
  "differential_test",
  "authority_scope",
  "authority_action",
  "telemetry",
] as const;

export type ClaimKind = typeof CLAIM_KINDS[number];

export const TRANSCRIPT_FORMATS = [
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "github-copilot-cli",
  "opencode",
  "aider",
  "markdown",
  "portable-receipt",
  "pull-request-evidence",
  "unified-git-diff",
  "test-integrity-diff",
  "github-merge-group-event",
  "authority/claude-code",
  "authority/codex",
  "authority/cursor",
  "authority/gemini-cli",
  "authority/github-copilot-cli",
  "authority/opencode",
  "authority/aider",
  "authority/markdown",
] as const;

export type TrustReportTranscriptFormat = typeof TRANSCRIPT_FORMATS[number];

export type Claim = {
  kind: ClaimKind;
  quote: string;
  subject: string;
  expectedCount?: number;
};

export const VERDICTS = ["verified", "contradicted", "unverifiable"] as const;
export type Verdict = typeof VERDICTS[number];
export const REPORT_STATUSES = ["PASS", "FAIL", "INCONCLUSIVE"] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];

export type CheckResult = {
  claim: Claim;
  verdict: Verdict;
  evidence: string;
  ruleId?: string;
  /** Passive checks do not satisfy the minimum-evidence gate by themselves. */
  contributesToPass?: boolean;
  /** Some missing evidence invalidates the execution context even outside strict mode. */
  blocksPass?: boolean;
};

export type ReportPolicy = {
  minVerified: number;
  strict: boolean;
  source?: string;
  sha256: string;
};

export type ReceiptSignature = {
  algorithm: "Ed25519";
  keyId: string;
  publicKey: string;
  value: string;
};

export type TrustReport = {
  schemaVersion: "2";
  vigilVersion: string;
  transcript: string;
  transcriptSha256: string;
  transcriptFormat: TrustReportTranscriptFormat;
  repo: string;
  base: string;
  head: string;
  generatedAt: string;
  receiptHash: string;
  repository: {
    remote?: string;
    tree?: string;
  };
  reproduction: string;
  signature?: ReceiptSignature;
  results: CheckResult[];
  /** Non-blocking findings that are receipt-bound but do not affect status. */
  advisories: CheckResult[];
  summary: {
    verified: number;
    contradicted: number;
    unverifiable: number;
    meaningfulVerified: number;
    status: ReportStatus;
    pass: boolean;
  };
  policy: ReportPolicy;
};

export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNAVAILABLE_SHA256 = "sha256:unavailable";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    throw new Error(`${label} must not be sparse or contain named properties`);
  }
  return value;
}

function exactKeys(recordValue: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const unsupported = Object.keys(recordValue).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(recordValue, key));
  if (unsupported.length || missing.length) {
    const details = [
      ...(unsupported.length ? [`unsupported: ${unsupported.sort().join(", ")}`] : []),
      ...(missing.length ? [`missing: ${missing.sort().join(", ")}`] : []),
    ].join("; ");
    throw new Error(`${label} has unsupported or missing fields${details ? ` (${details})` : ""}`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  const selected = string(value, label);
  if (!(allowed as readonly string[]).includes(selected)) throw new Error(`${label} has an unsupported value`);
  return selected as T[number];
}

function digest(value: unknown, label: string, unavailable = false): string {
  const selected = string(value, label);
  if (!SHA256.test(selected) && !(unavailable && selected === UNAVAILABLE_SHA256)) {
    throw new Error(`${label} must be a lowercase SHA-256 identifier${unavailable ? ` or ${UNAVAILABLE_SHA256}` : ""}`);
  }
  return selected;
}

function gitObjectId(value: unknown, label: string): string {
  const selected = string(value, label);
  if (!GIT_OBJECT_ID.test(selected)) throw new Error(`${label} must be a full lowercase Git object ID`);
  return selected;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const selected = string(value, label);
  const parsed = Date.parse(selected);
  if (!CANONICAL_TIMESTAMP.test(selected) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== selected) {
    throw new Error(`${label} must be canonical RFC3339 UTC`);
  }
  return selected;
}

function canonicalBase64(value: unknown, label: string): string {
  const selected = string(value, label);
  if (!selected || !BASE64.test(selected) || Buffer.from(selected, "base64").toString("base64") !== selected) {
    throw new Error(`${label} must be canonical base64`);
  }
  return selected;
}

function validateClaim(value: unknown, label: string): Claim {
  const selected = record(value, label);
  exactKeys(selected, ["kind", "quote", "subject"], ["expectedCount"], label);
  return {
    kind: oneOf(selected.kind, CLAIM_KINDS, `${label}.kind`),
    quote: string(selected.quote, `${label}.quote`),
    subject: string(selected.subject, `${label}.subject`),
    ...(Object.hasOwn(selected, "expectedCount")
      ? { expectedCount: nonNegativeInteger(selected.expectedCount, `${label}.expectedCount`) }
      : {}),
  };
}

function validateCheckResult(value: unknown, label: string): CheckResult {
  const selected = record(value, label);
  exactKeys(selected, ["claim", "verdict", "evidence"], ["ruleId", "contributesToPass", "blocksPass"], label);
  return {
    claim: validateClaim(selected.claim, `${label}.claim`),
    verdict: oneOf(selected.verdict, VERDICTS, `${label}.verdict`),
    evidence: string(selected.evidence, `${label}.evidence`),
    ...(Object.hasOwn(selected, "ruleId") ? { ruleId: string(selected.ruleId, `${label}.ruleId`) } : {}),
    ...(Object.hasOwn(selected, "contributesToPass")
      ? { contributesToPass: boolean(selected.contributesToPass, `${label}.contributesToPass`) }
      : {}),
    ...(Object.hasOwn(selected, "blocksPass") ? { blocksPass: boolean(selected.blocksPass, `${label}.blocksPass`) } : {}),
  };
}

function validatePolicy(value: unknown): ReportPolicy {
  const selected = record(value, "receipt policy");
  exactKeys(selected, ["minVerified", "strict", "sha256"], ["source"], "receipt policy");
  const minVerified = nonNegativeInteger(selected.minVerified, "receipt policy.minVerified");
  if (minVerified < 1) throw new Error("receipt policy.minVerified must be at least 1");
  return {
    minVerified,
    strict: boolean(selected.strict, "receipt policy.strict"),
    ...(Object.hasOwn(selected, "source") ? { source: string(selected.source, "receipt policy.source") } : {}),
    sha256: digest(selected.sha256, "receipt policy.sha256", true),
  };
}

function summarize(results: CheckResult[], policy: ReportPolicy): TrustReport["summary"] {
  const count = (verdict: Verdict) => results.filter((result) => result.verdict === verdict).length;
  const contradicted = count("contradicted");
  const unverifiable = count("unverifiable");
  const meaningfulVerified = results.filter(
    (result) => result.verdict === "verified" && result.contributesToPass !== false,
  ).length;
  const status: ReportStatus = contradicted > 0
    ? "FAIL"
    : meaningfulVerified < policy.minVerified
      || results.some((result) => result.verdict === "unverifiable" && result.blocksPass)
      || (policy.strict && unverifiable > 0)
      ? "INCONCLUSIVE"
      : "PASS";
  return {
    verified: count("verified"),
    contradicted,
    unverifiable,
    meaningfulVerified,
    status,
    pass: status === "PASS",
  };
}

/**
 * Parse the full receipt-v2 trust boundary. The returned value is a normalized
 * snapshot, so callers do not continue using unchecked nested input objects.
 */
export function validateTrustReport(value: unknown): TrustReport {
  const selected = record(value, "Agent Vigil receipt");
  exactKeys(selected, [
    "schemaVersion", "vigilVersion", "transcript", "transcriptSha256", "transcriptFormat",
    "repo", "base", "head", "generatedAt", "receiptHash", "repository", "reproduction",
    "results", "advisories", "summary", "policy",
  ], ["signature"], "Agent Vigil receipt");
  if (selected.schemaVersion !== "2") throw new Error("unsupported receipt schema: expected version 2");
  const resultValues = array(selected.results, "receipt results");
  const advisoryValues = array(selected.advisories, "receipt advisories");

  const repositoryValue = record(selected.repository, "receipt repository");
  exactKeys(repositoryValue, [], ["remote", "tree"], "receipt repository");
  const repository: TrustReport["repository"] = {
    ...(Object.hasOwn(repositoryValue, "remote") ? { remote: string(repositoryValue.remote, "receipt repository.remote") } : {}),
    ...(Object.hasOwn(repositoryValue, "tree") ? { tree: gitObjectId(repositoryValue.tree, "receipt repository.tree") } : {}),
  };
  const results = resultValues.map((result, index) => validateCheckResult(result, `receipt results[${index}]`));
  const advisories = advisoryValues.map((result, index) => validateCheckResult(result, `receipt advisories[${index}]`));
  const policy = validatePolicy(selected.policy);

  const summaryValue = record(selected.summary, "receipt summary");
  exactKeys(summaryValue, ["verified", "contradicted", "unverifiable", "meaningfulVerified", "status", "pass"], [], "receipt summary");
  const summary: TrustReport["summary"] = {
    verified: nonNegativeInteger(summaryValue.verified, "receipt summary.verified"),
    contradicted: nonNegativeInteger(summaryValue.contradicted, "receipt summary.contradicted"),
    unverifiable: nonNegativeInteger(summaryValue.unverifiable, "receipt summary.unverifiable"),
    meaningfulVerified: nonNegativeInteger(summaryValue.meaningfulVerified, "receipt summary.meaningfulVerified"),
    status: oneOf(summaryValue.status, REPORT_STATUSES, "receipt summary.status"),
    pass: boolean(summaryValue.pass, "receipt summary.pass"),
  };
  const expectedSummary = summarize(results, policy);
  for (const key of ["verified", "contradicted", "unverifiable", "meaningfulVerified", "status", "pass"] as const) {
    if (summary[key] !== expectedSummary[key]) throw new Error(`receipt summary.${key} does not match results and policy`);
  }

  let signature: ReceiptSignature | undefined;
  if (Object.hasOwn(selected, "signature")) {
    const signatureValue = record(selected.signature, "receipt signature");
    exactKeys(signatureValue, ["algorithm", "keyId", "publicKey", "value"], [], "receipt signature");
    if (signatureValue.algorithm !== "Ed25519") throw new Error("receipt signature.algorithm must be Ed25519");
    signature = {
      algorithm: "Ed25519",
      keyId: digest(signatureValue.keyId, "receipt signature.keyId"),
      publicKey: canonicalBase64(signatureValue.publicKey, "receipt signature.publicKey"),
      value: canonicalBase64(signatureValue.value, "receipt signature.value"),
    };
  }

  return {
    schemaVersion: "2",
    vigilVersion: string(selected.vigilVersion, "receipt vigilVersion"),
    transcript: string(selected.transcript, "receipt transcript"),
    transcriptSha256: digest(selected.transcriptSha256, "receipt transcriptSha256", true),
    transcriptFormat: oneOf(selected.transcriptFormat, TRANSCRIPT_FORMATS, "receipt transcriptFormat"),
    repo: string(selected.repo, "receipt repo"),
    base: string(selected.base, "receipt base"),
    head: string(selected.head, "receipt head"),
    generatedAt: canonicalTimestamp(selected.generatedAt, "receipt generatedAt"),
    receiptHash: digest(selected.receiptHash, "receipt receiptHash"),
    repository,
    reproduction: string(selected.reproduction, "receipt reproduction"),
    ...(signature ? { signature } : {}),
    results,
    advisories,
    summary,
    policy,
  };
}

export function buildReport(input: {
  transcript: string;
  transcriptSha256?: string;
  transcriptFormat: string;
  repo: string;
  base: string;
  head: string;
  results: CheckResult[];
  advisories?: CheckResult[];
  policy?: Partial<ReportPolicy>;
  repository?: { remote?: string; tree?: string };
  reproduction?: string;
}): TrustReport {
  const policy: ReportPolicy = {
    minVerified: Math.max(1, input.policy?.minVerified ?? 1),
    strict: input.policy?.strict ?? false,
    ...(input.policy?.source ? { source: input.policy.source } : {}),
    sha256: input.policy?.sha256 ?? "sha256:unavailable",
  };
  const summary = summarize(input.results, policy);

  const advisories = input.advisories ?? [];
  const receiptPayload = {
    schemaVersion: "2",
    vigilVersion: VERSION,
    transcriptFormat: input.transcriptFormat,
    transcriptSha256: input.transcriptSha256 ?? "sha256:unavailable",
    base: input.base,
    head: input.head,
    repository: input.repository ?? {},
    reproduction: input.reproduction ?? "unavailable",
    results: input.results,
    advisories,
    summary,
    policy,
  };

  return validateTrustReport({
    schemaVersion: "2",
    vigilVersion: VERSION,
    transcript: input.transcript,
    transcriptSha256: input.transcriptSha256 ?? "sha256:unavailable",
    transcriptFormat: input.transcriptFormat,
    repo: input.repo,
    base: input.base,
    head: input.head,
    generatedAt: new Date().toISOString(),
    receiptHash: `sha256:${createHash("sha256").update(canonical(receiptPayload)).digest("hex")}`,
    repository: input.repository ?? {},
    reproduction: input.reproduction ?? "unavailable",
    results: input.results,
    advisories,
    summary,
    policy,
  });
}

export function recomputeReceiptHash(value: unknown): string {
  const report = validateTrustReport(value);
  const payload = {
    schemaVersion: report.schemaVersion,
    vigilVersion: report.vigilVersion,
    transcriptFormat: report.transcriptFormat,
    transcriptSha256: report.transcriptSha256,
    base: report.base,
    head: report.head,
    repository: report.repository,
    reproduction: report.reproduction,
    results: report.results,
    advisories: report.advisories,
    summary: report.summary,
    policy: report.policy,
  };
  return `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
}
