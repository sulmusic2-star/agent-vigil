import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
// @ts-expect-error The public verifier is intentionally dependency-free ESM.
import { DEFAULT_PROOF_PATH, loadAndValidatePublicApmRuntimeProof, validatePublicApmRuntimeProof } from "../proof/apm-runtime/verify.mjs";

function proof(): Record<string, any> {
  return JSON.parse(readFileSync(DEFAULT_PROOF_PATH, "utf8")) as Record<string, any>;
}

test("privacy-minimized exact-runtime APM replay proof validates", () => {
  const validated = loadAndValidatePublicApmRuntimeProof();
  assert.equal(validated.value.evidenceStatus, "EXACT_RUNTIME_REPLAYED");
  assert.equal(validated.value.releaseReplay.required, true);
  assert.equal(validated.value.releaseReplay.completed, true);
  assert.equal(validated.value.releaseReplay.gate, "TECHNICAL_REPLAY_PASS");
  assert.equal(validated.value.releaseReplay.version, "0.17.0");
  assert.equal(validated.value.releaseReplay.releaseAuthorized, false);
  assert.equal(validated.value.releaseReplay.r0Started, false);
  assert.match(validated.artifactSha256, /^sha256:[0-9a-f]{64}$/);

  const cli = spawnSync(process.execPath, [new URL("../proof/apm-runtime/verify.mjs", import.meta.url).pathname], {
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).valid, true);
});

test("public APM runtime proof rejects non-allowlisted private-shaped fields and values", () => {
  const additions = [
    ["canaryCommand", ["node", "private-script"]],
    ["observationSha256", `sha256:${"a".repeat(64)}`],
    ["signingMaterial", "not-public"],
    ["localPath", ["", "Users", "example", "fixture"].join("/")],
  ] as const;
  for (const [key, value] of additions) {
    const changed = proof();
    changed[key] = value;
    assert.throws(() => validatePublicApmRuntimeProof(changed), /allowlist|private-shaped|private path|key material/);
  }
});

test("public APM runtime proof rejects commitment, outcome, cleanup, and release-state drift", () => {
  const mutations: Array<(value: Record<string, any>) => void> = [
    (value) => { value.source.current.commit = "0".repeat(40); },
    (value) => { value.source.candidate.tree.observedSha256 = `sha256:${"0".repeat(64)}`; },
    (value) => { value.outcome.verdict = "SAFE"; },
    (value) => { value.containment.networkBlocked = false; },
    (value) => { value.restoration.sessionRemoved = false; },
    (value) => { value.validation.verifier.valid = false; },
    (value) => { value.outcome.nestedReceiptSha256 = `sha256:${"0".repeat(64)}`; },
    (value) => { value.trialStability.current[1] = "FAIL"; },
    (value) => { value.retryDisclosure.retries = 1; },
    (value) => { value.releaseReplay.completed = false; },
    (value) => { value.releaseReplay.gate = "HOLD"; },
    (value) => { value.releaseReplay.version = "0.16.0"; },
    (value) => { value.releaseReplay.releaseAuthorized = true; },
    (value) => { value.releaseReplay.r0Started = true; },
  ];
  for (const mutate of mutations) {
    const changed = proof();
    mutate(changed);
    assert.throws(() => validatePublicApmRuntimeProof(changed));
  }
});
