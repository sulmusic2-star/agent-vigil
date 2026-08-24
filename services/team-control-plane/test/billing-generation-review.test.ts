import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/auth.ts";
import { handleProviderReconciliation, handleStripeWebhook, prepareCancellation } from "../src/billing.ts";
import { hmacHex } from "../src/crypto.ts";
import type { ExecutorEnv, ReconcilerEnv, StripeFetch } from "../src/stripe-adapter/contracts.ts";
import { STRIPE_API_VERSION } from "../src/stripe-adapter/contracts.ts";
import { handleExecution } from "../src/stripe-adapter/executor.ts";
import { handleReconciliation } from "../src/stripe-adapter/reconciler.ts";
import { signatureHeader } from "../src/stripe-adapter/safe.ts";

const WEBHOOK_SECRET = "test-only-stripe-webhook-secret-32-bytes-minimum";
const RECONCILIATION_SECRET = "test-only-reconciliation-secret-32-bytes-minimum";
const EXECUTOR_SECRET = "billing-review-executor-secret-at-least-32-bytes";
const RECONCILER_INVOKE_SECRET = "billing-review-reconciler-invoke-at-least-32-bytes";

const auth: AuthContext = {
  userId: "user_owner",
  orgId: "org_main",
  role: "owner",
  identityKind: "human",
  sessionId: "session_billing_review"
};

async function reset(): Promise<void> {
  await env.TEAM_CONTROL_DB.prepare(`DROP TRIGGER billing_generation_event_delete_guard`).run();
  try {
    await env.TEAM_CONTROL_DB.exec(`
      DELETE FROM workflow_integrity_receipts;
      DELETE FROM checkout_subscription_compensations;
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
      DELETE FROM organization_members;
      DELETE FROM organizations;
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
  const at = new Date().toISOString();
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organizations (id, slug, display_name, status, created_at)
       VALUES ('org_main', 'org-main', 'Org main', 'active', ?1)`
    ).bind(at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organization_members
        (org_id, user_id, role, identity_kind, active, created_at, updated_at)
       VALUES ('org_main', 'user_owner', 'owner', 'human', 1, ?1, ?1)`
    ).bind(at)
  ]);
}

function checkoutMetadata(
  checkoutIntentId: string,
  billingGeneration: number | null
): Record<string, string> {
  return {
    team_org_id: "org_main",
    internal_price_id: "team_monthly_usd_v1",
    provider_price_id: "price_team_monthly_test",
    ...(billingGeneration === null ? {} : { billing_generation: String(billingGeneration) }),
    checkout_intent_id: checkoutIntentId,
    contributor_limit: "15"
  };
}

async function webhook(
  id: string,
  type: string,
  object: Record<string, unknown>,
  created = Math.floor(Date.now() / 1000)
): Promise<Response> {
  const raw = JSON.stringify({
    id,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created,
    livemode: false,
    type,
    data: { object }
  });
  const timestamp = Math.floor(Date.now() / 1000);
  return handleStripeWebhook(
    new Request("https://team.example.test/v1/billing/stripe/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${timestamp},v1=${await hmacHex(WEBHOOK_SECRET, `${timestamp}.${raw}`)}`
      },
      body: raw
    }),
    env
  );
}

function executorEnv(): ExecutorEnv {
  return {
    TEAM_CONTROL_DB: env.TEAM_CONTROL_DB,
    TEAM_STRIPE_EXECUTOR_HMAC_SECRET: EXECUTOR_SECRET,
    STRIPE_EXECUTOR_RESTRICTED_KEY: "rk_test_executor_mock_key_123456789",
    STRIPE_EXECUTION_ENABLED: "true",
    STRIPE_LIVEMODE: "false",
    STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly_test",
    STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual_test",
    STRIPE_SUCCESS_URL: "https://app.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
    STRIPE_CANCEL_URL: "https://app.example.test/billing/canceled",
    STRIPE_RETURN_ORIGIN_ALLOWLIST: '["https://app.example.test"]'
  };
}

