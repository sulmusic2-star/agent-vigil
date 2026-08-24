import type {
  BillingAccountRow,
  BillingCommandRow,
  ExecutionInvocation,
  ExecutorEnv,
  InternalPriceId,
  RuntimeDependencies
} from "./contracts.ts";
import {
  AdapterError,
  assertAdapterDutySecretSeparation,
  boolean,
  configuredPrice,
  exactKeys,
  integer,
  internalPriceId,
  isRecord,
  liveMode,
  noStoreJson,
  opaqueId,
  orgId,
  parseJson,
  readBoundedBody,
  record,
  string,
  verifyInvocation
} from "./safe.ts";
import {
  billingAccount,
  claimCheckoutExecution,
  checkoutIntent,
  executableCommand,
  markCheckoutAccepted,
  markCheckoutCompensated,
  markCheckoutSubscriptionCompensated,
  markCommandAccepted,
  sourcePaymentContext
} from "./store.ts";
import { checkoutSessionExpirePath, invoicePaymentsPath, StripeClient, stripePath } from "./stripe-http.ts";

interface ParsedCheckout {
  command: Record<string, unknown>;
  checkoutIntentId: string;
  internalPriceId: InternalPriceId;
  providerPriceId: string;
  metadata: Record<string, string>;
}

interface ParsedCancellation {
  command: Record<string, unknown>;
  providerSubscriptionId: string;
}

interface ParsedRefund {
  command: Record<string, unknown>;
  amountCents: number;
  sourcePaymentEventId: string;
  reason: string;
}

function executionInvocation(raw: string): ExecutionInvocation {
  const body = parseJson(raw);
  exactKeys(body, ["schema_version", "request_id", "org_id", "command_id", "return_target"], "body");
  if (body.schema_version !== "stripe-command-execution-request-v1" || body.return_target !== "team_billing_v1") {
    throw new AdapterError(400, "invalid_contract", "Execution request schema is invalid.");
  }
  return {
    schema_version: body.schema_version,
    request_id: opaqueId(body.request_id, "request_id"),
    org_id: orgId(body.org_id),
    command_id: opaqueId(body.command_id, "command_id"),
    return_target: body.return_target
  };
}

function commandObject(row: BillingCommandRow, baseKeys: readonly string[]): Record<string, unknown> {
  const command = parseJson(row.command_json, "billing command");
  const expected = command.provider_result === undefined ? baseKeys : [...baseKeys, "provider_result"];
  exactKeys(command, expected, "billing command");
  if (
    command.command_id !== row.id ||
    command.idempotency_key !== row.idempotency_key ||
    command.provider !== "stripe" ||
    command.operation !== row.command_type
  ) {
    throw new AdapterError(409, "command_binding_mismatch", "Stored billing command failed its provider binding.");
  }
  return command;
}

function checkoutCommand(
  row: BillingCommandRow,
  expectedOrgId: string,
  env: ExecutorEnv
): ParsedCheckout {
  const command = commandObject(row, [
    "schema_version",
    "command_id",
    "provider",
    "operation",
    "idempotency_key",
    "parameters",
    "expires_at"
  ]);
  if (command.schema_version !== "checkout-command-v1") {
    throw new AdapterError(409, "command_binding_mismatch", "Stored checkout command schema is invalid.");
  }
  const expiresAt = Date.parse(string(command.expires_at, "expires_at", 64));
  if (!Number.isFinite(expiresAt)) {
    throw new AdapterError(409, "checkout_command_expired", "Prepared checkout command has expired.");
  }
  const parameters = record(command.parameters, "parameters");
  exactKeys(
    parameters,
    ["mode", "quantity", "provider_price_id", "internal_price_id", "client_reference_id", "metadata"],
    "parameters"
  );
  if (parameters.mode !== "subscription" || parameters.quantity !== 1 || parameters.client_reference_id !== expectedOrgId) {
    throw new AdapterError(409, "command_binding_mismatch", "Checkout command tenant or mode is invalid.");
  }
  const priceId = internalPriceId(parameters.internal_price_id);
  const providerPriceId = opaqueId(parameters.provider_price_id, "provider_price_id");
  if (providerPriceId !== configuredPrice(env, priceId)) {
    throw new AdapterError(409, "command_binding_mismatch", "Checkout command price is not canonical.");
  }
  const metadataValue = record(parameters.metadata, "metadata");
  exactKeys(
    metadataValue,
    ["team_org_id", "internal_price_id", "provider_price_id", "checkout_intent_id", "contributor_limit"],
    "metadata"
  );
  if (
    metadataValue.team_org_id !== expectedOrgId ||
    metadataValue.internal_price_id !== priceId ||
    metadataValue.provider_price_id !== providerPriceId ||
    metadataValue.contributor_limit !== "15"
  ) {
    throw new AdapterError(409, "command_binding_mismatch", "Checkout metadata is not canonical.");
  }
  const checkoutIntentId = opaqueId(metadataValue.checkout_intent_id, "checkout_intent_id");
  const metadata = Object.fromEntries(
    Object.entries(metadataValue).map(([key, value]) => [key, string(value, `metadata.${key}`, 255)])
  );
  return { command, checkoutIntentId, internalPriceId: priceId, providerPriceId, metadata };
}

