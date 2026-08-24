PRAGMA foreign_keys = ON;

INSERT INTO measurement_boundaries
  (boundary_id, schema_version, release_version, release_commit_sha, release_channel,
   deployment_environment, release_published_at, r0_started_at, github_app_id,
   initialized_message_id, initialized_at)
VALUES ('r0', 'r0-measurement-boundary-v1', '0.16.0',
        '0123456789abcdef0123456789abcdef01234567', 'github_app', 'production',
        '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z', 12345,
        'boundary_legacy_exact', '2026-08-19T00:00:00.000Z');

INSERT INTO organizations (id, slug, display_name, status, created_at) VALUES
  ('org_live', 'org-live', 'Live legacy org', 'active', '2026-08-20T00:00:00.000Z'),
  ('org_successor', 'org-successor', 'Successor legacy org', 'active', '2026-08-20T00:00:00.000Z'),
  ('org_github', 'org-github', 'GitHub legacy org', 'active', '2026-08-20T00:00:00.000Z');

INSERT INTO checkout_intents
  (id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
   contributor_limit, status, provider_session_id, created_by, created_at, expires_at)
VALUES
  ('checkout_live', 'org_live', 'checkout-live-idem', 'team_monthly_usd_v1', 'month', 29900,
   15, 'completed', 'cs_live', 'legacy_actor_redacted', '2026-08-20T00:01:00.000Z', '2026-08-20T00:31:00.000Z'),
  ('checkout_successor_old', 'org_successor', 'checkout-successor-old-idem', 'team_annual_usd_v1', 'year', 299000,
   15, 'completed', 'cs_successor_old', 'legacy_actor_redacted', '2026-08-20T00:02:00.000Z', '2026-08-20T00:32:00.000Z'),
  ('checkout_successor_new', 'org_successor', 'checkout-successor-new-idem', 'team_monthly_usd_v1', 'month', 29900,
   15, 'prepared', NULL, 'legacy_actor_redacted', '2026-08-23T00:02:00.000Z', '2026-08-23T00:32:00.000Z');

INSERT INTO billing_accounts
  (org_id, provider_customer_id, provider_subscription_id, commercial_state,
   internal_price_id, billing_interval, current_period_start, current_period_end,
   current_recognized_mrr_micros, last_reconciled_event_created, last_reconciled_event_id, updated_at)
VALUES
  ('org_live', 'cus_live', 'sub_live', 'paid', 'team_monthly_usd_v1', 'month',
   '2026-08-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', 29900000000, 1787184300, 'evt_live_invoice',
   '2026-08-20T00:05:00.000Z'),
  ('org_successor', 'cus_successor_old', 'sub_successor_old', 'expired', 'team_annual_usd_v1', 'year',
   '2025-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 0, 1787270700, 'evt_successor_deleted',
   '2026-08-21T00:05:00.000Z');

INSERT INTO provider_events
  (event_id, provider, event_type, object_id, org_id, event_created, payload_sha256,
   summary_json, status, received_at, reconciled_at)
