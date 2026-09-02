import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canonicalDispatch,
  default as worker,
  dispatchSignature,
  githubPrivateKeyPkcs8Bytes,
  parseMergeGroupPayload,
  verifyWebhookSignature,
  webhookSignature,
} from "../hosted/merge-queue-dispatcher/src/index.mjs";

const deliveryId = "550e8400-e29b-41d4-a716-446655440000";
const repository = "sulmusic2-star/agent-vigil";
const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);
const baseRef = "refs/heads/main";
const headRef = "refs/heads/gh-readonly-queue/main/pr-145-deadbeef";
const secret = "a-test-secret-with-more-than-thirty-two-characters";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "checks_requested",
    repository: { full_name: repository },
    installation: { id: 12345 },
    merge_group: { base_sha: baseSha, head_sha: headSha, base_ref: baseRef, head_ref: headRef },
    ...overrides,
  };
}

test("merge-queue dispatcher accepts only the configured queue identity", () => {
  assert.deepEqual(parseMergeGroupPayload(payload(), deliveryId, repository, baseRef), {
    deliveryId,
    repository,
    baseSha,
    headSha,
    baseRef,
    headRef,
    installationId: "12345",
  });

  assert.throws(() => parseMergeGroupPayload(payload({ action: "destroy" }), deliveryId, repository, baseRef), /checks_requested/);
  assert.throws(() => parseMergeGroupPayload(payload({ repository: { full_name: "attacker/repo" } }), deliveryId, repository, baseRef), /not allowed/);
  assert.throws(() => parseMergeGroupPayload(payload({ merge_group: { base_sha: baseSha, head_sha: headSha, base_ref: baseRef, head_ref: "refs/heads/main" } }), deliveryId, repository, baseRef), /head ref/);
  assert.throws(() => parseMergeGroupPayload(payload({ installation: { id: -1 } }), deliveryId, repository, baseRef), /installation ID/);
  assert.throws(() => parseMergeGroupPayload(payload(), "not-a-delivery", repository, baseRef), /delivery ID/);
});

test("webhook signatures cover the exact raw body", async () => {
  const body = new TextEncoder().encode(JSON.stringify(payload()));
  const signature = await webhookSignature(secret, body);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(await verifyWebhookSignature(secret, body, signature), true);
  assert.equal(await verifyWebhookSignature(secret, new TextEncoder().encode(`${new TextDecoder().decode(body)} `), signature), false);
  assert.equal(await verifyWebhookSignature(secret, body, `sha256=${"0".repeat(64)}`), false);
  assert.equal(await verifyWebhookSignature(secret, body, "not-a-signature"), false);
});

test("dispatch authentication binds every queue identity field", async () => {
  const value = parseMergeGroupPayload(payload(), deliveryId, repository, baseRef);
  const signature = await dispatchSignature(secret, value);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(canonicalDispatch(value).split("\n").length, 7);
  assert.notEqual(await dispatchSignature(secret, { ...value, headSha: "3".repeat(40) }), signature);
  assert.notEqual(await dispatchSignature(secret, { ...value, headRef: `${headRef}-changed` }), signature);
});

test("GitHub's RSA PKCS#1 App keys are normalized to importable PKCS#8", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fromPkcs1 = githubPrivateKeyPkcs8Bytes(pkcs1);
  const fromPkcs8 = githubPrivateKeyPkcs8Bytes(pkcs8);

  for (const normalized of [fromPkcs1, fromPkcs8]) {
    const imported = await webcrypto.subtle.importKey(
      "pkcs8",
      normalized,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      imported,
      new TextEncoder().encode("agent-vigil-queue-key-proof"),
    );
    assert.equal(signature.byteLength, 256);
  }
  assert.throws(
    () => githubPrivateKeyPkcs8Bytes("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAA==\n-----END ENCRYPTED PRIVATE KEY-----"),
    /unencrypted PKCS#8 or RSA PKCS#1/,
  );
});

test("HTTP boundary rejects unsigned events before the delivery ledger", async () => {
  const health = await worker.fetch(new Request("https://dispatcher.example/health"), {});
  assert.equal(health.status, 200);
  const body = JSON.stringify(payload());
  let ledgerCalls = 0;
  const env = {
    WEBHOOK_SECRET: secret,
    DISPATCH_SECRET: `${secret}-dispatch`,
    GITHUB_APP_ID: "4742339",
    GITHUB_APP_PRIVATE_KEY: "placeholder-not-used-before-the-ledger",
    ALLOWED_REPOSITORY: repository,
    ALLOWED_BASE_REF: baseRef,
    WORKFLOW_FILE: "agent-vigil-merge-group.yml",
    TRUSTED_REF: "main",
    DELIVERY_LEDGER: {
      idFromName(value: string) { return value; },
      get() {
        return {
          async fetch() {
            ledgerCalls += 1;
            return new Response(JSON.stringify({ status: "dispatched" }), { status: 202 });
          },
        };
      },
    },
  };

  const unsigned = await worker.fetch(new Request("https://dispatcher.example/github/merge-group", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "merge_group",
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
    },
    body,
  }), env);
  assert.equal(unsigned.status, 401);
  assert.equal(ledgerCalls, 0);

  const signature = await webhookSignature(secret, new TextEncoder().encode(body));
  const accepted = await worker.fetch(new Request("https://dispatcher.example/github/merge-group", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "merge_group",
      "x-hub-signature-256": signature,
    },
    body,
  }), env);
  assert.equal(accepted.status, 202);
  assert.equal(ledgerCalls, 1);
});

test("trusted merge-queue workflow keeps secrets out of candidate execution", () => {
  const workflow = readFileSync(new URL("../.github/workflows/agent-vigil-merge-group.yml", import.meta.url), "utf8");
  assert.match(workflow, /^on:\n(?:  #.*\n)+  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s{2}merge_group:/m);
  assert.match(workflow, /environment: agent-vigil-gate/);
  assert.match(workflow, /EXPECTED_ACTOR: \$\{\{ vars\.AGENT_VIGIL_GATE_ACTOR \|\| 'agent-vigil-gate\[bot\]' \}\}/);
  assert.match(workflow, /DISPATCH_SECRET: \$\{\{ secrets\.AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET \}\}/);
  assert.match(workflow, /uses: sulmusic2-star\/agent-vigil@a82db69c866826e41dcac5fcaaa9c40bbede7f84/);
  assert.match(workflow, /mode: merge-group/);
  assert.match(workflow, /merge-group-event: \$\{\{ steps\.queue-event\.outputs\.path \}\}/);
  assert.match(workflow, /Materialize the authenticated queue envelope outside the checkout/);
  assert.match(workflow, /writeFileSync\(eventPath,[\s\S]*flag: "wx", mode: 0o600/);
  assert.match(workflow, /name: "Agent Vigil governed evidence"/);
  assert.match(workflow, /repositories: \$\{\{ github\.event\.repository\.name \}\}/);
  assert.doesNotMatch(workflow, /repositories: agent-vigil/);
  assert.match(workflow, /github\.event\.inputs\.head_sha/);
  assert.match(workflow, /gh-readonly-queue/);

  const evidence = workflow.slice(workflow.indexOf("  evidence:"), workflow.indexOf("  governed-queue-check:"));
  assert.doesNotMatch(evidence, /secrets\.|GITHUB_APP_PRIVATE_KEY|DISPATCH_SECRET/);
});