function reconcilerEnv(controlPlane: Fetcher): ReconcilerEnv {
  return {
    TEAM_CONTROL_DB: env.TEAM_CONTROL_DB,
    TEAM_CONTROL_PLANE: controlPlane,
    TEAM_STRIPE_RECONCILER_INVOKE_HMAC_SECRET: RECONCILER_INVOKE_SECRET,
    STRIPE_READONLY_SECRET_KEY: "rk_test_billing_review_readonly_123456789",
    STRIPE_RECONCILIATION_HMAC_SECRET: RECONCILIATION_SECRET,
    STRIPE_RECONCILIATION_ENABLED: "true",
    STRIPE_LIVEMODE: "false",
    STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly_test",
    STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual_test"
  };
}

async function executionRequest(commandId: string, requestId: string, now: number): Promise<Request> {
  const raw = JSON.stringify({
    schema_version: "stripe-command-execution-request-v1",
    request_id: requestId,
    org_id: "org_main",
    command_id: commandId,
    return_target: "team_billing_v1"
  });
  return new Request("https://adapter.internal/v1/execute", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-Adapter-Signature": await signatureHeader(EXECUTOR_SECRET, raw, now)
    },
    body: raw
  });
}

async function reconciliationRequest(eventId: string, requestId: string, now: number): Promise<Request> {
  const raw = JSON.stringify({
    schema_version: "stripe-reconciliation-request-v1",
    request_id: requestId,
    source_event_id: eventId
  });
  return new Request("https://adapter.internal/v1/reconcile", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-Adapter-Signature": await signatureHeader(RECONCILER_INVOKE_SECRET, raw, now)
    },
    body: raw
  });
}

