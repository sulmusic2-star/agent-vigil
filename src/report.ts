import { createHash } from "node:crypto";

export const VERSION = "0.11.3";

export type ClaimKind =
  | "tests_pass"
  | "file_changed"
  | "path_exists"
  | "command_ran"
  | "work_complete"
  | "session_behavior"
  | "integrity"
  | "policy_attestation"
  | "change_scope"
  | "differential_test"
  | "authority_scope"
  | "authority_action"
  | "telemetry";

export type Claim = {
  kind: ClaimKind;
  quote: string;
  subject: string;
  expectedCount?: number;
};

export type Verdict = "verified" | "contradicted" | "unverifiable";
export type ReportStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

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
  transcriptFormat: string;
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
  advisories?: CheckResult[];
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
  const count = (verdict: Verdict) => input.results.filter((r) => r.verdict === verdict).length;
  const contradicted = count("contradicted");
  const unverifiable = count("unverifiable");
  const meaningfulVerified = input.results.filter(
    (r) => r.verdict === "verified" && r.contributesToPass !== false,
  ).length;

  let status: ReportStatus;
  if (contradicted > 0) status = "FAIL";
  else if (
    meaningfulVerified < policy.minVerified
    || input.results.some((result) => result.verdict === "unverifiable" && result.blocksPass)
    || (policy.strict && unverifiable > 0)
  ) status = "INCONCLUSIVE";
  else status = "PASS";

  const summary = {
    verified: count("verified"),
    contradicted,
    unverifiable,
    meaningfulVerified,
    status,
    pass: status === "PASS",
  };

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

  return {
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
  };
}

export function recomputeReceiptHash(report: TrustReport): string {
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
    ...(report.advisories !== undefined ? { advisories: report.advisories } : {}),
    summary: report.summary,
    policy: report.policy,
  };
  return `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
}
