import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { base64UrlEncode, hmacBase64Url, hmacHex, sha256Hex } from "../src/crypto.ts";
import worker from "../src/index.ts";

const ORIGIN = "https://team.example.test";
const SESSION_ISSUER = "https://auth.example.test/";
const SESSION_AUDIENCE = "agent-vigil-team-control-plane";
const SESSION_SECRET = "test-only-individual-session-secret-32-bytes-minimum";
const CONTROL_SECRET = "test-only-r0-measurement-control-secret-32-bytes";
const IDENTITY_SECRET = "test-only-r0-identity-bridge-secret-32-bytes";
const ACTIVITY_SECRET = "test-only-r0-activity-bridge-secret-32-bytes";
const GITHUB_WEBHOOK_SECRET = "test-only-github-webhook-secret-32-bytes-minimum";
const GITHUB_RECONCILIATION_SECRET = "test-only-github-reconciliation-secret-32-bytes";
const APP_ID = 12_345;
const INSTALLATION_ID = 440_001;
const ACCOUNT_NODE_ID = "USER_NODE_INDIVIDUAL_123";
const REPOSITORY_NODE_ID = "REPO_NODE_INDIVIDUAL_123";
const RELEASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RECEIPT_SHA256 = "a".repeat(64);

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
    DELETE FROM audit_events;
    DELETE FROM organization_members;
    DELETE FROM organizations;
  `);
}

async function individualSession(
  input: { sub?: string; accountNodeId?: string; sessionId?: string; audience?: string } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      schema_version: "individual-session-v1",
      kid: "individual-session-key-v1",
      iss: SESSION_ISSUER,
      aud: input.audience ?? SESSION_AUDIENCE,
      sub: input.sub ?? "github_oidc_user_primary",
      github_account_node_id: input.accountNodeId ?? ACCOUNT_NODE_ID,
      identity_kind: "human",
      jti: input.sessionId ?? `individual_session_${crypto.randomUUID()}`,
      iat: now,
      exp: now + 600
    })
  );
  const signed = `avindividual_v1.${payload}`;
  return `${signed}.${await hmacBase64Url(SESSION_SECRET, signed)}`;
}

async function individualApiWithEnv(
  path: string,
  token: string,
  runtimeEnv: Env,
  options: { method?: string; body?: object; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    }),
    runtimeEnv
  );
}

async function allApplicationRowsText(): Promise<string> {
  const tables = await env.TEAM_CONTROL_DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  ).all<{ name: string }>();
  const snapshot: Array<{ table: string; rows: unknown[] }> = [];
  for (const { name } of tables.results) {
    if (name.startsWith("sqlite_") || name.startsWith("_cf_") || name === "d1_migrations") continue;
    if (!/^[a-z0-9_]+$/u.test(name)) throw new Error(`Unexpected application table name: ${name}`);
    const rows = await env.TEAM_CONTROL_DB.prepare(`SELECT * FROM "${name}"`).all();
    snapshot.push({ table: name, rows: rows.results });
  }
  return JSON.stringify(snapshot);
}

async function individualApi(
  path: string,
  token: string,
  options: { method?: string; body?: object; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
}

async function signedMeasurement(
  path: string,
  body: Record<string, unknown>,
  secret?: string
): Promise<Response> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const selected =
    secret ??
    (path === "/v1/measurement/report" || body.message_kind === "r0_boundary_v1"
      ? CONTROL_SECRET
      : body.message_kind === "individual_activation_v1"
        ? ACTIVITY_SECRET
        : IDENTITY_SECRET);
  const signature = await hmacHex(selected, `${timestamp}.${raw}`);
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-Measurement-Signature": `t=${timestamp},v1=${signature}`
    },
    body: raw
  });
}

function boundary(): Record<string, unknown> {
  return {
    schema_version: "r0-measurement-bridge-v1",
    message_id: `boundary_${crypto.randomUUID()}`,
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

function attestation(accountNodeId = ACCOUNT_NODE_ID): Record<string, unknown> {
  return {
    schema_version: "r0-measurement-bridge-v1",
    message_id: `individual_attestation_${crypto.randomUUID()}`,
    message_kind: "individual_subject_attestation_v1",
    observed_at: new Date().toISOString(),
    github_account_node_id: accountNodeId,
    classification: "external",
    classification_basis: "provider_session_and_non_operator_registry"
  };
}

function activation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "r0-measurement-bridge-v1",
    message_id: `individual_activation_${crypto.randomUUID()}`,
    message_kind: "individual_activation_v1",
    observed_at: new Date().toISOString(),
    installation_id: INSTALLATION_ID,
    verifier_release_version: "0.16.0",
    verifier_release_commit_sha: RELEASE_COMMIT,
    verifier_outcome: "completed",
    verdict: "SAFE",
    receipt_sha256: RECEIPT_SHA256,
    ...overrides
  };
}

async function sendPersonalWebhook(
  deliveryId: string,
  accountType: "User" | "Organization" = "User"
): Promise<Response> {
  const at = new Date().toISOString();
  const raw = JSON.stringify({
    action: "created",
    installation: {
      id: INSTALLATION_ID,
      app_id: APP_ID,
      account: { node_id: ACCOUNT_NODE_ID, type: accountType, login: "must-never-be-stored" },
      repository_selection: "selected",
      created_at: at,
      updated_at: at
    },
    repositories: [
      { node_id: REPOSITORY_NODE_ID, name: "must-never-be-stored", full_name: "private/must-never-be-stored" }
    ]
  });
  return exports.default.fetch(`${ORIGIN}/v1/github/app/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "installation",
      "X-GitHub-Delivery": deliveryId,
      "X-Hub-Signature-256": `sha256=${await hmacHex(GITHUB_WEBHOOK_SECRET, raw)}`
    },
    body: raw
  });
}

