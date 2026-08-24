export const TEAM_TIER = "team" as const;
export const TEAM_CONTRIBUTOR_LIMIT = 15 as const;

export const TEAM_PRICES = {
  team_monthly_usd_v1: {
    internalPriceId: "team_monthly_usd_v1",
    interval: "month",
    listAmountCents: 29_900,
    billingMonths: 1
  },
  team_annual_usd_v1: {
    internalPriceId: "team_annual_usd_v1",
    interval: "year",
    listAmountCents: 299_000,
    billingMonths: 12
  }
} as const;

export type InternalPriceId = keyof typeof TEAM_PRICES;
export type BillingInterval = (typeof TEAM_PRICES)[InternalPriceId]["interval"];

export function isInternalPriceId(value: unknown): value is InternalPriceId {
  return typeof value === "string" && Object.hasOwn(TEAM_PRICES, value);
}

export function providerPriceId(env: Env, internalPriceId: InternalPriceId): string {
  const value =
    internalPriceId === "team_monthly_usd_v1"
      ? env.STRIPE_PRICE_TEAM_MONTHLY
      : env.STRIPE_PRICE_TEAM_ANNUAL;
  if (!value || value === "CONFIGURE_BEFORE_DEPLOYMENT") {
    throw new Error("provider price catalog is not configured");
  }
  return value;
}

export function recognizedMrrMicros(netRecurringAmountCents: number, internalPriceId: InternalPriceId): number {
  const months = TEAM_PRICES[internalPriceId].billingMonths;
  return Math.round((netRecurringAmountCents * 1_000_000) / months);
}

export function publicCatalog(): object {
  return {
    schema_version: "team-price-catalog-v1",
    tier: TEAM_TIER,
    contributor_limit: TEAM_CONTRIBUTOR_LIMIT,
    currency: "usd",
    prices: Object.values(TEAM_PRICES).map((price) => ({
      internal_price_id: price.internalPriceId,
      billing_interval: price.interval,
      list_amount_cents: price.listAmountCents
    })),
    boundaries: {
      checkout_is_not_payment: true,
      payment_requires_signed_webhook_and_reconciliation: true,
      paid_access_never_changes_verdict_semantics: true
    }
  };
}
