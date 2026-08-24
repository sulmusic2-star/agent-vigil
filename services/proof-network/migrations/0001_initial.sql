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

-- A revoked key can never regain authority. The only restoration transition is
-- SUSPENDED -> ACTIVE with an explicit RESTORED event. Keeping this invariant
-- in D1 closes the check/write race between a Worker authorization read and a
-- concurrent administrative status change.
CREATE TRIGGER publisher_status_transition_guard
BEFORE INSERT ON publisher_status_events
BEGIN
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TRANSITION_INVALID')
    WHERE NEW.reason_class = 'INITIAL_REGISTRATION'
      AND (NEW.status <> 'ACTIVE'
        OR (SELECT status FROM publishers WHERE key_id = NEW.key_id) <> 'ACTIVE'
        OR (SELECT registered_at FROM publishers WHERE key_id = NEW.key_id) <> NEW.occurred_at
        OR EXISTS (SELECT 1 FROM publisher_status_events WHERE key_id = NEW.key_id));
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TERMINAL')
    WHERE NEW.reason_class <> 'INITIAL_REGISTRATION'
      AND (SELECT status FROM publishers WHERE key_id = NEW.key_id) = 'REVOKED';
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TRANSITION_INVALID')
    WHERE NEW.reason_class <> 'INITIAL_REGISTRATION'
      AND (SELECT status FROM publishers WHERE key_id = NEW.key_id) = NEW.status;
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TRANSITION_INVALID')
    WHERE NEW.reason_class <> 'INITIAL_REGISTRATION'
      AND NEW.status = 'ACTIVE'
      AND ((SELECT status FROM publishers WHERE key_id = NEW.key_id) <> 'SUSPENDED'
        OR NEW.reason_class <> 'RESTORED');
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TRANSITION_INVALID')
    WHERE NEW.reason_class <> 'INITIAL_REGISTRATION'
      AND NEW.status <> 'ACTIVE' AND NEW.reason_class = 'RESTORED';
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TRANSITION_INVALID')
    WHERE NEW.reason_class <> 'INITIAL_REGISTRATION'
      AND NEW.reason_class = 'COMPROMISED' AND NEW.status <> 'REVOKED';
END;

CREATE TRIGGER publishers_status_update_guard
BEFORE UPDATE OF status ON publishers
BEGIN
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TERMINAL')
    WHERE OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED';
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TRANSITION_INVALID')
    WHERE OLD.status = NEW.status;
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TRANSITION_INVALID')
    WHERE NEW.status = 'ACTIVE' AND OLD.status <> 'SUSPENDED';
  SELECT RAISE(ABORT, 'PUBLISHER_STATUS_TRANSITION_INVALID')
    WHERE NOT EXISTS (
      SELECT 1 FROM publisher_status_events
       WHERE key_id = NEW.key_id
         AND status = NEW.status
         AND occurred_at = NEW.updated_at
    );
END;

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

CREATE TRIGGER compatibility_entries_active_publisher
BEFORE INSERT ON compatibility_entries
BEGIN
  SELECT RAISE(ABORT, 'PUBLISHER_NOT_ACTIVE')
    WHERE NOT EXISTS (
      SELECT 1 FROM publishers
       WHERE key_id = NEW.key_id AND status = 'ACTIVE'
    );
END;

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

-- Public resolution trust is transitive: the resolution, its signer, and both
-- exact entry referents must all remain active and free of current correction,
-- takedown, or revocation state. RESTORE is an explicit current-state clear.
CREATE VIEW public_compatibility_entries AS
SELECT entry.*,
       publisher.updated_at AS entry_publisher_updated_at,
       moderation.action AS entry_moderation_action,
       moderation.updated_at AS entry_moderation_updated_at
  FROM compatibility_entries entry
  JOIN publishers publisher ON publisher.key_id = entry.key_id
  LEFT JOIN moderation_state moderation
    ON moderation.record_type = 'ENTRY' AND moderation.record_hash = entry.entry_hash
 WHERE publisher.status = 'ACTIVE'
   AND (moderation.action IS NULL OR moderation.action = 'RESTORE');

