import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildControlProof } from "../src/control-proof.ts";
import {
  appendCorpusEntry,
  buildStatusReport,
  createCertificate,
  createSingleRepositoryPolicy,
  parseCorpus,
  renderStatusReport,
  validateCertificate,
} from "../src/certification.ts";
import { run } from "../src/cli.ts";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function proofFixture() {
  const repo = mkdtempSync(join(tmpdir(), "vigil-certification-proof-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "vigil@example.test"]);
    git(repo, ["config", "user.name", "Vigil Test"]);
    writeFileSync(join(repo, "README.md"), "certification fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-qm", "base"]);
    return buildControlProof(repo, "HEAD", "test-version");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const proof = proofFixture();
const certificate = createCertificate({
  proof,
  organization: "example",
  repository: "example/api",
  requiredCheck: "Agent Vigil evidence",
});

test("certificate binds repository identity to one verified control proof", () => {
  assert.equal(validateCertificate(certificate).certificateHash, certificate.certificateHash);
  assert.equal(certificate.proof.status, "PASS");
  assert.equal(certificate.proof.challenges.length, 7);
  assert.deepEqual(certificate.control, {
    vendor: "sulmusic2-star",
    product: "agent-vigil",
    adapter: "agent-vigil/control-proof-v1",
    version: "test-version",
  });

  const tampered = structuredClone(certificate);
  tampered.repository = "example/other";
  assert.throws(() => validateCertificate(tampered), /certificate hash is invalid/);

  const spoofed = structuredClone(certificate);
  spoofed.control.vendor = "other-vendor";
  assert.throws(() => validateCertificate(spoofed), /does not match its verified adapter/);
});

test("certificate rejects a changed proof time instead of refreshing old evidence", () => {
  assert.throws(() => createCertificate({ proof: { ...proof, generatedAt: "2026-08-23T00:00:00.000Z" }, organization: "example", repository: "example/api", requiredCheck: "Agent Vigil evidence" }), /receipt hash is invalid/);
});

test("chained corpus rejects duplicates, altered history, and broken sequence", () => {
  const first = appendCorpusEntry("", certificate);
  const parsed = parseCorpus(first.line);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].previousEntryHash, null);
  assert.throws(() => appendCorpusEntry(first.line, certificate), /already exists/);

  const altered = JSON.parse(first.line);
  altered.sequence = 2;
  assert.throws(() => parseCorpus(`${JSON.stringify(altered)}\n`), /chain is invalid/);

  const rehashedCertificate = structuredClone(certificate);
  rehashedCertificate.proof.generatedAt = "2026-08-01T00:00:00.000Z";
  assert.throws(() => appendCorpusEntry(first.line, rehashedCertificate), /certificate hash is invalid/);
});

test("seven-day policy distinguishes fresh, stale, missing, and future evidence", () => {
  const corpus = parseCorpus(appendCorpusEntry("", certificate).line);
  const policy = createSingleRepositoryPolicy({
    organization: "example",
    repository: "example/api",
    requiredCheck: "Agent Vigil evidence",
    pack: "authority",
  });
  const generated = Date.parse(certificate.proof.generatedAt);
  const fresh = buildStatusReport(policy, corpus, new Date(generated + 6 * 24 * 3_600_000).toISOString());
  assert.equal(fresh.status, "PASS");
  assert.equal(fresh.repositories[0].state, "FRESH");
  assert.match(renderStatusReport(fresh), /1\/1 required repositories have fresh proof/);

  const stale = buildStatusReport(policy, corpus, new Date(generated + 8 * 24 * 3_600_000).toISOString());
  assert.equal(stale.status, "HOLD");
  assert.equal(stale.repositories[0].state, "STALE");

  const future = buildStatusReport(policy, corpus, new Date(generated - 60_000).toISOString());
  assert.equal(future.repositories[0].state, "HOLD");
  assert.match(future.repositories[0].reason, /dated after/);

  const missingPolicy = createSingleRepositoryPolicy({ organization: "example", repository: "example/web", requiredCheck: "Agent Vigil evidence", pack: "baseline" });
  const missing = buildStatusReport(missingPolicy, corpus, new Date(generated + 3_600_000).toISOString());
  assert.equal(missing.repositories[0].state, "MISSING");
});

test("authority policy fails closed when a required challenge disappears", () => {
  const reduced = structuredClone(certificate);
  const last = reduced.proof.challenges.pop();
  assert.ok(last);
  // The certificate is deliberately not rehashed; altered evidence must be
  // rejected before policy evaluation can mistake it for a weaker pack.
  assert.throws(() => validateCertificate(reduced), /certificate hash is invalid/);
});

test("certify CLI creates a private record, corpus, policy, and deterministic status report", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-certify-cli-"));
  try {
    const proofPath = join(directory, "proof.json");
    const certificatePath = join(directory, "certificate.json");
    const corpusPath = join(directory, "corpus.jsonl");
    const policyPath = join(directory, "policy.json");
    const statusPath = join(directory, "status.json");
    writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);

    assert.equal(run(["certify", "record", proofPath, "--organization", "example", "--repository", "example/api", "--required-check", "Agent Vigil evidence", "--output", certificatePath]), 0);
    assert.equal(run(["certify", "add", certificatePath, "--corpus", corpusPath]), 0);
    assert.equal(run(["certify", "policy", "--organization", "example", "--repository", "example/api", "--required-check", "Agent Vigil evidence", "--pack", "authority", "--output", policyPath]), 0);
    const asOf = new Date(Date.parse(proof.generatedAt) + 3_600_000).toISOString();
    assert.equal(run(["certify", "status", "--corpus", corpusPath, "--policy", policyPath, "--as-of", asOf, "--format", "json", "--output", statusPath]), 0);
    const report = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.equal(report.status, "PASS");
    assert.deepEqual(report.summary, { fresh: 1, stale: 0, missing: 0, held: 0, total: 1 });
    assert.match(report.reportHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(run(["certify", "add", certificatePath, "--corpus", corpusPath]), 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
