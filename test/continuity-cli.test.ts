import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runContinuityCommand } from "../src/continuity/cli.ts";
import { sha256, type ContinuityEventDraft, type ContinuityPolicy, type ContinuityRoot } from "../src/continuity/contracts.ts";
import { buildReport } from "../src/report.ts";
import { generateSigningKey } from "../src/signature.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
let nextId = 1;

function silent(operation: () => number): number {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const log = console.log;
  const error = console.error;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  console.log = () => undefined;
  console.error = () => undefined;
  try { return operation(); }
  finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    console.log = log;
    console.error = error;
  }
}

function policy(requiredSources = ["verification", "github-outcome"]): ContinuityPolicy {
  return {
    schemaVersion: "agent-vigil-continuity-policy/v1",
    requiredSources,
    maxAgeSeconds: Object.fromEntries(requiredSources.map((source) => [source, 3600])),
    denyOn: ["revert_observed", "incident_linked", "attestation_invalid", "credential_revoked"],
    allowRemediation: true,
    requireSignedRoot: false,
    requireSignedEvents: false,
    trustedRootKeyIds: [],
    trustedIssuerKeyIds: [],
    protectedEnvironments: ["production"],
    maxClockSkewSeconds: 300,
  };
}

function event(root: ContinuityRoot, source: string, kind: "verification_refreshed" | "merge_observed" | "attestation_invalid", at: string, disposition: "affirm" | "revoke" = "affirm"): ContinuityEventDraft {
  const id = String(nextId++).padStart(12, "0");
  return {
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: `urn:uuid:10000000-0000-4000-8000-${id}`,
    subject: root.subject,
    source: {
      kind: source,
      issuer: sha256(`issuer-${id}`),
      evidenceHash: sha256(`evidence-${id}`),
      deliveryIdHash: source === "github-outcome" ? sha256(`delivery-${id}`) : null,
    },
    event: {
      kind,
      disposition,
      reasonCode: `${kind}.cli_fixture`,
      targetHash: sha256(`target-${id}`),
      freshUntil: "2026-08-23T13:30:00.000Z",
      supersedesEventId: null,
    },
    observedAt: at,
    effectiveAt: at,
    privacyTier: "receipt",
  };
}

function fixture(): { root: string; chain: string; policyPath: string; continuityRoot: ContinuityRoot } {
  const root = mkdtempSync(join(tmpdir(), "vigil-continuity-cli-"));
  const receiptPath = join(root, "receipt.json");
  const chain = join(root, "chain");
  const policyPath = join(root, "policy.json");
  const report = buildReport({
    transcript: "private/session.jsonl",
    transcriptSha256: sha256("private transcript"),
    transcriptFormat: "codex",
    repo: "/private/customer/repository",
    base: BASE,
    head: HEAD,
    results: [{
      claim: { kind: "tests_pass", quote: "fixture", subject: "fixture" },
      verdict: "verified",
      evidence: "fixture passed",
    }],
    policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: sha256("policy") },
    repository: { remote: "https://github.com/example/protected-repository.git", tree: TREE },
    reproduction: "secret command --token must-not-leak",
  });
  writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(policyPath, `${JSON.stringify(policy(), null, 2)}\n`);
  assert.equal(silent(() => runContinuityCommand(["init", receiptPath, "--output", chain])), 0);
  return { root, chain, policyPath, continuityRoot: JSON.parse(readFileSync(join(chain, "root.json"), "utf8")) as ContinuityRoot };
}

function append(root: ReturnType<typeof fixture>, draft: ContinuityEventDraft): void {
  const eventPath = join(root.root, `${draft.eventId.slice(-12)}.json`);
  writeFileSync(eventPath, `${JSON.stringify(draft, null, 2)}\n`);
  assert.equal(silent(() => runContinuityCommand(["append", "--chain", root.chain, "--event", eventPath])), 0);
}