VALUES
  ('evt_live_checkout', 'stripe', 'checkout.session.completed', 'cs_live', 'org_live', 1787184060, lower(hex(randomblob(32))),
   json_object('orgId','org_live','objectId','cs_live','customerId','cus_live','subscriptionId','sub_live',
     'internalPriceId','team_monthly_usd_v1','providerPriceId','price_live_monthly','checkoutIntentId','checkout_live',
     'refundId',NULL,'refundAmountCents',NULL,'refundChargeId',NULL,'refundPaymentIntentId',NULL,
     'refundSourcePaymentEventId',NULL,'refundBillingCommandId',NULL),
   'reconciled', '2026-08-20T00:01:01.000Z', '2026-08-20T00:01:02.000Z'),
  ('evt_live_invoice', 'stripe', 'invoice.paid', 'in_live', 'org_live', 1787184300, lower(hex(randomblob(32))),
   json_object('orgId','org_live','objectId','in_live','customerId','cus_live','subscriptionId','sub_live',
     'internalPriceId','team_monthly_usd_v1','providerPriceId','price_live_monthly','checkoutIntentId','checkout_live',
     'refundId',NULL,'refundAmountCents',NULL,'refundChargeId',NULL,'refundPaymentIntentId',NULL,
     'refundSourcePaymentEventId',NULL,'refundBillingCommandId',NULL),
   'reconciled', '2026-08-20T00:05:01.000Z', '2026-08-20T00:05:02.000Z'),
  ('evt_live_awaiting', 'stripe', 'customer.subscription.updated', 'sub_live', 'org_live', 1787184360, lower(hex(randomblob(32))),
   json_object('orgId','org_live','objectId','sub_live','customerId','cus_live','subscriptionId','sub_live',
     'internalPriceId','team_monthly_usd_v1','providerPriceId','price_live_monthly','checkoutIntentId','checkout_live',
     'refundId',NULL,'refundAmountCents',NULL,'refundChargeId',NULL,'refundPaymentIntentId',NULL,
     'refundSourcePaymentEventId',NULL,'refundBillingCommandId',NULL),
   'awaiting_reconciliation', '2026-08-20T00:06:01.000Z', NULL),
  ('evt_successor_checkout', 'stripe', 'checkout.session.completed', 'cs_successor_old', 'org_successor', 1787184120, lower(hex(randomblob(32))),
   json_object('orgId','org_successor','objectId','cs_successor_old','customerId','cus_successor_old','subscriptionId','sub_successor_old',
     'internalPriceId','team_annual_usd_v1','providerPriceId','price_successor_annual','checkoutIntentId','checkout_successor_old',
     'refundId',NULL,'refundAmountCents',NULL,'refundChargeId',NULL,'refundPaymentIntentId',NULL,
     'refundSourcePaymentEventId',NULL,'refundBillingCommandId',NULL),
   'reconciled', '2026-08-20T00:02:01.000Z', '2026-08-20T00:02:02.000Z'),
  ('evt_successor_deleted', 'stripe', 'customer.subscription.deleted', 'sub_successor_old', 'org_successor', 1787270700, lower(hex(randomblob(32))),
   json_object('orgId','org_successor','objectId','sub_successor_old','customerId','cus_successor_old','subscriptionId','sub_successor_old',
     'internalPriceId','team_annual_usd_v1','providerPriceId','price_successor_annual','checkoutIntentId','checkout_successor_old',
     'refundId',NULL,'refundAmountCents',NULL,'refundChargeId',NULL,'refundPaymentIntentId',NULL,
     'refundSourcePaymentEventId',NULL,'refundBillingCommandId',NULL),
   'reconciled', '2026-08-21T00:05:01.000Z', '2026-08-21T00:05:02.000Z');

INSERT INTO billing_commands
  (id, org_id, command_type, idempotency_key, command_json, status, created_by, created_at)
