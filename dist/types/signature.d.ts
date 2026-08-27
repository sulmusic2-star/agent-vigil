import { createPublicKey } from "node:crypto";
import type { TrustReport } from "./report.ts";
export declare function publicKeyDer(key: ReturnType<typeof createPublicKey>): Buffer;
export declare function signingKeyId(der: Buffer): string;
export declare function signReport(report: TrustReport, privateKeyPath: string): TrustReport;
export type VerificationResult = {
    hashValid: boolean;
    signatureValid?: boolean;
    keyPinned: boolean;
    keyId?: string;
};
export declare function verifyReport(value: unknown, publicKeyPath?: string): VerificationResult;
export declare function generateSigningKey(privatePath: string, publicPath: string): void;
export declare function publicKeyId(publicKeyPath: string): string;