function cancellationCommand(row: BillingCommandRow): ParsedCancellation {
  const command = commandObject(row, [
    "schema_version",
    "command_id",
    "provider",
    "operation",
    "idempotency_key",
    "provider_subscription_id",
    "reason"
  ]);
  if (command.schema_version !== "billing-command-v1") {
    throw new AdapterError(409, "command_binding_mismatch", "Cancellation command schema is invalid.");
  }
  const reason = string(command.reason, "reason", 64);
  if (!["no_longer_needed", "missing_feature", "too_expensive", "reliability", "other"].includes(reason)) {
    throw new AdapterError(409, "command_binding_mismatch", "Cancellation reason is invalid.");
  }
  return {
    command,
    providerSubscriptionId: opaqueId(command.provider_subscription_id, "provider_subscription_id")
  };
}

function refundCommand(row: BillingCommandRow): ParsedRefund {
  const command = commandObject(row, [
    "schema_version",
    "command_id",
    "provider",
    "operation",
    "idempotency_key",
    "amount_cents",
    "currency",
    "source_payment_event_id",
    "paid_features_materially_used",
    "reason"
  ]);
  if (command.schema_version !== "billing-command-v1" || command.currency !== "usd") {
    throw new AdapterError(409, "command_binding_mismatch", "Refund command schema is invalid.");
  }
  boolean(command.paid_features_materially_used, "paid_features_materially_used");
  const reason = string(command.reason, "reason", 64);
  if (!["first_subscription_14_day_unused", "duplicate_charge", "erroneous_charge", "case_by_case"].includes(reason)) {
    throw new AdapterError(409, "command_binding_mismatch", "Refund reason is invalid.");
  }
  return {
    command,
    amountCents: integer(command.amount_cents, "amount_cents", 1, 299_000),
    sourcePaymentEventId: opaqueId(command.source_payment_event_id, "source_payment_event_id"),
    reason
  };
}

function providerIdempotency(row: BillingCommandRow): string {
  const value = `avteam:${row.org_id}:${row.id}`;
  if (value.length > 255) throw new AdapterError(500, "command_binding_mismatch", "Provider idempotency is invalid.");
  return value;
}

function returnUrls(env: ExecutorEnv): { success: string; cancel: string } {
  let allowlist: unknown;
  try {
    allowlist = JSON.parse(env.STRIPE_RETURN_ORIGIN_ALLOWLIST);
  } catch {
    throw new AdapterError(503, "adapter_not_configured", "Checkout return allowlist is not configured.");
  }
  if (!Array.isArray(allowlist) || allowlist.length < 1 || allowlist.some((value) => typeof value !== "string")) {
    throw new AdapterError(503, "adapter_not_configured", "Checkout return allowlist is not configured.");
  }
  const origins = new Set(allowlist);
  const validate = (raw: string, success: boolean): string => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new AdapterError(503, "adapter_not_configured", "Checkout return URL is invalid.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      !origins.has(parsed.origin) ||
      (success && !raw.includes("{CHECKOUT_SESSION_ID}"))
    ) {
      throw new AdapterError(503, "adapter_not_configured", "Checkout return URL is outside the exact allowlist.");
    }
    return raw;
  };
  return { success: validate(env.STRIPE_SUCCESS_URL, true), cancel: validate(env.STRIPE_CANCEL_URL, false) };
}