VALUES
  ('command_live_checkout', 'org_live', 'create_checkout_session', 'checkout-live-idem',
   json_object('schema_version','checkout-command-v1','command_id','command_live_checkout','provider','stripe',
     'operation','create_checkout_session','idempotency_key','checkout-live-idem',
     'parameters',json_object('mode','subscription','quantity',1,'provider_price_id','price_live_monthly',
       'internal_price_id','team_monthly_usd_v1','client_reference_id','org_live',
       'metadata',json_object('team_org_id','org_live','internal_price_id','team_monthly_usd_v1',
         'provider_price_id','price_live_monthly','checkout_intent_id','checkout_live','contributor_limit','15')),
     'expires_at','2026-08-20T00:31:00.000Z','provider_result',json_object('session_id','cs_live')),
   'confirmed', 'legacy_actor_redacted', '2026-08-20T00:01:00.000Z'),
  ('command_live_cancel', 'org_live', 'cancel_at_period_end', 'cancel-live-idem',
   json_object('schema_version','billing-command-v1','command_id','command_live_cancel','provider','stripe',
     'operation','cancel_at_period_end','idempotency_key','cancel-live-idem','provider_subscription_id','sub_live',
     'reason','no_longer_needed'),
   'prepared', 'legacy_actor_redacted', '2026-08-20T00:07:00.000Z'),
  ('command_live_refund', 'org_live', 'request_refund', 'refund-live-idem',
   json_object('schema_version','billing-command-v1','command_id','command_live_refund','provider','stripe',
     'operation','request_refund','idempotency_key','refund-live-idem','amount_cents',1000,'currency','usd',
     'source_payment_event_id','evt_live_invoice','paid_features_materially_used',0,'reason','case_by_case'),
   'prepared', 'legacy_actor_redacted', '2026-08-20T00:08:00.000Z'),
  ('command_successor_old', 'org_successor', 'create_checkout_session', 'checkout-successor-old-idem',
   json_object('schema_version','checkout-command-v1','command_id','command_successor_old','provider','stripe',
     'operation','create_checkout_session','idempotency_key','checkout-successor-old-idem',
     'parameters',json_object('mode','subscription','quantity',1,'provider_price_id','price_successor_annual',
       'internal_price_id','team_annual_usd_v1','client_reference_id','org_successor',
       'metadata',json_object('team_org_id','org_successor','internal_price_id','team_annual_usd_v1',
         'provider_price_id','price_successor_annual','checkout_intent_id','checkout_successor_old','contributor_limit','15')),
     'expires_at','2026-08-20T00:32:00.000Z','provider_result',json_object('session_id','cs_successor_old')),
   'confirmed', 'legacy_actor_redacted', '2026-08-20T00:02:00.000Z'),
  ('command_successor_new', 'org_successor', 'create_checkout_session', 'checkout-successor-new-idem',
   json_object('schema_version','checkout-command-v1','command_id','command_successor_new','provider','stripe',
     'operation','create_checkout_session','idempotency_key','checkout-successor-new-idem',
     'parameters',json_object('mode','subscription','quantity',1,'provider_price_id','price_successor_monthly',
       'internal_price_id','team_monthly_usd_v1','client_reference_id','org_successor',
       'metadata',json_object('team_org_id','org_successor','internal_price_id','team_monthly_usd_v1',
         'provider_price_id','price_successor_monthly','checkout_intent_id','checkout_successor_new','contributor_limit','15')),
     'expires_at','2026-08-23T00:32:00.000Z'),
   'prepared', 'legacy_actor_redacted', '2026-08-23T00:02:00.000Z');

INSERT INTO github_deliveries
  (delivery_id, payload_sha256, event_name, action, installation_id, org_id, event_created_at, result, received_at)
VALUES ('delivery_org_created', lower(hex(randomblob(32))), 'installation', 'created', 7001, 'org_github',
        1787185000, 'applied', '2026-08-20T00:16:40.000Z');

INSERT INTO github_installation_provider_proofs
  (delivery_id, installation_id, github_account_node_id, account_type, verified_at, expires_at,
   consumed_at, consumed_by_lane)
VALUES ('delivery_org_created', 7001, 'ORG_NODE_LEGACY', 'Organization',
        '2026-08-20T00:16:40.000Z', '9999-12-31T23:59:59.999Z', '2026-08-20T00:16:41.000Z', 'organization');

INSERT INTO github_installation_claims
  (installation_id, github_account_node_id, org_id, status, claimed_by, claimed_at, updated_at,
   provider_proof_delivery_id, claim_expires_at, bound_at)
VALUES (7001, 'ORG_NODE_LEGACY', 'org_github', 'bound', 'legacy_actor_redacted',
        '2026-08-20T00:16:40.000Z', '2026-08-20T00:16:41.000Z', 'delivery_org_created',
        '9999-12-31T23:59:59.999Z', '2026-08-20T00:16:41.000Z');

INSERT INTO github_installations
  (installation_id, app_id, github_account_node_id, org_id, state, repository_selection,
   last_event_created_at, last_delivery_id, last_reconciliation_id, installed_at, reconciled_at, updated_at)
VALUES (7001, 12345, 'ORG_NODE_LEGACY', 'org_github', 'active', 'all', 1787185000,
        'delivery_org_created', 'recon_org_created', '2026-08-20T00:16:40.000Z',
        '2026-08-20T00:16:42.000Z', '2026-08-20T00:16:42.000Z');

INSERT INTO github_installation_reconciliations
  (reconciliation_id, payload_sha256, source_delivery_id, installation_id, org_id, observed_at, result, applied_at)
