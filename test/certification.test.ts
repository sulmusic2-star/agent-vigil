import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildControlProof } from "../src/control-proof.ts";
import {
  appendCorpusEntry,
  buildStatusReport,
  createCertificate,
  createSignedCertificate,
  createSingleRepositoryPolicy,
  parseCorpus,
  renderStatusReport,
  validateCertificate,
  validateSignedCertificate,
} from "../src/certification.ts";
import { run } from "../src/cli.ts";
import { generateSigningKey } from "../src/signature.ts";
import { signControlProof, signedControlIdentity, verifySignedControlProof } from "../src/signed-control-proof.ts";

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

function signedPayload(vendor = "example-vendor") {
  return {
    control: { vendor, product: "change-gate", version: "2026.8" },
    sourceCommit: proof.sourceCommit,
    generatedAt: proof.generatedAt,
    status: "PASS",
    challenges: [
      { id: "clean-control", expected: "PASS", actual: "PASS", passed: true, evidenceHash: `sha256:${"a".repeat(64)}` },
      { id: "permission-expansion", expected: "BLOCK", actual: "BLOCK", passed: true, evidenceHash: `sha256:${"b".repeat(64)}` },
    ],
    summary: { passed: 2, total: 2 },
    limits: ["The signer reports challenge results; Agent Vigil does not reconstruct private evidence."],
  } as const;
}

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
  assert.throws(() => appendCorpusEntry(first.line, rehashedCertificate), /receipt hash is invalid/);
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
  assert.throws(() => validateCertificate(reduced), /receipt hash is invalid/);
});

