import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertGuardEnvironmentUnchanged,
  initializeGuardProfileBinding,
  issueGuardEnvironmentStatement,
  verifyGuardEnvironment,
  verifyGuardEnvironmentReceiptBinding,
} from "../src/guard-environment.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vigil-environment-"));
  const profile = join(root, "profile");
  const policy = join(root, "policy.json");
  const manifest = join(root, "manifest.json");
  const privateKey = join(root, "private.pem");
  const publicKey = join(root, "public.pem");
  mkdirSync(profile, { mode: 0o700 });
  initializeGuardProfileBinding(profile);
  writeFileSync(policy, '{"network":"deny"}\n', { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({
    schemaVersion: "agent-vigil-guard-policy-files/v1",
    files: [{ label: "organization-policy", path: policy }],
  }), { mode: 0o600 });
  const keys = generateKeyPairSync("ed25519");
  writeFileSync(privateKey, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(publicKey, keys.publicKey.export({ format: "pem", type: "spki" }), { mode: 0o600 });
  const statement = issueGuardEnvironmentStatement({
    environmentId: "trusted-runner-1",
    host: "codex",
    profileHome: profile,
    policyManifestPath: manifest,
    privateKeyPath: privateKey,
    issuedAt: "2026-09-03T18:00:00.000Z",
    validUntil: "2026-09-04T18:00:00.000Z",
    nonce: "environment-test-nonce-0001",
  });
  return { root, profile, policy, publicKey, statement };
}

test("a pinned signer binds the disposable profile and policy bytes", () => {
  const value = fixture();
  try {
    const verified = verifyGuardEnvironment({
      statement: value.statement,
      publicKeyPath: value.publicKey,
      host: "codex",
      profileHome: value.profile,
      observedAt: "2026-09-03T19:00:00.000Z",
    });
    assert.equal(verified.binding.statementHash, value.statement.statementHash);
    const confused = structuredClone(verified.binding);
    confused.signature.algorithm = "RSA" as "Ed25519";
    assert.equal(verifyGuardEnvironmentReceiptBinding(confused, readFileSync(value.publicKey)), false);
    assert.doesNotThrow(() => assertGuardEnvironmentUnchanged(verified));
    writeFileSync(value.policy, '{"network":"allow"}\n', { mode: 0o600 });
    assert.throws(() => assertGuardEnvironmentUnchanged(verified), /changed during/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("wrong host and expired observations fail closed", () => {
  const value = fixture();
  try {
    const input = { statement: value.statement, publicKeyPath: value.publicKey, profileHome: value.profile };
    assert.throws(() => verifyGuardEnvironment({ ...input, host: "claude", observedAt: "2026-09-03T19:00:00.000Z" }), /host does not match/);
    assert.throws(() => verifyGuardEnvironment({ ...input, host: "codex", observedAt: "2026-09-05T19:00:00.000Z" }), /not valid/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
