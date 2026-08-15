// Core domain model: an agent SESSION makes CLAIMS; each claim is CHECKED
// against repo reality by a deterministic detector; the RESULT set becomes a
// trust report and a CI exit code. No LLM anywhere in the verification path —
// that is the entire point.

export type ClaimKind =
  | "tests_pass" // "all tests pass", "422 tests passing"
  | "file_changed" // "I updated src/auth.ts"
  | "path_exists" // any concrete path the summary references
  | "work_complete"; // "done/implemented/fixed" (checked for leftover markers)

export type Claim = {
  kind: ClaimKind;
  /** verbatim snippet from the agent's message that asserts this */
  quote: string;
  /** normalized subject: a path, a test command, etc. */
  subject: string;
};

export type Verdict = "verified" | "contradicted" | "unverifiable";

export type CheckResult = {
  claim: Claim;
  verdict: Verdict;
  /** what reality showed, in plain words */
  evidence: string;
};

export type TrustReport = {
  transcript: string;
  repo: string;
  generatedAt: string;
  results: CheckResult[];
  summary: {
    verified: number;
    contradicted: number;
    unverifiable: number;
    /** the CI gate: true iff nothing was contradicted */
    pass: boolean;
  };
};

export function buildReport(
  transcript: string,
  repo: string,
  results: CheckResult[],
): TrustReport {
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const contradicted = count("contradicted");
  return {
    transcript,
    repo,
    generatedAt: new Date().toISOString(),
    results,
    summary: {
      verified: count("verified"),
      contradicted,
      unverifiable: count("unverifiable"),
      pass: contradicted === 0,
    },
  };
}
