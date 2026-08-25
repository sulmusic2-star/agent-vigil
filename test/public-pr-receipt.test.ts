import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildPublicPrReceipt,
  collectPublicPrSnapshot,
  parsePublicPullRequestUrl,
  recomputePublicPrReceiptHash,
  signPublicPrReceipt,
  validateToolCommit,
  verifyPublicPrReceipt,
  type PublicPrSnapshot,
  type PublicPrTransport,
} from "../src/public-pr-receipt.ts";
import { generateSigningKey } from "../src/signature.ts";
import { runPublicPrReceiptCommand } from "../src/public-pr-receipt-cli.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TOOL = "3".repeat(40);
const PR_URL = "https://github.com/example/project/pull/42";
const NOW = "2026-08-25T13:00:00.000Z";

function source(kind: PublicPrSnapshot["sources"][number]["kind"]): PublicPrSnapshot["sources"][number] {
  return {
    kind,
    endpoint: `https://api.github.com/example/${kind}`,
    status: 200,
    bytes: 2,
    sha256: `sha256:${"4".repeat(64)}`,
    complete: true,
  };
}

function snapshot(overrides: Partial<PublicPrSnapshot> = {}): PublicPrSnapshot {
  return {
    pull: {
      state: "closed",
      merged: true,
      merged_at: "2026-08-25T12:00:00Z",
      updated_at: "2026-08-25T12:00:00Z",
      base: { sha: BASE },
      head: { sha: HEAD },
    },
    reviews: [{ state: "APPROVED", submitted_at: "2026-08-25T11:00:00Z", user: { login: "maintainer" } }],
    checkRuns: [{ status: "completed", conclusion: "success", completed_at: "2026-08-25T11:30:00Z" }],
    statuses: [],
    sources: [source("pull-request"), source("reviews"), source("check-runs"), source("commit-statuses")],
    unavailable: [],
    ...overrides,
  };
}

function build(value = snapshot(), generatedAt = NOW) {
  return buildPublicPrReceipt(value, PR_URL, { generatedAt, maxAgeHours: 168, toolVersion: "0.18.0", toolCommit: TOOL });
}

test("public PR URL parsing rejects alternate hosts, credentials, query data, and malformed paths", () => {
  assert.deepEqual(parsePublicPullRequestUrl("https://github.com/example/project/pull/42/"), {
    owner: "example", repo: "project", number: 42, url: PR_URL,
  });
  for (const value of [
    "http://github.com/example/project/pull/42",
    "https://evil.example/example/project/pull/42",
    "https://token@github.com/example/project/pull/42",
    "https://github.com/example/project/pull/42?token=secret",
    "https://github.com/example/project/issues/42",
  ]) assert.throws(() => parsePublicPullRequestUrl(value));
});

test("tool pin requires a full lowercase commit rather than a mutable tag or branch", () => {
  assert.equal(validateToolCommit(TOOL), TOOL);
  for (const value of ["v0.18.0", "main", "ABCDEF", "3".repeat(39), "G".repeat(40)]) {
    assert.throws(() => validateToolCommit(value), /full lowercase Git commit SHA/);
  }
});

test("merged approved public evidence becomes CURRENT without authorizing deployment", () => {
  const receipt = build();
  assert.equal(receipt.decision.continuity, "CURRENT");
  assert.equal(receipt.decision.allowsProtectedAction, false);
  assert.deepEqual(receipt.decision.reasonCodes, ["merged-approved-checks-observed"]);
  assert.equal(receipt.claimBoundary.executionObserved, true);
  assert.equal(receipt.claimBoundary.sufficiencyAssessed, false);
  assert.equal(receipt.integration.workflowChangeRequired, false);
  assert.equal(receipt.integration.repositoryWritePermission, false);
  assert.equal(recomputePublicPrReceiptHash(receipt), receipt.receiptHash);
});

test("formal approval followed by a closed unmerged PR becomes REVOKED", () => {
  const receipt = build(snapshot({
    pull: {
      state: "closed",
      merged: false,
      merged_at: null,
      closed_at: "2026-08-25T12:49:32Z",
      updated_at: "2026-08-25T12:49:32Z",
      base: { sha: BASE },
      head: { sha: HEAD },
    },
  }));
  assert.equal(receipt.decision.continuity, "REVOKED");
  assert.deepEqual(receipt.decision.reasonCodes, ["approved-then-closed-unmerged"]);
  assert.match(receipt.decision.summary, /closed the pull request without merging/);
});

test("missing, failing, pending, unknown, or incomplete check evidence fails closed to HOLD", () => {
  const variants: PublicPrSnapshot[] = [
    snapshot({ checkRuns: [] }),
    snapshot({ checkRuns: [{ status: "completed", conclusion: "failure", completed_at: "2026-08-25T11:30:00Z" }] }),
    snapshot({ checkRuns: [{ status: "in_progress", conclusion: null, started_at: "2026-08-25T11:30:00Z" }] }),
    snapshot({ checkRuns: [{ status: "completed", conclusion: null, completed_at: "2026-08-25T11:30:00Z" }] }),
    snapshot({ unavailable: ["reviews:pagination-incomplete"] }),
  ];
  for (const value of variants) assert.equal(build(value).decision.continuity, "HOLD");
});

