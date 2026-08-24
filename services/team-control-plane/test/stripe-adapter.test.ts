import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutorEnv, ReconcilerEnv, StripeFetch } from "../src/stripe-adapter/contracts.ts";
import { STRIPE_API_VERSION } from "../src/stripe-adapter/contracts.ts";
import { handleExecution } from "../src/stripe-adapter/executor.ts";
import { handleReconciliation } from "../src/stripe-adapter/reconciler.ts";
import { signatureHeader } from "../src/stripe-adapter/safe.ts";
import { StripeClient } from "../src/stripe-adapter/stripe-http.ts";

const NOW = Date.parse("2026-08-23T20:00:00.000Z");
const EXECUTOR_SECRET = "executor-invocation-secret-at-least-32-bytes";
const RECONCILER_INVOKE_SECRET = "reconciler-invocation-secret-at-least-32-bytes";
const RECONCILIATION_SECRET = "reconciliation-snapshot-secret-at-least-32-bytes";

function executorEnv(overrides: Partial<ExecutorEnv> = {}): ExecutorEnv {
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
    STRIPE_RETURN_ORIGIN_ALLOWLIST: '["https://app.example.test"]',
    ...overrides
  };
}

function reconcilerEnv(controlPlane: Fetcher, overrides: Partial<ReconcilerEnv> = {}): ReconcilerEnv {
  return {
    TEAM_CONTROL_DB: env.TEAM_CONTROL_DB,
    TEAM_CONTROL_PLANE: controlPlane,
    TEAM_STRIPE_RECONCILER_INVOKE_HMAC_SECRET: RECONCILER_INVOKE_SECRET,
    STRIPE_READONLY_SECRET_KEY: "rk_test_reconciler_mock_key_123456789",
    STRIPE_RECONCILIATION_HMAC_SECRET: RECONCILIATION_SECRET,
    STRIPE_RECONCILIATION_ENABLED: "true",
    STRIPE_LIVEMODE: "false",
    STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly_test",
    STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual_test",
    ...overrides
  };
}

async function reset(): Promise<void> {
  await env.TEAM_CONTROL_DB.exec(`
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
    DELETE FROM organization_members;
    DELETE FROM organizations;
  `);
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organizations (id, slug, display_name, status, created_at)
       VALUES ('org_main', 'org-main', 'Org main', 'active', ?1)`
    ).bind(new Date(NOW).toISOString()),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO organization_members
       (org_id, user_id, role, identity_kind, active, created_at, updated_at)
       VALUES ('org_main', 'user_owner', 'owner', 'human', 1, ?1, ?1)`
    ).bind(new Date(NOW).toISOString())
  ]);
}

