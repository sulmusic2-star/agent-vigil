PRAGMA foreign_keys = ON;

INSERT INTO organizations (id, slug, display_name, status, created_at)
VALUES ('org_ambiguous', 'org-ambiguous', 'Ambiguous legacy org', 'active', '2026-08-20T00:00:00.000Z');

INSERT INTO checkout_intents
  (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
   contributor_limit, status, provider_session_id, created_by, created_at, expires_at)
VALUES
  ('checkout_ambiguous_a', 'org_ambiguous', 'ambiguous-a', 'team_monthly_usd_v1', 'month', 29900,
   15, 'completed', 'cs_ambiguous_a', 'legacy_actor_redacted', '2026-08-20T00:01:00.000Z', '2026-08-20T00:31:00.000Z'),
  ('checkout_ambiguous_b', 'org_ambiguous', 'ambiguous-b', 'team_monthly_usd_v1', 'month', 29900,
   15, 'completed', 'cs_ambiguous_b', 'legacy_actor_redacted', '2026-08-20T00:02:00.000Z', '2026-08-20T00:32:00.000Z');

INSERT INTO billing_accounts
  (org_id, provider_customer_id, provider_subscription_id, commercial_state,
   internal_price_id, billing_interval, updated_at)
VALUES ('org_ambiguous', 'cus_ambiguous', 'sub_ambiguous', 'paid',
        'team_monthly_usd_v1', 'month', '2026-08-20T00:05:00.000Z');

INSERT INTO provider_events
  (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
   summary_json, status, received_at, reconciled_at)
VALUES
  ('evt_ambiguous_a', 'stripe', 'checkout.session.completed', 'cs_ambiguous_a', 'org_ambiguous', 1787184060,
   lower(hex(randomblob(32))),
   json_object('orgId','org_ambiguous','objectId','cs_ambiguous_a','customerId','cus_ambiguous',
     'subscriptionId','sub_ambiguous','internalPriceId','team_monthly_usd_v1',
     'providerPriceId','price_ambiguous','checkoutIntentId','checkout_ambiguous_a'),
   'reconciled', '2026-08-20T00:01:01.000Z', '2026-08-20T00:01:02.000Z'),
  ('evt_ambiguous_b', 'stripe', 'checkout.session.completed', 'cs_ambiguous_b', 'org_ambiguous', 1787184120,
   lower(hex(randomblob(32))),
   json_object('orgId','org_ambiguous','objectId','cs_ambiguous_b','customerId','cus_ambiguous',
     'subscriptionId','sub_ambiguous','internalPriceId','team_monthly_usd_v1',
     'providerPriceId','price_ambiguous','checkoutIntentId','checkout_ambiguous_b'),
   'reconciled', '2026-08-20T00:02:01.000Z', '2026-08-20T00:02:02.000Z');
