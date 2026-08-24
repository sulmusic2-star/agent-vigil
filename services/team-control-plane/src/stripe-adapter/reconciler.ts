import type {
  BillingAccountRow,
  InternalPriceId,
  ProviderEventRow,
  ReconcilerEnv,
  ReconciliationInvocation,
  ReconciliationSnapshot,
  RuntimeDependencies,
  StripeSummary
} from "./contracts.ts";
import { STRIPE_API_VERSION } from "./contracts.ts";
import {
  AdapterError,
  assertAdapterDutySecretSeparation,
  boolean,
  configuredPrice,
  exactKeys,
  integer,
  internalPriceId,
  isRecord,
  listAmountCents,
  liveMode,
  noStoreJson,
  opaqueId,
  parseJson,
  readBoundedBody,
  record,
  signatureHeader,
  string,
  verifyInvocation
} from "./safe.ts";
import {
  billingAccount,
  parsedSummary,
  providerEvent,
  refundProviderBinding,
  refundSourceBinding
} from "./store.ts";
import { StripeClient, stripePath } from "./stripe-http.ts";

interface SubscriptionBinding {
  id: string;
  customerId: string;
  internalPriceId: InternalPriceId;
  providerPriceId: string;
  periodStart: number;
  periodEnd: number;
  status: string;
  cancelAtPeriodEnd: boolean;
}

function invocation(raw: string): ReconciliationInvocation {
  const body = parseJson(raw);
  exactKeys(body, ["schema_version", "request_id", "source_event_id"], "body");
  if (body.schema_version !== "stripe-reconciliation-request-v1") {
    throw new AdapterError(400, "invalid_contract", "Reconciliation request schema is invalid.");
  }
  return {
    schema_version: body.schema_version,
    request_id: opaqueId(body.request_id, "request_id"),
    source_event_id: opaqueId(body.source_event_id, "source_event_id")
  };
}

function metadata(value: unknown, field: string): Record<string, unknown> {
  const parsed = record(value, field);
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string" || key.length > 40 || item.length > 255) {
      throw new AdapterError(409, "provider_binding_mismatch", "Stripe metadata is invalid.");
    }
  }
  return parsed;
}

function metadataBinding(value: unknown, expected: StripeSummary, field: string): void {
  const parsed = metadata(value, field);
  if (
    parsed.team_org_id !== expected.orgId ||
    parsed.internal_price_id !== expected.internalPriceId ||
    parsed.provider_price_id !== expected.providerPriceId
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe metadata does not match the stored tenant binding.");
  }
}

function refundMetadataBinding(value: unknown, expected: StripeSummary, field: string): void {
  const parsed = metadata(value, field);
  const commandBound = expected.refundBillingCommandId !== null;
  if (commandBound && (
    parsed.team_org_id !== expected.orgId ||
    parsed.source_payment_event_id !== expected.refundSourcePaymentEventId ||
    parsed.billing_command_id !== expected.refundBillingCommandId
  )) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe Refund metadata does not match the exact command binding.");
  }
  if (!commandBound && (
    (parsed.team_org_id !== undefined && parsed.team_org_id !== expected.orgId) ||
    (parsed.source_payment_event_id !== undefined &&
      parsed.source_payment_event_id !== expected.refundSourcePaymentEventId) ||
    parsed.billing_command_id !== undefined
  )) {
    throw new AdapterError(409, "provider_binding_mismatch", "Out-of-band Stripe Refund metadata conflicts with provider truth.");
  }
}

