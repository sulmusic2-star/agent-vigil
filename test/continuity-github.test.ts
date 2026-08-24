import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeContinuityChain, verifyContinuityChain } from "../src/continuity/chain.ts";
import { importGitHubOutcome } from "../src/continuity/github.ts";
import { sha256, type ContinuityRoot } from "../src/continuity/contracts.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { generateSigningKey } from "../src/signature.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "3".repeat(40);
const MERGE = "4".repeat(40);
const REVERT = "5".repeat(40);
const SECRET = "a test webhook secret";

function fixture(): { root: string; chain: string; continuityRoot: ContinuityRoot; secretPath: string } {
  const root = mkdtempSync(join(tmpdir(), "vigil-continuity-github-"));
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "fixture passed", subject: "fixture" },
    verdict: "verified",
    evidence: "deterministic fixture",
  };
  const report = buildReport({
    transcript: "private/session.jsonl",
    transcriptSha256: sha256("transcript"),
    transcriptFormat: "codex",
    repo: "/private/repository",
    base: BASE,
    head: HEAD,
    results: [result],
    policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: sha256("policy") },
    repository: { remote: "https://github.com/example/protected-repo.git", tree: TREE },
    reproduction: "private command",
  });
  const receipt = join(root, "receipt.json");
  writeFileSync(receipt, `${JSON.stringify(report, null, 2)}\n`);
  const chain = join(root, "chain");
  const continuityRoot = initializeContinuityChain(receipt, chain, new Date(Date.now() - 60_000));
  const secretPath = join(root, "webhook-secret.txt");
  writeFileSync(secretPath, `${SECRET}\n`, { mode: 0o600 });
  return { root, chain, continuityRoot, secretPath };
}

