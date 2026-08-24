import type { AuthContext } from "./auth.ts";
import { requireRole } from "./auth.ts";
import {
  type InternalPriceId,
  TEAM_CONTRIBUTOR_LIMIT,
  TEAM_PRICES,
  isInternalPriceId,
  providerPriceId,
  recognizedMrrMicros
} from "./catalog.ts";
import { sha256Hex, verifyHmacHex } from "./crypto.ts";
import { commercialActorPseudonym } from "./commercial-privacy.ts";
import { auditStatement, getEntitlement, lifecycleStatement, newId, nowIso, userAudit } from "./db.ts";
import { ApiError, jsonResponse, parseJsonObject, readBoundedText, readJsonObject } from "./http.ts";
import { assertBillingDutySecretSeparation } from "./measurement-security.ts";
import {
  assertExactKeys,
  requireBoolean,
  requireEnum,
  requireInteger,
  requireIsoDate,
  requireObject,
  requireOpaqueId,
  requireOrgId,
  requireString
} from "./validation.ts";

const SIGNATURE_TOLERANCE_SECONDS = 300;
const WEBHOOK_BODY_LIMIT = 262_144;
const STRIPE_API_VERSION = "2026-07-29.dahlia";

type SupportedStripeEventType =
  | "checkout.session.completed"
  | "invoice.paid"
  | "invoice.payment_failed"
  | "refund.created"
  | "customer.subscription.updated"
  | "customer.subscription.deleted";

type ReconciliationKind = "payment" | "payment_failure" | "refund" | "subscription";

interface BillingAccountRow {
  org_id: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  commercial_state: string;
  internal_price_id: InternalPriceId | null;
  billing_interval: "month" | "year" | null;
  current_period_start: string | null;
  current_period_end: string | null;
  current_recognized_mrr_micros: number;
  last_reconciled_event_created: number | null;
  last_reconciled_event_id: string | null;
}

interface ProviderEventRow {
  event_id: string;
  event_type: SupportedStripeEventType;
  object_id: string;
  org_id: string | null;
  event_created: number;
  summary_json: string;
  status: "awaiting_reconciliation" | "reconciled" | "ignored" | "stale" | "rejected";
}

type BillingCommandType = "create_checkout_session" | "cancel_at_period_end" | "request_refund";

interface BillingCommandRow {
  id: string;
  command_type: BillingCommandType;
  command_json: string;
}

interface StripeSummary {
  orgId: string;
  objectId: string;
  customerId: string | null;
  subscriptionId: string | null;
  internalPriceId: InternalPriceId;
  providerPriceId: string;
  checkoutIntentId: string | null;
  refundId: string | null;
  refundAmountCents: number | null;
  refundChargeId: string | null;
  refundPaymentIntentId: string | null;
  refundSourcePaymentEventId: string | null;
  refundBillingCommandId: string | null;
}

interface ReconciliationSnapshot {
  reconciliationId: string;
  observedAt: string;
  sourceEventId: string;
  kind: ReconciliationKind;
  orgId: string;
  providerCustomerId: string;
  providerSubscriptionId: string;
  providerObjectId: string;
  internalPriceId: InternalPriceId;
  providerPriceId: string;
  providerStatus: "paid" | "failed" | "active" | "past_due" | "canceled" | "refunded";
  currency: "usd";
  cashAmountCents: number;
  netRecurringAmountCents: number;
  refundAmountCents: number;
  periodStart: string;
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
  providerRefundId: string | null;
  providerChargeId: string | null;
  providerPaymentIntentId: string | null;
  sourcePaymentEventId: string | null;
  billingCommandId: string | null;
  cumulativeRefundAmountCents: number;
}

function nullableProviderId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireOpaqueId(value, field, 255);
}

function parseMetadataValue(value: unknown): {
  orgId: string;
  internalPriceId: InternalPriceId;
  providerPriceId: string;
  checkoutIntentId: string | null;
} {
  const metadata = requireObject(value, "provider metadata");
  const orgId = requireOrgId(requireString(metadata.team_org_id, "metadata.team_org_id", { max: 64 }));
  if (!isInternalPriceId(metadata.internal_price_id)) {
    throw new ApiError(400, "invalid_provider_event", "Provider event contains an unknown internal price.");
  }
  return {
    orgId,
    internalPriceId: metadata.internal_price_id,
    providerPriceId: requireOpaqueId(metadata.provider_price_id, "metadata.provider_price_id", 255),
    checkoutIntentId: nullableProviderId(metadata.checkout_intent_id, "metadata.checkout_intent_id")
  };
}

function invoiceBinding(object: Record<string, unknown>): { metadata: unknown; subscriptionId: string | null } {
  if (object.parent !== null && object.parent !== undefined) {
    const parent = requireObject(object.parent, "data.object.parent");
    if (parent.type !== "subscription_details") {
      throw new ApiError(400, "invalid_provider_event", "Invoice is not bound to a subscription.");
    }
    const details = requireObject(parent.subscription_details, "data.object.parent.subscription_details");
    return {
      metadata: details.metadata,
      subscriptionId: nullableProviderId(details.subscription, "data.object.parent.subscription_details.subscription")
    };
  }
  // Compatibility for already-created test fixtures and pre-Dahlia event replays.
  return {
    metadata: object.metadata,
    subscriptionId: nullableProviderId(object.subscription, "data.object.subscription")
  };
}

function extractStripeSummary(eventType: SupportedStripeEventType, object: Record<string, unknown>): StripeSummary {
  const invoice = eventType === "invoice.paid" || eventType === "invoice.payment_failed" ? invoiceBinding(object) : null;
  const metadata = parseMetadataValue(invoice?.metadata ?? object.metadata);
  const objectId = requireOpaqueId(object.id, "data.object.id", 255);
  let customerId = nullableProviderId(object.customer, "data.object.customer");
  let subscriptionId = invoice?.subscriptionId ?? nullableProviderId(object.subscription, "data.object.subscription");
  if (eventType.startsWith("customer.subscription.")) {
    subscriptionId = objectId;
    customerId = nullableProviderId(object.customer, "data.object.customer");
  }
  if (eventType === "checkout.session.completed") {
    if (object.mode !== "subscription") {
      throw new ApiError(400, "invalid_provider_event", "Checkout session must use subscription mode.");
    }
    customerId = nullableProviderId(object.customer, "data.object.customer");
    subscriptionId = nullableProviderId(object.subscription, "data.object.subscription");
    if (!metadata.checkoutIntentId) {
      throw new ApiError(400, "invalid_provider_event", "Checkout session is missing its checkout intent identifier.");
    }
  }
  return {
    ...metadata,
    objectId,
    customerId,
    subscriptionId,
    refundId: null,
    refundAmountCents: null,
    refundChargeId: null,
    refundPaymentIntentId: null,
    refundSourcePaymentEventId: null,
    refundBillingCommandId: null
  };
}