test("continuity CLI initializes, appends, verifies, and returns categorical status exit codes", () => {
  const value = fixture();
  const statusPath = join(value.root, "status.json");
  const verifyPath = join(value.root, "verify.json");

  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", value.chain, "--policy", value.policyPath,
    "--environment", "production", "--now", "2026-08-23T12:30:00.000Z",
  ])), 3);

  append(value, event(value.continuityRoot, "verification", "verification_refreshed", "2026-08-23T12:00:00.000Z"));
  append(value, event(value.continuityRoot, "github-outcome", "merge_observed", "2026-08-23T12:01:00.000Z"));
  assert.equal(silent(() => runContinuityCommand(["verify", "--chain", value.chain, "--json", "--output", verifyPath])), 0);
  assert.equal(silent(() => runContinuityCommand(["verify", "--chain", value.chain, "--expected-head", HEAD])), 0);
  assert.equal(silent(() => runContinuityCommand(["verify", "--chain", value.chain, "--expected-head", "d".repeat(40)])), 1);
  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", value.chain, "--policy", value.policyPath,
    "--environment", "production", "--now", "2026-08-23T12:30:00.000Z", "--json", "--output", statusPath,
  ])), 0);
  const decision = JSON.parse(readFileSync(statusPath, "utf8")) as { continuity: string; allowsProtectedAction: boolean };
  assert.equal(decision.continuity, "CURRENT");
  assert.equal(decision.allowsProtectedAction, true);
  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", value.chain, "--policy", value.policyPath, "--expected-head", "d".repeat(40),
    "--now", "2026-08-23T12:30:00.000Z",
  ])), 1);
  for (const secret of ["private/customer", "secret command", "must-not-leak", "example.invalid", value.root]) {
    assert.equal(readFileSync(statusPath, "utf8").includes(secret), false);
    assert.equal(readFileSync(verifyPath, "utf8").includes(secret), false);
  }

  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", value.chain, "--policy", value.policyPath, "--now", "2026-08-23T15:00:00.000Z",
  ])), 4);
  append(value, event(value.continuityRoot, "verification", "attestation_invalid", "2026-08-23T12:02:00.000Z", "revoke"));
  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", value.chain, "--policy", value.policyPath, "--now", "2026-08-23T12:30:00.000Z",
  ])), 1);
});

test("continuity status can load policy only from the named base revision", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-continuity-policy-ref-"));
  const repo = join(root, "policy-repository");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "vigil@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Vigil Test"]);
  const relativePolicy = ".agent-vigil-continuity.json";
  writeFileSync(join(repo, relativePolicy), `${JSON.stringify(policy(["verification", "deployment"]), null, 2)}\n`);
  execFileSync("git", ["-C", repo, "add", relativePolicy]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base policy"]);
  const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  writeFileSync(join(repo, relativePolicy), `${JSON.stringify(policy(["verification"]), null, 2)}\n`);
  writeFileSync(join(repo, "README.md"), "candidate\n");
  execFileSync("git", ["-C", repo, "add", relativePolicy, "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "candidate"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const report = buildReport({
    transcript: "private/session.jsonl",
    transcriptSha256: sha256("policy ref transcript"),
    transcriptFormat: "codex",
    repo,
    base,
    head,
    results: [{ claim: { kind: "tests_pass", quote: "fixture", subject: "fixture" }, verdict: "verified", evidence: "fixture passed" }],
    policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: sha256("policy") },
    repository: { remote: "https://github.com/example/policy-repository.git", tree },
    reproduction: "private command",
  });
  const receiptPath = join(root, "receipt.json");
  const chain = join(root, "chain");
  writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(silent(() => runContinuityCommand(["init", receiptPath, "--output", chain])), 0);
  const continuityRoot = JSON.parse(readFileSync(join(chain, "root.json"), "utf8")) as ContinuityRoot;
  const value = { root, chain, policyPath: join(repo, relativePolicy), continuityRoot };
  append(value, event(continuityRoot, "verification", "verification_refreshed", "2026-08-23T12:00:00.000Z"));
  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", chain, "--policy", join(repo, relativePolicy), "--now", "2026-08-23T12:30:00.000Z",
  ])), 0, "the weaker worktree policy would allow CURRENT");
  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", chain, "--policy", relativePolicy, "--repo", repo, "--policy-ref", base,
    "--now", "2026-08-23T12:30:00.000Z",
  ])), 3, "the named base policy still requires deployment evidence");
});

