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
  billing_generation: number;
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

interface CheckoutCommandStateRow {
  id: string;
  status: "provider_accepted" | "confirmed" | "compensating" | "canceled";
  resume_status: "provider_accepted" | "confirmed" | "canceled" | null;
}

interface BillingGenerationRow {
  generation: number;
  internal_price_id: InternalPriceId;
  status: "reserved" | "bound" | "terminal_verified" | "retired" | "abandoned";
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  terminal_source_event_id: string | null;
}

interface StripeSummary {
  orgId: string;
  objectId: string;
  customerId: string | null;
  subscriptionId: string | null;
  internalPriceId: InternalPriceId;
  providerPriceId: string;
  reportedInternalPriceId: InternalPriceId;
  reportedProviderPriceId: string;
  billingGeneration: number;
  reportedBillingGeneration: number | null;
  billingGenerationSource: "metadata" | "legacy_unique_binding" | "checkout_intent_binding";
  checkoutIntentId: string | null;
  checkoutSessionId: string | null;
  refundId: string | null;
  refundAmountCents: number | null;
  refundChargeId: string | null;
  refundPaymentIntentId: string | null;
  refundSourcePaymentEventId: string | null;
  refundBillingCommandId: string | null;
}

interface UnresolvedStripeSummary extends Omit<StripeSummary, "billingGeneration" | "billingGenerationSource"> {
  billingGeneration: number | null;
  billingGenerationSource: "metadata" | "checkout_intent_binding";
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
  billingGeneration: number;
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
  reportedInternalPriceId: InternalPriceId;
  reportedProviderPriceId: string;
  billingGeneration: number | null;
  reportedBillingGeneration: number | null;
  checkoutIntentId: string | null;
} {
  const metadata = requireObject(value, "provider metadata");
  const orgId = requireOrgId(requireString(metadata.team_org_id, "metadata.team_org_id", { max: 64 }));
  if (!isInternalPriceId(metadata.internal_price_id)) {
    throw new ApiError(400, "invalid_provider_event", "Provider event contains an unknown internal price.");
  }
  const billingGenerationRaw =
    metadata.billing_generation === null || metadata.billing_generation === undefined
      ? null
      : requireString(metadata.billing_generation, "metadata.billing_generation", {
          min: 1,
          max: 10,
          pattern: /^[1-9][0-9]{0,9}$/u
        });
  const reportedBillingGeneration = billingGenerationRaw === null ? null : Number(billingGenerationRaw);
  return {
    orgId,
    internalPriceId: metadata.internal_price_id,
    providerPriceId: requireOpaqueId(metadata.provider_price_id, "metadata.provider_price_id", 255),
    reportedInternalPriceId: metadata.internal_price_id,
    reportedProviderPriceId: requireOpaqueId(metadata.provider_price_id, "metadata.provider_price_id", 255),
    billingGeneration: reportedBillingGeneration,
    reportedBillingGeneration,
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

function extractStripeSummary(
  eventType: Exclude<SupportedStripeEventType, "refund.created">,
  object: Record<string, unknown>
): UnresolvedStripeSummary {
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
    billingGenerationSource: metadata.billingGeneration === null ? "checkout_intent_binding" : "metadata",
    objectId,
    customerId,
    subscriptionId,
    checkoutSessionId: eventType === "checkout.session.completed" ? objectId : null,
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
    `SELECT bc.id, bc.org_id, bc.command_json,
            json_extract(source.summary_json, '$.customerId') AS provider_customer_id,
            json_extract(source.summary_json, '$.subscriptionId') AS provider_subscription_id,
            json_extract(source.summary_json, '$.internalPriceId') AS internal_price_id,
            json_extract(source.summary_json, '$.providerPriceId') AS provider_price_id,
            json_extract(source.summary_json, '$.billingGeneration') AS billing_generation
       FROM billing_commands bc
       JOIN provider_events source
         ON source.event_id = json_extract(bc.command_json, '$.provider_result.source_payment_event_id')
        AND source.org_id = bc.org_id AND source.event_type = 'invoice.paid'
        AND source.status = 'reconciled'
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
      provider_price_id: string;
      billing_generation: number;
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
              json_extract(source.summary_json, '$.customerId') AS provider_customer_id,
              json_extract(source.summary_json, '$.subscriptionId') AS provider_subscription_id,
              json_extract(source.summary_json, '$.internalPriceId') AS internal_price_id,
              json_extract(source.summary_json, '$.providerPriceId') AS provider_price_id,
              json_extract(source.summary_json, '$.billingGeneration') AS billing_generation
         FROM billing_commands bc
         JOIN provider_events source
           ON source.event_id = json_extract(bc.command_json, '$.provider_result.source_payment_event_id')
          AND source.org_id = bc.org_id AND source.event_type = 'invoice.paid'
          AND source.status = 'reconciled'
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
        provider_price_id: string;
        billing_generation: number;
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
      internal_price_id: sourceBinding.internal_price_id,
      provider_price_id: sourceBinding.provider_price_id,
      billing_generation: sourceBinding.billing_generation
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
  if (
    !binding ||
    !isInternalPriceId(binding.internal_price_id) ||
    binding.provider_price_id !== providerPriceId(env, binding.internal_price_id) ||
    !Number.isSafeInteger(binding.billing_generation) ||
    binding.billing_generation <= 0
  ) {
    throw new ApiError(409, "refund_source_binding_mismatch", "Refund source price binding is invalid.");
  }
  return {
    orgId: binding.org_id,
    objectId: refundId,
    customerId: requireOpaqueId(binding.provider_customer_id, "provider_customer_id", 255),
    subscriptionId: requireOpaqueId(binding.provider_subscription_id, "provider_subscription_id", 255),
    internalPriceId: binding.internal_price_id,
    providerPriceId: binding.provider_price_id,
    reportedInternalPriceId: binding.internal_price_id,
    reportedProviderPriceId: binding.provider_price_id,
    billingGeneration: binding.billing_generation,
    reportedBillingGeneration: binding.billing_generation,
    billingGenerationSource: "metadata",
    checkoutIntentId: null,
    checkoutSessionId: null,
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
              internal_price_id, billing_interval, billing_generation, current_period_start, current_period_end,
              current_recognized_mrr_micros, last_reconciled_event_created, last_reconciled_event_id
         FROM billing_accounts WHERE org_id = ?1`
    )
    .bind(orgId)
    .first<BillingAccountRow>();
}

async function billingGenerationHead(db: D1Database, orgId: string): Promise<BillingGenerationRow | null> {
  return db
    .prepare(
      `SELECT generation, internal_price_id, status, provider_customer_id, provider_subscription_id,
              terminal_source_event_id
         FROM billing_generations WHERE org_id = ?1
        ORDER BY generation DESC LIMIT 1`
    )
    .bind(orgId)
    .first<BillingGenerationRow>();
}

async function billingGeneration(
  db: D1Database,
  orgId: string,
  generation: number
): Promise<BillingGenerationRow | null> {
  return db
    .prepare(
      `SELECT generation, internal_price_id, status, provider_customer_id, provider_subscription_id,
              terminal_source_event_id
         FROM billing_generations WHERE org_id = ?1 AND generation = ?2`
    )
    .bind(orgId, generation)
    .first<BillingGenerationRow>();
}

async function resolveStripeSummaryGeneration(
  env: Env,
  eventType: Exclude<SupportedStripeEventType, "refund.created">,
  summary: UnresolvedStripeSummary
): Promise<StripeSummary> {
  const db = env.TEAM_CONTROL_DB;
  if (eventType === "checkout.session.completed") {
    if (!summary.checkoutIntentId) {
      throw new ApiError(400, "invalid_provider_event", "Checkout session is missing its checkout intent identifier.");
    }
    const candidates = await db
      .prepare(
        `SELECT ci.billing_generation, ci.internal_price_id, ci.status AS checkout_status,
                ci.provider_session_id AS checkout_session_id,
                bg.status AS generation_status,
                bg.provider_checkout_session_id,
                bg.provider_customer_id, bg.provider_subscription_id,
                EXISTS (
                  SELECT 1 FROM workflow_integrity_receipts eligible
                   WHERE eligible.workflow_type = 'legacy_billing_generation_bridge_eligible'
                     AND eligible.source_ref = bg.org_id || ':' || CAST(bg.generation AS TEXT)
                     AND eligible.valid = 1
                ) AS legacy_bridge_eligible
           FROM checkout_intents ci
           JOIN billing_generations bg
             ON bg.org_id = ci.org_id AND bg.generation = ci.billing_generation
            AND bg.checkout_intent_id = ci.id
          WHERE ci.id = ?1 AND ci.org_id = ?2 AND bg.internal_price_id = ci.internal_price_id
            AND EXISTS (
              SELECT 1 FROM billing_commands bc
               WHERE bc.org_id = ci.org_id AND bc.command_type = 'create_checkout_session'
                 AND json_extract(bc.command_json, '$.parameters.metadata.checkout_intent_id') = ci.id
                 AND json_extract(bc.command_json, '$.parameters.internal_price_id') = ci.internal_price_id
            )
          LIMIT 2`
      )
      .bind(summary.checkoutIntentId, summary.orgId)
      .all<{
        billing_generation: number;
        internal_price_id: string;
        checkout_status: string;
        checkout_session_id: string | null;
        generation_status: string;
        provider_checkout_session_id: string | null;
        provider_customer_id: string | null;
        provider_subscription_id: string | null;
        legacy_bridge_eligible: number;
      }>();
    if (candidates.results.length !== 1) {
      throw new ApiError(
        409,
        "checkout_generation_binding_missing",
        "Checkout completion does not have one exact immutable intent generation."
      );
    }
    const candidate = candidates.results[0]!;
    if (!isInternalPriceId(candidate.internal_price_id)) {
      throw new ApiError(500, "checkout_generation_binding_corrupt", "Checkout generation has an invalid canonical price.");
    }
    const canonicalGeneration = candidate.billing_generation;
    const canonicalProviderPriceId = providerPriceId(env, candidate.internal_price_id);
    let legacyCheckoutBridge = false;
    if (
      summary.reportedBillingGeneration === null &&
      summary.customerId &&
      summary.subscriptionId &&
      candidate.legacy_bridge_eligible === 1 &&
      candidate.checkout_status === "provider_created" &&
      candidate.generation_status === "reserved" &&
      candidate.checkout_session_id === summary.objectId &&
      candidate.provider_checkout_session_id === summary.objectId &&
      candidate.provider_customer_id === null &&
      candidate.provider_subscription_id === null &&
      summary.reportedInternalPriceId === candidate.internal_price_id &&
      summary.reportedProviderPriceId === canonicalProviderPriceId
    ) {
      const collision = await db
        .prepare(
          `SELECT 1 AS found
             FROM billing_generations
            WHERE provider_customer_id = ?1 OR provider_subscription_id = ?2
           UNION ALL
           SELECT 1 AS found
             FROM checkout_subscription_compensations
            WHERE provider_customer_id = ?1 OR provider_subscription_id = ?2
           LIMIT 1`
        )
        .bind(summary.customerId, summary.subscriptionId)
        .first<{ found: number }>();
      legacyCheckoutBridge = !collision;
    }
    return {
      ...summary,
      internalPriceId: candidate.internal_price_id,
      providerPriceId: canonicalProviderPriceId,
      billingGeneration: canonicalGeneration,
      billingGenerationSource:
        summary.reportedBillingGeneration === canonicalGeneration
          ? "metadata"
          : legacyCheckoutBridge
            ? "legacy_unique_binding"
            : "checkout_intent_binding"
    };
  }

  if (summary.billingGeneration !== null) {
    return { ...summary, billingGeneration: summary.billingGeneration, billingGenerationSource: "metadata" };
  }
  if (!summary.customerId || !summary.subscriptionId) {
    throw new ApiError(
      409,
      "legacy_generation_binding_missing",
      "Legacy provider event is missing exact customer and subscription bindings."
    );
  }
  const candidates = await db
    .prepare(
      `SELECT bg.generation
         FROM billing_generations bg
         JOIN workflow_integrity_receipts eligible
           ON eligible.workflow_type = 'legacy_billing_generation_bridge_eligible'
          AND eligible.source_ref = bg.org_id || ':' || CAST(bg.generation AS TEXT)
          AND eligible.valid = 1
        WHERE bg.org_id = ?1 AND bg.provider_customer_id = ?2
          AND bg.provider_subscription_id = ?3 AND bg.internal_price_id = ?4
          AND (?5 IS NULL OR bg.checkout_intent_id = ?5)
        LIMIT 2`
    )
    .bind(
      summary.orgId,
      summary.customerId,
      summary.subscriptionId,
      summary.internalPriceId,
      summary.checkoutIntentId
    )
    .all<{ generation: number }>();
  if (candidates.results.length !== 1) {
    throw new ApiError(
      409,
      "legacy_generation_binding_missing",
      "Legacy provider event does not have one migration-approved immutable billing generation."
    );
  }
  return {
    ...summary,
    billingGeneration: candidates.results[0]!.generation,
    billingGenerationSource: "legacy_unique_binding"
  };
}

async function rejectProviderTenantCollision(
  db: D1Database,
  orgId: string,
  customerId: string,
  subscriptionId: string
): Promise<void> {
  const collision = await db
    .prepare(
      `SELECT org_id FROM billing_generations
        WHERE org_id <> ?1 AND (provider_customer_id = ?2 OR provider_subscription_id = ?3)
       UNION ALL
       SELECT org_id FROM billing_accounts
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
  const [account, generationHead] = await Promise.all([
    billingAccount(env.TEAM_CONTROL_DB, auth.orgId),
    billingGenerationHead(env.TEAM_CONTROL_DB, auth.orgId)
  ]);
  const replacingSubscription = account?.provider_subscription_id !== null && account?.provider_subscription_id !== undefined;
  if (replacingSubscription) {
    if (
      !generationHead ||
      generationHead.status !== "terminal_verified" ||
      account.billing_generation !== generationHead.generation ||
      account.provider_customer_id !== generationHead.provider_customer_id ||
      account.provider_subscription_id !== generationHead.provider_subscription_id ||
      !generationHead.terminal_source_event_id
    ) {
      throw new ApiError(
        409,
        "provider_subscription_not_terminal",
        "A signed, reconciled terminal subscription fact is required before another checkout."
      );
    }
  } else if (generationHead && generationHead.status !== "abandoned") {
    throw new ApiError(409, "checkout_generation_not_terminal", "The prior checkout generation is not terminal.");
  }
  const billingGeneration = (generationHead?.generation ?? 0) + 1;
  const previousGeneration = generationHead?.generation ?? null;
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
        billing_generation: String(billingGeneration),
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
        `UPDATE billing_generations SET status = 'retired', retired_at = ?1
          WHERE org_id = ?2 AND generation = ?3 AND status = 'terminal_verified'
            AND terminal_source_event_id IS NOT NULL AND ?3 IS NOT NULL`
      ).bind(at, auth.orgId, previousGeneration),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generation_events
          (id, org_id, generation, event_type, source_ref, occurred_at)
         SELECT ?1, ?2, ?3, 'retired', ?4, ?5
          WHERE ?3 IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM billing_generations
               WHERE org_id = ?2 AND generation = ?3 AND status = 'retired' AND retired_at = ?5
            )`
      ).bind(`billing_generation_retired_${checkoutIntentId}`, auth.orgId, previousGeneration, checkoutIntentId, at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generations
          (org_id, generation, checkout_intent_id, internal_price_id, status, reserved_at)
         SELECT ?1, ?2, ?3, ?4, 'reserved', ?5
          WHERE EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'active')
            AND NOT EXISTS (
              SELECT 1 FROM billing_generations WHERE org_id = ?1 AND status IN ('reserved', 'bound')
            )
            AND (
              (?6 IS NULL AND NOT EXISTS (SELECT 1 FROM billing_generations WHERE org_id = ?1)) OR
              (?6 IS NOT NULL AND EXISTS (
                SELECT 1 FROM billing_generations
                 WHERE org_id = ?1 AND generation = ?6
                   AND (status = 'abandoned' OR (status = 'retired' AND terminal_source_event_id IS NOT NULL))
              ))
            )
            AND NOT EXISTS (
              SELECT 1 FROM checkout_intents
               WHERE org_id = ?1 AND status IN ('prepared', 'executing', 'provider_created', 'compensating')
            )
            AND NOT EXISTS (
              SELECT 1 FROM entitlements
               WHERE org_id = ?1 AND status IN ('active', 'grace') AND ends_at > ?5
            )`
      ).bind(auth.orgId, billingGeneration, checkoutIntentId, internalPriceId, at, previousGeneration),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generation_events
          (id, org_id, generation, event_type, source_ref, occurred_at)
         SELECT ?1, ?2, ?3, 'reserved', ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM billing_generations
             WHERE org_id = ?2 AND generation = ?3 AND checkout_intent_id = ?4 AND status = 'reserved'
          )`
      ).bind(`billing_generation_reserved_${checkoutIntentId}`, auth.orgId, billingGeneration, checkoutIntentId, at),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO checkout_intents
          (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
           contributor_limit, status, created_by, created_at, expires_at, billing_generation)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 15, 'prepared', ?7, ?8, ?9, ?10
          WHERE EXISTS (
            SELECT 1 FROM billing_generations
             WHERE org_id = ?2 AND generation = ?10 AND checkout_intent_id = ?1 AND status = 'reserved'
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
        expiresAt,
        billingGeneration
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
        `INSERT OR IGNORE INTO billing_accounts (org_id, commercial_state, billing_generation, updated_at)
         SELECT ?1, 'offer_shown', ?2, ?3
          WHERE EXISTS (
            SELECT 1 FROM checkout_intents WHERE id = ?4 AND org_id = ?1 AND status = 'prepared'
          )`
      ).bind(auth.orgId, billingGeneration, at, checkoutIntentId),
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
      ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
         VALUES (?1, 'billing_generation_reserved', ?2,
           CASE WHEN
             EXISTS (
               SELECT 1 FROM billing_generations
                WHERE org_id = ?3 AND generation = ?4 AND checkout_intent_id = ?5 AND status = 'reserved'
             )
             AND EXISTS (
               SELECT 1 FROM billing_generation_events
                WHERE org_id = ?3 AND generation = ?4 AND event_type = 'reserved' AND source_ref = ?5
             )
             AND EXISTS (
               SELECT 1 FROM checkout_intents
                WHERE id = ?5 AND org_id = ?3 AND billing_generation = ?4 AND status = 'prepared'
             )
             AND EXISTS (
               SELECT 1 FROM billing_commands
                WHERE id = ?2 AND org_id = ?3 AND status = 'prepared'
             )
           THEN 1 ELSE 0 END, ?6)`
      ).bind(`integrity_${commandId}`, commandId, auth.orgId, billingGeneration, checkoutIntentId, at)
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
    (results[2]?.meta.changes ?? 0) !== 1 ||
    (results[3]?.meta.changes ?? 0) !== 1 ||
    (results[4]?.meta.changes ?? 0) !== 1 ||
    (results[5]?.meta.changes ?? 0) !== 1 ||
    (results[7]?.meta.changes ?? 0) !== 1 ||
    (results[8]?.meta.changes ?? 0) !== 1 ||
    (replacingSubscription &&
      ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1))
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
  const generation = account
    ? await billingGeneration(env.TEAM_CONTROL_DB, auth.orgId, account.billing_generation)
    : null;
  if (
    !account?.provider_customer_id ||
    !account.provider_subscription_id ||
    !generation ||
    generation.status !== "bound" ||
    generation.provider_customer_id !== account.provider_customer_id ||
    generation.provider_subscription_id !== account.provider_subscription_id ||
    generation.internal_price_id !== account.internal_price_id
  ) {
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
    billing_generation: account.billing_generation,
    reason
  };
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_commands
        (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
       SELECT ?1, ?2, 'cancel_at_period_end', ?3, ?4, 'prepared', ?5, ?6
        WHERE EXISTS (
          SELECT 1 FROM billing_accounts ba
          JOIN billing_generations bg ON bg.org_id = ba.org_id AND bg.generation = ba.billing_generation
         WHERE ba.org_id = ?2 AND ba.billing_generation = ?7
           AND ba.provider_customer_id = ?8 AND ba.provider_subscription_id = ?9
           AND ba.internal_price_id = ?10
           AND bg.status = 'bound' AND bg.provider_customer_id = ba.provider_customer_id
           AND bg.provider_subscription_id = ba.provider_subscription_id
           AND bg.internal_price_id = ba.internal_price_id
        )`
    ).bind(
      commandId,
      auth.orgId,
      idempotencyKey,
      JSON.stringify(command),
      actorPseudonym,
      at,
      account.billing_generation,
      account.provider_customer_id,
      account.provider_subscription_id,
      account.internal_price_id
    ),
    userAudit(env.TEAM_CONTROL_DB, auth, "team.cancellation.command_prepared", "billing_command", commandId, at, {
      reason,
      billing_generation: account.billing_generation
    }),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'billing_cancellation_prepared', ?2,
         CASE WHEN EXISTS (
           SELECT 1 FROM billing_commands c
           JOIN billing_accounts ba ON ba.org_id = c.org_id
          JOIN billing_generations bg ON bg.org_id = ba.org_id AND bg.generation = ba.billing_generation
          WHERE c.id = ?2 AND c.org_id = ?3 AND c.command_type = 'cancel_at_period_end'
            AND c.status = 'prepared'
            AND CAST(json_extract(c.command_json, '$.billing_generation') AS INTEGER) = ?4
            AND json_extract(c.command_json, '$.provider_subscription_id') = ?5
            AND ba.billing_generation = ?4 AND ba.provider_customer_id = ?6
            AND ba.provider_subscription_id = ?5 AND ba.internal_price_id = ?7
            AND bg.status = 'bound' AND bg.provider_customer_id = ?6
            AND bg.provider_subscription_id = ?5 AND bg.internal_price_id = ?7
         ) THEN 1 ELSE 0 END, ?8)`
    ).bind(
      newId("integrity"),
      commandId,
      auth.orgId,
      account.billing_generation,
      account.provider_subscription_id,
      account.provider_customer_id,
      account.internal_price_id,
      at
    )
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ApiError(409, "cancellation_state_conflict", "Cancelable subscription changed concurrently.");
  }
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

async function reserveUnexpectedCheckoutCompensation(
  env: Env,
  summary: StripeSummary,
  eventId: string,
  checkout: {
    id: string;
    org_id: string;
    internal_price_id: string;
    billing_generation: number;
    status: string;
    provider_session_id: string | null;
  },
  at: string
): Promise<void> {
  if (!summary.customerId || !summary.subscriptionId || !summary.checkoutIntentId) {
    throw new ApiError(400, "invalid_provider_event", "Unexpected Checkout completion is missing provider identifiers.");
  }
  const commands = await env.TEAM_CONTROL_DB.prepare(
    `SELECT bc.id, bc.status,
            CASE
              WHEN bc.status = 'compensating' THEN (
                SELECT x.resume_command_status
                  FROM checkout_subscription_compensations x
                 WHERE x.org_id = bc.org_id AND x.billing_command_id = bc.id
                   AND x.status IN ('prepared', 'executing')
                 ORDER BY x.requested_at, x.id LIMIT 1
              )
              ELSE bc.status
            END AS resume_status
       FROM billing_commands bc
      WHERE bc.org_id = ?1 AND bc.command_type = 'create_checkout_session'
        AND json_extract(bc.command_json, '$.parameters.metadata.checkout_intent_id') = ?2
        AND CAST(json_extract(bc.command_json, '$.parameters.metadata.billing_generation') AS INTEGER) = ?3
        AND bc.status IN ('provider_accepted', 'confirmed', 'compensating', 'canceled')
      LIMIT 2`
  )
    .bind(summary.orgId, summary.checkoutIntentId, summary.billingGeneration)
    .all<CheckoutCommandStateRow>();
  const command = commands.results[0];
  if (
    commands.results.length !== 1 ||
    !command ||
    !command.resume_status ||
    summary.billingGeneration !== checkout.billing_generation
  ) {
    throw new ApiError(
      409,
      "checkout_generation_mismatch",
      "Checkout completion does not match one executable immutable billing generation."
    );
  }
  await rejectProviderTenantCollision(env.TEAM_CONTROL_DB, summary.orgId, summary.customerId, summary.subscriptionId);
  const compensationId = newId("checkout_subscription_compensation");
  const generationEventId = newId("billing_generation_event");
  const auditId = newId("audit");
  const resumeStatus = command.resume_status;
  const reason =
    summary.reportedBillingGeneration === checkout.billing_generation &&
    summary.reportedInternalPriceId === summary.internalPriceId &&
    summary.reportedProviderPriceId === summary.providerPriceId
      ? "unexpected_session"
      : "unexpected_generation_binding";
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE provider_events SET status = 'rejected'
        WHERE event_id = ?1 AND org_id = ?2 AND event_type = 'checkout.session.completed'
          AND object_id = ?3 AND status = 'ignored'`
    ).bind(eventId, summary.orgId, summary.objectId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO checkout_subscription_compensations
        (id, org_id, billing_command_id, checkout_intent_id, billing_generation,
         provider_event_id, provider_session_id, provider_customer_id, provider_subscription_id,
         reason, status, resume_command_status, requested_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
              ?10, 'prepared', ?11, ?12
        WHERE EXISTS (
          SELECT 1 FROM billing_generations bg
          JOIN checkout_intents ci
            ON ci.id = bg.checkout_intent_id AND ci.org_id = bg.org_id
           AND ci.billing_generation = bg.generation
         WHERE bg.org_id = ?2 AND bg.generation = ?5 AND bg.checkout_intent_id = ?4
           AND bg.internal_price_id = ?13 AND ci.internal_price_id = ?13
        )
          AND NOT EXISTS (
            SELECT 1 FROM billing_generations
             WHERE provider_subscription_id = ?9
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkout_subscription_compensations
             WHERE provider_event_id = ?6
                OR (provider_session_id = ?7 AND provider_subscription_id = ?9)
          )`
    ).bind(
      compensationId,
      summary.orgId,
      command.id,
      summary.checkoutIntentId,
      summary.billingGeneration,
      eventId,
      summary.objectId,
      summary.customerId,
      summary.subscriptionId,
      reason,
      resumeStatus,
      at,
      summary.internalPriceId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_commands SET status = 'compensating',
          execution_lease_id = CASE WHEN status = 'compensating' THEN execution_lease_id ELSE ?4 END,
          execution_lease_expires_at = CASE WHEN status = 'compensating' THEN execution_lease_expires_at ELSE ?5 END
        WHERE id = ?1 AND org_id = ?2
          AND status IN ('provider_accepted', 'confirmed', 'compensating', 'canceled')
          AND (status = 'compensating' OR status = ?3)
          AND EXISTS (
            SELECT 1 FROM checkout_subscription_compensations
             WHERE id = ?4 AND org_id = ?2 AND billing_command_id = ?1
               AND checkout_intent_id = ?6 AND billing_generation = ?7
               AND provider_event_id = ?8 AND provider_session_id = ?9
               AND provider_subscription_id = ?10 AND status = 'prepared'
          )`
    ).bind(
      command.id,
      summary.orgId,
      command.status,
      compensationId,
      at,
      summary.checkoutIntentId,
      summary.billingGeneration,
      eventId,
      summary.objectId,
      summary.subscriptionId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_generation_events
        (id, org_id, generation, event_type, source_ref, occurred_at)
       SELECT ?1, ?2, ?3, 'unexpected_subscription_reserved', ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM checkout_subscription_compensations
           WHERE id = ?6 AND billing_command_id = ?7 AND status = 'prepared'
        )`
    ).bind(
      generationEventId,
      summary.orgId,
      summary.billingGeneration,
      compensationId,
      at,
      compensationId,
      command.id
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'stripe', 'stripe', 'billing.checkout.unexpected_subscription_requires_compensation',
              'checkout_subscription_compensation', ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM checkout_subscription_compensations
           WHERE id = ?3 AND org_id = ?2 AND provider_event_id = ?6
             AND provider_session_id = ?7 AND provider_subscription_id = ?8
             AND status = 'prepared'
        )`
    ).bind(
      auditId,
      summary.orgId,
      compensationId,
      JSON.stringify({ reason, provider_event_id: eventId }),
      at,
      eventId,
      summary.objectId,
      summary.subscriptionId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'unexpected_checkout_compensation_reserved', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM provider_events
              WHERE event_id = ?2 AND org_id = ?3 AND event_type = 'checkout.session.completed'
                AND object_id = ?4 AND status = 'rejected'
                AND json_extract(summary_json, '$.billingGeneration') = ?5
                AND json_extract(summary_json, '$.reportedBillingGeneration') IS ?6
                AND json_extract(summary_json, '$.customerId') = ?7
                AND json_extract(summary_json, '$.subscriptionId') = ?8
           )
           AND EXISTS (
             SELECT 1 FROM checkout_subscription_compensations
              WHERE id = ?9 AND org_id = ?3 AND billing_command_id = ?10
                AND checkout_intent_id = ?11 AND billing_generation = ?5
                AND provider_event_id = ?2 AND provider_session_id = ?4
                AND provider_customer_id = ?7 AND provider_subscription_id = ?8
                AND reason = ?12 AND status = 'prepared' AND resume_command_status = ?13
           )
           AND EXISTS (
             SELECT 1 FROM billing_commands
              WHERE id = ?10 AND org_id = ?3 AND status = 'compensating'
           )
           AND EXISTS (
             SELECT 1 FROM billing_generation_events
              WHERE id = ?14 AND org_id = ?3 AND generation = ?5
                AND event_type = 'unexpected_subscription_reserved' AND source_ref = ?9
           )
           AND EXISTS (
             SELECT 1 FROM audit_events
              WHERE id = ?15 AND org_id = ?3
                AND action = 'billing.checkout.unexpected_subscription_requires_compensation'
                AND resource_id = ?9
           )
         THEN 1 ELSE 0 END, ?16)`
    ).bind(
      `integrity_${compensationId}`,
      eventId,
      summary.orgId,
      summary.objectId,
      summary.billingGeneration,
      summary.reportedBillingGeneration,
      summary.customerId,
      summary.subscriptionId,
      compensationId,
      command.id,
      summary.checkoutIntentId,
      reason,
      resumeStatus,
      generationEventId,
      auditId,
      at
    )
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ApiError(409, "checkout_compensation_conflict", "Unexpected subscription compensation changed concurrently.");
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
  let summary: StripeSummary;
  if (eventType === "refund.created") {
    summary = await extractRefundStripeSummary(env, object);
  } else {
    summary = await resolveStripeSummaryGeneration(
      env,
      eventType,
      extractStripeSummary(eventType, object)
    );
  }
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
    const insertStatement = env.TEAM_CONTROL_DB.prepare(
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
      );
    if (summary.billingGenerationSource === "legacy_unique_binding") {
      const receiptId = `integrity_legacy_billing_generation_bridge_${eventId}`;
      const bridgeResults = await env.TEAM_CONTROL_DB.batch([
        insertStatement,
        env.TEAM_CONTROL_DB.prepare(
          `INSERT OR IGNORE INTO workflow_integrity_receipts
            (id, workflow_type, source_ref, valid, created_at)
           VALUES (?1, 'legacy_billing_generation_bridge_applied', ?2,
             CASE WHEN EXISTS (
               SELECT 1
                 FROM provider_events pe
                 JOIN billing_generations bg
                   ON bg.org_id = pe.org_id
                  AND bg.generation = CAST(json_extract(pe.summary_json, '$.billingGeneration') AS INTEGER)
                  AND bg.internal_price_id = json_extract(pe.summary_json, '$.internalPriceId')
                 JOIN workflow_integrity_receipts eligible
                   ON eligible.workflow_type = 'legacy_billing_generation_bridge_eligible'
                  AND eligible.source_ref = bg.org_id || ':' || CAST(bg.generation AS TEXT)
                  AND eligible.valid = 1
                WHERE pe.event_id = ?2 AND pe.payload_sha256 = ?3
                  AND json_extract(pe.summary_json, '$.billingGenerationSource') = 'legacy_unique_binding'
                  AND json_extract(pe.summary_json, '$.reportedBillingGeneration') IS NULL
                  AND (
                    (
                      pe.event_type <> 'checkout.session.completed'
                      AND bg.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
                      AND bg.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
                      AND (
                        json_extract(pe.summary_json, '$.checkoutIntentId') IS NULL OR
                        bg.checkout_intent_id = json_extract(pe.summary_json, '$.checkoutIntentId')
                      )
                    ) OR (
                      pe.event_type = 'checkout.session.completed'
                      AND bg.status = 'reserved'
                      AND bg.provider_customer_id IS NULL AND bg.provider_subscription_id IS NULL
                      AND bg.checkout_intent_id = json_extract(pe.summary_json, '$.checkoutIntentId')
                      AND bg.provider_checkout_session_id = pe.object_id
                      AND json_extract(pe.summary_json, '$.checkoutSessionId') = pe.object_id
                      AND json_extract(pe.summary_json, '$.reportedInternalPriceId') = bg.internal_price_id
                      AND json_extract(pe.summary_json, '$.reportedProviderPriceId') =
                          json_extract(pe.summary_json, '$.providerPriceId')
                      AND EXISTS (
                        SELECT 1 FROM checkout_intents ci
                         WHERE ci.id = bg.checkout_intent_id AND ci.org_id = bg.org_id
                           AND ci.billing_generation = bg.generation AND ci.status = 'provider_created'
                           AND ci.provider_session_id = pe.object_id
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM billing_generations collision
                         WHERE collision.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
                            OR collision.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM checkout_subscription_compensations collision
                         WHERE collision.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
                            OR collision.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
                      )
                    )
                  )
             ) THEN 1 ELSE 0 END, ?4)`
        ).bind(receiptId, eventId, payloadHash, at)
      ]);
      insert = bridgeResults[0]!;
      if ((insert.meta.changes ?? 0) === 1 && (bridgeResults[1]?.meta.changes ?? 0) !== 1) {
        throw new ApiError(
          409,
          "legacy_generation_bridge_conflict",
          "Legacy provider generation bridge was not recorded atomically."
        );
      }
    } else {
      insert = await insertStatement.run();
    }
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
      `SELECT payload_sha256, status FROM provider_events WHERE event_id = ?1`
    )
      .bind(eventId)
      .first<{ payload_sha256: string; status: ProviderEventRow["status"] }>();
    if (!existing || existing.payload_sha256 !== payloadHash) {
      throw new ApiError(409, "provider_event_replay_mismatch", "Provider event identifier was reused with different data.");
    }
    if (summary.billingGenerationSource === "legacy_unique_binding") {
      const receipt = await env.TEAM_CONTROL_DB.prepare(
        `SELECT valid FROM workflow_integrity_receipts
          WHERE id = ?1 AND workflow_type = 'legacy_billing_generation_bridge_applied'
            AND source_ref = ?2 AND valid = 1`
      )
        .bind(`integrity_legacy_billing_generation_bridge_${eventId}`, eventId)
        .first<{ valid: number }>();
      if (!receipt) {
        throw new ApiError(
          409,
          "legacy_generation_bridge_conflict",
          "Legacy provider generation bridge lacks its exact evidence receipt."
        );
      }
    }
    if (eventType !== "checkout.session.completed" || existing.status !== "ignored") {
      return jsonResponse({ received: true, duplicate: true });
    }
  }

  const [account, eventGeneration] = await Promise.all([
    billingAccount(env.TEAM_CONTROL_DB, summary.orgId),
    billingGeneration(env.TEAM_CONTROL_DB, summary.orgId, summary.billingGeneration)
  ]);
  const belongsToHistoricalGeneration =
    eventType !== "checkout.session.completed" &&
    summary.customerId !== null &&
    summary.subscriptionId !== null &&
    eventGeneration?.provider_customer_id === summary.customerId &&
    eventGeneration.provider_subscription_id === summary.subscriptionId &&
    eventGeneration.internal_price_id === summary.internalPriceId &&
    (account?.billing_generation !== summary.billingGeneration ||
      eventGeneration.status === "terminal_verified" ||
      eventGeneration.status === "retired");
  if (
    eventType !== "checkout.session.completed" &&
    !belongsToHistoricalGeneration &&
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
      `SELECT id, org_id, internal_price_id, billing_generation, status,
              provider_session_id, expires_at
         FROM checkout_intents WHERE id = ?1`
    )
      .bind(summary.checkoutIntentId)
      .first<{
        id: string;
        org_id: string;
        internal_price_id: string;
        billing_generation: number;
        status: string;
        provider_session_id: string | null;
        expires_at: string;
      }>();
    if (
      !checkout ||
      checkout.org_id !== summary.orgId ||
      checkout.internal_price_id !== summary.internalPriceId ||
      checkout.billing_generation !== summary.billingGeneration ||
      eventCreated * 1000 > Date.parse(checkout.expires_at) + SIGNATURE_TOLERANCE_SECONDS * 1000
    ) {
      throw new ApiError(409, "checkout_tenant_mismatch", "Checkout session does not match the prepared tenant intent.");
    }
    const generation = await env.TEAM_CONTROL_DB.prepare(
      `SELECT status, provider_checkout_session_id, provider_customer_id, provider_subscription_id
         FROM billing_generations
        WHERE org_id = ?1 AND generation = ?2 AND checkout_intent_id = ?3`
    )
      .bind(summary.orgId, summary.billingGeneration, summary.checkoutIntentId)
      .first<{
        status: string;
        provider_checkout_session_id: string | null;
        provider_customer_id: string | null;
        provider_subscription_id: string | null;
      }>();
    const exactReportedCheckoutPrice =
      summary.reportedInternalPriceId === summary.internalPriceId &&
      summary.reportedProviderPriceId === summary.providerPriceId;
    const exactGenerationEvidence =
      (summary.billingGenerationSource === "metadata" &&
        summary.reportedBillingGeneration === summary.billingGeneration) ||
      (summary.billingGenerationSource === "legacy_unique_binding" &&
        summary.reportedBillingGeneration === null);
    const expectedCompletion =
      exactGenerationEvidence &&
      exactReportedCheckoutPrice &&
      checkout.status === "provider_created" &&
      checkout.provider_session_id === summary.objectId &&
      generation?.status === "reserved" &&
      generation.provider_checkout_session_id === summary.objectId &&
      generation.provider_customer_id === null &&
      generation.provider_subscription_id === null;
    const alreadyBoundCompletion =
      summary.billingGenerationSource === "metadata" &&
      summary.reportedBillingGeneration === summary.billingGeneration &&
      exactReportedCheckoutPrice &&
      checkout.status === "completed" &&
      checkout.provider_session_id === summary.objectId &&
      generation?.status === "bound" &&
      generation.provider_checkout_session_id === summary.objectId &&
      generation.provider_customer_id === summary.customerId &&
      generation.provider_subscription_id === summary.subscriptionId;
    if (alreadyBoundCompletion) {
      const duplicateReceiptId = `integrity_duplicate_checkout_completion_${eventId}`;
      const duplicateAuditId = newId("audit");
      const duplicateResults = await env.TEAM_CONTROL_DB.batch([
        env.TEAM_CONTROL_DB.prepare(
          `UPDATE provider_events SET status = 'reconciled', reconciled_at = ?1
            WHERE event_id = ?2 AND org_id = ?3 AND event_type = 'checkout.session.completed'
              AND object_id = ?4 AND status = 'ignored'`
        ).bind(at, eventId, summary.orgId, summary.objectId),
        env.TEAM_CONTROL_DB.prepare(
          `INSERT INTO audit_events
            (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
           SELECT ?1, ?2, 'stripe', 'stripe', 'billing.checkout.duplicate_completion',
                  'provider_event', ?3, '{}', ?4
            WHERE EXISTS (
              SELECT 1 FROM provider_events
               WHERE event_id = ?3 AND org_id = ?2 AND status = 'reconciled'
            )`
        ).bind(duplicateAuditId, summary.orgId, eventId, at),
        env.TEAM_CONTROL_DB.prepare(
          `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
           VALUES (?1, 'duplicate_checkout_completion', ?2,
             CASE WHEN
               EXISTS (
                 SELECT 1 FROM provider_events
                  WHERE event_id = ?2 AND org_id = ?3 AND object_id = ?4 AND status = 'reconciled'
               )
               AND EXISTS (
                 SELECT 1 FROM checkout_intents
                  WHERE id = ?5 AND org_id = ?3 AND billing_generation = ?6
                    AND status = 'completed' AND provider_session_id = ?4
               )
               AND EXISTS (
                 SELECT 1 FROM billing_generations
                  WHERE org_id = ?3 AND generation = ?6 AND checkout_intent_id = ?5
                    AND status = 'bound' AND provider_checkout_session_id = ?4
                    AND provider_customer_id = ?7 AND provider_subscription_id = ?8
               )
               AND EXISTS (
                 SELECT 1 FROM audit_events
                  WHERE id = ?9 AND org_id = ?3 AND action = 'billing.checkout.duplicate_completion'
               )
             THEN 1 ELSE 0 END, ?10)`
        ).bind(
          duplicateReceiptId,
          eventId,
          summary.orgId,
          summary.objectId,
          summary.checkoutIntentId,
          summary.billingGeneration,
          summary.customerId,
          summary.subscriptionId,
          duplicateAuditId,
          at
        )
      ]);
      if (duplicateResults.some((result) => (result.meta.changes ?? 0) !== 1)) {
        throw new ApiError(409, "checkout_completion_conflict", "Duplicate Checkout completion was not recorded atomically.");
      }
      return jsonResponse({ received: true, duplicate: true });
    }
    if (!expectedCompletion || organization.status !== "active") {
      await reserveUnexpectedCheckoutCompensation(env, summary, eventId, checkout, at);
      if (organization.status !== "active") {
        throw new ApiError(
          409,
          "checkout_completion_frozen_for_deletion",
          "Checkout completion was reserved for exact subscription cancellation while organization deletion is pending."
        );
      }
      throw new ApiError(
        409,
        "checkout_completion_requires_compensation",
        "Unexpected completed subscription was reserved for exact provider cancellation."
      );
    }
    await rejectProviderTenantCollision(
      env.TEAM_CONTROL_DB,
      summary.orgId,
      summary.customerId,
      summary.subscriptionId
    );
    const previousState = account?.commercial_state ?? "offer_shown";
    let completionResults: D1Result[];
    try {
      completionResults = await env.TEAM_CONTROL_DB.batch([
        env.TEAM_CONTROL_DB.prepare(
          `UPDATE checkout_intents SET status = 'completed', provider_session_id = ?1,
             execution_lease_id = NULL, execution_lease_expires_at = NULL
            WHERE id = ?2 AND org_id = ?3
              AND status = 'provider_created' AND provider_session_id = ?1
              AND EXISTS (SELECT 1 FROM organizations WHERE id = ?3 AND status = 'active')`
        ).bind(summary.objectId, summary.checkoutIntentId, summary.orgId),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE billing_commands SET status = 'confirmed', execution_lease_id = NULL,
             execution_lease_expires_at = NULL
          WHERE org_id = ?1 AND command_type = 'create_checkout_session'
            AND status = 'provider_accepted'
            AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?2
            AND CAST(json_extract(command_json, '$.parameters.metadata.billing_generation') AS INTEGER) = ?4
            AND json_extract(command_json, '$.provider_result.session_id') = ?3
            AND EXISTS (
              SELECT 1 FROM checkout_intents
               WHERE id = ?2 AND org_id = ?1 AND status = 'completed' AND provider_session_id = ?3
            )
            AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'active')`
      ).bind(summary.orgId, summary.checkoutIntentId, summary.objectId, summary.billingGeneration),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE billing_generations
            SET status = 'bound', provider_customer_id = ?1, provider_subscription_id = ?2,
                bound_at = ?3
          WHERE org_id = ?4 AND generation = ?5 AND checkout_intent_id = ?6
            AND status = 'reserved' AND provider_checkout_session_id = ?7
            AND provider_customer_id IS NULL AND provider_subscription_id IS NULL
            AND EXISTS (
              SELECT 1 FROM checkout_intents
               WHERE id = ?6 AND org_id = ?4 AND billing_generation = ?5
                 AND status = 'completed' AND provider_session_id = ?7
            )
            AND EXISTS (
              SELECT 1 FROM billing_commands
               WHERE org_id = ?4 AND command_type = 'create_checkout_session' AND status = 'confirmed'
                 AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?6
                 AND CAST(json_extract(command_json, '$.parameters.metadata.billing_generation') AS INTEGER) = ?5
                 AND json_extract(command_json, '$.provider_result.session_id') = ?7
            )`
      ).bind(
        summary.customerId,
        summary.subscriptionId,
        at,
        summary.orgId,
        summary.billingGeneration,
        summary.checkoutIntentId,
        summary.objectId
      ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generation_events
          (id, org_id, generation, event_type, source_ref, occurred_at)
         SELECT ?1, ?2, ?3, 'bound', ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM billing_generations
             WHERE org_id = ?2 AND generation = ?3 AND checkout_intent_id = ?6
               AND status = 'bound' AND provider_customer_id = ?7 AND provider_subscription_id = ?8
          )`
      ).bind(
        `billing_generation_bound_${eventId}`,
        summary.orgId,
        summary.billingGeneration,
        eventId,
        at,
        summary.checkoutIntentId,
        summary.customerId,
        summary.subscriptionId
      ),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_accounts
          (org_id, provider_customer_id, provider_subscription_id, commercial_state, internal_price_id,
           billing_interval, contributor_limit, billing_generation, updated_at)
         SELECT ?1, ?2, ?3, 'payment_pending', ?4, ?5, 15, ?6, ?7
          WHERE EXISTS (
            SELECT 1 FROM billing_commands
             WHERE org_id = ?1 AND command_type = 'create_checkout_session' AND status = 'confirmed'
               AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?8
               AND CAST(json_extract(command_json, '$.parameters.metadata.billing_generation') AS INTEGER) = ?6
               AND json_extract(command_json, '$.provider_result.session_id') = ?9
          )
            AND EXISTS (
              SELECT 1 FROM checkout_intents
               WHERE id = ?8 AND org_id = ?1 AND billing_generation = ?6
                 AND status = 'completed' AND provider_session_id = ?9
            )
            AND EXISTS (
              SELECT 1 FROM billing_generations
               WHERE org_id = ?1 AND generation = ?6 AND checkout_intent_id = ?8
                 AND status = 'bound' AND provider_customer_id = ?2 AND provider_subscription_id = ?3
            )
            AND EXISTS (SELECT 1 FROM organizations WHERE id = ?1 AND status = 'active')
         ON CONFLICT(org_id) DO UPDATE SET
           provider_customer_id = excluded.provider_customer_id,
           provider_subscription_id = excluded.provider_subscription_id,
           commercial_state = 'payment_pending',
           internal_price_id = excluded.internal_price_id,
           billing_interval = excluded.billing_interval,
           billing_generation = excluded.billing_generation,
           updated_at = excluded.updated_at`
      ).bind(
        summary.orgId,
        summary.customerId,
        summary.subscriptionId,
        summary.internalPriceId,
        TEAM_PRICES[summary.internalPriceId].interval,
        summary.billingGeneration,
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
      ).bind(newId("audit"), summary.orgId, eventId, at, summary.customerId, summary.subscriptionId),
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE provider_events SET status = 'reconciled', reconciled_at = ?1
          WHERE event_id = ?2 AND org_id = ?3 AND event_type = 'checkout.session.completed'
            AND object_id = ?4 AND status = 'ignored'`
      ).bind(at, eventId, summary.orgId, summary.objectId),
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
         VALUES (?1, 'billing_generation_bound', ?2,
           CASE WHEN
             EXISTS (
               SELECT 1 FROM checkout_intents
                WHERE id = ?3 AND org_id = ?4 AND billing_generation = ?5
                  AND status = 'completed' AND provider_session_id = ?6
             )
             AND EXISTS (
               SELECT 1 FROM billing_commands
                WHERE org_id = ?4 AND command_type = 'create_checkout_session' AND status = 'confirmed'
                  AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') = ?3
                  AND CAST(json_extract(command_json, '$.parameters.metadata.billing_generation') AS INTEGER) = ?5
                  AND json_extract(command_json, '$.provider_result.session_id') = ?6
             )
             AND EXISTS (
               SELECT 1 FROM billing_generations
                WHERE org_id = ?4 AND generation = ?5 AND checkout_intent_id = ?3
                  AND status = 'bound' AND provider_checkout_session_id = ?6
                  AND provider_customer_id = ?7 AND provider_subscription_id = ?8
             )
             AND EXISTS (
               SELECT 1 FROM billing_generation_events
                WHERE org_id = ?4 AND generation = ?5 AND event_type = 'bound' AND source_ref = ?2
             )
             AND EXISTS (
               SELECT 1 FROM billing_accounts
                WHERE org_id = ?4 AND billing_generation = ?5
                  AND provider_customer_id = ?7 AND provider_subscription_id = ?8
                  AND commercial_state = 'payment_pending'
             )
             AND EXISTS (
               SELECT 1 FROM provider_events
                WHERE event_id = ?2 AND org_id = ?4 AND status = 'reconciled'
             )
           THEN 1 ELSE 0 END, ?9)`
      ).bind(
        `integrity_billing_generation_bound_${eventId}`,
        eventId,
        summary.checkoutIntentId,
        summary.orgId,
        summary.billingGeneration,
        summary.objectId,
        summary.customerId,
        summary.subscriptionId,
        at
      )
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
        await reserveUnexpectedCheckoutCompensation(env, summary, eventId, checkout, at);
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
        await reserveUnexpectedCheckoutCompensation(env, summary, eventId, checkout, at);
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
    "billing_generation",
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
    billingGeneration: requireInteger(body.billing_generation, "billing_generation", { min: 1, max: 2_147_483_647 }),
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

async function rejectLateBillingGeneration(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow,
  payloadHash: string
): Promise<void> {
  const at = nowIso();
  const generationEventId = newId("billing_generation_event");
  const receiptId = newId("integrity");
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO provider_reconciliation_snapshots
        (reconciliation_id, source_event_id, org_id, snapshot_kind, payload_sha256, observed_at, applied_at, result)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'stale')`
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
      `UPDATE provider_events SET status = 'stale'
        WHERE event_id = ?1 AND org_id = ?2 AND status = 'awaiting_reconciliation'`
    ).bind(event.event_id, snapshot.orgId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_generation_events
        (id, org_id, generation, event_type, source_ref, occurred_at)
       SELECT ?1, ?2, ?3, 'late_provider_event_ignored', ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM billing_generations
           WHERE org_id = ?2 AND generation = ?3 AND provider_customer_id = ?6
             AND provider_subscription_id = ?7
        )`
    ).bind(
      generationEventId,
      snapshot.orgId,
      snapshot.billingGeneration,
      event.event_id,
      at,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId
    ),
    auditStatement(env.TEAM_CONTROL_DB, {
      orgId: snapshot.orgId,
      actorType: "reconciler",
      actorId: "stripe-readonly-adapter",
      action: "billing.generation.late_provider_event_ignored",
      resourceType: "provider_event",
      resourceId: event.event_id,
      metadata: { billing_generation: snapshot.billingGeneration },
      at
    }),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'late_billing_generation_rejected', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM provider_reconciliation_snapshots
              WHERE reconciliation_id = ?3 AND source_event_id = ?2 AND result = 'stale'
           )
           AND EXISTS (
             SELECT 1 FROM provider_events WHERE event_id = ?2 AND status = 'stale'
           )
           AND EXISTS (
             SELECT 1 FROM billing_generation_events
              WHERE id = ?4 AND org_id = ?5 AND generation = ?6
                AND event_type = 'late_provider_event_ignored' AND source_ref = ?2
           )
         THEN 1 ELSE 0 END, ?7)`
    ).bind(
      receiptId,
      event.event_id,
      snapshot.reconciliationId,
      generationEventId,
      snapshot.orgId,
      snapshot.billingGeneration,
      at
    )
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ApiError(409, "late_generation_record_conflict", "Late provider generation could not be recorded atomically.");
  }
}