async function extractRefundStripeSummary(env: Env, object: Record<string, unknown>): Promise<StripeSummary> {
  if (object.object !== "refund" || object.currency !== "usd") {
    throw new ApiError(400, "invalid_provider_event", "Refund event does not contain a canonical USD Refund object.");
  }
  const refundId = requireOpaqueId(object.id, "data.object.id", 255);
  const chargeId = requireOpaqueId(object.charge, "data.object.charge", 255);
  const paymentIntentId = requireOpaqueId(object.payment_intent, "data.object.payment_intent", 255);
  const amountCents = requireInteger(object.amount, "data.object.amount", { min: 1, max: 10_000_000 });
  const status = requireString(object.status, "data.object.status", { max: 32 });
  if (!["pending", "requires_action", "succeeded"].includes(status)) {
    throw new ApiError(400, "invalid_provider_event", "Refund event has an unsupported status.");
  }
  const metadata = requireObject(object.metadata, "data.object.metadata");
  const bindings = await env.TEAM_CONTROL_DB.prepare(
    `SELECT bc.id, bc.org_id, bc.command_json, ba.provider_customer_id, ba.provider_subscription_id,
            ba.internal_price_id
       FROM billing_commands bc
       JOIN billing_accounts ba ON ba.org_id = bc.org_id
      WHERE bc.command_type = 'request_refund'
        AND bc.status IN ('provider_accepted', 'confirmed')
        AND json_extract(bc.command_json, '$.provider_result.refund_id') = ?1
      LIMIT 2`
  )
    .bind(refundId)
    .all<{
      id: string;
      org_id: string;
      command_json: string;
      provider_customer_id: string;
      provider_subscription_id: string;
      internal_price_id: string;
    }>();
  let binding = bindings.results[0];
  let sourcePaymentEventId: string;
  let billingCommandId: string | null;
  if (bindings.results.length === 1 && binding) {
    const metadataOrgId = requireOrgId(requireString(metadata.team_org_id, "metadata.team_org_id", { max: 64 }));
    sourcePaymentEventId = requireOpaqueId(
      metadata.source_payment_event_id,
      "metadata.source_payment_event_id",
      255
    );
    billingCommandId = requireOpaqueId(metadata.billing_command_id, "metadata.billing_command_id", 255);
    let command: unknown;
    try {
      command = JSON.parse(binding.command_json);
    } catch {
      throw new ApiError(500, "billing_command_corrupt", "Stored refund command could not be verified.");
    }
    const commandObject = requireObject(command, "refund command");
    const providerResult = requireObject(commandObject.provider_result, "refund command provider_result");
    if (
      binding.id !== billingCommandId ||
      binding.org_id !== metadataOrgId ||
      providerResult.charge_id !== chargeId ||
      providerResult.payment_intent_id !== paymentIntentId ||
      providerResult.refund_id !== refundId ||
      providerResult.amount_cents !== amountCents ||
      providerResult.source_payment_event_id !== sourcePaymentEventId
    ) {
      throw new ApiError(409, "refund_command_binding_mismatch", "Refund event does not match its accepted command.");
    }
  } else if (bindings.results.length === 0) {
    const sourceBindings = await env.TEAM_CONTROL_DB.prepare(
      `SELECT DISTINCT bc.org_id,
              json_extract(bc.command_json, '$.provider_result.source_payment_event_id') AS source_payment_event_id,
              ba.provider_customer_id, ba.provider_subscription_id, ba.internal_price_id
         FROM billing_commands bc
         JOIN billing_accounts ba ON ba.org_id = bc.org_id
        WHERE bc.command_type = 'request_refund'
          AND bc.status IN ('provider_accepted', 'confirmed')
          AND json_extract(bc.command_json, '$.provider_result.charge_id') = ?1
          AND json_extract(bc.command_json, '$.provider_result.payment_intent_id') = ?2
        LIMIT 2`
    )
      .bind(chargeId, paymentIntentId)
      .all<{
        org_id: string;
        source_payment_event_id: string;
        provider_customer_id: string;
        provider_subscription_id: string;
        internal_price_id: string;
      }>();
    if (sourceBindings.results.length !== 1) {
      throw new ApiError(409, "refund_source_binding_missing", "Out-of-band Refund has no unique confirmed source payment binding.");
    }
    const sourceBinding = sourceBindings.results[0]!;
    if (
      (metadata.team_org_id !== undefined && metadata.team_org_id !== sourceBinding.org_id) ||
      (metadata.source_payment_event_id !== undefined &&
        metadata.source_payment_event_id !== sourceBinding.source_payment_event_id) ||
      metadata.billing_command_id !== undefined
    ) {
      throw new ApiError(409, "refund_source_binding_mismatch", "Out-of-band Refund metadata conflicts with provider-bound payment state.");
    }
    binding = {
      id: "",
      org_id: sourceBinding.org_id,
      command_json: "{}",
      provider_customer_id: sourceBinding.provider_customer_id,
      provider_subscription_id: sourceBinding.provider_subscription_id,
      internal_price_id: sourceBinding.internal_price_id
    };
    sourcePaymentEventId = requireOpaqueId(
      sourceBinding.source_payment_event_id,
      "source_payment_event_id",
      255
    );
    billingCommandId = null;
  } else {
    throw new ApiError(409, "refund_command_binding_ambiguous", "Refund identifier is bound to multiple commands.");
  }
  if (!binding || !isInternalPriceId(binding.internal_price_id)) {
    throw new ApiError(409, "refund_source_binding_mismatch", "Refund source price binding is invalid.");
  }
  return {
    orgId: binding.org_id,
    objectId: refundId,
    customerId: requireOpaqueId(binding.provider_customer_id, "provider_customer_id", 255),
    subscriptionId: requireOpaqueId(binding.provider_subscription_id, "provider_subscription_id", 255),
    internalPriceId: binding.internal_price_id,
    providerPriceId: providerPriceId(env, binding.internal_price_id),
    checkoutIntentId: null,
    refundId,
    refundAmountCents: amountCents,
    refundChargeId: chargeId,
    refundPaymentIntentId: paymentIntentId,
    refundSourcePaymentEventId: sourcePaymentEventId,
    refundBillingCommandId: billingCommandId
  };
}

function parseStripeSignature(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && /^\d{1,12}$/u.test(value)) {
      timestamp = Number(value);
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) {
    throw new ApiError(400, "invalid_signature", "The request signature header is invalid.");
  }
  return { timestamp, signatures };
}

async function verifySignedPayload(header: string | null, rawBody: string, secret: string): Promise<number> {
  if (!header || header.length > 4096) {
    throw new ApiError(400, "invalid_signature", "A valid request signature is required.");
  }
  const parsed = parseStripeSignature(header);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new ApiError(400, "stale_signature", "The request signature timestamp is outside the allowed window.");
  }
  const signedPayload = `${parsed.timestamp}.${rawBody}`;
  for (const signature of parsed.signatures) {
    if (await verifyHmacHex(secret, signedPayload, signature)) {
      return parsed.timestamp;
    }
  }
  throw new ApiError(400, "invalid_signature", "The request signature is invalid.");
}

function stripeLivemode(env: Env): boolean {
  const value: string = env.STRIPE_LIVEMODE;
  if (value !== "true" && value !== "false") {
    throw new Error("STRIPE_LIVEMODE must be true or false");
  }
  return value === "true";
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key");
  if (!value) {
    throw new ApiError(428, "idempotency_key_required", "Idempotency-Key is required.");
  }
  return requireOpaqueId(value, "Idempotency-Key", 128);
}

async function existingBillingCommand(
  db: D1Database,
  orgId: string,
  idempotencyKey: string
): Promise<BillingCommandRow | null> {
  return db
    .prepare(
      `SELECT id, command_type, command_json FROM billing_commands
        WHERE org_id = ?1 AND idempotency_key = ?2`
    )
    .bind(orgId, idempotencyKey)
    .first<BillingCommandRow>();
}

function reuseBillingCommand(
  existing: BillingCommandRow,
  expectedType: BillingCommandType,
  requestMatches: (command: Record<string, unknown>) => boolean
): Record<string, unknown> {
  let command: unknown;
  try {
    command = JSON.parse(existing.command_json);
  } catch {
    throw new ApiError(500, "billing_command_corrupt", "Stored billing command could not be verified.");
  }
  if (
    existing.command_type !== expectedType ||
    !command ||
    typeof command !== "object" ||
    Array.isArray(command) ||
    !requestMatches(command as Record<string, unknown>)
  ) {
    throw new ApiError(
      409,
      "idempotency_key_reuse",
      "Idempotency-Key was already used for a different billing operation or payload."
    );
  }
  return command as Record<string, unknown>;
}

async function billingAccount(db: D1Database, orgId: string): Promise<BillingAccountRow | null> {
  return db
    .prepare(
      `SELECT org_id, provider_customer_id, provider_subscription_id, commercial_state,
              internal_price_id, billing_interval, current_period_start, current_period_end,
              current_recognized_mrr_micros, last_reconciled_event_created, last_reconciled_event_id
         FROM billing_accounts WHERE org_id = ?1`
    )
    .bind(orgId)
    .first<BillingAccountRow>();
}

async function rejectProviderTenantCollision(
  db: D1Database,
  orgId: string,
  customerId: string,
  subscriptionId: string
): Promise<void> {
  const collision = await db
    .prepare(
      `SELECT org_id FROM billing_accounts
        WHERE org_id <> ?1 AND (provider_customer_id = ?2 OR provider_subscription_id = ?3)
        LIMIT 1`
    )
    .bind(orgId, customerId, subscriptionId)
    .first<{ org_id: string }>();
  if (collision) {
    throw new ApiError(409, "provider_tenant_collision", "Provider identifiers are already bound to another tenant.");
  }
}

export async function prepareCheckout(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "billing"]);
  assertBillingDutySecretSeparation(env);
  const idempotencyKey = requireIdempotencyKey(request);
  const body = await readJsonObject(request);
  assertExactKeys(body, ["internal_price_id"]);
  if (!isInternalPriceId(body.internal_price_id)) {
    throw new ApiError(400, "invalid_price", "Choose a canonical Team price.");
  }
  const internalPriceId = body.internal_price_id;
  const price = TEAM_PRICES[internalPriceId];
  const stripePriceId = providerPriceId(env, internalPriceId);
  const existingIntent = await existingBillingCommand(env.TEAM_CONTROL_DB, auth.orgId, idempotencyKey);
  if (existingIntent) {
    const command = reuseBillingCommand(existingIntent, "create_checkout_session", (candidate) => {
      const parameters = candidate.parameters;
      return (
        !!parameters &&
        typeof parameters === "object" &&
        !Array.isArray(parameters) &&
        (parameters as Record<string, unknown>).internal_price_id === internalPriceId
      );
    });
    return jsonResponse({ command_id: existingIntent.id, command, duplicate: true }, 200);
  }
  const entitlement = await getEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  if (entitlement?.status === "active" && Date.parse(entitlement.ends_at) > Date.now()) {
    throw new ApiError(409, "already_entitled", "This organization already has an active Team entitlement.");
  }
  const at = nowIso();
  const actorPseudonym = await commercialActorPseudonym(env, auth.orgId, auth.userId);
  const checkoutIntentId = newId("checkout");
  const commandId = newId("billing_command");
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const command = {
    schema_version: "checkout-command-v1",
    command_id: commandId,
    provider: "stripe",
    operation: "create_checkout_session",
    idempotency_key: idempotencyKey,
    parameters: {
      mode: "subscription",
      quantity: 1,
      provider_price_id: stripePriceId,
      internal_price_id: internalPriceId,
      client_reference_id: auth.orgId,
      metadata: {
        team_org_id: auth.orgId,
        internal_price_id: internalPriceId,
        provider_price_id: stripePriceId,
        checkout_intent_id: checkoutIntentId,
        contributor_limit: String(TEAM_CONTRIBUTOR_LIMIT)
      }
    },
    expires_at: expiresAt
  };
  let results: D1Result[];
  try {
    results = await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO checkout_intents
          (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
           contributor_limit, status, created_by, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 15, 'prepared', ?7, ?8, ?9
          WHERE EXISTS (
            SELECT 1 FROM organizations WHERE id = ?2 AND status = 'active'
          )
            AND NOT EXISTS (
              SELECT 1 FROM checkout_intents
               WHERE org_id = ?2
                 AND status IN ('prepared', 'executing', 'provider_created', 'compensating')
            )
            AND NOT EXISTS (
              SELECT 1 FROM billing_accounts
               WHERE org_id = ?2 AND provider_subscription_id IS NOT NULL
                 AND commercial_state NOT IN ('expired', 'refunded')
            )
            AND NOT EXISTS (
              SELECT 1 FROM entitlements
               WHERE org_id = ?2 AND status IN ('active', 'grace') AND ends_at > ?8
            )`
      ).bind(
        checkoutIntentId,
        auth.orgId,
        idempotencyKey,
        internalPriceId,
        price.interval,
        price.listAmountCents,
        actorPseudonym,
        at,
        expiresAt
      ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_commands
          (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
         SELECT ?1, ?2, 'create_checkout_session', ?3, ?4, 'prepared', ?5, ?6
          WHERE EXISTS (
            SELECT 1 FROM checkout_intents WHERE id = ?7 AND org_id = ?2 AND status = 'prepared'
          )`
      ).bind(commandId, auth.orgId, idempotencyKey, JSON.stringify(command), actorPseudonym, at, checkoutIntentId),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO billing_accounts (org_id, commercial_state, updated_at)
         SELECT ?1, 'offer_shown', ?2
          WHERE EXISTS (
            SELECT 1 FROM checkout_intents WHERE id = ?3 AND org_id = ?1 AND status = 'prepared'
          )`
      ).bind(auth.orgId, at, checkoutIntentId),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO audit_events
          (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
         SELECT ?1, ?2, 'user', ?3, 'team.checkout.command_prepared',
                'billing_command', ?4, ?5, ?6
          WHERE EXISTS (
            SELECT 1 FROM checkout_intents WHERE id = ?7 AND org_id = ?2 AND status = 'prepared'
          )`
      ).bind(
        newId("audit"),
        auth.orgId,
        auth.userId,
        commandId,
        JSON.stringify({ internal_price_id: internalPriceId }),
        at,
        checkoutIntentId
      )
    ]);
  } catch (error) {
    const live = await env.TEAM_CONTROL_DB.prepare(
      `SELECT id FROM checkout_intents
        WHERE org_id = ?1 AND status IN ('prepared', 'executing', 'provider_created', 'compensating')
        LIMIT 1`
    )
      .bind(auth.orgId)
      .first();
    if (live) {
      throw new ApiError(409, "checkout_workflow_already_live", "This organization already has a live checkout workflow.");
    }
    throw error;
  }
  if (
    (results[0]?.meta.changes ?? 0) !== 1 ||
    (results[1]?.meta.changes ?? 0) !== 1 ||
    (results[3]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "checkout_workflow_already_live", "This organization already has a live checkout workflow.");
  }
  return jsonResponse({ command_id: commandId, checkout_intent_id: checkoutIntentId, command }, 202);
}

