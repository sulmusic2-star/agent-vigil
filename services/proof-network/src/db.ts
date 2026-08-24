import {
  canonical,
  sha256,
  type CompatibilityResolution,
  type PublicCompatibilityEntry,
  type SanitizedLifecycleEvent,
  type Verdict,
} from "./contracts";

export type PublisherStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

export type LifecycleInstallationStatus = "ACTIVE" | "REVOKED";

export type LifecycleInstallationRow = {
  installation_id: string;
  registration_idempotency_key: string;
  channel: string;
  external: number;
  demo: number;
  status: LifecycleInstallationStatus;
  registered_at: string;
  updated_at: string;
};

export type PublisherRow = {
  key_id: string;
  public_key_b64: string;
  status: PublisherStatus;
  registered_at: string;
  updated_at: string;
};

export type StoredJsonRow = {
  body_json: string;
  key_id: string;
  generated_at: string;
  published_at: string;
};

export type PublicEntryRow = StoredJsonRow & {
  entry_publisher_updated_at: string;
  entry_moderation_action: "RESTORE" | null;
  entry_moderation_updated_at: string | null;
};

export type PublicResolutionRow = StoredJsonRow & {
  resolution_publisher_updated_at: string;
  resolution_moderation_action: "RESTORE" | null;
  resolution_moderation_updated_at: string | null;
  broken_publisher_updated_at: string;
  broken_moderation_action: "RESTORE" | null;
  broken_moderation_updated_at: string | null;
  fixed_publisher_updated_at: string;
  fixed_moderation_action: "RESTORE" | null;
  fixed_moderation_updated_at: string | null;
};

export type ModerationState = {
  action: "CORRECT" | "TAKEDOWN" | "REVOKE" | "RESTORE";
  reason_class: string;
  replacement_hash: string | null;
  event_id: string;
  updated_at: string;
};

export type EntrySummary = {
  entryHash: string;
  keyId: string;
  ecosystem: string;
  componentName: string;
  currentVersion: string;
  candidateVersion: string;
  verdict: Verdict;
  generatedAt: string;
  publishedAt: string;
  resolutionHash?: string;
  fixedEntryHash?: string;
};

type EntrySummaryRow = {
  entry_hash: string;
  key_id: string;
  ecosystem: string;
  component_name: string;
  current_version: string;
  candidate_version: string;
  verdict: Verdict;
  generated_at: string;
  published_at: string;
  resolution_hash: string | null;
  fixed_entry_hash: string | null;
};

export type SearchFilters = {
  ecosystem?: string;
  component?: string;
  currentVersion?: string;
  candidateVersion?: string;
  verdict?: Verdict;
  query?: string;
  limit: number;
};

export async function getPublisher(db: D1Database, keyId: string): Promise<PublisherRow | null> {
  return db.prepare(
    "SELECT key_id, public_key_b64, status, registered_at, updated_at FROM publishers WHERE key_id = ?",
  ).bind(keyId).first<PublisherRow>();
}

export async function registerPublisher(
  db: D1Database,
  input: { eventId: string; keyId: string; publicKey: string; occurredAt: string },
): Promise<{ created: boolean; publisher: PublisherRow }> {
  const existing = await getPublisher(db, input.keyId);
  if (existing) {
    if (existing.public_key_b64 !== input.publicKey) throw new Error("publisher key registration conflicts with existing key material");
    return { created: false, publisher: existing };
  }
  await db.batch([
    db.prepare(
      "INSERT INTO publishers (key_id, public_key_b64, status, registered_at, updated_at) VALUES (?, ?, 'ACTIVE', ?, ?)",
    ).bind(input.keyId, input.publicKey, input.occurredAt, input.occurredAt),
    db.prepare(
      "INSERT INTO publisher_status_events (event_id, key_id, status, reason_class, occurred_at) VALUES (?, ?, 'ACTIVE', 'INITIAL_REGISTRATION', ?)",
    ).bind(input.eventId, input.keyId, input.occurredAt),
  ]);
  const publisher = await getPublisher(db, input.keyId);
  if (!publisher) throw new Error("publisher registration did not become visible");
  return { created: true, publisher };
}

