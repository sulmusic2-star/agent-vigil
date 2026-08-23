import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { base64UrlEncode, hmacBase64Url, hmacHex } from "../src/crypto.ts";
import { handleMeasurementBridge, handleMeasurementReport } from "../src/measurement.ts";
import {
  assertMeasurementDutySecretSeparation,
  MEASUREMENT_DUTY_SECRET_NAMES
} from "../src/measurement-security.ts";

const ORIGIN = "https://team.example.test";
const SESSION_SECRET = "test-only-team-session-secret-32-bytes-minimum";
const CONTROL_SECRET = "test-only-r0-measurement-control-secret-32-bytes";
const IDENTITY_BRIDGE_SECRET = "test-only-r0-identity-bridge-secret-32-bytes";
const ACTIVITY_BRIDGE_SECRET = "test-only-r0-activity-bridge-secret-32-bytes";
const GITHUB_WEBHOOK_SECRET = "test-only-github-webhook-secret-32-bytes-minimum";
const GITHUB_RECONCILIATION_SECRET = "test-only-github-reconciliation-secret-32-bytes";
const INDIVIDUAL_IDENTITY_SECRET = "test-only-r0-individual-identity-secret-32-bytes";
const INDIVIDUAL_SESSION_SECRET = "test-only-individual-session-secret-32-bytes-minimum";
const APP_ID = 12_345;
const INSTALLATION_ID = 71_234;
const ACCOUNT_NODE_ID = "ACCT_MEASUREMENT_123";
const RELEASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const MEASUREMENT_DUTY_SECRETS = {
  TEAM_SESSION_HMAC_SECRET: SESSION_SECRET,
  GITHUB_WEBHOOK_SECRET,
  GITHUB_RECONCILIATION_HMAC_SECRET: GITHUB_RECONCILIATION_SECRET,
  R0_MEASUREMENT_CONTROL_HMAC_SECRET: CONTROL_SECRET,
  R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET: IDENTITY_BRIDGE_SECRET,
  R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET: ACTIVITY_BRIDGE_SECRET,
  R0_MEASUREMENT_IDENTITY_HMAC_SECRET: "test-only-r0-measurement-identity-secret-32-bytes",
  R0_INDIVIDUAL_IDENTITY_HMAC_SECRET: INDIVIDUAL_IDENTITY_SECRET,
  INDIVIDUAL_SESSION_HMAC_SECRET: INDIVIDUAL_SESSION_SECRET
} as const;

