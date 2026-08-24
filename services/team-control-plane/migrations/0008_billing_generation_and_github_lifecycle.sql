PRAGMA foreign_keys = ON;

-- A tenant may buy Team again only after the prior provider subscription has a
-- reconciled terminal fact. The generation is the immutable identity boundary;
-- the append-only event table preserves every transition and late-event result.
ALTER TABLE checkout_intents
  ADD COLUMN billing_generation INTEGER NOT NULL DEFAULT 1 CHECK (billing_generation > 0);

ALTER TABLE billing_accounts
  ADD COLUMN billing_generation INTEGER NOT NULL DEFAULT 1 CHECK (billing_generation > 0);

CREATE TABLE billing_generations (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  checkout_intent_id TEXT UNIQUE,
  internal_price_id TEXT NOT NULL CHECK (internal_price_id IN ('team_monthly_usd_v1', 'team_annual_usd_v1')),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'bound', 'terminal_verified', 'retired', 'abandoned')),
  provider_checkout_session_id TEXT UNIQUE,
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE,
  reserved_at TEXT NOT NULL,
  bound_at TEXT,
  terminal_verified_at TEXT,
  terminal_source_event_id TEXT,
  retired_at TEXT,
  PRIMARY KEY (org_id, generation),
  CHECK ((provider_customer_id IS NULL) = (provider_subscription_id IS NULL)),
  CHECK (status NOT IN ('reserved', 'abandoned') OR (provider_customer_id IS NULL AND provider_subscription_id IS NULL)),
  CHECK (status IN ('reserved', 'abandoned') OR (provider_customer_id IS NOT NULL AND provider_subscription_id IS NOT NULL)),
  CHECK ((terminal_verified_at IS NULL) = (terminal_source_event_id IS NULL)),
  CHECK (status NOT IN ('terminal_verified', 'retired') OR terminal_source_event_id IS NOT NULL),
  CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);

CREATE UNIQUE INDEX billing_generations_one_live_per_org
  ON billing_generations(org_id) WHERE status IN ('reserved', 'bound');

CREATE TABLE billing_generation_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'reserved', 'bound', 'terminal_verified', 'retired', 'abandoned',
      'late_provider_event_ignored', 'unexpected_subscription_reserved',
      'unexpected_subscription_compensated', 'historical_refund_applied'
    )
  ),
  source_ref TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (org_id, generation) REFERENCES billing_generations(org_id, generation)
);

CREATE INDEX billing_generation_events_history_idx
  ON billing_generation_events(org_id, generation, occurred_at, id);

CREATE UNIQUE INDEX billing_generation_events_source_idx
  ON billing_generation_events(org_id, generation, event_type, source_ref);

CREATE TRIGGER billing_generation_event_update_guard
BEFORE UPDATE ON billing_generation_events
BEGIN
  SELECT RAISE(ABORT, 'billing generation history is append only');
END;

CREATE TRIGGER billing_generation_event_delete_guard
BEFORE DELETE ON billing_generation_events
BEGIN
  SELECT RAISE(ABORT, 'billing generation history is append only');
END;

-- Provider refund deliveries may arrive out of order. Preserve every exact
-- refund while requiring the locally booked total to fit both the source
-- payment and the greatest provider cumulative observation seen so far.
DROP TRIGGER provider_refund_cumulative_guard;

CREATE TRIGGER provider_refund_cumulative_guard
BEFORE INSERT ON provider_refund_applications
FOR EACH ROW
WHEN (NEW.billing_command_id IS NOT NULL AND NOT EXISTS (
       SELECT 1
         FROM billing_commands
        WHERE id = NEW.billing_command_id
          AND org_id = NEW.org_id
          AND command_type = 'request_refund'
          AND status = 'provider_accepted'
          AND json_extract(command_json, '$.provider_result.refund_id') = NEW.provider_refund_id
          AND json_extract(command_json, '$.provider_result.charge_id') = NEW.provider_charge_id
          AND json_extract(command_json, '$.provider_result.payment_intent_id') = NEW.provider_payment_intent_id
          AND json_extract(command_json, '$.provider_result.source_payment_event_id') = NEW.source_payment_event_id
          AND json_extract(command_json, '$.provider_result.amount_cents') = NEW.amount_cents
     ))
  OR (NEW.billing_command_id IS NULL AND NOT EXISTS (
       SELECT 1
         FROM billing_commands
        WHERE org_id = NEW.org_id
          AND command_type = 'request_refund'
          AND status IN ('provider_accepted', 'confirmed')
          AND json_extract(command_json, '$.provider_result.charge_id') = NEW.provider_charge_id
          AND json_extract(command_json, '$.provider_result.payment_intent_id') = NEW.provider_payment_intent_id
          AND json_extract(command_json, '$.provider_result.source_payment_event_id') = NEW.source_payment_event_id
     ))
  OR NEW.cumulative_amount_cents > COALESCE((
       SELECT amount_cents
         FROM cash_ledger
        WHERE org_id = NEW.org_id
          AND source_event_id = NEW.source_payment_event_id
          AND entry_type = 'payment'
     ), 0)
  OR (COALESCE((
        SELECT SUM(amount_cents)
          FROM provider_refund_applications
         WHERE org_id = NEW.org_id
           AND source_payment_event_id = NEW.source_payment_event_id
      ), 0) + NEW.amount_cents) > COALESCE((
       SELECT amount_cents
         FROM cash_ledger
        WHERE org_id = NEW.org_id
          AND source_event_id = NEW.source_payment_event_id
          AND entry_type = 'payment'
     ), 0)
  OR (COALESCE((
        SELECT SUM(amount_cents)
          FROM provider_refund_applications
         WHERE org_id = NEW.org_id
           AND source_payment_event_id = NEW.source_payment_event_id
      ), 0) + NEW.amount_cents) > MAX(
       NEW.cumulative_amount_cents,
       COALESCE((
         SELECT MAX(cumulative_amount_cents)
           FROM provider_refund_applications
          WHERE org_id = NEW.org_id
            AND source_payment_event_id = NEW.source_payment_event_id
       ), 0)
     )
BEGIN
  SELECT RAISE(ABORT, 'provider refund cumulative amount conflict');
END;

CREATE TRIGGER billing_generation_identity_guard
BEFORE UPDATE OF checkout_intent_id, internal_price_id, provider_checkout_session_id,
                 provider_customer_id, provider_subscription_id ON billing_generations
FOR EACH ROW
WHEN (OLD.checkout_intent_id IS NOT NULL AND NEW.checkout_intent_id IS NOT OLD.checkout_intent_id)
  OR NEW.internal_price_id IS NOT OLD.internal_price_id
  OR (OLD.provider_checkout_session_id IS NOT NULL AND NEW.provider_checkout_session_id IS NOT OLD.provider_checkout_session_id)
  OR (OLD.provider_customer_id IS NOT NULL AND NEW.provider_customer_id IS NOT OLD.provider_customer_id)
  OR (OLD.provider_subscription_id IS NOT NULL AND NEW.provider_subscription_id IS NOT OLD.provider_subscription_id)
BEGIN
  SELECT RAISE(ABORT, 'billing generation identity is immutable');
END;

CREATE TRIGGER billing_generation_status_guard
BEFORE UPDATE OF status ON billing_generations
FOR EACH ROW
WHEN NEW.status <> OLD.status
 AND NOT (
   (OLD.status = 'reserved' AND NEW.status IN ('bound', 'abandoned')) OR
   (OLD.status = 'bound' AND NEW.status = 'terminal_verified') OR
   (OLD.status = 'terminal_verified' AND NEW.status = 'retired')
 )
BEGIN
  SELECT RAISE(ABORT, 'billing generation transition is invalid');
END;

CREATE TRIGGER billing_account_generation_insert_guard
BEFORE INSERT ON billing_accounts
FOR EACH ROW
WHEN NEW.provider_subscription_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM billing_generations
    WHERE org_id = NEW.org_id AND generation = NEW.billing_generation
      AND provider_customer_id = NEW.provider_customer_id
      AND provider_subscription_id = NEW.provider_subscription_id
      AND status IN ('bound', 'terminal_verified')
 )
