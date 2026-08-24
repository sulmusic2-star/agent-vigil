CREATE TABLE individual_identities (
  subject_token TEXT PRIMARY KEY,
  canonical_subject_token TEXT NOT NULL,
  github_account_node_id TEXT NOT NULL UNIQUE,
  auth_subject_sha256 TEXT NOT NULL UNIQUE,
  token_key_id TEXT NOT NULL,
  classification TEXT CHECK (classification IN ('external', 'internal', 'demo', 'test')),
  classification_basis TEXT CHECK (
    classification_basis IN (
      'provider_session_and_non_operator_registry',
      'operator_identity_registry',
      'demo_registry',
      'test_environment_registry'
    )
  ),
  first_authenticated_at TEXT NOT NULL,
  classification_attested_at TEXT,
  auth_subject_rotated_at TEXT,
  eligible_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'merged')),
  merged_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    substr(subject_token, 1, 5) = 'mind_' AND
    length(subject_token) = 69 AND
    substr(subject_token, 6) NOT GLOB '*[^a-f0-9]*'
  ),
  CHECK (
    substr(canonical_subject_token, 1, 5) = 'mind_' AND
    length(canonical_subject_token) = 69 AND
    substr(canonical_subject_token, 6) NOT GLOB '*[^a-f0-9]*'
  ),
  CHECK (
    (classification IS NULL AND classification_basis IS NULL AND classification_attested_at IS NULL) OR
    (classification = 'external' AND classification_basis = 'provider_session_and_non_operator_registry' AND classification_attested_at IS NOT NULL) OR
    (classification = 'internal' AND classification_basis = 'operator_identity_registry' AND classification_attested_at IS NOT NULL) OR
    (classification = 'demo' AND classification_basis = 'demo_registry' AND classification_attested_at IS NOT NULL) OR
    (classification = 'test' AND classification_basis = 'test_environment_registry' AND classification_attested_at IS NOT NULL)
  ),
  CHECK (
    (status = 'active' AND canonical_subject_token = subject_token AND merged_at IS NULL) OR
    (status = 'merged' AND canonical_subject_token <> subject_token AND merged_at IS NOT NULL)
  )
);

CREATE INDEX individual_identities_canonical_idx
  ON individual_identities(canonical_subject_token, status);

CREATE TABLE individual_consents (
  subject_token TEXT PRIMARY KEY REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  opted_in INTEGER NOT NULL CHECK (opted_in IN (0, 1)),
  updated_session_sha256 TEXT NOT NULL,
  opted_in_at TEXT,
  opted_out_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (opted_in = 1 AND opted_in_at IS NOT NULL AND opted_out_at IS NULL) OR
    (opted_in = 0 AND opted_out_at IS NOT NULL)
  )
);

CREATE TABLE individual_session_mutations (
  session_sha256 TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('measurement_consent', 'installation_claim', 'deletion_request', 'deletion_confirmation')
  ),
  request_sha256 TEXT NOT NULL,
  subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  result TEXT NOT NULL CHECK (result = 'applied'),
  applied_at TEXT NOT NULL,
  PRIMARY KEY (session_sha256, action)
);

CREATE TABLE github_personal_installation_claims (
  installation_id INTEGER PRIMARY KEY CHECK (installation_id > 0),
  github_account_node_id TEXT NOT NULL UNIQUE,
  subject_token TEXT NOT NULL UNIQUE REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (account_type = 'User'),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'bound', 'revoked')),
  claimed_session_sha256 TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE github_personal_installations (
  installation_id INTEGER PRIMARY KEY REFERENCES github_personal_installation_claims(installation_id) ON DELETE RESTRICT,
  app_id INTEGER NOT NULL CHECK (app_id > 0),
  github_account_node_id TEXT NOT NULL UNIQUE,
  subject_token TEXT NOT NULL UNIQUE REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (account_type = 'User'),
  state TEXT NOT NULL CHECK (state IN ('pending_reconciliation', 'active', 'suspended', 'deleted')),
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  last_event_created_at INTEGER NOT NULL CHECK (last_event_created_at > 0),
  last_delivery_id TEXT NOT NULL UNIQUE,
  last_reconciliation_id TEXT,
  installed_at TEXT NOT NULL,
  suspended_at TEXT,
  deleted_at TEXT,
  reconciled_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE github_personal_deliveries (
  delivery_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN ('installation', 'installation_repositories')),
  action TEXT NOT NULL CHECK (action IN ('created', 'deleted', 'suspend', 'unsuspend', 'added', 'removed')),
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  subject_token TEXT REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (account_type = 'User'),
  event_created_at INTEGER NOT NULL CHECK (event_created_at > 0),
  result TEXT NOT NULL CHECK (result IN ('unclaimed', 'pending_reconciliation', 'applied', 'revoked', 'stale', 'rejected')),
  received_at TEXT NOT NULL
);