async function signedRequest(body: Record<string, unknown>, secret: string): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(secret, `${timestamp}.${raw}`);
  return new Request(`${ORIGIN}/v1/measurement/bridge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-Measurement-Signature": `t=${timestamp},v1=${signature}`
    },
    body: raw
  });
}

async function clearDatabase(): Promise<void> {
  await env.TEAM_CONTROL_DB.exec(`
    DELETE FROM individual_measurement_events;
    DELETE FROM individual_subject_attestations;
    DELETE FROM individual_auth_subject_rotations;
    DELETE FROM individual_identity_merges;
    DELETE FROM individual_measurement_bridge_messages;
    DELETE FROM github_personal_installation_reconciliations;
    DELETE FROM github_personal_deliveries;
    DELETE FROM github_personal_installations;
    DELETE FROM github_personal_installation_claims;
    DELETE FROM individual_audit_events;
    DELETE FROM individual_session_mutations;
    DELETE FROM individual_consents;
    DELETE FROM individual_identities;
    DELETE FROM individual_privacy_deletion_requests;
    DELETE FROM measurement_events;
    DELETE FROM measurement_subject_attestations;
    DELETE FROM measurement_bridge_messages;
    DELETE FROM measurement_subjects;
    DELETE FROM measurement_consents;
    DELETE FROM measurement_boundaries;
    DELETE FROM github_installation_reconciliations;
    DELETE FROM github_deliveries;
    DELETE FROM github_installation_repositories;
    DELETE FROM github_installations;
    DELETE FROM github_installation_claims;
    DELETE FROM privacy_deletion_requests;
    DELETE FROM provider_reconciliation_snapshots;
    DELETE FROM provider_state_cursors;
    DELETE FROM lifecycle_events;
    DELETE FROM revenue_ledger;
    DELETE FROM cash_ledger;
    DELETE FROM entitlements;
    DELETE FROM billing_commands;
    DELETE FROM provider_events;
    DELETE FROM commercial_transitions;
    DELETE FROM checkout_intents;
    DELETE FROM billing_accounts;
    DELETE FROM audit_events;
    DELETE FROM rollback_records;
    DELETE FROM exception_records;
    DELETE FROM update_history;
    DELETE FROM policy_heads;
    DELETE FROM policy_revisions;
    DELETE FROM organization_members;
    DELETE FROM organizations;
  `);
}

async function seedActiveOrganizationInstallation(): Promise<void> {
  const now = new Date().toISOString();
  const installedAt = "2026-06-01T00:00:00.000Z";
  const deliveryId = "b8a1e2b0-42f1-4aa3-a5e5-54a59dc50ef1";
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organizations (id, slug, display_name, status, created_at)
       VALUES ('org_measure', 'org-measure', 'Measurement fixture', 'active', ?1)`
    ).bind(now),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organization_members
        (org_id, user_id, role, identity_kind, active, created_at, updated_at)
       VALUES ('org_measure', 'user_owner', 'owner', 'human', 1, ?1, ?1)`
    ).bind(now),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organization_members
        (org_id, user_id, role, identity_kind, active, created_at, updated_at)
       VALUES ('org_measure', 'user_member', 'member', 'human', 1, ?1, ?1)`
    ).bind(now),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_installation_claims
        (installation_id, github_account_node_id, org_id, status, claimed_by, claimed_at, updated_at)
       VALUES (?1, ?2, 'org_measure', 'bound', 'user_owner', ?3, ?3)`
    ).bind(INSTALLATION_ID, ACCOUNT_NODE_ID, now),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_installations
        (installation_id, app_id, github_account_node_id, org_id, state, repository_selection,
         last_event_created_at, last_delivery_id, last_reconciliation_id, installed_at,
         reconciled_at, updated_at)
       VALUES (?1, ?2, ?3, 'org_measure', 'active', 'selected', ?4, ?5,
               'recon_measurement', ?6, ?7, ?7)`
    ).bind(
      INSTALLATION_ID,
      APP_ID,
      ACCOUNT_NODE_ID,
      Math.floor(Date.parse(installedAt) / 1000),
      deliveryId,
      installedAt,
      now
    )
  ]);
}

async function session(userId = "user_owner"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      schema_version: "team-session-v1",
      kid: "team-session-key-v1",
      sub: userId,
      org_id: "org_measure",
      jti: `session_${crypto.randomUUID()}`,
      iat: now,
      exp: now + 3600
    })
  );
  const input = `avteam_v1.${payload}`;
  return `${input}.${await hmacBase64Url(SESSION_SECRET, input)}`;
}

