import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeContinuityChain, verifyContinuityChain } from "../src/continuity/chain.ts";
import { sha256 } from "../src/continuity/contracts.ts";
import { importGitHubActionsOutcome } from "../src/continuity/github.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { generateSigningKey, publicKeyId } from "../src/signature.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "3".repeat(40);
const MERGE = "4".repeat(40);

function fixture(): { root: string; chain: string; privateKey: string; publicKey: string } {
  const root = mkdtempSync(join(tmpdir(), "vigil-continuity-actions-"));
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "fixture passed", subject: "fixture" },
    verdict: "verified",
    evidence: "deterministic fixture",
  };
  const report = buildReport({
    transcript: "private/session.jsonl",
    transcriptSha256: sha256("private transcript"),
    transcriptFormat: "codex",
    repo: "/private/customer/repository",
    base: BASE,
    head: HEAD,
    results: [result],
    policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: sha256("policy") },
    repository: { remote: "https://github.com/example/protected-repo.git", tree: TREE },
    reproduction: "private command --token must-not-leak",
  });
  const receipt = join(root, "receipt.json");
  const chain = join(root, "chain");
  const privateKey = join(root, "outcome-private.pem");
  const publicKey = join(root, "outcome-public.pem");
  writeFileSync(receipt, `${JSON.stringify(report, null, 2)}\n`);
  initializeContinuityChain(receipt, chain, new Date(Date.now() - 60_000));
  generateSigningKey(privateKey, publicKey);
  return { root, chain, privateKey, publicKey };
}

function mergePayload(at: string, repository = "example/protected-repo"): Record<string, unknown> {
  return {
    action: "closed",
    repository: { full_name: repository },
    pull_request: {
      number: 19,
      state: "closed",
      merged: true,
      merged_at: at,
      merge_commit_sha: MERGE,
      base: { sha: BASE },
      head: { sha: HEAD },
      labels: [],
    },
  };
}

function actionsEnvironment(eventPath: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "example/protected-repo",
    ...overrides,
  };
}

test("GitHub Actions import signs, minimizes, and deduplicates the runner event", () => {
  const value = fixture();
  const at = new Date(Date.now() - 30_000).toISOString();
  const eventPath = join(value.root, "event.json");
  const body = JSON.stringify(mergePayload(at));
  writeFileSync(eventPath, body, { mode: 0o600 });
  const options = {
    chain: value.chain,
    signingKeyPath: value.privateKey,
    environment: actionsEnvironment(eventPath),
  };
  const first = importGitHubActionsOutcome(options);
  const second = importGitHubActionsOutcome(options);
  assert.equal(first.appended, true);
  assert.equal(first.kind, "merge_observed");
  assert.equal(second.appended, false);
  assert.equal(second.eventHash, first.eventHash);

  const verified = verifyContinuityChain(value.chain);
  assert.equal(verified.valid, true);
  assert.equal(verified.events.length, 1);
  assert.equal(verified.events[0].signature?.keyId, publicKeyId(value.publicKey));
  const stored = readFileSync(join(value.chain, "events", "00000001.json"), "utf8");
  for (const privateValue of ["example/protected-repo", eventPath, body, "private/customer", "must-not-leak"]) {
    assert.equal(stored.includes(privateValue), false);
  }
});

test("GitHub Actions import rejects an untrusted context, event mismatch, and repository mismatch", () => {
  const value = fixture();
  const at = new Date(Date.now() - 30_000).toISOString();
  const eventPath = join(value.root, "event.json");
  writeFileSync(eventPath, JSON.stringify(mergePayload(at)), { mode: 0o600 });

  assert.throws(() => importGitHubActionsOutcome({
    chain: value.chain,
    signingKeyPath: value.privateKey,
    environment: actionsEnvironment(eventPath, { GITHUB_ACTIONS: "false" }),
  }), /must run inside GitHub Actions/);
  assert.throws(() => importGitHubActionsOutcome({
    chain: value.chain,
    signingKeyPath: value.privateKey,
    environment: actionsEnvironment(eventPath, { GITHUB_EVENT_NAME: "issues" }),
  }), /does not match/);
  assert.throws(() => importGitHubActionsOutcome({
    chain: value.chain,
    signingKeyPath: value.privateKey,
    environment: actionsEnvironment(eventPath, { GITHUB_REPOSITORY: "example/other" }),
  }), /different repository/);

  const crossPath = join(value.root, "cross.json");
  writeFileSync(crossPath, JSON.stringify(mergePayload(at, "example/other")), { mode: 0o600 });
  assert.throws(() => importGitHubActionsOutcome({
    chain: value.chain,
    signingKeyPath: value.privateKey,
    environment: actionsEnvironment(crossPath),
  }), /different repository/);
  assert.equal(verifyContinuityChain(value.chain).events.length, 0);
});

test("GitHub Actions import refuses a missing key, symbolic event path, and oversized event", () => {
  const at = new Date(Date.now() - 30_000).toISOString();

  const missingKey = fixture();
  const missingPath = join(missingKey.root, "event.json");
  writeFileSync(missingPath, JSON.stringify(mergePayload(at)), { mode: 0o600 });
  assert.throws(() => importGitHubActionsOutcome({
    chain: missingKey.chain,
    signingKeyPath: "",
    environment: actionsEnvironment(missingPath),
  }), /requires --signing-key/);

  const linked = fixture();
  const realPath = join(linked.root, "real.json");
  const linkedPath = join(linked.root, "linked.json");
  writeFileSync(realPath, JSON.stringify(mergePayload(at)), { mode: 0o600 });
  symlinkSync(realPath, linkedPath);
  assert.throws(() => importGitHubActionsOutcome({
    chain: linked.chain,
    signingKeyPath: linked.privateKey,
    environment: actionsEnvironment(linkedPath),
  }), /symbolic link/);

  const oversized = fixture();
  const oversizedPath = join(oversized.root, "oversized.json");
  writeFileSync(oversizedPath, "{}");
  truncateSync(oversizedPath, 32 * 1024 * 1024 + 1);
  assert.throws(() => importGitHubActionsOutcome({
    chain: oversized.chain,
    signingKeyPath: oversized.privateKey,
    environment: actionsEnvironment(oversizedPath),
  }), /byte limit/);
});
