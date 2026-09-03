import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import worker, {
  DeploymentAuthorizationLedger,
  DeliveryLedger,
  canonicalDispatch,
  dispatchEnvelope,
  dispatchSignature,
  parseDeploymentProtectionPayload,
  parseMergeGroupPayload,
  parsePullRequestPayload,
  registrationSignature,
  verifyControlAdmissionEnvelope,
  verifyDeploymentAuthorizationEnvelope,
  verifyDeploymentRegistration,
  verifyRegistrationSignature,
  verifyWebhookSignature,
  webhookSignature,
} from "../hosted/public-app/src/index.mjs";
import { buildGuardDeploymentAuthorization } from "../src/guard-deployment-authorization.ts";
import { signGuardControlAdmission, type GuardControlAdmission } from "../src/guard-control-protocol.ts";
import { guardDigest } from "../src/guard-compat.ts";
import type { GuardSigner } from "../src/guard-signing.ts";
import { publicKeyDer, signingKeyId } from "../src/signature.ts";

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

function deploymentPayload() {
  return {
    action: "requested",
    repository: { full_name: repository },
    installation: { id: 23456 },
    environment: "production",
    sha: headSha,
    ref: "main",
    deployment_callback_url: `https://api.github.com/repos/${repository}/actions/runs/78901/deployment_protection_rule`,
  };
}

function guardSigner(): GuardSigner {
  const pair = generateKeyPairSync("ed25519");
  return {
    provider: "local-ed25519",
    keyId: signingKeyId(publicKeyDer(pair.publicKey)),
    publicKey: pair.publicKey,
    sign: (message) => sign(null, message, pair.privateKey),
  };
}

function deploymentAuthorizationFixture() {
  const admissionSigner = guardSigner();
  const deploymentSigner = guardSigner();
  const now = Date.now();
  const issuedAt = new Date(now - 60_000).toISOString();
  const validUntil = new Date(now + 10 * 60_000).toISOString();
  const roleIds = Array.from({ length: 4 }, (_, index) => guardDigest(`hosted-role-${index}`));
  const unsigned: Omit<GuardControlAdmission, "admissionHash"> = {
    schemaVersion: "agent-vigil-control-admission/v1",
    evaluatedAt: new Date(now - 2 * 60_000).toISOString(),
    validUntil: new Date(now + 30 * 60_000).toISOString(),
    decision: "APPROVE",
    artifact: { host: "codex", version: "future-1", executableSha256: guardDigest("hosted-package") },
    environmentSha256: guardDigest("hosted-environment"),
    evidence: {
      current: { challengeHash: guardDigest("hc"), observationHash: guardDigest("ho"), routeReceiptHash: guardDigest("hr") },
      candidate: { challengeHash: guardDigest("nc"), observationHash: guardDigest("no"), routeReceiptHash: guardDigest("nr") },
      routeDecisionHash: guardDigest("hd"),
    },
    trust: {
      challengeSignerKeyId: roleIds[0], observerSignerKeyId: roleIds[1], routeSignerKeyId: roleIds[2],
      environmentSignerKeyId: roleIds[3], admissionSignerKeyId: admissionSigner.keyId,
    },
    reasonCodes: ["EXACT_CONTROL_ADMISSION_PROVEN"],
    limitations: ["Hosted deployment protection fixture."],
  };
  const admission = signGuardControlAdmission(unsigned, admissionSigner);
  const authorization = buildGuardDeploymentAuthorization({
    admissionEnvelope: admission.envelope, admissionPublicKey: admissionSigner.publicKey,
    repository, commitSha: headSha, environment: "production", deploymentSigner, issuedAt, validUntil,
  });
  const publicKeyPem = deploymentSigner.publicKey.export({ format: "pem", type: "spki" }).toString();
  const admissionPublicKeyPem = admissionSigner.publicKey.export({ format: "pem", type: "spki" }).toString();
  return { authorization, admission, publicKeyPem, admissionPublicKeyPem };
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
  const wrongType = new Request("https://app.example/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      "x-github-event": "pull_request",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body,
  });
  assert.equal((await worker.fetch(wrongType, env)).status, 415);
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

