import type {
  BillingAccountRow,
  BillingCommandRow,
  ProviderEventRow,
  StripeSummary
} from "./contracts.ts";
import { AdapterError, isRecord, parseJson } from "./safe.ts";

export async function executableCommand(
  db: D1Database,
  orgId: string,
  commandId: string
): Promise<BillingCommandRow> {
  const row = await db
    .prepare(
      `SELECT id, org_id, command_type, idempotency_key, command_json, status
              , execution_lease_id, execution_lease_expires_at,
              (SELECT status FROM organizations WHERE id = billing_commands.org_id) AS organization_status
         FROM billing_commands WHERE id = ?1 AND org_id = ?2`
    )
    .bind(commandId, orgId)
    .first<BillingCommandRow>();
  if (
    !row ||
    row.organization_status === "deleted" ||
    !["prepared", "executing", "compensating", "provider_accepted"].includes(row.status)
  ) {
    throw new AdapterError(409, "command_not_executable", "Billing command is not executable.");
  }
  return row;
}

export async function billingAccount(db: D1Database, orgId: string): Promise<BillingAccountRow | null> {
  return db
    .prepare(
      `SELECT org_id, provider_customer_id, provider_subscription_id, internal_price_id, billing_interval
         FROM billing_accounts WHERE org_id = ?1`
    )
    .bind(orgId)
    .first<BillingAccountRow>();
}

export async function refundProviderBinding(
  db: D1Database,
  orgId: string,
  refundId: string
): Promise<{
  commandId: string;
  refundId: string;
  chargeId: string;
  paymentIntentId: string;
  amountCents: number;
  sourcePaymentEventId: string;
}> {
  const rows = await db
    .prepare(
      `SELECT id, command_json FROM billing_commands
        WHERE org_id = ?1 AND command_type = 'request_refund'
          AND status IN ('provider_accepted', 'confirmed')
          AND json_extract(command_json, '$.provider_result.refund_id') = ?2
        LIMIT 2`
    )
    .bind(orgId, refundId)
    .all<{ id: string; command_json: string }>();
  if (rows.results.length !== 1) {
    throw new AdapterError(409, "refund_binding_missing", "Refund event is not bound to one accepted command.");
  }
  const command = parseJson(rows.results[0]!.command_json, "refund command");
  const result = command.provider_result;
  if (!isRecord(result)) {
    throw new AdapterError(500, "provider_binding_corrupt", "Stored refund binding is invalid.");
  }
  if (
    typeof result.refund_id !== "string" ||
    typeof result.charge_id !== "string" ||
    typeof result.payment_intent_id !== "string" ||
    result.refund_id !== refundId ||
    !Number.isSafeInteger(result.amount_cents) ||
    (result.amount_cents as number) <= 0 ||
    typeof result.source_payment_event_id !== "string"
  ) {
    throw new AdapterError(500, "provider_binding_corrupt", "Stored refund binding is invalid.");
  }
  return {
    commandId: rows.results[0]!.id,
    refundId: result.refund_id,
    chargeId: result.charge_id,
    paymentIntentId: result.payment_intent_id,
    amountCents: result.amount_cents as number,
    sourcePaymentEventId: result.source_payment_event_id
  };
}