function matchesMetadata(value: unknown, expected: Record<string, string>): boolean {
  if (!isRecord(value)) return false;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(value).sort();
  return (
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every((key, index) => key === actualKeys[index] && value[key] === expected[key])
  );
}

function validateCanceledCheckoutSubscription(
  value: Record<string, unknown>,
  subscriptionId: string,
  customerId: string,
  expectedPriceId: string,
  expectedMetadata: Record<string, string>
): void {
  const items = record(value.items, "subscription.items");
  const data = items.data;
  if (
    value.object !== "subscription" ||
    value.id !== subscriptionId ||
    value.customer !== customerId ||
    value.status !== "canceled" ||
    !matchesMetadata(value.metadata, expectedMetadata) ||
    !Array.isArray(data) ||
    data.length !== 1 ||
    !isRecord(data[0]) ||
    data[0].quantity !== 1 ||
    !isRecord(data[0].price) ||
    data[0].price.id !== expectedPriceId
  ) {
    throw new AdapterError(502, "checkout_subscription_compensation_unproven", "Stripe did not prove exact subscription cancellation.");
  }
}

function validateSubscription(
  object: Record<string, unknown>,
  account: BillingAccountRow,
  expectedPrice: string
): { subscriptionId: string; customerId: string; periodStart: number; periodEnd: number } {
  const subscriptionId = opaqueId(object.id, "subscription.id");
  const customerId = opaqueId(object.customer, "subscription.customer");
  if (
    object.object !== "subscription" ||
    subscriptionId !== account.provider_subscription_id ||
    customerId !== account.provider_customer_id
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe subscription does not match the tenant.");
  }
  const items = record(object.items, "subscription.items");
  const data = items.data;
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe subscription item set is not canonical.");
  }
  const item = data[0];
  const price = record(item.price, "subscription.items[0].price");
  if (price.id !== expectedPrice || item.quantity !== 1) {
    throw new AdapterError(409, "provider_binding_mismatch", "Stripe subscription price is not canonical.");
  }
  return {
    subscriptionId,
    customerId,
    periodStart: integer(item.current_period_start, "current_period_start", 1),
    periodEnd: integer(item.current_period_end, "current_period_end", 1)
  };
}