async function signedRequest(
  path: string,
  body: Record<string, unknown>,
  secret: string
): Promise<Request> {
  const raw = JSON.stringify(body);
  return new Request(`https://adapter.internal${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Agent-Vigil-Adapter-Signature": await signatureHeader(secret, raw, NOW)
    },
    body: raw
  });
}

function stripeJson(body: Record<string, unknown>, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function subscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sub_main",
    object: "subscription",
    livemode: false,
    customer: "cus_main",
    status: "active",
    cancel_at_period_end: false,
    metadata: {
      team_org_id: "org_main",
      internal_price_id: "team_monthly_usd_v1",
      provider_price_id: "price_team_monthly_test"
    },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: Math.floor((NOW - 60_000) / 1000),
          current_period_end: Math.floor((NOW + 30 * 86_400_000) / 1000),
          price: {
            id: "price_team_monthly_test",
            currency: "usd",
            unit_amount: 29_900,
            recurring: { interval: "month", interval_count: 1 }
          }
        }
      ]
    },
    ...overrides
  };
}

async function seedAccount(): Promise<void> {
  await env.TEAM_CONTROL_DB.prepare(
    `INSERT INTO billing_accounts
      (org_id, provider_customer_id, provider_subscription_id, commercial_state,
       internal_price_id, billing_interval, updated_at)
     VALUES ('org_main', 'cus_main', 'sub_main', 'entitled',
             'team_monthly_usd_v1', 'month', ?1)`
  )
    .bind(new Date(NOW).toISOString())
    .run();
}

describe.sequential("separate Stripe executor and reconciler", () => {
  beforeEach(reset);

  it("creates one exactly bound hosted Checkout Session and records provider acceptance", async () => {
    const commandId = "billing_command_checkout";
    const checkoutIntentId = "checkout_intent_main";
    const metadata = {
      team_org_id: "org_main",
      internal_price_id: "team_monthly_usd_v1",
      provider_price_id: "price_team_monthly_test",
      checkout_intent_id: checkoutIntentId,
      contributor_limit: "15"
    };
    const command = {
      schema_version: "checkout-command-v1",
      command_id: commandId,
      provider: "stripe",
      operation: "create_checkout_session",
      idempotency_key: "checkout_idem_1",
      parameters: {
        mode: "subscription",
        quantity: 1,
        provider_price_id: "price_team_monthly_test",
        internal_price_id: "team_monthly_usd_v1",
        client_reference_id: "org_main",
        metadata
      },
      expires_at: new Date(NOW + 30 * 60_000).toISOString()
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO checkout_intents
          (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
           contributor_limit, status, created_by, created_at, expires_at)
         VALUES (?1, 'org_main', 'checkout_idem_1', 'team_monthly_usd_v1', 'month', 29900,
                 15, 'prepared', 'user_owner', ?2, ?3)`
      ).bind(checkoutIntentId, new Date(NOW).toISOString(), command.expires_at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         VALUES (?1, 'org_main', 'create_checkout_session', 'checkout_idem_1', ?2,
                 'prepared', 'user_owner', ?3)`
      ).bind(commandId, JSON.stringify(command), new Date(NOW).toISOString())
    ]);
    const fetchMock = vi.fn<StripeFetch>(async (input, init) => {
      const url = new URL(input.toString());
      expect(url.href).toBe("https://api.stripe.com/v1/checkout/sessions");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Stripe-Version")).toBe(STRIPE_API_VERSION);
      expect(headers.get("Idempotency-Key")).toBe(`avteam:org_main:${commandId}`);
      expect(headers.get("Authorization")).toBe("Bearer rk_test_executor_mock_key_123456789");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("mode")).toBe("subscription");
      expect(form.get("line_items[0][price]")).toBe("price_team_monthly_test");
      expect(form.get("subscription_data[metadata][team_org_id]")).toBe("org_main");
      expect(form.get("success_url")).toContain("{CHECKOUT_SESSION_ID}");
      return stripeJson({
        id: "cs_test_main",
        object: "checkout.session",
        livemode: false,
        mode: "subscription",
        client_reference_id: "org_main",
        success_url: "https://app.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "https://app.example.test/billing/canceled",
        metadata,
        status: "open",
        url: "https://checkout.stripe.com/c/pay/cs_test_main",
        line_items: { data: [{ quantity: 1, price: { id: "price_team_monthly_test" } }] }
      });
    });
    const request = await signedRequest(
      "/v1/execute",
      {
        schema_version: "stripe-command-execution-request-v1",
        request_id: "request_checkout",
        org_id: "org_main",
        command_id: commandId,
        return_target: "team_billing_v1"
      },
      EXECUTOR_SECRET
    );
    const response = await handleExecution(request, executorEnv(), {
      stripeFetch: fetchMock,
      sleep: async () => undefined,
      now: () => NOW
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request_id: "request_checkout",
      command_id: commandId,
      provider_object_id: "cs_test_main",
      checkout_url: "https://checkout.stripe.com/c/pay/cs_test_main"
    });
    const stored = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status, provider_session_id FROM checkout_intents WHERE id = ?1`
    )
      .bind(checkoutIntentId)
      .first<{ status: string; provider_session_id: string }>();
    expect(stored).toEqual({ status: "provider_created", provider_session_id: "cs_test_main" });
  });

  it("expires provider Checkout and records compensation when deletion wins during the network call", async () => {
    const commandId = "billing_command_checkout_race";
    const checkoutIntentId = "checkout_intent_race";
    const metadata = {
      team_org_id: "org_main",
      internal_price_id: "team_monthly_usd_v1",
      provider_price_id: "price_team_monthly_test",
      checkout_intent_id: checkoutIntentId,
      contributor_limit: "15"
    };
    const command = {
      schema_version: "checkout-command-v1",
      command_id: commandId,
      provider: "stripe",
      operation: "create_checkout_session",
      idempotency_key: "checkout_race_idem",
      parameters: {
        mode: "subscription",
        quantity: 1,
        provider_price_id: "price_team_monthly_test",
        internal_price_id: "team_monthly_usd_v1",
        client_reference_id: "org_main",
        metadata
      },
      expires_at: new Date(NOW + 30 * 60_000).toISOString()
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO checkout_intents
          (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
           contributor_limit, status, created_by, created_at, expires_at)
         VALUES (?1, 'org_main', 'checkout_race_idem', 'team_monthly_usd_v1', 'month', 29900,
                 15, 'prepared', 'userp_test', ?2, ?3)`
      ).bind(checkoutIntentId, new Date(NOW).toISOString(), command.expires_at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         VALUES (?1, 'org_main', 'create_checkout_session', 'checkout_race_idem', ?2,
                 'prepared', 'userp_test', ?3)`
      ).bind(commandId, JSON.stringify(command), new Date(NOW).toISOString())
    ]);
    const calls: string[] = [];
    const fetchMock = vi.fn<StripeFetch>(async (input, init) => {
      const path = new URL(input.toString()).pathname;
      calls.push(path);
      if (path === "/v1/checkout/sessions") {
        await env.TEAM_CONTROL_DB.prepare(
          `UPDATE organizations SET status = 'deletion_pending'
            WHERE id = 'org_main' AND status = 'active'`
        ).run();
        return stripeJson({
          id: "cs_test_race",
          object: "checkout.session",
          livemode: false,
          mode: "subscription",
          client_reference_id: "org_main",
          success_url: "https://app.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
          cancel_url: "https://app.example.test/billing/canceled",
          metadata,
          status: "open",
          url: "https://checkout.stripe.com/c/pay/cs_test_race",
          line_items: { data: [{ quantity: 1, price: { id: "price_team_monthly_test" } }] }
        });
      }
      expect(path).toBe("/v1/checkout/sessions/cs_test_race/expire");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
        `avteam:org_main:${commandId}:expire`
      );
      return stripeJson({
        id: "cs_test_race",
        object: "checkout.session",
        livemode: false,
        status: "expired"
      });
    });
    await expect(
      handleExecution(
        await signedRequest(
          "/v1/execute",
          {
            schema_version: "stripe-command-execution-request-v1",
            request_id: "request_checkout_race",
            org_id: "org_main",
            command_id: commandId,
            return_target: "team_billing_v1"
          },
          EXECUTOR_SECRET
        ),
        executorEnv(),
        { stripeFetch: fetchMock, sleep: async () => undefined, now: () => NOW }
      )
    ).rejects.toMatchObject({ status: 409, code: "checkout_compensated_for_deletion" });
    expect(calls).toEqual([
      "/v1/checkout/sessions",
      "/v1/checkout/sessions/cs_test_race/expire"
    ]);
    const state = await env.TEAM_CONTROL_DB.prepare(
      `SELECT i.status AS intent_status, i.provider_session_id, i.compensated_at,
              c.status AS command_status, c.execution_lease_id
         FROM checkout_intents i JOIN billing_commands c ON c.org_id = i.org_id
        WHERE i.id = ?1 AND c.id = ?2`
    )
      .bind(checkoutIntentId, commandId)
      .first<Record<string, unknown>>();
    expect(state).toMatchObject({
      intent_status: "canceled",
      provider_session_id: "cs_test_race",
      command_status: "canceled",
      execution_lease_id: null
    });
    expect(String(state?.compensated_at)).toMatch(/^2026-08-23T20:00:00/u);
    const deleted = await env.TEAM_CONTROL_DB.prepare(
      `UPDATE organizations SET status = 'deleted'
        WHERE id = 'org_main' AND status = 'deletion_pending'
          AND NOT EXISTS (
            SELECT 1 FROM checkout_intents WHERE org_id = 'org_main'
              AND status IN ('executing', 'provider_created', 'compensating')
          )`
    ).run();
    expect(deleted.meta.changes).toBe(1);
  });

  it("executes cancellation only against the tenant-bound subscription", async () => {
    await seedAccount();
    const commandId = "billing_command_cancel";
    const command = {
      schema_version: "billing-command-v1",
      command_id: commandId,
      provider: "stripe",
      operation: "cancel_at_period_end",
      idempotency_key: "cancel_idem_1",
      provider_subscription_id: "sub_main",
      reason: "no_longer_needed"
    };
    await env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_commands
        (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
       VALUES (?1, 'org_main', 'cancel_at_period_end', 'cancel_idem_1', ?2,
               'prepared', 'user_owner', ?3)`
    )
      .bind(commandId, JSON.stringify(command), new Date(NOW).toISOString())
      .run();
    const fetchMock = vi.fn<StripeFetch>(async (input, init) => {
      expect(new URL(input.toString()).pathname).toBe("/v1/subscriptions/sub_main");
      expect(new URLSearchParams(String(init?.body)).get("cancel_at_period_end")).toBe("true");
      return stripeJson(subscription({ cancel_at_period_end: true }));
    });
    const response = await handleExecution(
      await signedRequest(
        "/v1/execute",
        {
          schema_version: "stripe-command-execution-request-v1",
          request_id: "request_cancel",
          org_id: "org_main",
          command_id: commandId,
          return_target: "team_billing_v1"
        },
        EXECUTOR_SECRET
      ),
      executorEnv(),
      { stripeFetch: fetchMock, sleep: async () => undefined, now: () => NOW }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider_status: "cancel_at_period_end" });
  });

  it("executes a refund only through a reconciled invoice, one paid PaymentIntent, and exact charge binding", async () => {
    await seedAccount();
    const summary = {
      orgId: "org_main",
      objectId: "in_main",
      customerId: "cus_main",
      subscriptionId: "sub_main",
      internalPriceId: "team_monthly_usd_v1",
      providerPriceId: "price_team_monthly_test",
      checkoutIntentId: null,
      refundId: null,
      refundAmountCents: null,
      refundChargeId: null,
      refundPaymentIntentId: null,
      refundSourcePaymentEventId: null,
      refundBillingCommandId: null
    };
    const commandId = "billing_command_refund";
    const command = {
      schema_version: "billing-command-v1",
      command_id: commandId,
      provider: "stripe",
      operation: "request_refund",
      idempotency_key: "refund_idem_1",
      amount_cents: 29_900,
      currency: "usd",
      source_payment_event_id: "evt_paid",
      paid_features_materially_used: false,
      reason: "first_subscription_14_day_unused"
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO provider_events
          (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
           summary_json, status, received_at, reconciled_at)
         VALUES ('evt_paid', 'stripe', 'invoice.paid', 'in_main', 'org_main', ?1, ?2,
                 ?3, 'reconciled', ?4, ?4)`
      ).bind(Math.floor(NOW / 1000) - 10, "a".repeat(64), JSON.stringify(summary), new Date(NOW).toISOString()),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO cash_ledger
          (id, org_id, source_event_id, entry_type, amount_cents, currency, occurred_at)
         VALUES ('cash_main', 'org_main', 'evt_paid', 'payment', 29900, 'usd', ?1)`
      ).bind(new Date(NOW).toISOString()),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         VALUES (?1, 'org_main', 'request_refund', 'refund_idem_1', ?2,
                 'prepared', 'user_owner', ?3)`
      ).bind(commandId, JSON.stringify(command), new Date(NOW).toISOString())
    ]);
    const fetchMock = vi.fn<StripeFetch>(async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === "/v1/invoice_payments") {
        expect(init?.method).toBe("GET");
        return stripeJson({
          object: "list",
          has_more: false,
          data: [
            {
              id: "inpay_main",
              object: "invoice_payment",
              livemode: false,
              invoice: "in_main",
              status: "paid",
              is_default: true,
              payment: { type: "payment_intent", payment_intent: "pi_main" }
            }
          ]
        });
      }
      if (url.pathname === "/v1/payment_intents/pi_main") {
        return stripeJson({
          id: "pi_main",
          object: "payment_intent",
          livemode: false,
          customer: "cus_main",
          currency: "usd",
          status: "succeeded",
          amount_received: 29_900,
          latest_charge: "ch_main"
        });
      }
      expect(url.pathname).toBe("/v1/refunds");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(`avteam:org_main:${commandId}`);
      return stripeJson({
        id: "re_main",
        object: "refund",
        livemode: false,
        payment_intent: "pi_main",
        charge: "ch_main",
        currency: "usd",
        amount: 29_900,
        status: "succeeded"
      });
    });
    const response = await handleExecution(
      await signedRequest(
        "/v1/execute",
        {
          schema_version: "stripe-command-execution-request-v1",
          request_id: "request_refund",
          org_id: "org_main",
          command_id: commandId,
          return_target: "team_billing_v1"
        },
        EXECUTOR_SECRET
      ),
      executorEnv(),
      { stripeFetch: fetchMock, sleep: async () => undefined, now: () => NOW }
    );
    expect(response.status).toBe(200);
    const stored = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status, command_json FROM billing_commands WHERE id = ?1`
    )
      .bind(commandId)
      .first<{ status: string; command_json: string }>();
    expect(stored?.status).toBe("provider_accepted");
    expect(JSON.parse(stored!.command_json)).toMatchObject({
      provider_result: { refund_id: "re_main", payment_intent_id: "pi_main", charge_id: "ch_main" }
    });
  });

  it("uses the restricted read-only key to build and sign an exact Dahlia invoice reconciliation", async () => {
    await seedAccount();
    const summary = {
      orgId: "org_main",
      objectId: "in_main",
      customerId: "cus_main",
      subscriptionId: "sub_main",
      internalPriceId: "team_monthly_usd_v1",
      providerPriceId: "price_team_monthly_test",
      checkoutIntentId: null,
      refundId: null,
      refundAmountCents: null,
      refundChargeId: null,
      refundPaymentIntentId: null,
      refundSourcePaymentEventId: null,
      refundBillingCommandId: null
    };
    await env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO provider_events
        (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
         summary_json, status, received_at)
       VALUES ('evt_paid', 'stripe', 'invoice.paid', 'in_main', 'org_main', ?1, ?2,
               ?3, 'awaiting_reconciliation', ?4)`
    )
      .bind(Math.floor(NOW / 1000), "b".repeat(64), JSON.stringify(summary), new Date(NOW).toISOString())
      .run();
    const stripeFetch = vi.fn<StripeFetch>(async (input, init) => {
      const url = new URL(input.toString());
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer rk_test_reconciler_mock_key_123456789");
      expect(headers.get("Stripe-Version")).toBe(STRIPE_API_VERSION);
      if (url.pathname === "/v1/events/evt_paid") {
        return stripeJson({
          id: "evt_paid",
          object: "event",
          api_version: STRIPE_API_VERSION,
          livemode: false,
          created: Math.floor(NOW / 1000),
          type: "invoice.paid",
          data: {
            object: {
              id: "in_main",
              object: "invoice",
              customer: "cus_main",
              currency: "usd",
              status: "paid",
              amount_paid: 29_900,
              total_excluding_tax: 29_900,
              parent: {
                type: "subscription_details",
                subscription_details: {
                  subscription: "sub_main",
                  metadata: {
                    team_org_id: "org_main",
                    internal_price_id: "team_monthly_usd_v1",
                    provider_price_id: "price_team_monthly_test"
                  }
                }
              }
            }
          }
        });
      }
      expect(url.pathname).toBe("/v1/subscriptions/sub_main");
      return stripeJson(subscription());
    });
    let submitted: Record<string, unknown> | null = null;
    const controlPlane = {
      fetch: async (request: Request): Promise<Response> => {
        expect(new URL(request.url).hostname).toBe("team-control-plane.internal");
        expect(request.headers.get("Agent-Vigil-Reconciliation-Signature")).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/u);
        submitted = await request.json<Record<string, unknown>>();
        return stripeJson({ reconciled: true });
      }
    } as unknown as Fetcher;
    const response = await handleReconciliation(
      await signedRequest(
        "/v1/reconcile",
        {
          schema_version: "stripe-reconciliation-request-v1",
          request_id: "request_reconcile",
          source_event_id: "evt_paid"
        },
        RECONCILER_INVOKE_SECRET
      ),
      reconcilerEnv(controlPlane),
      {
        stripeFetch,
        sleep: async () => undefined,
        now: () => NOW,
        randomUUID: () => "00000000-0000-4000-8000-000000000001"
      }
    );
    expect(response.status).toBe(200);
    expect(submitted).toMatchObject({
      schema_version: "billing-reconciliation-v1",
      source_event_id: "evt_paid",
      kind: "payment",
      org_id: "org_main",
      provider_customer_id: "cus_main",
      provider_subscription_id: "sub_main",
      provider_object_id: "in_main",
      cash_amount_cents: 29_900,
      net_recurring_amount_cents: 29_900,
      refund_amount_cents: 0
    });
  });

  it("reconciles a refund only through the accepted Refund, PaymentIntent, Charge, and tenant bindings", async () => {
    await seedAccount();
    const summary = {
      orgId: "org_main",
      objectId: "re_main",
      customerId: "cus_main",
      subscriptionId: "sub_main",
      internalPriceId: "team_monthly_usd_v1",
      providerPriceId: "price_team_monthly_test",
      checkoutIntentId: null,
      refundId: "re_main",
      refundAmountCents: 29_900,
      refundChargeId: "ch_main",
      refundPaymentIntentId: "pi_main",
      refundSourcePaymentEventId: "evt_paid",
      refundBillingCommandId: "billing_command_refund"
    };
    const command = {
      schema_version: "billing-command-v1",
      command_id: "billing_command_refund",
      provider: "stripe",
      operation: "request_refund",
      idempotency_key: "refund_idem_1",
      amount_cents: 29_900,
      currency: "usd",
      source_payment_event_id: "evt_paid",
      paid_features_materially_used: false,
      reason: "first_subscription_14_day_unused",
      provider_result: {
        refund_id: "re_main",
        payment_intent_id: "pi_main",
        charge_id: "ch_main",
        amount_cents: 29_900,
        source_payment_event_id: "evt_paid"
      }
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO provider_events
          (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
           summary_json, status, received_at)
         VALUES ('evt_refund', 'stripe', 'refund.created', 're_main', 'org_main', ?1, ?2,
                 ?3, 'awaiting_reconciliation', ?4)`
      ).bind(Math.floor(NOW / 1000), "c".repeat(64), JSON.stringify(summary), new Date(NOW).toISOString()),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         VALUES ('billing_command_refund', 'org_main', 'request_refund', 'refund_idem_1', ?1,
                 'provider_accepted', 'user_owner', ?2)`
      ).bind(JSON.stringify(command), new Date(NOW).toISOString())
    ]);
    const stripeFetch = vi.fn<StripeFetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = new URL(input.toString());
      if (url.pathname === "/v1/events/evt_refund") {
        return stripeJson({
          id: "evt_refund",
          object: "event",
          api_version: STRIPE_API_VERSION,
          livemode: false,
          created: Math.floor(NOW / 1000),
          type: "refund.created",
          data: {
            object: {
              id: "re_main",
              object: "refund",
              livemode: false,
              charge: "ch_main",
              payment_intent: "pi_main",
              currency: "usd",
              status: "succeeded",
              amount: 29_900,
              metadata: {
                team_org_id: "org_main",
                source_payment_event_id: "evt_paid",
                billing_command_id: "billing_command_refund"
              }
            }
          }
        });
      }
      if (url.pathname === "/v1/subscriptions/sub_main") return stripeJson(subscription());
      if (url.pathname === "/v1/refunds/re_main") {
        return stripeJson({
          id: "re_main",
          object: "refund",
          livemode: false,
          charge: "ch_main",
          payment_intent: "pi_main",
          amount: 29_900,
          currency: "usd",
          status: "succeeded",
          metadata: {
            team_org_id: "org_main",
            source_payment_event_id: "evt_paid",
            billing_command_id: "billing_command_refund"
          }
        });
      }
      expect(url.pathname).toBe("/v1/charges/ch_main");
      return stripeJson({
        id: "ch_main",
        object: "charge",
        livemode: false,
        customer: "cus_main",
        payment_intent: "pi_main",
        currency: "usd",
        status: "succeeded",
        amount_refunded: 29_900
      });
    });
    let submitted: Record<string, unknown> | null = null;
    const controlPlane = {
      fetch: async (request: Request): Promise<Response> => {
        submitted = await request.json<Record<string, unknown>>();
        return stripeJson({ reconciled: true });
      }
    } as unknown as Fetcher;
    const response = await handleReconciliation(
      await signedRequest(
        "/v1/reconcile",
        {
          schema_version: "stripe-reconciliation-request-v1",
          request_id: "request_refund_reconcile",
          source_event_id: "evt_refund"
        },
        RECONCILER_INVOKE_SECRET
      ),
      reconcilerEnv(controlPlane),
      {
        stripeFetch,
        sleep: async () => undefined,
        now: () => NOW,
        randomUUID: () => "00000000-0000-4000-8000-000000000002"
      }
    );
    expect(response.status).toBe(200);
    expect(submitted).toMatchObject({
      source_event_id: "evt_refund",
      kind: "refund",
      provider_object_id: "re_main",
      provider_status: "refunded",
      refund_amount_cents: 29_900,
      net_recurring_amount_cents: 29_900,
      provider_refund_id: "re_main",
      provider_charge_id: "ch_main",
      provider_payment_intent_id: "pi_main",
      source_payment_event_id: "evt_paid",
      billing_command_id: "billing_command_refund",
      cumulative_refund_amount_cents: 29_900
    });
  });

  it("reconciles an out-of-band partial Refund from its exact provider identity and amount", async () => {
    await seedAccount();
    const paidSummary = {
      orgId: "org_main",
      objectId: "in_main",
      customerId: "cus_main",
      subscriptionId: "sub_main",
      internalPriceId: "team_monthly_usd_v1",
      providerPriceId: "price_team_monthly_test",
      checkoutIntentId: null,
      refundId: null,
      refundAmountCents: null,
      refundChargeId: null,
      refundPaymentIntentId: null,
      refundSourcePaymentEventId: null,
      refundBillingCommandId: null
    };
    const outOfBandSummary = {
      ...paidSummary,
      objectId: "re_out_of_band",
      refundId: "re_out_of_band",
      refundAmountCents: 19_900,
      refundChargeId: "ch_main",
      refundPaymentIntentId: "pi_main",
      refundSourcePaymentEventId: "evt_paid",
      refundBillingCommandId: null
    };
    const priorCommand = {
      schema_version: "billing-command-v1",
      command_id: "billing_command_prior_refund",
      provider: "stripe",
      operation: "request_refund",
      idempotency_key: "refund_prior_idem",
      amount_cents: 10_000,
      currency: "usd",
      source_payment_event_id: "evt_paid",
      paid_features_materially_used: true,
      reason: "case_by_case",
      provider_result: {
        refund_id: "re_prior_api",
        payment_intent_id: "pi_main",
        charge_id: "ch_main",
        amount_cents: 10_000,
        source_payment_event_id: "evt_paid"
      }
    };
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO provider_events
          (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
           summary_json, status, received_at, reconciled_at)
         VALUES ('evt_paid', 'stripe', 'invoice.paid', 'in_main', 'org_main', ?1, ?2,
                 ?3, 'reconciled', ?4, ?4)`
      ).bind(Math.floor(NOW / 1000) - 10, "d".repeat(64), JSON.stringify(paidSummary), new Date(NOW).toISOString()),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO cash_ledger
          (id, org_id, source_event_id, entry_type, amount_cents, currency, occurred_at)
         VALUES ('cash_main', 'org_main', 'evt_paid', 'payment', 29900, 'usd', ?1)`
      ).bind(new Date(NOW).toISOString()),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         VALUES ('billing_command_prior_refund', 'org_main', 'request_refund', 'refund_prior_idem', ?1,
                 'provider_accepted', 'user_owner', ?2)`
      ).bind(JSON.stringify(priorCommand), new Date(NOW).toISOString()),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO provider_events
          (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
           summary_json, status, received_at)
         VALUES ('evt_refund_out_of_band', 'stripe', 'refund.created', 're_out_of_band', 'org_main', ?1, ?2,
                 ?3, 'awaiting_reconciliation', ?4)`
      ).bind(Math.floor(NOW / 1000), "e".repeat(64), JSON.stringify(outOfBandSummary), new Date(NOW).toISOString())
    ]);

    const stripeFetch = vi.fn<StripeFetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = new URL(input.toString());
      if (url.pathname === "/v1/events/evt_refund_out_of_band") {
        return stripeJson({
          id: "evt_refund_out_of_band",
          object: "event",
          api_version: STRIPE_API_VERSION,
          livemode: false,
          created: Math.floor(NOW / 1000),
          type: "refund.created",
          data: {
            object: {
              id: "re_out_of_band",
              object: "refund",
              livemode: false,
              charge: "ch_main",
              payment_intent: "pi_main",
              currency: "usd",
              status: "succeeded",
              amount: 19_900,
              metadata: {}
            }
          }
        });
      }
      if (url.pathname === "/v1/subscriptions/sub_main") return stripeJson(subscription());
      if (url.pathname === "/v1/refunds/re_out_of_band") {
        return stripeJson({
          id: "re_out_of_band",
          object: "refund",
          livemode: false,
          charge: "ch_main",
          payment_intent: "pi_main",
          amount: 19_900,
          currency: "usd",
          status: "succeeded",
          metadata: {}
        });
      }
      expect(url.pathname).toBe("/v1/charges/ch_main");
      return stripeJson({
        id: "ch_main",
        object: "charge",
        livemode: false,
        customer: "cus_main",
        payment_intent: "pi_main",
        currency: "usd",
        status: "succeeded",
        amount_refunded: 29_900
      });
    });
    let submitted: Record<string, unknown> | null = null;
    const controlPlane = {
      fetch: async (request: Request): Promise<Response> => {
        submitted = await request.json<Record<string, unknown>>();
        return stripeJson({ reconciled: true });
      }
    } as unknown as Fetcher;
    const response = await handleReconciliation(
      await signedRequest(
        "/v1/reconcile",
        {
          schema_version: "stripe-reconciliation-request-v1",
          request_id: "request_out_of_band_refund_reconcile",
          source_event_id: "evt_refund_out_of_band"
        },
        RECONCILER_INVOKE_SECRET
      ),
      reconcilerEnv(controlPlane),
      {
        stripeFetch,
        sleep: async () => undefined,
        now: () => NOW,
        randomUUID: () => "00000000-0000-4000-8000-000000000003"
      }
    );
    expect(response.status).toBe(200);
    expect(submitted).toMatchObject({
      source_event_id: "evt_refund_out_of_band",
      kind: "refund",
      provider_object_id: "re_out_of_band",
      refund_amount_cents: 19_900,
      net_recurring_amount_cents: 19_900,
      provider_refund_id: "re_out_of_band",
      provider_charge_id: "ch_main",
      provider_payment_intent_id: "pi_main",
      source_payment_event_id: "evt_paid",
      billing_command_id: null,
      cumulative_refund_amount_cents: 29_900
    });
  });

  it("keeps both workers inert while their feature flags are off", async () => {
    const fetchMock = vi.fn<StripeFetch>();
    await expect(
      handleExecution(
        new Request("https://adapter.internal/v1/execute", { method: "POST", body: "{}" }),
        executorEnv({ STRIPE_EXECUTION_ENABLED: "false" }),
        { stripeFetch: fetchMock }
      )
    ).rejects.toMatchObject({ code: "feature_disabled", status: 503 });
    const controlPlane = { fetch: vi.fn() } as unknown as Fetcher;
    await expect(
      handleReconciliation(
        new Request("https://adapter.internal/v1/reconcile", { method: "POST", body: "{}" }),
        reconcilerEnv(controlPlane, { STRIPE_RECONCILIATION_ENABLED: "false" }),
        { stripeFetch: fetchMock }
      )
    ).rejects.toMatchObject({ code: "feature_disabled", status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects every active Stripe adapter duty-secret collision before reading commands", async () => {
    await expect(
      handleExecution(
        new Request("https://adapter.internal/v1/execute", { method: "POST", body: "{}" }),
        executorEnv({ STRIPE_EXECUTOR_RESTRICTED_KEY: EXECUTOR_SECRET })
      )
    ).rejects.toMatchObject({ status: 503, code: "adapter_secret_configuration_invalid" });

    const controlPlane = { fetch: vi.fn() } as unknown as Fetcher;
    const base = reconcilerEnv(controlPlane);
    const keys = [
      "TEAM_STRIPE_RECONCILER_INVOKE_HMAC_SECRET",
      "STRIPE_READONLY_SECRET_KEY",
      "STRIPE_RECONCILIATION_HMAC_SECRET"
    ] as const;
    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        const leftKey = keys[left]!;
        const rightKey = keys[right]!;
        await expect(
          handleReconciliation(
            new Request("https://adapter.internal/v1/reconcile", { method: "POST", body: "{}" }),
            { ...base, [rightKey]: base[leftKey] }
          )
        ).rejects.toMatchObject({ status: 503, code: "adapter_secret_configuration_invalid" });
      }
    }
  });

  it("retries a transient Stripe failure with identical idempotency and bounds network timeouts", async () => {
    const attempts: Array<{ idempotency: string | null; body: string }> = [];
    const transientFetch = vi.fn<StripeFetch>(async (_input, init) => {
      attempts.push({
        idempotency: new Headers(init?.headers).get("Idempotency-Key"),
        body: String(init?.body)
      });
      if (attempts.length === 1) {
        return stripeJson({ error: { type: "api_error" } }, 503, { "Stripe-Should-Retry": "true" });
      }
      return stripeJson({ id: "re_retry", object: "refund", livemode: false });
    });
    const client = new StripeClient({
      fetch: transientFetch,
      secretKey: "rk_test_executor_mock_key_123456789",
      livemode: false,
      keyMode: "mutation",
      sleep: async () => undefined,
      timeoutMs: 100
    });
    await expect(
      client.request("/v1/refunds", {
        method: "POST",
        form: new URLSearchParams({ payment_intent: "pi_retry" }),
        idempotencyKey: "avteam:org_main:command_retry"
      })
    ).resolves.toMatchObject({ id: "re_retry" });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);

    const timeoutFetch = vi.fn<StripeFetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true
        });
      });
    });
    const timeoutClient = new StripeClient({
      fetch: timeoutFetch,
      secretKey: "rk_test_reconciler_mock_key_123456789",
      livemode: false,
      keyMode: "read_only",
      sleep: async () => undefined,
      timeoutMs: 5
    });
    await expect(timeoutClient.request("/v1/events/evt_timeout")).rejects.toMatchObject({
      code: "stripe_unavailable",
      status: 503
    });
    expect(timeoutFetch).toHaveBeenCalledTimes(3);
  });
});
