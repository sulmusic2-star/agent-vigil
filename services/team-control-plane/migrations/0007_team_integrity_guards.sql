PRAGMA foreign_keys = ON;

-- Checkout execution crosses an external provider boundary, so its local state must
-- have explicit lease and compensation states. These tables are not referenced by
-- foreign keys and can be rebuilt without weakening the surrounding tenant FKs.
ALTER TABLE checkout_intents RENAME TO checkout_intents_v1;

CREATE TABLE checkout_intents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  internal_price_id TEXT NOT NULL CHECK (internal_price_id IN ('team_monthly_usd_v1', 'team_annual_usd_v1')),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
  list_amount_cents INTEGER NOT NULL CHECK (list_amount_cents IN (29900, 299000)),
  contributor_limit INTEGER NOT NULL DEFAULT 15 CHECK (contributor_limit = 15),
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'executing', 'provider_created', 'compensating', 'completed', 'expired', 'canceled')
  ),
  provider_session_id TEXT,
  compensation_customer_id TEXT,
  compensation_subscription_id TEXT UNIQUE,
  execution_lease_id TEXT,
  execution_lease_expires_at TEXT,
  compensated_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (org_id, idempotency_key),
  CHECK (
    (status IN ('executing', 'compensating') AND execution_lease_id IS NOT NULL AND execution_lease_expires_at IS NOT NULL) OR
    (status NOT IN ('executing', 'compensating'))
  ),
  CHECK (status <> 'compensating' OR provider_session_id IS NOT NULL),
  CHECK ((compensation_customer_id IS NULL) = (compensation_subscription_id IS NULL)),
  CHECK (compensation_subscription_id IS NULL OR status IN ('executing', 'compensating'))
);

INSERT INTO checkout_intents (
  id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
  contributor_limit, status, provider_session_id, compensation_customer_id,
  compensation_subscription_id, execution_lease_id,
  execution_lease_expires_at, compensated_at, created_by, created_at, expires_at
)
SELECT id, org_id, idempotency_key, internal_price_id, billing_interval, list_amount_cents,
       contributor_limit, status, provider_session_id, NULL, NULL, NULL, NULL, NULL,
       'legacy_actor_redacted', created_at, expires_at
  FROM checkout_intents_v1;

DROP TABLE checkout_intents_v1;

ALTER TABLE billing_commands RENAME TO billing_commands_v1;

CREATE TABLE billing_commands (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  command_type TEXT NOT NULL CHECK (command_type IN ('create_checkout_session', 'cancel_at_period_end', 'request_refund')),
  idempotency_key TEXT NOT NULL,
  command_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'executing', 'compensating', 'provider_accepted', 'provider_rejected', 'confirmed', 'canceled')
  ),
  execution_lease_id TEXT,
  execution_lease_expires_at TEXT,
  compensated_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, idempotency_key),
  CHECK (
    (status IN ('executing', 'compensating') AND execution_lease_id IS NOT NULL AND execution_lease_expires_at IS NOT NULL) OR
    (status NOT IN ('executing', 'compensating'))
  )
);

INSERT INTO billing_commands (
  id, org_id, command_type, idempotency_key, command_json, status,
  execution_lease_id, execution_lease_expires_at, compensated_at, created_by, created_at
)
SELECT id, org_id, command_type, idempotency_key, command_json, status,
       NULL, NULL, NULL, 'legacy_actor_redacted', created_at
  FROM billing_commands_v1;

DROP TABLE billing_commands_v1;

-- A request idempotency key and an organization-wide reservation are separate
-- invariants. Resolve any pre-release duplicate live rows deterministically, then
-- let SQLite serialize every future concurrent insert.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY org_id ORDER BY created_at, id) AS position
    FROM checkout_intents
   WHERE status IN ('prepared', 'executing', 'provider_created', 'compensating')
)
UPDATE checkout_intents
   SET status = 'canceled', execution_lease_id = NULL, execution_lease_expires_at = NULL
 WHERE id IN (SELECT id FROM ranked WHERE position > 1);

