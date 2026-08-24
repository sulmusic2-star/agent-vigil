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
      'unexpected_subscription_compensated'
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

-- Seed the pre-release generation without inventing terminal provider proof.
INSERT INTO billing_generations (
  org_id, generation, checkout_intent_id, internal_price_id, status,
  provider_checkout_session_id, provider_customer_id, provider_subscription_id,
  reserved_at, bound_at, terminal_verified_at, terminal_source_event_id, retired_at
)
SELECT ba.org_id, 1,
       (SELECT ci.id FROM checkout_intents ci WHERE ci.org_id = ba.org_id ORDER BY ci.created_at DESC, ci.id DESC LIMIT 1),
       COALESCE(ba.internal_price_id, 'team_monthly_usd_v1'),
       CASE
         WHEN ba.provider_subscription_id IS NULL THEN 'reserved'
         WHEN ba.commercial_state = 'expired' AND EXISTS (
           SELECT 1 FROM provider_events pe
            WHERE pe.org_id = ba.org_id
              AND pe.event_type = 'customer.subscription.deleted'
              AND pe.status = 'reconciled'
              AND json_extract(pe.summary_json, '$.subscriptionId') = ba.provider_subscription_id
         ) THEN 'terminal_verified'
         ELSE 'bound'
       END,
       (SELECT ci.provider_session_id FROM checkout_intents ci WHERE ci.org_id = ba.org_id ORDER BY ci.created_at DESC, ci.id DESC LIMIT 1),
       ba.provider_customer_id, ba.provider_subscription_id, ba.updated_at,
       CASE WHEN ba.provider_subscription_id IS NOT NULL THEN ba.updated_at ELSE NULL END,
       CASE WHEN ba.commercial_state = 'expired' AND EXISTS (
         SELECT 1 FROM provider_events pe
          WHERE pe.org_id = ba.org_id
            AND pe.event_type = 'customer.subscription.deleted'
            AND pe.status = 'reconciled'
            AND json_extract(pe.summary_json, '$.subscriptionId') = ba.provider_subscription_id
       ) THEN ba.updated_at ELSE NULL END,
       CASE WHEN ba.commercial_state = 'expired' THEN (
         SELECT pe.event_id FROM provider_events pe
          WHERE pe.org_id = ba.org_id
            AND pe.event_type = 'customer.subscription.deleted'
            AND pe.status = 'reconciled'
            AND json_extract(pe.summary_json, '$.subscriptionId') = ba.provider_subscription_id
          ORDER BY pe.event_created DESC, pe.event_id DESC LIMIT 1
       ) ELSE NULL END,
       NULL
  FROM billing_accounts ba
 WHERE ba.provider_subscription_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM checkout_intents ci
       WHERE ci.org_id = ba.org_id
         AND ci.status IN ('prepared', 'executing', 'provider_created', 'compensating')
    );

INSERT INTO billing_generation_events (id, org_id, generation, event_type, source_ref, occurred_at)
SELECT 'billing_generation_migration_' || org_id, org_id, generation,
       CASE WHEN status = 'terminal_verified' THEN 'terminal_verified'
            WHEN status = 'bound' THEN 'bound' ELSE 'reserved' END,
       COALESCE(terminal_source_event_id, checkout_intent_id, 'migration_0008'), reserved_at
  FROM billing_generations;

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
  provider_subscription_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('unexpected_session', 'unexpected_generation_binding')),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'executing', 'completed')),
  resume_command_status TEXT NOT NULL CHECK (resume_command_status IN ('provider_accepted', 'confirmed')),
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

CREATE UNIQUE INDEX checkout_subscription_compensations_one_live_per_command
  ON checkout_subscription_compensations(billing_command_id)
  WHERE status IN ('prepared', 'executing');

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

-- Provider chronology exists before tenant binding. A later terminal head
-- invalidates every older creation proof in both organization and personal lanes.
ALTER TABLE github_installation_provider_proofs ADD COLUMN invalidated_at TEXT;
ALTER TABLE github_installation_provider_proofs ADD COLUMN invalidated_by_delivery_id TEXT;

CREATE TABLE github_installation_lifecycle_heads (
  installation_id INTEGER PRIMARY KEY CHECK (installation_id > 0),
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
BEFORE UPDATE OF latest_delivery_id, latest_event_created_at, latest_action, terminal
ON github_installation_lifecycle_heads
FOR EACH ROW
WHEN NEW.terminal <> CASE
       WHEN NEW.latest_action IN ('provider_not_found', 'deleted', 'suspend') THEN 1 ELSE 0 END
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

CREATE TABLE github_installation_release_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  source_delivery_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
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
      AND p.consumed_at IS NULL
      AND p.invalidated_at IS NULL
      AND p.expires_at = NEW.claim_expires_at
      AND NEW.claim_expires_at > NEW.claimed_at
      AND h.creation_delivery_id = p.delivery_id
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
      AND p.consumed_at IS NULL
      AND p.invalidated_at IS NULL
      AND p.expires_at = NEW.claim_expires_at
      AND NEW.claim_expires_at > NEW.claimed_at
      AND h.creation_delivery_id = p.delivery_id
      AND h.latest_delivery_id = p.delivery_id
      AND h.latest_action = 'created'
      AND h.terminal = 0
 )
BEGIN
  SELECT RAISE(ABORT, 'personal claim lacks latest nonterminal provider proof');
END;