function subscriptionBinding(
  object: Record<string, unknown>,
  expected: StripeSummary,
  env: ReconcilerEnv
): SubscriptionBinding {
  const id = opaqueId(object.id, "subscription.id");
  const customerId = opaqueId(object.customer, "subscription.customer");
  metadataBinding(object.metadata, expected, "subscription.metadata");
  if (object.object !== "subscription" || id !== expected.subscriptionId || customerId !== expected.customerId) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe subscription does not match the stored binding.");
  }
  const items = record(object.items, "subscription.items");
  if (!Array.isArray(items.data) || items.data.length !== 1 || !isRecord(items.data[0])) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe subscription item set is not canonical.");
  }
  const item = items.data[0];
  const price = record(item.price, "subscription.items[0].price");
  const priceId = opaqueId(price.id, "subscription.items[0].price.id");
  if (
    priceId !== expected.providerPriceId ||
    priceId !== configuredPrice(env, expected.internalPriceId) ||
    item.quantity !== 1 ||
    price.currency !== "usd" ||
    price.unit_amount !== listAmountCents(expected.internalPriceId)
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe subscription price is not canonical.");
  }
  const recurring = record(price.recurring, "subscription.items[0].price.recurring");
  const expectedInterval = expected.internalPriceId === "team_monthly_usd_v1" ? "month" : "year";
  if (recurring.interval !== expectedInterval || recurring.interval_count !== 1) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe billing interval is not canonical.");
  }
  const periodStart = integer(item.current_period_start, "current_period_start", 1);
  const periodEnd = integer(item.current_period_end, "current_period_end", 1);
  if (periodEnd <= periodStart) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe subscription period is invalid.");
  }
  return {
    id,
    customerId,
    internalPriceId: expected.internalPriceId,
    providerPriceId: priceId,
    periodStart,
    periodEnd,
    status: string(object.status, "subscription.status", 32),
    cancelAtPeriodEnd: boolean(object.cancel_at_period_end, "subscription.cancel_at_period_end")
  };
}

function invoiceSubscriptionDetails(invoice: Record<string, unknown>): {
  subscriptionId: string;
  metadata: Record<string, unknown>;
} {
  const parent = record(invoice.parent, "invoice.parent");
  if (parent.type !== "subscription_details") {
    throw new AdapterError(409, "provider_binding_mismatch", "Invoice is not a subscription invoice.");
  }
  const details = record(parent.subscription_details, "invoice.parent.subscription_details");
  return {
    subscriptionId: opaqueId(details.subscription, "invoice.parent.subscription_details.subscription"),
    metadata: metadata(details.metadata, "invoice.parent.subscription_details.metadata")
  };
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function baseSnapshot(
  event: ProviderEventRow,
  summary: StripeSummary,
  subscription: SubscriptionBinding,
  now: number,
  randomUUID: () => string
): Omit<
  ReconciliationSnapshot,
  "kind" | "provider_status" | "cash_amount_cents" | "net_recurring_amount_cents" | "refund_amount_cents"
> {
  return {
    schema_version: "billing-reconciliation-v1",
    reconciliation_id: `recon_${randomUUID()}`,
    observed_at: new Date(now).toISOString(),
    source_event_id: event.event_id,
    org_id: summary.orgId,
    provider_customer_id: subscription.customerId,
    provider_subscription_id: subscription.id,
    provider_object_id: event.object_id,
    internal_price_id: summary.internalPriceId,
    provider_price_id: summary.providerPriceId,
    currency: "usd",
    period_start: iso(subscription.periodStart),
    period_end: iso(subscription.periodEnd),
    cancel_at_period_end: subscription.cancelAtPeriodEnd,
    provider_refund_id: null,
    provider_charge_id: null,
    provider_payment_intent_id: null,
    source_payment_event_id: null,
    billing_command_id: null,
    cumulative_refund_amount_cents: 0
  };
}

function verifyEventEnvelope(
  object: Record<string, unknown>,
  row: ProviderEventRow,
  livemode: boolean
): Record<string, unknown> {
  if (
    object.object !== "event" ||
    object.id !== row.event_id ||
    object.type !== row.event_type ||
    object.created !== row.event_created ||
    object.api_version !== STRIPE_API_VERSION ||
    object.livemode !== livemode
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe Event does not match the signed webhook record.");
  }
  const data = record(object.data, "event.data");
  const providerObject = record(data.object, "event.data.object");
  if (providerObject.id !== row.object_id) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe Event object does not match the signed webhook record.");
  }
  return providerObject;
}

