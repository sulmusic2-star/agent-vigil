import type {
  BillingAccountRow,
  BillingCommandRow,
  BillingGenerationRow,
  CheckoutSubscriptionCompensationRow,
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
      `SELECT org_id, provider_customer_id, provider_subscription_id, billing_generation,
              internal_price_id, billing_interval
         FROM billing_accounts WHERE org_id = ?1`
    )
    .bind(orgId)
    .first<BillingAccountRow>();
}

export async function billingGeneration(
  db: D1Database,
  orgId: string,
  generation: number
): Promise<BillingGenerationRow | null> {
  return db
    .prepare(
      `SELECT org_id, generation, internal_price_id, status,
              provider_customer_id, provider_subscription_id
         FROM billing_generations
        WHERE org_id = ?1 AND generation = ?2
          AND status IN ('bound', 'terminal_verified', 'retired')
          AND provider_customer_id IS NOT NULL AND provider_subscription_id IS NOT NULL`
    )
    .bind(orgId, generation)
    .first<BillingGenerationRow>();
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
  billing_generation: number;
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
      `SELECT id, org_id, internal_price_id, billing_generation, status, provider_session_id,
              compensation_customer_id, compensation_subscription_id,
              execution_lease_id, execution_lease_expires_at, expires_at
         FROM checkout_intents WHERE id = ?1 AND org_id = ?2`
    )
    .bind(id, orgId)
    .first();
}

export async function checkoutSubscriptionCompensation(
  db: D1Database,
  orgId: string,
  billingCommandId: string
): Promise<CheckoutSubscriptionCompensationRow | null> {
  const rows = await db
    .prepare(
      `SELECT id, org_id, billing_command_id, checkout_intent_id, billing_generation,
              provider_event_id, provider_session_id, provider_customer_id,
              provider_subscription_id, reason, status, resume_command_status,
              execution_lease_id, execution_lease_expires_at
         FROM checkout_subscription_compensations
        WHERE org_id = ?1 AND billing_command_id = ?2
          AND status IN ('prepared', 'executing')
        ORDER BY requested_at, id
        LIMIT 1`
    )
    .bind(orgId, billingCommandId)
    .all<CheckoutSubscriptionCompensationRow>();
  return rows.results[0] ?? null;
}

export async function checkoutCompensationExpectedProviderState(
  db: D1Database,
  compensation: CheckoutSubscriptionCompensationRow
): Promise<{ providerPriceId: string; metadata: Record<string, string> }> {
  const rows = await db
    .prepare(
      `SELECT summary_json
         FROM provider_events
        WHERE event_id = ?1 AND org_id = ?2 AND event_type = 'checkout.session.completed'
          AND object_id = ?3 AND status = 'rejected'
        LIMIT 2`
    )
    .bind(compensation.provider_event_id, compensation.org_id, compensation.provider_session_id)
    .all<{ summary_json: string }>();
  if (rows.results.length !== 1) {
    throw new AdapterError(500, "checkout_compensation_binding_corrupt", "Checkout compensation lacks one payload-bound provider event.");
  }
  const summary = parseJson(rows.results[0]!.summary_json, "checkout compensation provider summary");
  const reportedGeneration = summary.reportedBillingGeneration;
  if (
    summary.orgId !== compensation.org_id ||
    summary.objectId !== compensation.provider_session_id ||
    summary.checkoutSessionId !== compensation.provider_session_id ||
    summary.customerId !== compensation.provider_customer_id ||
    summary.subscriptionId !== compensation.provider_subscription_id ||
    summary.checkoutIntentId !== compensation.checkout_intent_id ||
    summary.billingGeneration !== compensation.billing_generation ||
    (reportedGeneration !== null &&
      (!Number.isSafeInteger(reportedGeneration) || (reportedGeneration as number) <= 0)) ||
    (summary.billingGenerationSource !== "metadata" &&
      summary.billingGenerationSource !== "checkout_intent_binding" &&
      summary.billingGenerationSource !== "legacy_unique_binding") ||
    typeof summary.internalPriceId !== "string" ||
    typeof summary.providerPriceId !== "string" ||
    typeof summary.reportedInternalPriceId !== "string" ||
    typeof summary.reportedProviderPriceId !== "string"
  ) {
    throw new AdapterError(500, "checkout_compensation_binding_corrupt", "Checkout compensation provider summary is invalid.");
  }
  const metadata: Record<string, string> = {
    team_org_id: compensation.org_id,
    internal_price_id: summary.reportedInternalPriceId,
    provider_price_id: summary.reportedProviderPriceId,
    checkout_intent_id: compensation.checkout_intent_id,
    contributor_limit: "15"
  };
  if (reportedGeneration !== null) {
    metadata.billing_generation = String(reportedGeneration);
  }
  return { providerPriceId: summary.providerPriceId, metadata };
}