CREATE VIEW public_compatibility_resolutions AS
SELECT resolution.*,
       resolution_publisher.updated_at AS resolution_publisher_updated_at,
       resolution_moderation.action AS resolution_moderation_action,
       resolution_moderation.updated_at AS resolution_moderation_updated_at,
       broken.entry_publisher_updated_at AS broken_publisher_updated_at,
       broken.entry_moderation_action AS broken_moderation_action,
       broken.entry_moderation_updated_at AS broken_moderation_updated_at,
       fixed.entry_publisher_updated_at AS fixed_publisher_updated_at,
       fixed.entry_moderation_action AS fixed_moderation_action,
       fixed.entry_moderation_updated_at AS fixed_moderation_updated_at
  FROM compatibility_resolutions resolution
  JOIN publishers resolution_publisher ON resolution_publisher.key_id = resolution.key_id
  LEFT JOIN moderation_state resolution_moderation
    ON resolution_moderation.record_type = 'RESOLUTION'
   AND resolution_moderation.record_hash = resolution.resolution_hash
  JOIN public_compatibility_entries broken ON broken.entry_hash = resolution.broken_entry_hash
  JOIN public_compatibility_entries fixed ON fixed.entry_hash = resolution.fixed_entry_hash
 WHERE resolution_publisher.status = 'ACTIVE'
   AND (resolution_moderation.action IS NULL OR resolution_moderation.action = 'RESTORE');

-- Admission is protected at the write boundary as well as in the Worker so a
-- concurrent moderation or publisher-status change cannot create a resolution
-- whose transitive evidence is already unavailable.
CREATE TRIGGER compatibility_resolutions_public_referents
BEFORE INSERT ON compatibility_resolutions
BEGIN
  SELECT RAISE(ABORT, 'PUBLISHER_NOT_ACTIVE')
    WHERE NOT EXISTS (
      SELECT 1 FROM publishers
       WHERE key_id = NEW.key_id AND status = 'ACTIVE'
    );
  SELECT RAISE(ABORT, 'RESOLUTION_REFERENT_UNAVAILABLE')
    WHERE NOT EXISTS (
      SELECT 1 FROM public_compatibility_entries
       WHERE entry_hash = NEW.broken_entry_hash
    );
  SELECT RAISE(ABORT, 'RESOLUTION_REFERENT_UNAVAILABLE')
    WHERE NOT EXISTS (
      SELECT 1 FROM public_compatibility_entries
       WHERE entry_hash = NEW.fixed_entry_hash
    );
END;

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

-- Installation secrets are deterministically derived. Revocation therefore
-- has to be terminal; reactivating the same ID would reactivate the same
-- compromised credential.
CREATE TRIGGER lifecycle_installation_status_transition_guard
BEFORE INSERT ON lifecycle_installation_status_events
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_STATUS_TERMINAL')
    WHERE (SELECT status FROM lifecycle_installations
            WHERE installation_id = NEW.installation_id) = 'REVOKED';
  SELECT RAISE(ABORT, 'LIFECYCLE_STATUS_TRANSITION_INVALID')
    WHERE NEW.status <> 'REVOKED' OR NEW.reason_class = 'RESTORED';
END;

CREATE TRIGGER lifecycle_installations_status_update_guard
BEFORE UPDATE OF status ON lifecycle_installations
BEGIN
  SELECT RAISE(ABORT, 'LIFECYCLE_STATUS_TERMINAL')
    WHERE OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED';
  SELECT RAISE(ABORT, 'LIFECYCLE_STATUS_TRANSITION_INVALID')
    WHERE OLD.status = NEW.status OR NEW.status <> 'REVOKED';
  SELECT RAISE(ABORT, 'LIFECYCLE_STATUS_TRANSITION_INVALID')
    WHERE NOT EXISTS (
      SELECT 1 FROM lifecycle_installation_status_events
       WHERE installation_id = NEW.installation_id
         AND status = NEW.status
         AND occurred_at = NEW.updated_at
    );
END;

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
  component_identity TEXT NOT NULL CHECK (
    length(component_identity) BETWEEN 1 AND 160
    AND component_identity = lower(component_identity)
    AND component_identity GLOB '[a-z0-9@]*'
    AND component_identity NOT GLOB '*[^a-z0-9@/._-]*'
  ),
  current_exact_identity TEXT NOT NULL,
  candidate_exact_identity TEXT NOT NULL,
  real_update_intent INTEGER NOT NULL CHECK (real_update_intent IN (0, 1)),
  dedup_key TEXT NOT NULL,
  included_dedup_key TEXT UNIQUE,
  received_body_sha256 TEXT NOT NULL
) STRICT;

