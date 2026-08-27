import { type ContinuityState, type LoadedContinuityPolicy } from "./contracts.ts";
import type { ChainVerification } from "./chain.ts";
export type ContinuityReason = {
    ruleId: string;
    disposition: "revoke" | "expire" | "hold" | "observe";
    eventId?: string;
    source?: string;
    message: string;
};
export type ContinuityOutcomeFact = {
    eventId: string;
    kind: "merged" | "deployed" | "reverted" | "hotfixed" | "incident_linked" | "no_known_event_through";
    observedAt: string;
};
export type ContinuityDecision = {
    schemaVersion: "agent-vigil-continuity-decision/v1";
    evaluatedAt: string;
    historicalVerification: "PASS" | "FAIL" | "INCONCLUSIVE";
    continuity: ContinuityState;
    allowsProtectedAction: boolean;
    protectedEnvironment: string | null;
    rootHash: string;
    chainTip: string;
    eventCount: number;
    policy: {
        sourceHash: string;
        sha256: string;
    };
    outcomeFacts: ContinuityOutcomeFact[];
    reasons: ContinuityReason[];
    decisionHash: string;
};
export declare function evaluateContinuity(verification: ChainVerification, loadedPolicy: LoadedContinuityPolicy, options?: {
    now?: Date;
    environment?: string;
}): ContinuityDecision;
