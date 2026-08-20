import { createHash } from "node:crypto";

export const VERSION = "0.3.0";

export type ClaimKind =
  | "tests_pass"
  | "file_changed"
  | "path_exists"
  | "command_ran"
  | "work_complete"
  | "session_behavior"
  | "integrity";

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
};

export type ReportPolicy = {
  minVerified: number;
  strict: boolean;
};

export type TrustReport = {
  schemaVersion: "1";
  vigilVersion: string;
  transcript: string;
  transcriptSha256: string;
  transcriptFormat: string;
  repo: string;
  base: string;
  head: string;
  generatedAt: string;
  receiptHash: string;
  results: CheckResult[];
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
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
  policy?: Partial<ReportPolicy>;
}): TrustReport {
  const policy: ReportPolicy = {
    minVerified: Math.max(1, input.policy?.minVerified ?? 1),
    strict: input.policy?.strict ?? false,
  };
  const count = (verdict: Verdict) => input.results.filter((r) => r.verdict === verdict).length;
  const contradicted = count("contradicted");
  const unverifiable = count("unverifiable");
  const meaningfulVerified = input.results.filter(
    (r) => r.verdict === "verified" && r.contributesToPass !== false,
  ).length;

  let status: ReportStatus;
  if (contradicted > 0) status = "FAIL";
  else if (meaningfulVerified < policy.minVerified || (policy.strict && unverifiable > 0)) status = "INCONCLUSIVE";
  else status = "PASS";

  const receiptPayload = {
    schemaVersion: "1",
    vigilVersion: VERSION,
    transcriptFormat: input.transcriptFormat,
    transcriptSha256: input.transcriptSha256 ?? "sha256:unavailable",
    base: input.base,
    head: input.head,
    results: input.results,
    status,
    policy,
  };

  return {
    schemaVersion: "1",
    vigilVersion: VERSION,
    transcript: input.transcript,
    transcriptSha256: input.transcriptSha256 ?? "sha256:unavailable",
    transcriptFormat: input.transcriptFormat,
    repo: input.repo,
    base: input.base,
    head: input.head,
    generatedAt: new Date().toISOString(),
    receiptHash: `sha256:${createHash("sha256").update(canonical(receiptPayload)).digest("hex")}`,
    results: input.results,
    summary: {
      verified: count("verified"),
      contradicted,
      unverifiable,
      meaningfulVerified,
      status,
      pass: status === "PASS",
    },
    policy,
  };
}