BEGIN
  SELECT RAISE(ABORT, 'billing account lacks exact current generation');
END;

CREATE TRIGGER billing_account_generation_update_guard
BEFORE UPDATE OF provider_customer_id, provider_subscription_id, billing_generation ON billing_accounts
FOR EACH ROW
WHEN NEW.provider_subscription_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM billing_generations
    WHERE org_id = NEW.org_id AND generation = NEW.billing_generation
      AND provider_customer_id = NEW.provider_customer_id
      AND provider_subscription_id = NEW.provider_subscription_id
      AND status IN ('bound', 'terminal_verified')
 )
BEGIN
  SELECT RAISE(ABORT, 'billing account lacks exact current generation');
END;

-- Refuse legacy state that cannot be split into an exact historical
-- subscription and, when present, one later live successor checkout. In
-- particular, a refunded/expired projection is never terminal proof and a
-- latest checkout must not be combined with an older account binding.
CREATE TABLE migration_0008_billing_binding_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO migration_0008_billing_binding_guard (valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM billing_accounts ba
   WHERE ba.provider_subscription_id IS NOT NULL
     AND (
       ba.provider_customer_id IS NULL OR ba.internal_price_id IS NULL OR
       (
         SELECT COUNT(*) FROM checkout_intents origin
          WHERE origin.org_id = ba.org_id
            AND origin.provider_session_id IS NOT NULL
            AND origin.internal_price_id = ba.internal_price_id
            AND EXISTS (
              SELECT 1 FROM provider_events bound_event
               WHERE bound_event.org_id = ba.org_id
                 AND bound_event.event_type = 'checkout.session.completed'
                 AND bound_event.status = 'reconciled'
                 AND bound_event.object_id = origin.provider_session_id
                 AND json_extract(bound_event.summary_json, '$.customerId') = ba.provider_customer_id
                 AND json_extract(bound_event.summary_json, '$.subscriptionId') = ba.provider_subscription_id
                 AND json_extract(bound_event.summary_json, '$.internalPriceId') = ba.internal_price_id
            )
       ) <> 1 OR
       (
         EXISTS (
           SELECT 1 FROM checkout_intents live
            WHERE live.org_id = ba.org_id
              AND live.status IN ('prepared', 'executing', 'provider_created', 'compensating')
         )
         AND (
           NOT EXISTS (
             SELECT 1 FROM provider_events terminal
              WHERE terminal.org_id = ba.org_id
                AND terminal.event_type = 'customer.subscription.deleted'
                AND terminal.status = 'reconciled'
                AND json_extract(terminal.summary_json, '$.customerId') = ba.provider_customer_id
                AND json_extract(terminal.summary_json, '$.subscriptionId') = ba.provider_subscription_id
           ) OR
           NOT EXISTS (
             SELECT 1 FROM checkout_intents origin
              WHERE origin.org_id = ba.org_id
                AND origin.provider_session_id IS NOT NULL
                AND origin.internal_price_id = ba.internal_price_id
                AND EXISTS (
                  SELECT 1 FROM provider_events bound_event
                   WHERE bound_event.org_id = ba.org_id
                     AND bound_event.event_type = 'checkout.session.completed'
                     AND bound_event.status = 'reconciled'
                     AND bound_event.object_id = origin.provider_session_id
                     AND json_extract(bound_event.summary_json, '$.customerId') = ba.provider_customer_id
                     AND json_extract(bound_event.summary_json, '$.subscriptionId') = ba.provider_subscription_id
                     AND json_extract(bound_event.summary_json, '$.internalPriceId') = ba.internal_price_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM checkout_intents live_same
                   WHERE live_same.id = origin.id
                     AND live_same.status IN ('prepared', 'executing', 'provider_created', 'compensating')
                )
           )
         )
       )
     )
) THEN 1 ELSE 0 END;

DROP TABLE migration_0008_billing_binding_guard;

-- Generation 1 is the exact legacy provider subscription when one exists, or
-- the sole live provider-less checkout otherwise. A verified terminal legacy
-- subscription is immediately retired only when a distinct live successor is
-- already present.
INSERT INTO billing_generations (
  org_id, generation, checkout_intent_id, internal_price_id, status,
  provider_checkout_session_id, provider_customer_id, provider_subscription_id,
  reserved_at, bound_at, terminal_verified_at, terminal_source_event_id, retired_at
)
SELECT ba.org_id, 1,
       CASE WHEN ba.provider_subscription_id IS NOT NULL THEN (
           SELECT origin.id FROM checkout_intents origin
            WHERE origin.org_id = ba.org_id AND origin.provider_session_id IS NOT NULL
              AND origin.internal_price_id = ba.internal_price_id
              AND EXISTS (
                SELECT 1 FROM provider_events bound_event
                 WHERE bound_event.org_id = ba.org_id
                   AND bound_event.event_type = 'checkout.session.completed'
                   AND bound_event.status = 'reconciled'
                   AND bound_event.object_id = origin.provider_session_id
                   AND json_extract(bound_event.summary_json, '$.customerId') = ba.provider_customer_id
                   AND json_extract(bound_event.summary_json, '$.subscriptionId') = ba.provider_subscription_id
                   AND json_extract(bound_event.summary_json, '$.internalPriceId') = ba.internal_price_id
              )
            ORDER BY origin.created_at, origin.id LIMIT 1
       ) ELSE (
         SELECT live.id FROM checkout_intents live
          WHERE live.org_id = ba.org_id
            AND live.status IN ('prepared', 'executing', 'provider_created', 'compensating')
          ORDER BY live.created_at DESC, live.id DESC LIMIT 1
       ) END,
       COALESCE(ba.internal_price_id, (
         SELECT live.internal_price_id FROM checkout_intents live
          WHERE live.org_id = ba.org_id
            AND live.status IN ('prepared', 'executing', 'provider_created', 'compensating')
          ORDER BY live.created_at DESC, live.id DESC LIMIT 1
       ), 'team_monthly_usd_v1'),
       CASE
         WHEN ba.provider_subscription_id IS NULL THEN 'reserved'
         WHEN EXISTS (
           SELECT 1 FROM provider_events terminal
            WHERE terminal.org_id = ba.org_id
              AND terminal.event_type = 'customer.subscription.deleted'
              AND terminal.status = 'reconciled'
              AND json_extract(terminal.summary_json, '$.customerId') = ba.provider_customer_id
              AND json_extract(terminal.summary_json, '$.subscriptionId') = ba.provider_subscription_id
         ) AND EXISTS (
           SELECT 1 FROM checkout_intents live
            WHERE live.org_id = ba.org_id
              AND live.status IN ('prepared', 'executing', 'provider_created', 'compensating')
         ) THEN 'retired'
         WHEN EXISTS (
           SELECT 1 FROM provider_events terminal
            WHERE terminal.org_id = ba.org_id
              AND terminal.event_type = 'customer.subscription.deleted'
              AND terminal.status = 'reconciled'
              AND json_extract(terminal.summary_json, '$.customerId') = ba.provider_customer_id
              AND json_extract(terminal.summary_json, '$.subscriptionId') = ba.provider_subscription_id
         ) THEN 'terminal_verified'
         ELSE 'bound'
       END,
       CASE WHEN ba.provider_subscription_id IS NOT NULL THEN (
           SELECT origin.provider_session_id FROM checkout_intents origin
            WHERE origin.org_id = ba.org_id AND origin.provider_session_id IS NOT NULL
              AND origin.internal_price_id = ba.internal_price_id
              AND EXISTS (
                SELECT 1 FROM provider_events bound_event
                 WHERE bound_event.org_id = ba.org_id
                   AND bound_event.event_type = 'checkout.session.completed'
                   AND bound_event.status = 'reconciled'
                   AND bound_event.object_id = origin.provider_session_id
                   AND json_extract(bound_event.summary_json, '$.customerId') = ba.provider_customer_id
                   AND json_extract(bound_event.summary_json, '$.subscriptionId') = ba.provider_subscription_id
                   AND json_extract(bound_event.summary_json, '$.internalPriceId') = ba.internal_price_id
              )
            ORDER BY origin.created_at, origin.id LIMIT 1
       ) ELSE (
         SELECT live.provider_session_id FROM checkout_intents live
          WHERE live.org_id = ba.org_id
            AND live.status IN ('prepared', 'executing', 'provider_created', 'compensating')
          ORDER BY live.created_at DESC, live.id DESC LIMIT 1
       ) END,
       ba.provider_customer_id, ba.provider_subscription_id, ba.updated_at,
       CASE WHEN ba.provider_subscription_id IS NOT NULL THEN ba.updated_at ELSE NULL END,
       CASE WHEN ba.provider_subscription_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM provider_events terminal
          WHERE terminal.org_id = ba.org_id
            AND terminal.event_type = 'customer.subscription.deleted'
            AND terminal.status = 'reconciled'
            AND json_extract(terminal.summary_json, '$.customerId') = ba.provider_customer_id
            AND json_extract(terminal.summary_json, '$.subscriptionId') = ba.provider_subscription_id
       ) THEN ba.updated_at ELSE NULL END,
       CASE WHEN ba.provider_subscription_id IS NOT NULL THEN (
         SELECT terminal.event_id FROM provider_events terminal
          WHERE terminal.org_id = ba.org_id
            AND terminal.event_type = 'customer.subscription.deleted'
            AND terminal.status = 'reconciled'
            AND json_extract(terminal.summary_json, '$.customerId') = ba.provider_customer_id
            AND json_extract(terminal.summary_json, '$.subscriptionId') = ba.provider_subscription_id
          ORDER BY terminal.event_created DESC, terminal.event_id DESC LIMIT 1
       ) ELSE NULL END,
       CASE WHEN ba.provider_subscription_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM provider_events terminal
          WHERE terminal.org_id = ba.org_id
            AND terminal.event_type = 'customer.subscription.deleted'
            AND terminal.status = 'reconciled'
            AND json_extract(terminal.summary_json, '$.customerId') = ba.provider_customer_id
            AND json_extract(terminal.summary_json, '$.subscriptionId') = ba.provider_subscription_id
       ) AND EXISTS (
         SELECT 1 FROM checkout_intents live
          WHERE live.org_id = ba.org_id
            AND live.status IN ('prepared', 'executing', 'provider_created', 'compensating')
       ) THEN (
         SELECT live.created_at FROM checkout_intents live
          WHERE live.org_id = ba.org_id
            AND live.status IN ('prepared', 'executing', 'provider_created', 'compensating')
          ORDER BY live.created_at DESC, live.id DESC LIMIT 1
       ) ELSE NULL END
  FROM billing_accounts ba
 WHERE ba.provider_subscription_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM checkout_intents live
       WHERE live.org_id = ba.org_id
         AND live.status IN ('prepared', 'executing', 'provider_created', 'compensating')
    );