test("short-lived continuity staples bind a pinned signer, exact change, policy, environment, and evidence sequence", () => {
  const value = fixture();
  const privateKey = join(value.root, "staple-private.pem");
  const publicKey = join(value.root, "staple-public.pem");
  const staplePath = join(value.root, "continuity-staple.json");
  const verificationPath = join(value.root, "continuity-staple-verification.json");
  generateSigningKey(privateKey, publicKey);
  append(value, event(value.continuityRoot, "verification", "verification_refreshed", "2026-08-23T12:00:00.000Z"));
  append(value, event(value.continuityRoot, "github-outcome", "merge_observed", "2026-08-23T12:01:00.000Z"));
  const policyHash = sha256(readFileSync(value.policyPath));

  assert.equal(silent(() => runContinuityCommand([
    "staple", "--chain", value.chain, "--policy", value.policyPath, "--environment", "production",
    "--signing-key", privateKey, "--output", staplePath, "--now", "2026-08-23T12:30:00.000Z", "--ttl-seconds", "300",
  ])), 0);
  const staple = JSON.parse(readFileSync(staplePath, "utf8")) as {
    payload: { evidence: { chainTip: string; sequence: number }; decision: { continuity: string }; expiresAt: string };
    payloadHash: string;
  };
  assert.equal(staple.payload.decision.continuity, "CURRENT");
  assert.equal(staple.payload.evidence.sequence, 2);
  assert.equal(staple.payload.expiresAt, "2026-08-23T12:35:00.000Z");

  const verify = (now: string, extra: string[] = []) => silent(() => runContinuityCommand([
    "verify-staple", staplePath, "--public-key", publicKey, "--expected-receipt-hash", value.continuityRoot.receiptHash, "--expected-head", HEAD,
    "--environment", "production", "--expected-policy-sha256", policyHash, "--now", now,
    "--output", verificationPath, ...extra,
  ]));
  assert.equal(verify("2026-08-23T12:31:00.000Z", ["--expected-chain-tip", staple.payload.evidence.chainTip, "--minimum-sequence", "2"]), 0);
  const accepted = JSON.parse(readFileSync(verificationPath, "utf8")) as { allowsProtectedAction: boolean; signerPinned: boolean };
  assert.equal(accepted.allowsProtectedAction, true);
  assert.equal(accepted.signerPinned, true);
  assert.equal(verify("2026-08-23T12:36:00.000Z"), 4);
  assert.equal(verify("2026-08-23T12:20:00.000Z"), 2);
  assert.equal(verify("2026-08-23T12:31:00.000Z", ["--minimum-sequence", "3"]), 2);
  assert.equal(silent(() => runContinuityCommand([
    "verify-staple", staplePath, "--public-key", publicKey, "--expected-receipt-hash", `sha256:${"0".repeat(64)}`, "--expected-head", HEAD,
    "--environment", "production", "--expected-policy-sha256", policyHash,
  ])), 2);
  assert.equal(silent(() => runContinuityCommand([
    "verify-staple", staplePath, "--public-key", publicKey, "--expected-receipt-hash", value.continuityRoot.receiptHash, "--expected-head", "d".repeat(40),
    "--environment", "production", "--expected-policy-sha256", policyHash,
  ])), 2);
  const otherPrivateKey = join(value.root, "other-staple-private.pem");
  const otherPublicKey = join(value.root, "other-staple-public.pem");
  generateSigningKey(otherPrivateKey, otherPublicKey);
  assert.equal(silent(() => runContinuityCommand([
    "verify-staple", staplePath, "--public-key", otherPublicKey, "--expected-receipt-hash", value.continuityRoot.receiptHash, "--expected-head", HEAD,
    "--environment", "production", "--expected-policy-sha256", policyHash,
  ])), 2);
  assert.equal(silent(() => runContinuityCommand([
    "staple", "--chain", value.chain, "--policy", value.policyPath, "--environment", "production",
    "--signing-key", privateKey, "--output", join(value.root, "too-long.json"),
    "--now", "2026-08-23T12:30:00.000Z", "--ttl-seconds", "901",
  ])), 2);

  const tampered = JSON.parse(readFileSync(staplePath, "utf8"));
  tampered.payload.decision.continuity = "HOLD";
  writeFileSync(staplePath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.equal(verify("2026-08-23T12:31:00.000Z"), 2);
});

test("a signed staple preserves sticky revocation after a later ordinary green event", () => {
  const value = fixture();
  const privateKey = join(value.root, "staple-private.pem");
  const publicKey = join(value.root, "staple-public.pem");
  const staplePath = join(value.root, "revoked-staple.json");
  generateSigningKey(privateKey, publicKey);
  append(value, event(value.continuityRoot, "verification", "verification_refreshed", "2026-08-23T12:00:00.000Z"));
  append(value, event(value.continuityRoot, "github-outcome", "merge_observed", "2026-08-23T12:01:00.000Z"));
  append(value, event(value.continuityRoot, "verification", "attestation_invalid", "2026-08-23T12:02:00.000Z", "revoke"));
  append(value, event(value.continuityRoot, "verification", "verification_refreshed", "2026-08-23T12:03:00.000Z"));
  assert.equal(silent(() => runContinuityCommand([
    "staple", "--chain", value.chain, "--policy", value.policyPath, "--environment", "production",
    "--signing-key", privateKey, "--output", staplePath, "--now", "2026-08-23T12:30:00.000Z",
  ])), 1);
  assert.equal(silent(() => runContinuityCommand([
    "verify-staple", staplePath, "--public-key", publicKey, "--expected-receipt-hash", value.continuityRoot.receiptHash, "--expected-head", HEAD,
    "--environment", "production", "--expected-policy-sha256", sha256(readFileSync(value.policyPath)),
    "--now", "2026-08-23T12:31:00.000Z",
  ])), 1);
});

test("continuity CLI help is non-mutating and parser errors exit two", () => {
  assert.equal(silent(() => runContinuityCommand(["--help"])), 0);
  assert.equal(silent(() => runContinuityCommand(["unknown"])), 2);
  assert.equal(silent(() => runContinuityCommand(["verify", "--surprise"])), 2);
  assert.equal(silent(() => runContinuityCommand(["init", "receipt.json", "--output", "chain", "--json"])), 2);
  assert.equal(silent(() => runContinuityCommand(["verify", "--chain", ".", "--json", "--format", "json"])), 2);
  assert.equal(silent(() => runContinuityCommand(["status", "--chain", ".", "--policy-ref", "HEAD"])), 2);
  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", ".", "--policy", "policy.json", "--repo", ".", "--policy-ref", "HEAD",
  ])), 2);
});

