import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../src/report.ts";
import {
  CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE,
  buildControlProofPredicate,
  loadControlProof,
  verifyGhControlProofAttestationOutput,
  verifyGitHubControlProofAttestation,
  writeControlProofPredicate,
} from "../src/control-proof-attestation.ts";
import type { ControlProofReport } from "../src/control-proof.ts";
import { run } from "../src/cli.ts";

const SOURCE = "1".repeat(40);

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(): { root: string; path: string; proof: ControlProofReport } {
  const root = mkdtempSync(join(tmpdir(), "vigil-control-proof-attestation-"));
  const payload = {
    schemaVersion: "agent-vigil-control-proof/v1" as const,
    vigilVersion: "test-version",
    status: "PASS" as const,
    sourceCommit: SOURCE,
    generatedAt: "2026-08-24T12:00:00.000Z",
    challenges: [{
      id: "planted-denial",
      claim: "A planted authority expansion is blocked.",
      expected: "BLOCK" as const,
      actual: "BLOCK" as const,
      passed: true,
      base: SOURCE,
      head: "2".repeat(40),
      evidence: "the exact planted change was blocked",
    }],
    summary: { passed: 1, total: 1 },
    reproduction: `vigil prove --repo . --base ${SOURCE}`,
    limits: ["This fixture covers one planted control."],
  };
  const proof: ControlProofReport = { ...payload, receiptHash: digest(canonical(payload)) };
  const path = join(root, "control-proof.json");
  writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`);
  return { root, path, proof };
}

function verifiedGhOutput(path: string): unknown {
  const predicate = buildControlProofPredicate(path);
  const fileDigest = createHash("sha256").update(readFileSync(path)).digest("hex");
  return [{
    verificationResult: {
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: "control-proof.json", digest: { sha256: fileDigest } }],
        predicateType: CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE,
        predicate,
      },
    },
  }];
}

test("control proof predicate binds the exact proof while omitting claims and evidence", () => {
  const value = fixture();
  const predicate = buildControlProofPredicate(value.path);
  assert.equal(predicate.proof.receiptHash, value.proof.receiptHash);
  assert.equal(predicate.proof.sourceCommit, SOURCE);
  assert.deepEqual(predicate.privacy, { claimsIncluded: false, evidenceIncluded: false, repositoryPathIncluded: false });
  const serialized = JSON.stringify(predicate);
  assert.doesNotMatch(serialized, /planted authority expansion|exact planted change/);
  assert.doesNotMatch(serialized, new RegExp(value.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const output = join(value.root, "predicate.json");
  writeControlProofPredicate(value.path, output);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), predicate);
});

test("control proof attestation verification binds subject, predicate, source, and signer identity", () => {
  const value = fixture();
  assert.equal(verifyGhControlProofAttestationOutput(value.path, verifiedGhOutput(value.path)).valid, true);

  const calls: string[][] = [];
  const verification = verifyGitHubControlProofAttestation(value.path, "outside/repository", {
    signerWorkflow: "outside/repository/.github/workflows/agent-vigil-control-proof.yml",
    signerDigest: "3".repeat(40),
  }, (args) => {
    calls.push(args);
    return JSON.stringify(verifiedGhOutput(value.path));
  });
  assert.equal(verification.valid, true);
  assert.ok(calls[0].includes("--source-digest"));
  assert.ok(calls[0].includes(SOURCE));
  assert.ok(calls[0].includes("--signer-digest"));
  assert.ok(calls[0].includes("3".repeat(40)));
  assert.ok(calls[0].includes("--deny-self-hosted-runners"));
});

test("control proof attestation fails closed on tampering and misleading statements", () => {
  const wrongSubject = fixture();
  const subjectOutput = verifiedGhOutput(wrongSubject.path) as any;
  subjectOutput[0].verificationResult.statement.subject[0].digest.sha256 = "0".repeat(64);
  assert.equal(verifyGhControlProofAttestationOutput(wrongSubject.path, subjectOutput).valid, false);

  const replay = fixture();
  const replayOutput = verifiedGhOutput(replay.path) as any;
  replayOutput[0].verificationResult.statement.predicate.proof.sourceCommit = "9".repeat(40);
  assert.equal(verifyGhControlProofAttestationOutput(replay.path, replayOutput).valid, false);

  const extra = fixture();
  const extraOutput = verifiedGhOutput(extra.path) as any;
  extraOutput[0].verificationResult.statement.predicate.extra = true;
  assert.equal(verifyGhControlProofAttestationOutput(extra.path, extraOutput).valid, false);

  const tampered = fixture();
  const changed = JSON.parse(readFileSync(tampered.path, "utf8"));
  changed.challenges[0].actual = "PASS";
  writeFileSync(tampered.path, JSON.stringify(changed));
  assert.throws(() => loadControlProof(tampered.path), /inconsistent decision fields|does not match receiptHash/);
});

test("control proof loading rejects symlinks and invalid trust pins", () => {
  const value = fixture();
  const link = join(value.root, "linked-proof.json");
  symlinkSync(value.path, link);
  assert.throws(() => loadControlProof(link), /symbolic link/);
  assert.throws(() => verifyGitHubControlProofAttestation(value.path, "not-a-repository"), /owner\/name/);
  assert.throws(() => verifyGitHubControlProofAttestation(value.path, "outside/repository", { signerDigest: "short" }), /full lowercase commit SHA/);
});

test("CLI prepares a keyless control proof predicate and rejects malformed use", () => {
  const value = fixture();
  const output = join(value.root, "predicate.json");
  assert.equal(run(["attest-control", value.path, "--predicate-output", output]), 0);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).proof.sourceCommit, SOURCE);
  assert.equal(run(["attest-control", value.path]), 2);
  assert.equal(run(["verify-control-attestation", value.path, "--repository", "bad"]), 2);
});

test("composite Action allows GitHub attestation in prove mode and chooses the control predicate", () => {
  const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.doesNotMatch(action, /prove mode does not yet support attestation/);
  assert.match(action, /attest-control "\$VIGIL_REPORT"/);
  assert.match(action, /control-proof-predicate-v1\.schema\.json/);
  assert.match(action, /predicate-type: \$\{\{ steps\.prepare_attestation\.outputs\.predicate_type \}\}/);
});

test("weekly dogfood signs and retains its control proof without a private key", () => {
  const workflow = readFileSync(new URL("../.github/workflows/control-proof-weekly.yml", import.meta.url), "utf8");
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /node-version:\s*22\.23\.2/);
  assert.doesNotMatch(workflow, /^\s*node-version:\s*22\s*$/m);
  assert.match(workflow, /sulmusic2-star\/agent-vigil@33281ba665721165152177890837387d403d3fa6/);
  assert.match(workflow, /mode:\s*prove/);
  assert.match(workflow, /attest:\s*false/);
  assert.doesNotMatch(workflow, /npm\s|dist\/cli\.js|control-certificate|control-corpus|control-policy|control-status/);
  assert.match(workflow, /must contain exactly the proof and predicate/);
  assert.match(workflow, /predicate\.proof\.fileSha256 !== sha256\(proofBytes\)/);
  assert.match(workflow, /predicate\.proof\.challengeSetSha256 !== sha256\(canonical\(challengeSet\)\)/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /control-proof-predicate-v1\.schema\.json/);
  assert.match(workflow, /steps\.attestation\.outputs\.bundle-path/);
  assert.doesNotMatch(workflow, /PRIVATE_KEY|SIGNING_KEY|secrets\./);
});