-- A legacy live successor is generation 2 only when generation 1 has exact
-- reconciled terminal proof. The checkout keeps its own price/session and is
-- never cross-bound to the retired subscription.
INSERT INTO billing_generations (
  org_id, generation, checkout_intent_id, internal_price_id, status,
  provider_checkout_session_id, reserved_at
)
SELECT ba.org_id, 2, live.id, live.internal_price_id, 'reserved', live.provider_session_id, live.created_at
  FROM billing_accounts ba
  JOIN checkout_intents live ON live.id = (
    SELECT candidate.id FROM checkout_intents candidate
     WHERE candidate.org_id = ba.org_id
       AND candidate.status IN ('prepared', 'executing', 'provider_created', 'compensating')
     ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
  )
 WHERE ba.provider_subscription_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM billing_generations prior
      WHERE prior.org_id = ba.org_id AND prior.generation = 1
        AND prior.status = 'retired' AND prior.terminal_source_event_id IS NOT NULL
   );

UPDATE checkout_intents SET billing_generation = 2
 WHERE id IN (SELECT checkout_intent_id FROM billing_generations WHERE generation = 2);

INSERT INTO billing_generation_events (id, org_id, generation, event_type, source_ref, occurred_at)
SELECT 'billing_generation_migration_primary_' || org_id, org_id, generation,
       CASE WHEN status = 'terminal_verified' THEN 'terminal_verified'
            WHEN status = 'retired' THEN 'terminal_verified'
            WHEN status = 'bound' THEN 'bound' ELSE 'reserved' END,
       COALESCE(terminal_source_event_id, checkout_intent_id, 'migration_0008'), reserved_at
  FROM billing_generations WHERE generation = 1;

INSERT INTO billing_generation_events (id, org_id, generation, event_type, source_ref, occurred_at)
SELECT 'billing_generation_migration_retired_' || org_id, org_id, generation,
       'retired', checkout_intent_id, retired_at
  FROM billing_generations WHERE generation = 1 AND status = 'retired';

INSERT INTO billing_generation_events (id, org_id, generation, event_type, source_ref, occurred_at)
SELECT 'billing_generation_migration_successor_' || org_id, org_id, generation,
       'reserved', checkout_intent_id, reserved_at
  FROM billing_generations WHERE generation = 2;