export async function claimCheckoutSubscriptionCompensation(
  db: D1Database,
  row: BillingCommandRow,
  compensation: CheckoutSubscriptionCompensationRow,
  leaseId: string,
  leasedAt: string,
  leaseExpiresAt: string
): Promise<void> {
  const receiptId = `integrity_checkout_extra_claim_${leaseId}`;
  const results = await db.batch([
    db.prepare(
      `UPDATE checkout_subscription_compensations
          SET status = 'executing', execution_lease_id = ?1, execution_lease_expires_at = ?2
        WHERE id = ?3 AND org_id = ?4 AND billing_command_id = ?5
          AND (
            status = 'prepared' OR
            (status = 'executing' AND execution_lease_expires_at <= ?6)
          )
          AND EXISTS (
            SELECT 1 FROM billing_commands
             WHERE id = ?5 AND org_id = ?4 AND status = 'compensating'
               AND execution_lease_expires_at <= ?6
          )`
    ).bind(leaseId, leaseExpiresAt, compensation.id, row.org_id, row.id, leasedAt),
    db.prepare(
      `UPDATE billing_commands
          SET execution_lease_id = ?1, execution_lease_expires_at = ?2
        WHERE id = ?3 AND org_id = ?4 AND status = 'compensating'
          AND execution_lease_expires_at <= ?5
          AND EXISTS (
            SELECT 1 FROM checkout_subscription_compensations
             WHERE id = ?6 AND org_id = ?4 AND billing_command_id = ?3
               AND status = 'executing' AND execution_lease_id = ?1
               AND execution_lease_expires_at = ?2
          )`
    ).bind(leaseId, leaseExpiresAt, row.id, row.org_id, leasedAt, compensation.id),
    db.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'unexpected_checkout_compensation_claimed', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM checkout_subscription_compensations
              WHERE id = ?2 AND org_id = ?3 AND billing_command_id = ?4
                AND status = 'executing' AND execution_lease_id = ?5
                AND execution_lease_expires_at = ?6
           )
           AND EXISTS (
             SELECT 1 FROM billing_commands
              WHERE id = ?4 AND org_id = ?3 AND status = 'compensating'
                AND execution_lease_id = ?5 AND execution_lease_expires_at = ?6
           )
         THEN 1 ELSE 0 END, ?7)`
    ).bind(receiptId, compensation.id, row.org_id, row.id, leaseId, leaseExpiresAt, leasedAt)
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new AdapterError(409, "checkout_compensation_claim_conflict", "Checkout compensation is already leased or no longer active.");
  }
}

export async function markUnexpectedCheckoutSubscriptionCompensated(
  db: D1Database,
  row: BillingCommandRow,
  compensation: CheckoutSubscriptionCompensationRow,
  leaseId: string,
  compensatedAt: string
): Promise<void> {
  const generationEventId = `billing_generation_unexpected_compensated_${compensation.id}`;
  const auditId = `audit_unexpected_compensated_${compensation.id}`;
  const receiptId = `integrity_unexpected_compensated_${compensation.id}`;
  const results = await db.batch([
    db.prepare(
      `UPDATE checkout_subscription_compensations
          SET status = 'completed', completed_at = ?1,
              execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE id = ?2 AND org_id = ?3 AND billing_command_id = ?4
          AND billing_generation = ?5 AND provider_session_id = ?6
          AND provider_customer_id = ?7 AND provider_subscription_id = ?8
          AND status = 'executing' AND execution_lease_id = ?9
          AND EXISTS (
            SELECT 1 FROM billing_generations
             WHERE org_id = ?3 AND generation = ?5
               AND checkout_intent_id = checkout_subscription_compensations.checkout_intent_id
          )`
    ).bind(
      compensatedAt,
      compensation.id,
      row.org_id,
      row.id,
      compensation.billing_generation,
      compensation.provider_session_id,
      compensation.provider_customer_id,
      compensation.provider_subscription_id,
      leaseId
    ),
    db.prepare(
      `UPDATE billing_commands
          SET status = CASE WHEN EXISTS (
                SELECT 1 FROM checkout_subscription_compensations pending
                 WHERE pending.org_id = ?3 AND pending.billing_command_id = ?2
                   AND pending.id <> ?5 AND pending.status IN ('prepared', 'executing')
              ) THEN 'compensating' ELSE ?1 END,
              execution_lease_id = CASE WHEN EXISTS (
                SELECT 1 FROM checkout_subscription_compensations pending
                 WHERE pending.org_id = ?3 AND pending.billing_command_id = ?2
                   AND pending.id <> ?5 AND pending.status IN ('prepared', 'executing')
              ) THEN (
                SELECT pending.id FROM checkout_subscription_compensations pending
                 WHERE pending.org_id = ?3 AND pending.billing_command_id = ?2
                   AND pending.id <> ?5 AND pending.status IN ('prepared', 'executing')
                 ORDER BY pending.requested_at, pending.id LIMIT 1
              ) ELSE NULL END,
              execution_lease_expires_at = CASE WHEN EXISTS (
                SELECT 1 FROM checkout_subscription_compensations pending
                 WHERE pending.org_id = ?3 AND pending.billing_command_id = ?2
                   AND pending.id <> ?5 AND pending.status IN ('prepared', 'executing')
              ) THEN ?6 ELSE NULL END
        WHERE id = ?2 AND org_id = ?3 AND status = 'compensating'
          AND execution_lease_id = ?4
          AND EXISTS (
            SELECT 1 FROM checkout_subscription_compensations
             WHERE id = ?5 AND org_id = ?3 AND billing_command_id = ?2
               AND status = 'completed' AND completed_at = ?6
               AND resume_command_status = ?1
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkout_subscription_compensations pending
             WHERE pending.org_id = ?3 AND pending.billing_command_id = ?2
               AND pending.id <> ?5 AND pending.status IN ('prepared', 'executing')
               AND pending.resume_command_status <> ?1
          )`
    ).bind(compensation.resume_command_status, row.id, row.org_id, leaseId, compensation.id, compensatedAt),
    db.prepare(
      `INSERT INTO billing_generation_events
        (id, org_id, generation, event_type, source_ref, occurred_at)
       SELECT ?1, ?2, ?3, 'unexpected_subscription_compensated', ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM checkout_subscription_compensations
           WHERE id = ?6 AND org_id = ?2 AND billing_command_id = ?7
             AND billing_generation = ?3 AND provider_subscription_id = ?9
             AND status = 'completed' AND completed_at = ?5
        )
          AND EXISTS (
            SELECT 1 FROM billing_commands command
             WHERE command.id = ?7 AND command.org_id = ?2
               AND (
                 (command.status = ?8 AND command.execution_lease_id IS NULL
                   AND command.execution_lease_expires_at IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM checkout_subscription_compensations pending
                      WHERE pending.org_id = ?2 AND pending.billing_command_id = ?7
                        AND pending.status IN ('prepared', 'executing')
                   ))
                 OR
                 (command.status = 'compensating' AND command.execution_lease_id IS NOT NULL
                   AND command.execution_lease_expires_at = ?5
                   AND EXISTS (
                     SELECT 1 FROM checkout_subscription_compensations pending
                      WHERE pending.org_id = ?2 AND pending.billing_command_id = ?7
                        AND pending.id = command.execution_lease_id
                        AND pending.status IN ('prepared', 'executing')
                   ))
               )
          )`
    ).bind(
      generationEventId,
      row.org_id,
      compensation.billing_generation,
      compensation.id,
      compensatedAt,
      compensation.id,
      row.id,
      compensation.resume_command_status,
      compensation.provider_subscription_id
    ),
    db.prepare(
      `INSERT INTO audit_events
        (id, org_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, created_at)
       SELECT ?1, ?2, 'system', 'stripe-executor', 'billing.checkout.unexpected_subscription_compensated',
              'checkout_subscription_compensation', ?3, '{}', ?4
        WHERE EXISTS (
          SELECT 1 FROM billing_generation_events
           WHERE id = ?5 AND org_id = ?2 AND generation = ?6
             AND event_type = 'unexpected_subscription_compensated' AND source_ref = ?3
        )`
    ).bind(
      auditId,
      row.org_id,
      compensation.id,
      compensatedAt,
      generationEventId,
      compensation.billing_generation
    ),
    db.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'unexpected_checkout_subscription_compensated', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM checkout_subscription_compensations
              WHERE id = ?2 AND org_id = ?3 AND billing_command_id = ?4
                AND billing_generation = ?5 AND provider_session_id = ?6
                AND provider_customer_id = ?7 AND provider_subscription_id = ?8
                AND status = 'completed' AND completed_at = ?9
           )
           AND EXISTS (
             SELECT 1 FROM billing_commands
              WHERE id = ?4 AND org_id = ?3
                AND (
                  (status = ?10 AND execution_lease_id IS NULL AND execution_lease_expires_at IS NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM checkout_subscription_compensations pending
                       WHERE pending.org_id = ?3 AND pending.billing_command_id = ?4
                         AND pending.status IN ('prepared', 'executing')
                    ))
                  OR
                  (status = 'compensating' AND execution_lease_id IS NOT NULL
                    AND execution_lease_expires_at = ?9
                    AND EXISTS (
                      SELECT 1 FROM checkout_subscription_compensations pending
                       WHERE pending.org_id = ?3 AND pending.billing_command_id = ?4
                         AND pending.id = billing_commands.execution_lease_id
                         AND pending.status IN ('prepared', 'executing')
                    ))
                )
           )
           AND EXISTS (
             SELECT 1 FROM billing_generation_events
              WHERE id = ?11 AND org_id = ?3 AND generation = ?5
                AND event_type = 'unexpected_subscription_compensated' AND source_ref = ?2
           )
           AND EXISTS (
             SELECT 1 FROM audit_events
              WHERE id = ?12 AND org_id = ?3
                AND action = 'billing.checkout.unexpected_subscription_compensated'
           )
         THEN 1 ELSE 0 END, ?9)`
    ).bind(
      receiptId,
      compensation.id,
      row.org_id,
      row.id,
      compensation.billing_generation,
      compensation.provider_session_id,
      compensation.provider_customer_id,
      compensation.provider_subscription_id,
      compensatedAt,
      compensation.resume_command_status,
      generationEventId,
      auditId
    )
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new AdapterError(409, "checkout_compensation_not_recorded", "Unexpected Checkout compensation could not be committed.");
  }
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
    !Number.isSafeInteger(parsed.billingGeneration) ||
    (parsed.billingGeneration as number) <= 0 ||
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
    !Number.isSafeInteger(candidate.billingGeneration) ||
    (candidate.billingGeneration as number) <= 0 ||
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

