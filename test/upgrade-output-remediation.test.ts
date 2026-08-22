import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateTrials, type TargetSnapshot } from "../src/upgrade/decision.ts";
import {
  createPublicCompatibilityEntry,
  recomputeUpgradeReceiptHash,
  renderUpgradeReceipt,
  terminalSafe,
  validatePublicCompatibilityEntry,
  verifyPublicCompatibilityEntry,
  type UpgradePrivateReceipt,
} from "../src/upgrade/receipt.ts";
import type { CanaryTrial } from "../src/upgrade/sandbox.ts";

const IMAGE = `ghcr.io/example/runner:20@sha256:${"a".repeat(64)}`;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function trial(observation: string): CanaryTrial {
  return {
    state: "PASS",
    observationSha256: sha256(observation),
    observationCount: 1,
    reason: "bounded fixture",
  };
}

function snapshot(version: string, tree: string): TargetSnapshot {
  return {
    ecosystem: "agent-plugin",
    name: "fixture-agent",
    version,
    treeSha256: sha256(tree),
    manifestSha256: sha256(`${tree}-manifest`),
    fileCount: 2,
    totalBytes: 128,
    capabilities: [{ field: "tools", count: 1, sha256: sha256("tools") }],
  };
}

function receipt(nonce: string): UpgradePrivateReceipt {
  const current = aggregateTrials([trial("same"), trial("same")]);
  const candidate = aggregateTrials([trial("same"), trial("same")]);
  const value: UpgradePrivateReceipt = {
    schemaVersion: "agent-vigil-upgrade-receipt/v1",
    vigilVersion: "0.12.0-test",
    generatedAt: "2026-08-22T12:00:00.000Z",
    nonce,
    component: { ecosystem: "agent-plugin", name: "fixture-agent" },
    configSha256: sha256("config"),
    runner: {
      engine: "docker",
      image: IMAGE,
      trials: 2,
      network: "none",
      filesystem: "read-only",
      environment: "explicit",
    },
    containment: {
      status: "PASS",
      localEndpoint: true,
      imagePresent: true,
      networkBlocked: true,
      targetReadOnly: true,
      rootReadOnly: true,
      inheritedSecretAbsent: true,
      proxiesCleared: true,
      reason: "all required controls passed",
    },
    current: snapshot("1.0.0", "current"),
    candidate: snapshot("1.1.0", "candidate"),
    canaryHarness: { treeSha256: sha256("harness"), fileCount: 1, totalBytes: 32 },
    capabilities: [{ field: "tools", currentCount: 1, candidateCount: 1, changed: false }],
    canaries: [{
      id: "predictable-private-canary",
      idSha256: sha256("predictable-private-canary"),
      commandSha256: sha256("command"),
      current,
      candidate,
      changed: false,
      comparable: true,
    }],
    summary: {
      verdict: "SAFE",
      reasons: ["no material change was detected"],
      comparedCanaries: 1,
      changedCanaries: 0,
      changedCapabilities: 0,
    },
    limitations: ["bounded evidence"],
    receiptHash: "",
  };
  value.receiptHash = recomputeUpgradeReceiptHash(value);
  return value;
}

function signingKey(): string {
  const directory = mkdtempSync(join(tmpdir(), "vigil-output-remediation-"));
  const path = join(directory, "private.pem");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  return path;
}

test("public canary pseudonyms are nonce-bound and resist a raw ID dictionary guess", () => {
  const key = signingKey();
  const first = createPublicCompatibilityEntry(receipt("receipt-nonce-0000000000000001"), key);
  const second = createPublicCompatibilityEntry(receipt("receipt-nonce-0000000000000002"), key);
  const rawGuess = sha256("predictable-private-canary");

  assert.notEqual(first.canaries[0].idSha256, rawGuess);
  assert.notEqual(second.canaries[0].idSha256, rawGuess);
  assert.notEqual(first.canaries[0].idSha256, second.canaries[0].idSha256);
  assert.equal(first.runner.localEndpoint, true);
  assert.equal(verifyPublicCompatibilityEntry(first).hashValid, true);
  assert.equal(verifyPublicCompatibilityEntry(first).signatureValid, true);
  assert.equal(verifyPublicCompatibilityEntry(second).hashValid, true);
  assert.equal(verifyPublicCompatibilityEntry(second).signatureValid, true);

  const weakened = structuredClone(first);
  weakened.runner.localEndpoint = false;
  assert.throws(
    () => validatePublicCompatibilityEntry(weakened),
    /SAFE public entry is inconsistent with its containment or canary evidence/,
  );
});

test("human receipt output visibly escapes terminal controls without mutating structured evidence", () => {
  const value = receipt("receipt-nonce-0000000000000003");
  value.component.name = "agent\u001b[2J\u202Ename";
  value.current!.version = "1.0.0\nforged";
  value.candidate!.version = "2.0.0\u0085forged";
  value.summary.reasons = ["reason\twith\u2066controls\u2069"];
  value.canaries[0].id = "private\u001b-id";
  value.canaries[0].publicId = "public\u200D-id";
  value.limitations = ["limit\rhidden"];
  const before = structuredClone(value);

  const output = renderUpgradeReceipt(value);
  assert.doesNotMatch(output.replaceAll("\n", ""), /[\p{Cc}\p{Cf}\u2028\u2029]/u);
  assert.match(output, /agent\\u\{001B\}\[2J\\u\{202E\}name/);
  assert.match(output, /1\.0\.0\\u\{000A\}forged/);
  assert.match(output, /2\.0\.0\\u\{0085\}forged/);
  assert.match(output, /reason\\u\{0009\}with\\u\{2066\}controls\\u\{2069\}/);

  for (const untrusted of [value.canaries[0].id, value.canaries[0].publicId!, value.limitations[0]]) {
    const escaped = terminalSafe(untrusted);
    assert.doesNotMatch(escaped, /[\p{Cc}\p{Cf}\u2028\u2029]/u);
    assert.match(escaped, /\\u\{[0-9A-F]{4,6}\}/);
  }
  assert.deepEqual(value, before);
});