UPDATE billing_commands
   SET status = 'canceled', execution_lease_id = NULL, execution_lease_expires_at = NULL
 WHERE command_type = 'create_checkout_session'
   AND json_extract(command_json, '$.parameters.metadata.checkout_intent_id') IN (
     SELECT id FROM checkout_intents WHERE status = 'canceled'
   )
   AND status IN ('prepared', 'executing', 'provider_accepted', 'compensating');

CREATE UNIQUE INDEX checkout_intents_one_live_per_org
  ON checkout_intents(org_id)
  WHERE status IN ('prepared', 'executing', 'provider_created', 'compensating');

CREATE INDEX billing_commands_execution_idx
  ON billing_commands(org_id, command_type, status, execution_lease_expires_at);

-- A confirmation secret is returned once. Concurrent requests must never create
-- two live confirmations or commit an unreachable request after losing a race.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY org_id ORDER BY requested_at DESC, id DESC) AS position
    FROM privacy_deletion_requests WHERE status = 'pending'
)
UPDATE privacy_deletion_requests
   SET status = 'canceled', confirmation_sha256 = printf('%064d', 0)
 WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX privacy_deletion_one_pending_per_org
  ON privacy_deletion_requests(org_id) WHERE status = 'pending';

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY subject_token ORDER BY requested_at DESC, id DESC) AS position
    FROM individual_privacy_deletion_requests WHERE status = 'pending'
)
UPDATE individual_privacy_deletion_requests
   SET status = 'canceled', confirmation_sha256 = printf('%064d', 0),
       requested_session_sha256 = printf('%064d', 0)
 WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX individual_privacy_deletion_one_pending_per_subject
  ON individual_privacy_deletion_requests(subject_token) WHERE status = 'pending';

-- Provider callbacks and reconciler reads happen outside D1 transactions. These
-- guards are the final serialized boundary: once deletion commits, no callback
-- may recreate a hosted billing binding or entitlement from an earlier read.
CREATE TRIGGER provider_event_deleted_org_guard
BEFORE INSERT ON provider_events
FOR EACH ROW
WHEN NEW.org_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id AND status = 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'provider event targets deleted organization');
END;

CREATE TRIGGER checkout_completion_deleted_org_guard
BEFORE UPDATE OF status ON checkout_intents
FOR EACH ROW
WHEN NEW.status = 'completed'
 AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id AND status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'checkout completion targets non-active organization');
END;

CREATE TRIGGER billing_account_deleted_org_insert_guard
BEFORE INSERT ON billing_accounts
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id AND status = 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'billing account targets deleted organization');
END;

CREATE TRIGGER billing_account_deleted_org_update_guard
BEFORE UPDATE ON billing_accounts
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id AND status = 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'billing account targets deleted organization');
END;

CREATE TRIGGER entitlement_deleted_org_insert_guard
BEFORE INSERT ON entitlements
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id AND status = 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'entitlement targets deleted organization');
END;

CREATE TRIGGER entitlement_deleted_org_update_guard
BEFORE UPDATE ON entitlements
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM organizations WHERE id = NEW.org_id AND status = 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'entitlement targets deleted organization');
END;

-- Each financial refund entry is an exact Stripe Refund, not a charge-wide event.
-- The provider's current cumulative amount must cover every independently booked
-- Refund while the locally booked total can never exceed the source payment.
CREATE TABLE provider_refund_applications (
  provider_refund_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  billing_command_id TEXT REFERENCES billing_commands(id) ON DELETE RESTRICT,
  source_payment_event_id TEXT NOT NULL REFERENCES provider_events(event_id) ON DELETE RESTRICT,
  source_refund_event_id TEXT NOT NULL UNIQUE REFERENCES provider_events(event_id) ON DELETE RESTRICT,
  provider_charge_id TEXT NOT NULL,
  provider_payment_intent_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  cumulative_amount_cents INTEGER NOT NULL CHECK (cumulative_amount_cents >= amount_cents),
  applied_at TEXT NOT NULL,
  UNIQUE (billing_command_id)
);

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
  OR NEW.cumulative_amount_cents < (
       COALESCE((
         SELECT SUM(amount_cents)
           FROM provider_refund_applications
          WHERE org_id = NEW.org_id
            AND source_payment_event_id = NEW.source_payment_event_id
       ), 0) + NEW.amount_cents
     )
  OR NEW.cumulative_amount_cents > COALESCE((
       SELECT amount_cents
         FROM cash_ledger
        WHERE org_id = NEW.org_id
          AND source_event_id = NEW.source_payment_event_id
          AND entry_type = 'payment'
     ), 0)