-- Terminal status is provider truth, never a local commercial-state shortcut.
-- The triggering reconciliation must be the exact reconciled Stripe deletion
-- event for this immutable generation and provider subscription.
CREATE TRIGGER billing_generation_terminal_proof_guard
BEFORE UPDATE OF status, terminal_source_event_id ON billing_generations
FOR EACH ROW
WHEN NEW.status = 'terminal_verified'
 AND (
   OLD.status <> 'bound' OR
   NEW.terminal_source_event_id IS NULL OR
   NOT EXISTS (
     SELECT 1 FROM provider_events pe
      WHERE pe.event_id = NEW.terminal_source_event_id
        AND pe.org_id = NEW.org_id
        AND pe.event_type = 'customer.subscription.deleted'
        AND pe.status = 'reconciled'
        AND json_extract(pe.summary_json, '$.billingGeneration') = NEW.generation
        AND json_extract(pe.summary_json, '$.customerId') = NEW.provider_customer_id
        AND json_extract(pe.summary_json, '$.subscriptionId') = NEW.provider_subscription_id
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'billing generation lacks exact terminal provider proof');
END;

CREATE TABLE checkout_subscription_compensations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  billing_command_id TEXT NOT NULL REFERENCES billing_commands(id) ON DELETE RESTRICT,
  checkout_intent_id TEXT NOT NULL REFERENCES checkout_intents(id) ON DELETE RESTRICT,
  billing_generation INTEGER NOT NULL CHECK (billing_generation > 0),
  provider_event_id TEXT NOT NULL UNIQUE REFERENCES provider_events(event_id) ON DELETE RESTRICT,
  provider_session_id TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unexpected_session', 'unexpected_generation_binding')),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'executing', 'completed')),
  resume_command_status TEXT NOT NULL CHECK (resume_command_status IN ('provider_accepted', 'confirmed', 'canceled')),
  execution_lease_id TEXT,
  execution_lease_expires_at TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (org_id, billing_generation) REFERENCES billing_generations(org_id, generation),
  CHECK (
    (status = 'executing' AND execution_lease_id IS NOT NULL AND execution_lease_expires_at IS NOT NULL) OR
    (status <> 'executing' AND execution_lease_id IS NULL AND execution_lease_expires_at IS NULL)
  ),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX checkout_subscription_compensations_provider_binding
  ON checkout_subscription_compensations(provider_session_id, provider_subscription_id);

-- The last statement in every multi-table workflow inserts one of these. A
-- failed invariant produces valid=0, trips the CHECK, and rolls back the whole
-- D1 batch instead of committing partial zero-row secondary effects.
CREATE TABLE workflow_integrity_receipts (
  id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  created_at TEXT NOT NULL
);

-- v7 Stripe objects predate billing-generation metadata. Only generations
-- reconstructed from one exact local tenant/customer/subscription/price/session
-- binding are eligible for the legacy bridge. Runtime records a separate
-- applied receipt for every later provider event that consumes this eligibility.
INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
SELECT 'integrity_legacy_billing_generation_bridge_eligible_' || org_id || '_' || generation,
       'legacy_billing_generation_bridge_eligible', org_id || ':' || generation, 1, reserved_at
  FROM billing_generations
 WHERE provider_checkout_session_id IS NOT NULL
   AND (
     (status IN ('bound', 'terminal_verified', 'retired')
       AND provider_customer_id IS NOT NULL AND provider_subscription_id IS NOT NULL)
     OR (
       status = 'reserved' AND provider_customer_id IS NULL AND provider_subscription_id IS NULL
       AND EXISTS (
         SELECT 1 FROM checkout_intents ci
          WHERE ci.org_id = billing_generations.org_id
            AND ci.id = billing_generations.checkout_intent_id
            AND ci.status = 'provider_created'
            AND ci.provider_session_id = billing_generations.provider_checkout_session_id
       )
     )
   );

-- Normalize already-stored v7 provider summaries when and only when their full
-- immutable provider identity resolves to exactly one migrated generation. The
-- reported generation stays JSON null so an operator can distinguish a legacy
-- bridge from provider-supplied generation metadata.
UPDATE provider_events AS pe
   SET summary_json = json_set(
     pe.summary_json,
     '$.reportedInternalPriceId', json_extract(pe.summary_json, '$.internalPriceId'),
     '$.reportedProviderPriceId', json_extract(pe.summary_json, '$.providerPriceId'),
     '$.billingGeneration', CAST((
       SELECT bg.generation FROM billing_generations bg
        WHERE bg.org_id = pe.org_id
          AND bg.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
          AND bg.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
          AND bg.internal_price_id = json_extract(pe.summary_json, '$.internalPriceId')
          AND (
            json_extract(pe.summary_json, '$.checkoutIntentId') IS NULL OR
            bg.checkout_intent_id = json_extract(pe.summary_json, '$.checkoutIntentId')
          )
          AND (
            pe.event_type <> 'checkout.session.completed' OR
            bg.provider_checkout_session_id = pe.object_id
          )
     ) AS INTEGER),
     '$.reportedBillingGeneration', NULL,
     '$.billingGenerationSource', 'legacy_unique_binding',
     '$.checkoutSessionId', CASE
       WHEN pe.event_type = 'checkout.session.completed' THEN pe.object_id ELSE NULL
     END
   )
 WHERE json_valid(pe.summary_json)
   AND (
     SELECT COUNT(*) FROM billing_generations bg
      WHERE bg.org_id = pe.org_id
        AND bg.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
        AND bg.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
        AND bg.internal_price_id = json_extract(pe.summary_json, '$.internalPriceId')
        AND (
          json_extract(pe.summary_json, '$.checkoutIntentId') IS NULL OR
          bg.checkout_intent_id = json_extract(pe.summary_json, '$.checkoutIntentId')
        )
        AND (
          pe.event_type <> 'checkout.session.completed' OR
          bg.provider_checkout_session_id = pe.object_id
        )
   ) = 1;

INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
SELECT 'integrity_legacy_billing_generation_bridge_applied_' || pe.event_id,
       'legacy_billing_generation_bridge_applied', pe.event_id,
       CASE WHEN EXISTS (
         SELECT 1 FROM billing_generations bg
         JOIN workflow_integrity_receipts eligible
           ON eligible.workflow_type = 'legacy_billing_generation_bridge_eligible'
          AND eligible.source_ref = bg.org_id || ':' || bg.generation
          AND eligible.valid = 1
        WHERE bg.org_id = pe.org_id
          AND bg.generation = CAST(json_extract(pe.summary_json, '$.billingGeneration') AS INTEGER)
          AND bg.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
          AND bg.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
          AND bg.internal_price_id = json_extract(pe.summary_json, '$.internalPriceId')
          AND json_extract(pe.summary_json, '$.billingGenerationSource') = 'legacy_unique_binding'
          AND json_extract(pe.summary_json, '$.reportedBillingGeneration') IS NULL
       ) THEN 1 ELSE 0 END,
       pe.received_at
  FROM provider_events pe
 WHERE json_extract(pe.summary_json, '$.billingGenerationSource') = 'legacy_unique_binding';

-- Normalize v7 executable commands from their exact reservation/binding. A
-- create command stores the generation as Stripe metadata text; cancellation
-- stores the same generation as an integer in its local execution contract.
UPDATE billing_commands AS bc
   SET command_json = json_set(
     bc.command_json,
     '$.parameters.metadata.billing_generation', CAST((
       SELECT bg.generation
         FROM billing_generations bg
         JOIN checkout_intents ci ON ci.id = bg.checkout_intent_id AND ci.org_id = bg.org_id
        WHERE bg.org_id = bc.org_id
          AND ci.id = json_extract(bc.command_json, '$.parameters.metadata.checkout_intent_id')
          AND ci.internal_price_id = json_extract(bc.command_json, '$.parameters.internal_price_id')
          AND json_extract(bc.command_json, '$.parameters.metadata.team_org_id') = bc.org_id
          AND json_extract(bc.command_json, '$.parameters.metadata.internal_price_id') = ci.internal_price_id
     ) AS TEXT)
   )
 WHERE bc.command_type = 'create_checkout_session'
   AND json_valid(bc.command_json)
   AND (
     SELECT COUNT(*)
       FROM billing_generations bg
       JOIN checkout_intents ci ON ci.id = bg.checkout_intent_id AND ci.org_id = bg.org_id
      WHERE bg.org_id = bc.org_id
        AND ci.id = json_extract(bc.command_json, '$.parameters.metadata.checkout_intent_id')
        AND ci.internal_price_id = json_extract(bc.command_json, '$.parameters.internal_price_id')
        AND json_extract(bc.command_json, '$.parameters.metadata.team_org_id') = bc.org_id
        AND json_extract(bc.command_json, '$.parameters.metadata.internal_price_id') = ci.internal_price_id
   ) = 1;

UPDATE billing_commands AS bc
   SET command_json = json_set(
     bc.command_json,
     '$.billing_generation', CAST((
       SELECT bg.generation FROM billing_generations bg
        WHERE bg.org_id = bc.org_id
          AND bg.provider_subscription_id = json_extract(bc.command_json, '$.provider_subscription_id')
     ) AS INTEGER)
   )
 WHERE bc.command_type = 'cancel_at_period_end'
   AND json_valid(bc.command_json)
   AND (
     SELECT COUNT(*) FROM billing_generations bg
      WHERE bg.org_id = bc.org_id
        AND bg.provider_subscription_id = json_extract(bc.command_json, '$.provider_subscription_id')
   ) = 1;

INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
SELECT 'integrity_legacy_billing_command_generation_' || bc.id,
       'legacy_billing_command_generation_normalized', bc.id,
       CASE WHEN (
         (bc.command_type = 'create_checkout_session' AND EXISTS (
           SELECT 1 FROM billing_generations bg
           JOIN checkout_intents ci ON ci.id = bg.checkout_intent_id AND ci.org_id = bg.org_id
            WHERE bg.org_id = bc.org_id
              AND ci.id = json_extract(bc.command_json, '$.parameters.metadata.checkout_intent_id')
              AND CAST(json_extract(bc.command_json, '$.parameters.metadata.billing_generation') AS INTEGER) = bg.generation
         )) OR
         (bc.command_type = 'cancel_at_period_end' AND EXISTS (
           SELECT 1 FROM billing_generations bg
            WHERE bg.org_id = bc.org_id
              AND bg.provider_subscription_id = json_extract(bc.command_json, '$.provider_subscription_id')
              AND CAST(json_extract(bc.command_json, '$.billing_generation') AS INTEGER) = bg.generation
         ))
       ) THEN 1 ELSE 0 END,
       bc.created_at
  FROM billing_commands bc
 WHERE bc.command_type IN ('create_checkout_session', 'cancel_at_period_end')
   AND (
     json_extract(bc.command_json, '$.parameters.metadata.billing_generation') IS NOT NULL OR
     json_extract(bc.command_json, '$.billing_generation') IS NOT NULL
   );

-- Any live v7 workflow that cannot be normalized exactly blocks the upgrade.
-- This is the explicit migration HOLD: no ambiguous command or awaiting event
-- is allowed to become executable under generation-aware runtime code.
CREATE TABLE migration_0008_billing_bridge_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO migration_0008_billing_bridge_guard (valid)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM billing_commands bc
     WHERE bc.command_type = 'create_checkout_session'
       AND bc.status IN ('prepared', 'executing', 'compensating', 'provider_accepted')
       AND NOT EXISTS (
         SELECT 1 FROM billing_generations bg
         JOIN checkout_intents ci ON ci.id = bg.checkout_intent_id AND ci.org_id = bg.org_id
          WHERE bg.org_id = bc.org_id
            AND ci.id = json_extract(bc.command_json, '$.parameters.metadata.checkout_intent_id')
            AND ci.internal_price_id = json_extract(bc.command_json, '$.parameters.internal_price_id')
            AND CAST(json_extract(bc.command_json, '$.parameters.metadata.billing_generation') AS INTEGER) = bg.generation
            AND (
              ci.provider_session_id IS NULL OR
              json_extract(bc.command_json, '$.provider_result.session_id') = ci.provider_session_id
            )
       )
  )
  AND NOT EXISTS (
    SELECT 1 FROM billing_commands bc
     WHERE bc.command_type = 'cancel_at_period_end'
       AND bc.status IN ('prepared', 'executing', 'compensating', 'provider_accepted')
       AND NOT EXISTS (
         SELECT 1 FROM billing_generations bg
          WHERE bg.org_id = bc.org_id
            AND bg.provider_subscription_id = json_extract(bc.command_json, '$.provider_subscription_id')
            AND CAST(json_extract(bc.command_json, '$.billing_generation') AS INTEGER) = bg.generation
       )
  )
  AND NOT EXISTS (
    SELECT 1 FROM billing_commands bc
     WHERE bc.command_type = 'request_refund'
       AND bc.status IN ('prepared', 'executing', 'compensating', 'provider_accepted')
       AND NOT EXISTS (
         SELECT 1 FROM provider_events pe
         JOIN billing_generations bg
           ON bg.org_id = pe.org_id
          AND bg.generation = CAST(json_extract(pe.summary_json, '$.billingGeneration') AS INTEGER)
          WHERE pe.event_id = json_extract(bc.command_json, '$.source_payment_event_id')
            AND pe.org_id = bc.org_id
            AND pe.status = 'reconciled'
            AND bg.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
            AND bg.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
       )
  )
  AND NOT EXISTS (
    SELECT 1 FROM provider_events pe
     WHERE pe.status = 'awaiting_reconciliation'
       AND NOT EXISTS (
         SELECT 1 FROM billing_generations bg
          WHERE bg.org_id = pe.org_id
            AND bg.generation = CAST(json_extract(pe.summary_json, '$.billingGeneration') AS INTEGER)
            AND bg.provider_customer_id = json_extract(pe.summary_json, '$.customerId')
            AND bg.provider_subscription_id = json_extract(pe.summary_json, '$.subscriptionId')
            AND bg.internal_price_id = json_extract(pe.summary_json, '$.internalPriceId')
       )
  )