export async function hasExactLegacyGenerationBridgeEvidence(
  db: D1Database,
  row: ProviderEventRow,
  summary: StripeSummary
): Promise<boolean> {
  if (
    summary.billingGenerationSource !== "legacy_unique_binding" ||
    summary.reportedBillingGeneration !== null ||
    !summary.customerId ||
    !summary.subscriptionId ||
    !summary.checkoutIntentId
  ) {
    return false;
  }
  const rows = await db
    .prepare(
      `SELECT pe.event_id
         FROM provider_events pe
         JOIN billing_generations bg
           ON bg.org_id = pe.org_id
          AND bg.generation = CAST(json_extract(pe.summary_json, '$.billingGeneration') AS INTEGER)
          AND bg.internal_price_id = json_extract(pe.summary_json, '$.internalPriceId')
          AND bg.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
          AND bg.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
          AND bg.checkout_intent_id = json_extract(pe.summary_json, '$.checkoutIntentId')
         JOIN workflow_integrity_receipts eligible
           ON eligible.workflow_type = 'legacy_billing_generation_bridge_eligible'
          AND eligible.source_ref = bg.org_id || ':' || CAST(bg.generation AS TEXT)
          AND eligible.valid = 1
         JOIN workflow_integrity_receipts applied
           ON applied.id = 'integrity_legacy_billing_generation_bridge_' || pe.event_id
          AND applied.workflow_type = 'legacy_billing_generation_bridge_applied'
          AND applied.source_ref = pe.event_id
          AND applied.valid = 1
        WHERE pe.event_id = ?1 AND pe.org_id = ?2 AND pe.object_id = ?3
          AND pe.status = 'awaiting_reconciliation'
          AND json_extract(pe.summary_json, '$.orgId') = ?2
          AND json_extract(pe.summary_json, '$.objectId') = ?3
          AND json_extract(pe.summary_json, '$.customerId') = ?4
          AND json_extract(pe.summary_json, '$.subscriptionId') = ?5
          AND json_extract(pe.summary_json, '$.internalPriceId') = ?6
          AND json_extract(pe.summary_json, '$.providerPriceId') = ?7
          AND CAST(json_extract(pe.summary_json, '$.billingGeneration') AS INTEGER) = ?8
          AND json_extract(pe.summary_json, '$.checkoutIntentId') = ?9
          AND json_extract(pe.summary_json, '$.billingGenerationSource') = 'legacy_unique_binding'
          AND json_extract(pe.summary_json, '$.reportedBillingGeneration') IS NULL
        LIMIT 2`
    )
    .bind(
      row.event_id,
      summary.orgId,
      summary.objectId,
      summary.customerId,
      summary.subscriptionId,
      summary.internalPriceId,
      summary.providerPriceId,
      summary.billingGeneration,
      summary.checkoutIntentId
    )
    .all<{ event_id: string }>();
  return rows.results.length === 1;
}