export async function prepareCancellation(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "billing"]);
  assertBillingDutySecretSeparation(env);
  const idempotencyKey = requireIdempotencyKey(request);
  const body = await readJsonObject(request);
  assertExactKeys(body, ["reason"]);
  const reason = requireEnum(body.reason, "reason", [
    "no_longer_needed",
    "missing_feature",
    "too_expensive",
    "reliability",
    "other"
  ] as const);
  const existing = await existingBillingCommand(env.TEAM_CONTROL_DB, auth.orgId, idempotencyKey);
  if (existing) {
    const command = reuseBillingCommand(
      existing,
      "cancel_at_period_end",
      (candidate) => candidate.reason === reason
    );
    return jsonResponse({ command_id: existing.id, command, duplicate: true });
  }
  const account = await billingAccount(env.TEAM_CONTROL_DB, auth.orgId);
  if (!account?.provider_subscription_id || ["expired", "refunded"].includes(account.commercial_state)) {
    throw new ApiError(409, "no_cancelable_subscription", "No cancelable Team subscription is present.");
  }
  const at = nowIso();
  const actorPseudonym = await commercialActorPseudonym(env, auth.orgId, auth.userId);
  const commandId = newId("billing_command");
  const command = {
    schema_version: "billing-command-v1",
    command_id: commandId,
    provider: "stripe",
    operation: "cancel_at_period_end",
    idempotency_key: idempotencyKey,
    provider_subscription_id: account.provider_subscription_id,
    reason
  };
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_commands
        (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
       VALUES (?1, ?2, 'cancel_at_period_end', ?3, ?4, 'prepared', ?5, ?6)`
    ).bind(commandId, auth.orgId, idempotencyKey, JSON.stringify(command), actorPseudonym, at),
    userAudit(env.TEAM_CONTROL_DB, auth, "team.cancellation.command_prepared", "billing_command", commandId, at, {
      reason
    })
  ]);
  return jsonResponse({ command_id: commandId, command }, 202);
}

export async function prepareRefund(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "billing"]);
  assertBillingDutySecretSeparation(env);
  const idempotencyKey = requireIdempotencyKey(request);
  const body = await readJsonObject(request);
  assertExactKeys(body, ["reason", "amount_cents", "paid_features_materially_used", "source_payment_event_id"]);
  const reason = requireEnum(body.reason, "reason", [
    "first_subscription_14_day_unused",
    "duplicate_charge",
    "erroneous_charge",
    "case_by_case"
  ] as const);
  const amountCents = requireInteger(body.amount_cents, "amount_cents", { min: 1, max: 299_000 });
  const materiallyUsed = requireBoolean(body.paid_features_materially_used, "paid_features_materially_used");
  const sourcePaymentEventId = requireOpaqueId(body.source_payment_event_id, "source_payment_event_id", 255);
  const existing = await existingBillingCommand(env.TEAM_CONTROL_DB, auth.orgId, idempotencyKey);
  if (existing) {
    const command = reuseBillingCommand(
      existing,
      "request_refund",
      (candidate) =>
        candidate.reason === reason &&
        candidate.amount_cents === amountCents &&
        candidate.source_payment_event_id === sourcePaymentEventId &&
        candidate.paid_features_materially_used === materiallyUsed
    );
    return jsonResponse({ command_id: existing.id, command, duplicate: true });
  }
  if (reason === "first_subscription_14_day_unused" && materiallyUsed) {
    throw new ApiError(409, "refund_policy_not_met", "The unused-first-subscription refund reason is not applicable.");
  }
  const sourcePayment = await env.TEAM_CONTROL_DB.prepare(
    `SELECT amount_cents, occurred_at FROM cash_ledger
      WHERE org_id = ?1 AND source_event_id = ?2 AND entry_type = 'payment'`
  )
    .bind(auth.orgId, sourcePaymentEventId)
    .first<{ amount_cents: number; occurred_at: string }>();
  if (!sourcePayment) {
    throw new ApiError(409, "payment_not_found", "Refund source must be a provider-confirmed payment for this tenant.");
  }
  if (amountCents > sourcePayment.amount_cents) {
    throw new ApiError(409, "refund_exceeds_source_payment", "Refund amount exceeds the selected confirmed payment.");
  }
  if (
    reason === "first_subscription_14_day_unused" &&
    Date.now() - Date.parse(sourcePayment.occurred_at) > 14 * 86_400_000
  ) {
    throw new ApiError(409, "refund_window_expired", "The first-subscription refund window has expired.");
  }
  const netCash = await env.TEAM_CONTROL_DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_ledger WHERE org_id = ?1`
  )
    .bind(auth.orgId)
    .first<{ total: number }>();
  if (amountCents > (netCash?.total ?? 0)) {
    throw new ApiError(409, "refund_exceeds_net_cash", "Refund amount exceeds provider-confirmed net cash.");
  }
  const at = nowIso();
  const actorPseudonym = await commercialActorPseudonym(env, auth.orgId, auth.userId);
  const commandId = newId("billing_command");
  const command = {
    schema_version: "billing-command-v1",
    command_id: commandId,
    provider: "stripe",
    operation: "request_refund",
    idempotency_key: idempotencyKey,
    amount_cents: amountCents,
    currency: "usd",
    source_payment_event_id: sourcePaymentEventId,
    paid_features_materially_used: materiallyUsed,
    reason
  };
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_commands
        (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
       VALUES (?1, ?2, 'request_refund', ?3, ?4, 'prepared', ?5, ?6)`
    ).bind(commandId, auth.orgId, idempotencyKey, JSON.stringify(command), actorPseudonym, at),
    userAudit(env.TEAM_CONTROL_DB, auth, "team.refund.command_prepared", "billing_command", commandId, at, {
      reason,
      amount_cents: amountCents,
      source_payment_event_id: sourcePaymentEventId
    })
  ]);
  return jsonResponse({ command_id: commandId, command }, 202);
}

export async function listBillingCommands(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "billing"]);
  const rows = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, command_type, idempotency_key, command_json, status, created_by, created_at
       FROM billing_commands WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 100`
  )
    .bind(auth.orgId)
    .all();
  return jsonResponse({
    commands: rows.results.map((row) => ({ ...row, command: JSON.parse(String(row.command_json)), command_json: undefined }))
  });
}

