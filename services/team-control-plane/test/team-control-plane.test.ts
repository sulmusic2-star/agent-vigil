import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { handleProviderReconciliation } from "../src/billing.ts";
import { base64UrlEncode, hmacBase64Url, hmacHex } from "../src/crypto.ts";

const ORIGIN = "https://team.example.test";
const SESSION_SECRET = "test-only-team-session-secret-32-bytes-minimum";
const WEBHOOK_SECRET = "test-only-stripe-webhook-secret-32-bytes-minimum";
const RECONCILIATION_SECRET = "test-only-reconciliation-secret-32-bytes-minimum";
const GITHUB_WEBHOOK_SECRET = "test-only-github-webhook-secret-32-bytes-minimum";
const GITHUB_RECONCILIATION_SECRET = "test-only-github-reconciliation-secret-32-bytes";
const GITHUB_APP_ID = 12_345;
const GITHUB_INSTALLATION_ID = 98_765;
const GITHUB_ACCOUNT_NODE_ID = "ACCT_NODE_MAIN_123";
const GITHUB_REPOSITORY_NODE_ID = "REPO_NODE_MAIN_123";

async function clearDatabase(): Promise<void> {
  await env.TEAM_CONTROL_DB.prepare(`DROP TRIGGER billing_generation_event_delete_guard`).run();
  try {
    await env.TEAM_CONTROL_DB.exec(`
    DELETE FROM workflow_integrity_receipts;
    DELETE FROM checkout_subscription_compensations;
    DELETE FROM github_installation_release_reconciliations;
    DELETE FROM individual_measurement_events;
    DELETE FROM individual_subject_attestations;
    DELETE FROM individual_auth_subject_rotations;
    DELETE FROM individual_identity_merges;
    DELETE FROM individual_measurement_bridge_messages;
    DELETE FROM github_personal_installation_reconciliations;
    DELETE FROM github_personal_deliveries;
    DELETE FROM github_personal_installations;
    DELETE FROM github_personal_installation_claims;
    DELETE FROM github_installation_provider_proofs;
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
    DELETE FROM provider_refund_applications;
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
    DELETE FROM billing_generation_events;
    DELETE FROM billing_generations;
    DELETE FROM audit_events;
    DELETE FROM rollback_records;
    DELETE FROM exception_records;
    DELETE FROM update_history;
    DELETE FROM policy_heads;
    DELETE FROM policy_revisions;
    DELETE FROM organization_members;
    DELETE FROM organizations;
    DELETE FROM github_installation_lifecycle_heads;
    `);
  } finally {
    await env.TEAM_CONTROL_DB.prepare(
      `CREATE TRIGGER billing_generation_event_delete_guard
       BEFORE DELETE ON billing_generation_events
       BEGIN
         SELECT RAISE(ABORT, 'billing generation history is append only');
       END`
    ).run();
  }
}

async function seedOrganization(orgId = "org_main"): Promise<void> {
  const at = new Date().toISOString();
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organizations (id, slug, display_name, status, created_at)
       VALUES (?1, ?2, ?3, 'active', ?4)`
    ).bind(orgId, `${orgId}-slug`, `${orgId} display`, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organization_members
        (org_id, user_id, role, identity_kind, active, created_at, updated_at)
       VALUES (?1, 'user_owner', 'owner', 'human', 1, ?2, ?2)`
    ).bind(orgId, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organization_members
        (org_id, user_id, role, identity_kind, active, created_at, updated_at)
       VALUES (?1, 'user_admin', 'admin', 'human', 1, ?2, ?2)`
    ).bind(orgId, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organization_members
        (org_id, user_id, role, identity_kind, active, created_at, updated_at)
       VALUES (?1, 'user_member', 'member', 'human', 1, ?2, ?2)`
    ).bind(orgId, at)
  ]);
}

async function session(orgId = "org_main", userId = "user_owner", issuedAt?: number): Promise<string> {
  const now = issuedAt ?? Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      schema_version: "team-session-v1",
      kid: "team-session-key-v1",
      sub: userId,
      org_id: orgId,
      jti: `session_${crypto.randomUUID()}`,
      iat: now,
      exp: now + 3600
    })
  );
  const input = `avteam_v1.${payload}`;
  return `${input}.${await hmacBase64Url(SESSION_SECRET, input)}`;
}

async function api(
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: object;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
}

async function json<T>(response: Response): Promise<T> {
  return response.json<T>();
}

function metadata(orgId: string, checkoutIntentId: string | null = null, billingGeneration = 1): Record<string, string> {
  return {
    team_org_id: orgId,
    internal_price_id: "team_monthly_usd_v1",
    provider_price_id: "price_team_monthly_test",
    billing_generation: String(billingGeneration),
    ...(checkoutIntentId ? { checkout_intent_id: checkoutIntentId } : {})
  };
}

async function stripeWebhook(input: {
  id: string;
  type: string;
  created: number;
  object: Record<string, unknown>;
}): Promise<Response> {
  const raw = JSON.stringify({
    id: input.id,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: input.created,
    livemode: false,
    type: input.type,
    data: { object: input.object }
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(WEBHOOK_SECRET, `${timestamp}.${raw}`);
  return exports.default.fetch(`${ORIGIN}/v1/billing/stripe/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": `t=${timestamp},v1=${signature}`
    },
    body: raw
  });
}

interface ReconciliationOverrides {
  reconciliation_id?: string;
  observed_at?: string;
  source_event_id?: string;
  kind?: "payment" | "payment_failure" | "refund" | "subscription";
  org_id?: string;
  provider_customer_id?: string;
  provider_subscription_id?: string;
  provider_object_id?: string;
  internal_price_id?: "team_monthly_usd_v1" | "team_annual_usd_v1";
  provider_price_id?: string;
  billing_generation?: number;
  provider_status?: "paid" | "failed" | "active" | "past_due" | "canceled" | "refunded";
  cash_amount_cents?: number;
  net_recurring_amount_cents?: number;
  refund_amount_cents?: number;
  period_start?: string;
  period_end?: string;
  cancel_at_period_end?: boolean;
  provider_refund_id?: string | null;
  provider_charge_id?: string | null;
  provider_payment_intent_id?: string | null;
  source_payment_event_id?: string | null;
  billing_command_id?: string | null;
  cumulative_refund_amount_cents?: number;
}

function reconciliation(overrides: ReconciliationOverrides = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    schema_version: "billing-reconciliation-v1",
    reconciliation_id: overrides.reconciliation_id ?? `recon_${crypto.randomUUID()}`,
    observed_at: overrides.observed_at ?? new Date(now).toISOString(),
    source_event_id: overrides.source_event_id ?? "evt_invoice_paid",
    kind: overrides.kind ?? "payment",
    org_id: overrides.org_id ?? "org_main",
    provider_customer_id: overrides.provider_customer_id ?? "cus_main",
    provider_subscription_id: overrides.provider_subscription_id ?? "sub_main",
    provider_object_id: overrides.provider_object_id ?? "in_main",
    internal_price_id: overrides.internal_price_id ?? "team_monthly_usd_v1",
    provider_price_id: overrides.provider_price_id ?? "price_team_monthly_test",
    billing_generation: overrides.billing_generation ?? 1,
    provider_status: overrides.provider_status ?? "paid",
    currency: "usd",
    cash_amount_cents: overrides.cash_amount_cents ?? 29_900,
    net_recurring_amount_cents: overrides.net_recurring_amount_cents ?? 29_900,
    refund_amount_cents: overrides.refund_amount_cents ?? 0,
    provider_refund_id: overrides.provider_refund_id ?? null,
    provider_charge_id: overrides.provider_charge_id ?? null,
    provider_payment_intent_id: overrides.provider_payment_intent_id ?? null,
    source_payment_event_id: overrides.source_payment_event_id ?? null,
    billing_command_id: overrides.billing_command_id ?? null,
    cumulative_refund_amount_cents: overrides.cumulative_refund_amount_cents ?? 0,
    period_start: overrides.period_start ?? new Date(now - 60_000).toISOString(),
    period_end: overrides.period_end ?? new Date(now + 30 * 86_400_000).toISOString(),
    cancel_at_period_end: overrides.cancel_at_period_end ?? false
  };
}

async function signedReconciliationRequest(body: Record<string, unknown>): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(RECONCILIATION_SECRET, `${timestamp}.${raw}`);
  return new Request(`${ORIGIN}/v1/billing/stripe/reconciliation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-Reconciliation-Signature": `t=${timestamp},v1=${signature}`
    },
    body: raw
  });
}

async function reconcile(body: Record<string, unknown>): Promise<Response> {
  return exports.default.fetch(await signedReconciliationRequest(body));
}

interface GitHubWebhookInput {
  deliveryId: string;
  event: "installation" | "installation_repositories";
  action: "created" | "deleted" | "suspend" | "unsuspend" | "added" | "removed";
  eventTime: string;
  repositorySelection?: "all" | "selected";
  addedRepositoryNodeIds?: string[];
  removedRepositoryNodeIds?: string[];
  appId?: number;
  installationId?: number;
  accountNodeId?: string;
  accountType?: "Organization" | "User";
}

function githubPayload(input: GitHubWebhookInput): string {
  const repositorySelection = input.repositorySelection ?? "selected";
  const installation = {
    id: input.installationId ?? GITHUB_INSTALLATION_ID,
    app_id: input.appId ?? GITHUB_APP_ID,
    account: {
      node_id: input.accountNodeId ?? GITHUB_ACCOUNT_NODE_ID,
      type: input.accountType ?? "Organization",
      login: "must-never-be-stored"
    },
    repository_selection: repositorySelection,
    created_at: input.eventTime,
    updated_at: input.eventTime,
    html_url: "https://github.example/must-never-be-stored"
  };
  const repository = (nodeId: string) => ({
    node_id: nodeId,
    name: "must-never-be-stored",
    full_name: "private/must-never-be-stored"
  });
  return JSON.stringify({
    action: input.action,
    installation,
    ...(input.event === "installation" && input.action === "created"
      ? { repositories: (input.addedRepositoryNodeIds ?? [GITHUB_REPOSITORY_NODE_ID]).map(repository) }
      : {}),
    ...(input.event === "installation_repositories"
      ? {
          repository_selection: repositorySelection,
          repositories_added: (input.addedRepositoryNodeIds ?? []).map(repository),
          repositories_removed: (input.removedRepositoryNodeIds ?? []).map(repository)
        }
      : {}),
    sender: { login: "must-never-be-stored" }
  });
}