async function subscriptionFor(
  stripe: StripeClient,
  account: BillingAccountRow | null,
  summary: StripeSummary,
  env: ReconcilerEnv
): Promise<SubscriptionBinding> {
  if (
    !account ||
    account.provider_customer_id !== summary.customerId ||
    account.provider_subscription_id !== summary.subscriptionId ||
    account.internal_price_id !== summary.internalPriceId ||
    !summary.subscriptionId
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stored billing account does not match the provider event.");
  }
  const object = await stripe.request(stripePath("subscriptions", summary.subscriptionId));
  return subscriptionBinding(object, summary, env);
}

async function buildSnapshot(
  stripe: StripeClient,
  env: ReconcilerEnv,
  row: ProviderEventRow,
  event: Record<string, unknown>,
  now: number,
  randomUUID: () => string
): Promise<ReconciliationSnapshot> {
  const summary = parsedSummary(row);
  if (summary.providerPriceId !== configuredPrice(env, summary.internalPriceId)) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stored provider price is not canonical.");
  }
  const account = await billingAccount(env.TEAM_CONTROL_DB, summary.orgId);
  const providerObject = verifyEventEnvelope(event, row, liveMode(env.STRIPE_LIVEMODE));
  const subscription = await subscriptionFor(stripe, account, summary, env);
  const base = baseSnapshot(row, summary, subscription, now, randomUUID);

  if (row.event_type === "invoice.paid" || row.event_type === "invoice.payment_failed") {
    if (providerObject.object !== "invoice" || providerObject.customer !== summary.customerId) {
      throw new AdapterError(409, "provider_binding_mismatch", "Stripe invoice does not match the stored binding.");
    }
    const details = invoiceSubscriptionDetails(providerObject);
    metadataBinding(details.metadata, summary, "invoice.parent.subscription_details.metadata");
    if (details.subscriptionId !== summary.subscriptionId || providerObject.currency !== "usd") {
      throw new AdapterError(409, "provider_binding_mismatch", "Stripe invoice subscription is not canonical.");
    }
    if (row.event_type === "invoice.paid") {
      const listAmount = listAmountCents(summary.internalPriceId);
      if (
        providerObject.status !== "paid" ||
        providerObject.amount_paid !== listAmount ||
        providerObject.total_excluding_tax !== listAmount
      ) {
        throw new AdapterError(
          409,
          "unsupported_invoice_economics",
          "Discounted, credited, taxed, partial, or off-Stripe invoices are not enabled for recognition."
        );
      }
      return {
        ...base,
        kind: "payment",
        provider_status: "paid",
        cash_amount_cents: listAmount,
        net_recurring_amount_cents: listAmount,
        refund_amount_cents: 0
      };
    }
    if (providerObject.status === "paid" || providerObject.amount_paid !== 0) {
      throw new AdapterError(409, "provider_binding_mismatch", "Failed invoice provider state is inconsistent.");
    }
    return {
      ...base,
      kind: "payment_failure",
      provider_status: "failed",
      cash_amount_cents: 0,
      net_recurring_amount_cents: 0,
      refund_amount_cents: 0
    };
  }

  if (row.event_type === "customer.subscription.updated" || row.event_type === "customer.subscription.deleted") {
    const eventSubscription = subscriptionBinding(providerObject, summary, env);
    if (
      eventSubscription.id !== subscription.id ||
      eventSubscription.customerId !== subscription.customerId ||
      eventSubscription.providerPriceId !== subscription.providerPriceId
    ) {
      throw new AdapterError(409, "provider_binding_mismatch", "Subscription event does not match current provider state.");
    }
    let status: "active" | "past_due" | "canceled";
    if (row.event_type === "customer.subscription.deleted") {
      if (eventSubscription.status !== "canceled") {
        throw new AdapterError(409, "provider_binding_mismatch", "Deleted subscription event is not canceled.");
      }
      status = "canceled";
    } else if (eventSubscription.status === "active") {
      status = "active";
    } else if (["past_due", "unpaid"].includes(eventSubscription.status)) {
      status = "past_due";
    } else {
      throw new AdapterError(409, "unsupported_subscription_state", "Stripe subscription state is not supported.");
    }
    return {
      ...base,
      kind: "subscription",
      provider_status: status,
      cash_amount_cents: 0,
      net_recurring_amount_cents: 0,
      refund_amount_cents: 0,
      cancel_at_period_end: eventSubscription.cancelAtPeriodEnd
    };
  }

  if (row.event_type === "refund.created") {
    if (
      !summary.refundId ||
      !summary.refundChargeId ||
      !summary.refundPaymentIntentId ||
      !summary.refundSourcePaymentEventId ||
      !summary.refundAmountCents
    ) {
      throw new AdapterError(500, "provider_binding_corrupt", "Stored Refund binding is incomplete.");
    }
    if (
      providerObject.object !== "refund" ||
      providerObject.id !== summary.refundId ||
      providerObject.charge !== summary.refundChargeId ||
      providerObject.payment_intent !== summary.refundPaymentIntentId ||
      providerObject.currency !== "usd" ||
      providerObject.amount !== summary.refundAmountCents
    ) {
      throw new AdapterError(409, "provider_binding_mismatch", "Refund event does not match the stored exact Refund binding.");
    }
    refundMetadataBinding(providerObject.metadata, summary, "refund.metadata");
    const binding = summary.refundBillingCommandId
      ? await refundProviderBinding(env.TEAM_CONTROL_DB, summary.orgId, summary.refundId)
      : await refundSourceBinding(
          env.TEAM_CONTROL_DB,
          summary.orgId,
          summary.refundChargeId,
          summary.refundPaymentIntentId,
          summary.refundSourcePaymentEventId
        );
    if (
      binding.commandId !== summary.refundBillingCommandId ||
      binding.chargeId !== summary.refundChargeId ||
      binding.paymentIntentId !== summary.refundPaymentIntentId ||
      (binding.amountCents !== null && binding.amountCents !== summary.refundAmountCents) ||
      binding.sourcePaymentEventId !== summary.refundSourcePaymentEventId
    ) {
      throw new AdapterError(409, "provider_binding_mismatch", "Refund does not match the accepted exact command.");
    }
    const exactRefundId = summary.refundId;
    const exactRefundAmountCents = summary.refundAmountCents;
    const refund = await stripe.request(stripePath("refunds", exactRefundId));
    if (
      refund.object !== "refund" ||
      refund.id !== exactRefundId ||
      refund.charge !== binding.chargeId ||
      refund.payment_intent !== binding.paymentIntentId ||
      refund.amount !== exactRefundAmountCents ||
      refund.currency !== "usd" ||
      !["pending", "requires_action", "succeeded"].includes(string(refund.status, "refund.status", 32))
    ) {
      throw new AdapterError(409, "provider_binding_mismatch", "Stripe refund does not match the accepted command.");
    }
    if (refund.status !== "succeeded") {
      throw new AdapterError(409, "refund_not_settled", "Stripe refund is not yet succeeded.");
    }
    refundMetadataBinding(refund.metadata, summary, "refund.metadata");
    const charge = await stripe.request(stripePath("charges", binding.chargeId));
    const cumulativeRefundAmountCents = integer(charge.amount_refunded, "charge.amount_refunded", exactRefundAmountCents);
    if (
      charge.object !== "charge" ||
      charge.id !== binding.chargeId ||
      charge.customer !== summary.customerId ||
      charge.payment_intent !== binding.paymentIntentId ||
      charge.currency !== "usd" ||
      charge.status !== "succeeded" ||
      cumulativeRefundAmountCents < exactRefundAmountCents
    ) {
      throw new AdapterError(409, "provider_binding_mismatch", "Charge cumulative refund state is not canonical.");
    }
    return {
      ...base,
      kind: "refund",
      provider_status: "refunded",
      cash_amount_cents: 0,
      net_recurring_amount_cents: exactRefundAmountCents,
      refund_amount_cents: exactRefundAmountCents,
      provider_refund_id: exactRefundId,
      provider_charge_id: binding.chargeId,
      provider_payment_intent_id: binding.paymentIntentId,
      source_payment_event_id: binding.sourcePaymentEventId,
      billing_command_id: binding.commandId,
      cumulative_refund_amount_cents: cumulativeRefundAmountCents
    };
  }

  throw new AdapterError(409, "event_not_reconcilable", "Provider event type is not reconcilable.");
}