THEN 1 ELSE 0 END;

DROP TABLE migration_0008_billing_bridge_guard;

-- Provider chronology exists before tenant binding. A later terminal head
-- invalidates every older creation proof in both organization and personal lanes.
ALTER TABLE github_installation_provider_proofs ADD COLUMN invalidated_at TEXT;
ALTER TABLE github_installation_provider_proofs ADD COLUMN invalidated_by_delivery_id TEXT;
ALTER TABLE github_installation_provider_proofs ADD COLUMN incarnation INTEGER NOT NULL DEFAULT 1 CHECK (incarnation > 0);
ALTER TABLE github_installation_claims ADD COLUMN incarnation INTEGER NOT NULL DEFAULT 1 CHECK (incarnation > 0);
ALTER TABLE github_personal_installation_claims ADD COLUMN incarnation INTEGER NOT NULL DEFAULT 1 CHECK (incarnation > 0);
ALTER TABLE github_installations ADD COLUMN incarnation INTEGER NOT NULL DEFAULT 1 CHECK (incarnation > 0);
ALTER TABLE github_personal_installations ADD COLUMN incarnation INTEGER NOT NULL DEFAULT 1 CHECK (incarnation > 0);
ALTER TABLE github_deliveries ADD COLUMN incarnation INTEGER NOT NULL DEFAULT 1 CHECK (incarnation > 0);
ALTER TABLE github_personal_deliveries ADD COLUMN incarnation INTEGER NOT NULL DEFAULT 1 CHECK (incarnation > 0);

-- Reconciliation history belongs to an immutable installation incarnation, not
-- to the reusable live installation row. Remove the live-row foreign key so a
-- provider-not-found release can retain history while allowing a later creation
-- to reuse the external installation ID without cross-owner exposure.
ALTER TABLE github_installation_reconciliations RENAME TO github_installation_reconciliations_v7;

CREATE TABLE github_installation_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  source_delivery_id TEXT NOT NULL REFERENCES github_deliveries(delivery_id) ON DELETE RESTRICT,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  incarnation INTEGER NOT NULL CHECK (incarnation > 0),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'rejected')),
  applied_at TEXT NOT NULL
);

INSERT INTO github_installation_reconciliations
  (reconciliation_id, payload_sha256, source_delivery_id, installation_id, incarnation,
   org_id, observed_at, result, applied_at)
SELECT reconciliation_id, payload_sha256, source_delivery_id, installation_id, 1,
       org_id, observed_at, result, applied_at
  FROM github_installation_reconciliations_v7;

DROP TABLE github_installation_reconciliations_v7;

CREATE INDEX github_installation_reconciliations_owner_incarnation_idx
  ON github_installation_reconciliations(org_id, installation_id, incarnation, observed_at);

ALTER TABLE github_personal_installation_reconciliations
  RENAME TO github_personal_installation_reconciliations_v7;

CREATE TABLE github_personal_installation_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  source_delivery_id TEXT NOT NULL REFERENCES github_personal_deliveries(delivery_id) ON DELETE RESTRICT,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  incarnation INTEGER NOT NULL CHECK (incarnation > 0),
  subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (account_type = 'User'),
  observed_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'rejected')),
  applied_at TEXT NOT NULL
);

INSERT INTO github_personal_installation_reconciliations
  (reconciliation_id, payload_sha256, source_delivery_id, installation_id, incarnation,
   subject_token, account_type, observed_at, result, applied_at)
SELECT reconciliation_id, payload_sha256, source_delivery_id, installation_id, 1,
       subject_token, account_type, observed_at, result, applied_at
  FROM github_personal_installation_reconciliations_v7;

DROP TABLE github_personal_installation_reconciliations_v7;

CREATE INDEX github_personal_installation_reconciliations_owner_incarnation_idx
  ON github_personal_installation_reconciliations(subject_token, installation_id, incarnation, observed_at);

CREATE TABLE github_installation_lifecycle_heads (
  installation_id INTEGER PRIMARY KEY CHECK (installation_id > 0),
  incarnation INTEGER NOT NULL CHECK (incarnation > 0),
  github_account_node_id TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('Organization', 'User')),
  creation_delivery_id TEXT,
  latest_delivery_id TEXT NOT NULL UNIQUE,
  latest_event_created_at INTEGER NOT NULL CHECK (latest_event_created_at > 0),
  latest_action TEXT NOT NULL CHECK (
    latest_action IN ('created', 'deleted', 'suspend', 'unsuspend', 'added', 'removed', 'provider_not_found')
  ),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK (latest_action <> 'created' OR creation_delivery_id = latest_delivery_id),
  CHECK (terminal = CASE WHEN latest_action IN ('provider_not_found', 'deleted', 'suspend') THEN 1 ELSE 0 END)
);

CREATE INDEX github_installation_lifecycle_account_idx
  ON github_installation_lifecycle_heads(github_account_node_id, account_type);

