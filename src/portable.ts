import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical, recomputeReceiptHash, type ReportStatus, type TrustReport } from "./report.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export type PortableReceipt = {
  schemaVersion: "1";
  type: "agent-vigil/portable-receipt";
  vigilVersion: string;
  reportHash: string;
  resultsHash: string;
  transcriptSha256: string;
  base: string;
  head: string;
  repository: { remote?: string; tree?: string };
  policy: { sha256: string };
  summary: {
    verified: number;
    contradicted: number;
    unverifiable: number;
    meaningfulVerified: number;
    status: ReportStatus;
    pass: boolean;
  };
  issuedAt: string;
  portableHash: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
    value: string;
  };
};

type PortablePayload = Omit<PortableReceipt, "portableHash" | "signature">;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function payloadOf(receipt: PortableReceipt): PortablePayload {
  const { portableHash: _hash, signature: _signature, ...payload } = receipt;
  return payload;
}

export function createPortableReceipt(report: TrustReport, privateKeyPath: string): PortableReceipt {
  if (recomputeReceiptHash(report) !== report.receiptHash) throw new Error("full receipt hash is invalid; refusing to seal it");
  if (!report.repository.tree) {
    throw new Error("portable receipt requires a committed head tree; rerun with --head <sha> instead of WORKTREE");
  }
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  const payload: PortablePayload = {
    schemaVersion: "1",
    type: "agent-vigil/portable-receipt",
    vigilVersion: report.vigilVersion,
    reportHash: report.receiptHash,
    resultsHash: digest(report.results),
    transcriptSha256: report.transcriptSha256,
    base: report.base,
    head: report.head,
    repository: report.repository,
    policy: { sha256: report.policy.sha256 },
    summary: report.summary,
    issuedAt: new Date().toISOString(),
  };
  const portableHash = digest(payload);
  return {
    ...payload,
    portableHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(portableHash), privateKey).toString("base64"),
    },
  };
}

export type PortableVerification = {
  hashValid: boolean;
  signatureValid: boolean;
  signerTrusted: boolean;
  keyId?: string;
  errors: string[];
};

export function verifyPortableReceipt(receipt: PortableReceipt, trustedKeyIds: string[] = []): PortableVerification {
  const errors: string[] = [];
  if (!receipt || typeof receipt !== "object") return { hashValid: false, signatureValid: false, signerTrusted: false, errors: ["portable receipt must be an object"] };
  if (receipt.schemaVersion !== "1" || receipt.type !== "agent-vigil/portable-receipt") errors.push("unsupported portable receipt schema or type");
  for (const [label, value] of [
    ["reportHash", receipt.reportHash],
    ["resultsHash", receipt.resultsHash],
    ["transcriptSha256", receipt.transcriptSha256],
    ["policy.sha256", receipt.policy?.sha256],
    ["portableHash", receipt.portableHash],
    ["signature.keyId", receipt.signature?.keyId],
  ] as const) if (!SHA256.test(String(value ?? ""))) errors.push(`${label} is not a SHA-256 identifier`);
  if (!receipt.base || !receipt.head || !receipt.repository?.tree) errors.push("base, head, and repository tree are required");
  if (!receipt.summary || !new Set(["PASS", "FAIL", "INCONCLUSIVE"]).has(receipt.summary.status)) errors.push("summary status is invalid");
  if (receipt.summary && receipt.summary.pass !== (receipt.summary.status === "PASS")) errors.push("summary pass flag disagrees with status");
  const hashMatches = digest(payloadOf(receipt)) === receipt.portableHash;
  if (!hashMatches) errors.push("portable receipt hash is invalid");
  const hashValid = errors.length === 0 && hashMatches;

  let signatureValid = false;
  let keyId: string | undefined;
  try {
    if (receipt.signature?.algorithm !== "Ed25519") throw new Error("signature algorithm must be Ed25519");
    const publicKey = createPublicKey({ key: Buffer.from(receipt.signature.publicKey, "base64"), type: "spki", format: "der" });
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("embedded public key must be Ed25519");
    keyId = signingKeyId(publicKeyDer(publicKey));
    signatureValid = keyId === receipt.signature.keyId
      && verify(null, Buffer.from(receipt.portableHash), publicKey, Buffer.from(receipt.signature.value, "base64"));
    if (!signatureValid) errors.push("portable receipt signature is invalid");
  } catch (error) {
    errors.push(`portable receipt signature could not be read: ${(error as Error).message}`);
  }
  const signerTrusted = Boolean(keyId) && trustedKeyIds.includes(keyId!);
  if (!signerTrusted) errors.push("signer key ID is not pinned by the trusted policy");
  return { hashValid, signatureValid, signerTrusted, ...(keyId ? { keyId } : {}), errors };
}
