import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import worker, {
  DeliveryLedger,
  canonicalDispatch,
  dispatchEnvelope,
  dispatchSignature,
  parseMergeGroupPayload,
  parsePullRequestPayload,
  verifyWebhookSignature,
  webhookSignature,
} from "../hosted/public-app/src/index.mjs";

const deliveryId = "550e8400-e29b-41d4-a716-446655440000";
const repository = "outside-owner/outside-repository";
const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);
const secret = "a-public-app-test-secret-with-at-least-thirty-two-characters";

function pullPayload(action = "synchronize") {
  return {
    action,
    number: 17,
    repository: { full_name: repository },
    installation: { id: 23456 },
    pull_request: {
      base: { sha: baseSha, ref: "main" },
      head: { sha: headSha, ref: "feature" },
    },
  };
}

function queuePayload() {
  return {
    action: "checks_requested",
    repository: { full_name: repository },
    installation: { id: 23456 },
    merge_group: {
      base_sha: baseSha,
      head_sha: headSha,
      base_ref: "refs/heads/main",
      head_ref: "refs/heads/gh-readonly-queue/main/pr-17-deadbeef",
    },
  };
}

test("public App binds pull-request and merge-queue identities without a repository allowlist", () => {
  assert.deepEqual(parsePullRequestPayload(pullPayload(), deliveryId), {
    deliveryId,
    repository,
    installationId: "23456",
    event: "pull_request",
    number: "17",
    baseSha,
    headSha,
    baseRef: "main",
    headRef: "",
  });
  assert.equal(parseMergeGroupPayload(queuePayload(), deliveryId).event, "merge_group");
  assert.throws(() => parsePullRequestPayload(pullPayload("closed"), deliveryId), /verification trigger/);
  assert.throws(() => parsePullRequestPayload({ ...pullPayload(), installation: undefined }, deliveryId), /installation ID/);
  assert.throws(() => parseMergeGroupPayload({ ...queuePayload(), merge_group: { ...queuePayload().merge_group, head_ref: "refs/heads/main" } }, deliveryId), /head ref/);
});

test("public App reruns when the pull-request base changes and accepts valid punctuation in branch names", () => {
  const editedBase = pullPayload("edited");
  editedBase.changes = { base: { ref: { from: "main" } } };
  editedBase.pull_request.base.ref = "release@v2+candidate";
  assert.equal(parsePullRequestPayload(editedBase, deliveryId).baseRef, "release@v2+candidate");

  const editedTitle = pullPayload("edited");
  editedTitle.changes = { title: { from: "old title" } };
  assert.throws(() => parsePullRequestPayload(editedTitle, deliveryId), /verification trigger/);

  const invalid = pullPayload();
  invalid.pull_request.base.ref = "release..candidate";
  assert.throws(() => parsePullRequestPayload(invalid, deliveryId), /base ref/);

  const queue = queuePayload();
  queue.merge_group.base_ref = "refs/heads/release@v2+candidate";
  queue.merge_group.head_ref = "refs/heads/gh-readonly-queue/release@v2+candidate/pr-17-deadbeef";
  assert.equal(parseMergeGroupPayload(queue, deliveryId).baseRef, queue.merge_group.base_ref);
});

test("public App signatures bind the queued check and every exact-change field", async () => {
  const value = { ...parsePullRequestPayload(pullPayload(), deliveryId), checkRunId: "34567" };
  assert.equal(canonicalDispatch(value).split("\n").length, 11);
  const envelope = dispatchEnvelope(value);
  assert.match(envelope, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(envelope, "base64url").toString("utf8")), {
    schema: "agent-vigil-public-app-v1",
    ...value,
  });
  const signature = await dispatchSignature(secret, value);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.notEqual(await dispatchSignature(secret, { ...value, checkRunId: "34568" }), signature);
  assert.notEqual(await dispatchSignature(secret, { ...value, headSha: "3".repeat(40) }), signature);
});

test("public App verifies the exact raw webhook body before replay storage", async () => {
  const body = new TextEncoder().encode(JSON.stringify(pullPayload()));
  const signature = await webhookSignature(secret, body);
  assert.equal(await verifyWebhookSignature(secret, body, signature), true);
  assert.equal(await verifyWebhookSignature(secret, new TextEncoder().encode(`${new TextDecoder().decode(body)} `), signature), false);

  let ledgerCalls = 0;
  const env = {
    WEBHOOK_SECRET: secret,
    DISPATCH_SECRET: `${secret}-dispatch`,
    GITHUB_APP_ID: "1001",
    GITHUB_APP_PRIVATE_KEY: "unused-before-ledger",
    CONTROL_APP_ID: "1002",
    CONTROL_APP_PRIVATE_KEY: "unused-before-ledger",
    CONTROL_INSTALLATION_ID: "1003",
    CONTROL_REPOSITORY: "sulmusic2-star/agent-vigil",
    CONTROL_WORKFLOW: "public-app-gate.yml",
    CONTROL_REF: "main",
    DELIVERY_LEDGER: {
      idFromName(value: string) { return value; },
      get() {
        return { async fetch() { ledgerCalls += 1; return new Response(JSON.stringify({ status: "dispatched" }), { status: 202 }); } };
      },
    },
  };
  const request = (providedSignature: string) => new Request("https://app.example/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": providedSignature,
    },
    body,
  });
  assert.equal((await worker.fetch(request(`sha256=${"0".repeat(64)}`), env)).status, 401);
  assert.equal(ledgerCalls, 0);
  assert.equal((await worker.fetch(request(signature), env)).status, 202);
  assert.equal(ledgerCalls, 1);
});

