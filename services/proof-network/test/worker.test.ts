import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { canonical, sha256, signLifecycleRequest } from "../src/contracts";
import {
  FIRST_100_ACQUISITION_SCHEMA,
  FIRST_100_REGISTRATION_ID,
  exportFirst100Bundle,
  first100AccessGrantMessage,
  first100AdapterAttestationMessage,
  registerFirst100Pair,
  type First100AccessGrantRequest,
  type First100Proposal,
} from "../src/frequency";
import { publisherRequestHeaders, signedEntry, signedResolution, signingFixture, type SigningFixture } from "./fixtures";

const ADMIN_TOKEN = "local-test-admin-token-32-bytes-minimum-only";
let signer: SigningFixture;
let frequencyAdapter: SigningFixture;
const FREQUENCY_ADAPTER_VERSION = "test-adapter-1.0.0";

type LifecycleCredential = {
  installationId: string;
  installationSecret: string;
  channel: string;
  external: boolean;
  demo: boolean;
  measurementClass: "UNVERIFIED_TELEMETRY";
  gateEligible: false;
  sybilSusceptible: true;
};

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.method === "POST" && !headers.has("CF-Connecting-IP")) {
    headers.set("CF-Connecting-IP", `write-test-${crypto.randomUUID()}`);
  }
  return exports.default.fetch(`https://proof.example${path}`, { ...init, headers });
}

async function registerSigner(value: SigningFixture): Promise<void> {
  const response = await workerFetch("/v1/admin/publishers/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ eventId: crypto.randomUUID(), keyId: value.keyId, publicKey: value.publicKeyBase64 }),
  });
  expect(response.status).toBe(201);
}

async function registerCurrentSigner(): Promise<void> {
  await registerSigner(signer);
}

async function registerFrequencyAdapter(value: SigningFixture, version = FREQUENCY_ADAPTER_VERSION): Promise<void> {
  const response = await adminPost("/v1/admin/frequency/adapters/register", {
    eventId: crypto.randomUUID(),
    keyId: value.keyId,
    publicKey: value.publicKeyBase64,
    version,
  });
  expect(response.status).toBe(201);
}

function acquisitionFacts(index = 1): First100Proposal["acquisition"] {
  return {
    channel: "apm",
    external: true,
    optedIn: true,
    runClass: "EXTERNAL_STANDARD",
    identityClass: "IMMUTABLE",
    artifactClass: "SUPPORTED",
    realUpdateIntent: true,
    rawEventSha256: `sha256:${index.toString(16).padStart(64, "e")}`,
    pair: {
      ecosystem: "apm",
      componentIdentity: `public-agent-package-${Math.floor(index / 20)}`,
      currentExactIdentity: `sha256:${index.toString(16).padStart(64, "1")}`,
      candidateExactIdentity: `sha256:${(index + 1_000).toString(16).padStart(64, "2")}`,
    },
  };
}

async function acquisitionProposal(
  publisher: SigningFixture,
  adapter: SigningFixture | null,
  index = 1,
  acquisition: First100Proposal["acquisition"] = acquisitionFacts(index),
): Promise<First100Proposal> {
  const proposal: First100Proposal = {
    schemaVersion: FIRST_100_ACQUISITION_SCHEMA,
    kind: "acquisition",
    registrationId: FIRST_100_REGISTRATION_ID,
    acquisition,
  };
  if (!adapter) return proposal;
  const observedAt = new Date().toISOString();
  const unsigned = {
    schemaVersion: "agent-vigil-frequency-adapter-attestation/v1" as const,
    keyId: adapter.keyId,
    adapterVersion: FREQUENCY_ADAPTER_VERSION,
    eventId: crypto.randomUUID(),
    observedAt,
    artifactState: "UNOPENED" as const,
    signature: "",
  };
  const withUnsigned = { ...proposal, adapterAttestation: unsigned };
  const signature = await crypto.subtle.sign(
    "Ed25519", adapter.privateKey,
    new TextEncoder().encode(first100AdapterAttestationMessage(withUnsigned, publisher.keyId)),
  );
  return { ...proposal, adapterAttestation: { ...unsigned, signature: base64(signature) } };
}

async function adapterAccessRequest(
  publisher: SigningFixture,
  adapter: SigningFixture,
  acquisitionHandle: string,
): Promise<First100AccessGrantRequest> {
  const unsigned: First100AccessGrantRequest = {
    schemaVersion: "agent-vigil-frequency-artifact-access-request/v1",
    registrationId: FIRST_100_REGISTRATION_ID,
    acquisitionHandle,
    adapterKeyId: adapter.keyId,
    eventId: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    signature: "",
  };
  const signature = await crypto.subtle.sign(
    "Ed25519", adapter.privateKey,
    new TextEncoder().encode(first100AccessGrantMessage(unsigned, publisher.keyId)),
  );
  return { ...unsigned, signature: base64(signature) };
}

function base64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function adminPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return workerFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function ingestEntry(entry: Awaited<ReturnType<typeof signedEntry>>): Promise<Response> {
  return workerFetch("/v1/entries", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
    body: JSON.stringify(entry),
  });
}

async function setPublisherStatus(
  keyId: string,
  status: "ACTIVE" | "SUSPENDED" | "REVOKED",
  reasonClass: "COMPROMISED" | "OPERATOR_REQUEST" | "POLICY" | "ABUSE" | "RESTORED",
): Promise<Response> {
  return adminPost("/v1/admin/publishers/status", { eventId: crypto.randomUUID(), keyId, status, reasonClass });
}

async function moderateEntry(
  entryHash: string,
  action: "CORRECT" | "TAKEDOWN" | "REVOKE" | "RESTORE",
  reasonClass: "PRIVACY" | "INVALID_EVIDENCE" | "KEY_COMPROMISE" | "PUBLISHER_REQUEST" | "RESTORED",
  replacementHash?: string,
): Promise<Response> {
  return adminPost("/v1/admin/moderation", {
    eventId: crypto.randomUUID(),
    recordType: "ENTRY",
    recordHash: entryHash,
    action,
    reasonClass,
    ...(replacementHash === undefined ? {} : { replacementHash }),
  });
}

