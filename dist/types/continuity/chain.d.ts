import { type TrustReport } from "../report.ts";
import { type ContinuityEvent, type ContinuityRoot, type ContinuitySubject } from "./contracts.ts";
export type RootSignatureState = {
    present: boolean;
    valid: boolean;
    keyId?: string;
};
export type ChainVerification = {
    valid: boolean;
    errors: string[];
    root: ContinuityRoot;
    report: TrustReport;
    events: ContinuityEvent[];
    chainTip: string;
    rootSignature: RootSignatureState;
};
export declare function computeEventHash(event: ContinuityEvent): string;
export declare function initializeContinuityChain(receiptPath: string, outputDirectory: string, now?: Date): ContinuityRoot;
export declare function verifyContinuityChain(chainDirectory: string, options?: {
    now?: Date;
    maxClockSkewSeconds?: number;
    pinnedEventKeyIds?: string[];
    expectedBase?: string;
    expectedHead?: string;
    repo?: string;
}): ChainVerification;
export declare function createStoredEvent(draftValue: unknown, root: ContinuityRoot, priorEvents: ContinuityEvent[], privateKeyPath?: string, now?: Date): ContinuityEvent;
export declare function appendContinuityEvent(chainDirectory: string, draft: unknown, privateKeyPath?: string): ContinuityEvent;
export declare function continuitySubjectTemplate(root: ContinuityRoot): ContinuitySubject;
export declare function chainExists(path: string): boolean;
export declare function chainName(path: string): string;