async function executeCheckout(
  row: BillingCommandRow,
  env: ExecutorEnv,
  stripe: StripeClient,
  now: number
): Promise<Response> {
  const parsed = checkoutCommand(row, row.org_id, env);
  const intent = await checkoutIntent(env.TEAM_CONTROL_DB, parsed.checkoutIntentId, row.org_id);
  if (
    !intent ||
    intent.internal_price_id !== parsed.internalPriceId ||
    !["prepared", "executing", "provider_created", "compensating"].includes(intent.status)
  ) {
    throw new AdapterError(409, "checkout_intent_mismatch", "Prepared checkout intent is not executable.");
  }
  const compensationCustomerId = intent.compensation_customer_id;
  const compensationSubscriptionId = intent.compensation_subscription_id;
  if ((compensationCustomerId === null) !== (compensationSubscriptionId === null)) {
    throw new AdapterError(500, "checkout_compensation_binding_corrupt", "Checkout compensation binding is incomplete.");
  }
  if (!compensationSubscriptionId && Date.parse(intent.expires_at) < now) {
    throw new AdapterError(409, "checkout_command_expired", "Prepared checkout command has expired.");
  }
  const leaseId = `checkout_lease_${crypto.randomUUID()}`;
  const leasedAt = new Date(now).toISOString();
  const leaseExpiresAt = new Date(now + 60_000).toISOString();
  await claimCheckoutExecution(
    env.TEAM_CONTROL_DB,
    row,
    parsed.checkoutIntentId,
    leaseId,
    leasedAt,
    leaseExpiresAt
  );
  if (compensationCustomerId && compensationSubscriptionId) {
    if (!intent.provider_session_id) {
      throw new AdapterError(500, "checkout_compensation_binding_corrupt", "Checkout compensation Session binding is missing.");
    }
    const canceled = await stripe.request(stripePath("subscriptions", compensationSubscriptionId), {
      method: "DELETE"
    });
    validateCanceledCheckoutSubscription(
      canceled,
      compensationSubscriptionId,
      compensationCustomerId,
      parsed.providerPriceId,
      parsed.metadata
    );
    await markCheckoutSubscriptionCompensated(
      env.TEAM_CONTROL_DB,
      row,
      parsed.command,
      parsed.checkoutIntentId,
      intent.provider_session_id,
      compensationCustomerId,
      compensationSubscriptionId,
      leaseId,
      new Date(now).toISOString()
    );
    throw new AdapterError(
      409,
      "checkout_subscription_compensated_for_deletion",
      "Completed Checkout subscription was canceled because organization deletion won the race."
    );
  }
  const urls = returnUrls(env);
  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", parsed.providerPriceId);
  form.set("line_items[0][quantity]", "1");
  form.set("client_reference_id", row.org_id);
  form.set("success_url", urls.success);
  form.set("cancel_url", urls.cancel);
  form.append("expand[]", "line_items");
  for (const [key, value] of Object.entries(parsed.metadata)) {
    form.set(`metadata[${key}]`, value);
    form.set(`subscription_data[metadata][${key}]`, value);
  }
  const result = await stripe.request("/v1/checkout/sessions", {
    method: "POST",
    form,
    idempotencyKey: providerIdempotency(row)
  });
  const sessionId = opaqueId(result.id, "checkout.id");
  const checkoutUrl = string(result.url, "checkout.url", 4096);
  const parsedUrl = new URL(checkoutUrl);
  const lineItems = record(result.line_items, "checkout.line_items");
  const lines = lineItems.data;
  if (
    result.object !== "checkout.session" ||
    !sessionId.startsWith("cs_") ||
    result.mode !== "subscription" ||
    result.client_reference_id !== row.org_id ||
    result.success_url !== urls.success ||
    result.cancel_url !== urls.cancel ||
    !matchesMetadata(result.metadata, parsed.metadata) ||
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "checkout.stripe.com" ||
    !Array.isArray(lines) ||
    lines.length !== 1 ||
    !isRecord(lines[0]) ||
    lines[0].quantity !== 1 ||
    !isRecord(lines[0].price) ||
    lines[0].price.id !== parsed.providerPriceId
  ) {
    throw new AdapterError(502, "stripe_response_invalid", "Stripe checkout response failed binding validation.");
  }
  const accepted = await markCheckoutAccepted(
    env.TEAM_CONTROL_DB,
    row,
    parsed.command,
    parsed.checkoutIntentId,
    sessionId,
    leaseId
  );
  if (!accepted) {
    const expired = await stripe.request(checkoutSessionExpirePath(sessionId), {
      method: "POST",
      idempotencyKey: `${providerIdempotency(row)}:expire`
    });
    if (expired.object !== "checkout.session" || expired.id !== sessionId || expired.status !== "expired") {
      throw new AdapterError(502, "checkout_compensation_unproven", "Stripe did not prove Checkout compensation.");
    }
    await markCheckoutCompensated(
      env.TEAM_CONTROL_DB,
      row,
      parsed.command,
      parsed.checkoutIntentId,
      sessionId,
      leaseId,
      new Date(now).toISOString()
    );
    throw new AdapterError(
      409,
      "checkout_compensated_for_deletion",
      "Checkout was expired because organization deletion won the execution race."
    );
  }
  return noStoreJson({
    schema_version: "stripe-command-execution-result-v1",
    request_id: null,
    command_id: row.id,
    operation: row.command_type,
    provider_object_id: sessionId,
    provider_status: string(result.status, "checkout.status", 32),
    checkout_url: checkoutUrl
  });
}