async function registerLifecycleInstallation(
  runClass: "EXTERNAL_STANDARD" | "DEMO" | "INTERNAL" = "EXTERNAL_STANDARD",
  idempotencyKey = crypto.randomUUID(),
): Promise<{ credential: LifecycleCredential; idempotencyKey: string; status: number }> {
  const response = await workerFetch("/v1/lifecycle/installations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Vigil-Lifecycle-Consent": "v1",
      "X-Agent-Vigil-Registration-Idempotency-Key": idempotencyKey,
      "CF-Connecting-IP": "192.0.2.10",
    },
    body: JSON.stringify({
      schemaVersion: "agent-vigil-lifecycle-installation-registration/v1",
      requestedChannel: "apm",
      runClass,
    }),
  });
  return { credential: await response.json<LifecycleCredential>(), idempotencyKey, status: response.status };
}

async function lifecycleHeaders(
  credential: LifecycleCredential,
  body: string,
  eventId: string,
): Promise<Record<string, string>> {
  const timestamp = new Date().toISOString();
  const bodySha256 = await sha256(new TextEncoder().encode(body));
  const message = `agent-vigil-lifecycle-request/v1\nPOST\n/v1/lifecycle\n${eventId}\n${timestamp}\n${bodySha256}`;
  return {
    "Content-Type": "application/json",
    "X-Agent-Vigil-Lifecycle-Consent": "v1",
    "X-Agent-Vigil-Installation": credential.installationId,
    "X-Agent-Vigil-Request-Id": eventId,
    "X-Agent-Vigil-Timestamp": timestamp,
    "X-Agent-Vigil-Signature": await signLifecycleRequest(credential.installationSecret, message),
  };
}

beforeEach(async () => {
  await env.PROOF_DB.batch([
    env.PROOF_DB.prepare("DELETE FROM frequency_evaluations"),
    env.PROOF_DB.prepare("DELETE FROM frequency_artifact_access_grants"),
    env.PROOF_DB.prepare("DELETE FROM frequency_pairs"),
    env.PROOF_DB.prepare("DELETE FROM frequency_stop_events"),
    env.PROOF_DB.prepare("DELETE FROM frequency_adapter_status_events"),
    env.PROOF_DB.prepare("DELETE FROM frequency_adapters"),
    env.PROOF_DB.prepare("DELETE FROM frequency_publisher_checkpoints"),
    env.PROOF_DB.prepare("DELETE FROM lifecycle_events"),
    env.PROOF_DB.prepare("DELETE FROM lifecycle_installation_status_events"),
    env.PROOF_DB.prepare("DELETE FROM lifecycle_installations"),
    env.PROOF_DB.prepare("DELETE FROM moderation_state"),
    env.PROOF_DB.prepare("DELETE FROM moderation_events"),
    env.PROOF_DB.prepare("DELETE FROM compatibility_resolutions"),
    env.PROOF_DB.prepare("DELETE FROM compatibility_entries"),
    env.PROOF_DB.prepare("DELETE FROM publisher_status_events"),
    env.PROOF_DB.prepare("DELETE FROM publishers"),
  ]);
  signer = await signingFixture();
  await registerCurrentSigner();
  frequencyAdapter = await signingFixture();
  await registerFrequencyAdapter(frequencyAdapter);
});