CREATE INDEX frequency_pairs_component_included_idx
  ON frequency_pairs(component_identity, eligibility_decision, ingestion_sequence);

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
             AND component_identity = NEW.component_identity) >= 20;
END;

CREATE TRIGGER frequency_pairs_active_publisher
BEFORE INSERT ON frequency_pairs
BEGIN
  SELECT RAISE(ABORT, 'PUBLISHER_NOT_ACTIVE')
    WHERE NOT EXISTS (
      SELECT 1 FROM publishers
       WHERE key_id = NEW.publisher_key_id AND status = 'ACTIVE'
    );
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

-- A complete evaluation has one coherent state. MATERIAL is a demonstrated
-- regression: CHANGED is correctly detected, while SAFE is explicitly a
-- false-compatible result. HOLD is the only inconclusive state. Direct D1
-- writes therefore cannot bypass the Worker/schema cross-field contract.
CREATE TRIGGER frequency_evaluations_coherence_guard
BEFORE INSERT ON frequency_evaluations
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_EVALUATION_CONTRADICTORY')
    WHERE json_valid(NEW.workflow_consequences_json) <> 1
       OR json_type(NEW.workflow_consequences_json) <> 'array';
  SELECT RAISE(ABORT, 'FIRST_100_EVALUATION_CONTRADICTORY')
    WHERE (NEW.materiality_classification = 'MATERIAL'
           AND (NEW.verdict = 'HOLD'
             OR NEW.evidence_complete <> 1
             OR json_array_length(NEW.workflow_consequences_json) = 0
             OR NEW.false_compatible <> CASE WHEN NEW.verdict = 'SAFE' THEN 1 ELSE 0 END))
       OR (NEW.materiality_classification = 'NON_MATERIAL'
           AND (NEW.verdict = 'HOLD'
             OR NEW.evidence_complete <> 1
             OR json_array_length(NEW.workflow_consequences_json) <> 0
             OR NEW.false_compatible <> 0))
       OR (NEW.materiality_classification = 'INCONCLUSIVE'
           AND (NEW.verdict <> 'HOLD'
             OR NEW.evidence_complete <> 0
             OR json_array_length(NEW.workflow_consequences_json) <> 0
             OR NEW.false_compatible <> 0));
END;

CREATE TRIGGER frequency_evaluations_coherence_guard_update
BEFORE UPDATE ON frequency_evaluations
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_EVALUATION_CONTRADICTORY')
    WHERE json_valid(NEW.workflow_consequences_json) <> 1
       OR json_type(NEW.workflow_consequences_json) <> 'array';
  SELECT RAISE(ABORT, 'FIRST_100_EVALUATION_CONTRADICTORY')
    WHERE (NEW.materiality_classification = 'MATERIAL'
           AND (NEW.verdict = 'HOLD'
             OR NEW.evidence_complete <> 1
             OR json_array_length(NEW.workflow_consequences_json) = 0
             OR NEW.false_compatible <> CASE WHEN NEW.verdict = 'SAFE' THEN 1 ELSE 0 END))
       OR (NEW.materiality_classification = 'NON_MATERIAL'
           AND (NEW.verdict = 'HOLD'
             OR NEW.evidence_complete <> 1
             OR json_array_length(NEW.workflow_consequences_json) <> 0
             OR NEW.false_compatible <> 0))
       OR (NEW.materiality_classification = 'INCONCLUSIVE'
           AND (NEW.verdict <> 'HOLD'
             OR NEW.evidence_complete <> 0
             OR json_array_length(NEW.workflow_consequences_json) <> 0
             OR NEW.false_compatible <> 0));
END;

CREATE TRIGGER frequency_evaluations_active_publisher
BEFORE INSERT ON frequency_evaluations
BEGIN
  SELECT RAISE(ABORT, 'FIRST_100_PUBLISHER_NOT_ACTIVE')
    WHERE NOT EXISTS (
      SELECT 1
        FROM frequency_pairs pair
        JOIN publishers publisher ON publisher.key_id = pair.publisher_key_id
       WHERE pair.ingestion_sequence = NEW.ingestion_sequence
         AND publisher.status = 'ACTIVE'
    );
END;