test("delivery ledger creates one queued App check and dispatches the internal control workflow", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const calls: Array<{ url: string; body?: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: `token-${calls.length}-${"x".repeat(24)}` }), { status: 201 });
    if (url.endsWith("/check-runs")) return new Response(JSON.stringify({ id: 34567 }), { status: 201 });
    if (url.includes("/dispatches")) return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    let stored: any;
    const ledger = new DeliveryLedger({ storage: {
      async get() { return stored; },
      async put(_key: string, value: any) { stored = value; },
    } }, {
      GITHUB_APP_ID: "1001",
      GITHUB_APP_PRIVATE_KEY: pem,
      CONTROL_APP_ID: "1002",
      CONTROL_APP_PRIVATE_KEY: pem,
      CONTROL_INSTALLATION_ID: "1003",
      CONTROL_REPOSITORY: "sulmusic2-star/agent-vigil",
      CONTROL_WORKFLOW: "public-app-gate.yml",
      CONTROL_REF: "main",
      DISPATCH_SECRET: secret,
    });
    const value = parsePullRequestPayload(pullPayload(), deliveryId);
    const response = await ledger.fetch(new Request("https://ledger.internal/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    }));
    assert.equal(response.status, 202);
    assert.equal(calls.filter((call) => call.url.endsWith("/check-runs")).length, 1);
    assert.equal(calls.filter((call) => call.url.includes("/dispatches")).length, 1);
    const dispatch = calls.find((call) => call.url.includes("/dispatches"))?.body;
    assert.equal(dispatch.ref, "main");
    assert.deepEqual(Object.keys(dispatch.inputs).sort(), ["dispatchSignature", "envelope"]);
    const envelope = JSON.parse(Buffer.from(dispatch.inputs.envelope, "base64url").toString("utf8"));
    assert.equal(envelope.repository, repository);
    assert.equal(envelope.checkRunId, "34567");
    assert.match(dispatch.inputs.dispatchSignature, /^sha256=[0-9a-f]{64}$/);
    const tokenBodies = calls.filter((call) => call.url.includes("/access_tokens")).map((call) => call.body);
    assert.deepEqual(tokenBodies[0].permissions, { checks: "write", contents: "read", pull_requests: "read" });
    assert.deepEqual(tokenBodies[1].permissions, { actions: "write" });

    const replay = await ledger.fetch(new Request("https://ledger.internal/dispatch", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    }));
    assert.equal(replay.status, 202);
    assert.equal(calls.filter((call) => call.url.endsWith("/check-runs")).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("a control dispatch failure completes the queued check as blocking NOT CHECKED", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const calls: Array<{ url: string; method?: string; body?: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method, body });
    if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: `token-${calls.length}-${"x".repeat(24)}` }), { status: 201 });
    if (url.endsWith("/check-runs")) return new Response(JSON.stringify({ id: 34567 }), { status: 201 });
    if (url.includes("/dispatches")) return new Response(JSON.stringify({ message: "dispatch unavailable" }), { status: 503 });
    if (url.endsWith("/check-runs/34567") && init?.method === "PATCH") return new Response(JSON.stringify({ id: 34567 }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    let stored: any;
    const ledger = new DeliveryLedger({ storage: {
      async get() { return stored; },
      async put(_key: string, value: any) { stored = value; },
    } }, {
      GITHUB_APP_ID: "1001", GITHUB_APP_PRIVATE_KEY: pem,
      CONTROL_APP_ID: "1002", CONTROL_APP_PRIVATE_KEY: pem,
      CONTROL_INSTALLATION_ID: "1003", CONTROL_REPOSITORY: "sulmusic2-star/agent-vigil",
      CONTROL_WORKFLOW: "public-app-gate.yml", CONTROL_REF: "main", DISPATCH_SECRET: secret,
    });
    await assert.rejects(() => ledger.fetch(new Request("https://ledger.internal/dispatch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(parsePullRequestPayload(pullPayload(), deliveryId)),
    })), /GitHub API 503/);
    const completion = calls.find((call) => call.url.endsWith("/check-runs/34567"));
    assert.equal(completion?.body?.conclusion, "failure");
    assert.equal(completion?.body?.output?.title, "NOT CHECKED");
    assert.equal(stored.status, "failed");
  } finally { globalThis.fetch = originalFetch; }
});

test("public App manifest requests only the customer permissions its webhooks and checks need", () => {
  const manifest = JSON.parse(readFileSync("hosted/public-app/github-app-manifest.example.json", "utf8"));
  assert.equal(manifest.public, true);
  assert.deepEqual(manifest.default_events.sort(), ["merge_group", "pull_request"]);
  assert.equal(manifest.default_permissions.checks, "write");
  assert.equal(manifest.default_permissions.merge_queues, "read");
  assert.equal(manifest.default_permissions.contents, "read");
  assert.equal(manifest.default_permissions.pull_requests, "read");
  assert.equal(manifest.default_permissions.actions, undefined);
});