function canceledSubscription(
  subscriptionId: string,
  customerId: string,
  metadata: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({
      id: subscriptionId,
      object: "subscription",
      livemode: false,
      customer: customerId,
      status: "canceled",
      metadata,
      items: { data: [{ quantity: 1, price: { id: "price_team_monthly_test" } }] }
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

describe.sequential("billing-generation independent review regressions", () => {
  beforeEach(reset);

  it("drains separate missing/wrong-generation Checkout compensations during deletion without swallowing either", async () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const checkoutIntentId = "checkout_review_queue";
    const commandId = "billing_command_review_queue";
    const canonicalMetadata = checkoutMetadata(checkoutIntentId, 1);
    const command = {
      schema_version: "checkout-command-v1",
      command_id: commandId,
      provider: "stripe",
      operation: "create_checkout_session",
      idempotency_key: "checkout_review_queue_idem",
      parameters: {
        mode: "subscription",
        quantity: 1,
        provider_price_id: "price_team_monthly_test",
        internal_price_id: "team_monthly_usd_v1",
        client_reference_id: "org_main",
        metadata: canonicalMetadata
      },
      expires_at: new Date(now + 30 * 60_000).toISOString(),
      provider_result: { session_id: "cs_expected_review" }
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, checkout_intent_id, internal_price_id, status,
           provider_checkout_session_id, reserved_at)
         VALUES ('org_main', 1, ?1, 'team_monthly_usd_v1', 'reserved', 'cs_expected_review', ?2)`
      ).bind(checkoutIntentId, at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO checkout_intents
          (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
           contributor_limit, status, provider_session_id, created_by, created_at, expires_at, billing_generation)
         VALUES (?1, 'org_main', 'checkout_review_queue_idem', 'team_monthly_usd_v1', 'month', 29900,
                 15, 'provider_created', 'cs_expected_review', 'userp_review', ?2, ?3, 1)`
      ).bind(checkoutIntentId, at, command.expires_at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         VALUES (?1, 'org_main', 'create_checkout_session', 'checkout_review_queue_idem', ?2,
                 'provider_accepted', 'userp_review', ?3)`
      ).bind(commandId, JSON.stringify(command), at),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE organizations SET status = 'deletion_pending' WHERE id = 'org_main'`
      )
    ]);

    const missingMetadata = checkoutMetadata(checkoutIntentId, null);
    const wrongMetadata = checkoutMetadata(checkoutIntentId, 99);
    await expect(
      webhook("evt_review_missing_generation", "checkout.session.completed", {
        id: "cs_review_missing_generation",
        mode: "subscription",
        customer: "cus_review_shared_extra",
        subscription: "sub_review_shared_extra",
        metadata: missingMetadata
      })
    ).rejects.toMatchObject({ status: 409, code: "checkout_completion_frozen_for_deletion" });
    await expect(
      webhook("evt_review_wrong_generation", "checkout.session.completed", {
        id: "cs_review_wrong_generation",
        mode: "subscription",
        customer: "cus_review_shared_extra",
        subscription: "sub_review_shared_extra",
        metadata: wrongMetadata
      })
    ).rejects.toMatchObject({ status: 409, code: "checkout_completion_frozen_for_deletion" });

    const reserved = await env.TEAM_CONTROL_DB.prepare(
      `SELECT COUNT(*) AS count,
              COUNT(DISTINCT provider_event_id) AS events,
              COUNT(DISTINCT provider_session_id || ':' || provider_subscription_id) AS bindings
         FROM checkout_subscription_compensations
        WHERE org_id = 'org_main' AND status = 'prepared'
          AND reason = 'unexpected_generation_binding'`
    ).first<{ count: number; events: number; bindings: number }>();
    expect(reserved).toEqual({ count: 2, events: 2, bindings: 2 });

    const compensationOrder = await env.TEAM_CONTROL_DB.prepare(
      `SELECT provider_session_id FROM checkout_subscription_compensations
        WHERE org_id = 'org_main' AND status = 'prepared'
        ORDER BY requested_at, id`
    ).all<{ provider_session_id: string }>();
    const metadataBySession = new Map([
      ["cs_review_missing_generation", missingMetadata],
      ["cs_review_wrong_generation", wrongMetadata]
    ]);
    const canceled: string[] = [];
    const stripeFetch = vi.fn<StripeFetch>(async (input) => {
      const subscriptionId = new URL(input.toString()).pathname.split("/").pop()!;
      expect(subscriptionId).toBe("sub_review_shared_extra");
      const providerSessionId = compensationOrder.results[canceled.length]?.provider_session_id;
      const metadata = providerSessionId ? metadataBySession.get(providerSessionId) : undefined;
      if (!metadata || !providerSessionId) throw new Error("unexpected compensation order");
      canceled.push(providerSessionId);
      return canceledSubscription(subscriptionId, "cus_review_shared_extra", metadata);
    });
    const executionNow = Date.now() + 1_000;
    for (const requestId of ["request_review_comp_1", "request_review_comp_2"]) {
      await expect(
        handleExecution(
          await executionRequest(commandId, requestId, executionNow),
          executorEnv(),
          { stripeFetch, sleep: async () => undefined, now: () => executionNow }
        )
      ).rejects.toMatchObject({ status: 409, code: "unexpected_checkout_subscription_compensated" });
    }
    expect(canceled.sort()).toEqual(["cs_review_missing_generation", "cs_review_wrong_generation"]);
    const final = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM checkout_subscription_compensations
           WHERE org_id = 'org_main' AND status = 'completed') AS completed,
         (SELECT COUNT(*) FROM workflow_integrity_receipts
           WHERE workflow_type = 'unexpected_checkout_subscription_compensated') AS receipts,
         (SELECT status FROM billing_commands WHERE id = ?1) AS command_status,
         (SELECT status FROM billing_generations WHERE org_id = 'org_main' AND generation = 1) AS generation_status,
         (SELECT provider_subscription_id FROM billing_generations
           WHERE org_id = 'org_main' AND generation = 1) AS generation_subscription`
    )
      .bind(commandId)
      .first<Record<string, unknown>>();
    expect(final).toEqual({
      completed: 2,
      receipts: 2,
      command_status: "provider_accepted",
      generation_status: "reserved",
      generation_subscription: null
    });
  });

  it("accepts a missing-generation Checkout only through the migration marker and exact reserved Session", async () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const checkoutIntentId = "checkout_review_legacy_bridge";
    const commandId = "billing_command_review_legacy_bridge";
    const command = {
      schema_version: "checkout-command-v1",
      command_id: commandId,
      provider: "stripe",
      operation: "create_checkout_session",
      idempotency_key: "checkout_review_legacy_bridge_idem",
      parameters: {
        mode: "subscription",
        quantity: 1,
        provider_price_id: "price_team_monthly_test",
        internal_price_id: "team_monthly_usd_v1",
        client_reference_id: "org_main",
        metadata: checkoutMetadata(checkoutIntentId, 1)
      },
      expires_at: new Date(now + 30 * 60_000).toISOString(),
      provider_result: { session_id: "cs_review_legacy_expected" }
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, checkout_intent_id, internal_price_id, status,
           provider_checkout_session_id, reserved_at)
         VALUES ('org_main', 1, ?1, 'team_monthly_usd_v1', 'reserved',
                 'cs_review_legacy_expected', ?2)`
      ).bind(checkoutIntentId, at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO checkout_intents
          (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
           contributor_limit, status, provider_session_id, created_by, created_at, expires_at, billing_generation)
         VALUES (?1, 'org_main', 'checkout_review_legacy_bridge_idem', 'team_monthly_usd_v1',
                 'month', 29900, 15, 'provider_created', 'cs_review_legacy_expected',
                 'userp_review', ?2, ?3, 1)`
      ).bind(checkoutIntentId, at, command.expires_at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         VALUES (?1, 'org_main', 'create_checkout_session', 'checkout_review_legacy_bridge_idem',
                 ?2, 'provider_accepted', 'userp_review', ?3)`
      ).bind(commandId, JSON.stringify(command), at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO workflow_integrity_receipts
          (id, workflow_type, source_ref, valid, created_at)
         VALUES ('integrity_checkout_review_legacy_eligible',
                 'legacy_billing_generation_bridge_eligible', 'org_main:1', 1, ?1)`
      ).bind(at)
    ]);

    const response = await webhook("evt_review_legacy_checkout", "checkout.session.completed", {
      id: "cs_review_legacy_expected",
      mode: "subscription",
      customer: "cus_review_legacy",
      subscription: "sub_review_legacy",
      metadata: checkoutMetadata(checkoutIntentId, null)
    });
    expect(response.status).toBe(200);
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT g.status, g.provider_customer_id, g.provider_subscription_id,
              pe.status AS provider_event_status,
              json_extract(pe.summary_json, '$.billingGenerationSource') AS generation_source,
              (SELECT COUNT(*) FROM workflow_integrity_receipts
                WHERE workflow_type = 'legacy_billing_generation_bridge_applied'
                  AND source_ref = 'evt_review_legacy_checkout') AS bridge_receipts,
              (SELECT COUNT(*) FROM checkout_subscription_compensations
                WHERE org_id = 'org_main') AS compensations
         FROM billing_generations g
         JOIN provider_events pe ON pe.event_id = 'evt_review_legacy_checkout'
        WHERE g.org_id = 'org_main' AND g.generation = 1`
    ).first<Record<string, unknown>>();
    expect(state).toEqual({
      status: "bound",
      provider_customer_id: "cus_review_legacy",
      provider_subscription_id: "sub_review_legacy",
      provider_event_status: "reconciled",
      generation_source: "legacy_unique_binding",
      bridge_receipts: 1,
      compensations: 0
    });
  });

  it("compensates a missing-generation Session created after migration for an unmarked prepared successor", async () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const checkoutIntentId = "checkout_review_unmarked_successor";
    const commandId = "billing_command_review_unmarked_successor";
    const command = {
      schema_version: "checkout-command-v1",
      command_id: commandId,
      provider: "stripe",
      operation: "create_checkout_session",
      idempotency_key: "checkout_review_unmarked_successor_idem",
      parameters: {
        mode: "subscription",
        quantity: 1,
        provider_price_id: "price_team_monthly_test",
        internal_price_id: "team_monthly_usd_v1",
        client_reference_id: "org_main",
        metadata: checkoutMetadata(checkoutIntentId, 2)
      },
      expires_at: new Date(now + 30 * 60_000).toISOString(),
      provider_result: { session_id: "cs_review_unmarked_successor" }
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, internal_price_id, status, provider_customer_id,
           provider_subscription_id, reserved_at, bound_at, terminal_verified_at,
           terminal_source_event_id, retired_at)
         VALUES ('org_main', 1, 'team_monthly_usd_v1', 'retired', 'cus_review_legacy_old',
                 'sub_review_legacy_old', ?1, ?1, ?1, 'evt_review_legacy_old_terminal', ?1)`
      ).bind(at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, checkout_intent_id, internal_price_id, status,
           provider_checkout_session_id, reserved_at)
         VALUES ('org_main', 2, ?1, 'team_monthly_usd_v1', 'reserved',
                 'cs_review_unmarked_successor', ?2)`
      ).bind(checkoutIntentId, at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO checkout_intents
          (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
           contributor_limit, status, provider_session_id, created_by, created_at, expires_at, billing_generation)
         VALUES (?1, 'org_main', 'checkout_review_unmarked_successor_idem', 'team_monthly_usd_v1',
                 'month', 29900, 15, 'provider_created', 'cs_review_unmarked_successor',
                 'userp_review', ?2, ?3, 2)`
      ).bind(checkoutIntentId, at, command.expires_at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         VALUES (?1, 'org_main', 'create_checkout_session', 'checkout_review_unmarked_successor_idem',
                 ?2, 'provider_accepted', 'userp_review', ?3)`
      ).bind(commandId, JSON.stringify(command), at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO workflow_integrity_receipts
          (id, workflow_type, source_ref, valid, created_at)
         VALUES ('integrity_review_old_generation_eligible',
                 'legacy_billing_generation_bridge_eligible', 'org_main:1', 1, ?1)`
      ).bind(at)
    ]);

    await expect(
      webhook("evt_review_unmarked_successor", "checkout.session.completed", {
        id: "cs_review_unmarked_successor",
        mode: "subscription",
        customer: "cus_review_unmarked_successor",
        subscription: "sub_review_unmarked_successor",
        metadata: checkoutMetadata(checkoutIntentId, null)
      })
    ).rejects.toMatchObject({ status: 409, code: "checkout_completion_requires_compensation" });
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT g.status, g.provider_customer_id, g.provider_subscription_id,
              pe.status AS provider_event_status,
              x.status AS compensation_status, x.reason,
              x.provider_session_id, x.provider_subscription_id AS compensation_subscription,
              (SELECT COUNT(*) FROM workflow_integrity_receipts
                WHERE workflow_type = 'legacy_billing_generation_bridge_eligible'
                  AND source_ref = 'org_main:2') AS successor_markers
         FROM billing_generations g
         JOIN provider_events pe ON pe.event_id = 'evt_review_unmarked_successor'
         JOIN checkout_subscription_compensations x ON x.provider_event_id = pe.event_id
        WHERE g.org_id = 'org_main' AND g.generation = 2`
    ).first<Record<string, unknown>>();
    expect(state).toEqual({
      status: "reserved",
      provider_customer_id: null,
      provider_subscription_id: null,
      provider_event_status: "rejected",
      compensation_status: "prepared",
      reason: "unexpected_generation_binding",
      provider_session_id: "cs_review_unmarked_successor",
      compensation_subscription: "sub_review_unmarked_successor",
      successor_markers: 0
    });
  });

  it("prepares and executes cancellation for a fully refunded but still-bound current generation", async () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, internal_price_id, status, provider_customer_id,
           provider_subscription_id, reserved_at, bound_at)
         VALUES ('org_main', 1, 'team_monthly_usd_v1', 'bound', 'cus_refunded_bound',
                 'sub_refunded_bound', ?1, ?1)`
      ).bind(at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_accounts
          (org_id, provider_customer_id, provider_subscription_id, commercial_state,
           internal_price_id, billing_interval, billing_generation, updated_at)
         VALUES ('org_main', 'cus_refunded_bound', 'sub_refunded_bound', 'refunded',
                 'team_monthly_usd_v1', 'month', 1, ?1)`
      ).bind(at)
    ]);
    const request = () =>
      new Request("https://team.example.test/v1/orgs/org_main/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "cancel_refunded_bound" },
        body: JSON.stringify({ reason: "no_longer_needed" })
      });
    const prepared = await prepareCancellation(request(), env, auth);
    expect(prepared.status).toBe(202);
    const preparedBody = await prepared.json<{ command_id: string; command: Record<string, unknown> }>();
    expect(preparedBody.command).toMatchObject({
      provider_subscription_id: "sub_refunded_bound",
      billing_generation: 1
    });
    const duplicate = await prepareCancellation(request(), env, auth);
    expect(await duplicate.json()).toMatchObject({ duplicate: true, command_id: preparedBody.command_id });

    const stripeFetch = vi.fn<StripeFetch>(async () =>
      new Response(
        JSON.stringify({
          id: "sub_refunded_bound",
          object: "subscription",
          livemode: false,
          customer: "cus_refunded_bound",
          cancel_at_period_end: true,
          items: {
            data: [
              {
                quantity: 1,
                current_period_start: Math.floor((now - 60_000) / 1000),
                current_period_end: Math.floor((now + 86_400_000) / 1000),
                price: { id: "price_team_monthly_test" }
              }
            ]
          }
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    );
    const executed = await handleExecution(
      await executionRequest(preparedBody.command_id, "request_cancel_refunded_bound", now),
      executorEnv(),
      { stripeFetch, sleep: async () => undefined, now: () => now }
    );
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({ provider_object_id: "sub_refunded_bound" });
    expect(stripeFetch).toHaveBeenCalledTimes(1);
  });

  it("bridges only a migration-approved unique retired generation and keeps the current old event stale", async () => {
    const at = new Date().toISOString();
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, internal_price_id, status, provider_customer_id, provider_subscription_id,
           reserved_at, bound_at, terminal_verified_at, terminal_source_event_id, retired_at)
         VALUES ('org_main', 1, 'team_monthly_usd_v1', 'retired', 'cus_retired_review', 'sub_retired_review',
                 ?1, ?1, ?1, 'evt_terminal_review', ?1)`
      ).bind(at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, internal_price_id, status, provider_customer_id, provider_subscription_id,
           reserved_at, bound_at)
         VALUES ('org_main', 2, 'team_monthly_usd_v1', 'bound', 'cus_current_review', 'sub_current_review', ?1, ?1)`
      ).bind(at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_accounts
          (org_id, provider_customer_id, provider_subscription_id, commercial_state,
           internal_price_id, billing_interval, billing_generation,
           last_reconciled_event_created, last_reconciled_event_id, updated_at)
         VALUES ('org_main', 'cus_current_review', 'sub_current_review', 'entitled',
                 'team_monthly_usd_v1', 'month', 2, 200, 'evt_current_head', ?1)`
      ).bind(at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO workflow_integrity_receipts
          (id, workflow_type, source_ref, valid, created_at)
         VALUES ('integrity_legacy_review_eligible', 'legacy_billing_generation_bridge_eligible',
                 'org_main:1', 1, ?1)`
      ).bind(at)
    ]);
    const legacyMetadata = {
      team_org_id: "org_main",
      internal_price_id: "team_monthly_usd_v1",
      provider_price_id: "price_team_monthly_test"
    };
    const retiredResponse = await webhook(
      "evt_retired_legacy_review",
      "invoice.payment_failed",
      {
        id: "in_retired_legacy_review",
        customer: "cus_retired_review",
        subscription: "sub_retired_review",
        metadata: legacyMetadata
      },
      100
    );
    expect(await retiredResponse.json()).toMatchObject({ awaiting_reconciliation: true });
    const bridgeReceipt = await env.TEAM_CONTROL_DB.prepare(
      `SELECT valid FROM workflow_integrity_receipts
        WHERE workflow_type = 'legacy_billing_generation_bridge_applied'
          AND source_ref = 'evt_retired_legacy_review'`
    ).first<{ valid: number }>();
    expect(bridgeReceipt).toEqual({ valid: 1 });

    const reconciliation = {
      schema_version: "billing-reconciliation-v1",
      reconciliation_id: "recon_retired_legacy_review",
      observed_at: new Date().toISOString(),
      source_event_id: "evt_retired_legacy_review",
      kind: "payment_failure",
      org_id: "org_main",
      provider_customer_id: "cus_retired_review",
      provider_subscription_id: "sub_retired_review",
      provider_object_id: "in_retired_legacy_review",
      internal_price_id: "team_monthly_usd_v1",
      provider_price_id: "price_team_monthly_test",
      billing_generation: 1,
      provider_status: "failed",
      currency: "usd",
      cash_amount_cents: 0,
      net_recurring_amount_cents: 0,
      refund_amount_cents: 0,
      provider_refund_id: null,
      provider_charge_id: null,
      provider_payment_intent_id: null,
      source_payment_event_id: null,
      billing_command_id: null,
      cumulative_refund_amount_cents: 0,
      period_start: new Date(Date.now() - 60_000).toISOString(),
      period_end: new Date(Date.now() + 86_400_000).toISOString(),
      cancel_at_period_end: false
    };
    const raw = JSON.stringify(reconciliation);
    const timestamp = Math.floor(Date.now() / 1000);
    await expect(
      handleProviderReconciliation(
        new Request("https://team.example.test/v1/billing/stripe/reconciliation", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Agent-Vigil-Reconciliation-Signature": `t=${timestamp},v1=${await hmacHex(
              RECONCILIATION_SECRET,
              `${timestamp}.${raw}`
            )}`
          },
          body: raw
        }),
        env
      )
    ).rejects.toMatchObject({ status: 409, code: "retired_billing_generation" });

    const currentResponse = await webhook(
      "evt_current_old_review",
      "invoice.payment_failed",
      {
        id: "in_current_old_review",
        customer: "cus_current_review",
        subscription: "sub_current_review",
        metadata: { ...legacyMetadata, billing_generation: "2" }
      },
      100
    );
    expect(await currentResponse.json()).toMatchObject({ stale: true });
    const history = await env.TEAM_CONTROL_DB.prepare(
      `SELECT
         (SELECT status FROM provider_events WHERE event_id = 'evt_retired_legacy_review') AS retired_event_status,
         (SELECT COUNT(*) FROM billing_generation_events
           WHERE org_id = 'org_main' AND generation = 1
             AND event_type = 'late_provider_event_ignored'
             AND source_ref = 'evt_retired_legacy_review') AS retired_history,
         (SELECT status FROM provider_events WHERE event_id = 'evt_current_old_review') AS current_event_status,
         (SELECT billing_generation FROM billing_accounts WHERE org_id = 'org_main') AS current_generation`
    ).first<Record<string, unknown>>();
    expect(history).toEqual({
      retired_event_status: "stale",
      retired_history: 1,
      current_event_status: "stale",
      current_generation: 2
    });
  });

  it("reconciles legacy subscription metadata only with exact marker and applied bridge evidence", async () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const eventCreated = Math.floor(now / 1000);
    const eventId = "evt_review_legacy_reconcile";
    const checkoutIntentId = "checkout_review_legacy_reconcile";
    const legacyMetadata = checkoutMetadata(checkoutIntentId, null);
    const summary = {
      orgId: "org_main",
      objectId: "in_review_legacy_reconcile",
      customerId: "cus_review_legacy_reconcile",
      subscriptionId: "sub_review_legacy_reconcile",
      internalPriceId: "team_monthly_usd_v1",
      providerPriceId: "price_team_monthly_test",
      reportedInternalPriceId: "team_monthly_usd_v1",
      reportedProviderPriceId: "price_team_monthly_test",
      billingGeneration: 1,
      reportedBillingGeneration: null,
      billingGenerationSource: "legacy_unique_binding",
      checkoutIntentId,
      checkoutSessionId: null,
      refundId: null,
      refundAmountCents: null,
      refundChargeId: null,
      refundPaymentIntentId: null,
      refundSourcePaymentEventId: null,
      refundBillingCommandId: null
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO checkout_intents
          (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
           contributor_limit, status, provider_session_id, created_by, created_at, expires_at,
           billing_generation)
         VALUES (?1, 'org_main', 'checkout_review_legacy_reconcile_idem', 'team_monthly_usd_v1',
                 'month', 29900, 15, 'completed', 'cs_review_legacy_reconcile', 'userp_review',
                 ?2, ?3, 1)`
      ).bind(checkoutIntentId, at, new Date(now + 30 * 60_000).toISOString()),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, checkout_intent_id, internal_price_id, status,
           provider_checkout_session_id, provider_customer_id, provider_subscription_id,
           reserved_at, bound_at)
         VALUES ('org_main', 1, ?1, 'team_monthly_usd_v1', 'bound',
                 'cs_review_legacy_reconcile', 'cus_review_legacy_reconcile',
                 'sub_review_legacy_reconcile', ?2, ?2)`
      ).bind(checkoutIntentId, at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO provider_events
          (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
           summary_json, status, received_at)
         VALUES (?1, 'stripe', 'invoice.payment_failed', 'in_review_legacy_reconcile',
                 'org_main', ?2, ?3, ?4, 'awaiting_reconciliation', ?5)`
      ).bind(eventId, eventCreated, "e".repeat(64), JSON.stringify(summary), at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO workflow_integrity_receipts
          (id, workflow_type, source_ref, valid, created_at)
         VALUES ('integrity_review_legacy_reconcile_eligible',
                 'legacy_billing_generation_bridge_eligible', 'org_main:1', 1, ?1)`
      ).bind(at)
    ]);

    let providerMetadata: Record<string, string> = legacyMetadata;
    const stripeFetch = vi.fn<StripeFetch>(async (input) => {
      const path = new URL(input.toString()).pathname;
      if (path === `/v1/events/${eventId}`) {
        return new Response(
          JSON.stringify({
            id: eventId,
            object: "event",
            api_version: STRIPE_API_VERSION,
            created: eventCreated,
            livemode: false,
            type: "invoice.payment_failed",
            data: {
              object: {
                id: "in_review_legacy_reconcile",
                object: "invoice",
                customer: "cus_review_legacy_reconcile",
                currency: "usd",
                status: "open",
                amount_paid: 0,
                parent: {
                  type: "subscription_details",
                  subscription_details: {
                    subscription: "sub_review_legacy_reconcile",
                    metadata: providerMetadata
                  }
                }
              }
            }
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
      expect(path).toBe("/v1/subscriptions/sub_review_legacy_reconcile");
      return new Response(
        JSON.stringify({
          id: "sub_review_legacy_reconcile",
          object: "subscription",
          livemode: false,
          customer: "cus_review_legacy_reconcile",
          status: "past_due",
          cancel_at_period_end: false,
          metadata: providerMetadata,
          items: {
            data: [
              {
                quantity: 1,
                current_period_start: Math.floor((now - 60_000) / 1000),
                current_period_end: Math.floor((now + 86_400_000) / 1000),
                price: {
                  id: "price_team_monthly_test",
                  currency: "usd",
                  unit_amount: 29900,
                  recurring: { interval: "month", interval_count: 1 }
                }
              }
            ]
          }
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    });
    const submitted = vi.fn(async (_request: Request) => new Response("{}", { status: 200 }));
    const controlPlane = { fetch: submitted } as unknown as Fetcher;
    const dependencies = {
      stripeFetch,
      sleep: async () => undefined,
      now: () => now,
      randomUUID: () => "00000000-0000-4000-8000-000000000099"
    };

    await expect(
      handleReconciliation(
        await reconciliationRequest(eventId, "request_review_legacy_no_applied_receipt", now),
        reconcilerEnv(controlPlane),
        dependencies
      )
    ).rejects.toMatchObject({ status: 409, code: "provider_binding_mismatch" });
    expect(submitted).not.toHaveBeenCalled();

    await env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts
        (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'legacy_billing_generation_bridge_applied', ?2, 1, ?3)`
    )
      .bind(`integrity_legacy_billing_generation_bridge_${eventId}`, eventId, at)
      .run();
    providerMetadata = checkoutMetadata(checkoutIntentId, 2);
    await expect(
      handleReconciliation(
        await reconciliationRequest(eventId, "request_review_legacy_wrong_generation", now),
        reconcilerEnv(controlPlane),
        dependencies
      )
    ).rejects.toMatchObject({ status: 409, code: "provider_binding_mismatch" });
    expect(submitted).not.toHaveBeenCalled();

    providerMetadata = legacyMetadata;
    const response = await handleReconciliation(
      await reconciliationRequest(eventId, "request_review_legacy_exact", now),
      reconcilerEnv(controlPlane),
      dependencies
    );
    expect(response.status).toBe(200);
    expect(submitted).toHaveBeenCalledTimes(1);
    const submittedRequest = submitted.mock.calls[0]![0] as Request;
    expect(await submittedRequest.json()).toMatchObject({
      source_event_id: eventId,
      kind: "payment_failure",
      org_id: "org_main",
      provider_customer_id: "cus_review_legacy_reconcile",
      provider_subscription_id: "sub_review_legacy_reconcile",
      billing_generation: 1
    });
  });
});