async function sendGitHubWebhook(
  raw: string,
  event: GitHubWebhookInput["event"],
  deliveryId: string,
  secret = GITHUB_WEBHOOK_SECRET
): Promise<Response> {
  const signature = await hmacHex(secret, raw);
  return exports.default.fetch(`${ORIGIN}/v1/github/app/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": deliveryId,
      "X-Hub-Signature-256": `sha256=${signature}`
    },
    body: raw
  });
}

async function claimGitHubInstallation(owner: string, providerDeliveryId: string): Promise<Response> {
  return api("/v1/orgs/org_main/github/installation-claim", {
    method: "POST",
    token: owner,
    body: {
      schema_version: "github-installation-claim-v1",
      installation_id: GITHUB_INSTALLATION_ID,
      account_node_id: GITHUB_ACCOUNT_NODE_ID,
      provider_delivery_id: providerDeliveryId
    }
  });
}

function githubReconciliation(
  sourceDeliveryId: string,
  overrides: Partial<{
    reconciliation_id: string;
    account_node_id: string;
    account_type: "Organization" | "User";
    provider_status: "active" | "not_found";
    repository_selection: "all" | "selected";
    repository_node_ids: string[];
  }> = {}
): Record<string, unknown> {
  return {
    schema_version: "github-installation-reconciliation-v1",
    reconciliation_id: overrides.reconciliation_id ?? `github_recon_${crypto.randomUUID()}`,
    source_delivery_id: sourceDeliveryId,
    observed_at: new Date().toISOString(),
    app_id: GITHUB_APP_ID,
    installation_id: GITHUB_INSTALLATION_ID,
    account_node_id: overrides.account_node_id ?? GITHUB_ACCOUNT_NODE_ID,
    account_type: overrides.account_type ?? "Organization",
    provider_status: overrides.provider_status ?? "active",
    repository_selection: overrides.repository_selection ?? "selected",
    repository_node_ids: overrides.repository_node_ids ?? [GITHUB_REPOSITORY_NODE_ID]
  };
}

async function reconcileGitHub(body: Record<string, unknown>): Promise<Response> {
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

async function activateGitHubInstallation(owner: string, baseTime: number): Promise<{ deliveryId: string; serviceToken: string }> {
  const deliveryId = crypto.randomUUID();
  const raw = githubPayload({
    deliveryId,
    event: "installation",
    action: "created",
    eventTime: new Date(baseTime).toISOString()
  });
  expect((await sendGitHubWebhook(raw, "installation", deliveryId)).status).toBe(409);
  expect((await claimGitHubInstallation(owner, deliveryId)).status).toBe(201);
  expect((await sendGitHubWebhook(raw, "installation", deliveryId)).status).toBe(202);
  expect((await reconcileGitHub(githubReconciliation(deliveryId))).status).toBe(200);
  return {
    deliveryId,
    serviceToken: await session("org_main", `github-installation:${GITHUB_INSTALLATION_ID}`)
  };
}

async function acceptPreparedCheckout(checkoutIntentId: string, providerSessionId: string): Promise<number> {
  const checkout = await env.TEAM_CONTROL_DB.prepare(
    `SELECT billing_generation FROM checkout_intents WHERE id = ?1 AND org_id = 'org_main' AND status = 'prepared'`
  )
    .bind(checkoutIntentId)
    .first<{ billing_generation: number }>();
  expect(checkout).not.toBeNull();
  const generation = checkout!.billing_generation;
  const command = await env.TEAM_CONTROL_DB.prepare(
    `SELECT status,
            json_extract(command_json, '$.parameters.metadata.checkout_intent_id') AS checkout_intent_id,
            json_extract(command_json, '$.parameters.metadata.billing_generation') AS billing_generation
       FROM billing_commands
      WHERE org_id = 'org_main' AND command_type = 'create_checkout_session'
        AND status = 'prepared'
        AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?1`
  )
    .bind(checkoutIntentId)
    .first<{ status: string; checkout_intent_id: string; billing_generation: string }>();
  expect(command).toEqual({ status: "prepared", checkout_intent_id: checkoutIntentId, billing_generation: String(generation) });
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE checkout_intents SET status = 'provider_created', provider_session_id = ?1
        WHERE id = ?2 AND org_id = 'org_main' AND billing_generation = ?3 AND status = 'prepared'`
    ).bind(providerSessionId, checkoutIntentId, generation),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_generations SET provider_checkout_session_id = ?1
        WHERE org_id = 'org_main' AND generation = ?2 AND checkout_intent_id = ?3
          AND status = 'reserved' AND provider_checkout_session_id IS NULL`
    ).bind(providerSessionId, generation, checkoutIntentId),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_commands
          SET status = 'provider_accepted',
              command_json = json_set(command_json, '$.provider_result', json_object('session_id', ?1))
        WHERE org_id = 'org_main' AND command_type = 'create_checkout_session' AND status = 'prepared'
          AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?2`
    ).bind(providerSessionId, checkoutIntentId)
  ]);
  expect(results.map((result) => result.meta.changes ?? 0)).toEqual([1, 1, 1]);
  return generation;
}

async function prepareAndCompleteCheckout(
  internalPriceId: "team_monthly_usd_v1" | "team_annual_usd_v1",
  providerSessionId: string,
  eventId: string,
  eventCreated: number
): Promise<void> {
  const owner = await session();
  const checkoutResponse = await api("/v1/orgs/org_main/billing/checkout", {
    method: "POST",
    token: owner,
    headers: { "Idempotency-Key": `checkout_fixture_${eventId}` },
    body: { internal_price_id: internalPriceId }
  });
  expect(checkoutResponse.status).toBe(202);
  const checkout = await json<{
    checkout_intent_id: string;
    command: { parameters: { metadata: Record<string, string> } };
  }>(checkoutResponse);
  await acceptPreparedCheckout(checkout.checkout_intent_id, providerSessionId);
  const completed = await stripeWebhook({
    id: eventId,
    type: "checkout.session.completed",
    created: eventCreated,
    object: {
      id: providerSessionId,
      mode: "subscription",
      customer: "cus_main",
      subscription: "sub_main",
      metadata: checkout.command.parameters.metadata
    }
  });
  expect(completed.status).toBe(200);
}

async function activateMonthlyTeam(eventCreated: number): Promise<void> {
  await prepareAndCompleteCheckout("team_monthly_usd_v1", "cs_main", "evt_checkout_fixture", eventCreated - 1);
  const paidEvent = await stripeWebhook({
    id: "evt_invoice_paid",
    type: "invoice.paid",
    created: eventCreated,
    object: {
      id: "in_main",
      customer: "cus_main",
      subscription: "sub_main",
      metadata: metadata("org_main")
    }
  });
  expect(paidEvent.status).toBe(200);
  const reconciled = await reconcile(reconciliation());
  expect(reconciled.status).toBe(200);
}

