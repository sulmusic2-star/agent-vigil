CREATE TABLE provider_state_cursors (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  event_created INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'applied')),
  updated_at TEXT NOT NULL
);