async function applyHistoricalRefund(
  env: Env,
  snapshot: ReconciliationSnapshot,
  event: ProviderEventRow,
  payloadHash: string
): Promise<void> {
  if (
    !snapshot.providerRefundId ||
    !snapshot.providerChargeId ||
    !snapshot.providerPaymentIntentId ||
    !snapshot.sourcePaymentEventId
  ) {
    throw new ApiError(400, "invalid_refund_snapshot", "Historical refund reconciliation lacks its exact provider binding.");
  }
  const [sourcePayment, bookedRefunds, currentAccount, currentEntitlement, currentCursor] = await Promise.all([
    env.TEAM_CONTROL_DB.prepare(
      `SELECT c.amount_cents, pe.summary_json
         FROM cash_ledger c
         JOIN provider_events pe ON pe.event_id = c.source_event_id
        WHERE c.org_id = ?1 AND c.source_event_id = ?2 AND c.entry_type = 'payment'
          AND pe.org_id = ?1 AND pe.event_type = 'invoice.paid' AND pe.status = 'reconciled'`
    )
      .bind(snapshot.orgId, snapshot.sourcePaymentEventId)
      .first<{ amount_cents: number; summary_json: string }>(),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total,
              COALESCE(MAX(cumulative_amount_cents), 0) AS max_cumulative
         FROM provider_refund_applications
        WHERE org_id = ?1 AND source_payment_event_id = ?2`
    )
      .bind(snapshot.orgId, snapshot.sourcePaymentEventId)
      .first<{ total: number; max_cumulative: number }>(),
    billingAccount(env.TEAM_CONTROL_DB, snapshot.orgId),
    getEntitlement(env.TEAM_CONTROL_DB, snapshot.orgId),
    env.TEAM_CONTROL_DB.prepare(
      `SELECT event_created, event_id, reconciliation_id, status
         FROM provider_state_cursors WHERE org_id = ?1`
    )
      .bind(snapshot.orgId)
      .first<{ event_created: number; event_id: string; reconciliation_id: string; status: "claimed" | "applied" }>()
  ]);
  let sourceSummary: StripeSummary | null = null;
  try {
    sourceSummary = sourcePayment ? (JSON.parse(sourcePayment.summary_json) as StripeSummary) : null;
  } catch {
    sourceSummary = null;
  }
  const nextBookedTotal = (bookedRefunds?.total ?? 0) + snapshot.refundAmountCents;
  const greatestCumulative = Math.max(bookedRefunds?.max_cumulative ?? 0, snapshot.cumulativeRefundAmountCents);
  if (
    !sourcePayment ||
    !sourceSummary ||
    sourceSummary.orgId !== snapshot.orgId ||
    sourceSummary.customerId !== snapshot.providerCustomerId ||
    sourceSummary.subscriptionId !== snapshot.providerSubscriptionId ||
    sourceSummary.internalPriceId !== snapshot.internalPriceId ||
    sourceSummary.billingGeneration !== snapshot.billingGeneration ||
    snapshot.cumulativeRefundAmountCents > sourcePayment.amount_cents ||
    nextBookedTotal > sourcePayment.amount_cents ||
    nextBookedTotal > greatestCumulative
  ) {
    await rejectSnapshot(env, snapshot, event, payloadHash, "rejected");
    throw new ApiError(
      409,
      "historical_refund_binding_conflict",
      "Historical refund does not fit its exact retired generation and source payment."
    );
  }

  const adjustment = recognizedMrrMicros(snapshot.netRecurringAmountCents, snapshot.internalPriceId);
  const at = nowIso();
  const cashId = `cash_historical_refund_${event.event_id}`;
  const revenueId = `revenue_historical_refund_${event.event_id}`;
  const generationEventId = `billing_generation_historical_refund_${event.event_id}`;
  const lifecycleId = `life_historical_refund_${event.event_id}`;
  const auditId = `audit_historical_refund_${event.event_id}`;
  const receiptId = `integrity_historical_refund_${event.event_id}`;
  const results = await env.TEAM_CONTROL_DB.batch([
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO provider_reconciliation_snapshots
        (reconciliation_id, source_event_id, org_id, snapshot_kind, payload_sha256, observed_at, applied_at, result)
       VALUES (?1, ?2, ?3, 'refund', ?4, ?5, ?6, 'applied')`
    ).bind(
      snapshot.reconciliationId,
      event.event_id,
      snapshot.orgId,
      payloadHash,
      snapshot.observedAt,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE provider_events SET status = 'reconciled', reconciled_at = ?1
        WHERE event_id = ?2 AND org_id = ?3 AND status = 'awaiting_reconciliation'`
    ).bind(at, event.event_id, snapshot.orgId),
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
      `INSERT INTO cash_ledger
        (id, org_id, source_event_id, entry_type, amount_cents, currency, occurred_at)
       VALUES (?1, ?2, ?3, 'refund', ?4, 'usd', ?5)`
    ).bind(cashId, snapshot.orgId, event.event_id, -snapshot.refundAmountCents, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO revenue_ledger
        (id, org_id, source_event_id, entry_type, recognized_mrr_delta_micros, currency,
         recognized_period_start, recognized_period_end, occurred_at)
       VALUES (?1, ?2, ?3, 'mrr_refund_adjustment', ?4, 'usd', ?5, ?6, ?7)`
    ).bind(revenueId, snapshot.orgId, event.event_id, -adjustment, snapshot.periodStart, snapshot.periodEnd, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_generation_events
        (id, org_id, generation, event_type, source_ref, occurred_at)
       SELECT ?1, ?2, ?3, 'historical_refund_applied', ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM billing_generations
           WHERE org_id = ?2 AND generation = ?3 AND status IN ('terminal_verified', 'retired')
             AND provider_customer_id = ?6 AND provider_subscription_id = ?7
             AND internal_price_id = ?8
        )`
    ).bind(
      generationEventId,
      snapshot.orgId,
      snapshot.billingGeneration,
      event.event_id,
      at,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      snapshot.internalPriceId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO lifecycle_events
        (event_id, org_id, event_name, source_ref, event_day, created_at)
       VALUES (?1, ?2, 'refund_issued_v1', ?3, ?4, ?5)`
    ).bind(lifecycleId, snapshot.orgId, event.event_id, at.slice(0, 10), at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       VALUES (?1, ?2, 'reconciler', 'stripe-readonly-adapter', 'billing.refund.historical_confirmed',
               'provider_event', ?3, ?4, ?5)`
    ).bind(
      auditId,
      snapshot.orgId,
      event.event_id,
      JSON.stringify({ amount_cents: snapshot.refundAmountCents, billing_generation: snapshot.billingGeneration }),
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'historical_billing_refund_reconciled', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM provider_reconciliation_snapshots
              WHERE reconciliation_id = ?3 AND source_event_id = ?2 AND org_id = ?4
                AND snapshot_kind = 'refund' AND result = 'applied'
           )
           AND EXISTS (
             SELECT 1 FROM provider_events
              WHERE event_id = ?2 AND org_id = ?4 AND status = 'reconciled'
           )
           AND EXISTS (
             SELECT 1 FROM billing_generations
              WHERE org_id = ?4 AND generation = ?5 AND status IN ('terminal_verified', 'retired')
                AND provider_customer_id = ?6 AND provider_subscription_id = ?7
                AND internal_price_id = ?8
           )
           AND EXISTS (
             SELECT 1 FROM provider_refund_applications
              WHERE provider_refund_id = ?9 AND org_id = ?4 AND billing_command_id IS ?15
                AND source_payment_event_id = ?10 AND source_refund_event_id = ?2
                AND provider_charge_id = ?11 AND provider_payment_intent_id = ?12
                AND amount_cents = ?13 AND cumulative_amount_cents = ?14
           )
           AND (
             (?15 IS NULL AND EXISTS (
               SELECT 1 FROM billing_commands
                WHERE org_id = ?4 AND command_type = 'request_refund'
                  AND status IN ('provider_accepted', 'confirmed')
                  AND json_extract(command_json, '$.provider_result.charge_id') = ?11
                  AND json_extract(command_json, '$.provider_result.payment_intent_id') = ?12
                  AND json_extract(command_json, '$.provider_result.source_payment_event_id') = ?10
             )) OR EXISTS (
               SELECT 1 FROM billing_commands
                WHERE id = ?15 AND org_id = ?4 AND status = 'confirmed'
             )
           )
           AND EXISTS (
             SELECT 1 FROM cash_ledger payment
             JOIN provider_events source ON source.event_id = payment.source_event_id
              WHERE payment.org_id = ?4 AND payment.source_event_id = ?10
                AND payment.entry_type = 'payment' AND payment.amount_cents = ?16
                AND source.status = 'reconciled'
                AND CAST(json_extract(source.summary_json, '$.billingGeneration') AS INTEGER) = ?5
                AND json_extract(source.summary_json, '$.customerId') = ?6
                AND json_extract(source.summary_json, '$.subscriptionId') = ?7
                AND json_extract(source.summary_json, '$.internalPriceId') = ?8
           )
           AND EXISTS (
             SELECT 1 FROM cash_ledger
              WHERE id = ?17 AND org_id = ?4 AND source_event_id = ?2
                AND entry_type = 'refund' AND amount_cents = -?13
           )
           AND EXISTS (
             SELECT 1 FROM revenue_ledger
              WHERE id = ?18 AND org_id = ?4 AND source_event_id = ?2
                AND entry_type = 'mrr_refund_adjustment'
                AND recognized_mrr_delta_micros = ?19
           )
           AND EXISTS (
             SELECT 1 FROM billing_generation_events
              WHERE id = ?20 AND org_id = ?4 AND generation = ?5
                AND event_type = 'historical_refund_applied' AND source_ref = ?2
           )
           AND EXISTS (
             SELECT 1 FROM lifecycle_events
              WHERE event_id = ?21 AND org_id = ?4 AND event_name = 'refund_issued_v1' AND source_ref = ?2
           )
           AND EXISTS (
             SELECT 1 FROM audit_events
              WHERE id = ?22 AND org_id = ?4 AND action = 'billing.refund.historical_confirmed'
                AND resource_id = ?2
           )
           AND (
             (?23 = 0 AND NOT EXISTS (SELECT 1 FROM billing_accounts WHERE org_id = ?4)) OR
             (?23 = 1 AND EXISTS (
               SELECT 1 FROM billing_accounts
                WHERE org_id = ?4 AND billing_generation = ?24
                  AND provider_customer_id IS ?25 AND provider_subscription_id IS ?26
                  AND commercial_state = ?27 AND current_recognized_mrr_micros = ?28
                  AND last_reconciled_event_id IS ?29
             ))
           )
           AND (
             (?30 = 0 AND NOT EXISTS (SELECT 1 FROM entitlements WHERE org_id = ?4)) OR
             (?30 = 1 AND EXISTS (
               SELECT 1 FROM entitlements
                WHERE org_id = ?4 AND status = ?31 AND source_event_id = ?32
             ))
           )
           AND (
             (?33 = 0 AND NOT EXISTS (SELECT 1 FROM provider_state_cursors WHERE org_id = ?4)) OR
             (?33 = 1 AND EXISTS (
               SELECT 1 FROM provider_state_cursors
                WHERE org_id = ?4 AND event_created = ?34 AND event_id = ?35
                  AND reconciliation_id = ?36 AND status = ?37
             ))
           )
         THEN 1 ELSE 0 END, ?38)`
    ).bind(
      receiptId,
      event.event_id,
      snapshot.reconciliationId,
      snapshot.orgId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      snapshot.internalPriceId,
      snapshot.providerRefundId,
      snapshot.sourcePaymentEventId,
      snapshot.providerChargeId,
      snapshot.providerPaymentIntentId,
      snapshot.refundAmountCents,
      snapshot.cumulativeRefundAmountCents,
      snapshot.billingCommandId,
      sourcePayment.amount_cents,
      cashId,
      revenueId,
      -adjustment,
      generationEventId,
      lifecycleId,
      auditId,
      currentAccount ? 1 : 0,
      currentAccount?.billing_generation ?? null,
      currentAccount?.provider_customer_id ?? null,
      currentAccount?.provider_subscription_id ?? null,
      currentAccount?.commercial_state ?? null,
      currentAccount?.current_recognized_mrr_micros ?? null,
      currentAccount?.last_reconciled_event_id ?? null,
      currentEntitlement ? 1 : 0,
      currentEntitlement?.status ?? null,
      currentEntitlement?.source_event_id ?? null,
      currentCursor ? 1 : 0,
      currentCursor?.event_created ?? null,
      currentCursor?.event_id ?? null,
      currentCursor?.reconciliation_id ?? null,
      currentCursor?.status ?? null,
      at
    )
  ]);
  const expectedCommandChanges = snapshot.billingCommandId === null ? 0 : 1;
  if (results.some((result, index) => (result.meta.changes ?? 0) !== (index === 3 ? expectedCommandChanges : 1))) {
    throw new ApiError(
      409,
      "historical_refund_binding_conflict",
      "Historical refund lost its exact immutable generation or projection binding."
    );
  }
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
    summary.billingGeneration !== snapshot.billingGeneration ||
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
  const [account, generation] = await Promise.all([
    billingAccount(env.TEAM_CONTROL_DB, snapshot.orgId),
    billingGeneration(env.TEAM_CONTROL_DB, snapshot.orgId, snapshot.billingGeneration)
  ]);
  if (
    !generation ||
    generation.internal_price_id !== snapshot.internalPriceId ||
    generation.provider_customer_id !== snapshot.providerCustomerId ||
    generation.provider_subscription_id !== snapshot.providerSubscriptionId
  ) {
    await rejectSnapshot(env, snapshot, event, payloadHash, "rejected");
    throw new ApiError(409, "billing_generation_mismatch", "Reconciliation does not match an immutable billing generation.");
  }
  await rejectProviderTenantCollision(
    env.TEAM_CONTROL_DB,
    snapshot.orgId,
    snapshot.providerCustomerId,
    snapshot.providerSubscriptionId
  );
  if (snapshot.kind === "refund" && (generation.status === "terminal_verified" || generation.status === "retired")) {
    await applyHistoricalRefund(env, snapshot, event, payloadHash);
    return jsonResponse({ reconciled: true, source_event_id: event.event_id, historical_generation: true });
  }
  if (
    !account ||
    account.billing_generation !== snapshot.billingGeneration ||
    generation.status === "terminal_verified" ||
    generation.status === "retired"
  ) {
    await rejectLateBillingGeneration(env, snapshot, event, payloadHash);
    throw new ApiError(409, "retired_billing_generation", "A retired or superseded billing generation cannot change current state.");
  }
  if (
    generation.status !== "bound" ||
    account.provider_customer_id !== snapshot.providerCustomerId ||
    account.provider_subscription_id !== snapshot.providerSubscriptionId ||
    account.internal_price_id !== snapshot.internalPriceId
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
      `UPDATE provider_events SET status = 'reconciled', reconciled_at = ?1
        WHERE event_id = ?2 AND status = 'awaiting_reconciliation'`
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
  const cashId = newId("cash");
  const revenueId = newId("revenue");
  const paidTransitionId = newId("transition");
  const finalTransitionId = newId("transition");
  const paymentLifecycleId = newId("life");
  const entitlementLifecycleId = newId("life");
  const auditId = newId("audit");
  const receiptId = newId("integrity");
  const statements = reconciliationBaseStatements(env, snapshot, event, payloadHash, at);
  statements.push(
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO billing_accounts
        (org_id, provider_customer_id, provider_subscription_id, commercial_state, internal_price_id,
         billing_interval, contributor_limit, billing_generation, current_period_start, current_period_end,
         cancel_at_period_end, current_recognized_mrr_micros, last_reconciled_event_created,
         last_reconciled_event_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 15, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(org_id) DO UPDATE SET
         provider_customer_id = excluded.provider_customer_id,
         provider_subscription_id = excluded.provider_subscription_id,
         commercial_state = excluded.commercial_state,
         internal_price_id = excluded.internal_price_id,
         billing_interval = excluded.billing_interval,
         billing_generation = excluded.billing_generation,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         current_recognized_mrr_micros = excluded.current_recognized_mrr_micros,
         last_reconciled_event_created = excluded.last_reconciled_event_created,
         last_reconciled_event_id = excluded.last_reconciled_event_id,
         updated_at = excluded.updated_at
       WHERE billing_accounts.billing_generation = excluded.billing_generation
         AND billing_accounts.provider_customer_id = excluded.provider_customer_id
         AND billing_accounts.provider_subscription_id = excluded.provider_subscription_id`
    ).bind(
      snapshot.orgId,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      finalState,
      snapshot.internalPriceId,
      TEAM_PRICES[snapshot.internalPriceId].interval,
      snapshot.billingGeneration,
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
    ).bind(cashId, snapshot.orgId, event.event_id, snapshot.cashAmountCents, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO revenue_ledger
        (id, org_id, source_event_id, entry_type, recognized_mrr_delta_micros, currency,
         recognized_period_start, recognized_period_end, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'usd', ?6, ?7, ?8)`
    ).bind(
      revenueId,
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
    ).bind(paidTransitionId, snapshot.orgId, previousState, event.event_id, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO commercial_transitions
        (id, org_id, from_state, to_state, source, source_ref, occurred_at)
       VALUES (?1, ?2, 'paid', ?3, 'provider_reconciliation', ?4, ?5)`
    ).bind(finalTransitionId, snapshot.orgId, finalState, event.event_id, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO lifecycle_events
        (event_id, org_id, event_name, source_ref, event_day, created_at)
       VALUES (?1, ?2, 'payment_succeeded_v1', ?3, ?4, ?5)`
    ).bind(paymentLifecycleId, snapshot.orgId, event.event_id, at.slice(0, 10), at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO lifecycle_events
        (event_id, org_id, event_name, source_ref, event_day, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      entitlementLifecycleId,
      snapshot.orgId,
      renewal ? "subscription_renewed_v1" : "entitlement_activated_v1",
      event.event_id,
      at.slice(0, 10),
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       VALUES (?1, ?2, 'reconciler', 'stripe-readonly-adapter', ?3,
               'provider_event', ?4, ?5, ?6)`
    ).bind(
      auditId,
      snapshot.orgId,
      renewal ? "billing.subscription.renewed" : "billing.entitlement.activated",
      event.event_id,
      JSON.stringify({ internal_price_id: snapshot.internalPriceId }),
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'billing_payment_reconciled', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM provider_reconciliation_snapshots
              WHERE reconciliation_id = ?3 AND source_event_id = ?2 AND result = 'applied'
           )
           AND EXISTS (
             SELECT 1 FROM provider_events
              WHERE event_id = ?2 AND org_id = ?4 AND status = 'reconciled'
           )
           AND EXISTS (
             SELECT 1 FROM provider_state_cursors
              WHERE org_id = ?4 AND event_id = ?2 AND reconciliation_id = ?3 AND status = 'applied'
           )
           AND EXISTS (
             SELECT 1 FROM billing_accounts
              WHERE org_id = ?4 AND billing_generation = ?5
                AND provider_customer_id = ?6 AND provider_subscription_id = ?7
                AND commercial_state = ?8 AND current_recognized_mrr_micros = ?9
                AND last_reconciled_event_id = ?2
           )
           AND EXISTS (
             SELECT 1 FROM entitlements
              WHERE org_id = ?4 AND status = 'active' AND source_event_id = ?2
           )
           AND EXISTS (
             SELECT 1 FROM cash_ledger
              WHERE id = ?10 AND org_id = ?4 AND source_event_id = ?2
                AND entry_type = 'payment' AND amount_cents = ?11
           )
           AND EXISTS (
             SELECT 1 FROM revenue_ledger
              WHERE id = ?12 AND org_id = ?4 AND source_event_id = ?2
                AND entry_type = ?13 AND recognized_mrr_delta_micros = ?14
           )
           AND EXISTS (
             SELECT 1 FROM commercial_transitions
              WHERE id = ?15 AND org_id = ?4 AND source_ref = ?2 AND to_state = 'paid'
           )
           AND EXISTS (
             SELECT 1 FROM commercial_transitions
              WHERE id = ?16 AND org_id = ?4 AND source_ref = ?2 AND to_state = ?8
           )
           AND EXISTS (
             SELECT 1 FROM lifecycle_events
              WHERE event_id = ?17 AND org_id = ?4 AND source_ref = ?2
                AND event_name = 'payment_succeeded_v1'
           )
           AND EXISTS (
             SELECT 1 FROM lifecycle_events
              WHERE event_id = ?18 AND org_id = ?4 AND source_ref = ?2
                AND event_name = ?19
           )
           AND EXISTS (
             SELECT 1 FROM audit_events
              WHERE id = ?20 AND org_id = ?4 AND resource_id = ?2 AND action = ?21
           )
         THEN 1 ELSE 0 END, ?22)`
    ).bind(
      receiptId,
      event.event_id,
      snapshot.reconciliationId,
      snapshot.orgId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      finalState,
      mrr,
      cashId,
      snapshot.cashAmountCents,
      revenueId,
      renewal ? "mrr_renewed" : "mrr_started",
      mrr - previousMrr,
      paidTransitionId,
      finalTransitionId,
      paymentLifecycleId,
      entitlementLifecycleId,
      renewal ? "subscription_renewed_v1" : "entitlement_activated_v1",
      auditId,
      renewal ? "billing.subscription.renewed" : "billing.entitlement.activated",
      at
    )
  );
  const results = await env.TEAM_CONTROL_DB.batch(statements);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ApiError(409, "payment_reconciliation_conflict", "Payment reconciliation lost its exact generation binding.");
  }
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
  const transitionId = newId("transition");
  const lifecycleId = newId("life");
  const auditId = newId("audit");
  const receiptId = newId("integrity");
  const statements = reconciliationBaseStatements(env, snapshot, event, payloadHash, at);
  statements.push(
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE billing_accounts SET commercial_state = 'past_due', grace_until = ?1,
        last_reconciled_event_created = ?2, last_reconciled_event_id = ?3, updated_at = ?4
       WHERE org_id = ?5 AND billing_generation = ?6
         AND provider_customer_id = ?7 AND provider_subscription_id = ?8
         AND internal_price_id = ?9
         AND EXISTS (
           SELECT 1 FROM billing_generations
            WHERE org_id = ?5 AND generation = ?6 AND status = 'bound'
              AND provider_customer_id = ?7 AND provider_subscription_id = ?8
              AND internal_price_id = ?9
         )`
    ).bind(
      graceUntil,
      event.event_created,
      event.event_id,
      at,
      snapshot.orgId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      snapshot.internalPriceId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE entitlements SET status = 'grace', grace_until = ?1, source_event_id = ?2, updated_at = ?3
       WHERE org_id = ?4
         AND EXISTS (
           SELECT 1 FROM billing_accounts
            WHERE org_id = ?4 AND billing_generation = ?5
              AND provider_customer_id = ?6 AND provider_subscription_id = ?7
              AND internal_price_id = ?8 AND commercial_state = 'past_due'
              AND last_reconciled_event_id = ?2
         )`
    ).bind(
      graceUntil,
      event.event_id,
      at,
      snapshot.orgId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      snapshot.internalPriceId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO commercial_transitions
        (id, org_id, from_state, to_state, source, source_ref, occurred_at)
       SELECT ?1, ?2, ?3, 'past_due', 'provider_reconciliation', ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM billing_accounts
           WHERE org_id = ?2 AND billing_generation = ?6
             AND provider_customer_id = ?7 AND provider_subscription_id = ?8
             AND commercial_state = 'past_due' AND last_reconciled_event_id = ?4
        )`
    ).bind(
      transitionId,
      snapshot.orgId,
      account.commercial_state,
      event.event_id,
      at,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO lifecycle_events
        (event_id, org_id, event_name, source_ref, event_day, created_at)
       SELECT ?1, ?2, 'payment_failed_v1', ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM billing_accounts
           WHERE org_id = ?2 AND billing_generation = ?6
             AND provider_customer_id = ?7 AND provider_subscription_id = ?8
             AND commercial_state = 'past_due' AND last_reconciled_event_id = ?3
        )`
    ).bind(
      lifecycleId,
      snapshot.orgId,
      event.event_id,
      at.slice(0, 10),
      at,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'reconciler', 'stripe-readonly-adapter', 'billing.payment.failed',
              'provider_event', ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM billing_accounts
           WHERE org_id = ?2 AND billing_generation = ?6
             AND provider_customer_id = ?7 AND provider_subscription_id = ?8
             AND commercial_state = 'past_due' AND last_reconciled_event_id = ?3
        )`
    ).bind(
      auditId,
      snapshot.orgId,
      event.event_id,
      JSON.stringify({ grace_until: graceUntil }),
      at,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'payment_failure_reconciliation', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM provider_reconciliation_snapshots
              WHERE reconciliation_id = ?3 AND source_event_id = ?2 AND org_id = ?4
                AND snapshot_kind = 'payment_failure' AND result = 'applied'
           )
           AND EXISTS (
             SELECT 1 FROM provider_events
              WHERE event_id = ?2 AND org_id = ?4 AND status = 'reconciled'
           )
           AND EXISTS (
             SELECT 1 FROM provider_state_cursors
              WHERE org_id = ?4 AND event_id = ?2 AND reconciliation_id = ?3 AND status = 'applied'
           )
           AND EXISTS (
             SELECT 1 FROM billing_accounts
              WHERE org_id = ?4 AND billing_generation = ?5
                AND provider_customer_id = ?6 AND provider_subscription_id = ?7
                AND internal_price_id = ?8 AND commercial_state = 'past_due'
                AND grace_until = ?9 AND last_reconciled_event_id = ?2
           )
           AND EXISTS (
             SELECT 1 FROM entitlements
              WHERE org_id = ?4 AND status = 'grace' AND grace_until = ?9 AND source_event_id = ?2
           )
           AND EXISTS (
             SELECT 1 FROM commercial_transitions
              WHERE id = ?10 AND org_id = ?4 AND to_state = 'past_due' AND source_ref = ?2
           )
           AND EXISTS (
             SELECT 1 FROM lifecycle_events
              WHERE event_id = ?11 AND org_id = ?4 AND event_name = 'payment_failed_v1' AND source_ref = ?2
           )
           AND EXISTS (
             SELECT 1 FROM audit_events
              WHERE id = ?12 AND org_id = ?4 AND action = 'billing.payment.failed' AND resource_id = ?2
           )
         THEN 1 ELSE 0 END, ?13)`
    ).bind(
      receiptId,
      event.event_id,
      snapshot.reconciliationId,
      snapshot.orgId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      snapshot.internalPriceId,
      graceUntil,
      transitionId,
      lifecycleId,
      auditId,
      at
    )
  );
  const results = await env.TEAM_CONTROL_DB.batch(statements);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ApiError(409, "payment_failure_reconciliation_conflict", "Payment failure lost its exact generation binding.");
  }
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
  const expectedMrr = fullyRefunded ? 0 : Math.max(0, account.current_recognized_mrr_micros - adjustment);
  const cashId = newId("cash");
  const revenueId = newId("revenue");
  const transitionId = newId("transition");
  const lifecycleId = newId("life");
  const auditId = newId("audit");
  const receiptId = newId("integrity");
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
       WHERE org_id = ?7 AND billing_generation = ?8
         AND provider_customer_id = ?9 AND provider_subscription_id = ?10`
    ).bind(
      fullyRefunded ? "refunded" : account.commercial_state,
      fullyRefunded ? 1 : 0,
      adjustment,
      event.event_created,
      event.event_id,
      at,
      snapshot.orgId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId
    ),
    env.TEAM_CONTROL_DB.prepare(
      `UPDATE entitlements SET status = ?1, source_event_id = ?2, updated_at = ?3 WHERE org_id = ?4`
    ).bind(fullyRefunded ? "refunded" : "active", event.event_id, at, snapshot.orgId),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO cash_ledger
        (id, org_id, source_event_id, entry_type, amount_cents, currency, occurred_at)
       VALUES (?1, ?2, ?3, 'refund', ?4, 'usd', ?5)`
    ).bind(cashId, snapshot.orgId, event.event_id, -snapshot.refundAmountCents, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO revenue_ledger
        (id, org_id, source_event_id, entry_type, recognized_mrr_delta_micros, currency,
         recognized_period_start, recognized_period_end, occurred_at)
       VALUES (?1, ?2, ?3, 'mrr_refund_adjustment', ?4, 'usd', ?5, ?6, ?7)`
    ).bind(revenueId, snapshot.orgId, event.event_id, -adjustment, snapshot.periodStart, snapshot.periodEnd, at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO commercial_transitions
        (id, org_id, from_state, to_state, source, source_ref, occurred_at)
       VALUES (?1, ?2, ?3, ?4, 'provider_reconciliation', ?5, ?6)`
    ).bind(
      transitionId,
      snapshot.orgId,
      account.commercial_state,
      fullyRefunded ? "refunded" : account.commercial_state,
      event.event_id,
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO lifecycle_events
        (event_id, org_id, event_name, source_ref, event_day, created_at)
       VALUES (?1, ?2, 'refund_issued_v1', ?3, ?4, ?5)`
    ).bind(lifecycleId, snapshot.orgId, event.event_id, at.slice(0, 10), at),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       VALUES (?1, ?2, 'reconciler', 'stripe-readonly-adapter', 'billing.refund.confirmed',
               'provider_event', ?3, ?4, ?5)`
    ).bind(
      auditId,
      snapshot.orgId,
      event.event_id,
      JSON.stringify({ amount_cents: snapshot.refundAmountCents, full: fullyRefunded }),
      at
    ),
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'billing_refund_reconciled', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM provider_reconciliation_snapshots
              WHERE reconciliation_id = ?3 AND source_event_id = ?2 AND result = 'applied'
           )
           AND EXISTS (
             SELECT 1 FROM provider_events
              WHERE event_id = ?2 AND org_id = ?4 AND status = 'reconciled'
           )
           AND EXISTS (
             SELECT 1 FROM provider_refund_applications
              WHERE provider_refund_id = ?5 AND org_id = ?4
                AND source_refund_event_id = ?2 AND source_payment_event_id = ?6
                AND amount_cents = ?7 AND cumulative_amount_cents = ?8
           )
           AND (
             (?9 IS NULL AND NOT EXISTS (
               SELECT 1 FROM provider_refund_applications
                WHERE provider_refund_id = ?5 AND billing_command_id IS NOT NULL
             )) OR EXISTS (
               SELECT 1 FROM billing_commands
                WHERE id = ?9 AND org_id = ?4 AND status = 'confirmed'
             )
           )
           AND EXISTS (
             SELECT 1 FROM billing_accounts
              WHERE org_id = ?4 AND billing_generation = ?10
                AND provider_customer_id = ?11 AND provider_subscription_id = ?12
                AND commercial_state = ?13 AND current_recognized_mrr_micros = ?14
                AND last_reconciled_event_id = ?2
           )
           AND EXISTS (
             SELECT 1 FROM billing_generations
              WHERE org_id = ?4 AND generation = ?10 AND status = 'bound'
                AND provider_customer_id = ?11 AND provider_subscription_id = ?12
           )
           AND EXISTS (
             SELECT 1 FROM entitlements
              WHERE org_id = ?4 AND status = ?15 AND source_event_id = ?2
           )
           AND EXISTS (
             SELECT 1 FROM cash_ledger
              WHERE id = ?16 AND org_id = ?4 AND source_event_id = ?2
                AND entry_type = 'refund' AND amount_cents = ?17
           )
           AND EXISTS (
             SELECT 1 FROM revenue_ledger
              WHERE id = ?18 AND org_id = ?4 AND source_event_id = ?2
                AND entry_type = 'mrr_refund_adjustment'
                AND recognized_mrr_delta_micros = ?19
           )
           AND EXISTS (
             SELECT 1 FROM commercial_transitions
              WHERE id = ?20 AND org_id = ?4 AND source_ref = ?2 AND to_state = ?13
           )
           AND EXISTS (
             SELECT 1 FROM lifecycle_events
              WHERE event_id = ?21 AND org_id = ?4 AND source_ref = ?2
                AND event_name = 'refund_issued_v1'
           )
           AND EXISTS (
             SELECT 1 FROM audit_events
              WHERE id = ?22 AND org_id = ?4 AND resource_id = ?2
                AND action = 'billing.refund.confirmed'
           )
         THEN 1 ELSE 0 END, ?23)`
    ).bind(
      receiptId,
      event.event_id,
      snapshot.reconciliationId,
      snapshot.orgId,
      snapshot.providerRefundId,
      snapshot.sourcePaymentEventId,
      snapshot.refundAmountCents,
      snapshot.cumulativeRefundAmountCents,
      snapshot.billingCommandId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      fullyRefunded ? "refunded" : account.commercial_state,
      expectedMrr,
      fullyRefunded ? "refunded" : "active",
      cashId,
      -snapshot.refundAmountCents,
      revenueId,
      -adjustment,
      transitionId,
      lifecycleId,
      auditId,
      at
    )
  );
  const results = await env.TEAM_CONTROL_DB.batch(statements);
  const expectedCommandChanges = snapshot.billingCommandId === null ? 0 : 1;
  const expectedChanges = results.map((_, index) => (index === 2 || index === 4 ? 0 : 1));
  expectedChanges[4] = expectedCommandChanges;
  if (results.some((result, index) => (result.meta.changes ?? 0) !== expectedChanges[index])) {
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
  const requiredResultIndices = [0, 1, 2];
  const pushRequired = (statement: D1PreparedStatement): void => {
    requiredResultIndices.push(statements.length);
    statements.push(statement);
  };
  if (canceled) {
    pushRequired(
      env.TEAM_CONTROL_DB.prepare(
        `UPDATE billing_generations
            SET status = 'terminal_verified', terminal_verified_at = ?1, terminal_source_event_id = ?2
          WHERE org_id = ?3 AND generation = ?4 AND status = 'bound'
            AND provider_customer_id = ?5 AND provider_subscription_id = ?6
            AND EXISTS (
              SELECT 1 FROM provider_events
               WHERE event_id = ?2 AND org_id = ?3 AND event_type = 'customer.subscription.deleted'
                 AND status = 'reconciled'
            )`
      ).bind(
        at,
        event.event_id,
        snapshot.orgId,
        snapshot.billingGeneration,
        snapshot.providerCustomerId,
        snapshot.providerSubscriptionId
      )
    );
    pushRequired(
      env.TEAM_CONTROL_DB.prepare(
        `INSERT INTO billing_generation_events
          (id, org_id, generation, event_type, source_ref, occurred_at)
         SELECT ?1, ?2, ?3, 'terminal_verified', ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM billing_generations
             WHERE org_id = ?2 AND generation = ?3 AND status = 'terminal_verified'
               AND terminal_source_event_id = ?4
          )`
      ).bind(
        `billing_generation_terminal_${event.event_id}`,
        snapshot.orgId,
        snapshot.billingGeneration,
        event.event_id,
        at
      )
    );
  }
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
        last_reconciled_event_id = ?8, updated_at = ?9
       WHERE org_id = ?10 AND billing_generation = ?11
         AND provider_customer_id = ?12 AND provider_subscription_id = ?13`
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
      snapshot.orgId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId
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
  pushRequired(
    env.TEAM_CONTROL_DB.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'billing_subscription_reconciled', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM provider_reconciliation_snapshots
              WHERE reconciliation_id = ?3 AND source_event_id = ?2 AND result = 'applied'
           )
           AND EXISTS (
             SELECT 1 FROM provider_events WHERE event_id = ?2 AND status = 'reconciled'
           )
           AND EXISTS (
             SELECT 1 FROM provider_state_cursors
              WHERE org_id = ?4 AND event_id = ?2 AND reconciliation_id = ?3 AND status = 'applied'
           )
           AND EXISTS (
             SELECT 1 FROM billing_accounts
              WHERE org_id = ?4 AND billing_generation = ?5
                AND provider_customer_id = ?6 AND provider_subscription_id = ?7
                AND commercial_state = ?8 AND current_recognized_mrr_micros = ?9
                AND last_reconciled_event_id = ?2
           )
           AND EXISTS (
             SELECT 1 FROM entitlements
              WHERE org_id = ?4 AND status = ?10 AND source_event_id = ?2
           )
           AND (
             ?11 = 0 OR EXISTS (
               SELECT 1 FROM billing_generations
                WHERE org_id = ?4 AND generation = ?5 AND status = 'terminal_verified'
                  AND provider_customer_id = ?6 AND provider_subscription_id = ?7
                  AND terminal_source_event_id = ?2
             )
           )
         THEN 1 ELSE 0 END, ?12)`
    ).bind(
      `integrity_billing_subscription_${event.event_id}`,
      event.event_id,
      snapshot.reconciliationId,
      snapshot.orgId,
      snapshot.billingGeneration,
      snapshot.providerCustomerId,
      snapshot.providerSubscriptionId,
      nextState,
      nextMrr,
      canceled ? "expired" : pastDue ? "grace" : "active",
      canceled ? 1 : 0,
      at
    )
  );
  const results = await env.TEAM_CONTROL_DB.batch(statements);
  if (requiredResultIndices.some((index) => (results[index]?.meta.changes ?? 0) !== 1)) {
    throw new ApiError(409, "subscription_reconciliation_conflict", "Subscription reconciliation lost its exact generation binding.");
  }
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