async function recordFrozenCheckoutCompletion(
  env: Env,
  summary: StripeSummary,
  eventId: string,
  at: string
): Promise<void> {
  if (!summary.checkoutIntentId || !summary.customerId || !summary.subscriptionId) {
    throw new ApiError(400, "invalid_provider_event", "Frozen Checkout completion is missing provider identifiers.");
  }
  const leaseId = newId("checkout_subscription_compensation_lease");
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE checkout_intents
          SET status = 'compensating', provider_session_id = ?1,
              compensation_customer_id = ?2, compensation_subscription_id = ?3,
              execution_lease_id = ?4, execution_lease_expires_at = ?5
        WHERE id = ?6 AND org_id = ?7 AND internal_price_id = ?8
          AND status IN ('prepared', 'executing', 'provider_created', 'compensating', 'canceled')
          AND (provider_session_id IS NULL OR provider_session_id = ?1)
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?7 AND status = 'deletion_pending')`
    ).bind(
      summary.objectId,
      summary.customerId,
      summary.subscriptionId,
      leaseId,
      at,
      summary.checkoutIntentId,
      summary.orgId,
      summary.internalPriceId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_commands
          SET status = 'compensating', execution_lease_id = ?1, execution_lease_expires_at = ?2
        WHERE org_id = ?3 AND command_type = 'create_checkout_session'
          AND status IN ('prepared', 'executing', 'provider_accepted', 'compensating', 'canceled')
          AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?4
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?4 AND org_id = ?3 AND status = 'compensating'
               AND provider_session_id = ?5
               AND compensation_customer_id = ?6 AND compensation_subscription_id = ?7
               AND execution_lease_id = ?1 AND execution_lease_expires_at = ?2
          )`
    ).bind(
      leaseId,
      at,
      summary.orgId,
      summary.checkoutIntentId,
      summary.objectId,
      summary.customerId,
      summary.subscriptionId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE provider_events SET status = 'rejected'
        WHERE event_id = ?1 AND org_id = ?2 AND event_type = 'checkout.session.completed'
          AND object_id = ?3 AND status = 'ignored'
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?4 AND org_id = ?2 AND status = 'compensating'
               AND provider_session_id = ?3
               AND compensation_customer_id = ?5 AND compensation_subscription_id = ?6
          )`
    ).bind(
      eventId,
      summary.orgId,
      summary.objectId,
      summary.checkoutIntentId,
      summary.customerId,
      summary.subscriptionId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'stripe', 'stripe', 'billing.checkout.completion_requires_compensation',
              'provider_event', ?3, '{}', ?4
        WHERE EXISTS (
          SELECT 1 FROM provider_events
           WHERE event_id = ?3 AND org_id = ?2 AND status = 'rejected'
        )
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?5 AND org_id = ?2 AND status = 'compensating'
               AND compensation_subscription_id = ?6
          )`
    ).bind(newId("audit"), summary.orgId, eventId, at, summary.checkoutIntentId, summary.subscriptionId)
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ApiError(
      409,
      "checkout_completion_compensation_conflict",
      "Frozen Checkout completion could not reserve exact provider compensation."
    );
  }
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  assertBillingDutySecretSeparation(env);
  const rawBody = await readBoundedText(request, WEBHOOK_BODY_LIMIT);
  await verifySignedPayload(request.headers.get("Stripe-Signature"), rawBody, env.STRIPE_WEBHOOK_SECRET);
  const event = parseJsonObject(rawBody);
  const eventId = requireOpaqueId(event.id, "event.id", 255);
  if (event.object !== "event") {
    throw new ApiError(400, "invalid_provider_event", "Stripe payload is not an event object.");
  }
  const eventCreated = requireInteger(event.created, "event.created", { min: 1 });
  if (event.api_version !== STRIPE_API_VERSION) {
    throw new ApiError(400, "provider_api_version_mismatch", "Stripe event API version is not supported.");
  }
  const eventTypeValue = requireString(event.type, "event.type", { max: 128 });
  const livemode = requireBoolean(event.livemode, "event.livemode");
  if (livemode !== stripeLivemode(env)) {
    throw new ApiError(400, "provider_mode_mismatch", "Provider event mode does not match this environment.");
  }
  const supported = new Set<SupportedStripeEventType>([
    "checkout.session.completed",
    "invoice.paid",
    "invoice.payment_failed",
    "refund.created",
    "customer.subscription.updated",
    "customer.subscription.deleted"
  ]);
  if (!supported.has(eventTypeValue as SupportedStripeEventType)) {
    return jsonResponse({ received: true, ignored: true });
  }
  const eventType = eventTypeValue as SupportedStripeEventType;
  const data = requireObject(event.data, "event.data");
  const object = requireObject(data.object, "event.data.object");
  const summary =
    eventType === "refund.created"
      ? await extractRefundStripeSummary(env, object)
      : extractStripeSummary(eventType, object);
  const organization = await env.TEAM_CONTROL_DB.prepare(
    `SELECT status FROM organizations WHERE id = ?1`
  )
    .bind(summary.orgId)
    .first<{ status: "active" | "deletion_pending" | "deleted" }>();
  if (!organization || organization.status === "deleted") {
    throw new ApiError(410, "organization_deleted", "Provider events cannot mutate a deleted organization.");
  }
  if (summary.providerPriceId !== providerPriceId(env, summary.internalPriceId)) {
    throw new ApiError(409, "provider_price_mismatch", "Provider event does not match the canonical price catalog.");
  }
  const payloadHash = await sha256Hex(rawBody);
  const at = nowIso();
  let insert: D1Result;
  try {
    insert = await env.TEAM_CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO provider_events
        (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
         summary_json, status, received_at)
       VALUES (?1, 'stripe', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
      .bind(
        eventId,
        eventType,
        summary.objectId,
        summary.orgId,
        eventCreated,
        payloadHash,
        JSON.stringify(summary),
        eventType === "checkout.session.completed" ? "ignored" : "awaiting_reconciliation",
        at
      )
      .run();
  } catch (error) {
    const current = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status FROM organizations WHERE id = ?1`
    )
      .bind(summary.orgId)
      .first<{ status: string }>();
    if (!current || current.status === "deleted") {
      throw new ApiError(410, "organization_deleted", "Provider events cannot mutate a deleted organization.");
    }
    throw error;
  }
  if ((insert.meta.changes ?? 0) === 0) {
    const existing = await env.TEAM_CONTROL_DB.prepare(
      `SELECT payload_sha256 FROM provider_events WHERE event_id = ?1`
    )
      .bind(eventId)
      .first<{ payload_sha256: string }>();
    if (!existing || existing.payload_sha256 !== payloadHash) {
      throw new ApiError(409, "provider_event_replay_mismatch", "Provider event identifier was reused with different data.");
    }
    return jsonResponse({ received: true, duplicate: true });
  }

  if (eventType === "checkout.session.completed" && organization.status !== "active") {
    await recordFrozenCheckoutCompletion(env, summary, eventId, at);
    throw new ApiError(
      409,
      "checkout_completion_frozen_for_deletion",
      "Checkout completion was reserved for exact subscription cancellation while organization deletion is pending."
    );
  }

  const account = await billingAccount(env.TEAM_CONTROL_DB, summary.orgId);
  if (
    account?.last_reconciled_event_created !== null &&
    account?.last_reconciled_event_created !== undefined &&
    (eventCreated < account.last_reconciled_event_created ||
      (eventCreated === account.last_reconciled_event_created && eventId !== account.last_reconciled_event_id))
  ) {
    await env.TEAM_CONTROL_DB.batch([
      env.TEAM_CONTROL_DB.prepare(`UPDATE provider_events SET status = 'stale' WHERE event_id = ?1`).bind(eventId),
      auditStatement(env.TEAM_CONTROL_DB, {
        orgId: summary.orgId,
        actorType: "stripe",
        actorId: "stripe",
        action: "billing.webhook.stale",
        resourceType: "provider_event",
        resourceId: eventId,
        metadata: { event_type: eventType },
        at
      })
    ]);
    return jsonResponse({ received: true, stale: true });
  }

  if (eventType === "checkout.session.completed") {
    if (!summary.checkoutIntentId || !summary.customerId || !summary.subscriptionId) {
      throw new ApiError(400, "invalid_provider_event", "Completed checkout is missing provider identifiers.");
    }
    const checkout = await env.TEAM_CONTROL_DB.prepare(
      `SELECT id, org_id, internal_price_id, status, expires_at FROM checkout_intents WHERE id = ?1`
    )
      .bind(summary.checkoutIntentId)
      .first<{ id: string; org_id: string; internal_price_id: string; status: string; expires_at: string }>();
    if (
      !checkout ||
      checkout.org_id !== summary.orgId ||
      checkout.internal_price_id !== summary.internalPriceId ||
      !["prepared", "executing", "provider_created", "compensating"].includes(checkout.status) ||
      eventCreated * 1000 > Date.parse(checkout.expires_at) + SIGNATURE_TOLERANCE_SECONDS * 1000
    ) {
      throw new ApiError(409, "checkout_tenant_mismatch", "Checkout session does not match the prepared tenant intent.");
    }
    await rejectProviderTenantCollision(
      env.TEAM_CONTROL_DB,
      summary.orgId,
      summary.customerId,
      summary.subscriptionId
    );
    if (
      account?.provider_subscription_id &&
      (account.provider_subscription_id !== summary.subscriptionId || account.provider_customer_id !== summary.customerId)
    ) {
      await env.TEAM_CONTROL_DB.prepare(
        `UPDATE provider_events SET status = 'rejected' WHERE event_id = ?1`
      )
        .bind(eventId)
        .run();
      throw new ApiError(
        409,
        "checkout_workflow_collision",
        "A second provider subscription cannot replace the organization billing binding."
      );
    }
    const previousState = account?.commercial_state ?? "offer_shown";
    let completionResults: D1Result[];
    try {
      completionResults = await env.TEAM_CONTROL_DB.batch([
        env.TEAM_CONTROL_DB.prepare(
          `UPDATE checkout_intents SET status = 'completed', provider_session_id = ?1,
             execution_lease_id = NULL, execution_lease_expires_at = NULL
            WHERE id = ?2 AND org_id = ?3
              AND status IN ('prepared', 'executing', 'provider_created', 'compensating')
              AND EXISTS (SELECT 1 FROM organizations WHERE id = ?3 AND status = 'active')`
        ).bind(summary.objectId, summary.checkoutIntentId, summary.orgId),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE billing_commands SET status = 'confirmed', execution_lease_id = NULL,
             execution_lease_expires_at = NULL
          WHERE org_id = ?1 AND command_type = 'create_checkout_session'
            AND status IN ('prepared', 'executing', 'provider_accepted', 'compensating')
            AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?2
            AND EXISTS (
              SELECT 1 FROM checkout_intents
               WHERE id = ?2 AND org_id = ?1 AND status = 'completed' AND provider_session_id = ?3
            )
            AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'active')`
      ).bind(summary.orgId, summary.checkoutIntentId, summary.objectId),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_accounts
          (org_id, provider_customer_id, provider_subscription_id, commercial_state, internal_price_id,
           billing_interval, contributor_limit, updated_at)
         SELECT ?1, ?2, ?3, 'payment_pending', ?4, ?5, 15, ?6
          WHERE EXISTS (
            SELECT 1 FROM billing_commands
             WHERE org_id = ?1 AND command_type = 'create_checkout_session' AND status = 'confirmed'
               AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?7
          )
            AND EXISTS (
              SELECT 1 FROM checkout_intents
               WHERE id = ?7 AND org_id = ?1 AND status = 'completed' AND provider_session_id = ?8
            )
            AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'active')
         ON CONFLICT(org_id) DO UPDATE SET
           provider_customer_id = excluded.provider_customer_id,
           provider_subscription_id = excluded.provider_subscription_id,
           commercial_state = 'payment_pending',
           internal_price_id = excluded.internal_price_id,
           billing_interval = excluded.billing_interval,
           updated_at = excluded.updated_at`
      ).bind(
        summary.orgId,
        summary.customerId,
        summary.subscriptionId,
        summary.internalPriceId,
        TEAM_PRICES[summary.internalPriceId].interval,
        at,
        summary.checkoutIntentId,
        summary.objectId
      ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO commercial_transitions
          (id, org_id, from_state, to_state, source, source_ref, occurred_at)
         SELECT ?1, ?2, ?3, 'payment_pending', 'stripe_webhook', ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM billing_accounts
             WHERE org_id = ?2 AND provider_customer_id = ?6 AND provider_subscription_id = ?7
               AND commercial_state = 'payment_pending'
          )
            AND EXISTS (SELECT 1 FROM organizations WHERE id = ?2 AND status = 'active')`
      ).bind(newId("transition"), summary.orgId, previousState, eventId, at, summary.customerId, summary.subscriptionId),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO lifecycle_events
          (event_id, org_id, event_name, source_ref, event_day, created_at)
         SELECT ?1, ?2, 'team_offer_shown_v1', ?3, ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM billing_accounts
             WHERE org_id = ?2 AND provider_customer_id = ?6 AND provider_subscription_id = ?7
               AND commercial_state = 'payment_pending'
          )
            AND EXISTS (SELECT 1 FROM organizations WHERE id = ?2 AND status = 'active')`
      ).bind(
        newId("life"),
        summary.orgId,
        summary.checkoutIntentId,
        at.slice(0, 10),
        at,
        summary.customerId,
        summary.subscriptionId
      ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO lifecycle_events
          (event_id, org_id, event_name, source_ref, event_day, created_at)
         SELECT ?1, ?2, 'checkout_started_v1', ?3, ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM billing_accounts
             WHERE org_id = ?2 AND provider_customer_id = ?6 AND provider_subscription_id = ?7
               AND commercial_state = 'payment_pending'
          )
            AND EXISTS (SELECT 1 FROM organizations WHERE id = ?2 AND status = 'active')`
      ).bind(
        newId("life"),
        summary.orgId,
        summary.objectId,
        at.slice(0, 10),
        at,
        summary.customerId,
        summary.subscriptionId
      ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO audit_events
          (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
         SELECT ?1, ?2, 'stripe', 'stripe', 'billing.checkout.confirmed',
                'provider_event', ?3, '{}', ?4
          WHERE EXISTS (
            SELECT 1 FROM billing_accounts
             WHERE org_id = ?2 AND provider_customer_id = ?5 AND provider_subscription_id = ?6
               AND commercial_state = 'payment_pending'
          )
            AND EXISTS (SELECT 1 FROM organizations WHERE id = ?2 AND status = 'active')`
      ).bind(newId("audit"), summary.orgId, eventId, at, summary.customerId, summary.subscriptionId)
      ]);
    } catch (error) {
      const current = await env.TEAM_CONTROL_DB.prepare(
        `SELECT status FROM organizations WHERE id = ?1`
      )
        .bind(summary.orgId)
        .first<{ status: string }>();
      if (!current || current.status === "deleted") {
        throw new ApiError(410, "organization_deleted", "Provider events cannot mutate a deleted organization.");
      }
      if (current.status === "deletion_pending") {
        await recordFrozenCheckoutCompletion(env, summary, eventId, at);
        throw new ApiError(
          409,
          "checkout_completion_frozen_for_deletion",
          "Checkout completion was reserved for exact subscription cancellation while organization deletion is pending."
        );
      }
      throw error;
    }
    if (completionResults.some((result) => (result.meta.changes ?? 0) !== 1)) {
      const current = await env.TEAM_CONTROL_DB.prepare(
        `SELECT status FROM organizations WHERE id = ?1`
      )
        .bind(summary.orgId)
        .first<{ status: string }>();
      if (current?.status === "deletion_pending") {
        await recordFrozenCheckoutCompletion(env, summary, eventId, at);
        throw new ApiError(
          409,
          "checkout_completion_frozen_for_deletion",
          "Checkout completion was reserved for exact subscription cancellation while organization deletion is pending."
        );
      }
      await env.TEAM_CONTROL_DB.prepare(
        `UPDATE provider_events SET status = 'rejected' WHERE event_id = ?1 AND status = 'ignored'`
      )
        .bind(eventId)
        .run();
      throw new ApiError(409, "checkout_completion_conflict", "Checkout completion lost its atomic billing binding.");
    }
  } else {
    await env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       VALUES (?1, ?2, 'stripe', 'stripe', 'billing.webhook.verified', 'provider_event', ?3, ?4, ?5)`
    )
      .bind(newId("audit"), summary.orgId, eventId, JSON.stringify({ event_type: eventType }), at)
      .run();
  }
  return jsonResponse({ received: true, awaiting_reconciliation: eventType !== "checkout.session.completed" });
}