BEGIN
  SELECT RAISE(ABORT, 'provider refund cumulative amount conflict');
END;

-- A verified GitHub webhook creates a short-lived, single-use proof before either
-- organization or individual code may allocate a globally exclusive claim.
CREATE TABLE github_installation_provider_proofs (
  delivery_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  github_account_node_id TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('Organization', 'User')),
  verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_lane TEXT CHECK (consumed_by_lane IN ('organization', 'personal')),
  CHECK (
    (consumed_at IS NULL AND consumed_by_lane IS NULL) OR
    (consumed_at IS NOT NULL AND consumed_by_lane IS NOT NULL)
  ),
  UNIQUE (installation_id, delivery_id),
  UNIQUE (github_account_node_id, delivery_id)
);

CREATE INDEX github_installation_provider_proofs_available_idx
  ON github_installation_provider_proofs(installation_id, github_account_node_id, account_type, expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE github_installation_claims ADD COLUMN provider_proof_delivery_id TEXT;
ALTER TABLE github_installation_claims ADD COLUMN claim_expires_at TEXT;
ALTER TABLE github_installation_claims ADD COLUMN bound_at TEXT;

ALTER TABLE github_personal_installation_claims ADD COLUMN provider_proof_delivery_id TEXT;
ALTER TABLE github_personal_installation_claims ADD COLUMN claim_expires_at TEXT;
ALTER TABLE github_personal_installation_claims ADD COLUMN bound_at TEXT;

-- Existing pre-release claims did not have provider proof. Make them immediately
-- reclaimable unless an already-reconciled installation proves the binding.
UPDATE github_installation_claims
   SET provider_proof_delivery_id = COALESCE(legacy.last_delivery_id, 'legacy_bound_proof'),
       claim_expires_at = CASE WHEN status = 'bound' THEN '9999-12-31T23:59:59.999Z' ELSE '1970-01-01T00:00:00.000Z' END,
       bound_at = CASE WHEN status = 'bound' THEN updated_at ELSE NULL END
  FROM (
    SELECT c.installation_id AS claim_installation_id, i.last_delivery_id
      FROM github_installation_claims c
      LEFT JOIN github_installations i ON i.installation_id = c.installation_id
  ) AS legacy
 WHERE github_installation_claims.installation_id = legacy.claim_installation_id;

UPDATE github_personal_installation_claims
   SET provider_proof_delivery_id = COALESCE(legacy.last_delivery_id, 'legacy_bound_proof'),
       claim_expires_at = CASE WHEN status = 'bound' THEN '9999-12-31T23:59:59.999Z' ELSE '1970-01-01T00:00:00.000Z' END,
       bound_at = CASE WHEN status = 'bound' THEN updated_at ELSE NULL END
  FROM (
    SELECT c.installation_id AS claim_installation_id, i.last_delivery_id
      FROM github_personal_installation_claims c
      LEFT JOIN github_personal_installations i ON i.installation_id = c.installation_id
  ) AS legacy
 WHERE github_personal_installation_claims.installation_id = legacy.claim_installation_id;

CREATE TRIGGER github_org_claim_provider_proof_guard
BEFORE INSERT ON github_installation_claims
FOR EACH ROW
WHEN NEW.status = 'claimed'
 AND NOT EXISTS (
   SELECT 1 FROM github_installation_provider_proofs
    WHERE delivery_id = NEW.provider_proof_delivery_id
      AND installation_id = NEW.installation_id
      AND github_account_node_id = NEW.github_account_node_id
      AND account_type = 'Organization'
      AND consumed_at IS NULL
      AND expires_at = NEW.claim_expires_at
      AND NEW.claim_expires_at > NEW.claimed_at
 )
BEGIN
  SELECT RAISE(ABORT, 'organization claim lacks exact provider proof');
END;

CREATE TRIGGER github_personal_claim_provider_proof_guard
BEFORE INSERT ON github_personal_installation_claims
FOR EACH ROW
WHEN NEW.status = 'claimed'
 AND NOT EXISTS (
   SELECT 1 FROM github_installation_provider_proofs
    WHERE delivery_id = NEW.provider_proof_delivery_id
      AND installation_id = NEW.installation_id
      AND github_account_node_id = NEW.github_account_node_id
      AND account_type = 'User'
      AND consumed_at IS NULL
      AND expires_at = NEW.claim_expires_at
      AND NEW.claim_expires_at > NEW.claimed_at
 )
BEGIN
  SELECT RAISE(ABORT, 'personal claim lacks exact provider proof');
END;

-- Flatten any pre-release merge chains and refuse migration if a terminal active
-- canonical subject cannot be found. New writes must always target that terminal.
WITH RECURSIVE identity_closure(source_subject_token, current_subject_token, depth, path) AS (
  SELECT subject_token, canonical_subject_token, 0, '|' || subject_token || '|'
    FROM individual_identities
  UNION ALL
  SELECT closure.source_subject_token, identity.canonical_subject_token,
         closure.depth + 1, closure.path || identity.subject_token || '|'
    FROM identity_closure AS closure
    JOIN individual_identities AS identity
      ON identity.subject_token = closure.current_subject_token
   WHERE identity.status = 'merged'
     AND closure.depth < 64
     AND instr(closure.path, '|' || identity.subject_token || '|') = 0
), terminal AS (
  SELECT closure.source_subject_token, closure.current_subject_token AS terminal_subject_token
    FROM identity_closure AS closure
    JOIN individual_identities AS identity
      ON identity.subject_token = closure.current_subject_token
   WHERE identity.status = 'active'
     AND identity.canonical_subject_token = identity.subject_token
)
UPDATE individual_identities
   SET canonical_subject_token = (
     SELECT terminal_subject_token
       FROM terminal
      WHERE source_subject_token = individual_identities.subject_token
   )
 WHERE status = 'merged'
   AND EXISTS (
     SELECT 1 FROM terminal WHERE source_subject_token = individual_identities.subject_token
   );

CREATE TABLE migration_0007_identity_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO migration_0007_identity_guard(invalid_count)
SELECT COUNT(*)
  FROM individual_identities AS source
  LEFT JOIN individual_identities AS target
    ON target.subject_token = source.canonical_subject_token
 WHERE source.status = 'merged'
   AND (
     target.subject_token IS NULL OR
     target.status <> 'active' OR
     target.canonical_subject_token <> target.subject_token
   );

DROP TABLE migration_0007_identity_guard;

CREATE TRIGGER individual_identity_canonical_target_guard
BEFORE UPDATE OF canonical_subject_token, status ON individual_identities
FOR EACH ROW
WHEN NEW.status = 'merged'
 AND NOT EXISTS (
   SELECT 1
     FROM individual_identities AS target
    WHERE target.subject_token = NEW.canonical_subject_token
      AND target.status = 'active'
      AND target.canonical_subject_token = target.subject_token
 )
BEGIN
  SELECT RAISE(ABORT, 'individual canonical target is not terminal and active');
END;

CREATE TRIGGER individual_identity_merge_update_chronology_guard
BEFORE UPDATE OF canonical_subject_token, status, merged_at, updated_at ON individual_identities
FOR EACH ROW
WHEN NEW.canonical_subject_token <> OLD.canonical_subject_token
 AND NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'individual identity merge chronology conflict');
END;

-- Legacy actor columns are intentionally pseudonymous after this migration.
UPDATE privacy_deletion_requests SET requested_by = 'legacy_actor_redacted';
