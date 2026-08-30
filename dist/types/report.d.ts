export declare const VERSION = "0.23.0";
export declare const CLAIM_KINDS: readonly ["tests_pass", "file_changed", "path_exists", "command_ran", "work_complete", "session_behavior", "integrity", "policy_attestation", "change_scope", "differential_test", "authority_scope", "authority_action", "telemetry"];
export type ClaimKind = typeof CLAIM_KINDS[number];
export declare const TRANSCRIPT_FORMATS: readonly ["claude-code", "codex", "cursor", "gemini-cli", "github-copilot-cli", "opencode", "aider", "markdown", "portable-receipt", "pull-request-evidence", "unified-git-diff", "test-integrity-diff", "github-merge-group-event", "authority/claude-code", "authority/codex", "authority/cursor", "authority/gemini-cli", "authority/github-copilot-cli", "authority/opencode", "authority/aider", "authority/markdown"];
export type TrustReportTranscriptFormat = typeof TRANSCRIPT_FORMATS[number];
export type Claim = {
    kind: ClaimKind;
    quote: string;
    subject: string;
    expectedCount?: number;
};
export declare const VERDICTS: readonly ["verified", "contradicted", "unverifiable"];
export type Verdict = typeof VERDICTS[number];
export declare const REPORT_STATUSES: readonly ["PASS", "FAIL", "INCONCLUSIVE"];
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
export declare function canonical(value: unknown): string;
/**
 * Parse the full receipt-v2 trust boundary. The returned value is a normalized
 * snapshot, so callers do not continue using unchecked nested input objects.
 */
export declare function validateTrustReport(value: unknown): TrustReport;
export declare function buildReport(input: {
    transcript: string;
    transcriptSha256?: string;
    transcriptFormat: string;
    repo: string;
    base: string;
    head: string;
    results: CheckResult[];
    advisories?: CheckResult[];
    policy?: Partial<ReportPolicy>;
    repository?: {
        remote?: string;
        tree?: string;
    };
    reproduction?: string;
}): TrustReport;
export declare function recomputeReceiptHash(value: unknown): string;
