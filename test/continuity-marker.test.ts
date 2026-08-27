import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChainVerification } from "../src/continuity/chain.ts";
import { canonicalSha256, type ContinuityEvent, type ContinuityRoot, type ContinuityState } from "../src/continuity/contracts.ts";
import type { ContinuityDecision } from "../src/continuity/decision.ts";
import { issueContinuityStaple } from "../src/continuity/staple.ts";
import type { TrustReport } from "../src/report.ts";
import { generateSigningKey } from "../src/signature.ts";

const HEAD = "2".repeat(40);

function digest(label: string): string {
  return canonicalSha256({ label });
}

type MarkerFixture = {
  root: string;
  staple: string;
  publicKey: string;
  receiptHash: string;
  policyHash: string;
  chainTip: string;
};

function fixture(state: ContinuityState = "CURRENT", issuedAt = new Date()): MarkerFixture {
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-marker-fixture-"));
  const privateKey = join(root, "authority-private.pem");
  const publicKey = join(root, "authority-public.pem");
  const staple = join(root, "staple.json");
  generateSigningKey(privateKey, publicKey);
  const subject = {
    episodeReceiptHash: digest("receipt"),
    repositoryHash: digest("repository"),
    baseSha: "1".repeat(40),
    headSha: HEAD,
  };
  const rootHash = digest("root");
  const chainTip = digest("chain-tip");
  const policyHash = digest("policy");
  const continuityRoot: ContinuityRoot = {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: digest("receipt-file"),
    receiptHash: subject.episodeReceiptHash,
    rootHash,
    subject,
    historicalVerification: "PASS",
    createdAt: new Date(issuedAt.getTime() - 60_000).toISOString(),
  };
  const verification: ChainVerification = {
    valid: true,
    errors: [],
    root: continuityRoot,
    report: {} as TrustReport,
    events: [{ sequence: 1 }, { sequence: 2 }] as ContinuityEvent[],
    chainTip,
    rootSignature: { present: true, valid: true, keyId: digest("root-key") },
  };
  const decision: ContinuityDecision = {
    schemaVersion: "agent-vigil-continuity-decision/v1",
    evaluatedAt: issuedAt.toISOString(),
    historicalVerification: "PASS",
    continuity: state,
    allowsProtectedAction: state === "CURRENT",
    protectedEnvironment: "production",
    rootHash,
    chainTip,
    eventCount: 2,
    policy: { sourceHash: digest("policy-source"), sha256: policyHash },
    outcomeFacts: [],
    reasons: [],
    decisionHash: digest(`decision-${state}`),
  };
  writeFileSync(staple, `${JSON.stringify(issueContinuityStaple({ verification, decision, privateKeyPath: privateKey, ttlSeconds: 300 }), null, 2)}\n`);
  return { root, staple, publicKey, receiptHash: subject.episodeReceiptHash, policyHash, chainTip };
}

function actionScript(root: string): string {
  const action = readFileSync(join(process.cwd(), "github-marker/action.yml"), "utf8");
  const block = action.match(/      run: \|\n([\s\S]+)$/)?.[1];
  assert.ok(block, "continuity marker script is present");
  const script = join(root, "marker.sh");
  writeFileSync(script, block.split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n"));
  return script;
}

function run(value: MarkerFixture, overrides: NodeJS.ProcessEnv = {}) {
  const output = join(value.root, "github-output");
  const summary = join(value.root, "github-summary");
  const runner = join(value.root, "runner");
  const event = join(value.root, "event.json");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  writeFileSync(event, "{}\n");
  mkdirSync(runner, { recursive: true });
  const script = actionScript(value.root);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GITHUB_ACTION_PATH: join(process.cwd(), "github-marker"),
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_EVENT_PATH: event,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    RUNNER_TEMP: runner,
    VIGIL_TEST_VECTOR: "false",
    VIGIL_STAPLE: value.staple,
    VIGIL_PUBLIC_KEY: value.publicKey,
    VIGIL_EXPECTED_RECEIPT_HASH: value.receiptHash,
    VIGIL_EXPECTED_HEAD: HEAD,
    VIGIL_ENVIRONMENT: "production",
    VIGIL_EXPECTED_POLICY_SHA256: value.policyHash,
    VIGIL_EXPECTED_CHAIN_TIP: value.chainTip,
    VIGIL_MINIMUM_SEQUENCE: "2",
    ...overrides,
  };
  delete environment.NODE_V8_COVERAGE;
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync("bash", [script], { cwd: value.root, env: environment, encoding: "utf8" });
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  return { result, outputs, summary: readFileSync(summary, "utf8") };
}

