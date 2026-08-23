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
         FROM billing_commands WHERE id = ?1 AND org_id = ?2`
    )
    .bind(commandId, orgId)
    .first<BillingCommandRow>();
  if (!row || !["prepared", "provider_accepted"].includes(row.status)) {
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
  chargeId: string
): Promise<{
  refundId: string;
  paymentIntentId: string;
  amountCents: number;
  sourcePaymentEventId: string;
}> {
  const rows = await db
    .prepare(
      `SELECT command_json FROM billing_commands
        WHERE org_id = ?1 AND command_type = 'request_refund'
          AND status IN ('provider_accepted', 'confirmed')
          AND json_extract(command_json, '$.provider_result.charge_id') = ?2
        LIMIT 2`
    )
    .bind(orgId, chargeId)
    .all<{ command_json: string }>();
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
    typeof result.payment_intent_id !== "string" ||
    result.charge_id !== chargeId ||
    !Number.isSafeInteger(result.amount_cents) ||
    typeof result.source_payment_event_id !== "string"
  ) {
    throw new AdapterError(500, "provider_binding_corrupt", "Stored refund binding is invalid.");
  }
  return {
    refundId: result.refund_id,
    paymentIntentId: result.payment_intent_id,
    amountCents: result.amount_cents as number,
    sourcePaymentEventId: result.source_payment_event_id
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
  expires_at: string;
} | null> {
  return db
    .prepare(
      `SELECT id, org_id, internal_price_id, status, provider_session_id, expires_at
         FROM checkout_intents WHERE id = ?1 AND org_id = ?2`
    )
    .bind(id, orgId)
    .first();
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
    (parsed.checkoutIntentId !== null && typeof parsed.checkoutIntentId !== "string")
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
  if (
    candidate.orgId !== row.org_id ||
    candidate.objectId !== row.object_id ||
    typeof candidate.customerId !== "string" ||
    typeof candidate.subscriptionId !== "string" ||
    (candidate.internalPriceId !== "team_monthly_usd_v1" && candidate.internalPriceId !== "team_annual_usd_v1") ||
    typeof candidate.providerPriceId !== "string"
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
  providerSessionId: string
): Promise<void> {
  const stored = { ...command, provider_result: { session_id: providerSessionId } };
  const results = await db.batch([
    db.prepare(
      `UPDATE checkout_intents SET status = 'provider_created', provider_session_id = ?1
        WHERE id = ?2 AND org_id = ?3 AND status IN ('prepared', 'provider_created')
          AND (provider_session_id IS NULL OR provider_session_id = ?1)`
    ).bind(providerSessionId, checkoutIntentId, row.org_id),
    db.prepare(
      `UPDATE billing_commands SET status = 'provider_accepted', command_json = ?1
        WHERE id = ?2 AND org_id = ?3 AND status IN ('prepared', 'provider_accepted')`
    ).bind(JSON.stringify(stored), row.id, row.org_id)
  ]);
  if (results.some((result) => !result.success)) {
    throw new AdapterError(500, "provider_result_not_recorded", "Provider result could not be recorded.");
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
  if (!result.success) {
    throw new AdapterError(500, "provider_result_not_recorded", "Provider result could not be recorded.");
  }
}
