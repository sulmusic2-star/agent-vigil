import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { canonical, sha256, signLifecycleRequest } from "../src/contracts";
import { FIRST_100_REGISTRATION_ID } from "../src/frequency";
import { publisherRequestHeaders, signedEntry, signedResolution, signingFixture, type SigningFixture } from "./fixtures";

const ADMIN_TOKEN = "local-test-admin-token-32-bytes-minimum-only";
let signer: SigningFixture;

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
  if (headers.has("Authorization") && !headers.has("CF-Connecting-IP")) {
    headers.set("CF-Connecting-IP", `admin-test-${crypto.randomUUID()}`);
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
  action: "TAKEDOWN" | "REVOKE" | "RESTORE",
  reasonClass: "PRIVACY" | "INVALID_EVIDENCE" | "KEY_COMPROMISE" | "PUBLISHER_REQUEST" | "RESTORED",
): Promise<Response> {
  return adminPost("/v1/admin/moderation", {
    eventId: crypto.randomUUID(),
    recordType: "ENTRY",
    recordHash: entryHash,
    action,
    reasonClass,
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
    env.PROOF_DB.prepare("DELETE FROM frequency_pairs"),
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

  it("allocates first-100 chronology before inspection and exports the frozen schema", async () => {
    const proposal = {
      schemaVersion: "diffwitness-first-100-entry/v1",
      kind: "pair",
      registrationId: FIRST_100_REGISTRATION_ID,
      channel: "apm",
      external: true,
      optedIn: true,
      inspectionStarted: false,
      eligibility: { decision: "INCLUDED", reason: "ELIGIBLE" },
      pair: {
        ecosystem: "apm",
        componentIdentity: "public-agent-package",
        currentExactIdentity: `sha256:${"1".repeat(64)}`,
        candidateExactIdentity: `sha256:${"2".repeat(64)}`,
        realUpdateIntent: true,
      },
    };
    const body = JSON.stringify(proposal);
    const path = "/v1/frequency/first-100/pairs";
    const headers = await publisherRequestHeaders(signer, path, body);
    const first = await workerFetch(path, { method: "POST", headers, body });
    expect(first.status).toBe(201);
    const registered = await first.json<{ receivedAt: string; ingestionSequence: number; inspectionStarted: boolean; eligibility: { decision: string } }>();
    expect(registered.ingestionSequence).toBeGreaterThan(0);
    expect(registered.inspectionStarted).toBe(false);
    expect(registered.eligibility.decision).toBe("INCLUDED");
    expect(Number.isFinite(Date.parse(registered.receivedAt))).toBe(true);

    const replay = await workerFetch(path, { method: "POST", headers, body });
    expect((await replay.json<{ ingestionSequence: number }>()).ingestionSequence).toBe(registered.ingestionSequence);
    const exportResponse = await workerFetch("/api/v1/frequency/first-100.jsonl");
    expect(exportResponse.headers.get("X-Agent-Vigil-Gate-Eligible")).toBe("false");
    expect(exportResponse.headers.get("X-Agent-Vigil-Provenance-Required")).toBe("true");
    expect(exportResponse.headers.get("Link")).toContain("first-100-provenance.jsonl");
    expect(exportResponse.headers.get("Cache-Control")).toBe("no-store");
    const rawBeforeRevocation = new TextDecoder().decode(await exportResponse.arrayBuffer());
    const lines = rawBeforeRevocation.trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.ingestionSequence).toBe(registered.ingestionSequence);
    expect(lines[1]?.inspectionStarted).toBe(false);

    const activeProvenanceResponse = await workerFetch("/api/v1/frequency/first-100-provenance.jsonl");
    const activeProvenance = new TextDecoder().decode(await activeProvenanceResponse.arrayBuffer());
    expect(activeProvenance).toContain(signer.keyId);
    expect(activeProvenance).toContain('"status":"ACTIVE"');
    expect(activeProvenance).toContain('"gateEligible":true');

    expect((await setPublisherStatus(signer.keyId, "SUSPENDED", "POLICY")).status).toBe(200);
    const suspendedProvenanceResponse = await workerFetch("/api/v1/frequency/first-100-provenance.jsonl");
    const suspendedProvenance = new TextDecoder().decode(await suspendedProvenanceResponse.arrayBuffer());
    expect(suspendedProvenance).toContain('"status":"SUSPENDED"');
    expect(suspendedProvenance).toContain('"reason":"PUBLISHER_SUSPENDED"');
    expect(suspendedProvenance).toContain('"gateEligible":false');
    const rawWhileSuspendedResponse = await workerFetch("/api/v1/frequency/first-100.jsonl");
    expect(new TextDecoder().decode(await rawWhileSuspendedResponse.arrayBuffer())).toBe(rawBeforeRevocation);
    expect((await setPublisherStatus(signer.keyId, "ACTIVE", "RESTORED")).status).toBe(200);
    const restoredProvenanceResponse = await workerFetch("/api/v1/frequency/first-100-provenance.jsonl");
    const restoredProvenance = new TextDecoder().decode(await restoredProvenanceResponse.arrayBuffer());
    expect(restoredProvenance).toContain('"status":"ACTIVE"');
    expect(restoredProvenance).toContain('"gateEligible":true');

    expect((await setPublisherStatus(signer.keyId, "REVOKED", "COMPROMISED")).status).toBe(200);
    const rawAfterRevocationResponse = await workerFetch("/api/v1/frequency/first-100.jsonl");
    const rawAfterRevocation = new TextDecoder().decode(await rawAfterRevocationResponse.arrayBuffer());
    expect(rawAfterRevocation).toBe(rawBeforeRevocation);
    const provenanceResponse = await workerFetch("/api/v1/frequency/first-100-provenance.jsonl");
    const provenanceLines = new TextDecoder().decode(await provenanceResponse.arrayBuffer())
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(provenanceLines[1]).toMatchObject({
      ingestionSequence: registered.ingestionSequence,
      publisher: { keyId: signer.keyId, status: "REVOKED" },
      frozenEligibility: { decision: "INCLUDED", reason: "ELIGIBLE" },
      effectiveEligibility: { decision: "QUARANTINED", reason: "PUBLISHER_REVOKED", gateEligible: false },
      chronologyMutable: false,
    });

    const startedAt = new Date(Date.parse(registered.receivedAt) + 1).toISOString();
    const evaluation = await adminPost("/v1/admin/frequency/first-100/evaluations", {
      ingestionSequence: registered.ingestionSequence,
      evaluation: {
        startedAt,
        completedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
        verdict: "SAFE",
        receiptHash: `sha256:${"a".repeat(64)}`,
        falseCompatible: false,
        materiality: { classification: "NON_MATERIAL", evidenceComplete: true, workflowConsequences: [] },
      },
    });
    expect(evaluation.status).toBe(409);
    expect((await evaluation.json<{ error: { code: string } }>()).error.code).toBe("FIRST_100_PUBLISHER_NOT_ACTIVE");

    const now = new Date().toISOString();
    await expect(env.PROOF_DB.prepare(
      `INSERT INTO frequency_pairs
        (schema_version, kind, registration_id, publisher_key_id, request_id, received_at, channel,
         external, opted_in, inspection_started, eligibility_decision, eligibility_decided_at,
         eligibility_reason, ecosystem, component_identity, current_exact_identity,
         candidate_exact_identity, real_update_intent, dedup_key, included_dedup_key, received_body_sha256)
       VALUES ('diffwitness-first-100-entry/v1', 'pair', ?, ?, ?, ?, 'apm',
               1, 1, 0, 'INCLUDED', ?, 'ELIGIBLE', 'apm', 'other-package', ?, ?, 1, ?, ?, ?)`,
    ).bind(
      FIRST_100_REGISTRATION_ID,
      signer.keyId,
      crypto.randomUUID(),
      now,
      now,
      `sha256:${"3".repeat(64)}`,
      `sha256:${"4".repeat(64)}`,
      `sha256:${"5".repeat(64)}`,
      `sha256:${"5".repeat(64)}`,
      `sha256:${"6".repeat(64)}`,
    ).run()).rejects.toThrow(/PUBLISHER_NOT_ACTIVE/);
  });

  it("serializes concurrent first-100 component caps without rewriting chronology", async () => {
    const path = "/v1/frequency/first-100/pairs";
    const responses = await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      const proposal = {
        schemaVersion: "diffwitness-first-100-entry/v1",
        kind: "pair",
        registrationId: FIRST_100_REGISTRATION_ID,
        channel: "apm",
        external: true,
        optedIn: true,
        inspectionStarted: false,
        eligibility: { decision: "INCLUDED", reason: "ELIGIBLE" },
        pair: {
          ecosystem: "apm",
          componentIdentity: "bounded-package",
          currentExactIdentity: `sha256:${index.toString(16).padStart(64, "0")}`,
          candidateExactIdentity: `sha256:${(index + 100).toString(16).padStart(64, "0")}`,
          realUpdateIntent: true,
        },
      };
      const body = JSON.stringify(proposal);
      return workerFetch(path, { method: "POST", headers: await publisherRequestHeaders(signer, path, body), body });
    }));
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const entries = await Promise.all(responses.map((response) => response.json<{
      ingestionSequence: number;
      eligibility: { decision: string; reason: string };
    }>()));
    expect(entries.filter((entry) => entry.eligibility.decision === "INCLUDED")).toHaveLength(20);
    expect(entries.filter((entry) => entry.eligibility.reason === "COMPONENT_CAP")).toHaveLength(5);
    expect(new Set(entries.map((entry) => entry.ingestionSequence)).size).toBe(25);

    const exportResponse = await workerFetch("/api/v1/frequency/first-100.jsonl");
    const ledger = new TextDecoder().decode(await exportResponse.arrayBuffer()).trim().split("\n")
      .slice(1).map((line) => JSON.parse(line) as { ingestionSequence: number });
    expect(ledger).toHaveLength(25);
    expect(ledger.map((entry) => entry.ingestionSequence)).toEqual(
      [...ledger].map((entry) => entry.ingestionSequence).sort((left, right) => left - right),
    );
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
});