test("the five-minute marker creates only an ephemeral CURRENT marker", { skip: process.platform === "win32" }, () => {
  const value = fixture();
  const accepted = run(value);
  assert.equal(accepted.result.status, 0, `${accepted.result.stderr}\n${accepted.result.stdout}`);
  assert.equal(accepted.outputs.status, "CURRENT");
  assert.equal(accepted.outputs.reason_code, "CURRENT_STAPLE");
  assert.match(accepted.outputs.duration_ms, /^\d+$/);
  assert.equal(existsSync(accepted.outputs.marker), true);
  assert.equal(readFileSync(accepted.outputs.marker, "utf8"), "agent-vigil-continuity-marker/v1\nCURRENT\n");
  assert.match(accepted.summary, /CURRENT_STAPLE/);
  for (const privateValue of [value.root, value.receiptHash, HEAD]) assert.equal(accepted.summary.includes(privateValue), false);
});

test("the marker emits one private denial and no marker for revocation, expiry, or invalid input", { skip: process.platform === "win32" }, () => {
  const revoked = run(fixture("REVOKED"));
  assert.equal(revoked.result.status, 1);
  assert.equal(revoked.outputs.status, "REVOKED");
  assert.equal(revoked.outputs.reason_code, "LATER_EVIDENCE_REVOKED");
  assert.equal(revoked.outputs.marker, "");

  const expiredValue = fixture("CURRENT", new Date(Date.now() - 600_000));
  const expired = run(expiredValue);
  assert.equal(expired.result.status, 4);
  assert.equal(expired.outputs.status, "EXPIRED");
  assert.equal(expired.outputs.reason_code, "STAPLE_EXPIRED");
  assert.equal(expired.outputs.marker, "");

  const invalidValue = fixture();
  const changed = JSON.parse(readFileSync(invalidValue.staple, "utf8"));
  changed.payload.subject.headSha = "9".repeat(40);
  writeFileSync(invalidValue.staple, `${JSON.stringify(changed)}\n`);
  const invalid = run(invalidValue);
  assert.equal(invalid.result.status, 2);
  assert.equal(invalid.outputs.status, "ERROR");
  assert.equal(invalid.outputs.reason_code, "STAPLE_INVALID");
  assert.equal(invalid.outputs.marker, "");
});

test("the marker refuses candidate workflows and binds trusted GitHub event heads", { skip: process.platform === "win32" }, () => {
  const candidateValue = fixture();
  const candidate = run(candidateValue, { GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(candidate.result.status, 2);
  assert.equal(candidate.outputs.reason_code, "UNTRUSTED_WORKFLOW_CONTEXT");
  assert.equal(candidate.outputs.marker, "");

  const trustedValue = fixture();
  const event = join(trustedValue.root, "trusted-event.json");
  writeFileSync(event, `${JSON.stringify({ pull_request: { head: { sha: HEAD, repo: { fork: true } } } })}\n`);
  const trusted = run(trustedValue, { GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: event });
  assert.equal(trusted.result.status, 0, `${trusted.result.stderr}\n${trusted.result.stdout}`);

  const mismatchValue = fixture();
  const mismatchEvent = join(mismatchValue.root, "mismatch-event.json");
  writeFileSync(mismatchEvent, `${JSON.stringify({ pull_request: { head: { sha: "8".repeat(40) } } })}\n`);
  const mismatch = run(mismatchValue, { GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: mismatchEvent });
  assert.equal(mismatch.result.status, 2);
  assert.equal(mismatch.outputs.reason_code, "HEAD_BINDING_MISMATCH");
  assert.equal(mismatch.outputs.marker, "");
});

test("the bundled public vector produces a self-test marker that cannot be mistaken for CURRENT", { skip: process.platform === "win32" }, () => {
  const value = fixture();
  const smoke = run(value, { VIGIL_TEST_VECTOR: "true" });
  assert.equal(smoke.result.status, 0, `${smoke.result.stderr}\n${smoke.result.stdout}`);
  assert.equal(smoke.outputs.status, "SELF_TEST_PASS");
  assert.equal(smoke.outputs.reason_code, "PUBLIC_VECTOR_PASS");
  assert.equal(readFileSync(smoke.outputs.marker, "utf8"), "agent-vigil-continuity-marker/v1\nSELF_TEST_PASS\n");

  const refused = run(fixture(), { VIGIL_TEST_VECTOR: "true", GITHUB_EVENT_NAME: "pull_request_target" });
  assert.equal(refused.result.status, 2);
  assert.equal(refused.outputs.reason_code, "SELF_TEST_EVENT_REFUSED");
  assert.equal(refused.outputs.marker, "");
});
