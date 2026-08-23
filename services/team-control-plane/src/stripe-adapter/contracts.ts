export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;
export const TEAM_CONTRIBUTOR_LIMIT = 15 as const;
export const INVOCATION_TOLERANCE_SECONDS = 300;

export type InternalPriceId = "team_monthly_usd_v1" | "team_annual_usd_v1";
export type BillingCommandType = "create_checkout_session" | "cancel_at_period_end" | "request_refund";

export interface ExecutorEnv {
  TEAM_CONTROL_DB: D1Database;
  TEAM_STRIPE_EXECUTOR_HMAC_SECRET: string;
  STRIPE_EXECUTOR_RESTRICTED_KEY: string;
  STRIPE_EXECUTION_ENABLED: string;
  STRIPE_LIVEMODE: string;
  STRIPE_PRICE_TEAM_MONTHLY: string;
  STRIPE_PRICE_TEAM_ANNUAL: string;
  STRIPE_SUCCESS_URL: string;
  STRIPE_CANCEL_URL: string;
  STRIPE_RETURN_ORIGIN_ALLOWLIST: string;
}

export interface ReconcilerEnv {
  TEAM_CONTROL_DB: D1Database;
  TEAM_CONTROL_PLANE: Fetcher;
  TEAM_STRIPE_RECONCILER_INVOKE_HMAC_SECRET: string;
  STRIPE_READONLY_SECRET_KEY: string;
  STRIPE_RECONCILIATION_HMAC_SECRET: string;
  STRIPE_RECONCILIATION_ENABLED: string;
  STRIPE_LIVEMODE: string;
  STRIPE_PRICE_TEAM_MONTHLY: string;
  STRIPE_PRICE_TEAM_ANNUAL: string;
}

export interface ExecutionInvocation {
  schema_version: "stripe-command-execution-request-v1";
  request_id: string;
  org_id: string;
  command_id: string;
  return_target: "team_billing_v1";
}

export interface ReconciliationInvocation {
  schema_version: "stripe-reconciliation-request-v1";
  request_id: string;
  source_event_id: string;
}

export interface BillingCommandRow {
  id: string;
  org_id: string;
  command_type: BillingCommandType;
  idempotency_key: string;
  command_json: string;
  status: "prepared" | "provider_accepted" | "provider_rejected" | "confirmed";
}

export interface BillingAccountRow {
  org_id: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  internal_price_id: InternalPriceId | null;
  billing_interval: "month" | "year" | null;
}

export interface ProviderEventRow {
  event_id: string;
  event_type:
    | "invoice.paid"
    | "invoice.payment_failed"
    | "charge.refunded"
    | "customer.subscription.updated"
    | "customer.subscription.deleted";
  object_id: string;
  org_id: string;
  event_created: number;
  summary_json: string;
  status: "awaiting_reconciliation" | "reconciled" | "ignored" | "stale" | "rejected";
}

export interface StripeSummary {
  orgId: string;
  objectId: string;
  customerId: string | null;
  subscriptionId: string | null;
  internalPriceId: InternalPriceId;
  providerPriceId: string;
  checkoutIntentId: string | null;
}

export interface ReconciliationSnapshot {
  schema_version: "billing-reconciliation-v1";
  reconciliation_id: string;
  observed_at: string;
  source_event_id: string;
  kind: "payment" | "payment_failure" | "refund" | "subscription";
  org_id: string;
  provider_customer_id: string;
  provider_subscription_id: string;
  provider_object_id: string;
  internal_price_id: InternalPriceId;
  provider_price_id: string;
  provider_status: "paid" | "failed" | "active" | "past_due" | "canceled" | "refunded";
  currency: "usd";
  cash_amount_cents: number;
  net_recurring_amount_cents: number;
  refund_amount_cents: number;
  period_start: string;
  period_end: string;
  cancel_at_period_end: boolean;
}

export type StripeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RuntimeDependencies {
  stripeFetch?: StripeFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  randomUUID?: () => string;
}