function parseReconciliation(body: Record<string, unknown>): ReconciliationSnapshot {
  assertExactKeys(body, [
    "schema_version",
    "reconciliation_id",
    "observed_at",
    "source_event_id",
    "kind",
    "org_id",
    "provider_customer_id",
    "provider_subscription_id",
    "provider_object_id",
    "internal_price_id",
    "provider_price_id",
    "provider_status",
    "currency",
    "cash_amount_cents",
    "net_recurring_amount_cents",
    "refund_amount_cents",
    "provider_refund_id",
    "provider_charge_id",
    "provider_payment_intent_id",
    "source_payment_event_id",
    "billing_command_id",
    "cumulative_refund_amount_cents",
    "period_start",
    "period_end",
    "cancel_at_period_end"
  ]);
  if (body.schema_version !== "billing-reconciliation-v1") {
    throw new ApiError(400, "invalid_schema", "schema_version must be billing-reconciliation-v1.");
  }
  if (!isInternalPriceId(body.internal_price_id)) {
    throw new ApiError(400, "invalid_price", "Reconciliation contains an unknown internal price.");
  }
  const currency = requireEnum(body.currency, "currency", ["usd"] as const);
  return {
    reconciliationId: requireOpaqueId(body.reconciliation_id, "reconciliation_id", 255),
    observedAt: requireIsoDate(body.observed_at, "observed_at"),
    sourceEventId: requireOpaqueId(body.source_event_id, "source_event_id", 255),
    kind: requireEnum(body.kind, "kind", ["payment", "payment_failure", "refund", "subscription"] as const),
    orgId: requireOrgId(requireString(body.org_id, "org_id", { max: 64 })),
    providerCustomerId: requireOpaqueId(body.provider_customer_id, "provider_customer_id", 255),
    providerSubscriptionId: requireOpaqueId(body.provider_subscription_id, "provider_subscription_id", 255),
    providerObjectId: requireOpaqueId(body.provider_object_id, "provider_object_id", 255),
    internalPriceId: body.internal_price_id,
    providerPriceId: requireOpaqueId(body.provider_price_id, "provider_price_id", 255),
    providerStatus: requireEnum(body.provider_status, "provider_status", [
      "paid",
      "failed",
      "active",
      "past_due",
      "canceled",
      "refunded"
    ] as const),
    currency,
    cashAmountCents: requireInteger(body.cash_amount_cents, "cash_amount_cents", { min: 0, max: 10_000_000 }),
    netRecurringAmountCents: requireInteger(body.net_recurring_amount_cents, "net_recurring_amount_cents", {
      min: 0,
      max: 10_000_000
    }),
    refundAmountCents: requireInteger(body.refund_amount_cents, "refund_amount_cents", {
      min: 0,
      max: 10_000_000
    }),
    providerRefundId: nullableProviderId(body.provider_refund_id, "provider_refund_id"),
    providerChargeId: nullableProviderId(body.provider_charge_id, "provider_charge_id"),
    providerPaymentIntentId: nullableProviderId(body.provider_payment_intent_id, "provider_payment_intent_id"),
    sourcePaymentEventId: nullableProviderId(body.source_payment_event_id, "source_payment_event_id"),
    billingCommandId: nullableProviderId(body.billing_command_id, "billing_command_id"),
    cumulativeRefundAmountCents: requireInteger(
      body.cumulative_refund_amount_cents,
      "cumulative_refund_amount_cents",
      { min: 0, max: 10_000_000 }
    ),
    periodStart: requireIsoDate(body.period_start, "period_start"),
    periodEnd: requireIsoDate(body.period_end, "period_end"),
    cancelAtPeriodEnd: requireBoolean(body.cancel_at_period_end, "cancel_at_period_end")
  };
}

function expectedEventType(kind: ReconciliationKind): readonly SupportedStripeEventType[] {
  switch (kind) {
    case "payment":
      return ["invoice.paid"];
    case "payment_failure":
      return ["invoice.payment_failed"];
    case "refund":
      return ["refund.created"];
    case "subscription":
      return ["customer.subscription.updated", "customer.subscription.deleted"];
  }
}