async function executeCancellation(
  row: BillingCommandRow,
  env: ExecutorEnv,
  stripe: StripeClient
): Promise<Response> {
  const parsed = cancellationCommand(row);
  const account = await billingAccount(env.TEAM_CONTROL_DB, row.org_id);
  if (
    !account ||
    !account.provider_customer_id ||
    !account.provider_subscription_id ||
    !account.internal_price_id ||
    parsed.providerSubscriptionId !== account.provider_subscription_id
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "Cancellation is not bound to this tenant subscription.");
  }
  const form = new URLSearchParams({ cancel_at_period_end: "true" });
  const result = await stripe.request(stripePath("subscriptions", parsed.providerSubscriptionId), {
    method: "POST",
    form,
    idempotencyKey: providerIdempotency(row)
  });
  const bound = validateSubscription(result, account, configuredPrice(env, account.internal_price_id));
  if (result.cancel_at_period_end !== true) {
    throw new AdapterError(502, "stripe_response_invalid", "Stripe did not confirm period-end cancellation.");
  }
  await markCommandAccepted(env.TEAM_CONTROL_DB, row, parsed.command, {
    subscription_id: bound.subscriptionId,
    cancel_at_period_end: true
  });
  return noStoreJson({
    schema_version: "stripe-command-execution-result-v1",
    request_id: null,
    command_id: row.id,
    operation: row.command_type,
    provider_object_id: bound.subscriptionId,
    provider_status: "cancel_at_period_end"
  });
}

function paymentIntentFromInvoicePayments(
  response: Record<string, unknown>,
  invoiceId: string
): { paymentIntentId: string } {
  if (response.object !== "list" || response.has_more !== false || !Array.isArray(response.data) || response.data.length !== 1) {
    throw new AdapterError(409, "provider_binding_mismatch", "Source invoice does not have one conclusive paid payment.");
  }
  const invoicePayment = record(response.data[0], "invoice_payment");
  const payment = record(invoicePayment.payment, "invoice_payment.payment");
  if (
    invoicePayment.object !== "invoice_payment" ||
    invoicePayment.invoice !== invoiceId ||
    invoicePayment.status !== "paid" ||
    invoicePayment.is_default !== true ||
    payment.type !== "payment_intent"
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "Source invoice payment is not canonical.");
  }
  return { paymentIntentId: opaqueId(payment.payment_intent, "payment_intent") };
}