test("new check attempts and commit statuses supersede old results for the same named check", () => {
  const receipt = build(snapshot({
    checkRuns: [
      { id: 1, name: "tests", app: { slug: "github-actions" }, status: "completed", conclusion: "failure", completed_at: "2026-08-25T10:00:00Z" },
      { id: 2, name: "tests", app: { slug: "github-actions" }, status: "completed", conclusion: "success", completed_at: "2026-08-25T11:30:00Z" },
    ],
    statuses: [
      { id: 1, context: "preview", state: "failure", updated_at: "2026-08-25T10:00:00Z" },
      { id: 2, context: "preview", state: "success", updated_at: "2026-08-25T11:45:00Z" },
    ],
  }));
  assert.equal(receipt.decision.continuity, "CURRENT");
  assert.deepEqual(receipt.observation.checks, { total: 2, passing: 2, failing: 0, pending: 0, unknown: 0 });
});

test("otherwise-current evidence becomes EXPIRED after the selected window", () => {
  const receipt = build(snapshot(), "2026-09-02T13:00:01.000Z");
  assert.equal(receipt.decision.continuity, "EXPIRED");
  assert.deepEqual(receipt.decision.reasonCodes, ["evidence-older-than-policy-window"]);
});

test("an observation time before returned evidence fails closed to HOLD", () => {
  const receipt = build(snapshot(), "2026-08-25T11:59:59.000Z");
  assert.equal(receipt.decision.continuity, "HOLD");
  assert.deepEqual(receipt.decision.reasonCodes, ["evidence-after-observation-time"]);
});

test("customer-controlled Ed25519 signing never embeds the private key or its path", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-public-pr-sign-"));
  const privateKey = join(root, "operator-private.pem");
  const publicKey = join(root, "operator-public.pem");
  generateSigningKey(privateKey, publicKey);
  const signed = signPublicPrReceipt(build(), privateKey);
  const serialized = JSON.stringify(signed);
  assert.doesNotMatch(serialized, /PRIVATE KEY|operator-private|vigil-public-pr-sign/);
  assert.match(readFileSync(publicKey, "utf8"), /PUBLIC KEY/);
  assert.deepEqual(verifyPublicPrReceipt(signed), {
    hashValid: true,
    signatureValid: true,
    keyId: signed.signature?.keyId,
  });
  signed.decision.summary = "tampered";
  assert.equal(verifyPublicPrReceipt(signed).hashValid, false);
});

test("offline CLI verification accepts a valid receipt and rejects tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-public-pr-verify-"));
  const privateKey = join(root, "operator-private.pem");
  const publicKey = join(root, "operator-public.pem");
  const receiptPath = join(root, "receipt.json");
  generateSigningKey(privateKey, publicKey);
  const signed = signPublicPrReceipt(build(), privateKey);
  writeFileSync(receiptPath, JSON.stringify(signed));
  assert.equal(await runPublicPrReceiptCommand(["verify", receiptPath, "--format", "json"]), 0);
  signed.decision.summary = "tampered";
  writeFileSync(receiptPath, JSON.stringify(signed));
  assert.equal(await runPublicPrReceiptCommand(["verify", receiptPath]), 1);
});

test("collector uses only read-only api.github.com metadata endpoints and retains no response text", async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport: PublicPrTransport = async (url, headers) => {
    requests.push({ url, headers });
    let body: unknown;
    if (/\/pulls\/42$/.test(url)) body = {
      state: "closed", merged: false, closed_at: "2026-08-25T12:49:32Z", updated_at: "2026-08-25T12:49:32Z",
      base: { sha: BASE }, head: { sha: HEAD }, body: "private-looking prose must not be retained",
    };
    else if (/\/reviews\?/.test(url)) body = [{ state: "APPROVED", submitted_at: "2026-08-25T12:48:54Z", user: { login: "patrick" }, body: "review text" }];
    else if (/\/check-runs\?/.test(url)) body = { check_runs: [{ status: "completed", conclusion: "success", completed_at: "2026-08-25T12:45:00Z", output: { text: "logs" } }] };
    else body = [];
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) };
  };
  const value = await collectPublicPrSnapshot(PR_URL, { transport, token: "not-retained-token" });
  const receipt = build(value);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => new URL(request.url).hostname === "api.github.com"));
  assert.ok(requests.every((request) => request.headers.Authorization === "Bearer not-retained-token"));
  assert.doesNotMatch(JSON.stringify(receipt), /private-looking prose|review text|logs|not-retained-token/);
  assert.deepEqual(receipt.privacy, {
    publicMetadataOnly: true,
    sourceCodeFetched: false,
    sourceCodeRetained: false,
    promptsFetched: false,
    promptsRetained: false,
    transcriptsFetched: false,
    transcriptsRetained: false,
    requestBodiesSent: false,
  });
});

test("secondary GitHub endpoint failures are retained as coverage gaps rather than silently dropped", async () => {
  const transport: PublicPrTransport = async (url) => {
    if (/\/pulls\/42$/.test(url)) return {
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ state: "closed", merged: true, merged_at: "2026-08-25T12:00:00Z", updated_at: "2026-08-25T12:00:00Z", base: { sha: BASE }, head: { sha: HEAD } })),
    };
    if (/\/reviews\?/.test(url)) throw new Error("network down");
    return { status: 403, headers: {}, body: Buffer.from(JSON.stringify({ message: "rate limited" })) };
  };
  const value = await collectPublicPrSnapshot(PR_URL, { transport });
  const receipt = build(value);
  assert.equal(receipt.decision.continuity, "HOLD");
  assert.deepEqual(receipt.evidence.unavailable, [
    "check-runs:http-403",
    "commit-statuses:http-403",
    "reviews:network-error",
  ]);
  assert.ok(receipt.decision.reasonCodes.includes("source-coverage-incomplete"));
});
