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
  return exports.default.fetch(`https://proof.example${path}`, init);
}

async function registerCurrentSigner(): Promise<void> {
  const response = await workerFetch("/v1/admin/publishers/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ eventId: crypto.randomUUID(), keyId: signer.keyId, publicKey: signer.publicKeyBase64 }),
  });
  expect(response.status).toBe(201);
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
    const lines = new TextDecoder().decode(await exportResponse.arrayBuffer()).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.ingestionSequence).toBe(registered.ingestionSequence);
    expect(lines[1]?.inspectionStarted).toBe(false);
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