export async function updatePublisherStatus(
  db: D1Database,
  input: { eventId: string; keyId: string; status: PublisherStatus; reasonClass: string; occurredAt: string },
): Promise<PublisherRow> {
  const existingEvent = await db.prepare(
    "SELECT key_id, status, reason_class FROM publisher_status_events WHERE event_id = ?",
  ).bind(input.eventId).first<{ key_id: string; status: PublisherStatus; reason_class: string }>();
  if (existingEvent) {
    if (existingEvent.key_id !== input.keyId || existingEvent.status !== input.status
      || existingEvent.reason_class !== input.reasonClass) {
      throw new Error("publisher status event ID conflicts with different content");
    }
  } else {
    const publisher = await getPublisher(db, input.keyId);
    if (!publisher) throw new Error("publisher is not registered");
    if (publisher.status === "REVOKED") throw new Error("PUBLISHER_STATUS_TERMINAL");
    if (publisher.status === input.status) throw new Error("PUBLISHER_STATUS_TRANSITION_INVALID");
    if (input.status === "ACTIVE" && (publisher.status !== "SUSPENDED" || input.reasonClass !== "RESTORED")) {
      throw new Error("PUBLISHER_STATUS_TRANSITION_INVALID");
    }
    if (input.status !== "ACTIVE" && input.reasonClass === "RESTORED") {
      throw new Error("PUBLISHER_STATUS_TRANSITION_INVALID");
    }
    if (input.reasonClass === "COMPROMISED" && input.status !== "REVOKED") {
      throw new Error("PUBLISHER_STATUS_TRANSITION_INVALID");
    }
    await db.batch([
      db.prepare(
        "INSERT INTO publisher_status_events (event_id, key_id, status, reason_class, occurred_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(input.eventId, input.keyId, input.status, input.reasonClass, input.occurredAt),
      db.prepare(
        "UPDATE publishers SET status = ?, updated_at = ? WHERE key_id = ?",
      ).bind(input.status, input.occurredAt, input.keyId),
    ]);
  }
  const publisher = await getPublisher(db, input.keyId);
  if (!publisher) throw new Error("publisher is not registered");
  return publisher;
}

export async function getLifecycleInstallation(
  db: D1Database,
  installationId: string,
): Promise<LifecycleInstallationRow | null> {
  return db.prepare(
    `SELECT installation_id, registration_idempotency_key, channel, external, demo, status, registered_at, updated_at
       FROM lifecycle_installations WHERE installation_id = ?`,
  ).bind(installationId).first<LifecycleInstallationRow>();
}

export async function registerLifecycleInstallation(
  db: D1Database,
  input: {
    installationId: string;
    idempotencyKey: string;
    channel: string;
    external: boolean;
    demo: boolean;
    registeredAt: string;
  },
): Promise<{ created: boolean; installation: LifecycleInstallationRow }> {
  const existing = await db.prepare(
    `SELECT installation_id, registration_idempotency_key, channel, external, demo, status, registered_at, updated_at
       FROM lifecycle_installations WHERE registration_idempotency_key = ?`,
  ).bind(input.idempotencyKey).first<LifecycleInstallationRow>();
  if (existing) {
    if (existing.channel !== input.channel || existing.external !== (input.external ? 1 : 0)
      || existing.demo !== (input.demo ? 1 : 0)) {
      throw new Error("lifecycle registration idempotency key conflicts with different registration attributes");
    }
    return { created: false, installation: existing };
  }
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO lifecycle_installations
      (installation_id, registration_idempotency_key, channel, external, demo, status, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
  ).bind(
    input.installationId,
    input.idempotencyKey,
    input.channel,
    input.external ? 1 : 0,
    input.demo ? 1 : 0,
    input.registeredAt,
    input.registeredAt,
  ).run();
  const installation = await db.prepare(
    `SELECT installation_id, registration_idempotency_key, channel, external, demo, status, registered_at, updated_at
       FROM lifecycle_installations WHERE registration_idempotency_key = ?`,
  ).bind(input.idempotencyKey).first<LifecycleInstallationRow>();
  if (!installation) throw new Error("lifecycle installation registration did not become visible");
  return { created: installation.installation_id === input.installationId, installation };
}

export async function updateLifecycleInstallationStatus(
  db: D1Database,
  input: {
    eventId: string;
    installationId: string;
    status: LifecycleInstallationStatus;
    reasonClass: string;
    occurredAt: string;
  },
): Promise<LifecycleInstallationRow> {
  const existingEvent = await db.prepare(
    `SELECT installation_id, status, reason_class, occurred_at
       FROM lifecycle_installation_status_events WHERE event_id = ?`,
  ).bind(input.eventId).first<{
    installation_id: string;
    status: LifecycleInstallationStatus;
    reason_class: string;
    occurred_at: string;
  }>();
  if (existingEvent) {
    if (existingEvent.installation_id !== input.installationId || existingEvent.status !== input.status
      || existingEvent.reason_class !== input.reasonClass) {
      throw new Error("lifecycle installation status event ID conflicts with different content");
    }
  } else {
    const installation = await getLifecycleInstallation(db, input.installationId);
    if (!installation) throw new Error("lifecycle installation is not registered");
    if (installation.status === "REVOKED") throw new Error("LIFECYCLE_STATUS_TERMINAL");
    if (input.status !== "REVOKED" || input.reasonClass === "RESTORED") {
      throw new Error("LIFECYCLE_STATUS_TRANSITION_INVALID");
    }
    await db.batch([
      db.prepare(
        `INSERT INTO lifecycle_installation_status_events
          (event_id, installation_id, status, reason_class, occurred_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(input.eventId, input.installationId, input.status, input.reasonClass, input.occurredAt),
      db.prepare(
        "UPDATE lifecycle_installations SET status = ?, updated_at = ? WHERE installation_id = ?",
      ).bind(input.status, input.occurredAt, input.installationId),
    ]);
  }
  const installation = await getLifecycleInstallation(db, input.installationId);
  if (!installation) throw new Error("lifecycle installation status did not become visible");
  return installation;
}

export async function storeEntry(
  db: D1Database,
  entry: PublicCompatibilityEntry,
  publishedAt: string,
): Promise<{ created: boolean }> {
  const bodyJson = canonical(entry);
  const bodySha256 = await sha256(bodyJson);
  const existing = await db.prepare(
    "SELECT body_sha256 FROM compatibility_entries WHERE entry_hash = ?",
  ).bind(entry.entryHash).first<{ body_sha256: string }>();
  if (existing) {
    if (existing.body_sha256 !== bodySha256) throw new Error("entry hash conflicts with different stored bytes");
    return { created: false };
  }
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO compatibility_entries
      (entry_hash, key_id, ecosystem, component_name, current_version, candidate_version, verdict, generated_at, published_at, body_sha256, body_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    entry.entryHash,
    entry.signature.keyId,
    entry.component.ecosystem,
    entry.component.name,
    entry.component.currentVersion,
    entry.component.candidateVersion,
    entry.verdict,
    entry.generatedAt,
    publishedAt,
    bodySha256,
    bodyJson,
  ).run();
  const stored = await db.prepare(
    "SELECT body_sha256 FROM compatibility_entries WHERE entry_hash = ?",
  ).bind(entry.entryHash).first<{ body_sha256: string }>();
  if (!stored || stored.body_sha256 !== bodySha256) throw new Error("entry idempotency conflict");
  return { created: Number(inserted.meta.changes) === 1 };
}

export async function getEntryRow(db: D1Database, entryHash: string): Promise<StoredJsonRow | null> {
  return db.prepare(
    "SELECT body_json, key_id, generated_at, published_at FROM compatibility_entries WHERE entry_hash = ?",
  ).bind(entryHash).first<StoredJsonRow>();
}

export async function getPublicEntryRow(db: D1Database, entryHash: string): Promise<PublicEntryRow | null> {
  return db.prepare(
    `SELECT body_json, key_id, generated_at, published_at,
            entry_publisher_updated_at, entry_moderation_action, entry_moderation_updated_at
       FROM public_compatibility_entries
      WHERE entry_hash = ?`,
  ).bind(entryHash).first<PublicEntryRow>();
}

export async function storeResolution(
  db: D1Database,
  resolution: CompatibilityResolution,
  publishedAt: string,
): Promise<{ created: boolean }> {
  const bodyJson = canonical(resolution);
  const bodySha256 = await sha256(bodyJson);
  const existing = await db.prepare(
    "SELECT body_sha256 FROM compatibility_resolutions WHERE resolution_hash = ?",
  ).bind(resolution.resolutionHash).first<{ body_sha256: string }>();
  if (existing) {
    if (existing.body_sha256 !== bodySha256) throw new Error("resolution hash conflicts with different stored bytes");
    return { created: false };
  }
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO compatibility_resolutions
      (resolution_hash, key_id, broken_entry_hash, fixed_entry_hash, ecosystem, component_name, generated_at, published_at, body_sha256, body_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    resolution.resolutionHash,
    resolution.signature.keyId,
    resolution.broken.entryHash,
    resolution.fixed.entryHash,
    resolution.component.ecosystem,
    resolution.component.name,
    resolution.generatedAt,
    publishedAt,
    bodySha256,
    bodyJson,
  ).run();
  const stored = await db.prepare(
    "SELECT body_sha256 FROM compatibility_resolutions WHERE resolution_hash = ?",
  ).bind(resolution.resolutionHash).first<{ body_sha256: string }>();
  if (!stored || stored.body_sha256 !== bodySha256) throw new Error("resolution idempotency conflict");
  return { created: Number(inserted.meta.changes) === 1 };
}

export async function getResolutionRow(db: D1Database, resolutionHash: string): Promise<StoredJsonRow | null> {
  return db.prepare(
    "SELECT body_json, key_id, generated_at, published_at FROM compatibility_resolutions WHERE resolution_hash = ?",
  ).bind(resolutionHash).first<StoredJsonRow>();
}

export async function getPublicResolutionRow(
  db: D1Database,
  resolutionHash: string,
): Promise<PublicResolutionRow | null> {
  return db.prepare(
    `SELECT body_json, key_id, generated_at, published_at,
            resolution_publisher_updated_at, resolution_moderation_action, resolution_moderation_updated_at,
            broken_publisher_updated_at, broken_moderation_action, broken_moderation_updated_at,
            fixed_publisher_updated_at, fixed_moderation_action, fixed_moderation_updated_at
       FROM public_compatibility_resolutions
      WHERE resolution_hash = ?`,
  ).bind(resolutionHash).first<PublicResolutionRow>();
}

export async function getResolutionForBroken(db: D1Database, brokenEntryHash: string): Promise<PublicResolutionRow | null> {
  return db.prepare(
    `SELECT body_json, key_id, generated_at, published_at,
            resolution_publisher_updated_at, resolution_moderation_action, resolution_moderation_updated_at,
            broken_publisher_updated_at, broken_moderation_action, broken_moderation_updated_at,
            fixed_publisher_updated_at, fixed_moderation_action, fixed_moderation_updated_at
       FROM public_compatibility_resolutions
      WHERE broken_entry_hash = ?
      ORDER BY generated_at DESC, resolution_hash ASC
      LIMIT 1`,
  ).bind(brokenEntryHash).first<PublicResolutionRow>();
}

export async function searchEntries(db: D1Database, filters: SearchFilters): Promise<EntrySummary[]> {
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (filters.ecosystem !== undefined) { clauses.push("e.ecosystem = ?"); bindings.push(filters.ecosystem); }
  if (filters.component !== undefined) { clauses.push("e.component_name = ?"); bindings.push(filters.component); }
  if (filters.currentVersion !== undefined) { clauses.push("e.current_version = ?"); bindings.push(filters.currentVersion); }
  if (filters.candidateVersion !== undefined) { clauses.push("e.candidate_version = ?"); bindings.push(filters.candidateVersion); }
  if (filters.verdict !== undefined) { clauses.push("e.verdict = ?"); bindings.push(filters.verdict); }
  if (filters.query !== undefined) {
    clauses.push("(e.component_name LIKE ? ESCAPE '\\' OR e.ecosystem LIKE ? ESCAPE '\\')");
    const escaped = filters.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    bindings.push(`%${escaped}%`, `%${escaped}%`);
  }
  bindings.push(filters.limit);
  const result = await db.prepare(
    `SELECT e.entry_hash, e.key_id, e.ecosystem, e.component_name, e.current_version, e.candidate_version,
            e.verdict, e.generated_at, e.published_at, r.resolution_hash, r.fixed_entry_hash
       FROM public_compatibility_entries e
       LEFT JOIN public_compatibility_resolutions r
         ON r.resolution_hash = (
           SELECT candidate.resolution_hash
             FROM public_compatibility_resolutions candidate
            WHERE candidate.broken_entry_hash = e.entry_hash
            ORDER BY candidate.generated_at DESC, candidate.resolution_hash ASC
            LIMIT 1
         )
      ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
      ORDER BY e.generated_at DESC, e.entry_hash ASC
      LIMIT ?`,
  ).bind(...bindings).all<EntrySummaryRow>();
  return result.results.map((row) => ({
    entryHash: row.entry_hash,
    keyId: row.key_id,
    ecosystem: row.ecosystem,
    componentName: row.component_name,
    currentVersion: row.current_version,
    candidateVersion: row.candidate_version,
    verdict: row.verdict,
    generatedAt: row.generated_at,
    publishedAt: row.published_at,
    ...(row.resolution_hash === null ? {} : { resolutionHash: row.resolution_hash }),
    ...(row.fixed_entry_hash === null ? {} : { fixedEntryHash: row.fixed_entry_hash }),
  }));
}

export async function storeLifecycleEvent(
  db: D1Database,
  event: SanitizedLifecycleEvent,
  receivedAt: string,
  installationId: string,
): Promise<{ created: boolean; ingestionSequence: number; receivedAt: string }> {
  const sanitizedJson = canonical(event);
  const eventSha256 = await sha256(sanitizedJson);
  const existing = await db.prepare(
    "SELECT event_sha256, ingestion_sequence, received_at FROM lifecycle_events WHERE event_id = ?",
  ).bind(event.event_id).first<{ event_sha256: string; ingestion_sequence: number; received_at: string }>();
  if (existing) {
    if (existing.event_sha256 !== eventSha256) throw new Error("lifecycle event ID conflicts with different sanitized content");
    return { created: false, ingestionSequence: existing.ingestion_sequence, receivedAt: existing.received_at };
  }
  const subjectPseudoHash = event.entity_scope === "ORGANIZATION"
    ? event.organization_pseudo_hash
    : event.installation_pseudo_hash;
  if (!subjectPseudoHash) throw new Error("sanitized lifecycle subject is unavailable");
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO lifecycle_events
      (event_id, event_name, event_day, release_version, channel, external, demo, measurement_class,
       subject_type, subject_pseudo_hash, installation_pseudo_hash, organization_pseudo_hash,
       event_sha256, sanitized_json, received_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM lifecycle_installations
          WHERE installation_id = ? AND status = 'ACTIVE'
       )`,
  ).bind(
    event.event_id,
    event.event_name,
    event.event_day,
    event.release_version,
    event.channel,
    event.external ? 1 : 0,
    event.demo ? 1 : 0,
    "UNVERIFIED_TELEMETRY",
    event.entity_scope,
    subjectPseudoHash,
    event.installation_pseudo_hash,
    event.organization_pseudo_hash ?? null,
    eventSha256,
    sanitizedJson,
    receivedAt,
    installationId,
  ).run();
  const stored = await db.prepare(
    "SELECT event_sha256, ingestion_sequence, received_at FROM lifecycle_events WHERE event_id = ?",
  ).bind(event.event_id).first<{ event_sha256: string; ingestion_sequence: number; received_at: string }>();
  if (!stored) {
    const installation = await getLifecycleInstallation(db, installationId);
    if (!installation || installation.status !== "ACTIVE") throw new Error("LIFECYCLE_CREDENTIAL_NOT_ACTIVE");
    throw new Error("lifecycle event idempotency conflict");
  }
  if (stored.event_sha256 !== eventSha256) throw new Error("lifecycle event idempotency conflict");
  return {
    created: Number(inserted.meta.changes) === 1,
    ingestionSequence: stored.ingestion_sequence,
    receivedAt: stored.received_at,
  };
}

export type LifecycleExportRecord = {
  schemaVersion: "agent-vigil-lifecycle-ingestion/v1";
  measurementClass: "UNVERIFIED_TELEMETRY";
  gateEligible: false;
  sybilSusceptible: true;
  ingestionSequence: number;
  receivedAt: string;
  event: SanitizedLifecycleEvent;
};

export async function exportLifecycleEvents(db: D1Database, afterSequence: number, limit: number): Promise<LifecycleExportRecord[]> {
  const result = await db.prepare(
    `SELECT ingestion_sequence, received_at, sanitized_json
       FROM lifecycle_events
      WHERE ingestion_sequence > ?
      ORDER BY ingestion_sequence ASC
      LIMIT ?`,
  ).bind(afterSequence, limit).all<{ ingestion_sequence: number; received_at: string; sanitized_json: string }>();
  return result.results.map((row) => ({
    schemaVersion: "agent-vigil-lifecycle-ingestion/v1",
    measurementClass: "UNVERIFIED_TELEMETRY",
    gateEligible: false,
    sybilSusceptible: true,
    ingestionSequence: row.ingestion_sequence,
    receivedAt: row.received_at,
    event: JSON.parse(row.sanitized_json) as SanitizedLifecycleEvent,
  }));
}

export async function getModerationState(
  db: D1Database,
  recordType: "ENTRY" | "RESOLUTION",
  recordHash: string,
): Promise<ModerationState | null> {
  return db.prepare(
    `SELECT action, reason_class, replacement_hash, event_id, updated_at
       FROM moderation_state WHERE record_type = ? AND record_hash = ?`,
  ).bind(recordType, recordHash).first<ModerationState>();
}

export async function moderateRecord(
  db: D1Database,
  input: {
    eventId: string;
    recordType: "ENTRY" | "RESOLUTION";
    recordHash: string;
    action: "CORRECT" | "TAKEDOWN" | "REVOKE" | "RESTORE";
    reasonClass: string;
    replacementHash?: string;
    occurredAt: string;
  },
): Promise<ModerationState> {
  const existing = await db.prepare(
    "SELECT action, reason_class, replacement_hash FROM moderation_events WHERE event_id = ?",
  ).bind(input.eventId).first<{ action: string; reason_class: string; replacement_hash: string | null }>();
  if (existing) {
    if (existing.action !== input.action || existing.reason_class !== input.reasonClass
      || existing.replacement_hash !== (input.replacementHash ?? null)) {
      throw new Error("moderation event ID conflicts with an existing event");
    }
  } else {
    await db.batch([
      db.prepare(
        `INSERT INTO moderation_events
          (event_id, record_type, record_hash, action, reason_class, replacement_hash, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(input.eventId, input.recordType, input.recordHash, input.action, input.reasonClass, input.replacementHash ?? null, input.occurredAt),
      db.prepare(
        `INSERT INTO moderation_state
          (record_type, record_hash, action, reason_class, replacement_hash, event_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(record_type, record_hash) DO UPDATE SET
            action = excluded.action,
            reason_class = excluded.reason_class,
            replacement_hash = excluded.replacement_hash,
            event_id = excluded.event_id,
            updated_at = excluded.updated_at`,
      ).bind(input.recordType, input.recordHash, input.action, input.reasonClass, input.replacementHash ?? null, input.eventId, input.occurredAt),
    ]);
  }
  const state = await getModerationState(db, input.recordType, input.recordHash);
  if (!state) throw new Error("moderation state did not become visible");
  return state;
}