CREATE TRIGGER github_installation_lifecycle_identity_guard
BEFORE UPDATE OF github_account_node_id, account_type ON github_installation_lifecycle_heads
FOR EACH ROW
WHEN NEW.github_account_node_id IS NOT OLD.github_account_node_id
  OR NEW.account_type IS NOT OLD.account_type
BEGIN
  SELECT RAISE(ABORT, 'github lifecycle identity is immutable');
END;

-- Equal-second deliveries use one provider-independent total order. A terminal
-- action always dominates a nonterminal action, provider_not_found dominates a
-- delivery, and a delivery ID is otherwise accepted only for exact idempotency.
CREATE TRIGGER github_installation_lifecycle_chronology_guard
BEFORE UPDATE OF incarnation, latest_delivery_id, latest_event_created_at, latest_action, terminal
ON github_installation_lifecycle_heads
FOR EACH ROW
WHEN NEW.terminal <> CASE
       WHEN NEW.latest_action IN ('provider_not_found', 'deleted', 'suspend') THEN 1 ELSE 0 END
 OR NEW.incarnation <> CASE
      WHEN NEW.latest_action = 'created' AND NEW.latest_delivery_id <> OLD.latest_delivery_id
        THEN OLD.incarnation + 1
      ELSE OLD.incarnation
    END
 OR NEW.latest_event_created_at < OLD.latest_event_created_at
 OR (
   NEW.latest_event_created_at = OLD.latest_event_created_at
   AND NOT (
     (NEW.latest_action = 'provider_not_found' AND OLD.latest_action <> 'provider_not_found')
     OR (NEW.latest_delivery_id = OLD.latest_delivery_id AND NEW.latest_action = OLD.latest_action)
     OR (
       NEW.latest_delivery_id <> OLD.latest_delivery_id
       AND CASE NEW.latest_action
         WHEN 'provider_not_found' THEN 7 WHEN 'deleted' THEN 6 WHEN 'suspend' THEN 5
         WHEN 'unsuspend' THEN 4 WHEN 'removed' THEN 3 WHEN 'added' THEN 2 ELSE 1
       END >
       CASE OLD.latest_action
         WHEN 'provider_not_found' THEN 7 WHEN 'deleted' THEN 6 WHEN 'suspend' THEN 5
         WHEN 'unsuspend' THEN 4 WHEN 'removed' THEN 3 WHEN 'added' THEN 2 ELSE 1
       END
     )
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'github lifecycle chronology regressed');
END;

-- Existing v7 proof/claim/install rows must resolve to one exact account lane,
-- one provider-created delivery, and one deterministic latest lifecycle event.
-- Refuse ambiguous equal-time/equal-action histories instead of picking a
-- delivery ID as chronology.
CREATE TABLE migration_0008_github_lifecycle_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO migration_0008_github_lifecycle_guard (valid)
WITH legacy_deliveries AS (
  SELECT delivery_id, installation_id, event_created_at, action, 'Organization' AS account_type
    FROM github_deliveries
  UNION ALL
  SELECT delivery_id, installation_id, event_created_at, action, 'User' AS account_type
    FROM github_personal_deliveries
), ranked AS (
  SELECT installation_id, account_type, event_created_at,
         CASE action
           WHEN 'deleted' THEN 6 WHEN 'suspend' THEN 5 WHEN 'unsuspend' THEN 4
           WHEN 'removed' THEN 3 WHEN 'added' THEN 2 ELSE 1
         END AS action_rank,
         COUNT(*) AS same_rank_count
    FROM legacy_deliveries
   GROUP BY installation_id, account_type, event_created_at, action_rank
)
SELECT CASE WHEN
  NOT EXISTS (SELECT 1 FROM ranked WHERE same_rank_count > 1)
  AND NOT EXISTS (
    SELECT installation_id, account_type FROM legacy_deliveries
     WHERE action = 'created'
     GROUP BY installation_id, account_type
    HAVING COUNT(*) > 1
  )
  AND NOT EXISTS (
    SELECT installation_id FROM github_installation_provider_proofs
     GROUP BY installation_id
    HAVING COUNT(DISTINCT github_account_node_id || ':' || account_type) > 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_installation_claims c
     WHERE c.status = 'bound' AND NOT EXISTS (
       SELECT 1 FROM github_deliveries d
        WHERE d.installation_id = c.installation_id AND d.org_id = c.org_id AND d.action = 'created'
     )
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_personal_installation_claims c
     WHERE c.status = 'bound' AND NOT EXISTS (
       SELECT 1 FROM github_personal_deliveries d
        WHERE d.installation_id = c.installation_id AND d.subject_token = c.subject_token AND d.action = 'created'
     )
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_installation_provider_proofs p
     WHERE NOT EXISTS (
       SELECT 1 FROM legacy_deliveries d
        WHERE d.delivery_id = p.delivery_id AND d.installation_id = p.installation_id
          AND d.account_type = p.account_type AND d.action = 'created'
     )
  )
THEN 1 ELSE 0 END;

DROP TABLE migration_0008_github_lifecycle_guard;

-- Correct only a v7 legacy bound-claim placeholder to the single exact provider
-- creation. The guard above refuses multiple creations, so an existing exact
-- materialized binding is never moved to a later inferred incarnation.
UPDATE github_installation_claims
   SET provider_proof_delivery_id = (
     SELECT d.delivery_id FROM github_deliveries d
      WHERE d.installation_id = github_installation_claims.installation_id
        AND d.org_id = github_installation_claims.org_id AND d.action = 'created'
   )
 WHERE status = 'bound'
   AND provider_proof_delivery_id IS NOT (
     SELECT d.delivery_id FROM github_deliveries d
      WHERE d.installation_id = github_installation_claims.installation_id
        AND d.org_id = github_installation_claims.org_id AND d.action = 'created'
   );

UPDATE github_personal_installation_claims
   SET provider_proof_delivery_id = (
     SELECT d.delivery_id FROM github_personal_deliveries d
      WHERE d.installation_id = github_personal_installation_claims.installation_id
        AND d.subject_token = github_personal_installation_claims.subject_token AND d.action = 'created'
   )
 WHERE status = 'bound'
   AND provider_proof_delivery_id IS NOT (
     SELECT d.delivery_id FROM github_personal_deliveries d
      WHERE d.installation_id = github_personal_installation_claims.installation_id
        AND d.subject_token = github_personal_installation_claims.subject_token AND d.action = 'created'
   );

INSERT OR IGNORE INTO github_installation_provider_proofs
  (delivery_id, installation_id, github_account_node_id, account_type,
   verified_at, expires_at, consumed_at, consumed_by_lane, incarnation)
SELECT c.provider_proof_delivery_id, c.installation_id, c.github_account_node_id, 'Organization',
       d.received_at, '9999-12-31T23:59:59.999Z', COALESCE(c.bound_at, c.updated_at), 'organization', 1
  FROM github_installation_claims c
  JOIN github_deliveries d ON d.delivery_id = c.provider_proof_delivery_id
 WHERE c.status = 'bound';

INSERT OR IGNORE INTO github_installation_provider_proofs
  (delivery_id, installation_id, github_account_node_id, account_type,
   verified_at, expires_at, consumed_at, consumed_by_lane, incarnation)
SELECT c.provider_proof_delivery_id, c.installation_id, c.github_account_node_id, 'User',
       d.received_at, '9999-12-31T23:59:59.999Z', COALESCE(c.bound_at, c.updated_at), 'personal', 1
  FROM github_personal_installation_claims c
  JOIN github_personal_deliveries d ON d.delivery_id = c.provider_proof_delivery_id
 WHERE c.status = 'bound';

WITH identities AS (
  SELECT installation_id, github_account_node_id, account_type
    FROM github_installation_provider_proofs
   GROUP BY installation_id, github_account_node_id, account_type
), legacy_deliveries AS (
  SELECT delivery_id, installation_id, event_created_at, action, received_at,
         'Organization' AS account_type
    FROM github_deliveries
  UNION ALL
  SELECT delivery_id, installation_id, event_created_at, action, received_at,
         'User' AS account_type
    FROM github_personal_deliveries
), ranked_deliveries AS (
  SELECT d.*,
         ROW_NUMBER() OVER (
           PARTITION BY d.installation_id, d.account_type
           ORDER BY d.event_created_at DESC,
             CASE d.action
               WHEN 'deleted' THEN 6 WHEN 'suspend' THEN 5 WHEN 'unsuspend' THEN 4
               WHEN 'removed' THEN 3 WHEN 'added' THEN 2 ELSE 1
             END DESC
         ) AS lifecycle_rank
    FROM legacy_deliveries d
), ranked_creations AS (
  SELECT p.installation_id, p.account_type, p.delivery_id,
         ROW_NUMBER() OVER (
           PARTITION BY p.installation_id, p.account_type
           ORDER BY d.event_created_at DESC
         ) AS creation_rank
    FROM github_installation_provider_proofs p
    JOIN legacy_deliveries d ON d.delivery_id = p.delivery_id
     AND d.installation_id = p.installation_id AND d.account_type = p.account_type
)
INSERT INTO github_installation_lifecycle_heads
  (installation_id, incarnation, github_account_node_id, account_type, creation_delivery_id,
   latest_delivery_id, latest_event_created_at, latest_action, terminal, updated_at)
SELECT i.installation_id, 1, i.github_account_node_id, i.account_type,
       COALESCE(
         CASE WHEN i.account_type = 'Organization' THEN (
           SELECT c.provider_proof_delivery_id FROM github_installation_claims c
            WHERE c.installation_id = i.installation_id AND c.status = 'bound'
         ) ELSE (
           SELECT c.provider_proof_delivery_id FROM github_personal_installation_claims c
            WHERE c.installation_id = i.installation_id AND c.status = 'bound'
         ) END,
         creation.delivery_id
       ),
       latest.delivery_id, latest.event_created_at, latest.action,
       CASE WHEN latest.action IN ('deleted', 'suspend') THEN 1 ELSE 0 END,
       latest.received_at
  FROM identities i
  JOIN ranked_deliveries latest ON latest.installation_id = i.installation_id
   AND latest.account_type = i.account_type AND latest.lifecycle_rank = 1
  JOIN ranked_creations creation ON creation.installation_id = i.installation_id
   AND creation.account_type = i.account_type AND creation.creation_rank = 1;

UPDATE github_installation_provider_proofs
   SET invalidated_at = (
         SELECT h.updated_at FROM github_installation_lifecycle_heads h
          WHERE h.installation_id = github_installation_provider_proofs.installation_id
       ),
       invalidated_by_delivery_id = (
         SELECT h.latest_delivery_id FROM github_installation_lifecycle_heads h
          WHERE h.installation_id = github_installation_provider_proofs.installation_id
       )
 WHERE invalidated_at IS NULL
   AND EXISTS (
     SELECT 1 FROM github_installation_lifecycle_heads h
      WHERE h.installation_id = github_installation_provider_proofs.installation_id
        AND h.account_type = github_installation_provider_proofs.account_type AND h.terminal = 1
   );

CREATE TABLE github_installation_release_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  source_delivery_id TEXT NOT NULL,
  creation_delivery_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  incarnation INTEGER NOT NULL CHECK (incarnation > 0),
  github_account_node_id TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('organization', 'personal')),
  owner_ref TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result = 'released'),
  applied_at TEXT NOT NULL
);