function validateReconciliationValues(snapshot: ReconciliationSnapshot): void {
  if (Date.parse(snapshot.periodEnd) <= Date.parse(snapshot.periodStart)) {
    throw new ApiError(400, "invalid_period", "Billing period end must be after its start.");
  }
  if (snapshot.kind === "payment") {
    if (
      snapshot.providerStatus !== "paid" ||
      snapshot.cashAmountCents <= 0 ||
      snapshot.netRecurringAmountCents <= 0 ||
      snapshot.refundAmountCents !== 0 ||
      !refundFieldsAreEmpty(snapshot)
    ) {
      throw new ApiError(400, "invalid_payment_snapshot", "Payment reconciliation values are inconsistent.");
    }
  } else if (snapshot.kind === "payment_failure") {
    if (
      snapshot.providerStatus !== "failed" ||
      snapshot.cashAmountCents !== 0 ||
      snapshot.netRecurringAmountCents !== 0 ||
      snapshot.refundAmountCents !== 0 ||
      !refundFieldsAreEmpty(snapshot)
    ) {
      throw new ApiError(400, "invalid_failure_snapshot", "Payment-failure reconciliation values are inconsistent.");
    }
  } else if (snapshot.kind === "refund") {
    if (
      snapshot.providerStatus !== "refunded" ||
      snapshot.cashAmountCents !== 0 ||
      snapshot.refundAmountCents <= 0 ||
      snapshot.netRecurringAmountCents !== snapshot.refundAmountCents ||
      snapshot.providerRefundId !== snapshot.providerObjectId ||
      !snapshot.providerChargeId ||
      !snapshot.providerPaymentIntentId ||
      !snapshot.sourcePaymentEventId ||
      snapshot.cumulativeRefundAmountCents < snapshot.refundAmountCents
    ) {
      throw new ApiError(400, "invalid_refund_snapshot", "Refund reconciliation values are inconsistent.");
    }
  } else {
    if (
      !(["active", "past_due", "canceled"] as const).includes(
        snapshot.providerStatus as "active" | "past_due" | "canceled"
      ) ||
      snapshot.cashAmountCents !== 0 ||
      snapshot.netRecurringAmountCents !== 0 ||
      snapshot.refundAmountCents !== 0 ||
      !refundFieldsAreEmpty(snapshot)
    ) {
      throw new ApiError(400, "invalid_subscription_snapshot", "Subscription reconciliation values are inconsistent.");
    }
  }
}

function refundFieldsAreEmpty(snapshot: ReconciliationSnapshot): boolean {
  return (
    snapshot.providerRefundId === null &&
    snapshot.providerChargeId === null &&
    snapshot.providerPaymentIntentId === null &&
    snapshot.sourcePaymentEventId === null &&
    snapshot.billingCommandId === null &&
    snapshot.cumulativeRefundAmountCents === 0
  );
}

async function rejectSnapshot(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow,
  payloadHash: string,
  reason: "stale" | "rejected"
): Promise<void> {
  const at = nowIso();
  await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO provider_reconciliation_snapshots
        (reconciliation_id, source_event_id, org_id, snapshot_kind, payload_sha256, observed_at, applied_at, result)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      snapshot.reconciliationId,
      snapshot.sourceEventId,
      snapshot.orgId,
      snapshot.kind,
      payloadHash,
      snapshot.observedAt,
      at,
      reason
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE provider_events SET status = ?1 WHERE event_id = ?2 AND status <> 'reconciled'`
    ).bind(reason, event.event_id),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      actorType: "reconciler",
      actorId: "stripe-readonly-adapter",
      action: `billing.reconciliation.${reason}`,
      resourceType: "provider_event",
      resourceId: event.event_id,
      at
    })
  ]);
}

async function claimProviderState(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow
): Promise<boolean> {
  const claimed = await env.TEAM_CONTROL_DB.prepare(
    `INSERT INTO provider_state_cursors
      (org_id, event_created, event_id, reconciliation_id, status, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'claimed', ?5)
     ON CONFLICT(org_id) DO UPDATE SET
       event_created = excluded.event_created,
       event_id = excluded.event_id,
       reconciliation_id = excluded.reconciliation_id,
       status = 'claimed',
       updated_at = excluded.updated_at
     WHERE excluded.event_created > provider_state_cursors.event_created
        OR (
          excluded.event_created = provider_state_cursors.event_created
          AND excluded.event_id = provider_state_cursors.event_id
          AND excluded.reconciliation_id = provider_state_cursors.reconciliation_id
          AND provider_state_cursors.status = 'claimed'
        )`
  )
    .bind(snapshot.orgId, event.event_created, event.event_id, snapshot.reconciliationId, nowIso())
    .run();
  return (claimed.meta.changes ?? 0) === 1;
}

export async function handleProviderReconciliation(request: Request, env: Env): Promise<Response> {
  assertBillingDutySecretSeparation(env);
  const rawBody = await readBoundedText(request, 65_536);
  await verifySignedPayload(
    request.headers.get("Agent-Vigil-Reconciliation-Signature"),
    rawBody,
    env.STRIPE_RECONCILIATION_HMAC_SECRET
  );
  const snapshot = parseReconciliation(parseJsonObject(rawBody));
  validateReconciliationValues(snapshot);
  if (Math.abs(Date.now() - Date.parse(snapshot.observedAt)) > SIGNATURE_TOLERANCE_SECONDS * 1000) {
    throw new ApiError(400, "stale_snapshot", "Reconciliation observation is outside the allowed window.");
  }
  if (snapshot.providerPriceId !== providerPriceId(env, snapshot.internalPriceId)) {
    throw new ApiError(409, "provider_price_mismatch", "Reconciliation does not match the canonical price catalog.");
  }
  const payloadHash = await sha256Hex(rawBody);
  const priorSnapshot = await env.TEAM_CONTROL_DB.prepare(
    `SELECT reconciliation_id, payload_sha256, result
       FROM provider_reconciliation_snapshots WHERE reconciliation_id = ?1`
  )
    .bind(snapshot.reconciliationId)
    .first<{ reconciliation_id: string; payload_sha256: string; result: string }>();
  if (priorSnapshot) {
    if (priorSnapshot.payload_sha256 !== payloadHash) {
      throw new ApiError(409, "reconciliation_replay_mismatch", "Reconciliation identifier was reused with different data.");
    }
    return jsonResponse({ reconciled: priorSnapshot.result === "applied", duplicate: true, result: priorSnapshot.result });
  }
  const event = await env.TEAM_CONTROL_DB.prepare(
    `SELECT event_id, event_type, object_id, org_id, event_created, summary_json, status
       FROM provider_events WHERE event_id = ?1`
  )
    .bind(snapshot.sourceEventId)
    .first<ProviderEventRow>();
  if (!event || event.status === "ignored" || event.status === "rejected" || event.status === "stale") {
    throw new ApiError(409, "event_not_reconcilable", "Source provider event is not eligible for reconciliation.");
  }
  if (event.status === "reconciled") {
    return jsonResponse({ reconciled: true, duplicate: true });
  }
  const summary = JSON.parse(event.summary_json) as StripeSummary;
  const organization = await env.TEAM_CONTROL_DB.prepare(
    `SELECT status FROM organizations WHERE id = ?1`
  )
    .bind(snapshot.orgId)
    .first<{ status: "active" | "deletion_pending" | "deleted" }>();
  if (!organization || organization.status === "deleted") {
    await rejectSnapshot(env, snapshot, event, payloadHash, "rejected");
    throw new ApiError(410, "organization_deleted", "Reconciliation cannot mutate a deleted organization.");
  }
  if (
    !expectedEventType(snapshot.kind).includes(event.event_type) ||
    event.org_id !== snapshot.orgId ||
    summary.orgId !== snapshot.orgId ||
    event.object_id !== snapshot.providerObjectId ||
    (summary.customerId !== null && summary.customerId !== snapshot.providerCustomerId) ||
    (summary.subscriptionId !== null && summary.subscriptionId !== snapshot.providerSubscriptionId) ||
    summary.internalPriceId !== snapshot.internalPriceId ||
    summary.providerPriceId !== snapshot.providerPriceId ||
    (snapshot.kind === "refund" &&
      (summary.refundId !== snapshot.providerRefundId ||
        summary.refundAmountCents !== snapshot.refundAmountCents ||
        summary.refundChargeId !== snapshot.providerChargeId ||
        summary.refundPaymentIntentId !== snapshot.providerPaymentIntentId ||
        summary.refundSourcePaymentEventId !== snapshot.sourcePaymentEventId ||
        summary.refundBillingCommandId !== snapshot.billingCommandId))
  ) {
    await rejectSnapshot(env, snapshot, event, payloadHash, "rejected");
    throw new ApiError(409, "reconciliation_mismatch", "Reconciliation does not match the signed provider event.");
  }
  await rejectProviderTenantCollision(
    env.TEAM_CONTROL_DB,
    snapshot.orgId,
    snapshot.providerCustomerId,
    snapshot.providerSubscriptionId
  );
  const account = await billingAccount(env.TEAM_CONTROL_DB, snapshot.orgId);
  if (
    (account?.provider_customer_id && account.provider_customer_id !== snapshot.providerCustomerId) ||
    (account?.provider_subscription_id && account.provider_subscription_id !== snapshot.providerSubscriptionId)
  ) {
    await rejectSnapshot(env, snapshot, event, payloadHash, "rejected");
    throw new ApiError(409, "provider_binding_mismatch", "Provider identifiers do not match the tenant billing account.");
  }
  if (
    snapshot.kind !== "refund" &&
    account?.last_reconciled_event_created !== null &&
    account?.last_reconciled_event_created !== undefined &&
    (event.event_created < account.last_reconciled_event_created ||
      (event.event_created === account.last_reconciled_event_created && event.event_id !== account.last_reconciled_event_id))
  ) {
    await rejectSnapshot(env, snapshot, event, payloadHash, "stale");
    throw new ApiError(409, "stale_provider_event", "An older or ambiguously ordered event cannot change billing state.");
  }
  if (snapshot.kind !== "refund" && !(await claimProviderState(env, snapshot, event))) {
    await rejectSnapshot(env, snapshot, event, payloadHash, "stale");
    throw new ApiError(409, "stale_provider_event", "Provider chronology was claimed by a newer or competing event.");
  }

  try {
    if (snapshot.kind === "payment") {
      await applyPayment(env, snapshot, event, account, payloadHash);
    } else if (snapshot.kind === "payment_failure") {
      await applyPaymentFailure(env, snapshot, event, account, payloadHash);
    } else if (snapshot.kind === "refund") {
      await applyRefund(env, snapshot, event, account, payloadHash);
    } else {
      await applySubscription(env, snapshot, event, account, payloadHash);
    }
  } catch (error) {
    const current = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status FROM organizations WHERE id = ?1`
    )
      .bind(snapshot.orgId)
      .first<{ status: string }>();
    if (!current || current.status === "deleted") {
      throw new ApiError(410, "organization_deleted", "Reconciliation cannot mutate a deleted organization.");
    }
    throw error;
  }
  return jsonResponse({ reconciled: true, source_event_id: event.event_id });
}