export async function markCheckoutAccepted(
  db: D1Database,
  row: BillingCommandRow,
  command: Record<string, unknown>,
  checkoutIntentId: string,
  billingGeneration: number,
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
      `UPDATE billing_generations SET provider_checkout_session_id = ?1
        WHERE org_id = ?2 AND generation = ?3 AND checkout_intent_id = ?4 AND status = 'reserved'
          AND provider_checkout_session_id IS NULL
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?4 AND org_id = ?2 AND billing_generation = ?3
               AND status = 'provider_created' AND provider_session_id = ?1
          )`
    ).bind(providerSessionId, row.org_id, billingGeneration, checkoutIntentId),
    db.prepare(
      `UPDATE billing_commands SET status = 'provider_accepted', command_json = ?1,
          execution_lease_id = NULL, execution_lease_expires_at = NULL
        WHERE id = ?2 AND org_id = ?3 AND status = 'executing' AND execution_lease_id = ?4
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?5 AND org_id = ?3 AND status = 'provider_created'
               AND provider_session_id = ?6
          )
          AND EXISTS (
            SELECT 1 FROM billing_generations
             WHERE org_id = ?3 AND generation = ?7 AND checkout_intent_id = ?5
               AND status = 'reserved' AND provider_checkout_session_id = ?6
          )
          AND EXISTS (SELECT 1 FROM organizations WHERE id = ?3 AND status = 'active')`
    ).bind(JSON.stringify(stored), row.id, row.org_id, leaseId, checkoutIntentId, providerSessionId, billingGeneration),
    db.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'checkout_session_binding_attempt', ?2,
         CASE WHEN
           (
             EXISTS (
               SELECT 1 FROM checkout_intents
                WHERE id = ?3 AND org_id = ?4 AND billing_generation = ?5
                  AND status = 'provider_created' AND provider_session_id = ?6
             )
             AND EXISTS (
               SELECT 1 FROM billing_generations
                WHERE org_id = ?4 AND generation = ?5 AND checkout_intent_id = ?3
                  AND status = 'reserved' AND provider_checkout_session_id = ?6
             )
             AND EXISTS (
               SELECT 1 FROM billing_commands WHERE id = ?2 AND org_id = ?4 AND status = 'provider_accepted'
             )
           )
           OR (
             EXISTS (SELECT 1 FROM organizations WHERE id = ?4 AND status = 'deletion_pending')
             AND EXISTS (
               SELECT 1 FROM checkout_intents
                WHERE id = ?3 AND org_id = ?4 AND billing_generation = ?5
                  AND status = 'executing' AND execution_lease_id = ?7
             )
             AND EXISTS (
               SELECT 1 FROM billing_generations
                WHERE org_id = ?4 AND generation = ?5 AND checkout_intent_id = ?3
                  AND status = 'reserved' AND provider_checkout_session_id IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM billing_commands
                WHERE id = ?2 AND org_id = ?4 AND status = 'executing' AND execution_lease_id = ?7
             )
           )
         THEN 1 ELSE 0 END, ?8)`
    ).bind(
      `integrity_checkout_session_${leaseId}`,
      row.id,
      checkoutIntentId,
      row.org_id,
      billingGeneration,
      providerSessionId,
      leaseId,
      new Date().toISOString()
    )
  ]);
  const primaryChanges = results.slice(0, 3).map((result) => result.meta.changes ?? 0);
  if ((results[3]?.meta.changes ?? 0) !== 1) {
    throw new AdapterError(409, "checkout_session_binding_conflict", "Checkout Session binding receipt was not recorded.");
  }
  if (primaryChanges.every((changes) => changes === 1)) return true;
  if (primaryChanges.every((changes) => changes === 0)) return false;
  throw new AdapterError(409, "checkout_session_binding_conflict", "Checkout Session binding was only partially applied.");
}

export async function markCheckoutCompensated(
  db: D1Database,
  row: BillingCommandRow,
  command: Record<string, unknown>,
  checkoutIntentId: string,
  billingGeneration: number,
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
      `UPDATE billing_generations
          SET status = 'abandoned', provider_checkout_session_id = ?1
        WHERE org_id = ?2 AND generation = ?3 AND checkout_intent_id = ?4
          AND status = 'reserved' AND (provider_checkout_session_id IS NULL OR provider_checkout_session_id = ?1)
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?4 AND org_id = ?2 AND billing_generation = ?3
               AND status = 'canceled' AND provider_session_id = ?1 AND compensated_at = ?5
          )`
    ).bind(providerSessionId, row.org_id, billingGeneration, checkoutIntentId, compensatedAt),
    db.prepare(
      `INSERT INTO billing_generation_events
        (id, org_id, generation, event_type, source_ref, occurred_at)
       SELECT ?1, ?2, ?3, 'abandoned', ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM billing_generations
           WHERE org_id = ?2 AND generation = ?3 AND checkout_intent_id = ?6
             AND status = 'abandoned' AND provider_checkout_session_id = ?4
        )`
    ).bind(
      `billing_generation_abandoned_${row.id}`,
      row.org_id,
      billingGeneration,
      providerSessionId,
      compensatedAt,
      checkoutIntentId
    ),
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
    ).bind(JSON.stringify(stored), compensatedAt, row.id, row.org_id, leaseId, checkoutIntentId, providerSessionId),
    db.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'checkout_session_compensated', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM checkout_intents
              WHERE id = ?3 AND org_id = ?4 AND billing_generation = ?5
                AND status = 'canceled' AND provider_session_id = ?6 AND compensated_at = ?7
           )
           AND EXISTS (
             SELECT 1 FROM billing_generations
              WHERE org_id = ?4 AND generation = ?5 AND checkout_intent_id = ?3
                AND status = 'abandoned' AND provider_checkout_session_id = ?6
           )
           AND EXISTS (
             SELECT 1 FROM billing_generation_events
              WHERE org_id = ?4 AND generation = ?5 AND event_type = 'abandoned' AND source_ref = ?6
           )
           AND EXISTS (
             SELECT 1 FROM billing_commands
              WHERE id = ?2 AND org_id = ?4 AND status = 'canceled' AND compensated_at = ?7
           )
         THEN 1 ELSE 0 END, ?7)`
    ).bind(
      `integrity_checkout_session_compensated_${row.id}`,
      row.id,
      checkoutIntentId,
      row.org_id,
      billingGeneration,
      providerSessionId,
      compensatedAt
    )
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new AdapterError(409, "checkout_compensation_not_recorded", "Checkout compensation could not be committed.");
  }
}

