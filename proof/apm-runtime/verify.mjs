#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_PROOF_PATH = fileURLToPath(
  new URL("./pre-final-v0.8.5-v0.8.6.json", import.meta.url),
);

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const FORBIDDEN_KEY = /^(?:canary|command|observation|manifestEvidence|contentBase64|nonce|selection|rowSha|signature|signing|environmentValue|dockerEndpoint|localPath|absolutePath)/i;
const FORBIDDEN_STRING = /(?:file:\/\/|unix:\/\/|npipe:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|[\s"'])\/(?:Users|private|tmp)\/)/i;

function object(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(object(value, label)).sort();
  assert.deepEqual(keys, [...expected].sort(), `${label} must use only the public allowlist`);
}

function exactBooleanMap(value, keys, label) {
  exactKeys(value, keys, label);
  for (const key of keys) assert.equal(value[key], true, `${label}.${key} must be true`);
}

function inspectPrivacy(value, location = "$", depth = 0) {
  assert.ok(depth <= 12, "public proof nesting is unbounded");
  if (Array.isArray(value)) {
    assert.ok(value.length <= 8, `${location} array is unbounded`);
    value.forEach((item, index) => inspectPrivacy(item, `${location}[${index}]`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!FORBIDDEN_KEY.test(key), `${location}.${key} is a private-shaped field`);
      inspectPrivacy(item, `${location}.${key}`, depth + 1);
    }
    return;
  }
  if (typeof value === "string") {
    assert.ok(value.length <= 512, `${location} string is unbounded`);
    assert.ok(!FORBIDDEN_STRING.test(value), `${location} contains a private path, endpoint, or key material`);
  }
}

function validateTree(value, expected, label) {
  exactKeys(value, ["expectedSha256", "observedSha256", "fileCount", "totalBytes"], label);
  assert.match(value.expectedSha256, SHA256);
  assert.equal(value.expectedSha256, value.observedSha256, `${label} expected and observed trees differ`);
  assert.deepEqual(value, expected);
}

function validateEndpoint(value, expected, label) {
  exactKeys(value, ["tag", "commit", "archive", "tree"], label);
  assert.match(value.commit, COMMIT);
  exactKeys(value.archive, ["sha256", "bytes"], `${label}.archive`);
  assert.match(value.archive.sha256, SHA256);
  assert.ok(Number.isSafeInteger(value.archive.bytes) && value.archive.bytes > 0);
  assert.equal(value.tag, expected.tag);
  assert.equal(value.commit, expected.commit);
  assert.deepEqual(value.archive, expected.archive);
  validateTree(value.tree, expected.tree, `${label}.tree`);
}

const EXPECTED = Object.freeze({
  current: {
    tag: "v0.8.5",
    commit: "52e9b1b952d61aa2f97259fc3f9ea509cc833d3a",
    archive: {
      sha256: "sha256:2376fbde78672ce6548400937abf0dcd374489735839a180a4ae955614441680",
      bytes: 1242115,
    },
    tree: {
      expectedSha256: "sha256:aee0224fd5a4194bf4df01e4564194c55b7de263bf8a9ba48054cedda3d8813e",
      observedSha256: "sha256:aee0224fd5a4194bf4df01e4564194c55b7de263bf8a9ba48054cedda3d8813e",
      fileCount: 499,
      totalBytes: 5959236,
    },
  },
  candidate: {
    tag: "v0.8.6",
    commit: "b56c537cf5a23807b01ca7ea434968981bdded36",
    archive: {
      sha256: "sha256:f0ab85f5ef97fa188802ff1768c0f9c4922eb196635d56b35443b067365e9ed7",
      bytes: 1260808,
    },
    tree: {
      expectedSha256: "sha256:231b80c97d619dcf56c99cf9e2f7b97654eefd6e8d63509bb6e0ce483c84e845",
      observedSha256: "sha256:231b80c97d619dcf56c99cf9e2f7b97654eefd6e8d63509bb6e0ce483c84e845",
      fileCount: 502,
      totalBytes: 6054248,
    },
  },
});

export function validatePublicApmRuntimeProof(input) {
  const serialized = JSON.stringify(input);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 16 * 1024, "public proof exceeds 16 KiB");
  inspectPrivacy(input);
  exactKeys(input, [
    "schemaVersion", "evidenceStatus", "validatedCodeSha", "releaseReplay", "source",
    "publicVersionSelections", "outcome", "elapsedSeconds", "containment", "restoration",
    "validation", "transientRetryDisclosure",
  ], "public proof");
  assert.equal(input.schemaVersion, "agent-vigil-public-apm-runtime-proof/v1");
  assert.equal(input.evidenceStatus, "PRE_FINAL_RUNTIME");
  assert.equal(input.validatedCodeSha, "cb5a6bc55966bb4687d196ace7719f8fb41b5edb");

  exactKeys(input.releaseReplay, ["required", "completed", "gate"], "releaseReplay");
  assert.deepEqual(input.releaseReplay, { required: true, completed: false, gate: "HOLD" });

  exactKeys(input.source, ["repository", "current", "candidate"], "source");
  assert.equal(input.source.repository, "microsoft/apm");
  validateEndpoint(input.source.current, EXPECTED.current, "source.current");
  validateEndpoint(input.source.candidate, EXPECTED.candidate, "source.candidate");

  assert.deepEqual(input.publicVersionSelections, [
    {
      path: "docs/package.json",
      name: "apm-docs",
      versionField: "dependencies.astro",
      currentVersion: "5.18.0",
      candidateVersion: "5.18.1",
    },
    {
      path: "pyproject.toml",
      name: "apm-cli",
      versionField: "project.version",
      currentVersion: "0.8.5",
      candidateVersion: "0.8.6",
    },
  ]);

  exactKeys(input.outcome, ["verdict", "reason", "wrapperSha256"], "outcome");
  assert.deepEqual(input.outcome, {
    verdict: "CHANGED",
    reason: "MATERIAL_CHANGE_DETECTED",
    wrapperSha256: "sha256:6870faa9bf1688a4a3c483affac305ea92553084f487d39faed52e19201f02a2",
  });
  assert.equal(input.elapsedSeconds, 8.55);

  exactBooleanMap(input.containment, [
    "localTransportAccepted", "exactImagePresent", "networkBlocked", "targetReadOnly",
    "rootReadOnly", "inheritedSecretAbsent", "proxiesCleared",
  ], "containment");
  exactBooleanMap(input.restoration, ["restored", "hostMutationAbsent", "sessionRemoved"], "restoration");

  exactKeys(input.validation, ["schema", "verifier"], "validation");
  exactKeys(input.validation.schema, ["errors"], "validation.schema");
  exactKeys(input.validation.verifier, ["valid", "exitCode"], "validation.verifier");
  assert.deepEqual(input.validation, { schema: { errors: 0 }, verifier: { valid: true, exitCode: 0 } });

  exactKeys(input.transientRetryDisclosure, [
    "occurred", "attempts", "boundedRetries", "firstAttemptVerdict", "firstAttemptReason",
    "firstAttemptCleanupVerified", "doctorReadyBeforeRetry", "finalAttemptUsed",
  ], "transientRetryDisclosure");
  assert.deepEqual(input.transientRetryDisclosure, {
    occurred: true,
    attempts: 2,
    boundedRetries: 1,
    firstAttemptVerdict: "HOLD",
    firstAttemptReason: "The contained amd64 probe exited 139 before canary trials.",
    firstAttemptCleanupVerified: true,
    doctorReadyBeforeRetry: true,
    finalAttemptUsed: true,
  });
  return input;
}

export function loadAndValidatePublicApmRuntimeProof(proofPath = DEFAULT_PROOF_PATH) {
  const bytes = readFileSync(proofPath);
  const value = JSON.parse(bytes.toString("utf8"));
  validatePublicApmRuntimeProof(value);
  return {
    value,
    artifactSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.length,
  };
}

function isMain() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  const { artifactSha256, bytes } = loadAndValidatePublicApmRuntimeProof(process.argv[2]);
  process.stdout.write(`${JSON.stringify({ valid: true, artifactSha256, bytes })}\n`);
}
