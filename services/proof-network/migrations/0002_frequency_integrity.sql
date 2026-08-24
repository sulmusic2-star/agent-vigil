PRAGMA foreign_keys = ON;

-- The first-100 service was not deployed before this migration. These columns
-- bind every new chronological row to a server-created acquisition handle and,
-- when eligible, to a separately registered adapter attestation.
ALTER TABLE frequency_pairs ADD COLUMN acquisition_handle TEXT;
ALTER TABLE frequency_pairs ADD COLUMN raw_event_sha256 TEXT;
ALTER TABLE frequency_pairs ADD COLUMN adapter_key_id TEXT REFERENCES frequency_adapters(key_id);
ALTER TABLE frequency_pairs ADD COLUMN adapter_version TEXT;
ALTER TABLE frequency_pairs ADD COLUMN adapter_event_id TEXT;
ALTER TABLE frequency_pairs ADD COLUMN adapter_observed_at TEXT;
ALTER TABLE frequency_pairs ADD COLUMN adapter_attestation_sha256 TEXT;

CREATE UNIQUE INDEX frequency_pairs_acquisition_handle_idx
  ON frequency_pairs(acquisition_handle);
CREATE UNIQUE INDEX frequency_pairs_adapter_event_idx
  ON frequency_pairs(adapter_event_id)
  WHERE adapter_event_id IS NOT NULL;
CREATE INDEX frequency_pairs_channel_sequence_idx
  ON frequency_pairs(channel, ingestion_sequence);
CREATE INDEX frequency_pairs_publisher_sequence_idx
  ON frequency_pairs(publisher_key_id, ingestion_sequence);