export async function markCheckoutSubscriptionCompensated(
  db: D1Database,
  row: BillingCommandRow,
  command: Record<string, unknown>,
  checkoutIntentId: string,
  billingGeneration: number,
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
      `UPDATE billing_generations
          SET status = 'abandoned', provider_checkout_session_id = ?1
        WHERE org_id = ?2 AND generation = ?3 AND checkout_intent_id = ?4
          AND status = 'reserved' AND (provider_checkout_session_id IS NULL OR provider_checkout_session_id = ?1)
          AND EXISTS (
            SELECT 1 FROM checkout_intents
             WHERE id = ?4 AND org_id = ?2 AND billing_generation = ?3
               AND status = 'canceled' AND provider_session_id = ?1 AND compensated_at = ?5
          )`
    ).bind(providerSessionId, row.org_id, billingGeneration, checkoutIntentId, compensatedAt),
    db.prepare(
      `INSERT INTO billing_generation_events
        (id, org_id, generation, event_type, source_ref, occurred_at)
       SELECT ?1, ?2, ?3, 'abandoned', ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM billing_generations
           WHERE org_id = ?2 AND generation = ?3 AND checkout_intent_id = ?6
             AND status = 'abandoned' AND provider_checkout_session_id = ?7
        )`
    ).bind(
      `billing_generation_abandoned_${row.id}`,
      row.org_id,
      billingGeneration,
      providerSubscriptionId,
      compensatedAt,
      checkoutIntentId,
      providerSessionId
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
    ).bind(`audit_${crypto.randomUUID()}`, row.org_id, row.id, compensatedAt),
    db.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'checkout_subscription_compensated', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM checkout_intents
              WHERE id = ?3 AND org_id = ?4 AND billing_generation = ?5
                AND status = 'canceled' AND provider_session_id = ?6 AND compensated_at = ?7
                AND compensation_customer_id IS NULL AND compensation_subscription_id IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM billing_generations
              WHERE org_id = ?4 AND generation = ?5 AND checkout_intent_id = ?3
                AND status = 'abandoned' AND provider_checkout_session_id = ?6
           )
           AND EXISTS (
             SELECT 1 FROM billing_generation_events
              WHERE org_id = ?4 AND generation = ?5 AND event_type = 'abandoned' AND source_ref = ?8
           )
           AND EXISTS (
             SELECT 1 FROM billing_commands
              WHERE id = ?2 AND org_id = ?4 AND status = 'canceled' AND compensated_at = ?7
           )
         THEN 1 ELSE 0 END, ?7)`
    ).bind(
      `integrity_checkout_subscription_compensated_${row.id}`,
      row.id,
      checkoutIntentId,
      row.org_id,
      billingGeneration,
      providerSessionId,
      compensatedAt,
      providerSubscriptionId
    )
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
