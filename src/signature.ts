import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { readBoundedRegularFile } from "./continuity/contracts.ts";
import type { TrustReport } from "./report.ts";
import { recomputeReceiptHash, validateTrustReport } from "./report.ts";

const MAX_SIGNING_KEY_BYTES = 64 * 1024;

function readSigningKey(path: string, label: string): Buffer {
  return readBoundedRegularFile(path, MAX_SIGNING_KEY_BYTES, label);
}

export function publicKeyDer(key: ReturnType<typeof createPublicKey>): Buffer {
  return key.export({ type: "spki", format: "der" });
}

export function signingKeyId(der: Buffer): string {
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function signReport(report: TrustReport, privateKeyPath: string): TrustReport {
  const validated = validateTrustReport(report);
  if (recomputeReceiptHash(validated) !== validated.receiptHash) {
    throw new Error("receipt content does not match receiptHash; refusing to sign it");
  }
  const privateKey = createPrivateKey(readSigningKey(privateKeyPath, "signing private key"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  return {
    ...validated,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(validated.receiptHash), privateKey).toString("base64"),
    },
  };
}

export type VerificationResult = {
  hashValid: boolean;
  signatureValid?: boolean;
  keyPinned: boolean;
  keyId?: string;
};

export function verifyReport(value: unknown, publicKeyPath?: string): VerificationResult {
  const report = validateTrustReport(value);
  const hashValid = recomputeReceiptHash(report) === report.receiptHash;
  if (!report.signature) return { hashValid, keyPinned: false };
  try {
    const embedded = createPublicKey({
      key: Buffer.from(report.signature.publicKey, "base64"),
      type: "spki",
      format: "der",
    });
    const selected = publicKeyPath ? createPublicKey(readSigningKey(publicKeyPath, "pinned public key")) : embedded;
    const embeddedId = signingKeyId(publicKeyDer(embedded));
    const selectedId = signingKeyId(publicKeyDer(selected));
    const signatureValid = embedded.asymmetricKeyType === "ed25519"
      && selected.asymmetricKeyType === "ed25519"
      && embeddedId === report.signature.keyId
      && selectedId === report.signature.keyId
      && verify(null, Buffer.from(report.receiptHash), selected, Buffer.from(report.signature.value, "base64"));
    return { hashValid, signatureValid, keyPinned: Boolean(publicKeyPath), keyId: selectedId };
  } catch {
    return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  }
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
  const publicKey = createPublicKey(readSigningKey(publicKeyPath, "public key"));
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("public key must be Ed25519");
  return signingKeyId(publicKeyDer(publicKey));
}