async function executeRefund(row: BillingCommandRow, env: ExecutorEnv, stripe: StripeClient): Promise<Response> {
  const parsed = refundCommand(row);
  const account = await billingAccount(env.TEAM_CONTROL_DB, row.org_id);
  const source = await sourcePaymentContext(env.TEAM_CONTROL_DB, row.org_id, parsed.sourcePaymentEventId);
  if (
    !account ||
    !account.provider_customer_id ||
    !account.provider_subscription_id ||
    !account.internal_price_id ||
    source.summary.customerId !== account.provider_customer_id ||
    source.summary.subscriptionId !== account.provider_subscription_id ||
    source.summary.internalPriceId !== account.internal_price_id ||
    source.summary.objectId !== source.event.object_id ||
    parsed.amountCents > source.amountCents
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "Refund is not bound to the tenant payment.");
  }
  const payments = await stripe.request(invoicePaymentsPath(source.event.object_id));
  const { paymentIntentId } = paymentIntentFromInvoicePayments(payments, source.event.object_id);
  const paymentIntent = await stripe.request(stripePath("payment_intents", paymentIntentId));
  const chargeId = opaqueId(paymentIntent.latest_charge, "payment_intent.latest_charge");
  if (
    paymentIntent.object !== "payment_intent" ||
    paymentIntent.id !== paymentIntentId ||
    paymentIntent.customer !== account.provider_customer_id ||
    paymentIntent.currency !== "usd" ||
    paymentIntent.status !== "succeeded" ||
    integer(paymentIntent.amount_received, "payment_intent.amount_received", 1) < parsed.amountCents
  ) {
    throw new AdapterError(409, "provider_binding_mismatch", "PaymentIntent does not match the confirmed tenant payment.");
  }
  const reason = parsed.reason === "duplicate_charge" ? "duplicate" : "requested_by_customer";
  const form = new URLSearchParams({
    payment_intent: paymentIntentId,
    amount: String(parsed.amountCents),
    reason,
    "metadata[team_org_id]": row.org_id,
    "metadata[source_payment_event_id]": parsed.sourcePaymentEventId,
    "metadata[billing_command_id]": row.id
  });
  const result = await stripe.request("/v1/refunds", {
    method: "POST",
    form,
    idempotencyKey: providerIdempotency(row)
  });
  const refundId = opaqueId(result.id, "refund.id");
  const refundStatus = string(result.status, "refund.status", 32);
  if (
    result.object !== "refund" ||
    !refundId.startsWith("re_") ||
    result.payment_intent !== paymentIntentId ||
    result.charge !== chargeId ||
    result.currency !== "usd" ||
    result.amount !== parsed.amountCents ||
    !["pending", "requires_action", "succeeded"].includes(refundStatus)
  ) {
    throw new AdapterError(502, "stripe_response_invalid", "Stripe refund response failed binding validation.");
  }
  await markCommandAccepted(env.TEAM_CONTROL_DB, row, parsed.command, {
    refund_id: refundId,
    payment_intent_id: paymentIntentId,
    charge_id: chargeId,
    amount_cents: parsed.amountCents,
    source_payment_event_id: parsed.sourcePaymentEventId
  });
  return noStoreJson({
    schema_version: "stripe-command-execution-result-v1",
    request_id: null,
    command_id: row.id,
    operation: row.command_type,
    provider_object_id: refundId,
    provider_status: refundStatus
  });
}

export async function handleExecution(
  request: Request,
  env: ExecutorEnv,
  dependencies: RuntimeDependencies = {}
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/execute") {
    throw new AdapterError(404, "not_found", "Route not found.");
  }
  if (env.STRIPE_EXECUTION_ENABLED !== "true") {
    throw new AdapterError(503, "feature_disabled", "Stripe execution is disabled.");
  }
  assertAdapterDutySecretSeparation([
    { name: "TEAM_STRIPE_EXECUTOR_HMAC_SECRET", value: env.TEAM_STRIPE_EXECUTOR_HMAC_SECRET },
    { name: "STRIPE_EXECUTOR_RESTRICTED_KEY", value: env.STRIPE_EXECUTOR_RESTRICTED_KEY }
  ]);
  const raw = await readBoundedBody(request);
  await verifyInvocation(request, raw, env.TEAM_STRIPE_EXECUTOR_HMAC_SECRET, dependencies.now?.());
  const invocation = executionInvocation(raw);
  const row = await executableCommand(env.TEAM_CONTROL_DB, invocation.org_id, invocation.command_id);
  const stripe = new StripeClient({
    fetch: dependencies.stripeFetch ?? fetch,
    secretKey: env.STRIPE_EXECUTOR_RESTRICTED_KEY,
    livemode: liveMode(env.STRIPE_LIVEMODE),
    keyMode: "mutation",
    ...(dependencies.sleep ? { sleep: dependencies.sleep } : {})
  });
  let response: Response;
  if (row.command_type === "create_checkout_session") {
    response = await executeCheckout(row, env, stripe, dependencies.now?.() ?? Date.now());
  } else if (row.command_type === "cancel_at_period_end") {
    response = await executeCancellation(row, env, stripe);
  } else if (row.command_type === "request_refund") {
    response = await executeRefund(row, env, stripe);
  } else {
    throw new AdapterError(409, "command_not_executable", "Billing command is not supported.");
  }
  const body = await response.json<Record<string, unknown>>();
  body.request_id = invocation.request_id;
  return noStoreJson(body, response.status);
}
