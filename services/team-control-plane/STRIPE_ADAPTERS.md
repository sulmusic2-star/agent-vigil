# Stripe executor and reconciliation adapters

This is an implemented but disabled provider boundary. It has not been deployed, connected to a Stripe account, used to accept a payment, or shown to produce revenue.

## Separation

`wrangler.stripe-executor.jsonc` deploys `src/stripe-adapter/executor-worker.ts`. It receives one internal execution request, atomically leases and reloads the exact prepared command from Team D1, and can create a hosted subscription Checkout Session, set one bound subscription to cancel at period end, or create one refund bound to a reconciled invoice payment. It has no reconciliation signing secret. D1 admits at most one live checkout/subscription workflow per organization, independent of caller idempotency keys.

`wrangler.stripe-reconciler.jsonc` deploys `src/stripe-adapter/reconciler-worker.ts`. It retrieves a stored signed-webhook event, reads the exact Stripe Event and Subscription (and exact Refund for refund events), constructs `billing-reconciliation-v1`, signs it, and submits it over the `TEAM_CONTROL_PLANE` Service Binding. It has no executor invocation secret and sends no mutating Stripe request.

Both `workers_dev` and preview URLs are disabled. `STRIPE_EXECUTION_ENABLED` and `STRIPE_RECONCILIATION_ENABLED` default to `false`.

All Stripe requests send `Stripe-Version: 2026-07-29.dahlia`. Mutations carry stable `avteam:{org_id}:{command_id}` idempotency keys. Network attempts time out after eight seconds and retry at most twice after the first attempt. Stripe `POST` retries reuse identical parameters and idempotency. A deletion race after hosted Checkout creation triggers an exact Session-expiration request; the executor verifies `expired`, records the leased command and intent as compensated/canceled, and does not return a live URL. Checkout completion requires an exactly active organization at both the Worker and D1 serialized boundaries. A completion received during `deletion_pending` is recorded as rejected, cannot bind the subscription, and leaves the compensation state blocking confirmed deletion. Webhooks and reconciliations refuse a confirmed-deleted tenant.

## Team Worker Service Binding contract

The Team Worker signs the exact UTF-8 JSON body as `{unix_seconds}.{raw_body}` using HMAC-SHA256 and sends:

```text
Agent-Vigil-Adapter-Signature: t={unix_seconds},v1={lowercase_hex_hmac}
Content-Type: application/json
```

The executor request to `POST /v1/execute` is:

```json
{
  "schema_version": "stripe-command-execution-request-v1",
  "request_id": "request_opaque",
  "org_id": "org_opaque",
  "command_id": "billing_command_opaque",
  "return_target": "team_billing_v1"
}
```

The adapter does not accept a caller-supplied Stripe price, amount, customer, subscription, success URL, or cancel URL. It reloads those bindings from D1 and the immutable catalog. A successful Checkout response contains the hosted Stripe URL; this response must be returned only to the already-authenticated billing user and must never be logged or cached:

```json
{
  "schema_version": "stripe-command-execution-result-v1",
  "request_id": "request_opaque",
  "command_id": "billing_command_opaque",
  "operation": "create_checkout_session",
  "provider_object_id": "cs_opaque",
  "provider_status": "open",
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_opaque"
}
```

Cancellation and refund results omit `checkout_url`.

The reconciler request to `POST /v1/reconcile` is:

```json
{
  "schema_version": "stripe-reconciliation-request-v1",
  "request_id": "request_opaque",
  "source_event_id": "evt_opaque"
}
```

The response confirms only that a signed snapshot was submitted. Entitlement, cash, and MRR remain authoritative only in the Team control plane after it applies the existing reconciliation contract.

## Exact provider bindings

Checkout requires `subscription` mode, quantity one, one canonical configured Price, tenant `client_reference_id`, and the same minimal metadata on both the Checkout Session and created Subscription. Success and cancellation URLs are fixed environment values; their exact HTTPS origins must be present in `STRIPE_RETURN_ORIGIN_ALLOWLIST`, and the success URL must contain `{CHECKOUT_SESSION_ID}`.

Cancellation requires an accepted D1 command whose subscription ID equals the tenant billing account. Stripe must return the same customer, subscription, one canonical Price/quantity, and `cancel_at_period_end=true`.

Refund requires a same-tenant reconciled `invoice.paid` event and cash-ledger row. The executor reads Stripe InvoicePayments and requires exactly one paid default PaymentIntent, then verifies its customer, currency, succeeded status, received amount, and latest Charge. The accepted API command records only the exact opaque Refund, PaymentIntent, Charge, amount, source-payment event, and command bindings. Reconciliation accepts `refund.created`, fetches that exact Stripe Refund plus its current Charge and Subscription, and requires succeeded status and exact amount/identity agreement. An API-created Refund must match its exact accepted command. A provider-created Refund without command metadata must resolve to one previously confirmed source-payment context by Charge and PaymentIntent; ambiguous or conflicting context fails closed. The current Charge `amount_refunded` must cover every independently applied Refund without exceeding the source payment, so sequential and out-of-order partial events reconcile without replaying an older command amount or double booking. No payment method, email, address, receipt URL, client secret, or raw provider response is stored or returned.

The reconciler accepts Stripe subscription invoices only through `invoice.parent.subscription_details.metadata`. A top-level invoice metadata value cannot override that binding. Because discounts, credits, taxes, partial payments, and off-Stripe payments need a wider accounting policy, payment recognition currently fails closed unless `amount_paid` and `total_excluding_tax` both equal the canonical list amount.

## Required deployment configuration

Executor secrets:

- `TEAM_STRIPE_EXECUTOR_HMAC_SECRET`: at least 32 random bytes, unrelated to every other HMAC secret.
- `STRIPE_EXECUTOR_RESTRICTED_KEY`: a test/live-matched `rk_` key limited to the Checkout Session, Subscription, InvoicePayment, PaymentIntent, and Refund operations used in code.

Reconciler secrets:

- `TEAM_STRIPE_RECONCILER_INVOKE_HMAC_SECRET`: at least 32 unrelated random bytes.
- `STRIPE_READONLY_SECRET_KEY`: a different test/live-matched `rk_` key with read-only Event, Subscription, and Refund access.
- `STRIPE_RECONCILIATION_HMAC_SECRET`: the existing distinct snapshot-signing secret shared only with the Team control plane.

Both deployments require real, environment-specific monthly and annual Price IDs, the same D1 database binding as the Team control plane, and exact test/live-mode agreement. The executor additionally requires production success/cancel URLs and their exact origin allowlist plus permission to expire the exact Checkout Session during compensation. The reconciler requires the internal `TEAM_CONTROL_PLANE` Service Binding. The Stripe webhook endpoint must be created at API version `2026-07-29.dahlia` and register only the documented event types, including `refund.created` rather than relying on charge-wide `charge.refunded`. Control-plane Team-session, commercial-actor, Stripe-webhook, Stripe-reconciliation, GitHub, and measurement HMAC duties must remain pairwise distinct.

No key, Price, return origin, database ID, Service Binding, or feature flag has been activated by this repository change.

Provider behavior is pinned to Stripe's official documentation for [API versioning](https://docs.stripe.com/api/versioning), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), [Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create), [Checkout Session expiration](https://docs.stripe.com/api/checkout/sessions/expire), [subscription metadata on invoices](https://docs.stripe.com/metadata), [InvoicePayments](https://docs.stripe.com/api/invoice-payment), and [refund creation](https://docs.stripe.com/api/refunds/create).