DROP TRIGGER github_org_claim_provider_proof_guard;
DROP TRIGGER github_personal_claim_provider_proof_guard;

CREATE TRIGGER github_org_claim_provider_proof_guard
BEFORE INSERT ON github_installation_claims
FOR EACH ROW
WHEN NEW.status = 'claimed'
 AND NOT EXISTS (
   SELECT 1
     FROM github_installation_provider_proofs p
     JOIN github_installation_lifecycle_heads h
       ON h.installation_id = p.installation_id
      AND h.github_account_node_id = p.github_account_node_id
      AND h.account_type = p.account_type
    WHERE p.delivery_id = NEW.provider_proof_delivery_id
      AND p.installation_id = NEW.installation_id
      AND p.github_account_node_id = NEW.github_account_node_id
      AND p.account_type = 'Organization'
      AND p.incarnation = NEW.incarnation
      AND p.consumed_at IS NULL
      AND p.invalidated_at IS NULL
      AND p.expires_at = NEW.claim_expires_at
      AND NEW.claim_expires_at > NEW.claimed_at
      AND h.creation_delivery_id = p.delivery_id
      AND h.incarnation = NEW.incarnation
      AND h.latest_delivery_id = p.delivery_id
      AND h.latest_action = 'created'
      AND h.terminal = 0
 )
BEGIN
  SELECT RAISE(ABORT, 'organization claim lacks latest nonterminal provider proof');
END;

CREATE TRIGGER github_personal_claim_provider_proof_guard
BEFORE INSERT ON github_personal_installation_claims
FOR EACH ROW
WHEN NEW.status = 'claimed'
 AND NOT EXISTS (
   SELECT 1
     FROM github_installation_provider_proofs p
     JOIN github_installation_lifecycle_heads h
       ON h.installation_id = p.installation_id
      AND h.github_account_node_id = p.github_account_node_id
      AND h.account_type = p.account_type
    WHERE p.delivery_id = NEW.provider_proof_delivery_id
      AND p.installation_id = NEW.installation_id
      AND p.github_account_node_id = NEW.github_account_node_id
      AND p.account_type = 'User'
      AND p.incarnation = NEW.incarnation
      AND p.consumed_at IS NULL
      AND p.invalidated_at IS NULL
      AND p.expires_at = NEW.claim_expires_at
      AND NEW.claim_expires_at > NEW.claimed_at
      AND h.creation_delivery_id = p.delivery_id
      AND h.incarnation = NEW.incarnation
      AND h.latest_delivery_id = p.delivery_id
      AND h.latest_action = 'created'
      AND h.terminal = 0
 )
BEGIN
  SELECT RAISE(ABORT, 'personal claim lacks latest nonterminal provider proof');
END;

-- v7 derived eligibility after three separate commits. Reconstruct it only
-- when every current prerequisite has an exact historical source artifact.
-- Any pre-existing active eligibility that predates or lacks those sources is
-- an explicit migration HOLD instead of silently preserving a false cohort.
CREATE TABLE migration_0008_individual_eligibility_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

WITH exact_legacy AS (
  SELECT identity.subject_token,
         MAX(
           consent.updated_at,
           attestation.observed_at,
           message.received_at,
           reconciliation.applied_at,
           boundary.r0_started_at
         ) AS derived_eligible_at
    FROM individual_identities identity
    JOIN individual_consents consent
      ON consent.subject_token = identity.subject_token AND consent.opted_in = 1
    JOIN individual_session_mutations mutation
      ON mutation.session_sha256 = consent.updated_session_sha256
     AND mutation.action = 'measurement_consent'
     AND mutation.subject_token = identity.subject_token
     AND mutation.result = 'applied'
     AND mutation.applied_at = consent.updated_at
    JOIN individual_subject_attestations attestation
      ON attestation.subject_token = identity.subject_token
     AND attestation.classification = identity.classification
     AND attestation.classification_basis = identity.classification_basis
     AND attestation.observed_at = identity.classification_attested_at
    JOIN individual_measurement_bridge_messages message
      ON message.message_id = attestation.message_id
     AND message.message_kind = 'individual_subject_attestation_v1'
     AND message.subject_token = identity.subject_token
     AND message.observed_at = attestation.observed_at
     AND message.result = 'applied'
    JOIN github_personal_installations installation
      ON installation.subject_token = identity.subject_token
     AND installation.account_type = 'User'
     AND installation.state = 'active'
     AND installation.reconciled_at IS NOT NULL
    JOIN github_personal_installation_reconciliations reconciliation
      ON reconciliation.reconciliation_id = installation.last_reconciliation_id
     AND reconciliation.source_delivery_id = installation.last_delivery_id
     AND reconciliation.installation_id = installation.installation_id
     AND reconciliation.incarnation = installation.incarnation
     AND reconciliation.subject_token = identity.subject_token
     AND reconciliation.account_type = 'User'
     AND reconciliation.result = 'applied'
     AND reconciliation.applied_at = installation.reconciled_at
    JOIN github_personal_deliveries delivery
      ON delivery.delivery_id = reconciliation.source_delivery_id
     AND delivery.installation_id = installation.installation_id
     AND delivery.incarnation = installation.incarnation
     AND delivery.subject_token = identity.subject_token
     AND delivery.account_type = 'User'
     AND delivery.result = 'applied'
    JOIN measurement_boundaries boundary
      ON boundary.boundary_id = 'r0' AND boundary.github_app_id = installation.app_id
   WHERE identity.canonical_subject_token = identity.subject_token
     AND identity.status = 'active'
     AND identity.classification = 'external'
     AND identity.classification_basis = 'provider_session_and_non_operator_registry'
     AND installation.installed_at >= boundary.r0_started_at
     AND installation.installed_at <= installation.reconciled_at
     AND boundary.r0_started_at <= installation.reconciled_at
)
INSERT INTO migration_0008_individual_eligibility_guard (valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM individual_identities identity
   WHERE identity.canonical_subject_token = identity.subject_token
     AND identity.status = 'active'
     AND identity.eligible_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM exact_legacy exact
        WHERE exact.subject_token = identity.subject_token
          AND identity.eligible_at >= exact.derived_eligible_at
          AND identity.eligible_at <= identity.updated_at
     )
) THEN 1 ELSE 0 END;