describe.sequential("Team control plane", () => {
  beforeEach(async () => {
    await clearDatabase();
    await seedOrganization();
  });

  it("enforces authenticated tenant membership and ignores role claims", async () => {
    const health = await api("/healthz");
    expect(health.status).toBe(200);
    const catalog = await api("/v1/catalog");
    expect(catalog.status).toBe(200);
    expect(await json(catalog)).toMatchObject({ tier: "team", contributor_limit: 15, currency: "usd" });

    const missing = await api("/v1/orgs/org_main");
    expect(missing.status).toBe(401);

    const owner = await session();
    const organization = await api("/v1/orgs/org_main", { token: owner });
    expect(organization.status).toBe(200);
    expect(await json(organization)).toMatchObject({ membership: { role: "owner" } });

    const crossTenant = await api("/v1/orgs/org_main", { token: await session("org_other") });
    expect(crossTenant.status).toBe(403);

    const expired = await api("/v1/orgs/org_main", {
      token: await session("org_main", "user_owner", Math.floor(Date.now() / 1000) - 7200)
    });
    expect(expired.status).toBe(401);
  });

  it("serializes distinct checkout idempotency keys into one live workflow and pseudonymizes its actor", async () => {
    const owner = await session();
    const create = (idempotencyKey: string) =>
      api("/v1/orgs/org_main/billing/checkout", {
        method: "POST",
        token: owner,
        headers: { "Idempotency-Key": idempotencyKey },
        body: { internal_price_id: "team_monthly_usd_v1" }
      });
    const responses = await Promise.all([create("checkout_race_a"), create("checkout_race_b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM checkout_intents
           WHERE org_id = 'org_main'
             AND status IN ('prepared', 'executing', 'provider_created', 'compensating')) AS live_intents,
         (SELECT COUNT(*) FROM billing_commands
           WHERE org_id = 'org_main' AND command_type = 'create_checkout_session'
             AND status IN ('prepared', 'executing', 'provider_accepted', 'compensating')) AS live_commands,
         (SELECT created_by FROM checkout_intents WHERE org_id = 'org_main') AS actor`
    ).first<{ live_intents: number; live_commands: number; actor: string }>();
    expect(state).toMatchObject({ live_intents: 1, live_commands: 1 });
    expect(state?.actor).toMatch(/^userp_[a-f0-9]{64}$/u);
    expect(state?.actor).not.toContain("user_owner");
  });

  it("refuses checkout completion during deletion freeze and preserves the compensation block", async () => {
    const owner = await session();
    const prepared = await api("/v1/orgs/org_main/billing/checkout", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "checkout_completion_deletion_race" },
      body: { internal_price_id: "team_monthly_usd_v1" }
    });
    expect(prepared.status).toBe(202);
    const preparedBody = await prepared.json<{ command_id: string; checkout_intent_id: string }>();
    const commandRow = await env.TEAM_CONTROL_DB.prepare(
      `SELECT command_json FROM billing_commands WHERE id = ?1`
    )
      .bind(preparedBody.command_id)
      .first<{ command_json: string }>();
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE checkout_intents SET status = 'provider_created', provider_session_id = 'cs_frozen'
          WHERE id = ?1 AND status = 'prepared'`
      ).bind(preparedBody.checkout_intent_id),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE billing_commands SET status = 'provider_accepted', command_json = ?1
          WHERE id = ?2 AND status = 'prepared'`
      ).bind(
        JSON.stringify({ ...JSON.parse(commandRow!.command_json), provider_result: { session_id: "cs_frozen" } }),
        preparedBody.command_id
      )
    ]);

    const deletion = await api("/v1/orgs/org_main/privacy/deletion-requests", {
      method: "POST",
      token: owner
    });
    expect(deletion.status).toBe(202);
    const deletionBody = await deletion.json<{ confirmation: string }>();
    await expect(
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE checkout_intents SET status = 'completed' WHERE id = ?1 AND status = 'compensating'`
      )
        .bind(preparedBody.checkout_intent_id)
        .run()
    ).rejects.toThrow(/checkout completion targets non-active organization/u);
    const completion = await stripeWebhook({
      id: "evt_checkout_completed_during_deletion",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      object: {
        id: "cs_frozen",
        mode: "subscription",
        customer: "cus_frozen",
        subscription: "sub_frozen",
        metadata: metadata("org_main", preparedBody.checkout_intent_id)
      }
    });
    expect(completion.status).toBe(409);
    expect(await completion.json()).toMatchObject({ error: { code: "checkout_completion_frozen_for_deletion" } });

    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT status FROM organizations WHERE id = 'org_main') AS org_status,
         (SELECT status FROM checkout_intents WHERE id = ?1) AS checkout_status,
         (SELECT compensation_customer_id FROM checkout_intents WHERE id = ?1) AS compensation_customer_id,
         (SELECT compensation_subscription_id FROM checkout_intents WHERE id = ?1) AS compensation_subscription_id,
         (SELECT status FROM billing_commands WHERE id = ?2) AS command_status,
         (SELECT status FROM provider_events WHERE event_id = 'evt_checkout_completed_during_deletion') AS event_status,
         (SELECT COUNT(*) FROM billing_accounts
           WHERE org_id = 'org_main' AND provider_subscription_id IS NOT NULL) AS provider_bindings,
         (SELECT COUNT(*) FROM commercial_transitions
           WHERE org_id = 'org_main' AND source_ref = 'evt_checkout_completed_during_deletion') AS transitions,
         (SELECT COUNT(*) FROM lifecycle_events
           WHERE org_id = 'org_main' AND source_ref IN (?1, 'cs_frozen')) AS lifecycle,
         (SELECT COUNT(*) FROM audit_events
           WHERE org_id = 'org_main' AND action = 'billing.checkout.confirmed'
             AND resource_id = 'evt_checkout_completed_during_deletion') AS confirmation_audits`
    )
      .bind(preparedBody.checkout_intent_id, preparedBody.command_id)
      .first<Record<string, unknown>>();
    expect(state).toEqual({
      org_status: "deletion_pending",
      checkout_status: "compensating",
      compensation_customer_id: "cus_frozen",
      compensation_subscription_id: "sub_frozen",
      command_status: "compensating",
      event_status: "rejected",
      provider_bindings: 0,
      transitions: 0,
      lifecycle: 0,
      confirmation_audits: 0
    });

    const confirmed = await api("/v1/orgs/org_main/privacy/data", {
      method: "DELETE",
      token: owner,
      headers: { "X-Deletion-Confirmation": deletionBody.confirmation }
    });
    expect(confirmed.status).toBe(409);
    expect(await confirmed.json()).toMatchObject({ error: { code: "provider_cleanup_incomplete" } });
  });

  it("reserves an unexpected completed Checkout Session for cancellation without binding a second subscription", async () => {
    const owner = await session();
    const prepared = await api("/v1/orgs/org_main/billing/checkout", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "checkout_unexpected_session" },
      body: { internal_price_id: "team_monthly_usd_v1" }
    });
    expect(prepared.status).toBe(202);
    const body = await prepared.json<{
      command_id: string;
      checkout_intent_id: string;
      command: { parameters: { metadata: Record<string, string> } };
    }>();
    expect(await acceptPreparedCheckout(body.checkout_intent_id, "cs_expected")).toBe(1);

    const unexpected = await stripeWebhook({
      id: "evt_checkout_unexpected",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      object: {
        id: "cs_unexpected",
        mode: "subscription",
        customer: "cus_unexpected",
        subscription: "sub_unexpected",
        metadata: body.command.parameters.metadata
      }
    });
    expect(unexpected.status).toBe(409);
    expect(await unexpected.json()).toMatchObject({ error: { code: "checkout_completion_requires_compensation" } });
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT g.status AS generation_status,
              g.provider_checkout_session_id, g.provider_customer_id, g.provider_subscription_id,
              i.status AS intent_status, i.provider_session_id AS expected_session_id,
              c.status AS command_status,
              x.status AS compensation_status, x.provider_session_id AS unexpected_session_id,
              x.provider_customer_id AS unexpected_customer_id,
              x.provider_subscription_id AS unexpected_subscription_id,
              (SELECT COUNT(*) FROM billing_accounts WHERE org_id = 'org_main'
                AND provider_subscription_id IS NOT NULL) AS installed_subscriptions,
              (SELECT COUNT(*) FROM checkout_subscription_compensations
                WHERE billing_command_id = c.id AND status IN ('prepared', 'executing')) AS live_compensations
         FROM billing_generations g
         JOIN checkout_intents i ON i.id = g.checkout_intent_id
         JOIN billing_commands c
           ON json_extract(c.command_json, '$.parameters.metadata.checkout_intent_id') = i.id
         JOIN checkout_subscription_compensations x ON x.billing_command_id = c.id
        WHERE g.org_id = 'org_main' AND g.generation = 1`
    ).first<Record<string, unknown>>();
    expect(state).toEqual({
      generation_status: "reserved",
      provider_checkout_session_id: "cs_expected",
      provider_customer_id: null,
      provider_subscription_id: null,
      intent_status: "provider_created",
      expected_session_id: "cs_expected",
      command_status: "compensating",
      compensation_status: "prepared",
      unexpected_session_id: "cs_unexpected",
      unexpected_customer_id: "cus_unexpected",
      unexpected_subscription_id: "sub_unexpected",
      installed_subscriptions: 0,
      live_compensations: 1
    });
    const replay = await stripeWebhook({
      id: "evt_checkout_unexpected",
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      object: {
        id: "cs_unexpected",
        mode: "subscription",
        customer: "cus_unexpected",
        subscription: "sub_unexpected",
        metadata: body.command.parameters.metadata
      }
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ duplicate: true });
  });

  it("compensates an unexpected Checkout Session delivered after a newer reconciled billing event", async () => {
    const created = Math.floor(Date.now() / 1000);
    await activateMonthlyTeam(created);
    const checkout = await env.TEAM_CONTROL_DB.prepare(
      `SELECT id, billing_generation FROM checkout_intents
        WHERE org_id = 'org_main' AND provider_session_id = 'cs_main' AND status = 'completed'`
    ).first<{ id: string; billing_generation: number }>();
    expect(checkout).toMatchObject({ billing_generation: 1 });

    const unexpected = await stripeWebhook({
      id: "evt_checkout_unexpected_after_payment",
      type: "checkout.session.completed",
      created: created - 1,
      object: {
        id: "cs_unexpected_after_payment",
        mode: "subscription",
        customer: "cus_unexpected_after_payment",
        subscription: "sub_unexpected_after_payment",
        metadata: metadata("org_main", checkout!.id, checkout!.billing_generation)
      }
    });
    expect(unexpected.status).toBe(409);
    expect(await unexpected.json()).toMatchObject({ error: { code: "checkout_completion_requires_compensation" } });
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT a.billing_generation, a.provider_customer_id, a.provider_subscription_id,
              e.status AS entitlement_status, e.source_event_id,
              x.status AS compensation_status, x.provider_subscription_id AS unexpected_subscription_id,
              p.status AS provider_event_status
         FROM billing_accounts a
         JOIN entitlements e ON e.org_id = a.org_id
         JOIN checkout_subscription_compensations x ON x.org_id = a.org_id
         JOIN provider_events p ON p.event_id = x.provider_event_id
        WHERE a.org_id = 'org_main'`
    ).first<Record<string, unknown>>();
    expect(state).toEqual({
      billing_generation: 1,
      provider_customer_id: "cus_main",
      provider_subscription_id: "sub_main",
      entitlement_status: "active",
      source_event_id: "evt_invoice_paid",
      compensation_status: "prepared",
      unexpected_subscription_id: "sub_unexpected_after_payment",
      provider_event_status: "rejected"
    });
  });

  it("atomically issues only one deletion confirmation under concurrent owner requests", async () => {
    const owner = await session();
    const responses = await Promise.all([
      api("/v1/orgs/org_main/privacy/deletion-requests", { method: "POST", token: owner }),
      api("/v1/orgs/org_main/privacy/deletion-requests", { method: "POST", token: owner })
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses[0]).toBe(202);
    expect([403, 409]).toContain(statuses[1]);
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT status FROM organizations WHERE id = 'org_main') AS org_status,
         (SELECT COUNT(*) FROM privacy_deletion_requests
           WHERE org_id = 'org_main' AND status = 'pending') AS pending_requests,
         (SELECT COUNT(*) FROM audit_events
           WHERE org_id = 'org_main' AND action = 'privacy.deletion.requested') AS request_audits,
         (SELECT requested_by FROM privacy_deletion_requests
           WHERE org_id = 'org_main' AND status = 'pending') AS actor`
    ).first<Record<string, unknown>>();
    expect(state).toMatchObject({ org_status: "deletion_pending", pending_requests: 1, request_audits: 1 });
    expect(state?.actor).toMatch(/^userp_[a-f0-9]{64}$/u);
  });

  it("keeps checkout and webhook state separate from paid entitlement and recognized MRR", async () => {
    const owner = await session();
    const checkout = await api("/v1/orgs/org_main/billing/checkout", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "checkout_test_1" },
      body: { internal_price_id: "team_monthly_usd_v1" }
    });
    expect(checkout.status).toBe(202);
    const checkoutBody = await json<{
      checkout_intent_id: string;
      command: { operation: string; parameters: { provider_price_id: string } };
    }>(checkout);
    expect(checkoutBody.command).toMatchObject({
      operation: "create_checkout_session",
      parameters: { provider_price_id: "price_team_monthly_test" }
    });
    const idempotencyMismatch = await api("/v1/orgs/org_main/billing/checkout", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "checkout_test_1" },
      body: { internal_price_id: "team_annual_usd_v1" }
    });
    expect(idempotencyMismatch.status).toBe(409);

    let ledger = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(ledger)).toMatchObject({ entitlement: null, recognized_mrr: { minor_unit_micros: 0 } });

    const created = Math.floor(Date.now() / 1000);
    await acceptPreparedCheckout(checkoutBody.checkout_intent_id, "cs_main");
    const completedCheckout = await stripeWebhook({
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
      created,
      object: {
        id: "cs_main",
        mode: "subscription",
        customer: "cus_main",
        subscription: "sub_main",
        metadata: metadata("org_main", checkoutBody.checkout_intent_id)
      }
    });
    expect(completedCheckout.status).toBe(200);

    const webhook = await stripeWebhook({
      id: "evt_invoice_paid",
      type: "invoice.paid",
      created: created + 1,
      object: {
        id: "in_main",
        customer: "cus_main",
        metadata: { team_org_id: "org_spoofed" },
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_main",
            metadata: metadata("org_main")
          }
        }
      }
    });
    expect(webhook.status).toBe(200);
    ledger = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(ledger)).toMatchObject({ entitlement: null, recognized_mrr: { minor_unit_micros: 0 } });

    const snapshot = reconciliation();
    const applied = await reconcile(snapshot);
    expect(applied.status).toBe(200);
    ledger = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(ledger)).toMatchObject({
      billing_state: "entitled",
      entitlement: { tier: "team", status: "active", contributor_limit: 15 },
      recognized_mrr: { minor_unit_micros: 29_900_000_000 },
      cash_ledger: [{ entry_type: "payment", amount_cents: 29_900 }]
    });

    const duplicateSnapshot = await reconcile(snapshot);
    expect(duplicateSnapshot.status).toBe(200);
    expect(await json(duplicateSnapshot)).toMatchObject({ duplicate: true });
    const duplicateEvent = await stripeWebhook({
      id: "evt_invoice_paid",
      type: "invoice.paid",
      created: created + 1,
      object: {
        id: "in_main",
        customer: "cus_main",
        metadata: { team_org_id: "org_spoofed" },
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_main",
            metadata: metadata("org_main")
          }
        }
      }
    });
    expect(await json(duplicateEvent)).toMatchObject({ duplicate: true });
  });

  it("fails closed on plan substitution, event-id payload reuse, and stale ordering", async () => {
    const created = Math.floor(Date.now() / 1000);
    const wrongPrice = await stripeWebhook({
      id: "evt_wrong_price",
      type: "invoice.paid",
      created,
      object: {
        id: "in_wrong",
        customer: "cus_main",
        subscription: "sub_main",
        metadata: { ...metadata("org_main"), provider_price_id: "price_attacker" }
      }
    });
    expect(wrongPrice.status).toBe(409);

    await activateMonthlyTeam(created + 10);
    const replayMismatch = await stripeWebhook({
      id: "evt_invoice_paid",
      type: "invoice.paid",
      created: created + 10,
      object: {
        id: "in_changed",
        customer: "cus_main",
        subscription: "sub_main",
        metadata: metadata("org_main")
      }
    });
    expect(replayMismatch.status).toBe(409);

    const stale = await stripeWebhook({
      id: "evt_subscription_stale",
      type: "customer.subscription.updated",
      created: created + 5,
      object: {
        id: "sub_main",
        customer: "cus_main",
        metadata: metadata("org_main")
      }
    });
    expect(stale.status).toBe(200);
    expect(await json(stale)).toMatchObject({ stale: true });
    const staleReconciliation = await reconcile(
      reconciliation({
        source_event_id: "evt_subscription_stale",
        kind: "subscription",
        provider_object_id: "sub_main",
        provider_status: "canceled",
        cash_amount_cents: 0,
        net_recurring_amount_cents: 0
      })
    );
    expect(staleReconciliation.status).toBe(409);

    const ledger = await api("/v1/orgs/org_main/billing/ledger", { token: await session() });
    expect(await json(ledger)).toMatchObject({
      billing_state: "entitled",
      entitlement: { status: "active" },
      recognized_mrr: { minor_unit_micros: 29_900_000_000 }
    });
  });

  it("requires reconciled entitlement for Team writes and prevents role escalation", async () => {
    const created = Math.floor(Date.now() / 1000);
    const owner = await session();
    const noEntitlement = await api("/v1/orgs/org_main/policy", {
      method: "PUT",
      token: owner,
      headers: { "If-Match": '"0"' },
      body: {
        schema_version: "team-policy-v1",
        base_revision: 0,
        required_gate_enabled: true,
        policy: { allowed_version_tokens: [], denied_version_tokens: [], required_canary_ids: ["canary_1"] },
        canaries: [{ id: "canary_1", artifact_class: "behavioral", description: "Bounded check" }]
      }
    });
    expect(noEntitlement.status).toBe(402);

    await activateMonthlyTeam(created);
    const body = {
      schema_version: "team-policy-v1",
      base_revision: 0,
      required_gate_enabled: true,
      policy: { allowed_version_tokens: [], denied_version_tokens: [], required_canary_ids: ["canary_1"] },
      canaries: [{ id: "canary_1", artifact_class: "behavioral", description: "Bounded check" }]
    };
    const policy = await api("/v1/orgs/org_main/policy", {
      method: "PUT",
      token: owner,
      headers: { "If-Match": '"0"' },
      body
    });
    expect(policy.status).toBe(201);
    expect(policy.headers.get("ETag")).toBe('"1"');
    const gate = await api("/v1/orgs/org_main/gate", { token: await session("org_main", "user_member") });
    expect(await json(gate)).toMatchObject({ decision: "ALLOW", policy_revision: 1 });

    const conflict = await api("/v1/orgs/org_main/policy", {
      method: "PUT",
      token: owner,
      headers: { "If-Match": '"0"' },
      body
    });
    expect(conflict.status).toBe(409);

    const escalation = await api("/v1/orgs/org_main/members/user_attacker", {
      method: "PUT",
      token: await session("org_main", "user_admin"),
      body: { role: "owner", identity_kind: "human", active: true }
    });
    expect(escalation.status).toBe(403);

    const privilegedService = await api("/v1/orgs/org_main/members/github_installation_1", {
      method: "PUT",
      token: owner,
      body: { role: "billing", identity_kind: "service", active: true }
    });
    expect(privilegedService.status).toBe(400);

    for (let index = 0; index < 12; index += 1) {
      const add = await api(`/v1/orgs/org_main/members/user_${index}`, {
        method: "PUT",
        token: owner,
        body: { role: "member", identity_kind: "human", active: true }
      });
      expect(add.status).toBe(200);
    }
    const sixteenth = await api("/v1/orgs/org_main/members/user_16", {
      method: "PUT",
      token: owner,
      body: { role: "member", identity_kind: "human", active: true }
    });
    expect(sixteenth.status).toBe(409);
  });

  it("prepares cancellation and refund without mutating money, then applies provider-confirmed refund", async () => {
    const created = Math.floor(Date.now() / 1000);
    await activateMonthlyTeam(created);
    const owner = await session();
    const before = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(before)).toMatchObject({ recognized_mrr: { minor_unit_micros: 29_900_000_000 } });

    const cancellation = await api("/v1/orgs/org_main/billing/cancel", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "cancel_test_1" },
      body: { reason: "no_longer_needed" }
    });
    expect(cancellation.status).toBe(202);
    const refundCommand = await api("/v1/orgs/org_main/billing/refund", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "refund_test_1" },
      body: {
        reason: "first_subscription_14_day_unused",
        amount_cents: 29_900,
        paid_features_materially_used: false,
        source_payment_event_id: "evt_invoice_paid"
      }
    });
    expect(refundCommand.status).toBe(202);
    const preparedRefund = await json<{ command_id: string }>(refundCommand.clone());
    const refundRow = await env.TEAM_CONTROL_DB.prepare(
      `SELECT command_json FROM billing_commands WHERE id = ?1`
    )
      .bind(preparedRefund.command_id)
      .first<{ command_json: string }>();
    const acceptedRefundCommand = {
      ...JSON.parse(refundRow!.command_json),
      provider_result: {
        refund_id: "re_main",
        payment_intent_id: "pi_main",
        charge_id: "ch_main",
        amount_cents: 29_900,
        source_payment_event_id: "evt_invoice_paid"
      }
    };
    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_commands SET status = 'provider_accepted', command_json = ?1 WHERE id = ?2`
    )
      .bind(JSON.stringify(acceptedRefundCommand), preparedRefund.command_id)
      .run();
    const refundIdempotencyMismatch = await api("/v1/orgs/org_main/billing/refund", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "refund_test_1" },
      body: {
        reason: "first_subscription_14_day_unused",
        amount_cents: 1,
        paid_features_materially_used: false,
        source_payment_event_id: "evt_invoice_paid"
      }
    });
    expect(refundIdempotencyMismatch.status).toBe(409);
    const stillActive = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(stillActive)).toMatchObject({
      entitlement: { status: "active" },
      recognized_mrr: { minor_unit_micros: 29_900_000_000 },
      cash_ledger: [{ amount_cents: 29_900 }]
    });

    const refundEvent = await stripeWebhook({
      id: "evt_refund",
      type: "refund.created",
      created: created + 1,
      object: {
        id: "re_main",
        object: "refund",
        charge: "ch_main",
        payment_intent: "pi_main",
        amount: 29_900,
        currency: "usd",
        status: "succeeded",
        metadata: {
          team_org_id: "org_main",
          source_payment_event_id: "evt_invoice_paid",
          billing_command_id: preparedRefund.command_id
        }
      }
    });
    expect(refundEvent.status).toBe(200);
    const refundSnapshot = reconciliation({
      source_event_id: "evt_refund",
      kind: "refund",
      provider_object_id: "re_main",
      provider_status: "refunded",
      cash_amount_cents: 0,
      refund_amount_cents: 29_900,
      provider_refund_id: "re_main",
      provider_charge_id: "ch_main",
      provider_payment_intent_id: "pi_main",
      source_payment_event_id: "evt_invoice_paid",
      billing_command_id: preparedRefund.command_id,
      cumulative_refund_amount_cents: 29_900
    });
    const refunded = await reconcile(refundSnapshot);
    expect(refunded.status).toBe(200);
    const after = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(after)).toMatchObject({
      billing_state: "refunded",
      entitlement: { status: "refunded" },
      recognized_mrr: { minor_unit_micros: 0 },
      cash_ledger: [{ amount_cents: 29_900 }, { amount_cents: -29_900 }]
    });
  });

  it("reconciles exact API and out-of-band partial Refunds independently without double booking", async () => {
    const created = Math.floor(Date.now() / 1000);
    await activateMonthlyTeam(created);
    const owner = await session();

    const prepareAcceptedRefund = async (
      idempotencyKey: string,
      amountCents: number,
      refundId: string
    ): Promise<string> => {
      const prepared = await api("/v1/orgs/org_main/billing/refund", {
        method: "POST",
        token: owner,
        headers: { "Idempotency-Key": idempotencyKey },
        body: {
          reason: "case_by_case",
          amount_cents: amountCents,
          paid_features_materially_used: true,
          source_payment_event_id: "evt_invoice_paid"
        }
      });
      expect(prepared.status).toBe(202);
      const { command_id: commandId } = await prepared.json<{ command_id: string }>();
      const row = await env.TEAM_CONTROL_DB.prepare(
        `SELECT command_json FROM billing_commands WHERE id = ?1`
      )
        .bind(commandId)
        .first<{ command_json: string }>();
      await env.TEAM_CONTROL_DB.prepare(
        `UPDATE billing_commands SET status = 'provider_accepted', command_json = ?1 WHERE id = ?2`
      )
        .bind(
          JSON.stringify({
            ...JSON.parse(row!.command_json),
            provider_result: {
              refund_id: refundId,
              payment_intent_id: "pi_partial",
              charge_id: "ch_partial",
              amount_cents: amountCents,
              source_payment_event_id: "evt_invoice_paid"
            }
          }),
          commandId
        )
        .run();
      return commandId;
    };

    const firstCommand = await prepareAcceptedRefund("refund_partial_1", 10_000, "re_partial_1");
    const ingest = async (
      eventId: string,
      refundId: string,
      commandId: string | null,
      amountCents: number,
      offset: number
    ) => {
      const response = await stripeWebhook({
        id: eventId,
        type: "refund.created",
        created: created + offset,
        object: {
          id: refundId,
          object: "refund",
          charge: "ch_partial",
          payment_intent: "pi_partial",
          amount: amountCents,
          currency: "usd",
          status: "succeeded",
          metadata: commandId
            ? {
                team_org_id: "org_main",
                source_payment_event_id: "evt_invoice_paid",
                billing_command_id: commandId
              }
            : {}
        }
      });
      expect(response.status).toBe(200);
    };
    await ingest("evt_partial_1", "re_partial_1", firstCommand, 10_000, 1);
    await ingest("evt_partial_2", "re_partial_2", null, 19_900, 2);

    const partialSnapshot = (
      eventId: string,
      refundId: string,
      commandId: string | null,
      amountCents: number,
      cumulative: number,
      reconciliationId: string
    ) =>
      reconciliation({
        reconciliation_id: reconciliationId,
        source_event_id: eventId,
        kind: "refund",
        provider_object_id: refundId,
        provider_status: "refunded",
        cash_amount_cents: 0,
        net_recurring_amount_cents: amountCents,
        refund_amount_cents: amountCents,
        provider_refund_id: refundId,
        provider_charge_id: "ch_partial",
        provider_payment_intent_id: "pi_partial",
        source_payment_event_id: "evt_invoice_paid",
        billing_command_id: commandId,
        cumulative_refund_amount_cents: cumulative
      });
    const second = partialSnapshot(
      "evt_partial_2",
      "re_partial_2",
      null,
      19_900,
      29_900,
      "recon_partial_2"
    );
    expect((await reconcile(second)).status).toBe(200);
    expect((await reconcile(second)).status).toBe(200);

    const first = partialSnapshot(
      "evt_partial_1",
      "re_partial_1",
      firstCommand,
      10_000,
      29_900,
      "recon_partial_1"
    );
    expect((await reconcile(first)).status).toBe(200);
    expect((await reconcile(first)).status).toBe(200);

    const applications = await env.TEAM_CONTROL_DB.prepare(
      `SELECT provider_refund_id, billing_command_id, amount_cents, cumulative_amount_cents
         FROM provider_refund_applications ORDER BY provider_refund_id`
    ).all();
    expect(applications.results).toEqual([
      {
        provider_refund_id: "re_partial_1",
        billing_command_id: firstCommand,
        amount_cents: 10_000,
        cumulative_amount_cents: 29_900
      },
      {
        provider_refund_id: "re_partial_2",
        billing_command_id: null,
        amount_cents: 19_900,
        cumulative_amount_cents: 29_900
      }
    ]);
    const ledger = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await ledger.json()).toMatchObject({
      billing_state: "refunded",
      recognized_mrr: { minor_unit_micros: 0 },
      cash_ledger: [{ amount_cents: 29_900 }, { amount_cents: -19_900 }, { amount_cents: -10_000 }]
    });
  });

  it("rechecks out only after verified terminal generations and isolates every late prior-generation event", async () => {
    const created = Math.floor(Date.now() / 1000);
    const owner = await session();
    await activateMonthlyTeam(created);

    const refundPrepared = await api("/v1/orgs/org_main/billing/refund", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "refund_generation_1" },
      body: {
        reason: "first_subscription_14_day_unused",
        amount_cents: 29_900,
        paid_features_materially_used: false,
        source_payment_event_id: "evt_invoice_paid"
      }
    });
    expect(refundPrepared.status).toBe(202);
    const { command_id: refundCommandId } = await refundPrepared.json<{ command_id: string }>();
    const refundCommand = await env.TEAM_CONTROL_DB.prepare(
      `SELECT command_json FROM billing_commands WHERE id = ?1 AND status = 'prepared'`
    )
      .bind(refundCommandId)
      .first<{ command_json: string }>();
    expect(refundCommand).not.toBeNull();
    const acceptedRefund = {
      ...JSON.parse(refundCommand!.command_json),
      provider_result: {
        refund_id: "re_generation_1",
        payment_intent_id: "pi_generation_1",
        charge_id: "ch_generation_1",
        amount_cents: 29_900,
        source_payment_event_id: "evt_invoice_paid"
      }
    };
    expect(
      (
        await env.TEAM_CONTROL_DB.prepare(
          `UPDATE billing_commands SET status = 'provider_accepted', command_json = ?1
            WHERE id = ?2 AND status = 'prepared'`
        )
          .bind(JSON.stringify(acceptedRefund), refundCommandId)
          .run()
      ).meta.changes
    ).toBe(1);
    expect(
      (
        await stripeWebhook({
          id: "evt_refund_generation_1",
          type: "refund.created",
          created: created + 1,
          object: {
            id: "re_generation_1",
            object: "refund",
            charge: "ch_generation_1",
            payment_intent: "pi_generation_1",
            amount: 29_900,
            currency: "usd",
            status: "succeeded",
            metadata: {
              team_org_id: "org_main",
              source_payment_event_id: "evt_invoice_paid",
              billing_command_id: refundCommandId
            }
          }
        })
      ).status
    ).toBe(200);
    expect(
      (
        await reconcile(
          reconciliation({
            reconciliation_id: "recon_refund_generation_1",
            source_event_id: "evt_refund_generation_1",
            kind: "refund",
            provider_object_id: "re_generation_1",
            provider_status: "refunded",
            cash_amount_cents: 0,
            refund_amount_cents: 29_900,
            provider_refund_id: "re_generation_1",
            provider_charge_id: "ch_generation_1",
            provider_payment_intent_id: "pi_generation_1",
            source_payment_event_id: "evt_invoice_paid",
            billing_command_id: refundCommandId,
            cumulative_refund_amount_cents: 29_900
          })
        )
      ).status
    ).toBe(200);

    const refundOnlyCheckout = await api("/v1/orgs/org_main/billing/checkout", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "checkout_refund_alone_must_block" },
      body: { internal_price_id: "team_monthly_usd_v1" }
    });
    expect(refundOnlyCheckout.status).toBe(409);
    expect(await refundOnlyCheckout.json()).toMatchObject({ error: { code: "provider_subscription_not_terminal" } });
    const refundOnlyState = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status,
              (SELECT COUNT(*) FROM billing_generations
                WHERE org_id = 'org_main' AND status IN ('reserved', 'bound')) AS live_generations,
              (SELECT COUNT(*) FROM billing_generations
                WHERE org_id = 'org_main' AND provider_subscription_id IS NOT NULL) AS bound_subscriptions
         FROM billing_generations WHERE org_id = 'org_main' AND generation = 1`
    ).first<Record<string, unknown>>();
    expect(refundOnlyState).toEqual({ status: "bound", live_generations: 1, bound_subscriptions: 1 });

    const terminalize = async (
      generation: number,
      customerId: string,
      subscriptionId: string,
      suffix: string,
      offset: number
    ): Promise<void> => {
      const eventId = `evt_subscription_deleted_${suffix}`;
      expect(
        (
          await stripeWebhook({
            id: eventId,
            type: "customer.subscription.deleted",
            created: created + offset,
            object: {
              id: subscriptionId,
              customer: customerId,
              metadata: metadata("org_main", null, generation)
            }
          })
        ).status
      ).toBe(200);
      const terminal = await reconcile(
        reconciliation({
          reconciliation_id: `recon_subscription_deleted_${suffix}`,
          source_event_id: eventId,
          kind: "subscription",
          provider_customer_id: customerId,
          provider_subscription_id: subscriptionId,
          provider_object_id: subscriptionId,
          billing_generation: generation,
          provider_status: "canceled",
          cash_amount_cents: 0,
          net_recurring_amount_cents: 0
        })
      );
      expect(terminal.status).toBe(200);
    };
    const checkoutGeneration = async (
      customerId: string,
      subscriptionId: string,
      suffix: string,
      offset: number
    ): Promise<number> => {
      const checkout = await api("/v1/orgs/org_main/billing/checkout", {
        method: "POST",
        token: owner,
        headers: { "Idempotency-Key": `checkout_${suffix}` },
        body: { internal_price_id: "team_monthly_usd_v1" }
      });
      expect(checkout.status).toBe(202);
      const body = await checkout.json<{
        checkout_intent_id: string;
        command: { parameters: { metadata: Record<string, string> } };
      }>();
      const generation = await acceptPreparedCheckout(body.checkout_intent_id, `cs_${suffix}`);
      const completion = await stripeWebhook({
        id: `evt_checkout_${suffix}`,
        type: "checkout.session.completed",
        created: created + offset,
        object: {
          id: `cs_${suffix}`,
          mode: "subscription",
          customer: customerId,
          subscription: subscriptionId,
          metadata: body.command.parameters.metadata
        }
      });
      expect(completion.status).toBe(200);
      return generation;
    };
    const payGeneration = async (
      generation: number,
      customerId: string,
      subscriptionId: string,
      suffix: string,
      offset: number
    ): Promise<void> => {
      const eventId = `evt_invoice_${suffix}`;
      expect(
        (
          await stripeWebhook({
            id: eventId,
            type: "invoice.paid",
            created: created + offset,
            object: {
              id: `in_${suffix}`,
              customer: customerId,
              subscription: subscriptionId,
              metadata: metadata("org_main", null, generation)
            }
          })
        ).status
      ).toBe(200);
      const paid = await reconcile(
        reconciliation({
          reconciliation_id: `recon_invoice_${suffix}`,
          source_event_id: eventId,
          provider_customer_id: customerId,
          provider_subscription_id: subscriptionId,
          provider_object_id: `in_${suffix}`,
          billing_generation: generation
        })
      );
      expect(paid.status).toBe(200);
    };

    await terminalize(1, "cus_main", "sub_main", "generation_1", 2);
    const generation2 = await checkoutGeneration("cus_main", "sub_generation_2", "generation_2", 3);
    expect(generation2).toBe(2);
    await payGeneration(2, "cus_main", "sub_generation_2", "generation_2", 4);

    const lateInvoice = await stripeWebhook({
      id: "evt_late_invoice_generation_1",
      type: "invoice.paid",
      created: created + 5,
      object: {
        id: "in_late_generation_1",
        customer: "cus_main",
        subscription: "sub_main",
        metadata: metadata("org_main", null, 1)
      }
    });
    expect(lateInvoice.status).toBe(200);
    const lateInvoiceReconciliation = await reconcile(
      reconciliation({
        reconciliation_id: "recon_late_invoice_generation_1",
        source_event_id: "evt_late_invoice_generation_1",
        provider_customer_id: "cus_main",
        provider_subscription_id: "sub_main",
        provider_object_id: "in_late_generation_1",
        billing_generation: 1
      })
    );
    expect(lateInvoiceReconciliation.status).toBe(409);
    expect(await lateInvoiceReconciliation.json()).toMatchObject({ error: { code: "retired_billing_generation" } });

    const lateSubscription = await stripeWebhook({
      id: "evt_late_subscription_generation_1",
      type: "customer.subscription.updated",
      created: created + 6,
      object: {
        id: "sub_main",
        customer: "cus_main",
        metadata: metadata("org_main", null, 1)
      }
    });
    expect(lateSubscription.status).toBe(200);
    expect(
      (
        await reconcile(
          reconciliation({
            reconciliation_id: "recon_late_subscription_generation_1",
            source_event_id: "evt_late_subscription_generation_1",
            kind: "subscription",
            provider_customer_id: "cus_main",
            provider_subscription_id: "sub_main",
            provider_object_id: "sub_main",
            billing_generation: 1,
            provider_status: "active",
            cash_amount_cents: 0,
            net_recurring_amount_cents: 0
          })
        )
      ).status
    ).toBe(409);

    const latePaymentFailure = await stripeWebhook({
      id: "evt_late_payment_failure_generation_1",
      type: "invoice.payment_failed",
      created: created + 7,
      object: {
        id: "in_late_payment_failure_generation_1",
        customer: "cus_main",
        subscription: "sub_main",
        metadata: metadata("org_main", null, 1)
      }
    });
    expect(latePaymentFailure.status).toBe(200);
    const lateFailureReconciliation = await reconcile(
      reconciliation({
        reconciliation_id: "recon_late_payment_failure_generation_1",
        source_event_id: "evt_late_payment_failure_generation_1",
        kind: "payment_failure",
        provider_customer_id: "cus_main",
        provider_subscription_id: "sub_main",
        provider_object_id: "in_late_payment_failure_generation_1",
        billing_generation: 1,
        provider_status: "failed",
        cash_amount_cents: 0,
        net_recurring_amount_cents: 0
      })
    );
    expect(lateFailureReconciliation.status).toBe(409);
    expect(await lateFailureReconciliation.json()).toMatchObject({ error: { code: "retired_billing_generation" } });

    const lateRefund = await stripeWebhook({
      id: "evt_late_refund_generation_1",
      type: "refund.created",
      created: created + 7,
      object: {
        id: "re_late_generation_1",
        object: "refund",
        charge: "ch_generation_1",
        payment_intent: "pi_generation_1",
        amount: 1,
        currency: "usd",
        status: "succeeded",
        metadata: {}
      }
    });
    expect(lateRefund.status).toBe(200);
    expect(
      (
        await reconcile(
          reconciliation({
            reconciliation_id: "recon_late_refund_generation_1",
            source_event_id: "evt_late_refund_generation_1",
            kind: "refund",
            provider_customer_id: "cus_main",
            provider_subscription_id: "sub_main",
            provider_object_id: "re_late_generation_1",
            billing_generation: 1,
            provider_status: "refunded",
            cash_amount_cents: 0,
            net_recurring_amount_cents: 1,
            refund_amount_cents: 1,
            provider_refund_id: "re_late_generation_1",
            provider_charge_id: "ch_generation_1",
            provider_payment_intent_id: "pi_generation_1",
            source_payment_event_id: "evt_invoice_paid",
            billing_command_id: null,
            cumulative_refund_amount_cents: 29_901
          })
        )
      ).status
    ).toBe(409);

    const generation2State = await env.TEAM_CONTROL_DB.prepare(
      `SELECT a.billing_generation, a.provider_customer_id, a.provider_subscription_id,
              a.current_recognized_mrr_micros, e.status AS entitlement_status,
              e.source_event_id,
              (SELECT COUNT(*) FROM billing_generation_events
                WHERE org_id = 'org_main' AND generation = 1
                  AND event_type = 'late_provider_event_ignored') AS late_generation_1_events
         FROM billing_accounts a JOIN entitlements e ON e.org_id = a.org_id
        WHERE a.org_id = 'org_main'`
    ).first<Record<string, unknown>>();
    expect(generation2State).toEqual({
      billing_generation: 2,
      provider_customer_id: "cus_main",
      provider_subscription_id: "sub_generation_2",
      current_recognized_mrr_micros: 29_900_000_000,
      entitlement_status: "active",
      source_event_id: "evt_invoice_generation_2",
      late_generation_1_events: 4
    });

    await terminalize(2, "cus_main", "sub_generation_2", "generation_2", 8);
    const generation3 = await checkoutGeneration("cus_generation_3", "sub_generation_3", "generation_3", 9);
    expect(generation3).toBe(3);
    await payGeneration(3, "cus_generation_3", "sub_generation_3", "generation_3", 10);
    const history = await env.TEAM_CONTROL_DB.prepare(
      `SELECT generation, status, provider_customer_id, provider_subscription_id
         FROM billing_generations WHERE org_id = 'org_main' ORDER BY generation`
    ).all();
    expect(history.results).toEqual([
      { generation: 1, status: "retired", provider_customer_id: "cus_main", provider_subscription_id: "sub_main" },
      {
        generation: 2,
        status: "retired",
        provider_customer_id: "cus_main",
        provider_subscription_id: "sub_generation_2"
      },
      {
        generation: 3,
        status: "bound",
        provider_customer_id: "cus_generation_3",
        provider_subscription_id: "sub_generation_3"
      }
    ]);
    const finalLedger = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await finalLedger.json()).toMatchObject({
      billing_state: "entitled",
      entitlement: { status: "active", source_event_id: "evt_invoice_generation_3" },
      recognized_mrr: { minor_unit_micros: 29_900_000_000 }
    });
  });

  it("rolls back every payment-failure effect when the exact generation changes after pre-read", async () => {
    const created = Math.floor(Date.now() / 1000);
    await activateMonthlyTeam(created);
    const failureEvent = await stripeWebhook({
      id: "evt_payment_failure_interleaved",
      type: "invoice.payment_failed",
      created: created + 1,
      object: {
        id: "in_payment_failure_interleaved",
        customer: "cus_main",
        subscription: "sub_main",
        metadata: metadata("org_main", null, 1)
      }
    });
    expect(failureEvent.status).toBe(200);
    const at = new Date().toISOString();
    await env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO provider_events
        (event_id, provider, event_type, object_id, org_id, event_created,
         payload_sha256, summary_json, status, received_at, reconciled_at)
       VALUES ('evt_interleave_terminal', 'stripe', 'customer.subscription.deleted', 'sub_main',
               'org_main', ?1, ?2, ?3, 'reconciled', ?4, ?4)`
    )
      .bind(
        created + 2,
        "a".repeat(64),
        JSON.stringify({
          orgId: "org_main",
          objectId: "sub_main",
          customerId: "cus_main",
          subscriptionId: "sub_main",
          internalPriceId: "team_monthly_usd_v1",
          providerPriceId: "price_team_monthly_test",
          billingGeneration: 1
        }),
        at
      )
      .run();

    let interleaved = false;
    const interleavingDb = new Proxy(env.TEAM_CONTROL_DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
            if (!interleaved) {
              interleaved = true;
              const switchedAt = new Date().toISOString();
              const switched = await target.batch([
                target.prepare(
                  `UPDATE billing_generations
                      SET status = 'terminal_verified', terminal_verified_at = ?1,
                          terminal_source_event_id = 'evt_interleave_terminal'
                    WHERE org_id = 'org_main' AND generation = 1 AND status = 'bound'`
                ).bind(switchedAt),
                target.prepare(
                  `UPDATE billing_generations SET status = 'retired', retired_at = ?1
                    WHERE org_id = 'org_main' AND generation = 1 AND status = 'terminal_verified'`
                ).bind(switchedAt),
                target.prepare(
                  `INSERT INTO billing_generations
                    (org_id, generation, internal_price_id, status, provider_customer_id,
                     provider_subscription_id, reserved_at, bound_at)
                   VALUES ('org_main', 2, 'team_monthly_usd_v1', 'bound',
                           'cus_interleaved_s2', 'sub_interleaved_s2', ?1, ?1)`
                ).bind(switchedAt),
                target.prepare(
                  `UPDATE billing_accounts
                      SET provider_customer_id = 'cus_interleaved_s2',
                          provider_subscription_id = 'sub_interleaved_s2',
                          billing_generation = 2, commercial_state = 'entitled',
                          last_reconciled_event_created = ?1,
                          last_reconciled_event_id = 'evt_interleaved_s2', updated_at = ?2
                    WHERE org_id = 'org_main' AND billing_generation = 1`
                ).bind(created + 3, switchedAt),
                target.prepare(
                  `UPDATE entitlements SET status = 'active', grace_until = NULL,
                          source_event_id = 'evt_interleaved_s2', updated_at = ?1
                    WHERE org_id = 'org_main'`
                ).bind(switchedAt)
              ]);
              expect(switched.map((result) => result.meta.changes ?? 0)).toEqual([1, 1, 1, 1, 1]);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const interleavingEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "TEAM_CONTROL_DB" ? interleavingDb : Reflect.get(target, property, receiver);
      }
    }) as unknown as Env;
    const body = reconciliation({
      reconciliation_id: "recon_payment_failure_interleaved",
      source_event_id: "evt_payment_failure_interleaved",
      kind: "payment_failure",
      provider_object_id: "in_payment_failure_interleaved",
      billing_generation: 1,
      provider_status: "failed",
      cash_amount_cents: 0,
      net_recurring_amount_cents: 0
    });
    await expect(handleProviderReconciliation(await signedReconciliationRequest(body), interleavingEnv)).rejects.toThrow();
    expect(interleaved).toBe(true);

    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT a.billing_generation, a.provider_customer_id, a.provider_subscription_id,
              a.commercial_state, e.status AS entitlement_status, e.source_event_id,
              p.status AS failure_event_status,
              (SELECT COUNT(*) FROM provider_reconciliation_snapshots
                WHERE reconciliation_id = 'recon_payment_failure_interleaved') AS snapshots,
              (SELECT COUNT(*) FROM commercial_transitions
                WHERE source_ref = 'evt_payment_failure_interleaved') AS transitions,
              (SELECT COUNT(*) FROM lifecycle_events
                WHERE source_ref = 'evt_payment_failure_interleaved') AS lifecycle,
              (SELECT COUNT(*) FROM audit_events
                WHERE resource_id = 'evt_payment_failure_interleaved'
                  AND action = 'billing.payment.failed') AS audits,
              (SELECT COUNT(*) FROM workflow_integrity_receipts
                WHERE source_ref = 'evt_payment_failure_interleaved') AS receipts
         FROM billing_accounts a
         JOIN entitlements e ON e.org_id = a.org_id
         JOIN provider_events p ON p.event_id = 'evt_payment_failure_interleaved'
        WHERE a.org_id = 'org_main'`
    ).first<Record<string, unknown>>();
    expect(state).toEqual({
      billing_generation: 2,
      provider_customer_id: "cus_interleaved_s2",
      provider_subscription_id: "sub_interleaved_s2",
      commercial_state: "entitled",
      entitlement_status: "active",
      source_event_id: "evt_interleaved_s2",
      failure_event_status: "awaiting_reconciliation",
      snapshots: 0,
      transitions: 0,
      lifecycle: 0,
      audits: 0,
      receipts: 0
    });
  });

  it("normalizes annual recurring value and applies confirmed period-end cancellation then expiration", async () => {
    const created = Math.floor(Date.now() / 1000);
    const annualMetadata = {
      team_org_id: "org_main",
      internal_price_id: "team_annual_usd_v1",
      provider_price_id: "price_team_annual_test",
      billing_generation: "1"
    };
    await prepareAndCompleteCheckout("team_annual_usd_v1", "cs_annual", "evt_checkout_annual", created - 1);
    const annualEvent = await stripeWebhook({
      id: "evt_annual_paid",
      type: "invoice.paid",
      created,
      object: {
        id: "in_annual",
        customer: "cus_main",
        subscription: "sub_main",
        metadata: annualMetadata
      }
    });
    expect(annualEvent.status).toBe(200);
    const periodStart = new Date(Date.now() - 60_000).toISOString();
    const periodEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const annualReconciliation = await reconcile(
      reconciliation({
        source_event_id: "evt_annual_paid",
        provider_object_id: "in_annual",
        internal_price_id: "team_annual_usd_v1",
        provider_price_id: "price_team_annual_test",
        cash_amount_cents: 299_000,
        net_recurring_amount_cents: 299_000,
        period_start: periodStart,
        period_end: periodEnd
      })
    );
    expect(annualReconciliation.status).toBe(200);
    const owner = await session();
    let ledger = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(ledger)).toMatchObject({
      entitlement: { status: "active" },
      recognized_mrr: { minor_unit_micros: 24_916_666_667 },
      cash_ledger: [{ amount_cents: 299_000 }]
    });

    const cancellationEvent = await stripeWebhook({
      id: "evt_subscription_cancel_at_end",
      type: "customer.subscription.updated",
      created: created + 1,
      object: {
        id: "sub_main",
        customer: "cus_main",
        metadata: annualMetadata
      }
    });
    expect(cancellationEvent.status).toBe(200);
    const canceledAtEnd = await reconcile(
      reconciliation({
        source_event_id: "evt_subscription_cancel_at_end",
        kind: "subscription",
        provider_object_id: "sub_main",
        internal_price_id: "team_annual_usd_v1",
        provider_price_id: "price_team_annual_test",
        provider_status: "active",
        cash_amount_cents: 0,
        net_recurring_amount_cents: 0,
        period_start: periodStart,
        period_end: periodEnd,
        cancel_at_period_end: true
      })
    );
    expect(canceledAtEnd.status).toBe(200);
    ledger = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(ledger)).toMatchObject({
      billing_state: "canceled_at_period_end",
      entitlement: { status: "active" },
      recognized_mrr: { minor_unit_micros: 24_916_666_667 }
    });

    const deletionEvent = await stripeWebhook({
      id: "evt_subscription_deleted",
      type: "customer.subscription.deleted",
      created: created + 2,
      object: {
        id: "sub_main",
        customer: "cus_main",
        metadata: annualMetadata
      }
    });
    expect(deletionEvent.status).toBe(200);
    const expired = await reconcile(
      reconciliation({
        source_event_id: "evt_subscription_deleted",
        kind: "subscription",
        provider_object_id: "sub_main",
        internal_price_id: "team_annual_usd_v1",
        provider_price_id: "price_team_annual_test",
        provider_status: "canceled",
        cash_amount_cents: 0,
        net_recurring_amount_cents: 0,
        period_start: periodStart,
        period_end: periodEnd
      })
    );
    expect(expired.status).toBe(200);
    ledger = await api("/v1/orgs/org_main/billing/ledger", { token: owner });
    expect(await json(ledger)).toMatchObject({
      billing_state: "expired",
      entitlement: { status: "expired" },
      recognized_mrr: { minor_unit_micros: 0 }
    });
  });

  it("rejects provider customers preserved in another tenant's retired generation history", async () => {
    await seedOrganization("org_other");
    const at = new Date().toISOString();
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, internal_price_id, status, provider_customer_id,
           provider_subscription_id, reserved_at, bound_at, terminal_verified_at,
           terminal_source_event_id, retired_at)
         VALUES ('org_other', 1, 'team_monthly_usd_v1', 'retired', 'cus_collision',
                 'sub_retired_collision', ?1, ?1, ?1, 'evt_retired_collision', ?1)`
      ).bind(at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, internal_price_id, status, provider_customer_id,
           provider_subscription_id, reserved_at, bound_at)
         VALUES ('org_other', 2, 'team_monthly_usd_v1', 'bound', 'cus_other_current',
                 'sub_other_current', ?1, ?1)`
      ).bind(at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_accounts
          (org_id, provider_customer_id, provider_subscription_id, commercial_state,
           internal_price_id, billing_interval, billing_generation, updated_at)
         VALUES ('org_other', 'cus_other_current', 'sub_other_current', 'entitled',
                 'team_monthly_usd_v1', 'month', 2, ?1)`
      ).bind(at)
    ]);
    const owner = await session();
    const prepared = await api("/v1/orgs/org_main/billing/checkout", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "checkout_retired_customer_collision" },
      body: { internal_price_id: "team_monthly_usd_v1" }
    });
    expect(prepared.status).toBe(202);
    const checkout = await prepared.json<{
      checkout_intent_id: string;
      command: { parameters: { metadata: Record<string, string> } };
    }>();
    expect(await acceptPreparedCheckout(checkout.checkout_intent_id, "cs_retired_customer_collision")).toBe(1);
    const created = Math.floor(Date.now() / 1000);
    const completion = await stripeWebhook({
      id: "evt_checkout_retired_customer_collision",
      type: "checkout.session.completed",
      created,
      object: {
        id: "cs_retired_customer_collision",
        mode: "subscription",
        customer: "cus_collision",
        subscription: "sub_org_main_new",
        metadata: checkout.command.parameters.metadata
      }
    });
    expect(completion.status).toBe(409);
    expect(await completion.json()).toMatchObject({ error: { code: "provider_tenant_collision" } });
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT i.status AS checkout_status, g.status AS generation_status,
              g.provider_customer_id, g.provider_subscription_id,
              (SELECT COUNT(*) FROM billing_accounts WHERE org_id = 'org_main') AS org_main_accounts
         FROM checkout_intents i
         JOIN billing_generations g ON g.checkout_intent_id = i.id
        WHERE i.id = ?1`
    )
      .bind(checkout.checkout_intent_id)
      .first<Record<string, unknown>>();
    expect(state).toEqual({
      checkout_status: "provider_created",
      generation_status: "reserved",
      provider_customer_id: null,
      provider_subscription_id: null,
      org_main_accounts: 1
    });
  });

  it("requires a later organization creation after terminal heads and provider-not-found release", async () => {
    const owner = await session();
    const baseTime = Date.now() - 10_000;
    const creation1 = crypto.randomUUID();
    const creation1Raw = githubPayload({
      deliveryId: creation1,
      event: "installation",
      action: "created",
      eventTime: new Date(baseTime).toISOString()
    });
    expect((await sendGitHubWebhook(creation1Raw, "installation", creation1)).status).toBe(409);
    expect((await claimGitHubInstallation(owner, creation1)).status).toBe(201);

    const deletion1 = crypto.randomUUID();
    const deletion1Raw = githubPayload({
      deliveryId: deletion1,
      event: "installation",
      action: "deleted",
      eventTime: new Date(baseTime + 1_000).toISOString()
    });
    expect((await sendGitHubWebhook(deletion1Raw, "installation", deletion1)).status).toBe(409);
    const oldClaimAfterDelete = await claimGitHubInstallation(await session(), creation1);
    expect(oldClaimAfterDelete.status).toBe(409);
    expect(await oldClaimAfterDelete.json()).toMatchObject({ error: { code: "github_provider_proof_required" } });
    const oldReplayAfterDelete = await sendGitHubWebhook(creation1Raw, "installation", creation1);
    expect(oldReplayAfterDelete.status).toBe(409);
    expect(await oldReplayAfterDelete.json()).toMatchObject({ error: { code: "stale_github_lifecycle" } });

    const creation2 = crypto.randomUUID();
    const creation2Raw = githubPayload({
      deliveryId: creation2,
      event: "installation",
      action: "created",
      eventTime: new Date(baseTime + 2_000).toISOString()
    });
    expect((await sendGitHubWebhook(creation2Raw, "installation", creation2)).status).toBe(409);
    expect((await claimGitHubInstallation(await session(), creation2)).status).toBe(201);
    expect((await sendGitHubWebhook(creation2Raw, "installation", creation2)).status).toBe(202);
    const pendingUpdate2 = crypto.randomUUID();
    const pendingUpdate2Raw = githubPayload({
      deliveryId: pendingUpdate2,
      event: "installation_repositories",
      action: "added",
      eventTime: new Date(baseTime + 3_000).toISOString(),
      addedRepositoryNodeIds: ["REPO_NODE_LATER_PENDING_2"]
    });
    expect((await sendGitHubWebhook(pendingUpdate2Raw, "installation_repositories", pendingUpdate2)).status).toBe(202);
    const released = await reconcileGitHub(
      githubReconciliation(pendingUpdate2, {
        reconciliation_id: "github_recon_not_found_generation_2",
        provider_status: "not_found",
        repository_node_ids: []
      })
    );
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ reconciled: false, released: true });

    const oldClaimAfterRelease = await claimGitHubInstallation(await session(), creation2);
    expect(oldClaimAfterRelease.status).toBe(409);
    expect(await oldClaimAfterRelease.json()).toMatchObject({ error: { code: "github_provider_proof_required" } });
    const oldReplayAfterRelease = await sendGitHubWebhook(creation2Raw, "installation", creation2);
    expect(oldReplayAfterRelease.status).toBe(200);
    expect(await oldReplayAfterRelease.json()).toMatchObject({ duplicate: true, result: "rejected" });
    const releasedState = await env.TEAM_CONTROL_DB.prepare(
      `SELECT p.delivery_id AS proof_delivery_id, p.invalidated_by_delivery_id,
              h.latest_delivery_id, h.latest_action, h.terminal,
              (SELECT COUNT(*) FROM github_deliveries
                WHERE installation_id = ?1 AND result = 'rejected') AS rejected_deliveries,
              (SELECT COUNT(*) FROM github_deliveries
                WHERE installation_id = ?1 AND result = 'pending_reconciliation') AS pending_deliveries
         FROM github_installation_provider_proofs p
         JOIN github_installation_lifecycle_heads h ON h.installation_id = p.installation_id
        WHERE p.installation_id = ?1 AND p.delivery_id = ?2`
    )
      .bind(GITHUB_INSTALLATION_ID, creation2)
      .first<Record<string, unknown>>();
    expect(releasedState).toEqual({
      proof_delivery_id: creation2,
      invalidated_by_delivery_id: pendingUpdate2,
      latest_delivery_id: pendingUpdate2,
      latest_action: "provider_not_found",
      terminal: 1,
      rejected_deliveries: 2,
      pending_deliveries: 0
    });
    const postReleaseExport = await api("/v1/orgs/org_main/privacy/export", { token: owner });
    expect(postReleaseExport.status).toBe(200);
    const postReleaseExportBody = await postReleaseExport.json<{
      github_app: {
        provider_proofs: Array<{ delivery_id: string; invalidated_by_delivery_id: string }>;
        lifecycle_heads: Array<{ latest_delivery_id: string; latest_action: string }>;
        deliveries: Array<{ delivery_id: string; result: string }>;
        release_reconciliations: Array<{ source_delivery_id: string }>;
        integrity_receipts: Array<{ workflow_type: string }>;
      };
    }>();
    expect(postReleaseExportBody.github_app.provider_proofs).toContainEqual(
      expect.objectContaining({ delivery_id: creation2, invalidated_by_delivery_id: pendingUpdate2 })
    );
    expect(postReleaseExportBody.github_app.lifecycle_heads).toContainEqual(
      expect.objectContaining({ latest_delivery_id: pendingUpdate2, latest_action: "provider_not_found" })
    );
    expect(postReleaseExportBody.github_app.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delivery_id: creation2, result: "rejected" }),
        expect.objectContaining({ delivery_id: pendingUpdate2, result: "rejected" })
      ])
    );
    expect(postReleaseExportBody.github_app.release_reconciliations).toContainEqual(
      expect.objectContaining({ source_delivery_id: pendingUpdate2 })
    );
    expect(postReleaseExportBody.github_app.integrity_receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workflow_type: "github_lifecycle_head_recorded" }),
        expect.objectContaining({ workflow_type: "github_org_not_found_release" })
      ])
    );

    const creation3 = crypto.randomUUID();
    const creation3Raw = githubPayload({
      deliveryId: creation3,
      event: "installation",
      action: "created",
      eventTime: new Date(baseTime + 4_000).toISOString()
    });
    expect((await sendGitHubWebhook(creation3Raw, "installation", creation3)).status).toBe(409);
    expect((await claimGitHubInstallation(await session(), creation3)).status).toBe(201);
    expect((await sendGitHubWebhook(creation3Raw, "installation", creation3)).status).toBe(202);
    expect(
      (
        await reconcileGitHub(
          githubReconciliation(creation3, { reconciliation_id: "github_recon_creation_generation_3" })
        )
      ).status
    ).toBe(200);
    const final = await env.TEAM_CONTROL_DB.prepare(
      `SELECT h.creation_delivery_id, h.latest_delivery_id, h.latest_action, h.terminal,
              c.provider_proof_delivery_id, c.status AS claim_status, i.state AS installation_state,
              (SELECT COUNT(*) FROM github_installation_provider_proofs
                WHERE installation_id = ?1 AND invalidated_at IS NULL) AS live_proofs,
              (SELECT COUNT(*) FROM github_installation_release_reconciliations
                WHERE installation_id = ?1 AND result = 'released') AS releases
         FROM github_installation_lifecycle_heads h
         JOIN github_installation_claims c ON c.installation_id = h.installation_id
         JOIN github_installations i ON i.installation_id = h.installation_id
        WHERE h.installation_id = ?1`
    )
      .bind(GITHUB_INSTALLATION_ID)
      .first<Record<string, unknown>>();
    expect(final).toEqual({
      creation_delivery_id: creation3,
      latest_delivery_id: creation3,
      latest_action: "created",
      terminal: 0,
      provider_proof_delivery_id: creation3,
      claim_status: "bound",
      installation_state: "active",
      live_proofs: 1,
      releases: 1
    });
  });

  it("lets a same-second terminal organization delivery dominate creation and blocks same-second recreation", async () => {
    const owner = await session();
    const eventTime = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const creation = crypto.randomUUID();
    const creationRaw = githubPayload({
      deliveryId: creation,
      event: "installation",
      action: "created",
      eventTime
    });
    expect((await sendGitHubWebhook(creationRaw, "installation", creation)).status).toBe(409);
    expect((await claimGitHubInstallation(owner, creation)).status).toBe(201);
    expect((await sendGitHubWebhook(creationRaw, "installation", creation)).status).toBe(202);

    const deletion = crypto.randomUUID();
    const deletionRaw = githubPayload({
      deliveryId: deletion,
      event: "installation",
      action: "deleted",
      eventTime
    });
    expect((await sendGitHubWebhook(deletionRaw, "installation", deletion)).status).toBe(202);
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT h.latest_delivery_id, h.latest_action, h.terminal,
              p.invalidated_by_delivery_id, i.state AS installation_state,
              c.status AS claim_status, m.active AS service_active
         FROM github_installation_lifecycle_heads h
         JOIN github_installation_provider_proofs p ON p.delivery_id = h.creation_delivery_id
         JOIN github_installations i ON i.installation_id = h.installation_id
         JOIN github_installation_claims c ON c.installation_id = h.installation_id
         JOIN organization_members m
           ON m.org_id = c.org_id AND m.identity_kind = 'service' AND m.role = 'member'
        WHERE h.installation_id = ?1`
    )
      .bind(GITHUB_INSTALLATION_ID)
      .first<Record<string, unknown>>();
    expect(state).toEqual({
      latest_delivery_id: deletion,
      latest_action: "deleted",
      terminal: 1,
      invalidated_by_delivery_id: deletion,
      installation_state: "deleted",
      claim_status: "revoked",
      service_active: 0
    });

    const sameSecondRecreation = crypto.randomUUID();
    const sameSecondRecreationRaw = githubPayload({
      deliveryId: sameSecondRecreation,
      event: "installation",
      action: "created",
      eventTime
    });
    const rejected = await sendGitHubWebhook(sameSecondRecreationRaw, "installation", sameSecondRecreation);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "stale_github_lifecycle" } });
    expect(
      await env.TEAM_CONTROL_DB.prepare(
        `SELECT latest_delivery_id, latest_action, terminal
           FROM github_installation_lifecycle_heads WHERE installation_id = ?1`
      )
        .bind(GITHUB_INSTALLATION_ID)
        .first()
    ).toEqual({ latest_delivery_id: deletion, latest_action: "deleted", terminal: 1 });
  });

  it("requires signed provider preclaim proof and releases an expired unbound organization claim", async () => {
    const owner = await session();
    const firstDelivery = crypto.randomUUID();
    const firstRaw = githubPayload({
      deliveryId: firstDelivery,
      event: "installation",
      action: "created",
      eventTime: new Date(Date.now() - 2_000).toISOString()
    });
    expect((await sendGitHubWebhook(firstRaw, "installation", firstDelivery)).status).toBe(409);
    expect((await claimGitHubInstallation(owner, firstDelivery)).status).toBe(201);
    await env.TEAM_CONTROL_DB.prepare(
      `UPDATE github_installation_claims SET claim_expires_at = '1970-01-01T00:00:00.000Z'
        WHERE installation_id = ?1`
    )
      .bind(GITHUB_INSTALLATION_ID)
      .run();

    const secondDelivery = crypto.randomUUID();
    const secondRaw = githubPayload({
      deliveryId: secondDelivery,
      event: "installation",
      action: "created",
      eventTime: new Date(Date.now() - 1_000).toISOString()
    });
    expect((await sendGitHubWebhook(secondRaw, "installation", secondDelivery)).status).toBe(409);
    await seedOrganization("org_other");
    const reclaimed = await api("/v1/orgs/org_other/github/installation-claim", {
      method: "POST",
      token: await session("org_other"),
      body: {
        schema_version: "github-installation-claim-v1",
        installation_id: GITHUB_INSTALLATION_ID,
        account_node_id: GITHUB_ACCOUNT_NODE_ID,
        provider_delivery_id: secondDelivery
      }
    });
    expect(reclaimed.status).toBe(201);
    const claim = await env.TEAM_CONTROL_DB.prepare(
      `SELECT org_id, provider_proof_delivery_id, status FROM github_installation_claims
        WHERE installation_id = ?1`
    )
      .bind(GITHUB_INSTALLATION_ID)
      .first();
    expect(claim).toMatchObject({
      org_id: "org_other",
      provider_proof_delivery_id: secondDelivery,
      status: "claimed"
    });
  });

  it("verifies raw GitHub signatures, requires an owner claim, deduplicates bytes, and reconciles before activation", async () => {
    const invalidSignature = await sendGitHubWebhook(
      "not-json",
      "installation",
      crypto.randomUUID(),
      "wrong-test-only-github-secret-32-bytes"
    );
    expect(invalidSignature.status).toBe(401);

    const createdAt = new Date(Date.now() - 10_000).toISOString();
    const deliveryId = crypto.randomUUID();
    const raw = githubPayload({
      deliveryId,
      event: "installation",
      action: "created",
      eventTime: createdAt
    });
    const unclaimed = await sendGitHubWebhook(raw, "installation", deliveryId);
    expect(unclaimed.status).toBe(409);
    expect((await claimGitHubInstallation(await session(), deliveryId)).status).toBe(201);
    await seedOrganization("org_other");
    const tenantCollision = await api("/v1/orgs/org_other/github/installation-claim", {
      method: "POST",
      token: await session("org_other"),
      body: {
        schema_version: "github-installation-claim-v1",
        installation_id: GITHUB_INSTALLATION_ID,
        account_node_id: GITHUB_ACCOUNT_NODE_ID,
        provider_delivery_id: deliveryId
      }
    });
    expect(tenantCollision.status).toBe(409);
    expect(
      await env.TEAM_CONTROL_DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE org_id = 'org_other' AND action = 'github.installation.claimed'`
      ).first<{ count: number }>()
    ).toMatchObject({ count: 0 });

    const wrongAppDelivery = crypto.randomUUID();
    const wrongAppRaw = githubPayload({
      deliveryId: wrongAppDelivery,
      event: "installation",
      action: "created",
      eventTime: createdAt,
      appId: GITHUB_APP_ID + 1
    });
    expect((await sendGitHubWebhook(wrongAppRaw, "installation", wrongAppDelivery)).status).toBe(409);

    const accepted = await sendGitHubWebhook(raw, "installation", deliveryId);
    expect(accepted.status).toBe(202);
    expect(await json(accepted)).toMatchObject({ state: "pending_reconciliation" });
    const serviceToken = await session("org_main", `github-installation:${GITHUB_INSTALLATION_ID}`);
    expect((await api("/v1/orgs/org_main", { token: serviceToken })).status).toBe(403);

    const stateBefore = await api("/v1/orgs/org_main/github/installation", { token: await session() });
    const stateBeforeText = await stateBefore.text();
    expect(stateBefore.status).toBe(200);
    expect(stateBeforeText).not.toContain("must-never-be-stored");
    expect(JSON.parse(stateBeforeText)).toMatchObject({
      installation: { state: "pending_reconciliation" },
      repositories: [{ repository_node_id: GITHUB_REPOSITORY_NODE_ID, selected: true }],
      stores_repository_names_or_source: false
    });

    const snapshot = githubReconciliation(deliveryId, { reconciliation_id: "github_recon_created" });
    const reconciled = await reconcileGitHub(snapshot);
    expect(reconciled.status).toBe(200);
    expect((await api("/v1/orgs/org_main", { token: serviceToken })).status).toBe(200);
    const duplicateReconciliation = await reconcileGitHub(snapshot);
    expect(duplicateReconciliation.status).toBe(200);
    expect(await json(duplicateReconciliation)).toMatchObject({ duplicate: true, result: "applied" });

    const duplicate = await sendGitHubWebhook(raw, "installation", deliveryId);
    expect(duplicate.status).toBe(200);
    expect(await json(duplicate)).toMatchObject({ duplicate: true, result: "applied" });
    const changedBytes = raw.replace("must-never-be-stored", "different-name-never-stored");
    const replayMismatch = await sendGitHubWebhook(changedBytes, "installation", deliveryId);
    expect(replayMismatch.status).toBe(409);

    const persistedNames = await env.TEAM_CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE metadata_json LIKE '%must-never-be-stored%'
           OR actor_id LIKE '%must-never-be-stored%'
           OR resource_id LIKE '%must-never-be-stored%'`
    ).first<{ count: number }>();
    expect(persistedNames?.count).toBe(0);
  });

  it("revokes a suspended installation immediately and requires matching reconciliation after unsuspend", async () => {
    const owner = await session();
    const baseTime = Date.now() - 20_000;
    const active = await activateGitHubInstallation(owner, baseTime);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(200);

    const suspendDelivery = crypto.randomUUID();
    const suspendRaw = githubPayload({
      deliveryId: suspendDelivery,
      event: "installation",
      action: "suspend",
      eventTime: new Date(baseTime + 2_000).toISOString()
    });
    expect((await sendGitHubWebhook(suspendRaw, "installation", suspendDelivery)).status).toBe(202);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(403);

    const staleDelivery = crypto.randomUUID();
    const staleRaw = githubPayload({
      deliveryId: staleDelivery,
      event: "installation_repositories",
      action: "added",
      eventTime: new Date(baseTime + 1_000).toISOString(),
      addedRepositoryNodeIds: ["REPO_NODE_STALE_123"]
    });
    expect((await sendGitHubWebhook(staleRaw, "installation_repositories", staleDelivery)).status).toBe(409);

    const unsuspendDelivery = crypto.randomUUID();
    const unsuspendRaw = githubPayload({
      deliveryId: unsuspendDelivery,
      event: "installation",
      action: "unsuspend",
      eventTime: new Date(baseTime + 4_000).toISOString()
    });
    expect((await sendGitHubWebhook(unsuspendRaw, "installation", unsuspendDelivery)).status).toBe(202);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(403);

    const mismatch = await reconcileGitHub(
      githubReconciliation(unsuspendDelivery, {
        reconciliation_id: "github_recon_wrong_account",
        account_node_id: "ACCT_NODE_WRONG_123"
      })
    );
    expect(mismatch.status).toBe(409);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(403);

    const reconciled = await reconcileGitHub(
      githubReconciliation(unsuspendDelivery, { reconciliation_id: "github_recon_unsuspend" })
    );
    expect(reconciled.status).toBe(200);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(200);
  });

  it("tracks opaque repository selection, reconciles selection-mode changes, and tombstones deletion", async () => {
    const owner = await session();
    const baseTime = Date.now() - 20_000;
    const active = await activateGitHubInstallation(owner, baseTime);
    const addedRepository = "REPO_NODE_SECOND_123";
    const addDelivery = crypto.randomUUID();
    const addRaw = githubPayload({
      deliveryId: addDelivery,
      event: "installation_repositories",
      action: "added",
      eventTime: new Date(baseTime + 2_000).toISOString(),
      addedRepositoryNodeIds: [addedRepository]
    });
    expect((await sendGitHubWebhook(addRaw, "installation_repositories", addDelivery)).status).toBe(200);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(200);

    const allDelivery = crypto.randomUUID();
    const allRaw = githubPayload({
      deliveryId: allDelivery,
      event: "installation_repositories",
      action: "added",
      eventTime: new Date(baseTime + 4_000).toISOString(),
      repositorySelection: "all"
    });
    expect((await sendGitHubWebhook(allRaw, "installation_repositories", allDelivery)).status).toBe(202);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(403);
    expect(
      (
        await reconcileGitHub(
          githubReconciliation(allDelivery, {
            reconciliation_id: "github_recon_all",
            repository_selection: "all",
            repository_node_ids: []
          })
        )
      ).status
    ).toBe(200);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(200);

    const deleteDelivery = crypto.randomUUID();
    const deleteRaw = githubPayload({
      deliveryId: deleteDelivery,
      event: "installation",
      action: "deleted",
      eventTime: new Date(baseTime + 6_000).toISOString(),
      repositorySelection: "all"
    });
    expect((await sendGitHubWebhook(deleteRaw, "installation", deleteDelivery)).status).toBe(202);
    expect((await api("/v1/orgs/org_main", { token: active.serviceToken })).status).toBe(403);
    const state = await api("/v1/orgs/org_main/github/installation", { token: owner });
    expect(await json(state)).toMatchObject({
      claim: { status: "revoked" },
      installation: { state: "deleted" },
      repositories: [
        { selected: false },
        { selected: false }
      ]
    });
  });

  it("erases released organization lifecycle, proof, release, delivery, and integrity rows on privacy deletion", async () => {
    const owner = await session();
    const creation = crypto.randomUUID();
    const creationRaw = githubPayload({
      deliveryId: creation,
      event: "installation",
      action: "created",
      eventTime: new Date(Date.now() - 2_000).toISOString()
    });
    expect((await sendGitHubWebhook(creationRaw, "installation", creation)).status).toBe(409);
    expect((await claimGitHubInstallation(owner, creation)).status).toBe(201);
    expect((await sendGitHubWebhook(creationRaw, "installation", creation)).status).toBe(202);
    const reconciliationId = "github_recon_privacy_release";
    expect(
      (
        await reconcileGitHub(
          githubReconciliation(creation, {
            reconciliation_id: reconciliationId,
            provider_status: "not_found",
            repository_node_ids: []
          })
        )
      ).status
    ).toBe(200);

    const deletion = await api("/v1/orgs/org_main/privacy/deletion-requests", { method: "POST", token: owner });
    expect(deletion.status).toBe(202);
    const confirmation = await deletion.json<{ confirmation: string }>();
    const confirmed = await api("/v1/orgs/org_main/privacy/data", {
      method: "DELETE",
      token: owner,
      headers: { "X-Deletion-Confirmation": confirmation.confirmation }
    });
    expect(confirmed.status).toBe(202);
    const residuals = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM github_installation_provider_proofs WHERE installation_id = ?1) AS proofs,
         (SELECT COUNT(*) FROM github_installation_lifecycle_heads WHERE installation_id = ?1) AS heads,
         (SELECT COUNT(*) FROM github_installation_release_reconciliations
           WHERE installation_id = ?1 OR owner_ref = 'org_main') AS releases,
         (SELECT COUNT(*) FROM github_deliveries WHERE installation_id = ?1) AS deliveries,
         (SELECT COUNT(*) FROM workflow_integrity_receipts
           WHERE (workflow_type = 'github_lifecycle_head_recorded' AND source_ref = ?2)
              OR (workflow_type = 'github_org_not_found_release' AND source_ref = ?3)) AS receipts`
    )
      .bind(GITHUB_INSTALLATION_ID, creation, reconciliationId)
      .first<Record<string, unknown>>();
    expect(residuals).toEqual({ proofs: 0, heads: 0, releases: 0, deliveries: 0, receipts: 0 });
  });

  it("exports data and requires one-time owner confirmation before deletion", async () => {
    const owner = await session();
    const preparedCheckout = await api("/v1/orgs/org_main/billing/checkout", {
      method: "POST",
      token: owner,
      headers: { "Idempotency-Key": "privacy_checkout_1" },
      body: { internal_price_id: "team_monthly_usd_v1" }
    });
    expect(preparedCheckout.status).toBe(202);
    const github = await activateGitHubInstallation(owner, Date.now() - 10_000);
    expect((await api("/v1/orgs/org_main", { token: github.serviceToken })).status).toBe(200);
    const exported = await api("/v1/orgs/org_main/privacy/export", { token: owner });
    expect(exported.status).toBe(200);
    expect(await json(exported)).toMatchObject({
      schema_version: "team-privacy-export-v1",
      github_app: { installation: { state: "active" }, stores_repository_names_or_source: false }
    });

    const deletion = await api("/v1/orgs/org_main/privacy/deletion-requests", {
      method: "POST",
      token: owner
    });
    expect(deletion.status).toBe(202);
    const deletionBody = await json<{ confirmation: string }>(deletion);
    const wrong = await api("/v1/orgs/org_main/privacy/data", {
      method: "DELETE",
      token: owner,
      headers: { "X-Deletion-Confirmation": "wrong-confirmation" }
    });
    expect(wrong.status).toBe(403);
    const confirmed = await api("/v1/orgs/org_main/privacy/data", {
      method: "DELETE",
      token: owner,
      headers: { "X-Deletion-Confirmation": deletionBody.confirmation }
    });
    expect(confirmed.status).toBe(202);
    expect(await json(confirmed)).toMatchObject({ deleted: true, access_revoked: true });
    const checkoutState = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status FROM checkout_intents WHERE org_id = 'org_main'`
    ).first<{ status: string }>();
    const commandState = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status FROM billing_commands WHERE org_id = 'org_main'`
    ).first<{ status: string }>();
    expect(checkoutState?.status).toBe("canceled");
    expect(commandState?.status).toBe("canceled");
    const githubResiduals = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM github_installation_claims WHERE installation_id = ?1 OR org_id = 'org_main') AS claims,
         (SELECT COUNT(*) FROM github_installations WHERE installation_id = ?1 OR org_id = 'org_main') AS installations,
         (SELECT COUNT(*) FROM github_installation_repositories WHERE installation_id = ?1) AS repositories,
         (SELECT COUNT(*) FROM github_deliveries WHERE installation_id = ?1 OR org_id = 'org_main') AS deliveries,
         (SELECT COUNT(*) FROM github_installation_reconciliations
           WHERE installation_id = ?1 OR org_id = 'org_main') AS reconciliations`
    )
      .bind(GITHUB_INSTALLATION_ID)
      .first<{
        claims: number;
        installations: number;
        repositories: number;
        deliveries: number;
        reconciliations: number;
      }>();
    expect(githubResiduals).toEqual({
      claims: 0,
      installations: 0,
      repositories: 0,
      deliveries: 0,
      reconciliations: 0
    });
    const retainedAudit = await env.TEAM_CONTROL_DB.prepare(
      `SELECT actor_id, action, resource_type, resource_id, metadata_json
         FROM audit_events WHERE org_id = 'org_main' ORDER BY created_at`
    ).all<Record<string, unknown>>();
    const retainedAuditJson = JSON.stringify(retainedAudit.results);
    expect(retainedAuditJson).not.toContain(String(GITHUB_INSTALLATION_ID));
    expect(retainedAudit.results.some((row) => String(row.action).startsWith("github."))).toBe(false);
    expect(retainedAudit.results.some((row) => row.action === "privacy.deletion.completed")).toBe(true);
    const retainedCommercialActors = await env.TEAM_CONTROL_DB.prepare(
      `SELECT created_by AS actor FROM checkout_intents WHERE org_id = 'org_main'
       UNION ALL SELECT created_by FROM billing_commands WHERE org_id = 'org_main'
       UNION ALL SELECT requested_by FROM privacy_deletion_requests WHERE org_id = 'org_main'`
    ).all<{ actor: string }>();
    expect(retainedCommercialActors.results).toHaveLength(3);
    for (const row of retainedCommercialActors.results) {
      expect(row.actor).toMatch(/^userp_[a-f0-9]{64}$/u);
      expect(row.actor).not.toBe("user_owner");
    }
    const rejectedAfterDeletion = await stripeWebhook({
      id: "evt_after_deletion",
      type: "invoice.paid",
      created: Math.floor(Date.now() / 1000),
      object: {
        id: "in_after_deletion",
        customer: "cus_after_deletion",
        subscription: "sub_after_deletion",
        metadata: metadata("org_main")
      }
    });
    expect(rejectedAfterDeletion.status).toBe(410);
    expect(
      await env.TEAM_CONTROL_DB.prepare(
        `SELECT COUNT(*) AS count FROM provider_events WHERE event_id = 'evt_after_deletion'`
      ).first<{ count: number }>()
    ).toMatchObject({ count: 0 });
    expect((await api("/v1/orgs/org_main", { token: github.serviceToken })).status).toBe(403);
    const after = await api("/v1/orgs/org_main", { token: owner });
    expect(after.status).toBe(403);
  });
});
