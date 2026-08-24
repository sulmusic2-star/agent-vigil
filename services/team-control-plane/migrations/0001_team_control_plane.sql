PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deletion_pending', 'deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE organization_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'billing', 'member')),
  identity_kind TEXT NOT NULL DEFAULT 'human' CHECK (identity_kind IN ('human', 'service')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX organization_members_active_idx
  ON organization_members(org_id, active, identity_kind);

CREATE TABLE policy_revisions (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy_json TEXT NOT NULL,
  canary_metadata_json TEXT NOT NULL,
  required_gate_enabled INTEGER NOT NULL CHECK (required_gate_enabled IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, revision)
);

CREATE TABLE policy_heads (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (org_id, revision) REFERENCES policy_revisions(org_id, revision)
);

CREATE TABLE update_history (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pair_token TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('SAFE', 'CHANGED', 'HOLD')),
  disposition TEXT NOT NULL CHECK (disposition IN ('APPLY', 'DEFER', 'RESTORE', 'NO_DECISION')),
  receipt_sha256 TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX update_history_org_created_idx ON update_history(org_id, created_at DESC);

CREATE TABLE exception_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pair_token TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'used', 'revoked', 'expired')),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX exception_records_org_state_idx ON exception_records(org_id, state, expires_at);

CREATE TABLE rollback_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pair_token TEXT NOT NULL,
  from_ref_token TEXT NOT NULL,
  to_ref_token TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX rollback_records_org_created_idx ON rollback_records(org_id, created_at DESC);

CREATE TABLE checkout_intents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  internal_price_id TEXT NOT NULL CHECK (internal_price_id IN ('team_monthly_usd_v1', 'team_annual_usd_v1')),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
  list_amount_cents INTEGER NOT NULL CHECK (list_amount_cents IN (29900, 299000)),
  contributor_limit INTEGER NOT NULL DEFAULT 15 CHECK (contributor_limit = 15),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'provider_created', 'completed', 'expired', 'canceled')),
  provider_session_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (org_id, idempotency_key)
);

CREATE TABLE billing_accounts (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  provider_customer_id TEXT UNIQUE,
  provider_subscription_id TEXT UNIQUE,
  commercial_state TEXT NOT NULL DEFAULT 'offer_shown' CHECK (
    commercial_state IN (
      'offer_shown', 'checkout_started', 'payment_pending', 'paid', 'entitled',
      'renewed', 'past_due', 'canceled_at_period_end', 'refunded', 'expired'
    )
  ),
  internal_price_id TEXT CHECK (internal_price_id IN ('team_monthly_usd_v1', 'team_annual_usd_v1')),
  billing_interval TEXT CHECK (billing_interval IN ('month', 'year')),
  contributor_limit INTEGER NOT NULL DEFAULT 15 CHECK (contributor_limit = 15),
  current_period_start TEXT,
  current_period_end TEXT,
  grace_until TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  current_recognized_mrr_micros INTEGER NOT NULL DEFAULT 0 CHECK (current_recognized_mrr_micros >= 0),
  last_reconciled_event_created INTEGER,
  last_reconciled_event_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE commercial_transitions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('offer', 'checkout_command', 'stripe_webhook', 'provider_reconciliation', 'privacy')),
  source_ref TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX commercial_transitions_org_idx ON commercial_transitions(org_id, occurred_at);

CREATE TABLE provider_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'stripe'),
  event_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  org_id TEXT,
  event_created INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('awaiting_reconciliation', 'reconciled', 'ignored', 'stale', 'rejected')
  ),
  received_at TEXT NOT NULL,
  reconciled_at TEXT
);

CREATE INDEX provider_events_org_created_idx ON provider_events(org_id, event_created);

CREATE TABLE provider_reconciliation_snapshots (
  reconciliation_id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL REFERENCES provider_events(event_id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('payment', 'payment_failure', 'refund', 'subscription')),
  payload_sha256 TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'stale', 'rejected'))
);

CREATE TABLE billing_commands (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  command_type TEXT NOT NULL CHECK (command_type IN ('create_checkout_session', 'cancel_at_period_end', 'request_refund')),
  idempotency_key TEXT NOT NULL,
  command_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'provider_accepted', 'provider_rejected', 'confirmed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, idempotency_key)
);

CREATE TABLE entitlements (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  tier TEXT NOT NULL CHECK (tier = 'team'),
  status TEXT NOT NULL CHECK (status IN ('active', 'grace', 'read_only', 'expired', 'refunded')),
  contributor_limit INTEGER NOT NULL CHECK (contributor_limit = 15),
  billing_source TEXT NOT NULL CHECK (billing_source = 'stripe'),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  grace_until TEXT,
  source_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cash_ledger (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('payment', 'refund')),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  occurred_at TEXT NOT NULL,
  UNIQUE (source_event_id, entry_type)
);

CREATE TABLE revenue_ledger (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source_event_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('mrr_started', 'mrr_renewed', 'mrr_refund_adjustment', 'mrr_ended')),
  recognized_mrr_delta_micros INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'usd'),
  recognized_period_start TEXT NOT NULL,
  recognized_period_end TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (source_event_id, entry_type)
);

CREATE TABLE lifecycle_events (
  event_id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  event_name TEXT NOT NULL CHECK (
    event_name IN (
      'shared_policy_enabled_v1', 'required_gate_enabled_v1', 'team_offer_shown_v1',
      'checkout_started_v1', 'payment_succeeded_v1', 'entitlement_activated_v1',
      'payment_failed_v1', 'refund_issued_v1', 'subscription_renewed_v1',
      'subscription_canceled_v1', 'entitlement_expired_v1'
    )
  ),
  source_ref TEXT NOT NULL,
  event_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, event_name, source_ref)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'stripe', 'reconciler', 'system')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_events_org_created_idx ON audit_events(org_id, created_at DESC);

CREATE TABLE privacy_deletion_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  confirmation_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'canceled')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);