async function reconcilePersonal(deliveryId: string): Promise<Response> {
  const body = {
    schema_version: "github-installation-reconciliation-v1",
    reconciliation_id: `personal_recon_${crypto.randomUUID()}`,
    source_delivery_id: deliveryId,
    observed_at: new Date().toISOString(),
    app_id: APP_ID,
    installation_id: INSTALLATION_ID,
    account_node_id: ACCOUNT_NODE_ID,
    account_type: "User",
    provider_status: "active",
    repository_selection: "selected",
    repository_node_ids: [REPOSITORY_NODE_ID]
  };
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(GITHUB_RECONCILIATION_SECRET, `${timestamp}.${raw}`);
  return exports.default.fetch(`${ORIGIN}/v1/github/app/reconciliation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-GitHub-Reconciliation-Signature": `t=${timestamp},v1=${signature}`
    },
    body: raw
  });
}

async function initializeEligibleIndividual(token: string): Promise<void> {
  expect((await signedMeasurement("/v1/measurement/bridge", boundary())).status).toBe(201);
  expect(
    (
      await individualApi("/v1/individual/measurement-consent", token, {
        method: "PUT",
        body: { schema_version: "r0-individual-measurement-consent-v1", opted_in: true }
      })
    ).status
  ).toBe(200);
  expect(
    (
      await individualApi("/v1/individual/github/installation-claim", token, {
        method: "POST",
        body: { schema_version: "github-personal-installation-claim-v1", installation_id: INSTALLATION_ID }
      })
    ).status
  ).toBe(201);
  const wrongType = await sendPersonalWebhook(crypto.randomUUID(), "Organization");
  expect(wrongType.status).toBe(409);
  expect(await wrongType.json()).toMatchObject({ error: { code: "github_installation_claim_required" } });
  const deliveryId = crypto.randomUUID();
  expect((await sendPersonalWebhook(deliveryId)).status).toBe(202);
  expect((await reconcilePersonal(deliveryId)).status).toBe(200);
  expect((await signedMeasurement("/v1/measurement/bridge", attestation())).status).toBe(201);
}

async function seedMergedCanonicalCohort(
  insertionOrder: "source-first" | "target-first"
): Promise<{ firstTrue: string; outsideTrueWindow: string }> {
  const target = `mind_${"1".repeat(64)}`;
  const source = `mind_${"2".repeat(64)}`;
  const targetInstallation = 990_001;
  const sourceInstallation = 990_002;
  const firstTrue = "2026-01-01T00:01:00.000Z";
  const sameDayLater = "2026-01-01T23:59:00.000Z";
  const outsideTrueWindow = "2026-03-02T12:00:00.000Z";
  const seedAt = "2025-12-31T00:00:00.000Z";
  const mergeAt = "2026-01-02T00:00:00.000Z";
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_identities
        (subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256,
         token_key_id, classification, classification_basis, first_authenticated_at,
         classification_attested_at, eligible_at, status, merged_at, updated_at)
       VALUES (?1, ?1, 'USER_TARGET_METRIC', ?2, 'individual-identity-key-v1', 'external',
         'provider_session_and_non_operator_registry', ?3, ?3, ?3, 'active', NULL, ?3)`
    ).bind(target, "3".repeat(64), seedAt),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_identities
        (subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256,
         token_key_id, classification, classification_basis, first_authenticated_at,
         classification_attested_at, eligible_at, status, merged_at, updated_at)
       VALUES (?1, ?2, 'USER_SOURCE_METRIC', ?3, 'individual-identity-key-v1', 'external',
         'provider_session_and_non_operator_registry', ?4, ?4, NULL, 'merged', ?5, ?5)`
    ).bind(source, target, "4".repeat(64), seedAt, mergeAt),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO individual_consents
        (subject_token, opted_in, updated_session_sha256, opted_in_at, opted_out_at, updated_at)
       VALUES (?1, 1, ?2, ?3, NULL, ?3)`
    ).bind(target, "5".repeat(64), seedAt),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_personal_installation_claims
        (installation_id, github_account_node_id, subject_token, account_type, status,
         claimed_session_sha256, claimed_at, updated_at)
       VALUES (?1, 'USER_TARGET_METRIC', ?2, 'User', 'bound', ?3, ?4, ?4)`
    ).bind(targetInstallation, target, "6".repeat(64), seedAt),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_personal_installation_claims
        (installation_id, github_account_node_id, subject_token, account_type, status,
         claimed_session_sha256, claimed_at, updated_at)
       VALUES (?1, 'USER_SOURCE_METRIC', ?2, 'User', 'revoked', ?3, ?4, ?4)`
    ).bind(sourceInstallation, source, "7".repeat(64), seedAt),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_personal_installations
        (installation_id, app_id, github_account_node_id, subject_token, account_type, state,
         repository_selection, last_event_created_at, last_delivery_id, last_reconciliation_id,
         installed_at, reconciled_at, updated_at)
       VALUES (?1, ?2, 'USER_TARGET_METRIC', ?3, 'User', 'active', 'all', 1,
         'metric_target_delivery', 'metric_target_recon', ?4, ?4, ?4)`
    ).bind(targetInstallation, APP_ID, target, seedAt),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO github_personal_installations
        (installation_id, app_id, github_account_node_id, subject_token, account_type, state,
         repository_selection, last_event_created_at, last_delivery_id, last_reconciliation_id,
         installed_at, deleted_at, reconciled_at, updated_at)
       VALUES (?1, ?2, 'USER_SOURCE_METRIC', ?3, 'User', 'deleted', 'all', 1,
         'metric_source_delivery', NULL, ?4, ?5, NULL, ?5)`
    ).bind(sourceInstallation, APP_ID, source, seedAt, mergeAt)
  ]);

  const sameDayRows = [
    ["metric_source_early", source, sourceInstallation, firstTrue] as const,
    ["metric_target_late", target, targetInstallation, sameDayLater] as const
  ];
  if (insertionOrder === "target-first") sameDayRows.reverse();
  const eventRows = [
    ...sameDayRows,
    ["metric_target_second", target, targetInstallation, outsideTrueWindow] as const
  ];
  for (const [id, subject, installation, occurredAt] of eventRows) {
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO individual_measurement_bridge_messages
          (message_id, payload_sha256, message_kind, subject_token, installation_id,
           observed_at, result, received_at)
         VALUES (?1, ?2, 'individual_activation_v1', ?3, ?4, ?5, 'applied', ?5)`
      ).bind(id, "9".repeat(64), subject, installation, occurredAt),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO individual_measurement_events
          (event_id, subject_token, installation_id, event_name, event_day, occurred_at,
           release_version, release_commit_sha, release_channel, verdict, receipt_sha256)
         VALUES (?1, ?2, ?3, 'individual_activation_v1', substr(?4, 1, 10), ?4,
           '0.16.0', ?5, 'github_app', 'SAFE', ?6)`
      ).bind(id, subject, installation, occurredAt, RELEASE_COMMIT, RECEIPT_SHA256)
    ]);
  }
  return { firstTrue, outsideTrueWindow };
}