describe("proof-network Worker", () => {
  it("ingests an exact signed entry idempotently and serves search, page, API, and badge", async () => {
    const entry = await signedEntry(signer);
    const first = await workerFetch("/v1/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
      body: JSON.stringify(entry),
    });
    expect(first.status).toBe(201);
    const replay = await workerFetch("/v1/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
      body: JSON.stringify(entry),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json<{ created: boolean }>()).created).toBe(false);

    const api = await workerFetch(`/api/v1/entries/${entry.entryHash}`);
    expect(api.status).toBe(200);
    expect(api.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await api.json<{ entry: { entryHash: string } }>()).entry.entryHash).toBe(entry.entryHash);
    expect((await workerFetch(`/proof/${entry.entryHash}`)).headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect((await workerFetch(`/api/v1/badges/${entry.entryHash}`)).status).toBe(200);
    const search = await workerFetch("/api/v1/search?component=public-agent-package");
    expect((await search.json<{ count: number }>()).count).toBe(1);
    expect(new TextDecoder().decode(await (await workerFetch("/robots.txt")).arrayBuffer())).toContain("/sitemap.xml");
    expect(new TextDecoder().decode(await (await workerFetch("/sitemap.xml")).arrayBuffer())).toContain(`/proof/${entry.entryHash}`);
  });

  it("never serves corrected SAFE evidence as an active direct, search, API, or green badge signal", async () => {
    const original = await signedEntry(signer, { verdict: "SAFE", candidateVersion: "1.1.0-invalid" });
    const replacement = await signedEntry(signer, { verdict: "CHANGED", candidateVersion: "1.1.0-corrected" });
    expect((await ingestEntry(original)).status).toBe(201);
    expect((await ingestEntry(replacement)).status).toBe(201);
    expect((await moderateEntry(original.entryHash, "CORRECT", "INVALID_EVIDENCE", replacement.entryHash)).status).toBe(200);

    const directApi = await workerFetch(`/api/v1/entries/${original.entryHash}`);
    expect(directApi.status).toBe(410);
    expect(await directApi.json()).toMatchObject({ error: { action: "CORRECT", replacementHash: replacement.entryHash } });
    const directPage = await workerFetch(`/proof/${original.entryHash}`);
    expect(directPage.status).toBe(410);
    expect(await directPage.text()).not.toContain(">SAFE<");

    const search = await workerFetch("/api/v1/search?component=public-agent-package");
    const searchBody = await search.json<{ entries: Array<{ entryHash: string }> }>();
    expect(searchBody.entries.map((entry) => entry.entryHash)).not.toContain(original.entryHash);

    const badge = await workerFetch(`/api/v1/badges/${original.entryHash}`);
    expect(badge.status).toBe(200);
    expect(await badge.json()).toMatchObject({ message: "corrected", color: "lightgrey", link: `/proof/${replacement.entryHash}` });
    expect((await workerFetch(`/api/v1/badges/${replacement.entryHash}`)).status).toBe(200);

    expect((await moderateEntry(original.entryHash, "RESTORE", "RESTORED")).status).toBe(200);
    expect((await workerFetch(`/api/v1/entries/${original.entryHash}`)).status).toBe(200);
    expect(await (await workerFetch(`/api/v1/badges/${original.entryHash}`)).json()).toMatchObject({ message: "safe", color: "2ea44f" });
  });

  it("rejects tampering and unregistered publisher keys", async () => {
    const entry = await signedEntry(signer);
    const tampered = { ...entry, component: { ...entry.component, candidateVersion: "tampered" } };
    const tamperedResponse = await workerFetch("/v1/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
      body: JSON.stringify(tampered),
    });
    expect(tamperedResponse.status).toBe(422);

    const other = await signingFixture();
    const unregistered = await signedEntry(other);
    const response = await workerFetch("/v1/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
      body: JSON.stringify(unregistered),
    });
    expect(response.status).toBe(403);
  });

  it("allows only suspended publishers to restore and makes revoked key material terminal", async () => {
    expect((await setPublisherStatus(signer.keyId, "SUSPENDED", "POLICY")).status).toBe(200);
    expect((await ingestEntry(await signedEntry(signer, { candidateVersion: "1.1.0-suspended" }))).status).toBe(403);
    expect((await setPublisherStatus(signer.keyId, "ACTIVE", "RESTORED")).status).toBe(200);
    expect((await ingestEntry(await signedEntry(signer, { candidateVersion: "1.1.0-restored" }))).status).toBe(201);

    expect((await setPublisherStatus(signer.keyId, "REVOKED", "COMPROMISED")).status).toBe(200);
    const restore = await setPublisherStatus(signer.keyId, "ACTIVE", "RESTORED");
    expect(restore.status).toBe(409);
    expect((await restore.json<{ error: { code: string } }>()).error.code).toBe("PUBLISHER_STATUS_TERMINAL");
    expect((await ingestEntry(await signedEntry(signer, { candidateVersion: "1.1.0-after-revoke" }))).status).toBe(403);

    await expect(env.PROOF_DB.prepare(
      `INSERT INTO publisher_status_events (event_id, key_id, status, reason_class, occurred_at)
       VALUES (?, ?, 'ACTIVE', 'RESTORED', ?)`,
    ).bind(crypto.randomUUID(), signer.keyId, new Date().toISOString()).run()).rejects.toThrow(/PUBLISHER_STATUS_TERMINAL/);
    await expect(env.PROOF_DB.prepare(
      "UPDATE publishers SET status = 'ACTIVE', updated_at = ? WHERE key_id = ?",
    ).bind(new Date().toISOString(), signer.keyId).run()).rejects.toThrow(/PUBLISHER_STATUS_TERMINAL/);
    const publisher = await env.PROOF_DB.prepare("SELECT status FROM publishers WHERE key_id = ?")
      .bind(signer.keyId).first<{ status: string }>();
    expect(publisher?.status).toBe("REVOKED");
  });

  it("cannot lose a concurrent terminal publisher revocation to a suspension write", async () => {
    const racer = await signingFixture();
    await registerSigner(racer);
    const [suspension, revocation] = await Promise.all([
      setPublisherStatus(racer.keyId, "SUSPENDED", "POLICY"),
      setPublisherStatus(racer.keyId, "REVOKED", "COMPROMISED"),
    ]);
    expect(revocation.status).toBe(200);
    expect([200, 409]).toContain(suspension.status);
    const publisher = await env.PROOF_DB.prepare("SELECT status FROM publishers WHERE key_id = ?")
      .bind(racer.keyId).first<{ status: string }>();
    expect(publisher?.status).toBe("REVOKED");
    expect((await setPublisherStatus(racer.keyId, "ACTIVE", "RESTORED")).status).toBe(409);
  });

  it("binds broken evidence to a later verified fixed entry", async () => {
    const broken = await signedEntry(signer, { verdict: "CHANGED", generatedAt: new Date(Date.now() - 3_000).toISOString() });
    const fixed = await signedEntry(signer, { verdict: "SAFE", candidateVersion: "1.1.1-fixed", generatedAt: new Date(Date.now() - 1_000).toISOString() });
    for (const entry of [broken, fixed]) {
      expect((await workerFetch("/v1/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
        body: JSON.stringify(entry),
      })).status).toBe(201);
    }
    const resolution = await signedResolution(signer, broken, fixed);
    const response = await workerFetch("/v1/resolutions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
      body: JSON.stringify(resolution),
    });
    expect(response.status).toBe(201);
    const api = await workerFetch(`/api/v1/entries/${broken.entryHash}`);
    expect((await api.json<{ resolution: { resolutionHash: string } }>()).resolution.resolutionHash).toBe(resolution.resolutionHash);
  });

  it("requires active unmoderated resolution referents at admission and every public read", async () => {
    const broken = await signedEntry(signer, {
      verdict: "CHANGED",
      generatedAt: new Date(Date.now() - 4_000).toISOString(),
    });
    const fixed = await signedEntry(signer, {
      verdict: "SAFE",
      candidateVersion: "1.1.1-fixed",
      generatedAt: new Date(Date.now() - 2_000).toISOString(),
    });
    expect((await ingestEntry(broken)).status).toBe(201);
    expect((await ingestEntry(fixed)).status).toBe(201);
    const resolution = await signedResolution(signer, broken, fixed);

    expect((await moderateEntry(fixed.entryHash, "TAKEDOWN", "PRIVACY")).status).toBe(200);
    const rejected = await workerFetch("/v1/resolutions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
      body: JSON.stringify(resolution),
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json<{ error: { code: string } }>()).error.code).toBe("RESOLUTION_REFERENCES_UNAVAILABLE");

    const resolutionJson = canonical(resolution);
    await expect(env.PROOF_DB.prepare(
      `INSERT INTO compatibility_resolutions
        (resolution_hash, key_id, broken_entry_hash, fixed_entry_hash, ecosystem, component_name,
         generated_at, published_at, body_sha256, body_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      resolution.resolutionHash,
      resolution.signature.keyId,
      resolution.broken.entryHash,
      resolution.fixed.entryHash,
      resolution.component.ecosystem,
      resolution.component.name,
      resolution.generatedAt,
      new Date().toISOString(),
      await sha256(resolutionJson),
      resolutionJson,
    ).run()).rejects.toThrow(/RESOLUTION_REFERENT_UNAVAILABLE/);

    expect((await moderateEntry(fixed.entryHash, "RESTORE", "RESTORED")).status).toBe(200);
    expect((await workerFetch("/v1/resolutions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
      body: JSON.stringify(resolution),
    })).status).toBe(201);
    expect((await moderateEntry(fixed.entryHash, "TAKEDOWN", "PRIVACY")).status).toBe(200);

    expect((await workerFetch(`/api/v1/resolutions/${resolution.resolutionHash}`)).status).toBe(410);
    const brokenApi = await workerFetch(`/api/v1/entries/${broken.entryHash}`);
    expect(brokenApi.status).toBe(200);
    expect((await brokenApi.json<{ resolution: unknown }>()).resolution).toBeNull();
    const search = await workerFetch("/api/v1/search?component=public-agent-package");
    const searchText = await search.text();
    expect(search.status).toBe(200);
    expect(searchText).not.toContain(resolution.resolutionHash);
    expect(searchText).not.toContain(fixed.entryHash);
    const sitemap = await (await workerFetch("/sitemap.xml")).text();
    expect(sitemap).not.toContain(resolution.resolutionHash);
  });

  it("authenticates and pseudonymizes lifecycle events without producing gate metrics", async () => {
    const { credential, status: registrationStatus } = await registerLifecycleInstallation();
    expect(registrationStatus).toBe(201);
    expect(credential).toMatchObject({
      channel: "apm",
      external: true,
      demo: false,
      measurementClass: "UNVERIFIED_TELEMETRY",
      gateEligible: false,
      sybilSusceptible: true,
    });
    const event = {
      schema_version: "agent-vigil-lifecycle-event/v1",
      event_id: crypto.randomUUID(),
      event_name: "preflight_completed_v1",
      event_day: new Date().toISOString().slice(0, 10),
      release_version: "0.15.0",
      channel: credential.channel,
      external: credential.external,
      demo: credential.demo,
      entity_scope: "INDIVIDUAL_INSTALLATION",
      installation_pseudo_id: credential.installationId,
      opaque_pair_token: `sha256:${"a".repeat(64)}`,
      verdict: "SAFE",
      shared_policy: false,
      required_gate: false,
      public_contribution: false,
      organization_context: false,
    };
    const body = JSON.stringify(event);
    const headers = await lifecycleHeaders(credential, body, event.event_id);
    const first = await workerFetch("/v1/lifecycle", { method: "POST", headers, body });
    expect(first.status).toBe(202);
    const firstReceipt = await first.json<{ ingestionSequence: number; receivedAt: string; created: boolean }>();
    const replay = await workerFetch("/v1/lifecycle", { method: "POST", headers, body: JSON.stringify(event) });
    const replayReceipt = await replay.json<{ ingestionSequence: number; receivedAt: string; created: boolean }>();
    expect(replay.status).toBe(200);
    expect(replayReceipt).toEqual({ ...firstReceipt, created: false });

    const stored = await env.PROOF_DB.prepare(
      "SELECT sanitized_json, measurement_class FROM lifecycle_events WHERE event_id = ?",
    ).bind(event.event_id).first<{ sanitized_json: string; measurement_class: string }>();
    expect(stored?.sanitized_json).not.toContain(event.installation_pseudo_id);
    expect(stored?.measurement_class).toBe("UNVERIFIED_TELEMETRY");

    const { credential: internalCredential } = await registerLifecycleInstallation("INTERNAL");
    const internal = {
      ...event,
      event_id: crypto.randomUUID(),
      channel: internalCredential.channel,
      external: internalCredential.external,
      demo: internalCredential.demo,
      installation_pseudo_id: internalCredential.installationId,
    };
    const internalBody = JSON.stringify(internal);
    expect((await workerFetch("/v1/lifecycle", {
      method: "POST",
      headers: await lifecycleHeaders(internalCredential, internalBody, internal.event_id),
      body: internalBody,
    })).status).toBe(202);
    const exported = await workerFetch("/v1/admin/lifecycle/export", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const exportLines = new TextDecoder().decode(await exported.arrayBuffer()).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exportLines).toHaveLength(2);
    expect(exportLines[0]).toMatchObject({
      measurementClass: "UNVERIFIED_TELEMETRY",
      gateEligible: false,
      sybilSusceptible: true,
    });
  });

  it("rejects lifecycle privacy canaries without persisting them", async () => {
    const { credential } = await registerLifecycleInstallation();
    const base = {
      schema_version: "agent-vigil-lifecycle-event/v1",
      event_id: crypto.randomUUID(),
      event_name: "update_plan_created_v1",
      event_day: new Date().toISOString().slice(0, 10),
      release_version: "0.15.0",
      channel: credential.channel,
      external: credential.external,
      demo: credential.demo,
      entity_scope: "INDIVIDUAL_INSTALLATION",
      installation_pseudo_id: credential.installationId,
      shared_policy: false,
      required_gate: false,
      public_contribution: false,
      organization_context: false,
    };
    for (const forbidden of [
      { source: "private source" },
      { prompt: "private prompt" },
      { repository_name: "private repository" },
      { argv: ["--secret", "value"] },
      { environment_variables: { SECRET: "value" } },
      { full_receipt: { raw: true } },
    ]) {
      const event = { ...base, ...forbidden, event_id: crypto.randomUUID() };
      const body = JSON.stringify(event);
      const response = await workerFetch("/v1/lifecycle", {
        method: "POST",
        headers: await lifecycleHeaders(credential, body, event.event_id),
        body,
      });
      expect(response.status).toBe(422);
    }
    const count = await env.PROOF_DB.prepare("SELECT COUNT(*) AS count FROM lifecycle_events").first<{ count: number }>();
    expect(Number(count?.count)).toBe(0);
  });

  it("rejects forged organizations, changed installation IDs, body tampering, and revoked credentials", async () => {
    const { credential, idempotencyKey } = await registerLifecycleInstallation();
    const replayRegistration = await registerLifecycleInstallation("EXTERNAL_STANDARD", idempotencyKey);
    expect(replayRegistration.status).toBe(200);
    expect(replayRegistration.credential.installationId).toBe(credential.installationId);
    expect(replayRegistration.credential.installationSecret).toBe(credential.installationSecret);

    const base = {
      schema_version: "agent-vigil-lifecycle-event/v1",
      event_id: crypto.randomUUID(),
      event_name: "preflight_completed_v1",
      event_day: new Date().toISOString().slice(0, 10),
      release_version: "0.15.0",
      channel: credential.channel,
      external: credential.external,
      demo: credential.demo,
      entity_scope: "INDIVIDUAL_INSTALLATION",
      installation_pseudo_id: credential.installationId,
      opaque_pair_token: `sha256:${"b".repeat(64)}`,
      verdict: "SAFE",
      shared_policy: false,
      required_gate: false,
      public_contribution: false,
      organization_context: false,
    };

    const forgedOrganization = {
      ...base,
      event_id: crypto.randomUUID(),
      entity_scope: "ORGANIZATION",
      organization_context: true,
      organization_pseudo_id: "forged-organization-1234",
    };
    const forgedBody = JSON.stringify(forgedOrganization);
    expect((await workerFetch("/v1/lifecycle", {
      method: "POST",
      headers: await lifecycleHeaders(credential, forgedBody, forgedOrganization.event_id),
      body: forgedBody,
    })).status).toBe(403);

    const inflated = { ...base, event_id: crypto.randomUUID(), installation_pseudo_id: crypto.randomUUID() };
    const inflatedBody = JSON.stringify(inflated);
    expect((await workerFetch("/v1/lifecycle", {
      method: "POST",
      headers: await lifecycleHeaders(credential, inflatedBody, inflated.event_id),
      body: inflatedBody,
    })).status).toBe(422);

    const signedBody = JSON.stringify(base);
    const signedHeaders = await lifecycleHeaders(credential, signedBody, base.event_id);
    const tamperedBody = JSON.stringify({ ...base, verdict: "CHANGED" });
    expect((await workerFetch("/v1/lifecycle", { method: "POST", headers: signedHeaders, body: tamperedBody })).status).toBe(401);

    expect((await workerFetch("/v1/admin/lifecycle/installations/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        installationId: credential.installationId,
        status: "REVOKED",
        reasonClass: "CONSENT_WITHDRAWN",
      }),
    })).status).toBe(200);
    const reactivation = await adminPost("/v1/admin/lifecycle/installations/status", {
      eventId: crypto.randomUUID(),
      installationId: credential.installationId,
      status: "ACTIVE",
      reasonClass: "RESTORED",
    });
    expect(reactivation.status).toBe(400);
    expect((await registerLifecycleInstallation("EXTERNAL_STANDARD", idempotencyKey)).status).toBe(409);
    await expect(env.PROOF_DB.prepare(
      `INSERT INTO lifecycle_installation_status_events
        (event_id, installation_id, status, reason_class, occurred_at)
       VALUES (?, ?, 'ACTIVE', 'RESTORED', ?)`,
    ).bind(crypto.randomUUID(), credential.installationId, new Date().toISOString()).run())
      .rejects.toThrow(/LIFECYCLE_STATUS_TERMINAL/);
    await expect(env.PROOF_DB.prepare(
      "UPDATE lifecycle_installations SET status = 'ACTIVE', updated_at = ? WHERE installation_id = ?",
    ).bind(new Date().toISOString(), credential.installationId).run())
      .rejects.toThrow(/LIFECYCLE_STATUS_TERMINAL/);
    const newEvent = { ...base, event_id: crypto.randomUUID() };
    const newBody = JSON.stringify(newEvent);
    expect((await workerFetch("/v1/lifecycle", {
      method: "POST",
      headers: await lifecycleHeaders(credential, newBody, newEvent.event_id),
      body: newBody,
    })).status).toBe(401);
    const count = await env.PROOF_DB.prepare("SELECT COUNT(*) AS count FROM lifecycle_events").first<{ count: number }>();
    expect(Number(count?.count)).toBe(0);
  });

  it("registers trusted acquisition before access, derives exclusions, and signs fresh moderation state", async () => {
    const path = "/v1/frequency/first-100/acquisitions";
    const proposal = await acquisitionProposal(signer, frequencyAdapter, 1);
    const body = JSON.stringify(proposal);
    const headers = await publisherRequestHeaders(signer, path, body);
    const first = await workerFetch(path, { method: "POST", headers, body });
    expect(first.status).toBe(201);
    const receipt = await first.json<{
      acquisitionHandle: string;
      artifactAccess: string;
      entry: { receivedAt: string; ingestionSequence: number; inspectionStarted: boolean; eligibility: { decision: string; reason: string } };
    }>();
    expect(receipt).toMatchObject({
      artifactAccess: "REQUIRES_TRUSTED_ADAPTER_GRANT",
      entry: { inspectionStarted: false, eligibility: { decision: "INCLUDED", reason: "ELIGIBLE" } },
    });
    expect((await env.PROOF_DB.prepare("SELECT COUNT(*) AS count FROM frequency_artifact_access_grants")
      .first<{ count: number }>())?.count).toBe(0);

    const beforeGrant = await adminPost("/v1/admin/frequency/first-100/evaluations", {
      ingestionSequence: receipt.entry.ingestionSequence,
      evaluation: {
        startedAt: new Date(Date.parse(receipt.entry.receivedAt) + 1).toISOString(),
        completedAt: new Date(Date.parse(receipt.entry.receivedAt) + 2).toISOString(),
        verdict: "CHANGED",
        receiptHash: `sha256:${"9".repeat(64)}`,
        falseCompatible: false,
        materiality: { classification: "MATERIAL", evidenceComplete: true, workflowConsequences: ["REQUIRED_BEHAVIOR_UNAVAILABLE"] },
      },
    });
    expect(beforeGrant.status).toBe(409);
    expect((await beforeGrant.json<{ error: { code: string } }>()).error.code).toBe("FIRST_100_ARTIFACT_ACCESS_NOT_GRANTED");

    const fakeDuplicate = { ...proposal, eligibility: { decision: "EXCLUDED", reason: "DUPLICATE_PAIR" } };
    const fakeBody = JSON.stringify(fakeDuplicate);
    expect((await workerFetch(path, {
      method: "POST", headers: await publisherRequestHeaders(signer, path, fakeBody), body: fakeBody,
    })).status).toBe(422);

    const untrusted = await acquisitionProposal(signer, null, 2);
    const untrustedBody = JSON.stringify(untrusted);
    const untrustedResponse = await workerFetch(path, {
      method: "POST", headers: await publisherRequestHeaders(signer, path, untrustedBody), body: untrustedBody,
    });
    expect(await untrustedResponse.json()).toMatchObject({
      artifactAccess: "GATE_INELIGIBLE",
      entry: { eligibility: { decision: "EXCLUDED", reason: "MALFORMED_PREINSPECTION_RECORD" } },
    });

    const invalidAttestation = await acquisitionProposal(signer, frequencyAdapter, 22);
    invalidAttestation.adapterAttestation!.signature = `${invalidAttestation.adapterAttestation!.signature.startsWith("A") ? "B" : "A"}${invalidAttestation.adapterAttestation!.signature.slice(1)}`;
    const invalidAttestationBody = JSON.stringify(invalidAttestation);
    const invalidAttestationResponse = await workerFetch(path, {
      method: "POST",
      headers: await publisherRequestHeaders(signer, path, invalidAttestationBody),
      body: invalidAttestationBody,
    });
    expect(invalidAttestationResponse.status).toBe(201);
    expect(await invalidAttestationResponse.json()).toMatchObject({
      artifactAccess: "GATE_INELIGIBLE",
      entry: { eligibility: { decision: "EXCLUDED", reason: "MALFORMED_PREINSPECTION_RECORD" } },
    });

    const replayedAdapterEvent = await acquisitionProposal(signer, frequencyAdapter, 23);
    replayedAdapterEvent.adapterAttestation!.eventId = proposal.adapterAttestation!.eventId;
    replayedAdapterEvent.adapterAttestation!.signature = base64(await crypto.subtle.sign(
      "Ed25519",
      frequencyAdapter.privateKey,
      new TextEncoder().encode(first100AdapterAttestationMessage(replayedAdapterEvent, signer.keyId)),
    ));
    const replayedAdapterBody = JSON.stringify(replayedAdapterEvent);
    const replayedAdapterResponse = await workerFetch(path, {
      method: "POST",
      headers: await publisherRequestHeaders(signer, path, replayedAdapterBody),
      body: replayedAdapterBody,
    });
    expect(await replayedAdapterResponse.json()).toMatchObject({
      artifactAccess: "GATE_INELIGIBLE",
      entry: { eligibility: { decision: "EXCLUDED", reason: "MALFORMED_PREINSPECTION_RECORD" } },
    });

    const duplicateProposal = await acquisitionProposal(signer, frequencyAdapter, 3, {
      ...proposal.acquisition,
      rawEventSha256: `sha256:${"d".repeat(64)}`,
    });
    const duplicateBody = JSON.stringify(duplicateProposal);
    const duplicateResponse = await workerFetch(path, {
      method: "POST", headers: await publisherRequestHeaders(signer, path, duplicateBody), body: duplicateBody,
    });
    expect(await duplicateResponse.json()).toMatchObject({
      entry: { eligibility: { decision: "EXCLUDED", reason: "DUPLICATE_PAIR" } },
    });

    const accessPath = `/v1/frequency/first-100/acquisitions/${receipt.acquisitionHandle}/grant`;
    const access = await adapterAccessRequest(signer, frequencyAdapter, receipt.acquisitionHandle);
    const accessBody = JSON.stringify(access);
    const accessResponse = await workerFetch(accessPath, {
      method: "POST", headers: await publisherRequestHeaders(signer, accessPath, accessBody), body: accessBody,
    });
    expect(accessResponse.status).toBe(201);
    const grant = await accessResponse.json<{ grantedAt: string }>();
    expect(Date.parse(grant.grantedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.entry.receivedAt));

    const conflictingAccess = {
      ...access,
      requestedAt: new Date(Date.parse(access.requestedAt) + 1).toISOString(),
      signature: "",
    };
    conflictingAccess.signature = base64(await crypto.subtle.sign(
      "Ed25519",
      frequencyAdapter.privateKey,
      new TextEncoder().encode(first100AccessGrantMessage(conflictingAccess, signer.keyId)),
    ));
    const conflictingAccessBody = JSON.stringify(conflictingAccess);
    const conflictingAccessResponse = await workerFetch(accessPath, {
      method: "POST",
      headers: await publisherRequestHeaders(signer, accessPath, conflictingAccessBody),
      body: conflictingAccessBody,
    });
    expect(conflictingAccessResponse.status).toBe(422);

    const startedAt = new Date(Date.parse(grant.grantedAt) + 1).toISOString();
    expect((await adminPost("/v1/admin/frequency/first-100/evaluations", {
      ingestionSequence: receipt.entry.ingestionSequence,
      evaluation: {
        startedAt,
        completedAt: new Date(Date.parse(startedAt) + 1).toISOString(),
        verdict: "CHANGED",
        receiptHash: `sha256:${"a".repeat(64)}`,
        falseCompatible: false,
        materiality: { classification: "MATERIAL", evidenceComplete: true, workflowConsequences: ["REQUIRED_BEHAVIOR_UNAVAILABLE"] },
      },
    })).status).toBe(201);

    const manifestResponse = await workerFetch("/api/v1/frequency/first-100/manifest.json");
    expect(manifestResponse.status).toBe(200);
    const issuedAt = manifestResponse.headers.get("X-Agent-Vigil-Head-Issued-At")!;
    const manifest = await manifestResponse.json<{
      payload: {
        moderationCheckpoint: { sequence: number };
        publisherStates: unknown[];
        adapterStates: unknown[];
        publisherStateSha256: string;
        adapterStateSha256: string;
        rawLedgerSha256: string;
        provenanceSha256: string;
        chunks: unknown[];
      };
      signature: { keyId: string; value: string };
    }>();
    expect(manifest.payload.chunks).toHaveLength(1);
    expect(manifest.payload.publisherStates).toHaveLength(1);
    expect(manifest.payload.adapterStates).toHaveLength(1);
    expect(manifest.payload.publisherStateSha256).toBe(await sha256(canonical(manifest.payload.publisherStates)));
    expect(manifest.payload.adapterStateSha256).toBe(await sha256(canonical(manifest.payload.adapterStates)));
    expect(manifest.signature.keyId).toBe(env.FREQUENCY_OPERATOR_KEY_ID);
    expect(manifest.signature.keyId).not.toBe(signer.keyId);
    expect(manifest.signature.keyId).not.toBe(frequencyAdapter.keyId);
    const headResponse = await workerFetch(`/api/v1/frequency/first-100/head.json?issuedAt=${encodeURIComponent(issuedAt)}`);
    const activeHead = await headResponse.json<{ payload: Record<string, unknown>; signature: { keyId: string } }>();
    expect(activeHead.payload).toMatchObject({
      rawLedgerSha256: manifest.payload.rawLedgerSha256,
      provenanceSha256: manifest.payload.provenanceSha256,
      moderationCheckpoint: manifest.payload.moderationCheckpoint,
      operatorDutySeparated: true,
    });

    expect((await setPublisherStatus(signer.keyId, "REVOKED", "COMPROMISED")).status).toBe(200);
    const revokedHead = await (await workerFetch(
      `/api/v1/frequency/first-100/head.json?issuedAt=${encodeURIComponent(issuedAt)}`,
    )).json<{ payload: { manifestPayloadSha256: string; moderationCheckpoint: { sequence: number } } }>();
    expect(revokedHead.payload.moderationCheckpoint.sequence).toBeGreaterThan(manifest.payload.moderationCheckpoint.sequence);
    expect(revokedHead.payload.manifestPayloadSha256).not.toBe(activeHead.payload.manifestPayloadSha256);
    const revokedProvenance = new TextDecoder().decode(
      await (await workerFetch("/api/v1/frequency/first-100-provenance.jsonl")).arrayBuffer(),
    );
    expect(revokedProvenance).toContain('"reason":"PUBLISHER_REVOKED"');
    expect(revokedProvenance).toContain('"gateEligible":false');
  });

  it("enforces publisher, adapter, and operator signing duties pairwise", async () => {
    const adapterReuse = await adminPost("/v1/admin/frequency/adapters/register", {
      eventId: crypto.randomUUID(),
      keyId: signer.keyId,
      publicKey: signer.publicKeyBase64,
      version: FREQUENCY_ADAPTER_VERSION,
    });
    expect(adapterReuse.status).toBe(409);
    expect((await adapterReuse.json<{ error: { code: string } }>()).error.code).toBe("KEY_DUTY_CONFLICT");

    const publisherReuse = await workerFetch("/v1/admin/publishers/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        keyId: frequencyAdapter.keyId,
        publicKey: frequencyAdapter.publicKeyBase64,
      }),
    });
    expect(publisherReuse.status).toBe(409);

    await env.PROOF_DB.prepare(
      `INSERT INTO publishers (key_id, public_key_b64, status, registered_at, updated_at)
       VALUES (?, ?, 'ACTIVE', ?, ?)`,
    ).bind(env.FREQUENCY_OPERATOR_KEY_ID, signer.publicKeyBase64, new Date().toISOString(), new Date().toISOString()).run();
    expect((await workerFetch("/api/v1/frequency/first-100/manifest.json")).status).toBe(500);
  });

  it("derives duplicate and component caps under concurrent trusted writes", async () => {
    const path = "/v1/frequency/first-100/acquisitions";
    const responses = await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      const facts = acquisitionFacts(index + 1);
      facts.pair.componentIdentity = "bounded-package";
      facts.pair.ecosystem = index % 2 === 0 ? "apm" : "skills";
      const proposal = await acquisitionProposal(signer, frequencyAdapter, index + 1, facts);
      const body = JSON.stringify(proposal);
      return workerFetch(path, { method: "POST", headers: await publisherRequestHeaders(signer, path, body), body });
    }));
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const receipts = await Promise.all(responses.map((response) => response.json<{
      entry: { ingestionSequence: number; eligibility: { decision: string; reason: string } };
    }>()));
    expect(receipts.filter((value) => value.entry.eligibility.decision === "INCLUDED")).toHaveLength(20);
    expect(receipts.filter((value) => value.entry.eligibility.reason === "COMPONENT_CAP")).toHaveLength(5);
    expect(new Set(receipts.map((value) => value.entry.ingestionSequence)).size).toBe(25);
  });

  it("serializes the 100th inclusion against concurrent exclusions without exporting a post-close row", async () => {
    const register = async (index: number, adapter: SigningFixture | null) => registerFirst100Pair(
      env.PROOF_DB,
      await acquisitionProposal(signer, adapter, index),
      {
        r0ReleasedAt: "2026-08-23T00:00:00.000Z",
        releasedChannels: "apm",
        receivedAt: new Date().toISOString(),
        publisherKeyId: signer.keyId,
        requestId: crypto.randomUUID(),
        operatorKeyId: env.FREQUENCY_OPERATOR_KEY_ID,
      },
    );
    for (let index = 1; index <= 99; index += 1) {
      expect((await register(index, frequencyAdapter)).entry.eligibility.decision).toBe("INCLUDED");
    }
    const concurrent = await Promise.allSettled([
      register(100, frequencyAdapter),
      register(10_000, null),
    ]);
    expect(concurrent[0]!.status).toBe("fulfilled");
    await expect(register(10_001, null)).rejects.toThrow(/sample is closed/);
    const bundle = await exportFirst100Bundle(env.PROOF_DB);
    expect(bundle.entries.filter((entry) => entry.eligibility.decision === "INCLUDED")).toHaveLength(100);
    expect(bundle.entries.at(-1)?.eligibility.decision).toBe("INCLUDED");
    expect(bundle.entries.length).toBeLessThanOrEqual(101);
    expect(Number((await env.PROOF_DB.prepare(
      "SELECT COUNT(*) AS count FROM frequency_pairs",
    ).first<{ count: number }>())?.count)).toBe(bundle.entries.length);
    expect(await env.PROOF_DB.prepare(
      "SELECT scope_type, reason FROM frequency_stop_events WHERE reason = 'INCLUDED_SAMPLE_CLOSED'",
    ).first()).toMatchObject({ scope_type: "SAMPLE", reason: "INCLUDED_SAMPLE_CLOSED" });
  });

  it("serializes total, channel, and publisher all-row quotas and records bounded stop events", async () => {
    const untrustedResults = await Promise.allSettled(Array.from({ length: 405 }, async (_, index) => registerFirst100Pair(
      env.PROOF_DB,
      await acquisitionProposal(signer, null, index + 1),
      {
        r0ReleasedAt: "2026-08-23T00:00:00.000Z",
        releasedChannels: "apm",
        receivedAt: new Date().toISOString(),
        publisherKeyId: signer.keyId,
        requestId: crypto.randomUUID(),
        operatorKeyId: env.FREQUENCY_OPERATOR_KEY_ID,
      },
    )));
    expect(untrustedResults.filter((result) => result.status === "fulfilled")).toHaveLength(400);
    expect(untrustedResults.filter((result) => result.status === "rejected")).toHaveLength(5);
    expect(Number((await env.PROOF_DB.prepare("SELECT COUNT(*) AS count FROM frequency_pairs").first<{ count: number }>())?.count)).toBe(400);
    expect(await env.PROOF_DB.prepare("SELECT scope_type, reason FROM frequency_stop_events").first())
      .toMatchObject({ scope_type: "PUBLISHER", reason: "PUBLISHER_ROW_CAP" });

    // Reset only the bounded frequency lane, retaining registered principals.
    await env.PROOF_DB.batch([
      env.PROOF_DB.prepare("DELETE FROM frequency_stop_events"),
      env.PROOF_DB.prepare("DELETE FROM frequency_pairs"),
    ]);
    const publishers = [signer, await signingFixture(), await signingFixture()];
    const adapters = [frequencyAdapter, await signingFixture(), await signingFixture()];
    for (let index = 1; index < publishers.length; index += 1) {
      await registerSigner(publishers[index]!);
      await registerFrequencyAdapter(adapters[index]!);
    }
    const insertExcluded = async (index: number, channel: "apm" | "skills"): Promise<void> => {
      const publisher = publishers[index % publishers.length]!;
      const adapter = adapters[index % adapters.length]!;
      const now = new Date().toISOString();
      await env.PROOF_DB.prepare(
        `INSERT INTO frequency_pairs
          (schema_version, kind, registration_id, publisher_key_id, request_id, received_at, channel,
           external, opted_in, inspection_started, eligibility_decision, eligibility_decided_at,
           eligibility_reason, ecosystem, component_identity, current_exact_identity, candidate_exact_identity,
           real_update_intent, dedup_key, included_dedup_key, received_body_sha256, acquisition_handle,
           raw_event_sha256, adapter_key_id, adapter_version, adapter_event_id, adapter_observed_at,
           adapter_attestation_sha256)
         VALUES ('diffwitness-first-100-entry/v1', 'pair', ?, ?, ?, ?, ?, 1, 1, 0, 'EXCLUDED', ?,
                 'DUPLICATE_PAIR', ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        FIRST_100_REGISTRATION_ID, publisher.keyId, crypto.randomUUID(), now, channel, now, channel,
        `quota-component-${index}`, `sha256:${index.toString(16).padStart(64, "1")}`,
        `sha256:${(index + 2_000).toString(16).padStart(64, "2")}`,
        `sha256:${index.toString(16).padStart(64, "3")}`, `sha256:${index.toString(16).padStart(64, "4")}`,
        crypto.randomUUID(), `sha256:${index.toString(16).padStart(64, "5")}`, adapter.keyId,
        FREQUENCY_ADAPTER_VERSION, crypto.randomUUID(), now, `sha256:${index.toString(16).padStart(64, "6")}`,
      ).run();
    };
    const lane = await Promise.allSettled(Array.from({ length: 510 }, (_, index) => insertExcluded(index + 1_000, "apm")));
    expect(lane.filter((result) => result.status === "fulfilled")).toHaveLength(500);
    expect(lane.filter((result) => result.status === "rejected")).toHaveLength(10);
    await expect(registerFirst100Pair(env.PROOF_DB, await acquisitionProposal(signer, null, 9_000), {
      r0ReleasedAt: "2026-08-23T00:00:00.000Z", releasedChannels: "apm", receivedAt: new Date().toISOString(),
      publisherKeyId: signer.keyId, requestId: crypto.randomUUID(), operatorKeyId: env.FREQUENCY_OPERATOR_KEY_ID,
    })).rejects.toThrow(/channel row cap reached/);
    const global = await Promise.allSettled(Array.from({ length: 510 }, (_, index) => insertExcluded(index + 10_000, "skills")));
    expect(global.filter((result) => result.status === "fulfilled")).toHaveLength(500);
    expect(global.filter((result) => result.status === "rejected")).toHaveLength(10);
    await expect(registerFirst100Pair(env.PROOF_DB, await acquisitionProposal(signer, null, 19_000), {
      r0ReleasedAt: "2026-08-23T00:00:00.000Z", releasedChannels: "apm,skills", receivedAt: new Date().toISOString(),
      publisherKeyId: signer.keyId, requestId: crypto.randomUUID(), operatorKeyId: env.FREQUENCY_OPERATOR_KEY_ID,
    })).rejects.toThrow(/global row cap reached/);
    expect(Number((await env.PROOF_DB.prepare("SELECT COUNT(*) AS count FROM frequency_pairs").first<{ count: number }>())?.count)).toBe(1_000);
    const stops = await env.PROOF_DB.prepare("SELECT scope_type, reason FROM frequency_stop_events ORDER BY stop_sequence").all();
    expect(stops.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope_type: "CHANNEL", reason: "CHANNEL_ROW_CAP" }),
      expect.objectContaining({ scope_type: "GLOBAL", reason: "GLOBAL_ROW_CAP" }),
    ]));
  });

  it("uses append-only moderation for takedown and correction state", async () => {
    const entry = await signedEntry(signer);
    expect((await workerFetch("/v1/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Vigil-Public-Consent": "v1" },
      body: JSON.stringify(entry),
    })).status).toBe(201);
    const moderation = await workerFetch("/v1/admin/moderation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ eventId: crypto.randomUUID(), recordType: "ENTRY", recordHash: entry.entryHash, action: "TAKEDOWN", reasonClass: "PRIVACY" }),
    });
    expect(moderation.status).toBe(200);
    expect((await workerFetch(`/api/v1/entries/${entry.entryHash}`)).status).toBe(410);
    const stored = await env.PROOF_DB.prepare("SELECT body_json FROM compatibility_entries WHERE entry_hash = ?")
      .bind(entry.entryHash).first<{ body_json: string }>();
    expect(stored?.body_json).toBe(canonical(entry));
  });

  it("keeps the migrated D1 foreign-key graph internally consistent", async () => {
    const foreignKeys = await env.PROOF_DB.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeys.results).toEqual([]);
  });
});
