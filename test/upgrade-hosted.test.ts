import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  publishCompatibilityRecord,
  registerLifecycleInstallation,
  uploadLifecycleEvent,
  validateLifecycleCredential,
  validateLifecycleEventForUpload,
  type LifecycleCredential,
} from "../src/upgrade/hosted.ts";
import type { PublicCompatibilityEntry } from "../src/upgrade/receipt.ts";

function jsonResponse(value: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...Object.fromEntries(new Headers(extra)) },
  });
}

function credential(): LifecycleCredential {
  return {
    schemaVersion: "agent-vigil-lifecycle-installation-credential/v1",
    installationId: randomUUID(),
    installationSecret: randomBytes(32).toString("base64url"),
    channel: "apm",
    external: true,
    demo: false,
    registeredAt: new Date().toISOString(),
    measurementClass: "UNVERIFIED_TELEMETRY",
    gateEligible: false,
    sybilSusceptible: true,
  };
}

function lifecycleEvent(value: LifecycleCredential): Record<string, unknown> {
  return {
    schema_version: "agent-vigil-lifecycle-event/v1",
    event_id: randomUUID(),
    event_name: "preflight_completed_v1",
    event_day: new Date().toISOString().slice(0, 10),
    release_version: "0.15.0",
    channel: value.channel,
    external: value.external,
    demo: value.demo,
    entity_scope: "INDIVIDUAL_INSTALLATION",
    installation_pseudo_id: value.installationId,
    opaque_pair_token: `sha256:${"a".repeat(64)}`,
    verdict: "SAFE",
    shared_policy: false,
    required_gate: false,
    public_contribution: false,
    organization_context: false,
  };
}

test("hosted proof publishing requires HTTPS, explicit consent, no redirect, and an exact matching receipt", async () => {
  const record = {
    schemaVersion: "agent-vigil-compatibility-entry/v1",
    entryHash: `sha256:${"b".repeat(64)}`,
  } as PublicCompatibilityEntry;
  let observed = false;
  const receipt = await publishCompatibilityRecord({
    endpoint: "https://proof.example",
    record,
    fetchImpl: async (request, init) => {
      observed = true;
      assert.equal(String(request), "https://proof.example/v1/entries");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("X-Agent-Vigil-Public-Consent"), "v1");
      assert.equal(init?.body, JSON.stringify(record));
      return jsonResponse({
        schemaVersion: "agent-vigil-proof-ingestion/v1",
        recordType: "ENTRY",
        recordHash: record.entryHash,
        created: true,
        receivedAt: new Date().toISOString(),
        location: `/api/v1/entries/${record.entryHash}`,
      }, 201);
    },
  });
  assert.equal(observed, true);
  assert.deepEqual(receipt, { recordType: "ENTRY", recordHash: record.entryHash, created: true });
  await assert.rejects(() => publishCompatibilityRecord({
    endpoint: "http://proof.example",
    record,
    fetchImpl: async () => { throw new Error("must not run"); },
  }), /HTTPS/);
});

test("lifecycle registration returns only an explicitly unverified, Sybil-susceptible installation credential", async () => {
  const value = credential();
  const registered = await registerLifecycleInstallation({
    endpoint: "https://proof.example/",
    requestedChannel: "apm",
    runClass: "EXTERNAL_STANDARD",
    idempotencyKey: randomUUID(),
    fetchImpl: async (request, init) => {
      assert.equal(String(request), "https://proof.example/v1/lifecycle/installations");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-Agent-Vigil-Lifecycle-Consent"), "v1");
      assert.match(headers.get("X-Agent-Vigil-Registration-Idempotency-Key") ?? "", /^[0-9a-f-]{36}$/);
      return jsonResponse({ ...value, created: true }, 201);
    },
  });
  assert.deepEqual(registered, value);
  assert.deepEqual(validateLifecycleCredential(registered), registered);
  assert.throws(() => validateLifecycleCredential({ ...registered, gateEligible: true }), /measurement boundaries/);
});

test("lifecycle upload HMAC binds the exact event and emits no gate-eligible claim", async () => {
  const value = credential();
  const event = lifecycleEvent(value);
  const timestamp = new Date().toISOString();
  const receipt = await uploadLifecycleEvent({
    endpoint: "https://proof.example",
    credential: value,
    event,
    timestamp,
    fetchImpl: async (request, init) => {
      assert.equal(String(request), "https://proof.example/v1/lifecycle");
      const body = String(init?.body);
      const bodyHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
      const eventId = event.event_id as string;
      const message = `agent-vigil-lifecycle-request/v1\nPOST\n/v1/lifecycle\n${eventId}\n${timestamp}\n${bodyHash}`;
      const expected = createHmac("sha256", Buffer.from(value.installationSecret, "base64url")).update(message).digest("base64url");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-Agent-Vigil-Signature"), expected);
      assert.equal(headers.get("X-Agent-Vigil-Request-Id"), eventId);
      assert.equal(headers.get("X-Agent-Vigil-Installation"), value.installationId);
      return jsonResponse({
        schemaVersion: "agent-vigil-lifecycle-ingestion-receipt/v1",
        eventId,
        created: true,
        receivedAt: new Date().toISOString(),
        ingestionSequence: 7,
        entityScope: "INDIVIDUAL_INSTALLATION",
        measurementClass: "UNVERIFIED_TELEMETRY",
        gateEligible: false,
        sybilSusceptible: true,
      }, 202);
    },
  });
  assert.deepEqual(receipt, { eventId: event.event_id, ingestionSequence: 7, created: true });
});

test("client privacy canaries and forged organization or installation identities fail before fetch", async () => {
  const value = credential();
  const base = lifecycleEvent(value);
  for (const privateField of [
    { source: "private" }, { prompt: "private" }, { transcript: "private" }, { path: "/private" },
    { argv: ["--secret"] }, { env: { TOKEN: "secret" } }, { repository_name: "private" }, { full_receipt: {} },
  ]) {
    assert.throws(() => validateLifecycleEventForUpload({ ...base, ...privateField }, value), /missing or unknown fields/);
  }
  assert.throws(() => validateLifecycleEventForUpload({
    ...base,
    entity_scope: "ORGANIZATION",
    organization_context: true,
    organization_pseudo_id: "forged-organization-1234",
  }, value), /authenticated tenant adapter/);
  assert.throws(() => validateLifecycleEventForUpload({ ...base, installation_pseudo_id: randomUUID() }, value), /does not match/);
  let fetched = false;
  await assert.rejects(() => uploadLifecycleEvent({
    endpoint: "https://proof.example",
    credential: value,
    event: { ...base, source: "do-not-send" },
    fetchImpl: async () => { fetched = true; return jsonResponse({}); },
  }), /missing or unknown fields/);
  assert.equal(fetched, false);
});

test("chunked oversized hosted responses are rejected without exposing the body", async () => {
  const record = {
    schemaVersion: "agent-vigil-compatibility-entry/v1",
    entryHash: `sha256:${"c".repeat(64)}`,
  } as PublicCompatibilityEntry;
  await assert.rejects(() => publishCompatibilityRecord({
    endpoint: "https://proof.example",
    record,
    fetchImpl: async () => new Response("x".repeat(40 * 1024), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  }), /size limit/);
});