async function submitSnapshot(
  env: ReconcilerEnv,
  snapshot: ReconciliationSnapshot,
  now: number,
  sleep: (milliseconds: number) => Promise<void>
): Promise<void> {
  const raw = JSON.stringify(snapshot);
  const signature = await signatureHeader(env.STRIPE_RECONCILIATION_HMAC_SECRET, raw, now);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await env.TEAM_CONTROL_PLANE.fetch(
        new Request("https://team-control-plane.internal/v1/billing/stripe/reconciliation", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Agent-Vigil-Reconciliation-Signature": signature
          },
          body: raw,
          signal: controller.signal
        })
      );
      clearTimeout(timeout);
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      if (response.status < 500 || attempt === 1) {
        throw new AdapterError(502, "reconciliation_rejected", "Team control plane rejected reconciliation.");
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof AdapterError) throw error;
      if (attempt === 1) {
        throw new AdapterError(503, "control_plane_unavailable", "Team control plane was unavailable.");
      }
    }
    await sleep(100);
  }
}

export async function handleReconciliation(
  request: Request,
  env: ReconcilerEnv,
  dependencies: RuntimeDependencies = {}
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/reconcile") {
    throw new AdapterError(404, "not_found", "Route not found.");
  }
  if (env.STRIPE_RECONCILIATION_ENABLED !== "true") {
    throw new AdapterError(503, "feature_disabled", "Stripe reconciliation is disabled.");
  }
  assertAdapterDutySecretSeparation([
    { name: "TEAM_STRIPE_RECONCILER_INVOKE_HMAC_SECRET", value: env.TEAM_STRIPE_RECONCILER_INVOKE_HMAC_SECRET },
    { name: "STRIPE_READONLY_SECRET_KEY", value: env.STRIPE_READONLY_SECRET_KEY },
    { name: "STRIPE_RECONCILIATION_HMAC_SECRET", value: env.STRIPE_RECONCILIATION_HMAC_SECRET }
  ]);
  const now = dependencies.now?.() ?? Date.now();
  const raw = await readBoundedBody(request);
  await verifyInvocation(request, raw, env.TEAM_STRIPE_RECONCILER_INVOKE_HMAC_SECRET, now);
  const input = invocation(raw);
  const row = await providerEvent(env.TEAM_CONTROL_DB, input.source_event_id);
  const stripe = new StripeClient({
    fetch: dependencies.stripeFetch ?? fetch,
    secretKey: env.STRIPE_READONLY_SECRET_KEY,
    livemode: liveMode(env.STRIPE_LIVEMODE),
    keyMode: "read_only",
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {})
  });
  const event = await stripe.request(stripePath("events", row.event_id));
  const snapshot = await buildSnapshot(
    stripe,
    env,
    row,
    event,
    now,
    dependencies.randomUUID ?? (() => crypto.randomUUID())
  );
  const sleep = dependencies.sleep ?? (async (milliseconds: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
  await submitSnapshot(env, snapshot, now, sleep);
  return noStoreJson({
    schema_version: "stripe-reconciliation-result-v1",
    request_id: input.request_id,
    source_event_id: row.event_id,
    provider_object_id: row.object_id,
    submitted: true
  });
}