test("signed proof binds challenge evidence to a pinned Ed25519 identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-signed-proof-"));
  try {
    const privateKey = join(directory, "provider-private.pem");
    const publicKey = join(directory, "provider-public.pem");
    const wrongPrivateKey = join(directory, "wrong-private.pem");
    const wrongPublicKey = join(directory, "wrong-public.pem");
    generateSigningKey(privateKey, publicKey);
    generateSigningKey(wrongPrivateKey, wrongPublicKey);
    const signed = signControlProof(signedPayload(), privateKey);
    assert.equal(verifySignedControlProof(signed, publicKey).payload.status, "PASS");
    assert.throws(() => verifySignedControlProof(signed, wrongPublicKey), /does not match the pinned public key/);

    const certificateV2 = createSignedCertificate({
      proof: signed,
      publicKeyPath: publicKey,
      organization: "example",
      repository: "example/api",
      requiredCheck: "Independent AI control",
    });
    assert.equal(validateSignedCertificate(certificateV2).certificateHash, certificateV2.certificateHash);
    assert.equal(certificateV2.control.keyId, signed.signature.keyId);
    assert.equal(signedControlIdentity(signed), `example-vendor/change-gate@${signed.signature.keyId}`);

    const tampered = structuredClone(signed);
    tampered.payload.challenges[0].evidenceHash = `sha256:${"c".repeat(64)}`;
    assert.throws(() => verifySignedControlProof(tampered), /payload hash is invalid/);

    const badSignature = structuredClone(signed);
    badSignature.signature.value = Buffer.alloc(64).toString("base64");
    assert.throws(() => verifySignedControlProof(badSignature), /signature is invalid/);

    const inconsistent = structuredClone(signed);
    inconsistent.payload.challenges[0].passed = false;
    assert.throws(() => verifySignedControlProof(inconsistent), /inconsistent decision fields/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("signed proof rejects malformed decisions, encodings, identities, and key types", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-signed-proof-negative-"));
  try {
    const privateKey = join(directory, "provider-private.pem");
    const publicKey = join(directory, "provider-public.pem");
    generateSigningKey(privateKey, publicKey);
    const signed = signControlProof(signedPayload(), privateKey);

    assert.throws(() => signControlProof({ ...signedPayload(), extra: true }, privateKey), /fields must be exactly/);
    assert.throws(() => signControlProof({ ...signedPayload(), challenges: [], summary: { passed: 0, total: 0 } }, privateKey), /must contain 1 to 100/);
    assert.throws(() => signControlProof({ ...signedPayload(), summary: { passed: 1, total: 2 } }, privateKey), /summary does not match/);
    assert.throws(() => signControlProof({ ...signedPayload(), status: "HOLD" }, privateKey), /status does not match/);
    assert.throws(() => signControlProof({ ...signedPayload(), control: { vendor: "bad/vendor", product: "gate", version: "1" } }, privateKey), /must contain only/);
    assert.throws(() => signControlProof({ ...signedPayload(), challenges: [signedPayload().challenges[0], signedPayload().challenges[0]], summary: { passed: 2, total: 2 } }, privateKey), /duplicate signed proof challenge/);

    const wrongId = structuredClone(signed);
    wrongId.signature.keyId = `sha256:${"0".repeat(64)}`;
    assert.throws(() => verifySignedControlProof(wrongId), /key ID does not match/);
    const badBase64 = structuredClone(signed);
    badBase64.signature.publicKey = "***";
    assert.throws(() => verifySignedControlProof(badBase64), /canonical base64/);
    const extra = { ...signed, extra: true };
    assert.throws(() => verifySignedControlProof(extra), /fields must be exactly/);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPrivate = join(directory, "rsa-private.pem");
    const rsaPublic = join(directory, "rsa-public.pem");
    writeFileSync(rsaPrivate, rsa.privateKey.export({ type: "pkcs8", format: "pem" }));
    writeFileSync(rsaPublic, rsa.publicKey.export({ type: "spki", format: "pem" }));
    assert.throws(() => signControlProof(signedPayload(), rsaPrivate), /private key must be Ed25519/);
    assert.throws(() => verifySignedControlProof(signed, rsaPublic), /public key must be Ed25519/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mixed V1 and V2 corpus preserves one chain and policy pins the signer", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-mixed-corpus-"));
  try {
    const privateKey = join(directory, "provider-private.pem");
    const publicKey = join(directory, "provider-public.pem");
    generateSigningKey(privateKey, publicKey);
    const signed = signControlProof(signedPayload(), privateKey);
    const certificateV2 = createSignedCertificate({ proof: signed, publicKeyPath: publicKey, organization: "example", repository: "example/api", requiredCheck: "Independent AI control" });
    const first = appendCorpusEntry("", certificate);
    const second = appendCorpusEntry(first.line, certificateV2);
    const entries = parseCorpus(first.line + second.line);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].schemaVersion, "agent-vigil-control-corpus-entry/v1");
    assert.equal(entries[1].schemaVersion, "agent-vigil-control-corpus-entry/v2");
    assert.equal(entries[1].previousEntryHash, entries[0].entryHash);
    const mismatched = JSON.parse(second.line);
    mismatched.schemaVersion = "agent-vigil-control-corpus-entry/v1";
    assert.throws(() => parseCorpus(first.line + `${JSON.stringify(mismatched)}\n`), /entry and certificate versions do not match/);

    const spoofedCertificate = structuredClone(certificateV2);
    spoofedCertificate.control.vendor = "other-vendor";
    assert.throws(() => validateSignedCertificate(spoofedCertificate), /identity does not match/);

    const identity = signedControlIdentity(signed);
    const policy = {
      schemaVersion: "agent-vigil-control-policy/v1",
      policyId: "independent-weekly-v1",
      organization: "example",
      maxAgeHours: 168,
      repositories: [{ repository: "example/api", requiredCheck: "Independent AI control", allowedControls: [identity], requiredChallenges: ["clean-control", "permission-expansion"] }],
    };
    const asOf = new Date(Date.parse(signed.payload.generatedAt) + 3_600_000).toISOString();
    const fresh = buildStatusReport(policy, entries, asOf);
    assert.equal(fresh.status, "PASS");
    assert.equal(fresh.repositories[0].control, identity);

    const replacementPrivate = join(directory, "replacement-private.pem");
    const replacementPublic = join(directory, "replacement-public.pem");
    generateSigningKey(replacementPrivate, replacementPublic);
    const replacementProof = signControlProof(signedPayload(), replacementPrivate);
    const replacementCertificate = createSignedCertificate({ proof: replacementProof, publicKeyPath: replacementPublic, organization: "example", repository: "example/api", requiredCheck: "Independent AI control" });
    const replacementEntry = appendCorpusEntry(first.line, replacementCertificate);
    const held = buildStatusReport(policy, parseCorpus(first.line + replacementEntry.line), asOf);
    assert.equal(held.status, "HOLD");
    assert.match(held.repositories[0].reason, /not allowed by policy/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("certify signed CLI creates a pinned V2 certificate and adds it to a corpus", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-certify-signed-cli-"));
  try {
    const privateKey = join(directory, "provider-private.pem");
    const publicKey = join(directory, "provider-public.pem");
    const payloadPath = join(directory, "payload.json");
    const proofPath = join(directory, "signed-proof.json");
    const certificatePath = join(directory, "signed-certificate.json");
    const corpusPath = join(directory, "corpus.jsonl");
    generateSigningKey(privateKey, publicKey);
    writeFileSync(payloadPath, `${JSON.stringify(signedPayload())}\n`);
    assert.equal(run(["certify", "sign", payloadPath, "--private-key", privateKey, "--output", proofPath]), 0);
    assert.equal(run(["certify", "record-signed", proofPath, "--public-key", publicKey, "--organization", "example", "--repository", "example/api", "--required-check", "Independent AI control", "--output", certificatePath]), 0);
    assert.equal(run(["certify", "add", certificatePath, "--corpus", corpusPath]), 0);
    const entries = parseCorpus(readFileSync(corpusPath, "utf8"));
    assert.equal(entries[0].schemaVersion, "agent-vigil-control-corpus-entry/v2");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
