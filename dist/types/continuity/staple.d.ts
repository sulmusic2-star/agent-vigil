import { type ContinuitySignature, type ContinuityState, type ContinuitySubject } from "./contracts.ts";
import type { ChainVerification } from "./chain.ts";
import type { ContinuityDecision } from "./decision.ts";
export declare const CONTINUITY_STAPLE_SCHEMA: "agent-vigil-continuity-staple/v1";
export declare const DEFAULT_STAPLE_TTL_SECONDS = 300;
export declare const MAX_STAPLE_TTL_SECONDS = 900;
export declare const STAPLE_CLOCK_SKEW_SECONDS = 60;
export type ContinuityStaplePayload = {
    schemaVersion: typeof CONTINUITY_STAPLE_SCHEMA;
    subject: ContinuitySubject;
    decision: {
        continuity: ContinuityState;
        allowsProtectedAction: boolean;
        evaluatedAt: string;
        decisionHash: string;
    };
    evidence: {
        rootHash: string;
        chainTip: string;
        sequence: number;
        eventCount: number;
    };
    policy: {
        sourceHash: string;
        sha256: string;
    };
    environment: string;
    issuedAt: string;
    expiresAt: string;
};
export type SignedContinuityStaple = {
    schemaVersion: typeof CONTINUITY_STAPLE_SCHEMA;
    payload: ContinuityStaplePayload;
    payloadHash: string;
    signature: ContinuitySignature;
};
export type ContinuityStapleVerification = {
    schemaVersion: "agent-vigil-continuity-staple-verification/v1";
    valid: true;
    fresh: boolean;
    signerPinned: true;
    embeddedContinuity: ContinuityState;
    effectiveContinuity: ContinuityState;
    allowsProtectedAction: boolean;
    subject: ContinuitySubject;
    environment: string;
    policySha256: string;
    chainTip: string;
    sequence: number;
    issuedAt: string;
    expiresAt: string;
    payloadHash: string;
    signerKeyId: string;
    limits: string[];
};
type VerifyStapleBindings = {
    expectedHead: string;
    expectedReceiptHash: string;
    expectedEnvironment: string;
    expectedPolicySha256: string;
    now?: Date;
    minimumSequence?: number;
    expectedChainTip?: string;
};
export type VerifyStapleOptions = VerifyStapleBindings & ({
    publicKeyPath: string;
    publicKeyPem?: never;
} | {
    publicKeyPem: string | Uint8Array;
    publicKeyPath?: never;
});
export declare const MAX_CONTINUITY_STAPLE_BYTES: number;
export declare function issueContinuityStaple(options: {
    verification: ChainVerification;
    decision: ContinuityDecision;
    privateKeyPath: string;
    ttlSeconds?: number;
}): SignedContinuityStaple;
export declare function loadContinuityStaple(path: string): unknown;
export declare function parseContinuityStapleJson(value: string): unknown;
export declare function verifyContinuityStaple(input: unknown, options: VerifyStapleOptions): ContinuityStapleVerification;
export {};
