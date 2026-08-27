export declare const CONTINUITY_EVENT_KINDS: readonly ["merge_observed", "deployment_observed", "revert_observed", "hotfix_observed", "incident_linked", "verification_refreshed", "policy_superseded", "authority_changed", "agent_upgrade_changed", "security_advisory_observed", "credential_revoked", "attestation_invalid", "monitor_checkpoint", "coverage_gap", "exception_granted", "remediation_verified"];
export declare const CONTINUITY_DISPOSITIONS: readonly ["affirm", "hold", "revoke", "observe"];
export declare const CONTINUITY_PRIVACY_TIERS: readonly ["receipt", "metadata", "full-local"];
export declare const CONTINUITY_STATES: readonly ["CURRENT", "HOLD", "EXPIRED", "REVOKED"];
export type ContinuityEventKind = typeof CONTINUITY_EVENT_KINDS[number];
export type ContinuityDisposition = typeof CONTINUITY_DISPOSITIONS[number];
export type ContinuityPrivacyTier = typeof CONTINUITY_PRIVACY_TIERS[number];
export type ContinuityState = typeof CONTINUITY_STATES[number];
export type ContinuitySubject = {
    episodeReceiptHash: string;
    repositoryHash: string;
    baseSha: string;
    headSha: string;
};
export type ContinuityEventDraft = {
    schemaVersion: "agent-vigil-continuity-event/v1";
    eventId: string;
    subject: ContinuitySubject;
    source: {
        kind: string;
        issuer: string;
        evidenceHash: string;
        deliveryIdHash: string | null;
    };
    event: {
        kind: ContinuityEventKind;
        disposition: ContinuityDisposition;
        reasonCode: string;
        targetHash: string | null;
        freshUntil: string | null;
        supersedesEventId: string | null;
    };
    observedAt: string;
    effectiveAt: string;
    privacyTier: ContinuityPrivacyTier;
};
export type ContinuitySignature = {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
    value: string;
};
export type ContinuityEvent = ContinuityEventDraft & {
    sequence: number;
    predecessorHash: string;
    eventHash: string;
    signature: ContinuitySignature | null;
};
export type ContinuityRoot = {
    schemaVersion: "agent-vigil-continuity-root/v1";
    receiptFileSha256: string;
    receiptHash: string;
    rootHash: string;
    subject: ContinuitySubject;
    historicalVerification: "PASS" | "FAIL" | "INCONCLUSIVE";
    createdAt: string;
};
export type ContinuityPolicy = {
    schemaVersion: "agent-vigil-continuity-policy/v1";
    requiredSources: string[];
    maxAgeSeconds: Record<string, number>;
    denyOn: ContinuityEventKind[];
    allowRemediation: boolean;
    requireSignedRoot: boolean;
    requireSignedEvents: boolean;
    trustedRootKeyIds: string[];
    trustedIssuerKeyIds: string[];
    protectedEnvironments: string[];
    maxClockSkewSeconds: number;
};
export type LoadedContinuityPolicy = {
    value: ContinuityPolicy;
    source: string;
    sha256: string;
};
export declare function validateProtectedEnvironment(value: unknown): string;
export declare function validateContinuitySubject(value: unknown): ContinuitySubject;
export declare function validateEventDraft(value: unknown): ContinuityEventDraft;
export declare function validateStoredEvent(value: unknown): ContinuityEvent;
export declare function validateContinuityRoot(value: unknown): ContinuityRoot;
export declare function validateContinuityPolicy(value: unknown): ContinuityPolicy;
export declare function sha256(value: string | Buffer): string;
export declare function canonicalSha256(value: unknown): string;
export declare function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Buffer;
export declare function readBoundedJson(path: string, maximumBytes: number, label: string): unknown;
export declare function loadEventDraft(path: string): ContinuityEventDraft;
export declare function loadContinuityPolicy(options: {
    path: string;
    repo?: string;
    ref?: string;
}): LoadedContinuityPolicy;