test("deployment protection payloads bind the exact repository, commit, environment, and workflow run", () => {
  assert.deepEqual(parseDeploymentProtectionPayload(deploymentPayload(), deliveryId), {
    deliveryId, repository, installationId: "23456", event: "deployment_protection_rule",
    environment: "production", commitSha: headSha, runId: "78901", ref: "main",
  });
  assert.throws(() => parseDeploymentProtectionPayload({ ...deploymentPayload(), environment: "prod\nattack" }, deliveryId), /environment/);
  assert.throws(() => parseDeploymentProtectionPayload({ ...deploymentPayload(), sha: "abc" }, deliveryId), /commit SHA/);
  assert.throws(() => parseDeploymentProtectionPayload({ ...deploymentPayload(), deployment_callback_url: "https://evil.example/callback" }, deliveryId), /callback URL/);
  assert.throws(() => parseDeploymentProtectionPayload({ ...deploymentPayload(), deployment_callback_url: `${deploymentPayload().deployment_callback_url}?redirect=1` }, deliveryId), /callback URL/);
  assert.throws(() => parseDeploymentProtectionPayload({ ...deploymentPayload(), deployment_callback_url: deploymentPayload().deployment_callback_url.replace("api.github.com", "api.github.com:444") }, deliveryId), /callback URL/);
  assert.throws(() => parseDeploymentProtectionPayload({ ...deploymentPayload(), deployment_callback_url: deploymentPayload().deployment_callback_url.replace("/repos/", "/repos%2f") }, deliveryId), /callback URL/);
  assert.throws(() => parseDeploymentProtectionPayload({ ...deploymentPayload(), action: "completed" }, deliveryId), /not requested/);
});

test("the Worker verifies the signed deployment authorization before storing it", async () => {
  const fixture = deploymentAuthorizationFixture();
  const checked = await verifyDeploymentAuthorizationEnvelope(
    fixture.authorization.envelope, fixture.publicKeyPem, new Date().toISOString(),
  );
  assert.equal(checked.authorizationHash, fixture.authorization.authorization.authorizationHash);
  const checkedAdmission = await verifyControlAdmissionEnvelope(
    fixture.admission.envelope, fixture.admissionPublicKeyPem, new Date().toISOString(),
  );
  assert.equal(checkedAdmission.payload.admissionHash, fixture.admission.admission.admissionHash);
  const registration = {
    schemaVersion: "agent-vigil-deployment-registration/v1",
    authorization: fixture.authorization.envelope,
    admission: fixture.admission.envelope,
  };
  assert.equal((await verifyDeploymentRegistration(
    registration, fixture.publicKeyPem, fixture.admissionPublicKeyPem,
  )).authorizationHash, fixture.authorization.authorization.authorizationHash);

  const tampered = structuredClone(fixture.authorization.envelope);
  const payload = JSON.parse(Buffer.from(tampered.payload, "base64").toString("utf8"));
  payload.repository = "attacker/repository";
  tampered.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  await assert.rejects(() => verifyDeploymentAuthorizationEnvelope(tampered, fixture.publicKeyPem), /signature is invalid/);

  let registered: any;
  const env = {
    DEPLOYMENT_PUBLIC_KEY_PEM: fixture.publicKeyPem,
    ADMISSION_PUBLIC_KEY_PEM: fixture.admissionPublicKeyPem,
    REGISTRATION_SECRET: `${secret}-registration`,
    DEPLOYMENT_AUTHORIZATIONS: {
      idFromName(value: string) { return value; },
      get(id: string) {
        return { async fetch(_url: string, init: RequestInit) {
          registered = { id, body: JSON.parse(String(init.body)) };
          return new Response(JSON.stringify({ status: "registered" }), { status: 201 });
        } };
      },
    },
  };
  const registrationBody = new TextEncoder().encode(JSON.stringify(registration));
  const transportSignature = await registrationSignature(env.REGISTRATION_SECRET, registrationBody);
  assert.equal(await verifyRegistrationSignature(env.REGISTRATION_SECRET, registrationBody, transportSignature), true);
  const response = await worker.fetch(new Request("https://app.example/deployment/authorizations", {
    method: "POST", headers: {
      "content-type": "application/json",
      "x-agent-vigil-registration-signature": transportSignature,
    },
    body: registrationBody,
  }), env);
  assert.equal(response.status, 201);
  assert.equal(registered.id, `${repository}\n${headSha}\nproduction`);
  assert.equal(registered.body.operation, "register");

  const forgedRegistration = { ...registration, authorization: tampered };
  const forgedBody = new TextEncoder().encode(JSON.stringify(forgedRegistration));
  const forgedResponse = await worker.fetch(new Request("https://app.example/deployment/authorizations", {
    method: "POST", headers: {
      "content-type": "application/json",
      "x-agent-vigil-registration-signature": await registrationSignature(env.REGISTRATION_SECRET, forgedBody),
    }, body: forgedBody,
  }), env);
  assert.equal(forgedResponse.status, 400);

  const unauthenticated = await worker.fetch(new Request("https://app.example/deployment/authorizations", {
    method: "POST", headers: { "content-type": "application/json" }, body: registrationBody,
  }), env);
  assert.equal(unauthenticated.status, 401);

  const wrongContentType = await worker.fetch(new Request("https://app.example/deployment/authorizations", {
    method: "POST", headers: {
      "content-type": "text/plain",
      "x-agent-vigil-registration-signature": transportSignature,
    }, body: registrationBody,
  }), env);
  assert.equal(wrongContentType.status, 415);

  assert.notEqual(
    await registrationSignature(env.REGISTRATION_SECRET, registrationBody),
    await webhookSignature(env.REGISTRATION_SECRET, registrationBody),
    "registration and webhook HMACs must be domain separated",
  );

  const wrongAdmission = structuredClone(registration);
  const admissionPayload = JSON.parse(Buffer.from(wrongAdmission.admission.payload, "base64").toString("utf8"));
  admissionPayload.artifact.version = "substituted";
  wrongAdmission.admission.payload = Buffer.from(JSON.stringify(admissionPayload)).toString("base64");
  const wrongAdmissionBody = new TextEncoder().encode(JSON.stringify(wrongAdmission));
  const wrongAdmissionResponse = await worker.fetch(new Request("https://app.example/deployment/authorizations", {
    method: "POST", headers: {
      "content-type": "application/json",
      "x-agent-vigil-registration-signature": await registrationSignature(env.REGISTRATION_SECRET, wrongAdmissionBody),
    }, body: wrongAdmissionBody,
  }), env);
  assert.equal(wrongAdmissionResponse.status, 400);
});

