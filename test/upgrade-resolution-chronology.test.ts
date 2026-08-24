import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonical } from "../src/report.ts";
import { publicKeyDer, signingKeyId } from "../src/signature.ts";
import {
  createCompatibilityRegistry,
  createCompatibilityResolution,
  type CompatibilityResolution,
} from "../src/upgrade/network.ts";
import type { PublicCompatibilityEntry } from "../src/upgrade/receipt.ts";

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function signingFixture(): {
  privateKey: KeyObject;
  privateKeyPath: string;
  publicKey: string;
  keyId: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "vigil-resolution-chronology-"));
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "private.pem");
  writeFileSync(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  const der = publicKeyDer(createPublicKey(privateKey));
  return {
    privateKey,
    privateKeyPath,
    publicKey: der.toString("base64"),
    keyId: signingKeyId(der),
  };
}

function compatibilityEntry(input: {
  verdict: "CHANGED" | "SAFE";
  generatedAt: string;
  candidateVersion: string;
  candidateArtifact: string;
  privateKey: KeyObject;
  publicKey: string;
  keyId: string;
}): PublicCompatibilityEntry {
  const matched = input.verdict === "SAFE";
  const unsigned = {
    schemaVersion: "agent-vigil-compatibility-entry/v1" as const,
    vigilVersion: "0.14.0-test",
    generatedAt: input.generatedAt,
    component: {
      ecosystem: "agent-plugin",
      name: "chronology-fixture",
      currentVersion: "1.0.0",
      candidateVersion: input.candidateVersion,
      currentArtifactSha256: sha("baseline-artifact"),
      candidateArtifactSha256: sha(input.candidateArtifact),
    },
    runner: {
      imageDigest: sha("runner-image"),
      trials: 2,
      localEndpoint: true,
      networkBlocked: true,
      readOnly: true,
      environmentIsolated: true,
      configSha256: sha("config"),
      canaryHarnessSha256: sha("canary-harness"),
    },
    verdict: input.verdict,
    changedCapabilities: [],
    canaries: [{
      publicId: "startup-contract",
      idSha256: sha("canary-id"),
      current: "PASS" as const,
      candidate: matched ? "PASS" as const : "FAIL" as const,
      matched,
    }],
    privateReceiptCommitment: sha(`${input.verdict}-receipt`),
    limitations: ["Bounded to this exact recorded pair."],
  };
  const entryHash = sha(canonical(unsigned));
  return {
    ...unsigned,
    entryHash,
    signature: {
      algorithm: "Ed25519",
      keyId: input.keyId,
      publicKey: input.publicKey,
      value: sign(null, Buffer.from(entryHash), input.privateKey).toString("base64"),
    },
  };
}

function resignResolution(
  resolution: CompatibilityResolution,
  fixedEntryHash: string,
  privateKey: KeyObject,
): CompatibilityResolution {
  const updated = structuredClone(resolution);
  updated.fixed.entryHash = fixedEntryHash;
  const { resolutionHash: _oldHash, signature: _oldSignature, ...unsigned } = updated;
  updated.resolutionHash = sha(canonical(unsigned));
  updated.signature.value = sign(null, Buffer.from(updated.resolutionHash), privateKey).toString("base64");
  return updated;
}

function entries(fixedGeneratedAt: string) {
  const keys = signingFixture();
  const broken = compatibilityEntry({
    verdict: "CHANGED",
    generatedAt: "2026-08-23T10:00:00.000Z",
    candidateVersion: "2.0.0",
    candidateArtifact: "broken-artifact",
    ...keys,
  });
  const fixed = compatibilityEntry({
    verdict: "SAFE",
    generatedAt: fixedGeneratedAt,
    candidateVersion: "2.0.1",
    candidateArtifact: "fixed-artifact",
    ...keys,
  });
  return { ...keys, broken, fixed };
}

test("resolution creation requires fixed evidence to be strictly later", () => {
  for (const fixedGeneratedAt of [
    "2026-08-23T09:59:59.999Z",
    "2026-08-23T10:00:00.000Z",
  ]) {
    const { broken, fixed, privateKeyPath } = entries(fixedGeneratedAt);
    assert.throws(
      () => createCompatibilityResolution({ broken, fixed, privateKeyPath }),
      /strictly later/,
    );
  }

  const { broken, fixed, privateKeyPath } = entries("2026-08-23T10:00:00.001Z");
  assert.doesNotThrow(() => createCompatibilityResolution({ broken, fixed, privateKeyPath }));
});

test("registry validation rejects signed resolutions whose referenced fixed evidence is not later", () => {
  for (const fixedGeneratedAt of [
    "2026-08-23T09:59:59.999Z",
    "2026-08-23T10:00:00.000Z",
  ]) {
    const valid = entries("2026-08-23T10:00:00.001Z");
    const resolution = createCompatibilityResolution({
      broken: valid.broken,
      fixed: valid.fixed,
      privateKeyPath: valid.privateKeyPath,
      generatedAt: "2026-08-23T12:00:00.000Z",
    });
    const fixed = compatibilityEntry({
      verdict: "SAFE",
      generatedAt: fixedGeneratedAt,
      candidateVersion: "2.0.1",
      candidateArtifact: "fixed-artifact",
      privateKey: valid.privateKey,
      publicKey: valid.publicKey,
      keyId: valid.keyId,
    });
    const signedResolution = resignResolution(resolution, fixed.entryHash, valid.privateKey);

    assert.throws(
      () => createCompatibilityRegistry([valid.broken, fixed], [signedResolution]),
      /strictly later/,
    );
  }
});