CREATE TABLE frequency_adapters (
  key_id TEXT PRIMARY KEY CHECK (key_id GLOB 'sha256:*' AND length(key_id) = 71),
  public_key_b64 TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE frequency_adapter_status_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL REFERENCES frequency_adapters(key_id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  reason_class TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER frequency_adapter_key_duty_separation
BEFORE INSERT ON frequency_adapters
BEGIN
  SELECT RAISE(ABORT, 'FREQUENCY_KEY_DUTY_CONFLICT')
    WHERE EXISTS (SELECT 1 FROM publishers WHERE key_id = NEW.key_id);
END;

CREATE TRIGGER frequency_publisher_key_duty_separation
BEFORE INSERT ON publishers
BEGIN
  SELECT RAISE(ABORT, 'FREQUENCY_KEY_DUTY_CONFLICT')
    WHERE EXISTS (SELECT 1 FROM frequency_adapters WHERE key_id = NEW.key_id);
END;

CREATE TRIGGER frequency_adapter_status_transition_guard
BEFORE INSERT ON frequency_adapter_status_events
BEGIN
  SELECT RAISE(ABORT, 'FREQUENCY_ADAPTER_STATUS_TRANSITION_INVALID')
    WHERE NEW.reason_class = 'INITIAL_REGISTRATION'
      AND (NEW.status <> 'ACTIVE'
        OR (SELECT status FROM frequency_adapters WHERE key_id = NEW.key_id) <> 'ACTIVE'
        OR EXISTS (SELECT 1 FROM frequency_adapter_status_events WHERE key_id = NEW.key_id));
  SELECT RAISE(ABORT, 'FREQUENCY_ADAPTER_STATUS_TERMINAL')
    WHERE NEW.reason_class <> 'INITIAL_REGISTRATION'
      AND (SELECT status FROM frequency_adapters WHERE key_id = NEW.key_id) = 'REVOKED';
  SELECT RAISE(ABORT, 'FREQUENCY_ADAPTER_STATUS_TRANSITION_INVALID')
    WHERE NEW.reason_class <> 'INITIAL_REGISTRATION' AND NEW.status <> 'REVOKED';
END;

CREATE TRIGGER frequency_adapters_status_update_guard
BEFORE UPDATE OF status ON frequency_adapters
BEGIN
  SELECT RAISE(ABORT, 'FREQUENCY_ADAPTER_STATUS_TERMINAL')
    WHERE OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED';
  SELECT RAISE(ABORT, 'FREQUENCY_ADAPTER_STATUS_TRANSITION_INVALID')
    WHERE OLD.status = NEW.status OR NEW.status <> 'REVOKED';
  SELECT RAISE(ABORT, 'FREQUENCY_ADAPTER_STATUS_TRANSITION_INVALID')
    WHERE NOT EXISTS (
      SELECT 1 FROM frequency_adapter_status_events
       WHERE key_id = NEW.key_id AND status = NEW.status AND occurred_at = NEW.updated_at
    );
END;

-- This table is the global, database-assigned publisher-moderation clock. It is
-- independent of caller timestamps and is included in every signed export/head.
CREATE TABLE frequency_publisher_checkpoints (
  checkpoint_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL REFERENCES publishers(key_id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  reason_class TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

INSERT INTO frequency_publisher_checkpoints
  (event_id, key_id, status, reason_class, occurred_at)
SELECT event_id, key_id, status, reason_class, occurred_at
  FROM publisher_status_events
 ORDER BY rowid;

CREATE TRIGGER frequency_publisher_checkpoint_append
AFTER INSERT ON publisher_status_events
BEGIN
  INSERT INTO frequency_publisher_checkpoints
    (event_id, key_id, status, reason_class, occurred_at)
  VALUES (NEW.event_id, NEW.key_id, NEW.status, NEW.reason_class, NEW.occurred_at);
END;

CREATE TABLE frequency_artifact_access_grants (
  grant_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  acquisition_handle TEXT NOT NULL UNIQUE,
  ingestion_sequence INTEGER NOT NULL UNIQUE REFERENCES frequency_pairs(ingestion_sequence),
  publisher_key_id TEXT NOT NULL REFERENCES publishers(key_id),
  adapter_key_id TEXT NOT NULL REFERENCES frequency_adapters(key_id),
  requested_at TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  request_sha256 TEXT NOT NULL
) STRICT;

CREATE TABLE frequency_stop_events (
  stop_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('GLOBAL', 'CHANNEL', 'PUBLISHER', 'SAMPLE')),
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'GLOBAL_ROW_CAP', 'CHANNEL_ROW_CAP', 'PUBLISHER_ROW_CAP', 'INCLUDED_SAMPLE_CLOSED'
  )),
  publisher_key_id TEXT NOT NULL REFERENCES publishers(key_id),
  channel TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_body_sha256 TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (scope_type, scope_id, reason)
) STRICT;

-- All rows count, including exclusions. D1 serializes trigger evaluation with
-- the INSERT, so simultaneous final writes cannot exceed any bound.
CREATE TRIGGER frequency_pairs_all_row_caps
BEFORE INSERT ON frequency_pairs
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_GLOBAL_ROW_CAP')
    WHERE (SELECT COUNT(*) FROM frequency_pairs) >= 1000;
  SELECT RAISE(ABORT, 'FIRST_100_CHANNEL_ROW_CAP')
    WHERE (SELECT COUNT(*) FROM frequency_pairs WHERE channel = NEW.channel) >= 500;
  SELECT RAISE(ABORT, 'FIRST_100_PUBLISHER_ROW_CAP')
    WHERE (SELECT COUNT(*) FROM frequency_pairs WHERE publisher_key_id = NEW.publisher_key_id) >= 400;
END;

-- Once the database serializes the 100th included row, no later exclusion may
-- slip past the frozen chronological boundary during a concurrent request.
CREATE TRIGGER frequency_pairs_sample_closed_all_rows
BEFORE INSERT ON frequency_pairs
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_SAMPLE_CLOSED')
    WHERE (SELECT COUNT(*) FROM frequency_pairs WHERE eligibility_decision = 'INCLUDED') >= 100;
END;

-- Callers never choose eligibility. A direct D1 write cannot create an included
-- row without an ACTIVE, version-bound adapter attestation and server handle.
CREATE TRIGGER frequency_pairs_acquisition_integrity
BEFORE INSERT ON frequency_pairs
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_ACQUISITION_HANDLE_REQUIRED')
    WHERE NEW.acquisition_handle IS NULL OR length(NEW.acquisition_handle) <> 36;
  SELECT RAISE(ABORT, 'FIRST_100_RAW_EVENT_REQUIRED')
    WHERE NEW.raw_event_sha256 IS NULL
       OR NEW.raw_event_sha256 NOT GLOB 'sha256:*'
       OR length(NEW.raw_event_sha256) <> 71;
  SELECT RAISE(ABORT, 'FIRST_100_TRUSTED_ADAPTER_REQUIRED')
    WHERE NEW.eligibility_decision = 'INCLUDED'
      AND (NEW.adapter_key_id IS NULL
        OR NEW.adapter_version IS NULL
        OR NEW.adapter_event_id IS NULL
        OR NEW.adapter_observed_at IS NULL
        OR NEW.adapter_attestation_sha256 IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM frequency_adapters
           WHERE key_id = NEW.adapter_key_id
             AND version = NEW.adapter_version
             AND status = 'ACTIVE'
        ));
  SELECT RAISE(ABORT, 'FIRST_100_UNTRUSTED_REASON_INVALID')
    WHERE NEW.adapter_key_id IS NULL
      AND (NEW.eligibility_decision <> 'EXCLUDED'
        OR NEW.eligibility_reason <> 'MALFORMED_PREINSPECTION_RECORD');
END;

CREATE TRIGGER frequency_artifact_access_grant_guard
BEFORE INSERT ON frequency_artifact_access_grants
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_ACCESS_GRANT_INVALID')
    WHERE NOT EXISTS (
      SELECT 1
        FROM frequency_pairs pair
        JOIN publishers publisher ON publisher.key_id = pair.publisher_key_id
        JOIN frequency_adapters adapter ON adapter.key_id = pair.adapter_key_id
       WHERE pair.ingestion_sequence = NEW.ingestion_sequence
         AND pair.acquisition_handle = NEW.acquisition_handle
         AND pair.publisher_key_id = NEW.publisher_key_id
         AND pair.adapter_key_id = NEW.adapter_key_id
         AND pair.eligibility_decision = 'INCLUDED'
         AND pair.received_at <= NEW.requested_at
         AND publisher.status = 'ACTIVE'
         AND adapter.status = 'ACTIVE'
    );
END;

CREATE TRIGGER frequency_evaluations_access_grant_guard
BEFORE INSERT ON frequency_evaluations
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_ARTIFACT_ACCESS_NOT_GRANTED')
    WHERE NOT EXISTS (
      SELECT 1
        FROM frequency_artifact_access_grants grant_record
       WHERE grant_record.ingestion_sequence = NEW.ingestion_sequence
         AND grant_record.granted_at <= NEW.started_at
    );
END;
