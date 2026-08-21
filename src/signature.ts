import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { TrustReport } from "./report.ts";
import { recomputeReceiptHash } from "./report.ts";

export function publicKeyDer(key: ReturnType<typeof createPublicKey>): Buffer {
  return key.export({ type: "spki", format: "der" });
}

export function signingKeyId(der: Buffer): string {
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function signReport(report: TrustReport, privateKeyPath: string): TrustReport {
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  report.signature = {
    algorithm: "Ed25519",
    keyId: signingKeyId(der),
    publicKey: der.toString("base64"),
    value: sign(null, Buffer.from(report.receiptHash), privateKey).toString("base64"),
  };
  return report;
}

export type VerificationResult = {
  hashValid: boolean;
  signatureValid?: boolean;
  keyPinned: boolean;
  keyId?: string;
};

export function verifyReport(report: TrustReport, publicKeyPath?: string): VerificationResult {
  const hashValid = recomputeReceiptHash(report) === report.receiptHash;
  if (!report.signature) return { hashValid, keyPinned: false };
  if (report.signature.algorithm !== "Ed25519") return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  const embedded = createPublicKey({
    key: Buffer.from(report.signature.publicKey, "base64"),
    type: "spki",
    format: "der",
  });
  const selected = publicKeyPath ? createPublicKey(readFileSync(publicKeyPath)) : embedded;
  const selectedDer = publicKeyDer(selected);
  const selectedId = signingKeyId(selectedDer);
  const signatureValid = selectedId === report.signature.keyId
    && verify(null, Buffer.from(report.receiptHash), selected, Buffer.from(report.signature.value, "base64"));
  return { hashValid, signatureValid, keyPinned: Boolean(publicKeyPath), keyId: selectedId };
}

export function generateSigningKey(privatePath: string, publicPath: string): void {
  const pair = generateKeyPairSync("ed25519");
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(privatePath, privatePem, { mode: 0o600, flag: "wx" });
  chmodSync(privatePath, 0o600);
  writeFileSync(publicPath, publicPem, { flag: "wx" });
}

export function publicKeyId(publicKeyPath: string): string {
  const publicKey = createPublicKey(readFileSync(publicKeyPath));
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("public key must be Ed25519");
  return signingKeyId(publicKeyDer(publicKey));
}