async function tenantApi(
  path: string,
  options: { method?: string; userId?: string; body?: object; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${await session(options.userId)}`);
  if (options.body) headers.set("Content-Type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
}

async function signedPost(path: string, body: Record<string, unknown>, overrideSecret?: string): Promise<Response> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const kind = body.message_kind;
  const secret =
    overrideSecret ??
    (path === "/v1/measurement/report" || kind === "r0_boundary_v1"
      ? CONTROL_SECRET
      : kind === "organization_subject_attestation_v1"
        ? IDENTITY_BRIDGE_SECRET
        : ACTIVITY_BRIDGE_SECRET);
  const signature = await hmacHex(secret, `${timestamp}.${raw}`);
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-Measurement-Signature": `t=${timestamp},v1=${signature}`
    },
    body: raw
  });
}

function boundary(messageId = `boundary_${crypto.randomUUID()}`): Record<string, unknown> {
  return {
    schema_version: "r0-measurement-bridge-v1",
    message_id: messageId,
    message_kind: "r0_boundary_v1",
    observed_at: new Date().toISOString(),
    release_version: "0.16.0",
    release_commit_sha: RELEASE_COMMIT,
    release_channel: "github_app",
    deployment_environment: "production",
    release_published_at: "2026-05-01T00:00:00.000Z",
    r0_started_at: "2026-05-01T00:00:00.000Z",
    github_app_id: APP_ID
  };
}

function attestation(
  classification: "external" | "internal" | "demo" | "test" = "external",
  messageId = `attest_${crypto.randomUUID()}`,
  observedAt = new Date().toISOString()
): Record<string, unknown> {
  const bases = {
    external: "provider_confirmed_non_operator",
    internal: "operator_identity_registry",
    demo: "demo_registry",
    test: "test_environment_registry"
  } as const;
  return {
    schema_version: "r0-measurement-bridge-v1",
    message_id: messageId,
    message_kind: "organization_subject_attestation_v1",
    observed_at: observedAt,
    installation_id: INSTALLATION_ID,
    classification,
    classification_basis: bases[classification]
  };
}

function event(
  kind: "organization_activation_v1" | "team_offer_presented_v1",
  messageId = `event_${crypto.randomUUID()}`
): Record<string, unknown> {
  return {
    schema_version: "r0-measurement-bridge-v1",
    message_id: messageId,
    message_kind: kind,
    observed_at: new Date().toISOString(),
    installation_id: INSTALLATION_ID
  };
}

async function optIn(userId = "user_owner"): Promise<Response> {
  return tenantApi("/v1/orgs/org_measure/measurement-consent", {
    method: "PUT",
    userId,
    body: { schema_version: "r0-measurement-consent-v1", opted_in: true }
  });
}

async function initializeEligibleSubject(): Promise<void> {
  expect((await signedPost("/v1/measurement/bridge", boundary())).status).toBe(201);
  expect((await optIn()).status).toBe(200);
  expect((await signedPost("/v1/measurement/bridge", attestation())).status).toBe(201);
}

describe("R0 organization measurement plane", () => {
  beforeEach(async () => {
    await clearDatabase();
    await seedActiveOrganizationInstallation();
  });

  it("pins one exact R0 boundary and rejects signature or replay drift", async () => {
    const unsigned = await exports.default.fetch(`${ORIGIN}/v1/measurement/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(boundary())
    });
    expect(unsigned.status).toBe(401);

    const message = boundary("boundary_replay_1");
    const created = await signedPost("/v1/measurement/bridge", message);
    expect(created.status).toBe(201);

    const duplicate = await signedPost("/v1/measurement/bridge", message);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true, counted: true });

    const changed = { ...message, r0_started_at: "2026-05-02T00:00:00.000Z" };
    const replayMismatch = await signedPost("/v1/measurement/bridge", changed);
    expect(replayMismatch.status).toBe(409);
    expect(await replayMismatch.json()).toMatchObject({ error: { code: "measurement_message_replay_mismatch" } });

    const secondBoundary = await signedPost("/v1/measurement/bridge", boundary("boundary_second"));
    expect(secondBoundary.status).toBe(409);
    expect(await secondBoundary.json()).toMatchObject({ error: { code: "r0_boundary_already_initialized" } });
  });

  it("requires human-owner opt-in, bridge classification, and active reconciled identity", async () => {
    expect((await signedPost("/v1/measurement/bridge", boundary())).status).toBe(201);
    const memberConsent = await optIn("user_member");
    expect(memberConsent.status).toBe(403);

    const wrongBridgeRole = await signedPost(
      "/v1/measurement/bridge",
      attestation("external", "attest_wrong_bridge_role"),
      ACTIVITY_BRIDGE_SECRET
    );
    expect(wrongBridgeRole.status).toBe(401);

    const external = await signedPost("/v1/measurement/bridge", attestation());
    expect(external.status).toBe(201);
    expect(await external.json()).toMatchObject({ gate_eligible_now: false });

    const beforeConsent = await signedPost("/v1/measurement/bridge", event("organization_activation_v1"));
    expect(beforeConsent.status).toBe(409);
    expect(await beforeConsent.json()).toMatchObject({ error: { code: "organization_not_measurement_eligible" } });

    expect((await optIn()).status).toBe(200);
    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installations SET state = 'suspended' WHERE installation_id = ?1`
    )
      .bind(INSTALLATION_ID)
      .run();
    const suspended = await signedPost("/v1/measurement/bridge", event("organization_activation_v1"));
    expect(suspended.status).toBe(409);

    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installations SET state = 'active' WHERE installation_id = ?1`
    )
      .bind(INSTALLATION_ID)
      .run();
    const withForbiddenName = { ...event("organization_activation_v1"), account_name: "do-not-store" };
    const rejectedField = await signedPost("/v1/measurement/bridge", withForbiddenName);
    expect(rejectedField.status).toBe(400);
    expect(await rejectedField.json()).toMatchObject({ error: { code: "unexpected_field" } });
  });

  it("requires every measurement HMAC duty to use a distinct secret before request handling", async () => {
    const configured = {
      R0_MEASUREMENT_ENABLED: "true",
      R0_INDIVIDUAL_MEASUREMENT_ENABLED: "true",
      ...MEASUREMENT_DUTY_SECRETS
    } as const;
    const names = MEASUREMENT_DUTY_SECRET_NAMES;
    let collisionsChecked = 0;
    for (let left = 0; left < names.length; left += 1) {
      for (let right = left + 1; right < names.length; right += 1) {
        const leftName = names[left];
        const rightName = names[right];
        if (!leftName || !rightName) throw new Error("test secret matrix is incomplete");
        const collided = { ...configured, [rightName]: configured[leftName] };
        let error: unknown;
        try {
          assertMeasurementDutySecretSeparation(collided);
        } catch (caught) {
          error = caught;
        }
        expect(error).toMatchObject({
          status: 503,
          code: "r0_measurement_secret_configuration_invalid",
          message: "R0 measurement duty-secret configuration is invalid."
        });
        collisionsChecked += 1;
      }
    }
    expect(collisionsChecked).toBe(36);

    const organizationOnly = { ...configured, R0_INDIVIDUAL_MEASUREMENT_ENABLED: "false" } as const;
    let organizationCollisionsChecked = 0;
    for (let left = 0; left < 7; left += 1) {
      for (let right = left + 1; right < 7; right += 1) {
        const leftName = names[left];
        const rightName = names[right];
        if (!leftName || !rightName) throw new Error("organization secret matrix is incomplete");
        expect(() =>
          assertMeasurementDutySecretSeparation({
            ...organizationOnly,
            [rightName]: organizationOnly[leftName]
          })
        ).toThrowError(/duty-secret configuration is invalid/u);
        organizationCollisionsChecked += 1;
      }
    }
    expect(organizationCollisionsChecked).toBe(21);

    const invalidEnv = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET") return IDENTITY_BRIDGE_SECRET;
        return Reflect.get(target, property, receiver);
      }
    });
    await expect(
      handleMeasurementBridge(
        new Request(`${ORIGIN}/v1/measurement/bridge`, { method: "POST", body: "not-read" }),
        invalidEnv
      )
    ).rejects.toMatchObject({
      status: 503,
      code: "r0_measurement_secret_configuration_invalid",
      message: "R0 measurement duty-secret configuration is invalid."
    });
  });

  it("rejects cross-role taint before persistence and keeps corrected reports empty", async () => {
    expect((await signedPost("/v1/measurement/bridge", boundary("boundary_cross_role"))).status).toBe(201);
    expect((await optIn()).status).toBe(200);

    const collidedEnv = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "TEAM_SESSION_HMAC_SECRET") return IDENTITY_BRIDGE_SECRET;
        return Reflect.get(target, property, receiver);
      }
    });
    const classification = attestation("external", "cross_role_attestation");
    await expect(
      handleMeasurementBridge(await signedRequest(classification, IDENTITY_BRIDGE_SECRET), collidedEnv)
    ).rejects.toMatchObject({ status: 503, code: "r0_measurement_secret_configuration_invalid" });

    const activation = event("organization_activation_v1", "cross_role_activation");
    await expect(
      handleMeasurementBridge(await signedRequest(activation, ACTIVITY_BRIDGE_SECRET), collidedEnv)
    ).rejects.toMatchObject({ status: 503, code: "r0_measurement_secret_configuration_invalid" });

    const reportRequest = {
      schema_version: "r0-measurement-report-request-v1",
      query_id: "cross_role_collided_report",
      observed_at: new Date().toISOString()
    };
    await expect(
      handleMeasurementReport(await signedRequest(reportRequest, CONTROL_SECRET), collidedEnv)
    ).rejects.toMatchObject({ status: 503, code: "r0_measurement_secret_configuration_invalid" });

    const residuals = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM measurement_subjects WHERE org_id = 'org_measure') AS subjects,
        (SELECT COUNT(*) FROM measurement_subject_attestations
          WHERE message_id = 'cross_role_attestation') AS attestations,
        (SELECT COUNT(*) FROM measurement_bridge_messages
          WHERE message_id IN ('cross_role_attestation', 'cross_role_activation')) AS messages,
        (SELECT COUNT(*) FROM measurement_events
          WHERE event_id = 'cross_role_activation') AS events,
        (SELECT COUNT(*) FROM audit_events
          WHERE resource_id IN ('cross_role_attestation', 'cross_role_activation')) AS audits`
    ).first<Record<string, number>>();
    expect(residuals).toEqual({ subjects: 0, attestations: 0, messages: 0, events: 0, audits: 0 });

    const corrected = await signedPost("/v1/measurement/report", {
      ...reportRequest,
      query_id: "cross_role_corrected_report"
    });
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({
      organizations: { eligible_installations: 0, activated_organizations: 0 }
    });
  });

  it("keeps subject classification strictly monotonic and permits only exact replay at equal time", async () => {
    expect((await signedPost("/v1/measurement/bridge", boundary())).status).toBe(201);
    const baseTime = Date.now() - 4_000;
    const firstAt = new Date(baseTime).toISOString();
    const staleAt = new Date(baseTime + 1_000).toISOString();
    const newestAt = new Date(baseTime + 2_000).toISOString();

    const first = attestation("external", "attest_chronology_first", firstAt);
    expect((await signedPost("/v1/measurement/bridge", first)).status).toBe(201);
    const newest = attestation("internal", "attest_chronology_newest", newestAt);
    expect((await signedPost("/v1/measurement/bridge", newest)).status).toBe(201);

    const exactReplay = await signedPost("/v1/measurement/bridge", newest);
    expect(exactReplay.status).toBe(200);
    expect(await exactReplay.json()).toMatchObject({ accepted: true, duplicate: true, counted: true });

    const stale = await signedPost(
      "/v1/measurement/bridge",
      attestation("external", "attest_chronology_stale", staleAt)
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "stale_measurement_classification_observation" }
    });

    const equalDifferent = await signedPost(
      "/v1/measurement/bridge",
      attestation("external", "attest_chronology_equal_different", newestAt)
    );
    expect(equalDifferent.status).toBe(409);
    expect(await equalDifferent.json()).toMatchObject({
      error: { code: "ambiguous_measurement_classification_observation" }
    });
    const equalSame = await signedPost(
      "/v1/measurement/bridge",
      attestation("internal", "attest_chronology_equal_same", newestAt)
    );
    expect(equalSame.status).toBe(409);
    expect(await equalSame.json()).toMatchObject({
      error: { code: "ambiguous_measurement_classification_observation" }
    });

    const subject = await env.TEAM_CONTROL_DB.prepare(
      `SELECT classification, classification_basis, classification_attested_at
         FROM measurement_subjects WHERE org_id = 'org_measure'`
    ).first<{
      classification: string;
      classification_basis: string;
      classification_attested_at: string;
    }>();
    expect(subject).toEqual({
      classification: "internal",
      classification_basis: "operator_identity_registry",
      classification_attested_at: newestAt
    });
    const evidenceCounts = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM measurement_subject_attestations) AS attestations,
         (SELECT COUNT(*) FROM measurement_bridge_messages
           WHERE message_kind = 'organization_subject_attestation_v1') AS messages,
         (SELECT COUNT(*) FROM audit_events
           WHERE action = 'measurement.organization.classified') AS audits`
    ).first<{ attestations: number; messages: number; audits: number }>();
    expect(evidenceCounts).toEqual({ attestations: 2, messages: 2, audits: 2 });

    await expect(
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE measurement_subjects
            SET classification = 'external',
                classification_basis = 'provider_confirmed_non_operator',
                classification_attested_at = ?1
          WHERE org_id = 'org_measure'`
      )
        .bind(staleAt)
        .run()
    ).rejects.toThrow(/measurement classification chronology conflict/u);
    const afterDirectWrite = await env.TEAM_CONTROL_DB.prepare(
      `SELECT classification, classification_attested_at
         FROM measurement_subjects WHERE org_id = 'org_measure'`
    ).first<{ classification: string; classification_attested_at: string }>();
    expect(afterDirectWrite).toEqual({ classification: "internal", classification_attested_at: newestAt });
  });

  it("deduplicates same-day use and derives repeat, PQL, and matured offer cohorts", async () => {
    await initializeEligibleSubject();

    const firstId = "activation_first";
    const first = event("organization_activation_v1", firstId);
    expect((await signedPost("/v1/measurement/bridge", first)).status).toBe(201);
    const exactReplay = await signedPost("/v1/measurement/bridge", first);
    expect(await exactReplay.json()).toMatchObject({ duplicate: true, counted: true });

    const sameDay = await signedPost("/v1/measurement/bridge", event("organization_activation_v1"));
    expect(sameDay.status).toBe(202);
    expect(await sameDay.json()).toMatchObject({ counted: false, result: "ignored_duplicate_day" });

    const prematureOffer = await signedPost("/v1/measurement/bridge", event("team_offer_presented_v1"));
    expect(prematureOffer.status).toBe(409);
    expect(await prematureOffer.json()).toMatchObject({ error: { code: "pql_qualification_required" } });

    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE measurement_events SET occurred_at = ?1, event_day = substr(?1, 1, 10)
        WHERE event_id = ?2`
    )
      .bind(yesterday, firstId)
      .run();
    const secondId = "activation_second";
    expect((await signedPost("/v1/measurement/bridge", event("organization_activation_v1", secondId))).status).toBe(201);
    const offerId = "offer_presented";
    expect((await signedPost("/v1/measurement/bridge", event("team_offer_presented_v1", offerId))).status).toBe(201);

    const now = Date.now();
    const firstAt = new Date(now - 70 * 86_400_000).toISOString();
    const secondAt = new Date(now - 69 * 86_400_000).toISOString();
    const offerAt = new Date(now - 68 * 86_400_000).toISOString();
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE measurement_events SET occurred_at = ?1, event_day = substr(?1, 1, 10) WHERE event_id = ?2`
      ).bind(firstAt, firstId),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE measurement_events SET occurred_at = ?1, event_day = substr(?1, 1, 10) WHERE event_id = ?2`
      ).bind(secondAt, secondId),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE measurement_events SET occurred_at = ?1, event_day = substr(?1, 1, 10) WHERE event_id = ?2`
      ).bind(offerAt, offerId)
    ]);

    const report = await signedPost("/v1/measurement/report", {
      schema_version: "r0-measurement-report-request-v1",
      query_id: `query_${crypto.randomUUID()}`,
      observed_at: new Date().toISOString()
    });
    expect(report.status).toBe(200);
    const body = await report.json<Record<string, any>>();
    expect(body.organizations).toMatchObject({
      eligible_installations: 1,
      activated_organizations: 1,
      matured_activated_organizations: 1,
      repeated_organizations_within_60_days: 1,
      matured_repeat_rate: 1,
      pql_organizations: 1,
      pql_offered_organizations: 1,
      matured_pql_offered_organizations: 1,
      sample_floor_met: false
    });
    expect(body.individuals).toMatchObject({
      identity_status: "AUTHENTICATED_GITHUB_OIDC_AND_RECONCILED_PERSONAL_APP",
      evidence_status: "BOUNDED_GATE_EVIDENCE",
      eligible_installations: 0,
      activated_individuals: 0,
      matured_repeat_rate: null
    });
    expect(body.coverage_and_sybil_boundary).toMatchObject({
      anonymous_telemetry_included: false,
      sybil_resistant: false,
      unique_company_identity_proven: false
    });
  });

  it("exports and deletes measurement evidence with organization privacy data", async () => {
    await initializeEligibleSubject();
    const measurementEventId = "privacy_activation_event_1";
    expect(
      (
        await signedPost(
          "/v1/measurement/bridge",
          event("organization_activation_v1", measurementEventId)
        )
      ).status
    ).toBe(201);

    const exported = await tenantApi("/v1/orgs/org_measure/privacy/export");
    expect(exported.status).toBe(200);
    const exportBody = await exported.json<Record<string, any>>();
    expect(exportBody.r0_measurement).toMatchObject({
      consent: { opted_in: true },
      stores_repository_or_account_names: false
    });
    expect(exportBody.r0_measurement.events).toHaveLength(1);
    const subjectToken = exportBody.r0_measurement.subject.subject_token as string;
    expect(subjectToken).toMatch(/^morg_[a-f0-9]{64}$/u);

    const request = await tenantApi("/v1/orgs/org_measure/privacy/deletion-requests", { method: "POST" });
    expect(request.status).toBe(202);
    const deletion = await request.json<{ confirmation: string }>();
    const confirmed = await tenantApi("/v1/orgs/org_measure/privacy/data", {
      method: "DELETE",
      headers: { "X-Deletion-Confirmation": deletion.confirmation }
    });
    expect(confirmed.status).toBe(202);
    const rows = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM measurement_subjects WHERE org_id = 'org_measure') AS subjects,
         (SELECT COUNT(*) FROM measurement_events WHERE org_id = 'org_measure') AS events,
         (SELECT COUNT(*) FROM measurement_consents WHERE org_id = 'org_measure') AS consents`
    ).first<{ subjects: number; events: number; consents: number }>();
    expect(rows).toEqual({ subjects: 0, events: 0, consents: 0 });
    const retainedAudit = await env.TEAM_CONTROL_DB.prepare(
      `SELECT actor_type, actor_id, action, resource_type, resource_id, metadata_json
         FROM audit_events WHERE org_id = 'org_measure' ORDER BY created_at`
    ).all<Record<string, unknown>>();
    const retainedAuditJson = JSON.stringify(retainedAudit.results);
    expect(retainedAuditJson).not.toContain(subjectToken);
    expect(retainedAuditJson).not.toContain("morg_");
    expect(retainedAuditJson).not.toContain("classification");
    expect(retainedAuditJson).not.toContain("provider_confirmed_non_operator");
    expect(retainedAuditJson).not.toContain(String(INSTALLATION_ID));
    expect(retainedAuditJson).not.toContain(measurementEventId);
    expect(retainedAudit.results.some((row) => row.action === "privacy.deletion.completed")).toBe(true);
    expect(retainedAudit.results.some((row) => String(row.action).startsWith("measurement."))).toBe(false);
  });
});
