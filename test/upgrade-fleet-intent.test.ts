import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonical } from "../src/report.ts";
import { publicKeyDer, signingKeyId } from "../src/signature.ts";
import { runUpgradeCommand } from "../src/upgrade/cli.ts";
import {
  enforceFleetPolicy,
  validateFleetPolicy,
  type FleetDeploymentIntent,
  type FleetPolicy,
} from "../src/upgrade/fleet.ts";
import type { PublicCompatibilityEntry } from "../src/upgrade/receipt.ts";

function sha(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function fixture(): {
  entry: PublicCompatibilityEntry;
  intent: FleetDeploymentIntent;
  policy: FleetPolicy;
  publicKeyPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "vigil-fleet-intent-"));
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPath = join(directory, "publisher.pem");
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }));
  const generatedAt = new Date(Date.now() - 60_000).toISOString();
  const unsigned = {
    schemaVersion: "agent-vigil-compatibility-entry/v1",
    vigilVersion: "0.14.0-test",
    generatedAt,
    component: {
      ecosystem: "agent-plugin",
      name: "fixture-agent",
      currentVersion: "1.0.0",
      candidateVersion: "2.0.0",
      currentArtifactSha256: sha("artifact-1.0.0"),
      candidateArtifactSha256: sha("artifact-2.0.0"),
    },
    runner: {
      imageDigest: sha("runner"),
      trials: 2,
      localEndpoint: true,
      networkBlocked: true,
      readOnly: true,
      environmentIsolated: true,
      configSha256: sha("config"),
      canaryHarnessSha256: sha("canary-harness"),
    },
    verdict: "SAFE",
    changedCapabilities: [],
    canaries: [{
      publicId: "startup-contract",
      idSha256: sha("canary-id"),
      current: "PASS",
      candidate: "PASS",
      matched: true,
    }],
    privateReceiptCommitment: sha("private-receipt"),
    limitations: ["Bounded to this exact recorded pair."],
  } satisfies Omit<PublicCompatibilityEntry, "entryHash" | "signature">;
  const entryHash = sha(canonical(unsigned));
  const der = publicKeyDer(createPublicKey(pair.privateKey));
  const entry: PublicCompatibilityEntry = {
    ...unsigned,
    entryHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(entryHash), pair.privateKey).toString("base64"),
    },
  };
  const intent: FleetDeploymentIntent = {
    currentVersion: entry.component.currentVersion,
    candidateVersion: entry.component.candidateVersion,
    currentArtifactSha256: entry.component.currentArtifactSha256,
    candidateArtifactSha256: entry.component.candidateArtifactSha256,
  };
  const policy = validateFleetPolicy({
    schemaVersion: "agent-vigil-fleet-policy/v1",
    policyId: "platform-agent-updates",
    allowedPublisherKeyIds: [entry.signature.keyId],
    allowedComponents: [{ ecosystem: entry.component.ecosystem, name: entry.component.name }],
    allowedRunnerImages: [entry.runner.imageDigest],
    allowedConfigSha256: [entry.runner.configSha256],
    allowedCanaryHarnessSha256: [entry.runner.canaryHarnessSha256],
    maxEvidenceAgeHours: 8_760,
    minimumCanaries: 1,
  });
  return { entry, intent, policy, publicKeyPath };
}

test("fleet ALLOW is bound to exact trusted caller deployment intent", () => {
  const { entry, intent, policy, publicKeyPath } = fixture();
  const evaluatedAt = new Date(Date.parse(entry.generatedAt) + 60_000).toISOString();
  const decision = enforceFleetPolicy({ policy, entry, deploymentIntent: intent, evaluatedAt });
  assert.equal(decision.status, "ALLOW");
  assert.deepEqual(decision.deploymentIntent, { source: "trusted-caller", ...intent });
  assert.match(decision.reasons[0], /matches trusted deployment intent/);

  const directory = mkdtempSync(join(tmpdir(), "vigil-fleet-intent-cli-"));
  const entryPath = join(directory, "entry.json");
  const policyPath = join(directory, "policy.json");
  const decisionPath = join(directory, "decision.json");
  writeFileSync(entryPath, `${JSON.stringify(entry)}\n`);
  writeFileSync(policyPath, `${JSON.stringify(policy)}\n`);
  const code = runUpgradeCommand([
    "enforce", entryPath,
    "--policy", policyPath,
    "--public-key", publicKeyPath,
    "--expected-current-version", intent.currentVersion,
    "--expected-candidate-version", intent.candidateVersion,
    "--expected-current-artifact-sha256", intent.currentArtifactSha256,
    "--expected-candidate-artifact-sha256", intent.candidateArtifactSha256,
    "--output", decisionPath,
  ]);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(decisionPath, "utf8")).deploymentIntent, {
    source: "trusted-caller",
    ...intent,
  });
});

test("fleet BLOCK rejects replayed, unrelated, and reversed deployment intent", () => {
  const { entry, intent, policy } = fixture();
  const evaluatedAt = new Date(Date.parse(entry.generatedAt) + 60_000).toISOString();
  const cases: Array<[string, FleetDeploymentIntent, RegExp]> = [
    ["replayed", {
      currentVersion: "2.0.0",
      candidateVersion: "2.1.0",
      currentArtifactSha256: intent.candidateArtifactSha256,
      candidateArtifactSha256: sha("artifact-2.1.0"),
    }, /current version|candidate version/],
    ["unrelated", {
      ...intent,
      currentArtifactSha256: sha("unrelated-current"),
      candidateArtifactSha256: sha("unrelated-candidate"),
    }, /artifact SHA256/],
    ["downgrade", {
      currentVersion: intent.candidateVersion,
      candidateVersion: intent.currentVersion,
      currentArtifactSha256: intent.candidateArtifactSha256,
      candidateArtifactSha256: intent.currentArtifactSha256,
    }, /current version|candidate version/],
  ];
  for (const [label, deploymentIntent, expectedReason] of cases) {
    const decision = enforceFleetPolicy({ policy, entry, deploymentIntent, evaluatedAt });
    assert.equal(decision.status, "BLOCK", label);
    assert.ok(decision.reasons.some((reason) => expectedReason.test(reason)), label);
    assert.deepEqual(decision.deploymentIntent, { source: "trusted-caller", ...deploymentIntent }, label);
    const exactDecision = enforceFleetPolicy({ policy, entry, deploymentIntent: intent, evaluatedAt });
    assert.notEqual(decision.decisionHash, exactDecision.decisionHash, `${label} intent must change the decision commitment`);
  }
});

test("fleet CLI fails closed when trusted deployment intent is missing", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")); };
  try {
    assert.equal(runUpgradeCommand([
      "enforce", "entry.json", "--policy", "policy.json", "--public-key", "publisher.pem",
    ]), 2);
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((message) => /all four trusted --expected-\* deployment intent values/.test(message)));
});