function reconciliationBaseStatements(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow,
  payloadHash: string,
  at: string
): D1PreparedStatement[] {
  return [
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO provider_reconciliation_snapshots
        (reconciliation_id, source_event_id, org_id, snapshot_kind, payload_sha256, observed_at, applied_at, result)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'applied')`
    ).bind(
      snapshot.reconciliationId,
      snapshot.sourceEventId,
      snapshot.orgId,
      snapshot.kind,
      payloadHash,
      snapshot.observedAt,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE provider_events SET status = 'reconciled', reconciled_at = ?1 WHERE event_id = ?2`
    ).bind(at, event.event_id),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE provider_state_cursors SET status = 'applied', updated_at = ?1
        WHERE org_id = ?2 AND event_id = ?3 AND reconciliation_id = ?4 AND status = 'claimed'`
    ).bind(at, snapshot.orgId, event.event_id, snapshot.reconciliationId)
  ];
}

async function applyPayment(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow,
  account: BillingAccountRow | null,
  payloadHash: string
): Promise<void> {
  const at = nowIso();
  const priorEntitlement = await getEntitlement(env.TEAM_CONTROL_DB, snapshot.orgId);
  const renewal = priorEntitlement?.status === "active" || priorEntitlement?.status === "grace";
  const mrr = recognizedMrrMicros(snapshot.netRecurringAmountCents, snapshot.internalPriceId);
  const previousMrr = account?.current_recognized_mrr_micros ?? 0;
  const finalState = renewal ? "renewed" : "entitled";
  const previousState = account?.commercial_state ?? "payment_pending";
  const statements = reconciliationBaseStatements(env, snapshot, event, payloadHash, at);
  statements.push(
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_accounts
        (org_id, provider_customer_id, provider_subscription_id, commercial_state, internal_price_id,
         billing_interval, contributor_limit, current_period_start, current_period_end,
         cancel_at_period_end, current_recognized_mrr_micros, last_reconciled_event_created,
         last_reconciled_event_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 15, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(org_id) DO UPDATE SET
         provider_customer_id = excluded.provider_customer_id,
         provider_subscription_id = excluded.provider_subscription_id,
         commercial_state = excluded.commercial_state,
         internal_price_id = excluded.internal_price_id,
         billing_interval = excluded.billing_interval,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         current_recognized_mrr_micros = excluded.current_recognized_mrr_micros,
         last_reconciled_event_created = excluded.last_reconciled_event_created,
         last_reconciled_event_id = excluded.last_reconciled_event_id,
         updated_at = excluded.updated_at`
    ).bind(
      snapshot.orgId,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      finalState,
      snapshot.internalPriceId,
      TEAM_PRICES[snapshot.internalPriceId].interval,
      snapshot.periodStart,
      snapshot.periodEnd,
      snapshot.cancelAtPeriodEnd ? 1 : 0,
      mrr,
      event.event_created,
      event.event_id,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO entitlements
        (org_id, tier, status, contributor_limit, billing_source, starts_at, ends_at,
         grace_until, source_event_id, updated_at)
       VALUES (?1, 'team', 'active', 15, 'stripe', ?2, ?3, NULL, ?4, ?5)
       ON CONFLICT(org_id) DO UPDATE SET
         status = 'active', starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         grace_until = NULL, source_event_id = excluded.source_event_id, updated_at = excluded.updated_at`
    ).bind(snapshot.orgId, snapshot.periodStart, snapshot.periodEnd, event.event_id, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO cash_ledger
        (id, org_id, source_event_id, entry_type, amount_cents, currency, occurred_at)
       VALUES (?1, ?2, ?3, 'payment', ?4, 'usd', ?5)`
    ).bind(newId("cash"), snapshot.orgId, event.event_id, snapshot.cashAmountCents, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO revenue_ledger
        (id, org_id, source_event_id, entry_type, recognized_mrr_delta_micros, currency,
         recognized_period_start, recognized_period_end, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'usd', ?6, ?7, ?8)`
    ).bind(
      newId("revenue"),
      snapshot.orgId,
      event.event_id,
      renewal ? "mrr_renewed" : "mrr_started",
      mrr - previousMrr,
      snapshot.periodStart,
      snapshot.periodEnd,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO commercial_transitions
        (id, org_id, from_state, to_state, source, source_ref, occurred_at)
       VALUES (?1, ?2, ?3, 'paid', 'provider_reconciliation', ?4, ?5)`
    ).bind(newId("transition"), snapshot.orgId, previousState, event.event_id, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO commercial_transitions
        (id, org_id, from_state, to_state, source, source_ref, occurred_at)
       VALUES (?1, ?2, 'paid', ?3, 'provider_reconciliation', ?4, ?5)`
    ).bind(newId("transition"), snapshot.orgId, finalState, event.event_id, at),
    lifecycleStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      eventName: "payment_succeeded_v1",
      sourceRef: event.event_id,
      at
    }),
    lifecycleStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      eventName: renewal ? "subscription_renewed_v1" : "entitlement_activated_v1",
      sourceRef: event.event_id,
      at
    }),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      actorType: "reconciler",
      actorId: "stripe-readonly-adapter",
      action: renewal ? "billing.subscription.renewed" : "billing.entitlement.activated",
      resourceType: "provider_event",
      resourceId: event.event_id,
      metadata: { internal_price_id: snapshot.internalPriceId },
      at
    })
  );
  await env.TEAM_CONTROL_DB.batch(statements);
}

async function applyPaymentFailure(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow,
  account: BillingAccountRow | null,
  payloadHash: string
): Promise<void> {
  if (!account) {
    throw new ApiError(409, "billing_account_missing", "A failed payment cannot bind an unknown billing account.");
  }
  const at = nowIso();
  const graceUntil = new Date(Date.parse(snapshot.observedAt) + 7 * 86_400_000).toISOString();
  const statements = reconciliationBaseStatements(env, snapshot, event, payloadHash, at);
  statements.push(
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_accounts SET commercial_state = 'past_due', grace_until = ?1,
        last_reconciled_event_created = ?2, last_reconciled_event_id = ?3, updated_at = ?4
       WHERE org_id = ?5`
    ).bind(graceUntil, event.event_created, event.event_id, at, snapshot.orgId),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE entitlements SET status = 'grace', grace_until = ?1, source_event_id = ?2, updated_at = ?3
       WHERE org_id = ?4`
    ).bind(graceUntil, event.event_id, at, snapshot.orgId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO commercial_transitions
        (id, org_id, from_state, to_state, source, source_ref, occurred_at)
       VALUES (?1, ?2, ?3, 'past_due', 'provider_reconciliation', ?4, ?5)`
    ).bind(newId("transition"), snapshot.orgId, account.commercial_state, event.event_id, at),
    lifecycleStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      eventName: "payment_failed_v1",
      sourceRef: event.event_id,
      at
    }),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      actorType: "reconciler",
      actorId: "stripe-readonly-adapter",
      action: "billing.payment.failed",
      resourceType: "provider_event",
      resourceId: event.event_id,
      metadata: { grace_until: graceUntil },
      at
    })
  );
  await env.TEAM_CONTROL_DB.batch(statements);
}