CREATE INDEX github_personal_deliveries_installation_created_idx
  ON github_personal_deliveries(installation_id, event_created_at);

CREATE TABLE github_personal_installation_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  source_delivery_id TEXT NOT NULL REFERENCES github_personal_deliveries(delivery_id) ON DELETE RESTRICT,
  installation_id INTEGER NOT NULL REFERENCES github_personal_installations(installation_id) ON DELETE RESTRICT,
  subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (account_type = 'User'),
  observed_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'rejected')),
  applied_at TEXT NOT NULL
);

CREATE TABLE individual_measurement_bridge_messages (
  message_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (
    message_kind IN (
      'individual_subject_attestation_v1',
      'individual_auth_subject_rotation_v1',
      'individual_identity_merge_v1',
      'individual_activation_v1'
    )
  ),
  subject_token TEXT REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  installation_id INTEGER,
  observed_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'ignored_duplicate_day')),
  received_at TEXT NOT NULL
);

CREATE INDEX individual_measurement_bridge_subject_idx
  ON individual_measurement_bridge_messages(subject_token, received_at);

CREATE TABLE individual_subject_attestations (
  message_id TEXT PRIMARY KEY REFERENCES individual_measurement_bridge_messages(message_id) ON DELETE RESTRICT,
  subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('external', 'internal', 'demo', 'test')),
  classification_basis TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE individual_auth_subject_rotations (
  message_id TEXT PRIMARY KEY REFERENCES individual_measurement_bridge_messages(message_id) ON DELETE RESTRICT,
  subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  prior_auth_subject_sha256 TEXT NOT NULL,
  new_auth_subject_sha256 TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  CHECK (prior_auth_subject_sha256 <> new_auth_subject_sha256)
);

CREATE TABLE individual_identity_merges (
  message_id TEXT PRIMARY KEY REFERENCES individual_measurement_bridge_messages(message_id) ON DELETE RESTRICT,
  source_subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  target_subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  provider_merge_reference_sha256 TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  CHECK (source_subject_token <> target_subject_token)
);

CREATE TABLE individual_measurement_events (
  event_id TEXT PRIMARY KEY REFERENCES individual_measurement_bridge_messages(message_id) ON DELETE RESTRICT,
  subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  installation_id INTEGER NOT NULL REFERENCES github_personal_installations(installation_id) ON DELETE RESTRICT,
  event_name TEXT NOT NULL CHECK (event_name = 'individual_activation_v1'),
  event_day TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  release_version TEXT NOT NULL,
  release_commit_sha TEXT NOT NULL,
  release_channel TEXT NOT NULL CHECK (release_channel = 'github_app'),
  verdict TEXT NOT NULL CHECK (verdict IN ('SAFE', 'BREAK', 'INCONCLUSIVE')),
  receipt_sha256 TEXT NOT NULL,
  UNIQUE (subject_token, event_name, event_day)
);

CREATE INDEX individual_measurement_events_subject_time_idx
  ON individual_measurement_events(subject_token, occurred_at);

CREATE TABLE individual_audit_events (
  id TEXT PRIMARY KEY,
  subject_token TEXT NOT NULL REFERENCES individual_identities(subject_token) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human_session', 'identity_bridge', 'activity_bridge', 'github_app', 'system')),
  actor_session_sha256 TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX individual_audit_subject_created_idx
  ON individual_audit_events(subject_token, created_at DESC);

CREATE TABLE individual_privacy_deletion_requests (
  id TEXT PRIMARY KEY,
  subject_token TEXT NOT NULL,
  confirmation_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'canceled')),
  requested_session_sha256 TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TRIGGER individual_classification_chronology_guard
BEFORE UPDATE OF classification, classification_basis, classification_attested_at
ON individual_identities
FOR EACH ROW
WHEN OLD.classification_attested_at IS NOT NULL
  AND NEW.classification_attested_at <= OLD.classification_attested_at
BEGIN
  SELECT RAISE(ABORT, 'individual classification chronology conflict');
END;

CREATE TRIGGER individual_auth_rotation_chronology_guard
BEFORE UPDATE OF auth_subject_sha256, updated_at
ON individual_identities
FOR EACH ROW
WHEN NEW.auth_subject_sha256 <> OLD.auth_subject_sha256
  AND NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'individual auth rotation chronology conflict');
END;
