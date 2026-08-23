import {
  ENTRY_SCHEMA,
  RESOLUTION_SCHEMA,
  canonical,
  sha256,
  type CompatibilityResolution,
  type PublicCompatibilityEntry,
  type Verdict,
} from "../src/contracts";

export type SigningFixture = { privateKey: CryptoKey; publicKeyBase64: string; keyId: string };

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

export async function signingFixture(): Promise<SigningFixture> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("Ed25519 generation did not return a key pair");
  const publicKey = await crypto.subtle.exportKey("spki", pair.publicKey) as ArrayBuffer;
  const publicKeyBase64 = base64(publicKey);
  return { privateKey: pair.privateKey, publicKeyBase64, keyId: await sha256(new Uint8Array(publicKey)) };
}

export async function signedEntry(
  signer: SigningFixture,
  input: { verdict?: Verdict; candidateVersion?: string; generatedAt?: string } = {},
): Promise<PublicCompatibilityEntry> {
  const verdict = input.verdict ?? "SAFE";
  const changed = verdict === "CHANGED";
  const hold = verdict === "HOLD";
  const unsigned = {
    schemaVersion: ENTRY_SCHEMA,
    vigilVersion: "0.15.0-dev.0",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    component: {
      ecosystem: "apm",
      name: "public-agent-package",
      currentVersion: "1.0.0",
      candidateVersion: input.candidateVersion ?? (changed ? "1.1.0-broken" : hold ? "1.1.0-hold" : "1.1.0"),
      currentArtifactSha256: `sha256:${"1".repeat(64)}`,
      candidateArtifactSha256: `sha256:${changed ? "2".repeat(64) : hold ? "3".repeat(64) : "4".repeat(64)}`,
    },
    runner: {
      imageDigest: `sha256:${"5".repeat(64)}`,
      trials: 2,
      localEndpoint: true,
      networkBlocked: true,
      readOnly: true,
      environmentIsolated: true,
      configSha256: `sha256:${"6".repeat(64)}`,
      canaryHarnessSha256: `sha256:${"7".repeat(64)}`,
    },
    verdict,
    changedCapabilities: changed ? ["tools"] : [],
    canaries: [{
      publicId: "basic-behavior",
      idSha256: `sha256:${"8".repeat(64)}`,
      current: "PASS" as const,
      candidate: changed ? "FAIL" as const : hold ? "HOLD" as const : "PASS" as const,
      matched: !changed && !hold,
    }],
    privateReceiptCommitment: `sha256:${"9".repeat(64)}`,
    limitations: ["Bounded fixture evidence only."],
  };
  const entryHash = await sha256(canonical(unsigned));
  const signature = await crypto.subtle.sign("Ed25519", signer.privateKey, new TextEncoder().encode(entryHash));
  return {
    ...unsigned,
    entryHash,
    signature: { algorithm: "Ed25519", keyId: signer.keyId, publicKey: signer.publicKeyBase64, value: base64(signature) },
  };
}

export async function signedResolution(
  signer: SigningFixture,
  broken: PublicCompatibilityEntry,
  fixed: PublicCompatibilityEntry,
): Promise<CompatibilityResolution> {
  const unsigned = {
    schemaVersion: RESOLUTION_SCHEMA,
    vigilVersion: "0.15.0-dev.0",
    generatedAt: new Date(Date.parse(fixed.generatedAt) + 1_000).toISOString(),
    component: { ecosystem: broken.component.ecosystem, name: broken.component.name },
    broken: {
      entryHash: broken.entryHash,
      baselineVersion: broken.component.currentVersion,
      brokenVersion: broken.component.candidateVersion,
      brokenArtifactSha256: broken.component.candidateArtifactSha256,
    },
    fixed: {
      entryHash: fixed.entryHash,
      baselineVersion: fixed.component.currentVersion,
      fixedVersion: fixed.component.candidateVersion,
      fixedArtifactSha256: fixed.component.candidateArtifactSha256,
    },
    relation: "RESTORED_RECORDED_COMPATIBILITY" as const,
    limitations: ["Restores only the recorded baseline canary behavior."],
  };
  const resolutionHash = await sha256(canonical(unsigned));
  const signature = await crypto.subtle.sign("Ed25519", signer.privateKey, new TextEncoder().encode(resolutionHash));
  return {
    ...unsigned,
    resolutionHash,
    signature: { algorithm: "Ed25519", keyId: signer.keyId, publicKey: signer.publicKeyBase64, value: base64(signature) },
  };
}

export async function publisherRequestHeaders(
  signer: SigningFixture,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const timestamp = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const bodySha256 = await sha256(new TextEncoder().encode(body));
  const message = `agent-vigil-hosted-request/v1\nPOST\n${path}\n${requestId}\n${timestamp}\n${bodySha256}`;
  const signature = await crypto.subtle.sign("Ed25519", signer.privateKey, new TextEncoder().encode(message));
  return {
    "Content-Type": "application/json",
    "X-Agent-Vigil-Publisher-Key": signer.keyId,
    "X-Agent-Vigil-Request-Id": requestId,
    "X-Agent-Vigil-Timestamp": timestamp,
    "X-Agent-Vigil-Signature": base64(signature),
  };
}