async function applyRefund(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow,
  account: BillingAccountRow | null,
  payloadHash: string
): Promise<void> {
  if (!account) {
    throw new ApiError(409, "billing_account_missing", "A refund cannot bind an unknown billing account.");
  }
  if (
    !snapshot.providerRefundId ||
    !snapshot.providerChargeId ||
    !snapshot.providerPaymentIntentId ||
    !snapshot.sourcePaymentEventId
  ) {
    throw new ApiError(400, "invalid_refund_snapshot", "Refund reconciliation is missing its exact provider binding.");
  }
  const sourcePayment = await env.TEAM_CONTROL_DB.prepare(
    `SELECT amount_cents FROM cash_ledger
      WHERE org_id = ?1 AND source_event_id = ?2 AND entry_type = 'payment'`
  )
    .bind(snapshot.orgId, snapshot.sourcePaymentEventId)
    .first<{ amount_cents: number }>();
  if (!sourcePayment || snapshot.cumulativeRefundAmountCents > sourcePayment.amount_cents) {
    throw new ApiError(409, "refund_exceeds_source_payment", "Provider refund exceeds its exact confirmed payment.");
  }
  const netCash = await env.TEAM_CONTROL_DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM cash_ledger WHERE org_id = ?1`
  )
    .bind(snapshot.orgId)
    .first<{ total: number }>();
  if (snapshot.refundAmountCents > (netCash?.total ?? 0)) {
    throw new ApiError(409, "refund_exceeds_net_cash", "Provider refund exceeds confirmed net cash.");
  }
  const adjustment = recognizedMrrMicros(snapshot.netRecurringAmountCents, snapshot.internalPriceId);
  const fullyRefunded = snapshot.cumulativeRefundAmountCents === sourcePayment.amount_cents;
  const at = nowIso();
  const statements = reconciliationBaseStatements(env, snapshot, event, payloadHash, at);
  statements.push(
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO provider_refund_applications
        (provider_refund_id, org_id, billing_command_id, source_payment_event_id,
         source_refund_event_id, provider_charge_id, provider_payment_intent_id,
         amount_cents, cumulative_amount_cents, applied_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(
      snapshot.providerRefundId,
      snapshot.orgId,
      snapshot.billingCommandId,
      snapshot.sourcePaymentEventId,
      event.event_id,
      snapshot.providerChargeId,
      snapshot.providerPaymentIntentId,
      snapshot.refundAmountCents,
      snapshot.cumulativeRefundAmountCents,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_commands SET status = 'confirmed'
        WHERE id = ?1 AND org_id = ?2 AND command_type = 'request_refund' AND status = 'provider_accepted'
          AND json_extract(command_json, '$.provider_result.refund_id') = ?3
          AND json_extract(command_json, '$.provider_result.charge_id') = ?4
          AND json_extract(command_json, '$.provider_result.payment_intent_id') = ?5
          AND json_extract(command_json, '$.provider_result.source_payment_event_id') = ?6
          AND json_extract(command_json, '$.provider_result.amount_cents') = ?7`
    ).bind(
      snapshot.billingCommandId,
      snapshot.orgId,
      snapshot.providerRefundId,
      snapshot.providerChargeId,
      snapshot.providerPaymentIntentId,
      snapshot.sourcePaymentEventId,
      snapshot.refundAmountCents
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_accounts SET commercial_state = ?1,
        current_recognized_mrr_micros = CASE
          WHEN ?2 = 1 THEN 0
          ELSE MAX(0, current_recognized_mrr_micros - ?3)
        END,
        last_reconciled_event_created = ?4, last_reconciled_event_id = ?5, updated_at = ?6
       WHERE org_id = ?7`
    ).bind(
      fullyRefunded ? "refunded" : account.commercial_state,
      fullyRefunded ? 1 : 0,
      adjustment,
      event.event_created,
      event.event_id,
      at,
      snapshot.orgId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE entitlements SET status = ?1, source_event_id = ?2, updated_at = ?3 WHERE org_id = ?4`
    ).bind(fullyRefunded ? "refunded" : "active", event.event_id, at, snapshot.orgId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO cash_ledger
        (id, org_id, source_event_id, entry_type, amount_cents, currency, occurred_at)
       VALUES (?1, ?2, ?3, 'refund', ?4, 'usd', ?5)`
    ).bind(newId("cash"), snapshot.orgId, event.event_id, -snapshot.refundAmountCents, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO revenue_ledger
        (id, org_id, source_event_id, entry_type, recognized_mrr_delta_micros, currency,
         recognized_period_start, recognized_period_end, occurred_at)
       VALUES (?1, ?2, ?3, 'mrr_refund_adjustment', ?4, 'usd', ?5, ?6, ?7)`
    ).bind(newId("revenue"), snapshot.orgId, event.event_id, -adjustment, snapshot.periodStart, snapshot.periodEnd, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO commercial_transitions
        (id, org_id, from_state, to_state, source, source_ref, occurred_at)
       VALUES (?1, ?2, ?3, ?4, 'provider_reconciliation', ?5, ?6)`
    ).bind(
      newId("transition"),
      snapshot.orgId,
      account.commercial_state,
      fullyRefunded ? "refunded" : account.commercial_state,
      event.event_id,
      at
    ),
    lifecycleStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      eventName: "refund_issued_v1",
      sourceRef: event.event_id,
      at
    }),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      actorType: "reconciler",
      actorId: "stripe-readonly-adapter",
      action: "billing.refund.confirmed",
      resourceType: "provider_event",
      resourceId: event.event_id,
      metadata: { amount_cents: snapshot.refundAmountCents, full: fullyRefunded },
      at
    })
  );
  const results = await env.TEAM_CONTROL_DB.batch(statements);
  const expectedCommandChanges = snapshot.billingCommandId === null ? 0 : 1;
  if (
    (results[3]?.meta.changes ?? 0) !== 1 ||
    (results[4]?.meta.changes ?? 0) !== expectedCommandChanges ||
    (results[5]?.meta.changes ?? 0) !== 1
  ) {
    throw new ApiError(409, "refund_binding_conflict", "Refund reconciliation lost its exact command binding.");
  }
}

async function applySubscription(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow,
  account: BillingAccountRow | null,
  payloadHash: string
): Promise<void> {
  if (!account) {
    throw new ApiError(409, "billing_account_missing", "Subscription state cannot bind an unknown billing account.");
  }
  const at = nowIso();
  const canceled = snapshot.providerStatus === "canceled";
  const pastDue = snapshot.providerStatus === "past_due";
  const cancelAtEnd = snapshot.cancelAtPeriodEnd && !canceled;
  const nextState = canceled ? "expired" : pastDue ? "past_due" : cancelAtEnd ? "canceled_at_period_end" : "entitled";
  const nextMrr = canceled ? 0 : account.current_recognized_mrr_micros;
  const graceUntil = pastDue ? new Date(Date.parse(snapshot.observedAt) + 7 * 86_400_000).toISOString() : null;
  const statements = reconciliationBaseStatements(env, snapshot, event, payloadHash, at);
  statements.push(
    ...(snapshot.cancelAtPeriodEnd || canceled
      ? [
          env.TEAM_CONTROL_DB.prepare(
            `UPDATE billing_commands SET status = 'confirmed'
              WHERE org_id = ?1 AND command_type = 'cancel_at_period_end' AND status = 'provider_accepted'
                AND json_extract(command_json, '$.provider_subscription_id') = ?2`
          ).bind(snapshot.orgId, snapshot.providerSubscriptionId)
        ]
      : []),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_accounts SET commercial_state = ?1, current_period_start = ?2,
        current_period_end = ?3, grace_until = ?4, cancel_at_period_end = ?5,
        current_recognized_mrr_micros = ?6, last_reconciled_event_created = ?7,
        last_reconciled_event_id = ?8, updated_at = ?9 WHERE org_id = ?10`
    ).bind(
      nextState,
      snapshot.periodStart,
      snapshot.periodEnd,
      graceUntil,
      cancelAtEnd ? 1 : 0,
      nextMrr,
      event.event_created,
      event.event_id,
      at,
      snapshot.orgId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE entitlements SET status = ?1, ends_at = ?2, grace_until = ?3,
        source_event_id = ?4, updated_at = ?5 WHERE org_id = ?6`
    ).bind(canceled ? "expired" : pastDue ? "grace" : "active", snapshot.periodEnd, graceUntil, event.event_id, at, snapshot.orgId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO commercial_transitions
        (id, org_id, from_state, to_state, source, source_ref, occurred_at)
       VALUES (?1, ?2, ?3, ?4, 'provider_reconciliation', ?5, ?6)`
    ).bind(newId("transition"), snapshot.orgId, account.commercial_state, nextState, event.event_id, at),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      actorType: "reconciler",
      actorId: "stripe-readonly-adapter",
      action: `billing.subscription.${nextState}`,
      resourceType: "provider_event",
      resourceId: event.event_id,
      at
    })
  );
  if (cancelAtEnd) {
    statements.push(
      lifecycleStatement(env.TEAM_CONTROL_DB, {
        orgId: snapshot.orgId,
        eventName: "subscription_canceled_v1",
        sourceRef: event.event_id,
        at
      })
    );
  }
  if (canceled) {
    statements.push(
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO revenue_ledger
          (id, org_id, source_event_id, entry_type, recognized_mrr_delta_micros, currency,
           recognized_period_start, recognized_period_end, occurred_at)
         VALUES (?1, ?2, ?3, 'mrr_ended', ?4, 'usd', ?5, ?6, ?7)`
      ).bind(
        newId("revenue"),
        snapshot.orgId,
        event.event_id,
        -account.current_recognized_mrr_micros,
        snapshot.periodStart,
        snapshot.periodEnd,
        at
      ),
      lifecycleStatement(env.TEAM_CONTROL_DB, {
        orgId: snapshot.orgId,
        eventName: "entitlement_expired_v1",
        sourceRef: event.event_id,
        at
      })
    );
  }
  if (pastDue) {
    statements.push(
      lifecycleStatement(env.TEAM_CONTROL_DB, {
        orgId: snapshot.orgId,
        eventName: "payment_failed_v1",
        sourceRef: event.event_id,
        at
      })
    );
  }
  await env.TEAM_CONTROL_DB.batch(statements);
}

export async function getEntitlementAndRevenue(env: Env, auth: AuthContext): Promise<Response> {
  requireRole(auth, ["owner", "admin", "billing"]);
  const account = await billingAccount(env.TEAM_CONTROL_DB, auth.orgId);
  const entitlement = await getEntitlement(env.TEAM_CONTROL_DB, auth.orgId);
  const cash = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, source_event_id, entry_type, amount_cents, currency, occurred_at
       FROM cash_ledger WHERE org_id = ?1 ORDER BY occurred_at`
  )
    .bind(auth.orgId)
    .all();
  const revenue = await env.TEAM_CONTROL_DB.prepare(
    `SELECT id, source_event_id, entry_type, recognized_mrr_delta_micros, currency,
            recognized_period_start, recognized_period_end, occurred_at
       FROM revenue_ledger WHERE org_id = ?1 ORDER BY occurred_at`
  )
    .bind(auth.orgId)
    .all();
  return jsonResponse({
    schema_version: "team-commercial-ledger-v1",
    billing_state: account?.commercial_state ?? null,
    entitlement,
    recognized_mrr: {
      currency: "usd",
      minor_unit_micros: account?.current_recognized_mrr_micros ?? 0,
      source: "provider_reconciled_subscription_projection"
    },
    cash_ledger: cash.results,
    recognized_mrr_ledger: revenue.results,
    boundaries: {
      checkout_is_not_cash: true,
      invoice_is_not_cash: true,
      annual_cash_is_not_mrr: true
    }
  });
}