test("signed GitHub deployment webhooks reach the exact deployment ledger identity", async () => {
  const body = new TextEncoder().encode(JSON.stringify(deploymentPayload()));
  const signature = await webhookSignature(secret, body);
  let received: any;
  const env = {
    WEBHOOK_SECRET: secret,
    GITHUB_APP_ID: "1001",
    GITHUB_APP_PRIVATE_KEY: "unused-before-ledger",
    DEPLOYMENT_PUBLIC_KEY_PEM: "pinned-before-registration",
    DEPLOYMENT_AUTHORIZATIONS: {
      idFromName(value: string) { return value; },
      get(id: string) { return { async fetch(_url: string, init: RequestInit) {
        received = { id, body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ state: "rejected" }), { status: 200 });
      } }; },
    },
  };
  const response = await worker.fetch(new Request("https://app.example/github/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "deployment_protection_rule", "x-github-delivery": deliveryId, "x-hub-signature-256": signature },
    body,
  }), env);
  assert.equal(response.status, 200);
  assert.equal(received.id, `${repository}\n${headSha}\nproduction`);
  assert.equal(received.body.operation, "decide");
  assert.equal(received.body.event.runId, "78901");
});

test("deployment ledger approves only a current exact authorization and reports the decision once", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fixture = deploymentAuthorizationFixture();
  const calls: Array<{ url: string; body?: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: `token-${"x".repeat(24)}` }), { status: 201 });
    if (url.endsWith("/deployment_protection_rule")) return new Response(JSON.stringify({}), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const storage = new Map<string, any>();
    const alarms: number[] = [];
    const ledger = new DeploymentAuthorizationLedger({ storage: {
      async get(key: string) { return storage.get(key); },
      async put(key: string, value: any) { storage.set(key, value); },
      async setAlarm(value: number) { alarms.push(value); },
      async deleteAll() { storage.clear(); },
    } }, { GITHUB_APP_ID: "1001", GITHUB_APP_PRIVATE_KEY: pem });
    const register = await ledger.fetch(new Request("https://ledger/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "register", authorization: fixture.authorization.authorization }),
    }));
    assert.equal(register.status, 201);
    assert.deepEqual(alarms, [Date.parse(fixture.authorization.authorization.validUntil) + 24 * 60 * 60 * 1000]);
    const stale = await ledger.fetch(new Request("https://ledger/", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "register", authorization: {
        ...fixture.authorization.authorization,
        authorizationHash: guardDigest("stale-authorization"),
        issuedAt: new Date(Date.parse(fixture.authorization.authorization.issuedAt) - 1).toISOString(),
      } }),
    }));
    assert.equal(stale.status, 409);
    const event = parseDeploymentProtectionPayload(deploymentPayload(), deliveryId);
    const decide = () => ledger.fetch(new Request("https://ledger/", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "decide", event }),
    }));
    const [first, concurrent] = await Promise.all([decide(), decide()]);
    assert.equal((await first.json() as any).state, "approved");
    assert.equal((await concurrent.json() as any).state, "approved");
    assert.deepEqual(calls.find((call) => call.url.endsWith("/deployment_protection_rule"))?.body, {
      environment_name: "production", state: "approved",
      comment: `Agent Vigil approved authorization ${fixture.authorization.authorization.authorizationHash} for this exact repository, commit, and environment. The deployment job must still verify the admitted artifact bytes.`,
    });
    await decide();
    assert.equal(calls.filter((call) => call.url.endsWith("/deployment_protection_rule")).length, 1);
    await ledger.alarm();
    assert.equal(storage.size, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("missing authorization rejects deployment and callback failure is never recorded as a decision", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const event = parseDeploymentProtectionPayload(deploymentPayload(), deliveryId);
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, any>();
  const state = { storage: {
    async get(key: string) { return storage.get(key); },
    async put(key: string, value: any) { storage.set(key, value); },
  } };
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: `token-${"x".repeat(24)}` }), { status: 201 });
      if (url.endsWith("/deployment_protection_rule")) return new Response(JSON.stringify({}), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const rejected = await new DeploymentAuthorizationLedger(state, { GITHUB_APP_ID: "1001", GITHUB_APP_PRIVATE_KEY: pem })
      .fetch(new Request("https://ledger/", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "decide", event }) }));
    assert.equal((await rejected.json() as any).state, "rejected");

    storage.clear();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return new Response(JSON.stringify({ token: `token-${"x".repeat(24)}` }), { status: 201 });
      if (url.endsWith("/deployment_protection_rule")) return new Response(JSON.stringify({ message: "unavailable" }), { status: 503 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    await assert.rejects(() => new DeploymentAuthorizationLedger(state, { GITHUB_APP_ID: "1001", GITHUB_APP_PRIVATE_KEY: pem })
      .fetch(new Request("https://ledger/", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "decide", event }) })), /GitHub API 503/);
    assert.equal(storage.has(`decision:${deliveryId}`), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("public App manifest and control workflow keep customer setup to one App installation", () => {
  const manifest = JSON.parse(readFileSync("hosted/public-app/github-app-manifest.example.json", "utf8"));
  assert.equal(manifest.public, true);
  assert.deepEqual(manifest.default_events.sort(), ["deployment_protection_rule", "merge_group", "pull_request"]);
  assert.equal(manifest.default_permissions.actions, "read");
  assert.equal(manifest.default_permissions.checks, "write");
  assert.equal(manifest.default_permissions.merge_queues, "read");
  assert.equal(manifest.default_permissions.deployments, "write");
  assert.equal(manifest.default_permissions.contents, "read");

  const workflow = readFileSync("hosted/public-app/control-workflow.yml", "utf8");
  assert.match(workflow, /^\s{2}workflow_dispatch:/m);
  const inputBlock = workflow.match(/^\s{4}inputs:\n([\s\S]*?)^\s{0,2}permissions:/m)?.[1] ?? "";
  assert.deepEqual([...inputBlock.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]), ["envelope", "dispatchSignature"]);
  assert.doesNotMatch(workflow, /^\s{2}(?:pull_request|merge_group):/m);
  assert.match(workflow, /agent-vigil-public-app-v1/);
  assert.match(workflow, /JSON\.parse\(Buffer\.from\(envelope, "base64url"\)/);
  assert.match(workflow, /Object\.keys\(value\)\.sort\(\)/);
  assert.match(workflow, /uses: sulmusic2-star\/agent-vigil@[0-9a-f]{40}/);
  assert.match(workflow, /mode: merge-group/);
  assert.match(workflow, /merge-group-event: \$\{\{ steps\.change-event\.outputs\.path \}\}/);
  assert.match(workflow, /Materialize the authenticated exact-change envelope outside the checkout/);
  assert.doesNotMatch(workflow, /path: candidate|uses: \.\/control/);
  assert.match(workflow, /candidate-setup-cmd: npm ci --ignore-scripts/);
  assert.match(workflow, /PASS.*FAIL.*NOT CHECKED/s);
  assert.doesNotMatch(workflow, /REPLACE_WITH_OWNER|customer.*private.key/i);
});