describe("R0 individual measurement lane", () => {
  beforeEach(clearDatabase);

  it("requires independent human session, account.type=User reconciliation, exact verifier proof, and daily dedupe", async () => {
    const wrongAudience = await individualSession({ audience: "another-control-plane" });
    const rejectedAudience = await individualApi("/v1/individual/measurement", wrongAudience);
    expect(rejectedAudience.status).toBe(401);
    expect(await rejectedAudience.json()).toMatchObject({ error: { code: "invalid_individual_session" } });

    const token = await individualSession();
    await initializeEligibleIndividual(token);

    const mismatchedSession = await individualSession({ sub: "github_oidc_attacker_same_node" });
    const mismatched = await individualApi("/v1/individual/measurement", mismatchedSession);
    expect(mismatched.status).toBe(409);
    expect(await mismatched.json()).toMatchObject({ error: { code: "individual_identity_collision" } });

    const wrongRelease = await signedMeasurement(
      "/v1/measurement/bridge",
      activation({ verifier_release_commit_sha: "f".repeat(40) })
    );
    expect(wrongRelease.status).toBe(409);
    expect(await wrongRelease.json()).toMatchObject({ error: { code: "individual_verifier_release_mismatch" } });

    const callerIdentity = await signedMeasurement(
      "/v1/measurement/bridge",
      activation({ github_account_node_id: ACCOUNT_NODE_ID })
    );
    expect(callerIdentity.status).toBe(400);
    expect(await callerIdentity.json()).toMatchObject({ error: { code: "unexpected_field" } });

    const firstId = "individual_activation_first";
    const first = activation({ message_id: firstId });
    expect((await signedMeasurement("/v1/measurement/bridge", first)).status).toBe(201);
    const replay = await signedMeasurement("/v1/measurement/bridge", first);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true, counted: true });
    const sameDay = await signedMeasurement("/v1/measurement/bridge", activation());
    expect(sameDay.status).toBe(202);
    expect(await sameDay.json()).toMatchObject({ counted: false, result: "ignored_duplicate_day" });

    const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_measurement_events SET occurred_at = ?1, event_day = substr(?1, 1, 10)
        WHERE event_id = ?2`
    )
      .bind(old, firstId)
      .run();
    const secondId = "individual_activation_second";
    expect(
      (
        await signedMeasurement(
          "/v1/measurement/bridge",
          activation({ message_id: secondId })
        )
      ).status
    ).toBe(201);
    const repeatedAt = new Date(Date.now() - 60 * 86_400_000).toISOString();
    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE individual_measurement_events SET occurred_at = ?1, event_day = substr(?1, 1, 10)
        WHERE event_id = ?2`
    )
      .bind(repeatedAt, secondId)
      .run();

    const report = await signedMeasurement("/v1/measurement/report", {
      schema_version: "r0-measurement-report-request-v1",
      query_id: `individual_report_${crypto.randomUUID()}`,
      observed_at: new Date().toISOString()
    });
    expect(report.status).toBe(200);
    const reportBody = await report.json<Record<string, unknown>>();
    expect(reportBody.individuals).toMatchObject({
      identity_status: "AUTHENTICATED_GITHUB_OIDC_AND_RECONCILED_PERSONAL_APP",
      evidence_status: "BOUNDED_GATE_EVIDENCE",
      eligible_installations: 1,
      currently_active_installations: 1,
      activated_individuals: 1,
      matured_activated_individuals: 1,
      repeated_individuals_within_60_days: 1,
      matured_repeat_rate: 1
    });
  });

  it("supports signed auth-subject rotation and provider merge without accepting stale identities", async () => {
    expect((await signedMeasurement("/v1/measurement/bridge", boundary())).status).toBe(201);
    const primary = await individualSession();
    expect(
      (
        await individualApi("/v1/individual/measurement-consent", primary, {
          method: "PUT",
          body: { schema_version: "r0-individual-measurement-consent-v1", opted_in: true }
        })
      ).status
    ).toBe(200);
    const priorHash = await sha256Hex(`${SESSION_ISSUER}:github_oidc_user_primary`);
    const newHash = await sha256Hex(`${SESSION_ISSUER}:github_oidc_user_rotated`);
    const rotation = await signedMeasurement("/v1/measurement/bridge", {
      schema_version: "r0-measurement-bridge-v1",
      message_id: `individual_rotation_${crypto.randomUUID()}`,
      message_kind: "individual_auth_subject_rotation_v1",
      observed_at: new Date(Date.now() + 500).toISOString(),
      github_account_node_id: ACCOUNT_NODE_ID,
      prior_auth_subject_sha256: priorHash,
      new_auth_subject_sha256: newHash
    });
    expect(rotation.status).toBe(201);
    expect((await individualApi("/v1/individual/measurement", primary)).status).toBe(409);
    const rotated = await individualSession({ sub: "github_oidc_user_rotated" });
    expect((await individualApi("/v1/individual/measurement", rotated)).status).toBe(200);

    const sourceNode = "USER_NODE_MERGE_SOURCE_123";
    const source = await individualSession({ sub: "github_oidc_merge_source", accountNodeId: sourceNode });
    expect(
      (
        await individualApi("/v1/individual/measurement-consent", source, {
          method: "PUT",
          body: { schema_version: "r0-individual-measurement-consent-v1", opted_in: true }
        })
      ).status
    ).toBe(200);
    const merge = await signedMeasurement("/v1/measurement/bridge", {
      schema_version: "r0-measurement-bridge-v1",
      message_id: `individual_merge_${crypto.randomUUID()}`,
      message_kind: "individual_identity_merge_v1",
      observed_at: new Date(Date.now() + 1_500).toISOString(),
      source_github_account_node_id: sourceNode,
      target_github_account_node_id: ACCOUNT_NODE_ID,
      provider_merge_reference_sha256: "b".repeat(64)
    });
    expect(merge.status).toBe(201);
    expect((await individualApi("/v1/individual/measurement", source)).status).toBe(409);
    const merged = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status, canonical_subject_token FROM individual_identities WHERE github_account_node_id = ?1`
    )
      .bind(sourceNode)
      .first<{ status: string; canonical_subject_token: string }>();
    expect(merged?.status).toBe("merged");
    expect(merged?.canonical_subject_token).toMatch(/^mind_[a-f0-9]{64}$/u);
  });

  it("uses the earliest canonical alias event deterministically for the 60-day cohort", async () => {
    for (const insertionOrder of ["target-first", "source-first"] as const) {
      await clearDatabase();
      expect((await signedMeasurement("/v1/measurement/bridge", boundary())).status).toBe(201);
      const { firstTrue, outsideTrueWindow } = await seedMergedCanonicalCohort(insertionOrder);
      const canonicalDay = await env.TEAM_CONTROL_DB.prepare(
        `SELECT MIN(e.occurred_at) AS first_at
           FROM individual_measurement_events e
           JOIN individual_identities i ON i.subject_token = e.subject_token
          WHERE i.canonical_subject_token = ?1 AND e.event_day = '2026-01-01'`
      )
        .bind(`mind_${"1".repeat(64)}`)
        .first<{ first_at: string }>();
      expect(canonicalDay?.first_at).toBe(firstTrue);
      expect(Date.parse(outsideTrueWindow)).toBeGreaterThan(Date.parse(firstTrue) + 60 * 86_400_000);

      const report = await signedMeasurement("/v1/measurement/report", {
        schema_version: "r0-measurement-report-request-v1",
        query_id: `merged_alias_report_${insertionOrder}`,
        observed_at: new Date().toISOString()
      });
      expect(report.status).toBe(200);
      expect(await report.json()).toMatchObject({
        individuals: {
          activated_individuals: 1,
          matured_activated_individuals: 1,
          repeated_individuals_within_60_days: 0,
          matured_repeat_rate: 0
        }
      });
    }
  });

  it("keeps privacy export and erasure available during an unrelated measurement-secret collision", async () => {
    const token = await individualSession();
    await initializeEligibleIndividual(token);
    const activationId = "privacy_collision_activation";
    expect(
      (
        await signedMeasurement(
          "/v1/measurement/bridge",
          activation({ message_id: activationId })
        )
      ).status
    ).toBe(201);

    const collidedEnv = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "TEAM_SESSION_HMAC_SECRET") return IDENTITY_SECRET;
        return Reflect.get(target, property, receiver);
      }
    });
    const blockedMeasurement = await individualApiWithEnv("/v1/individual/measurement", token, collidedEnv);
    expect(blockedMeasurement.status).toBe(503);
    expect(await blockedMeasurement.json()).toMatchObject({
      error: { code: "r0_measurement_secret_configuration_invalid" }
    });

    const exported = await individualApiWithEnv("/v1/individual/privacy/export", token, collidedEnv);
    expect(exported.status).toBe(200);
    const exportBody = await exported.json<Record<string, unknown>>();
    const exportJson = JSON.stringify(exportBody);
    expect(exportJson).toContain(ACCOUNT_NODE_ID);
    expect(exportJson).toContain("mind_");
    expect(exportJson).not.toContain("must-never-be-stored");
    const subject = await env.TEAM_CONTROL_DB.prepare(
      `SELECT subject_token, auth_subject_sha256 FROM individual_identities WHERE github_account_node_id = ?1`
    )
      .bind(ACCOUNT_NODE_ID)
      .first<{ subject_token: string; auth_subject_sha256: string }>();
    expect(subject?.subject_token).toMatch(/^mind_[a-f0-9]{64}$/u);

    const deletionRequest = await individualApiWithEnv(
      "/v1/individual/privacy/deletion-requests",
      token,
      collidedEnv,
      {
        method: "POST",
        body: { schema_version: "individual-deletion-request-v1" }
      }
    );
    expect(deletionRequest.status).toBe(202);
    const deletion = await deletionRequest.json<{ confirmation: string }>();
    const confirmed = await individualApiWithEnv(
      "/v1/individual/privacy/data",
      token,
      collidedEnv,
      {
        method: "DELETE",
        headers: { "X-Deletion-Confirmation": deletion.confirmation },
        body: { schema_version: "individual-deletion-confirmation-v1" }
      }
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ deleted: true, access_revoked: true });

    const residuals = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM individual_identities) AS identities,
        (SELECT COUNT(*) FROM individual_consents) AS consents,
        (SELECT COUNT(*) FROM github_personal_installation_claims WHERE installation_id = ?1) AS claims,
        (SELECT COUNT(*) FROM github_personal_installations WHERE installation_id = ?1) AS installations,
        (SELECT COUNT(*) FROM github_personal_deliveries WHERE installation_id = ?1) AS deliveries,
        (SELECT COUNT(*) FROM github_personal_installation_reconciliations WHERE installation_id = ?1) AS reconciliations,
        (SELECT COUNT(*) FROM github_deliveries WHERE installation_id = ?1) AS organization_deliveries,
        (SELECT COUNT(*) FROM individual_measurement_events) AS events,
        (SELECT COUNT(*) FROM individual_measurement_bridge_messages) AS messages,
        (SELECT COUNT(*) FROM individual_audit_events) AS audits`
    )
      .bind(INSTALLATION_ID)
      .first<Record<string, number>>();
    expect(residuals).toEqual({
      identities: 0,
      consents: 0,
      claims: 0,
      installations: 0,
      deliveries: 0,
      reconciliations: 0,
      organization_deliveries: 0,
      events: 0,
      messages: 0,
      audits: 0
    });
    const deletionRows = await env.TEAM_CONTROL_DB.prepare(
      `SELECT subject_token, confirmation_sha256, requested_session_sha256, status
         FROM individual_privacy_deletion_requests`
    ).all<Record<string, unknown>>();
    const retainedJson = JSON.stringify(deletionRows.results);
    expect(retainedJson).not.toContain(ACCOUNT_NODE_ID);
    expect(retainedJson).not.toContain(String(INSTALLATION_ID));
    expect(retainedJson).not.toContain(subject?.subject_token ?? "mind_missing");
    expect(retainedJson).not.toContain(subject?.auth_subject_sha256 ?? "hash_missing");
    expect(retainedJson).not.toContain("mind_");
    expect(deletionRows.results).toHaveLength(1);
    expect(deletionRows.results[0]).toMatchObject({ status: "completed" });

    const databaseText = await allApplicationRowsText();
    for (const erased of [
      ACCOUNT_NODE_ID,
      String(INSTALLATION_ID),
      subject?.subject_token ?? "mind_missing",
      subject?.auth_subject_sha256 ?? "hash_missing",
      activationId,
      "provider_session_and_non_operator_registry"
    ]) {
      expect(databaseText).not.toContain(erased);
    }
    expect(databaseText).not.toContain("mind_");

    const postDeleteExport = await individualApiWithEnv(
      "/v1/individual/privacy/export",
      token,
      collidedEnv
    );
    expect(postDeleteExport.status).toBe(409);
    expect(await postDeleteExport.json()).toMatchObject({ error: { code: "individual_identity_not_bound" } });
  });
});
