PRAGMA foreign_keys = ON;

CREATE TABLE publishers (
  key_id TEXT PRIMARY KEY CHECK (key_id GLOB 'sha256:*' AND length(key_id) = 71),
  public_key_b64 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE publisher_status_events (
  event_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES publishers(key_id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  reason_class TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TABLE compatibility_entries (
  entry_hash TEXT PRIMARY KEY CHECK (entry_hash GLOB 'sha256:*' AND length(entry_hash) = 71),
  key_id TEXT NOT NULL REFERENCES publishers(key_id),
  ecosystem TEXT NOT NULL,
  component_name TEXT NOT NULL,
  current_version TEXT NOT NULL,
  candidate_version TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('SAFE', 'CHANGED', 'HOLD')),
  generated_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_json TEXT NOT NULL
) STRICT;

CREATE INDEX compatibility_entries_pair_idx
  ON compatibility_entries(ecosystem, component_name, current_version, candidate_version, generated_at DESC);
CREATE INDEX compatibility_entries_component_idx
  ON compatibility_entries(ecosystem, component_name, generated_at DESC);
CREATE INDEX compatibility_entries_verdict_idx
  ON compatibility_entries(verdict, generated_at DESC);

CREATE TABLE compatibility_resolutions (
  resolution_hash TEXT PRIMARY KEY CHECK (resolution_hash GLOB 'sha256:*' AND length(resolution_hash) = 71),
  key_id TEXT NOT NULL REFERENCES publishers(key_id),
  broken_entry_hash TEXT NOT NULL REFERENCES compatibility_entries(entry_hash),
  fixed_entry_hash TEXT NOT NULL REFERENCES compatibility_entries(entry_hash),
  ecosystem TEXT NOT NULL,
  component_name TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_json TEXT NOT NULL,
  UNIQUE (broken_entry_hash, fixed_entry_hash)
) STRICT;

CREATE INDEX compatibility_resolutions_broken_idx
  ON compatibility_resolutions(broken_entry_hash, generated_at DESC);

CREATE TABLE moderation_events (
  event_id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL CHECK (record_type IN ('ENTRY', 'RESOLUTION')),
  record_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CORRECT', 'TAKEDOWN', 'REVOKE', 'RESTORE')),
  reason_class TEXT NOT NULL,
  replacement_hash TEXT,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TABLE moderation_state (
  record_type TEXT NOT NULL CHECK (record_type IN ('ENTRY', 'RESOLUTION')),
  record_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CORRECT', 'TAKEDOWN', 'REVOKE', 'RESTORE')),
  reason_class TEXT NOT NULL,
  replacement_hash TEXT,
  event_id TEXT NOT NULL REFERENCES moderation_events(event_id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (record_type, record_hash)
) STRICT;

CREATE TABLE lifecycle_installations (
  installation_id TEXT PRIMARY KEY,
  registration_idempotency_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  external INTEGER NOT NULL CHECK (external IN (0, 1)),
  demo INTEGER NOT NULL CHECK (demo IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE lifecycle_installation_status_events (
  event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES lifecycle_installations(installation_id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  reason_class TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TABLE lifecycle_events (
  ingestion_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  event_day TEXT NOT NULL,
  release_version TEXT NOT NULL,
  channel TEXT NOT NULL,
  external INTEGER NOT NULL CHECK (external IN (0, 1)),
  demo INTEGER NOT NULL CHECK (demo IN (0, 1)),
  measurement_class TEXT NOT NULL CHECK (measurement_class = 'UNVERIFIED_TELEMETRY'),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('INDIVIDUAL_INSTALLATION', 'ORGANIZATION')),
  subject_pseudo_hash TEXT NOT NULL,
  installation_pseudo_hash TEXT NOT NULL,
  organization_pseudo_hash TEXT,
  event_sha256 TEXT NOT NULL,
  sanitized_json TEXT NOT NULL,
  received_at TEXT NOT NULL
) STRICT;

CREATE INDEX lifecycle_subject_day_idx
  ON lifecycle_events(subject_type, subject_pseudo_hash, event_day, event_name);
CREATE INDEX lifecycle_channel_day_idx
  ON lifecycle_events(channel, event_day, event_name);

CREATE TABLE frequency_pairs (
  ingestion_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version TEXT NOT NULL CHECK (schema_version = 'diffwitness-first-100-entry/v1'),
  kind TEXT NOT NULL CHECK (kind = 'pair'),
  registration_id TEXT NOT NULL,
  publisher_key_id TEXT NOT NULL REFERENCES publishers(key_id),
  request_id TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  external INTEGER NOT NULL CHECK (external IN (0, 1)),
  opted_in INTEGER NOT NULL CHECK (opted_in IN (0, 1)),
  inspection_started INTEGER NOT NULL CHECK (inspection_started = 0),
  eligibility_decision TEXT NOT NULL CHECK (eligibility_decision IN ('INCLUDED', 'EXCLUDED')),
  eligibility_decided_at TEXT NOT NULL,
  eligibility_reason TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  component_identity TEXT NOT NULL,
  current_exact_identity TEXT NOT NULL,
  candidate_exact_identity TEXT NOT NULL,
  real_update_intent INTEGER NOT NULL CHECK (real_update_intent IN (0, 1)),
  dedup_key TEXT NOT NULL,
  included_dedup_key TEXT UNIQUE,
  received_body_sha256 TEXT NOT NULL
) STRICT;

CREATE INDEX frequency_pairs_component_included_idx
  ON frequency_pairs(ecosystem, component_identity, eligibility_decision, ingestion_sequence);

-- D1 serializes the write guarded by this trigger, so concurrent requests
-- cannot create a 101st included pair or a 21st pair for one component.
CREATE TRIGGER frequency_pairs_included_caps
BEFORE INSERT ON frequency_pairs
WHEN NEW.eligibility_decision = 'INCLUDED'
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_SAMPLE_CLOSED')
    WHERE (SELECT COUNT(*) FROM frequency_pairs WHERE eligibility_decision = 'INCLUDED') >= 100;
  SELECT RAISE(ABORT, 'FIRST_100_COMPONENT_CAP')
    WHERE (SELECT COUNT(*) FROM frequency_pairs
           WHERE eligibility_decision = 'INCLUDED'
             AND ecosystem = NEW.ecosystem
             AND component_identity = NEW.component_identity) >= 20;
END;

CREATE TABLE frequency_evaluations (
  ingestion_sequence INTEGER PRIMARY KEY REFERENCES frequency_pairs(ingestion_sequence),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('SAFE', 'CHANGED', 'HOLD')),
  receipt_hash TEXT NOT NULL,
  false_compatible INTEGER NOT NULL CHECK (false_compatible IN (0, 1)),
  materiality_classification TEXT NOT NULL CHECK (materiality_classification IN ('MATERIAL', 'NON_MATERIAL', 'INCONCLUSIVE')),
  evidence_complete INTEGER NOT NULL CHECK (evidence_complete IN (0, 1)),
  workflow_consequences_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;
