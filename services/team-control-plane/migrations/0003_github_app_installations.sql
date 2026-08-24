CREATE TABLE github_installation_claims (
  installation_id INTEGER PRIMARY KEY CHECK (installation_id > 0),
  github_account_node_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'bound', 'revoked')),
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE github_installations (
  installation_id INTEGER PRIMARY KEY REFERENCES github_installation_claims(installation_id) ON DELETE RESTRICT,
  app_id INTEGER NOT NULL CHECK (app_id > 0),
  github_account_node_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
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

CREATE TABLE github_installation_repositories (
  installation_id INTEGER NOT NULL REFERENCES github_installations(installation_id) ON DELETE RESTRICT,
  repository_node_id TEXT NOT NULL,
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, repository_node_id)
);

CREATE INDEX github_installation_repositories_selected_idx
  ON github_installation_repositories(installation_id, selected);

CREATE TABLE github_deliveries (
  delivery_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN ('installation', 'installation_repositories')),
  action TEXT NOT NULL CHECK (action IN ('created', 'deleted', 'suspend', 'unsuspend', 'added', 'removed')),
  installation_id INTEGER NOT NULL CHECK (installation_id > 0),
  org_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  event_created_at INTEGER NOT NULL CHECK (event_created_at > 0),
  result TEXT NOT NULL CHECK (result IN ('unclaimed', 'pending_reconciliation', 'applied', 'revoked', 'stale', 'rejected')),
  received_at TEXT NOT NULL
);

CREATE INDEX github_deliveries_installation_created_idx
  ON github_deliveries(installation_id, event_created_at);

CREATE TABLE github_installation_reconciliations (
  reconciliation_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL,
  source_delivery_id TEXT NOT NULL REFERENCES github_deliveries(delivery_id) ON DELETE RESTRICT,
  installation_id INTEGER NOT NULL REFERENCES github_installations(installation_id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'rejected')),
  applied_at TEXT NOT NULL
);
