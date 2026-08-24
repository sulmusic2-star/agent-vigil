CREATE TABLE measurement_boundaries (
  boundary_id TEXT PRIMARY KEY CHECK (boundary_id = 'r0'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'r0-measurement-boundary-v1'),
  release_version TEXT NOT NULL,
  release_commit_sha TEXT NOT NULL,
  release_channel TEXT NOT NULL CHECK (release_channel = 'github_app'),
  deployment_environment TEXT NOT NULL CHECK (deployment_environment = 'production'),
  release_published_at TEXT NOT NULL,
  r0_started_at TEXT NOT NULL,
  github_app_id INTEGER NOT NULL CHECK (github_app_id > 0),
  initialized_message_id TEXT NOT NULL UNIQUE,
  initialized_at TEXT NOT NULL
);

CREATE TABLE measurement_consents (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  opted_in INTEGER NOT NULL CHECK (opted_in IN (0, 1)),
  updated_by TEXT NOT NULL,
  opted_in_at TEXT,
  opted_out_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (opted_in = 1 AND opted_in_at IS NOT NULL AND opted_out_at IS NULL) OR
    (opted_in = 0 AND opted_out_at IS NOT NULL)
  )
);

CREATE TABLE measurement_subjects (
  subject_token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  installation_id INTEGER NOT NULL UNIQUE REFERENCES github_installations(installation_id) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('external', 'internal', 'demo', 'test')),
  classification_basis TEXT NOT NULL CHECK (
    classification_basis IN (
      'provider_confirmed_non_operator', 'operator_identity_registry',
      'demo_registry', 'test_environment_registry'
    )
  ),
  first_attested_at TEXT NOT NULL,
  classification_attested_at TEXT NOT NULL,
  eligible_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (classification = 'external' AND classification_basis = 'provider_confirmed_non_operator') OR
    (classification = 'internal' AND classification_basis = 'operator_identity_registry') OR
    (classification = 'demo' AND classification_basis = 'demo_registry') OR
    (classification = 'test' AND classification_basis = 'test_environment_registry')
  )
);

CREATE TABLE measurement_bridge_messages (
  message_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (
    message_kind IN (
      'r0_boundary_v1', 'organization_subject_attestation_v1',
      'organization_activation_v1', 'team_offer_presented_v1'
    )
  ),
  org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  installation_id INTEGER,
  subject_token TEXT,
  observed_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'ignored_duplicate_day')),
  received_at TEXT NOT NULL
);

CREATE INDEX measurement_bridge_messages_org_idx
  ON measurement_bridge_messages(org_id, received_at);

CREATE TABLE measurement_subject_attestations (
  message_id TEXT PRIMARY KEY REFERENCES measurement_bridge_messages(message_id) ON DELETE RESTRICT,
  subject_token TEXT NOT NULL REFERENCES measurement_subjects(subject_token) ON DELETE RESTRICT,
  classification TEXT NOT NULL CHECK (classification IN ('external', 'internal', 'demo', 'test')),
  classification_basis TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE INDEX measurement_subject_attestations_subject_idx
  ON measurement_subject_attestations(subject_token, observed_at);

CREATE TABLE measurement_events (
  event_id TEXT PRIMARY KEY REFERENCES measurement_bridge_messages(message_id) ON DELETE RESTRICT,
  subject_token TEXT NOT NULL REFERENCES measurement_subjects(subject_token) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_name TEXT NOT NULL CHECK (
    event_name IN ('organization_activation_v1', 'team_offer_presented_v1')
  ),
  event_day TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  release_version TEXT NOT NULL,
  release_commit_sha TEXT NOT NULL,
  release_channel TEXT NOT NULL CHECK (release_channel = 'github_app'),
  offer_contract_id TEXT,
  CHECK (
    (event_name = 'organization_activation_v1' AND offer_contract_id IS NULL) OR
    (event_name = 'team_offer_presented_v1' AND offer_contract_id = 'team_v1_299_monthly_2990_annual')
  ),
  UNIQUE (subject_token, event_name, event_day)
);

CREATE INDEX measurement_events_subject_time_idx
  ON measurement_events(subject_token, event_name, occurred_at);