function signature(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function writePayload(root: string, name: string, payload: unknown): { path: string; body: Buffer; signature: string } {
  const path = join(root, name);
  const body = Buffer.from(JSON.stringify(payload));
  writeFileSync(path, body, { mode: 0o600 });
  return { path, body, signature: signature(body) };
}

function mergedPayload(at: string, overrides: Record<string, unknown> = {}): any {
  return {
    action: "closed",
    repository: { full_name: "example/protected-repo" },
    pull_request: {
      number: 17,
      state: "closed",
      merged: true,
      merged_at: at,
      merge_commit_sha: MERGE,
      base: { sha: BASE },
      head: { sha: HEAD },
      labels: [],
    },
    ...overrides,
  };
}

test("authenticated merge evidence is minimized, bound to the receipt, and idempotent", () => {
  const value = fixture();
  const at = new Date(Date.now() - 30_000).toISOString();
  const input = writePayload(value.root, "merge-webhook.json", mergedPayload(at));
  const options = {
    chain: value.chain,
    eventPath: input.path,
    deliveryId: "11111111-1111-4111-8111-111111111111",
    webhookSignature: input.signature,
    webhookSecretPath: value.secretPath,
  };
  const first = importGitHubOutcome(options);
  assert.equal(first.appended, true);
  assert.equal(first.kind, "merge_observed");
  assert.equal(first.disposition, "affirm");
  const second = importGitHubOutcome(options);
  assert.equal(second.appended, false);
  assert.equal(second.eventHash, first.eventHash);
  const verified = verifyContinuityChain(value.chain);
  assert.equal(verified.valid, true);
  assert.equal(verified.events.length, 1);
  const stored = readFileSync(join(value.chain, "events", "00000001.json"), "utf8");
  for (const privateValue of ["example/protected-repo", input.path, SECRET, input.signature, JSON.stringify(mergedPayload(at))]) {
    assert.equal(stored.includes(privateValue), false);
  }

  const changed = writePayload(value.root, "changed-webhook.json", mergedPayload(at, {
    pull_request: { ...mergedPayload(at).pull_request, merge_commit_sha: "6".repeat(40) },
  }));
  assert.throws(() => importGitHubOutcome({ ...options, eventPath: changed.path, webhookSignature: changed.signature }), /already recorded with different evidence/);
  assert.equal(verifyContinuityChain(value.chain).events.length, 1);
});

test("invalid, malformed, cross-repository, wrong-commit, and symbolic-link evidence is rejected without a record", () => {
  const at = new Date(Date.now() - 30_000).toISOString();

  const invalid = fixture();
  const input = writePayload(invalid.root, "merge.json", mergedPayload(at));
  assert.throws(() => importGitHubOutcome({
    chain: invalid.chain,
    eventPath: input.path,
    deliveryId: "22222222-2222-4222-8222-222222222222",
    webhookSignature: signature(input.body, "wrong secret"),
    webhookSecretPath: invalid.secretPath,
  }), /signature is invalid/);
  assert.equal(verifyContinuityChain(invalid.chain).events.length, 0);

  const malformed = fixture();
  const malformedPath = join(malformed.root, "malformed.json");
  const malformedBody = Buffer.from("{not-json");
  writeFileSync(malformedPath, malformedBody);
  assert.throws(() => importGitHubOutcome({
    chain: malformed.chain,
    eventPath: malformedPath,
    deliveryId: "33333333-3333-4333-8333-333333333333",
    webhookSignature: signature(malformedBody),
    webhookSecretPath: malformed.secretPath,
  }), /not valid JSON/);
  assert.equal(verifyContinuityChain(malformed.chain).events.length, 0);

  const crossRepo = fixture();
  const crossInput = writePayload(crossRepo.root, "cross.json", mergedPayload(at, { repository: { full_name: "example/other" } }));
  assert.throws(() => importGitHubOutcome({
    chain: crossRepo.chain,
    eventPath: crossInput.path,
    deliveryId: "44444444-4444-4444-8444-444444444444",
    webhookSignature: crossInput.signature,
    webhookSecretPath: crossRepo.secretPath,
  }), /different repository/);

  const wrongHead = fixture();
  const wrongPayload = mergedPayload(at);
  wrongPayload.pull_request.head.sha = "7".repeat(40);
  const wrongInput = writePayload(wrongHead.root, "wrong-head.json", wrongPayload);
  assert.throws(() => importGitHubOutcome({
    chain: wrongHead.chain,
    eventPath: wrongInput.path,
    deliveryId: "55555555-5555-4555-8555-555555555555",
    webhookSignature: wrongInput.signature,
    webhookSecretPath: wrongHead.secretPath,
  }), /does not match/);

  const inconsistent = fixture();
  const inconsistentPayload = mergedPayload(at);
  inconsistentPayload.pull_request.state = "open";
  const inconsistentInput = writePayload(inconsistent.root, "inconsistent.json", inconsistentPayload);
  assert.throws(() => importGitHubOutcome({
    chain: inconsistent.chain,
    eventPath: inconsistentInput.path,
    deliveryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    webhookSignature: inconsistentInput.signature,
    webhookSecretPath: inconsistent.secretPath,
  }), /completed merge/);

  const extraTimestamp = fixture();
  const timestampInput = writePayload(extraTimestamp.root, "timestamp.json", mergedPayload(at));
  assert.throws(() => importGitHubOutcome({
    chain: extraTimestamp.chain,
    eventPath: timestampInput.path,
    deliveryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    webhookSignature: timestampInput.signature,
    webhookSecretPath: extraTimestamp.secretPath,
    observedAt: at,
  }), /only with --unavailable/);

  const linked = fixture();
  const real = writePayload(linked.root, "real.json", mergedPayload(at));
  const symbolic = join(linked.root, "symbolic.json");
  symlinkSync(real.path, symbolic);
  assert.throws(() => importGitHubOutcome({
    chain: linked.chain,
    eventPath: symbolic,
    deliveryId: "66666666-6666-4666-8666-666666666666",
    webhookSignature: real.signature,
    webhookSecretPath: linked.secretPath,
  }), /symbolic link/);

  const oversized = fixture();
  const oversizedPath = join(oversized.root, "oversized.json");
  writeFileSync(oversizedPath, "{}");
  truncateSync(oversizedPath, 32 * 1024 * 1024 + 1);
  assert.throws(() => importGitHubOutcome({
    chain: oversized.chain,
    eventPath: oversizedPath,
    deliveryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    webhookSignature: `sha256=${"0".repeat(64)}`,
    webhookSecretPath: oversized.secretPath,
  }), /byte limit/);

  const emptySecret = fixture();
  writeFileSync(emptySecret.secretPath, "");
  const emptyInput = writePayload(emptySecret.root, "empty-secret.json", mergedPayload(at));
  assert.throws(() => importGitHubOutcome({
    chain: emptySecret.chain,
    eventPath: emptyInput.path,
    deliveryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    webhookSignature: emptyInput.signature,
    webhookSecretPath: emptySecret.secretPath,
  }), /secret is empty or invalid/);
});

test("reverts revoke, linked incidents and hotfixes remain factual, and observer outages hold", () => {
  const at = new Date(Date.now() - 30_000).toISOString();

  const reverted = fixture();
  const revertInput = writePayload(reverted.root, "revert.json", {
    repository: { full_name: "example/protected-repo" },
    after: REVERT,
    commits: [{ id: REVERT, message: `This reverts commit ${HEAD}`, timestamp: at }],
    head_commit: { timestamp: at },
  });
  const revertReceipt = importGitHubOutcome({
    chain: reverted.chain,
    eventPath: revertInput.path,
    deliveryId: "77777777-7777-4777-8777-777777777777",
    webhookSignature: revertInput.signature,
    webhookSecretPath: reverted.secretPath,
  });
  assert.equal(revertReceipt.kind, "revert_observed");
  assert.equal(revertReceipt.disposition, "revoke");

  const incident = fixture();
  const incidentInput = writePayload(incident.root, "incident.json", {
    action: "labeled",
    repository: { full_name: "example/protected-repo" },
    issue: {
      id: 991,
      number: 31,
      state: "open",
      updated_at: at,
      labels: [{ name: "incident" }, { name: `agent-vigil:${HEAD}` }],
    },
  });
  const incidentReceipt = importGitHubOutcome({
    chain: incident.chain,
    eventPath: incidentInput.path,
    deliveryId: "88888888-8888-4888-8888-888888888888",
    webhookSignature: incidentInput.signature,
    webhookSecretPath: incident.secretPath,
  });
  assert.equal(incidentReceipt.kind, "incident_linked");
  assert.equal(incidentReceipt.disposition, "observe");

  const hotfix = fixture();
  const hotfixPayload = mergedPayload(at);
  hotfixPayload.pull_request.head.sha = "9".repeat(40);
  hotfixPayload.pull_request.labels = [{ name: "hotfix" }, { name: `agent-vigil:${HEAD}` }];
  const hotfixInput = writePayload(hotfix.root, "hotfix.json", hotfixPayload);
  const hotfixPrivate = join(hotfix.root, "hotfix-recorder-private.pem");
  const hotfixPublic = join(hotfix.root, "hotfix-recorder-public.pem");
  generateSigningKey(hotfixPrivate, hotfixPublic);
  const hotfixReceipt = importGitHubOutcome({
    chain: hotfix.chain,
    eventPath: hotfixInput.path,
    deliveryId: "99999999-9999-4999-8999-999999999999",
    webhookSignature: hotfixInput.signature,
    webhookSecretPath: hotfix.secretPath,
    signingKeyPath: hotfixPrivate,
  });
  assert.equal(hotfixReceipt.kind, "hotfix_observed");
  assert.equal(hotfixReceipt.disposition, "observe");
  const signedHotfix = verifyContinuityChain(hotfix.chain).events[0];
  assert.ok(signedHotfix.signature);
  assert.equal(signedHotfix.source.issuer, signedHotfix.signature?.keyId);

  const outage = fixture();
  const privateKey = join(outage.root, "observer-private.pem");
  const publicKey = join(outage.root, "observer-public.pem");
  generateSigningKey(privateKey, publicKey);
  const outageReceipt = importGitHubOutcome({
    chain: outage.chain,
    deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    unavailable: true,
    observedAt: at,
    signingKeyPath: privateKey,
  });
  assert.equal(outageReceipt.kind, "coverage_gap");
  assert.equal(outageReceipt.disposition, "hold");
  assert.ok(verifyContinuityChain(outage.chain).events[0].signature);
  assert.throws(() => importGitHubOutcome({
    chain: fixture().chain,
    deliveryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    unavailable: true,
    observedAt: at,
  }), /requires --signing-key/);
});