export async function refundSourceBinding(
  db: D1Database,
  orgId: string,
  chargeId: string,
  paymentIntentId: string,
  sourcePaymentEventId: string
): Promise<{
  commandId: null;
  refundId: null;
  chargeId: string;
  paymentIntentId: string;
  amountCents: null;
  sourcePaymentEventId: string;
}> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT bc.org_id,
              json_extract(bc.command_json, '$.provider_result.source_payment_event_id') AS source_payment_event_id
         FROM billing_commands bc
         JOIN provider_events pe
           ON pe.event_id = json_extract(bc.command_json, '$.provider_result.source_payment_event_id')
          AND pe.org_id = bc.org_id AND pe.event_type = 'invoice.paid' AND pe.status = 'reconciled'
         JOIN cash_ledger cash
           ON cash.org_id = bc.org_id AND cash.source_event_id = pe.event_id
          AND cash.entry_type = 'payment'
        WHERE bc.org_id = ?1 AND bc.command_type = 'request_refund'
          AND bc.status IN ('provider_accepted', 'confirmed')
          AND json_extract(bc.command_json, '$.provider_result.charge_id') = ?2
          AND json_extract(bc.command_json, '$.provider_result.payment_intent_id') = ?3
          AND json_extract(bc.command_json, '$.provider_result.source_payment_event_id') = ?4
        LIMIT 2`
    )
    .bind(orgId, chargeId, paymentIntentId, sourcePaymentEventId)
    .all<{ org_id: string; source_payment_event_id: string }>();
  if (rows.results.length !== 1) {
    throw new AdapterError(409, "refund_source_binding_missing", "Refund has no unique confirmed source payment binding.");
  }
  return {
    commandId: null,
    refundId: null,
    chargeId,
    paymentIntentId,
    amountCents: null,
    sourcePaymentEventId
  };
}

export async function checkoutIntent(
  db: D1Database,
  id: string,
  orgId: string
): Promise<{
  id: string;
  org_id: string;
  internal_price_id: string;
  status: string;
  provider_session_id: string | null;
  compensation_customer_id: string | null;
  compensation_subscription_id: string | null;
  execution_lease_id: string | null;
  execution_lease_expires_at: string | null;
  expires_at: string;
} | null> {
  return db
    .prepare(
      `SELECT id, org_id, internal_price_id, status, provider_session_id,
              compensation_customer_id, compensation_subscription_id,
              execution_lease_id, execution_lease_expires_at, expires_at
         FROM checkout_intents WHERE id = ?1 AND org_id = ?2`
    )
    .bind(id, orgId)
    .first();
}

export async function claimCheckoutExecution(
  db: D1Database,
  row: BillingCommandRow,
  checkoutIntentId: string,
  leaseId: string,
  leasedAt: string,
  leaseExpiresAt: string
): Promise<void> {
  const results = await db.batch([
    db.prepare(
      `UPDATE billing_commands
          SET status = 'executing', execution_lease_id = ?1, execution_lease_expires_at = ?2
        WHERE id = ?3 AND org_id = ?4 AND command_type = 'create_checkout_session'
          AND (
            status IN ('prepared', 'provider_accepted') OR
            (status IN ('executing', 'compensating') AND execution_lease_expires_at <= ?5)
          )
          AND EXISTS (
            SELECT 1 FROM organizations
             WHERE id = ?4 AND status IN ('active', 'deletion_pending')
          )
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?6 AND org_id = ?4
               AND status IN ('prepared', 'executing', 'provider_created', 'compensating')
               AND (
                 status IN ('prepared', 'provider_created') OR
                 execution_lease_expires_at <= ?5
               )
          )`
    ).bind(leaseId, leaseExpiresAt, row.id, row.org_id, leasedAt, checkoutIntentId),
    db.prepare(
      `UPDATE checkout_intents
          SET status = 'executing', execution_lease_id = ?1, execution_lease_expires_at = ?2
        WHERE id = ?3 AND org_id = ?4
          AND status IN ('prepared', 'executing', 'provider_created', 'compensating')
          AND EXISTS (
            SELECT 1 FROM billing_commands
             WHERE id = ?5 AND org_id = ?4 AND status = 'executing'
               AND execution_lease_id = ?1 AND execution_lease_expires_at = ?2
          )`
    ).bind(leaseId, leaseExpiresAt, checkoutIntentId, row.org_id, row.id)
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new AdapterError(409, "checkout_execution_claim_conflict", "Checkout execution is already leased or no longer active.");
  }
}

export async function sourcePaymentContext(
  db: D1Database,
  orgId: string,
  sourceEventId: string
): Promise<{ event: ProviderEventRow; amountCents: number; summary: StripeSummary }> {
  const event = await db
    .prepare(
      `SELECT event_id, event_type, object_id, org_id, event_created, summary_json, status
         FROM provider_events WHERE event_id = ?1 AND org_id = ?2`
    )
    .bind(sourceEventId, orgId)
    .first<ProviderEventRow>();
  const cash = await db
    .prepare(
      `SELECT amount_cents FROM cash_ledger
         WHERE org_id = ?1 AND source_event_id = ?2 AND entry_type = 'payment'`
    )
    .bind(orgId, sourceEventId)
    .first<{ amount_cents: number }>();
  if (!event || event.event_type !== "invoice.paid" || event.status !== "reconciled" || !cash) {
    throw new AdapterError(409, "payment_binding_missing", "Refund is not bound to a reconciled provider payment.");
  }
  const parsed = parseJson(event.summary_json, "provider_event.summary_json");
  if (
    typeof parsed.orgId !== "string" ||
    typeof parsed.objectId !== "string" ||
    (parsed.customerId !== null && typeof parsed.customerId !== "string") ||
    (parsed.subscriptionId !== null && typeof parsed.subscriptionId !== "string") ||
    (parsed.internalPriceId !== "team_monthly_usd_v1" && parsed.internalPriceId !== "team_annual_usd_v1") ||
    typeof parsed.providerPriceId !== "string" ||
    (parsed.checkoutIntentId !== null && typeof parsed.checkoutIntentId !== "string") ||
    parsed.refundId !== null ||
    parsed.refundAmountCents !== null ||
    parsed.refundChargeId !== null ||
    parsed.refundPaymentIntentId !== null ||
    parsed.refundSourcePaymentEventId !== null ||
    parsed.refundBillingCommandId !== null
  ) {
    throw new AdapterError(500, "provider_binding_corrupt", "Stored provider binding is invalid.");
  }
  return { event, amountCents: cash.amount_cents, summary: parsed as unknown as StripeSummary };
}

export async function providerEvent(db: D1Database, eventId: string): Promise<ProviderEventRow> {
  const row = await db
    .prepare(
      `SELECT event_id, event_type, object_id, org_id, event_created, summary_json, status
         FROM provider_events WHERE event_id = ?1`
    )
    .bind(eventId)
    .first<ProviderEventRow>();
  if (!row || !row.org_id || row.status !== "awaiting_reconciliation") {
    throw new AdapterError(409, "event_not_reconcilable", "Provider event is not awaiting reconciliation.");
  }
  return row;
}

export function parsedSummary(row: ProviderEventRow): StripeSummary {
  let value: unknown;
  try {
    value = JSON.parse(row.summary_json);
  } catch {
    throw new AdapterError(500, "provider_binding_corrupt", "Stored provider binding is invalid.");
  }
  if (!isRecord(value)) {
    throw new AdapterError(500, "provider_binding_corrupt", "Stored provider binding is invalid.");
  }
  const candidate = value as Partial<StripeSummary>;
  const nullableString = (item: unknown): boolean => item === null || typeof item === "string";
  if (
    candidate.orgId !== row.org_id ||
    candidate.objectId !== row.object_id ||
    typeof candidate.customerId !== "string" ||
    typeof candidate.subscriptionId !== "string" ||
    (candidate.internalPriceId !== "team_monthly_usd_v1" && candidate.internalPriceId !== "team_annual_usd_v1") ||
    typeof candidate.providerPriceId !== "string" ||
    !nullableString(candidate.checkoutIntentId) ||
    !nullableString(candidate.refundId) ||
    !(candidate.refundAmountCents === null || Number.isSafeInteger(candidate.refundAmountCents)) ||
    !nullableString(candidate.refundChargeId) ||
    !nullableString(candidate.refundPaymentIntentId) ||
    !nullableString(candidate.refundSourcePaymentEventId) ||
    !nullableString(candidate.refundBillingCommandId) ||
    (row.event_type === "refund.created"
      ? candidate.refundId !== row.object_id ||
        typeof candidate.refundAmountCents !== "number" ||
        candidate.refundAmountCents <= 0 ||
        typeof candidate.refundChargeId !== "string" ||
        typeof candidate.refundPaymentIntentId !== "string" ||
        typeof candidate.refundSourcePaymentEventId !== "string"
      : candidate.refundId !== null ||
        candidate.refundAmountCents !== null ||
        candidate.refundChargeId !== null ||
        candidate.refundPaymentIntentId !== null ||
        candidate.refundSourcePaymentEventId !== null ||
        candidate.refundBillingCommandId !== null)
  ) {
    throw new AdapterError(500, "provider_binding_corrupt", "Stored provider binding is invalid.");
  }
  return candidate as StripeSummary;
}

export async function markCheckoutAccepted(
  db: D1Database,
  row: BillingCommandRow,
  command: Record<string, unknown>,
  checkoutIntentId: string,
  providerSessionId: string,
  leaseId: string
): Promise<boolean> {
  const stored = { ...command, provider_result: { session_id: providerSessionId } };
  const results = await db.batch([
    db.prepare(
      `UPDATE checkout_intents SET status = 'provider_created', provider_session_id = ?1,
          execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE id = ?2 AND org_id = ?3 AND status = 'executing' AND execution_lease_id = ?4
          AND (provider_session_id IS NULL OR provider_session_id = ?1)
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?3 AND status = 'active')`
    ).bind(providerSessionId, checkoutIntentId, row.org_id, leaseId),
    db.prepare(
      `UPDATE billing_commands SET status = 'provider_accepted', command_json = ?1,
          execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE id = ?2 AND org_id = ?3 AND status = 'executing' AND execution_lease_id = ?4
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?5 AND org_id = ?3 AND status = 'provider_created'
               AND provider_session_id = ?6
          )
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?3 AND status = 'active')`
    ).bind(JSON.stringify(stored), row.id, row.org_id, leaseId, checkoutIntentId, providerSessionId)
  ]);
  return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
}

export async function markCheckoutCompensated(
  db: D1Database,
  row: BillingCommandRow,
  command: Record<string, unknown>,
  checkoutIntentId: string,
  providerSessionId: string,
  leaseId: string,
  compensatedAt: string
): Promise<void> {
  const stored = {
    ...command,
    provider_result: {
      session_id: providerSessionId,
      compensation: "checkout_session_expired",
      compensated_at: compensatedAt
    }
  };
  const results = await db.batch([
    db.prepare(
      `UPDATE checkout_intents
          SET status = 'canceled', provider_session_id = ?1, compensated_at = ?2,
              execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE id = ?3 AND org_id = ?4 AND status IN ('executing', 'compensating')
          AND execution_lease_id = ?5
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?4 AND status = 'deletion_pending')`
    ).bind(providerSessionId, compensatedAt, checkoutIntentId, row.org_id, leaseId),
    db.prepare(
      `UPDATE billing_commands
          SET status = 'canceled', command_json = ?1, compensated_at = ?2,
              execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE id = ?3 AND org_id = ?4 AND status IN ('executing', 'compensating')
          AND execution_lease_id = ?5
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?6 AND org_id = ?4 AND status = 'canceled'
               AND provider_session_id = ?7 AND compensated_at = ?2
          )`
    ).bind(JSON.stringify(stored), compensatedAt, row.id, row.org_id, leaseId, checkoutIntentId, providerSessionId)
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new AdapterError(409, "checkout_compensation_not_recorded", "Checkout compensation could not be committed.");
  }
}

export async function markCheckoutSubscriptionCompensated(
  db: D1Database,
  row: BillingCommandRow,
  command: Record<string, unknown>,
  checkoutIntentId: string,
  providerSessionId: string,
  providerCustomerId: string,
  providerSubscriptionId: string,
  leaseId: string,
  compensatedAt: string
): Promise<void> {
  const stored = {
    ...command,
    provider_result: {
      session_id: providerSessionId,
      compensation: "completed_checkout_subscription_canceled",
      provider_customer_id: providerCustomerId,
      provider_subscription_id: providerSubscriptionId,
      provider_status: "canceled",
      compensated_at: compensatedAt
    }
  };
  const results = await db.batch([
    db.prepare(
      `UPDATE checkout_intents
          SET status = 'canceled', compensated_at = ?1,
              compensation_customer_id = NULL, compensation_subscription_id = NULL,
              execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE id = ?2 AND org_id = ?3 AND status = 'executing'
          AND provider_session_id = ?4
          AND compensation_customer_id = ?5 AND compensation_subscription_id = ?6
          AND execution_lease_id = ?7
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?3 AND status = 'deletion_pending')`
    ).bind(
      compensatedAt,
      checkoutIntentId,
      row.org_id,
      providerSessionId,
      providerCustomerId,
      providerSubscriptionId,
      leaseId
    ),
    db.prepare(
      `UPDATE billing_commands
          SET status = 'canceled', command_json = ?1, compensated_at = ?2,
              execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE id = ?3 AND org_id = ?4 AND status = 'executing' AND execution_lease_id = ?5
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?6 AND org_id = ?4 AND status = 'canceled'
               AND provider_session_id = ?7 AND compensated_at = ?2
               AND compensation_customer_id IS NULL AND compensation_subscription_id IS NULL
          )`
    ).bind(JSON.stringify(stored), compensatedAt, row.id, row.org_id, leaseId, checkoutIntentId, providerSessionId),
    db.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'system', 'stripe-executor', 'billing.checkout.subscription_compensated',
              'billing_command', ?3, '{}', ?4
        WHERE EXISTS (
          SELECT 1 FROM billing_commands
           WHERE id = ?3 AND org_id = ?2 AND status = 'canceled' AND compensated_at = ?4
        )`
    ).bind(`audit_${crypto.randomUUID()}`, row.org_id, row.id, compensatedAt)
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new AdapterError(409, "checkout_compensation_not_recorded", "Checkout subscription compensation could not be committed.");
  }
}

export async function markCommandAccepted(
  db: D1Database,
  row: BillingCommandRow,
  command: Record<string, unknown>,
  providerResult: Record<string, unknown>
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE billing_commands SET status = 'provider_accepted', command_json = ?1
        WHERE id = ?2 AND org_id = ?3 AND status IN ('prepared', 'provider_accepted')`
    )
    .bind(JSON.stringify({ ...command, provider_result: providerResult }), row.id, row.org_id)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new AdapterError(500, "provider_result_not_recorded", "Provider result could not be recorded.");
  }
}