test("continuity CLI imports the current GitHub Actions event without a webhook secret", () => {
  const value = fixture();
  const privateKey = join(value.root, "actions-private.pem");
  const publicKey = join(value.root, "actions-public.pem");
  const eventPath = join(value.root, "github-event.json");
  const outputPath = join(value.root, "github-import.json");
  generateSigningKey(privateKey, publicKey);
  const at = new Date(Date.now() - 30_000).toISOString();
  writeFileSync(eventPath, JSON.stringify({
    action: "closed",
    repository: { full_name: "example/protected-repository" },
    pull_request: {
      number: 29,
      state: "closed",
      merged: true,
      merged_at: at,
      merge_commit_sha: "d".repeat(40),
      base: { sha: BASE },
      head: { sha: HEAD },
      labels: [],
    },
  }));
  const names = ["GITHUB_ACTIONS", "GITHUB_EVENT_PATH", "GITHUB_EVENT_NAME", "GITHUB_REPOSITORY"] as const;
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_REPOSITORY = "example/protected-repository";
    const command = [
      "import-github-actions", "--chain", value.chain, "--signing-key", privateKey,
      "--format", "json", "--output", outputPath,
    ];
    assert.equal(silent(() => runContinuityCommand(command)), 0);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).appended, true);
    assert.equal(silent(() => runContinuityCommand(command)), 0);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).appended, false);
    process.env.GITHUB_EVENT_NAME = "issues";
    assert.equal(silent(() => runContinuityCommand(command)), 2);
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});

test("continuity output cannot replace chain or policy inputs", () => {
  const value = fixture();
  assert.equal(silent(() => runContinuityCommand([
    "verify", "--chain", value.chain, "--output", join(value.chain, "root.json"),
  ])), 2);
  assert.equal(silent(() => runContinuityCommand([
    "status", "--chain", value.chain, "--policy", value.policyPath, "--output", value.policyPath,
  ])), 2);
  const privateKey = join(value.root, "staple-private.pem");
  const publicKey = join(value.root, "staple-public.pem");
  generateSigningKey(privateKey, publicKey);
  assert.equal(silent(() => runContinuityCommand([
    "staple", "--chain", value.chain, "--policy", value.policyPath, "--environment", "production",
    "--signing-key", privateKey, "--output", value.policyPath,
  ])), 2);
});