DROP TABLE migration_0008_individual_eligibility_guard;

WITH exact_legacy AS (
  SELECT identity.subject_token,
         MAX(
           consent.updated_at,
           attestation.observed_at,
           message.received_at,
           reconciliation.applied_at,
           boundary.r0_started_at
         ) AS derived_eligible_at
    FROM individual_identities identity
    JOIN individual_consents consent
      ON consent.subject_token = identity.subject_token AND consent.opted_in = 1
    JOIN individual_session_mutations mutation
      ON mutation.session_sha256 = consent.updated_session_sha256
     AND mutation.action = 'measurement_consent'
     AND mutation.subject_token = identity.subject_token
     AND mutation.result = 'applied'
     AND mutation.applied_at = consent.updated_at
    JOIN individual_subject_attestations attestation
      ON attestation.subject_token = identity.subject_token
     AND attestation.classification = identity.classification
     AND attestation.classification_basis = identity.classification_basis
     AND attestation.observed_at = identity.classification_attested_at
    JOIN individual_measurement_bridge_messages message
      ON message.message_id = attestation.message_id
     AND message.message_kind = 'individual_subject_attestation_v1'
     AND message.subject_token = identity.subject_token
     AND message.observed_at = attestation.observed_at
     AND message.result = 'applied'
    JOIN github_personal_installations installation
      ON installation.subject_token = identity.subject_token
     AND installation.account_type = 'User'
     AND installation.state = 'active'
     AND installation.reconciled_at IS NOT NULL
    JOIN github_personal_installation_reconciliations reconciliation
      ON reconciliation.reconciliation_id = installation.last_reconciliation_id
     AND reconciliation.source_delivery_id = installation.last_delivery_id
     AND reconciliation.installation_id = installation.installation_id
     AND reconciliation.incarnation = installation.incarnation
     AND reconciliation.subject_token = identity.subject_token
     AND reconciliation.account_type = 'User'
     AND reconciliation.result = 'applied'
     AND reconciliation.applied_at = installation.reconciled_at
    JOIN github_personal_deliveries delivery
      ON delivery.delivery_id = reconciliation.source_delivery_id
     AND delivery.installation_id = installation.installation_id
     AND delivery.incarnation = installation.incarnation
     AND delivery.subject_token = identity.subject_token
     AND delivery.account_type = 'User'
     AND delivery.result = 'applied'
    JOIN measurement_boundaries boundary
      ON boundary.boundary_id = 'r0' AND boundary.github_app_id = installation.app_id
   WHERE identity.canonical_subject_token = identity.subject_token
     AND identity.status = 'active'
     AND identity.classification = 'external'
     AND identity.classification_basis = 'provider_session_and_non_operator_registry'
     AND installation.installed_at >= boundary.r0_started_at
     AND installation.installed_at <= installation.reconciled_at
     AND boundary.r0_started_at <= installation.reconciled_at
)
UPDATE individual_identities
   SET eligible_at = (
         SELECT derived_eligible_at FROM exact_legacy exact
          WHERE exact.subject_token = individual_identities.subject_token
       ),
       updated_at = MAX(updated_at, (
         SELECT derived_eligible_at FROM exact_legacy exact
          WHERE exact.subject_token = individual_identities.subject_token
       ))
 WHERE eligible_at IS NULL
   AND EXISTS (
     SELECT 1 FROM exact_legacy exact
      WHERE exact.subject_token = individual_identities.subject_token
   );

WITH exact_legacy AS (
  SELECT identity.subject_token,
         MAX(
           consent.updated_at,
           attestation.observed_at,
           message.received_at,
           reconciliation.applied_at,
           boundary.r0_started_at
         ) AS derived_eligible_at
    FROM individual_identities identity
    JOIN individual_consents consent
      ON consent.subject_token = identity.subject_token AND consent.opted_in = 1
    JOIN individual_session_mutations mutation
      ON mutation.session_sha256 = consent.updated_session_sha256
     AND mutation.action = 'measurement_consent'
     AND mutation.subject_token = identity.subject_token
     AND mutation.result = 'applied'
     AND mutation.applied_at = consent.updated_at
    JOIN individual_subject_attestations attestation
      ON attestation.subject_token = identity.subject_token
     AND attestation.classification = identity.classification
     AND attestation.classification_basis = identity.classification_basis
     AND attestation.observed_at = identity.classification_attested_at
    JOIN individual_measurement_bridge_messages message
      ON message.message_id = attestation.message_id
     AND message.message_kind = 'individual_subject_attestation_v1'
     AND message.subject_token = identity.subject_token
     AND message.observed_at = attestation.observed_at
     AND message.result = 'applied'
    JOIN github_personal_installations installation
      ON installation.subject_token = identity.subject_token
     AND installation.account_type = 'User'
     AND installation.state = 'active'
     AND installation.reconciled_at IS NOT NULL
    JOIN github_personal_installation_reconciliations reconciliation
      ON reconciliation.reconciliation_id = installation.last_reconciliation_id
     AND reconciliation.source_delivery_id = installation.last_delivery_id
     AND reconciliation.installation_id = installation.installation_id
     AND reconciliation.incarnation = installation.incarnation
     AND reconciliation.subject_token = identity.subject_token
     AND reconciliation.account_type = 'User'
     AND reconciliation.result = 'applied'
     AND reconciliation.applied_at = installation.reconciled_at
    JOIN github_personal_deliveries delivery
      ON delivery.delivery_id = reconciliation.source_delivery_id
     AND delivery.installation_id = installation.installation_id
     AND delivery.incarnation = installation.incarnation
     AND delivery.subject_token = identity.subject_token
     AND delivery.account_type = 'User'
     AND delivery.result = 'applied'
    JOIN measurement_boundaries boundary
      ON boundary.boundary_id = 'r0' AND boundary.github_app_id = installation.app_id
   WHERE identity.canonical_subject_token = identity.subject_token
     AND identity.status = 'active'
     AND identity.classification = 'external'
     AND identity.classification_basis = 'provider_session_and_non_operator_registry'
     AND installation.installed_at >= boundary.r0_started_at
     AND installation.installed_at <= installation.reconciled_at
     AND boundary.r0_started_at <= installation.reconciled_at
)
INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
SELECT 'integrity_individual_eligibility_migration_' || exact.subject_token,
       'individual_eligibility_migration_backfill',
       exact.subject_token || ':migration_0008',
       CASE WHEN identity.eligible_at IS NOT NULL
                   AND identity.eligible_at >= exact.derived_eligible_at
                   AND identity.eligible_at <= identity.updated_at
              THEN 1 ELSE 0 END,
       exact.derived_eligible_at
  FROM exact_legacy exact
  JOIN individual_identities identity ON identity.subject_token = exact.subject_token;