VALUES ('recon_org_created', lower(hex(randomblob(32))), 'delivery_org_created', 7001, 'org_github',
        '2026-08-20T00:16:42.000Z', 'applied', '2026-08-20T00:16:42.000Z');

INSERT INTO individual_identities
  (subject_token, canonical_subject_token, github_account_node_id, auth_subject_sha256, token_key_id,
   classification, classification_basis, first_authenticated_at, classification_attested_at,
   eligible_at, status, updated_at)
VALUES ('mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'USER_NODE_LEGACY', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'legacy-key', 'external', 'provider_session_and_non_operator_registry',
        '2026-08-20T00:17:00.000Z', '2026-08-20T00:17:01.000Z',
        NULL, 'active', '2026-08-20T00:17:01.001Z');

INSERT INTO individual_consents
  (subject_token, opted_in, updated_session_sha256, opted_in_at, opted_out_at, updated_at)
VALUES ('mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1,
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        '2026-08-20T00:17:00.500Z', NULL, '2026-08-20T00:17:00.500Z');

INSERT INTO individual_session_mutations
  (session_sha256, action, request_sha256, subject_token, result, applied_at)
VALUES ('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        'measurement_consent',
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'applied', '2026-08-20T00:17:00.500Z');

INSERT INTO individual_measurement_bridge_messages
  (message_id, payload_sha256, message_kind, subject_token, installation_id,
   observed_at, result, received_at)
VALUES ('individual_attestation_legacy_exact',
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        'individual_subject_attestation_v1',
        'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        NULL, '2026-08-20T00:17:01.000Z', 'applied', '2026-08-20T00:17:01.001Z');

INSERT INTO individual_subject_attestations
  (message_id, subject_token, classification, classification_basis, observed_at)
VALUES ('individual_attestation_legacy_exact',
        'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'external', 'provider_session_and_non_operator_registry',
        '2026-08-20T00:17:01.000Z');

INSERT INTO github_personal_deliveries
  (delivery_id, payload_sha256, event_name, action, installation_id, subject_token,
   account_type, event_created_at, result, received_at)
VALUES ('delivery_personal_created', lower(hex(randomblob(32))), 'installation', 'created', 7002,
        'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'User', 1787185020,
        'applied', '2026-08-20T00:17:00.000Z');

INSERT INTO github_installation_provider_proofs
  (delivery_id, installation_id, github_account_node_id, account_type, verified_at, expires_at,
   consumed_at, consumed_by_lane)
VALUES ('delivery_personal_created', 7002, 'USER_NODE_LEGACY', 'User',
        '2026-08-20T00:17:00.000Z', '9999-12-31T23:59:59.999Z', '2026-08-20T00:17:01.000Z', 'personal');

INSERT INTO github_personal_installation_claims
  (installation_id, github_account_node_id, subject_token, account_type, status,
   claimed_session_sha256, claimed_at, updated_at, provider_proof_delivery_id, claim_expires_at, bound_at)
VALUES (7002, 'USER_NODE_LEGACY',
        'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'User', 'bound',
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        '2026-08-20T00:17:00.000Z', '2026-08-20T00:17:01.000Z', 'delivery_personal_created',
        '9999-12-31T23:59:59.999Z', '2026-08-20T00:17:01.000Z');

INSERT INTO github_personal_installations
  (installation_id, app_id, github_account_node_id, subject_token, account_type, state,
   repository_selection, last_event_created_at, last_delivery_id, last_reconciliation_id,
   installed_at, reconciled_at, updated_at)
VALUES (7002, 12345, 'USER_NODE_LEGACY',
        'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'User', 'active',
        'all', 1787185020, 'delivery_personal_created', 'recon_personal_created',
        '2026-08-20T00:17:00.000Z', '2026-08-20T00:17:02.000Z', '2026-08-20T00:17:02.000Z');

INSERT INTO github_personal_installation_reconciliations
  (reconciliation_id, payload_sha256, source_delivery_id, installation_id, subject_token,
   account_type, observed_at, result, applied_at)
VALUES ('recon_personal_created', lower(hex(randomblob(32))), 'delivery_personal_created', 7002,
        'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'User',
        '2026-08-20T00:17:02.000Z', 'applied', '2026-08-20T00:17:02.000Z');
