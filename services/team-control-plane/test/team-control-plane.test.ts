import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

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

function metadata(orgId: string, checkoutIntentId: string | null = null): Record<string, string> {
  return {
    team_org_id: orgId,
    internal_price_id: "team_monthly_usd_v1",
    provider_price_id: "price_team_monthly_test",
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

async function reconcile(body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(RECONCILIATION_SECRET, `${timestamp}.${raw}`);
  return exports.default.fetch(`${ORIGIN}/v1/billing/stripe/reconciliation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-Reconciliation-Signature": `t=${timestamp},v1=${signature}`
    },
    body: raw
  });
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
    provider_status: "active",
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

async function activateMonthlyTeam(eventCreated: number): Promise<void> {
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

  it("normalizes annual recurring value and applies confirmed period-end cancellation then expiration", async () => {
    const created = Math.floor(Date.now() / 1000);
    const annualMetadata = {
      team_org_id: "org_main",
      internal_price_id: "team_annual_usd_v1",
      provider_price_id: "price_team_annual_test"
    };
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

  it("rejects provider customer or subscription identifiers already bound to another tenant", async () => {
    await seedOrganization("org_other");
    const at = new Date().toISOString();
    await env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_accounts
        (org_id, provider_customer_id, provider_subscription_id, commercial_state, updated_at)
       VALUES ('org_other', 'cus_collision', 'sub_collision', 'entitled', ?1)`
    )
      .bind(at)
      .run();
    const created = Math.floor(Date.now() / 1000);
    const event = await stripeWebhook({
      id: "evt_collision",
      type: "invoice.paid",
      created,
      object: {
        id: "in_collision",
        customer: "cus_collision",
        subscription: "sub_collision",
        metadata: metadata("org_main")
      }
    });
    expect(event.status).toBe(200);
    const result = await reconcile(
      reconciliation({
        source_event_id: "evt_collision",
        provider_customer_id: "cus_collision",
        provider_subscription_id: "sub_collision",
        provider_object_id: "in_collision"
      })
    );
    expect(result.status).toBe(409);
    const ledger = await api("/v1/orgs/org_main/billing/ledger", { token: await session() });
    expect(await json(ledger)).toMatchObject({ entitlement: null, recognized_mrr: { minor_unit_micros: 0 } });
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
