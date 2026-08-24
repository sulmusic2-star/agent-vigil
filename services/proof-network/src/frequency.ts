import { canonical, sha256, verifyDetachedEd25519 } from "./contracts";

export const FIRST_100_SCHEMA = "diffwitness-first-100-entry/v1" as const;
export const FIRST_100_REGISTRATION_ID = "d0a44ad6-acfc-4542-a5fa-84c68ff37067" as const;
export const FIRST_100_REGISTRATION_SHA256 = "9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da" as const;
export const FIRST_100_ACQUISITION_SCHEMA = "agent-vigil-first-100-acquisition/v1" as const;
export const FIRST_100_GLOBAL_ROW_CAP = 1_000;
export const FIRST_100_CHANNEL_ROW_CAP = 500;
export const FIRST_100_PUBLISHER_ROW_CAP = 400;
export const FIRST_100_EXPORT_CHUNK_ROWS = 100;
export const FIRST_100_EXPORT_TTL_MS = 5 * 60_000;

const CHANNELS = new Set([
  "apm",
  "skills",
  "agent-plugin",
  "mcp-registry-referral",
  "github-action",
  "github-app",
  "public-proof-referral",
]);

const REASONS = new Set([
  "ELIGIBLE",
  "BEFORE_R0",
  "INTERNAL_OR_MAINTAINER",
  "DEMO_OR_CORPUS",
  "CI_RETRY",
  "DUPLICATE_PAIR",
  "MUTABLE_IDENTITY",
  "NO_REAL_UPDATE_INTENT",
  "UNSUPPORTED_CHANNEL",
  "UNSUPPORTED_ARTIFACT",
  "COMPONENT_CAP",
  "CONSENT_WITHDRAWN_BEFORE_INSPECTION",
  "MALFORMED_PREINSPECTION_RECORD",
]);

const CONSEQUENCES = new Set([
  "REQUIRED_BEHAVIOR_UNAVAILABLE",
  "FORBIDDEN_BEHAVIOR_EXECUTES",
  "DISABLED_PERMISSION_OR_CONFIG_CHANGED",
  "PROTOCOL_OR_DETERMINISTIC_CONTRACT_INCOMPATIBLE",
  "EXACT_RESTORATION_FAILED",
  "EXPLICIT_ORGANIZATION_POLICY_BREACHED",
]);

export type First100Channel =
  | "apm"
  | "skills"
  | "agent-plugin"
  | "mcp-registry-referral"
  | "github-action"
  | "github-app"
  | "public-proof-referral";

export type First100Reason =
  | "ELIGIBLE"
  | "BEFORE_R0"
  | "INTERNAL_OR_MAINTAINER"
  | "DEMO_OR_CORPUS"
  | "CI_RETRY"
  | "DUPLICATE_PAIR"
  | "MUTABLE_IDENTITY"
  | "NO_REAL_UPDATE_INTENT"
  | "UNSUPPORTED_CHANNEL"
  | "UNSUPPORTED_ARTIFACT"
  | "COMPONENT_CAP"
  | "CONSENT_WITHDRAWN_BEFORE_INSPECTION"
  | "MALFORMED_PREINSPECTION_RECORD";

export type First100AcquisitionFacts = {
  channel: First100Channel;
  external: boolean;
  optedIn: boolean;
  runClass: "EXTERNAL_STANDARD" | "INTERNAL_OR_MAINTAINER" | "DEMO_OR_CORPUS" | "CI_RETRY";
  identityClass: "IMMUTABLE" | "MUTABLE";
  artifactClass: "SUPPORTED" | "UNSUPPORTED";
  realUpdateIntent: boolean;
  rawEventSha256: string;
  pair: {
    ecosystem: string;
    componentIdentity: string;
    currentExactIdentity: string;
    candidateExactIdentity: string;
  };
};

export type First100AdapterAttestation = {
  schemaVersion: "agent-vigil-frequency-adapter-attestation/v1";
  keyId: string;
  adapterVersion: string;
  eventId: string;
  observedAt: string;
  artifactState: "UNOPENED";
  signature: string;
};

export type First100Proposal = {
  schemaVersion: typeof FIRST_100_ACQUISITION_SCHEMA;
  kind: "acquisition";
  registrationId: typeof FIRST_100_REGISTRATION_ID;
  acquisition: First100AcquisitionFacts;
  adapterAttestation?: First100AdapterAttestation;
};

export type First100Evaluation = {
  ingestionSequence: number;
  evaluation: {
    startedAt: string;
    completedAt: string;
    verdict: "SAFE" | "CHANGED" | "HOLD";
    receiptHash: string;
    falseCompatible: boolean;
    materiality: {
      classification: "MATERIAL" | "NON_MATERIAL" | "INCONCLUSIVE";
      evidenceComplete: boolean;
      workflowConsequences: string[];
    };
  };
};

export type First100Entry = {
  schemaVersion: typeof FIRST_100_SCHEMA;
  kind: "pair";
  registrationId: typeof FIRST_100_REGISTRATION_ID;
  receivedAt: string;
  ingestionSequence: number;
  channel: First100Channel;
  external: boolean;
  optedIn: boolean;
  inspectionStarted: false;
  eligibility: { decision: "INCLUDED" | "EXCLUDED"; decidedAt: string; reason: First100Reason };
  pair: {
    ecosystem: string;
    componentIdentity: string;
    currentExactIdentity: string;
    candidateExactIdentity: string;
    realUpdateIntent: boolean;
  };
  evaluation?: First100Evaluation["evaluation"];
};

export type First100ProvenanceRecord = {
  schemaVersion: "agent-vigil-first-100-provenance/v2";
  kind: "publisher-provenance";
  registrationId: typeof FIRST_100_REGISTRATION_ID;
  ingestionSequence: number;
  publisher: {
    keyId: string;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED";
    statusUpdatedAt: string;
  };
  frozenEligibility: {
    decision: "INCLUDED" | "EXCLUDED";
    reason: First100Reason;
  };
  effectiveEligibility: {
    decision: "INCLUDED" | "EXCLUDED" | "QUARANTINED";
    reason: First100Reason | "PUBLISHER_SUSPENDED" | "PUBLISHER_REVOKED" | "ADAPTER_REVOKED";
    gateEligible: boolean;
  };
  acquisition: {
    handle: string;
    rawEventSha256: string;
    trustedAdapter: null | {
      keyId: string;
      version: string;
      eventId: string;
      observedAt: string;
      status: "ACTIVE" | "REVOKED";
    };
    registeredBeforeArtifactAccess: boolean;
    artifactAccessGrantedAt: string | null;
  };
  chronologyMutable: false;
};

export type FrequencyAdapterRow = {
  key_id: string;
  public_key_b64: string;
  version: string;
  status: "ACTIVE" | "REVOKED";
  registered_at: string;
  updated_at: string;
};

export type First100AcquisitionReceipt = {
  schemaVersion: "agent-vigil-first-100-acquisition-receipt/v1";
  acquisitionHandle: string;
  artifactAccess: "REQUIRES_TRUSTED_ADAPTER_GRANT" | "GATE_INELIGIBLE";
  entry: First100Entry;
};

export type First100AccessGrantRequest = {
  schemaVersion: "agent-vigil-frequency-artifact-access-request/v1";
  registrationId: typeof FIRST_100_REGISTRATION_ID;
  acquisitionHandle: string;
  adapterKeyId: string;
  eventId: string;
  requestedAt: string;
  signature: string;
};

type FrequencyRow = {
  ingestion_sequence: number;
  received_at: string;
  channel: First100Channel;
  external: number;
  opted_in: number;
  eligibility_decision: "INCLUDED" | "EXCLUDED";
  eligibility_decided_at: string;
  eligibility_reason: First100Reason;
  ecosystem: string;
  component_identity: string;
  current_exact_identity: string;
  candidate_exact_identity: string;
  real_update_intent: number;
  started_at: string | null;
  completed_at: string | null;
  verdict: "SAFE" | "CHANGED" | "HOLD" | null;
  receipt_hash: string | null;
  false_compatible: number | null;
  materiality_classification: "MATERIAL" | "NON_MATERIAL" | "INCONCLUSIVE" | null;
  evidence_complete: number | null;
  workflow_consequences_json: string | null;
  acquisition_handle: string;
};

type First100ProvenanceRow = {
  ingestion_sequence: number;
  received_at: string;
  publisher_key_id: string;
  publisher_status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  publisher_updated_at: string;
  eligibility_decision: "INCLUDED" | "EXCLUDED";
  eligibility_reason: First100Reason;
  acquisition_handle: string;
  raw_event_sha256: string;
  adapter_key_id: string | null;
  adapter_version: string | null;
  adapter_event_id: string | null;
  adapter_observed_at: string | null;
  adapter_status: "ACTIVE" | "REVOKED" | null;
  artifact_access_granted_at: string | null;
};

type First100BundleRow = FrequencyRow & First100ProvenanceRow;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function exactOptional(value: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function text(value: unknown, label: string, minimum: number, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")
    || (pattern !== undefined && !pattern.test(value))) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 1, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error(`${label} is invalid`);
  return result;
}

export function validateFirst100Proposal(input: unknown): First100Proposal {
  const root = object(input, "first-100 proposal");
  exactOptional(root, ["schemaVersion", "kind", "registrationId", "acquisition"], ["adapterAttestation"], "first-100 proposal");
  if (root.schemaVersion !== FIRST_100_ACQUISITION_SCHEMA || root.kind !== "acquisition" || root.registrationId !== FIRST_100_REGISTRATION_ID) {
    throw new Error("first-100 proposal does not match the frozen registration");
  }
  const acquisition = object(root.acquisition, "first-100 acquisition facts");
  exact(acquisition, [
    "channel", "external", "optedIn", "runClass", "identityClass", "artifactClass",
    "realUpdateIntent", "rawEventSha256", "pair",
  ], "first-100 acquisition facts");
  if (!CHANNELS.has(String(acquisition.channel))) throw new Error("first-100 proposal channel is unsupported");
  if (typeof acquisition.external !== "boolean" || typeof acquisition.optedIn !== "boolean"
    || typeof acquisition.realUpdateIntent !== "boolean"
    || !new Set(["EXTERNAL_STANDARD", "INTERNAL_OR_MAINTAINER", "DEMO_OR_CORPUS", "CI_RETRY"]).has(String(acquisition.runClass))
    || !new Set(["IMMUTABLE", "MUTABLE"]).has(String(acquisition.identityClass))
    || !new Set(["SUPPORTED", "UNSUPPORTED"]).has(String(acquisition.artifactClass))) {
    throw new Error("first-100 acquisition facts are invalid");
  }
  const pair = object(acquisition.pair, "first-100 proposal pair");
  exact(pair, ["ecosystem", "componentIdentity", "currentExactIdentity", "candidateExactIdentity"], "first-100 proposal pair");
  const currentExactIdentity = text(pair.currentExactIdentity, "first-100 current exact identity", 8, 256, /^[A-Za-z0-9][A-Za-z0-9@:+._-]*$/);
  const candidateExactIdentity = text(pair.candidateExactIdentity, "first-100 candidate exact identity", 8, 256, /^[A-Za-z0-9][A-Za-z0-9@:+._-]*$/);
  if (currentExactIdentity === candidateExactIdentity) throw new Error("first-100 exact identities must be distinct");
  let adapterAttestation: First100AdapterAttestation | undefined;
  if (root.adapterAttestation !== undefined) {
    const attestation = object(root.adapterAttestation, "first-100 adapter attestation");
    exact(attestation, [
      "schemaVersion", "keyId", "adapterVersion", "eventId", "observedAt", "artifactState", "signature",
    ], "first-100 adapter attestation");
    if (attestation.schemaVersion !== "agent-vigil-frequency-adapter-attestation/v1"
      || attestation.artifactState !== "UNOPENED") throw new Error("first-100 adapter attestation is invalid");
    adapterAttestation = {
      schemaVersion: "agent-vigil-frequency-adapter-attestation/v1",
      keyId: text(attestation.keyId, "first-100 adapter key ID", 71, 71, /^sha256:[0-9a-f]{64}$/),
      adapterVersion: text(attestation.adapterVersion, "first-100 adapter version", 1, 80, /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/),
      eventId: text(attestation.eventId, "first-100 adapter event ID", 36, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      observedAt: timestamp(attestation.observedAt, "first-100 adapter observedAt"),
      artifactState: "UNOPENED",
      signature: text(attestation.signature, "first-100 adapter signature", 1, 512),
    };
  }
  return {
    schemaVersion: FIRST_100_ACQUISITION_SCHEMA,
    kind: "acquisition",
    registrationId: FIRST_100_REGISTRATION_ID,
    acquisition: {
      channel: acquisition.channel as First100Channel,
      external: acquisition.external,
      optedIn: acquisition.optedIn,
      runClass: acquisition.runClass as First100AcquisitionFacts["runClass"],
      identityClass: acquisition.identityClass as First100AcquisitionFacts["identityClass"],
      artifactClass: acquisition.artifactClass as First100AcquisitionFacts["artifactClass"],
      realUpdateIntent: acquisition.realUpdateIntent,
      rawEventSha256: text(acquisition.rawEventSha256, "first-100 raw event hash", 71, 71, /^sha256:[0-9a-f]{64}$/),
      pair: {
        ecosystem: text(pair.ecosystem, "first-100 ecosystem", 1, 64, /^[a-z0-9][a-z0-9._-]*$/),
        componentIdentity: text(pair.componentIdentity, "first-100 component identity", 1, 160, /^[a-z0-9@][a-z0-9@/._-]*$/),
        currentExactIdentity,
        candidateExactIdentity,
      },
    },
    ...(adapterAttestation === undefined ? {} : { adapterAttestation }),
  };
}

export function validateFirst100Evaluation(input: unknown): First100Evaluation {
  const root = object(input, "first-100 evaluation record");
  exact(root, ["ingestionSequence", "evaluation"], "first-100 evaluation record");
  if (!Number.isInteger(root.ingestionSequence) || Number(root.ingestionSequence) < 1) throw new Error("first-100 ingestion sequence is invalid");
  const evaluation = object(root.evaluation, "first-100 evaluation");
  exact(evaluation, ["startedAt", "completedAt", "verdict", "receiptHash", "falseCompatible", "materiality"], "first-100 evaluation");
  if (!new Set(["SAFE", "CHANGED", "HOLD"]).has(String(evaluation.verdict)) || typeof evaluation.falseCompatible !== "boolean") {
    throw new Error("first-100 evaluation verdict or false-compatible state is invalid");
  }
  const startedAt = timestamp(evaluation.startedAt, "first-100 evaluation startedAt");
  const completedAt = timestamp(evaluation.completedAt, "first-100 evaluation completedAt");
  if (Date.parse(completedAt) < Date.parse(startedAt)) throw new Error("first-100 evaluation completion precedes start");
  const materiality = object(evaluation.materiality, "first-100 materiality");
  exact(materiality, ["classification", "evidenceComplete", "workflowConsequences"], "first-100 materiality");
  if (!new Set(["MATERIAL", "NON_MATERIAL", "INCONCLUSIVE"]).has(String(materiality.classification))
    || typeof materiality.evidenceComplete !== "boolean" || !Array.isArray(materiality.workflowConsequences)
    || materiality.workflowConsequences.length > 6
    || materiality.workflowConsequences.some((item) => typeof item !== "string" || !CONSEQUENCES.has(item))
    || new Set(materiality.workflowConsequences).size !== materiality.workflowConsequences.length) {
    throw new Error("first-100 materiality is invalid");
  }
  const verdict = evaluation.verdict as "SAFE" | "CHANGED" | "HOLD";
  const classification = materiality.classification as "MATERIAL" | "NON_MATERIAL" | "INCONCLUSIVE";
  const falseCompatible = evaluation.falseCompatible;
  const evidenceComplete = materiality.evidenceComplete;
  const workflowConsequences = materiality.workflowConsequences as string[];
  if (classification === "MATERIAL") {
    if (verdict === "HOLD" || !evidenceComplete || workflowConsequences.length === 0
      || falseCompatible !== (verdict === "SAFE")) {
      throw new Error("first-100 material evaluation is contradictory");
    }
  } else if (classification === "NON_MATERIAL") {
    if (verdict === "HOLD" || !evidenceComplete || workflowConsequences.length !== 0 || falseCompatible) {
      throw new Error("first-100 non-material evaluation is contradictory");
    }
  } else if (verdict !== "HOLD" || evidenceComplete || workflowConsequences.length !== 0 || falseCompatible) {
    throw new Error("first-100 inconclusive evaluation is contradictory");
  }
  return {
    ingestionSequence: Number(root.ingestionSequence),
    evaluation: {
      startedAt,
      completedAt,
      verdict,
      receiptHash: text(evaluation.receiptHash, "first-100 receipt hash", 71, 71, /^sha256:[0-9a-f]{64}$/),
      falseCompatible,
      materiality: {
        classification,
        evidenceComplete,
        workflowConsequences,
      },
    },
  };
}

export async function getFrequencyAdapter(db: D1Database, keyId: string): Promise<FrequencyAdapterRow | null> {
  return db.prepare(
    "SELECT key_id, public_key_b64, version, status, registered_at, updated_at FROM frequency_adapters WHERE key_id = ?",
  ).bind(keyId).first<FrequencyAdapterRow>();
}

export async function registerFrequencyAdapter(
  db: D1Database,
  input: { eventId: string; keyId: string; publicKey: string; version: string; occurredAt: string },
): Promise<{ created: boolean; adapter: FrequencyAdapterRow }> {
  const existing = await getFrequencyAdapter(db, input.keyId);
  if (existing) {
    if (existing.public_key_b64 !== input.publicKey || existing.version !== input.version) {
      throw new Error("frequency adapter registration conflicts with existing key material or version");
    }
    return { created: false, adapter: existing };
  }
  await db.batch([
    db.prepare(
      `INSERT INTO frequency_adapters
        (key_id, public_key_b64, version, status, registered_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(input.keyId, input.publicKey, input.version, input.occurredAt, input.occurredAt),
    db.prepare(
      `INSERT INTO frequency_adapter_status_events
        (event_id, key_id, status, reason_class, occurred_at)
       VALUES (?, ?, 'ACTIVE', 'INITIAL_REGISTRATION', ?)`,
    ).bind(input.eventId, input.keyId, input.occurredAt),
  ]);
  const adapter = await getFrequencyAdapter(db, input.keyId);
  if (!adapter) throw new Error("frequency adapter registration did not become visible");
  return { created: true, adapter };
}

export async function revokeFrequencyAdapter(
  db: D1Database,
  input: { eventId: string; keyId: string; reasonClass: string; occurredAt: string },
): Promise<FrequencyAdapterRow> {
  const existingEvent = await db.prepare(
    "SELECT key_id, status, reason_class FROM frequency_adapter_status_events WHERE event_id = ?",
  ).bind(input.eventId).first<{ key_id: string; status: string; reason_class: string }>();
  if (existingEvent) {
    if (existingEvent.key_id !== input.keyId || existingEvent.status !== "REVOKED"
      || existingEvent.reason_class !== input.reasonClass) throw new Error("frequency adapter event ID conflicts with different content");
  } else {
    const adapter = await getFrequencyAdapter(db, input.keyId);
    if (!adapter) throw new Error("frequency adapter is not registered");
    if (adapter.status === "REVOKED") throw new Error("FREQUENCY_ADAPTER_STATUS_TERMINAL");
    await db.batch([
      db.prepare(
        `INSERT INTO frequency_adapter_status_events
          (event_id, key_id, status, reason_class, occurred_at)
         VALUES (?, ?, 'REVOKED', ?, ?)`,
      ).bind(input.eventId, input.keyId, input.reasonClass, input.occurredAt),
      db.prepare("UPDATE frequency_adapters SET status = 'REVOKED', updated_at = ? WHERE key_id = ?")
        .bind(input.occurredAt, input.keyId),
    ]);
  }
  const updated = await getFrequencyAdapter(db, input.keyId);
  if (!updated) throw new Error("frequency adapter status did not become visible");
  return updated;
}

export function first100AdapterAttestationMessage(proposal: First100Proposal, publisherKeyId: string): string {
  const attestation = proposal.adapterAttestation;
  if (!attestation) throw new Error("first-100 adapter attestation is absent");
  return canonical({
    schemaVersion: "agent-vigil-frequency-adapter-attestation/v1",
    registrationId: FIRST_100_REGISTRATION_ID,
    publisherKeyId,
    adapter: {
      keyId: attestation.keyId,
      version: attestation.adapterVersion,
      eventId: attestation.eventId,
      observedAt: attestation.observedAt,
      artifactState: attestation.artifactState,
    },
    acquisition: proposal.acquisition,
  });
}

async function trustedAdapterForProposal(
  db: D1Database,
  proposal: First100Proposal,
  publisherKeyId: string,
  operatorKeyId: string,
  receivedAt: string,
): Promise<FrequencyAdapterRow | null> {
  const attestation = proposal.adapterAttestation;
  if (!attestation) return null;
  if (attestation.keyId === publisherKeyId || attestation.keyId === operatorKeyId || publisherKeyId === operatorKeyId) {
    return null;
  }
  if (Date.parse(attestation.observedAt) > Date.parse(receivedAt)
    || Date.parse(attestation.observedAt) < Date.parse(receivedAt) - 5 * 60_000) {
    return null;
  }
  const adapter = await getFrequencyAdapter(db, attestation.keyId);
  if (!adapter || adapter.status !== "ACTIVE" || adapter.version !== attestation.adapterVersion) {
    return null;
  }
  if (!(await verifyDetachedEd25519(adapter.public_key_b64, attestation.signature, first100AdapterAttestationMessage(proposal, publisherKeyId)))) {
    return null;
  }
  const replayed = await db.prepare("SELECT ingestion_sequence FROM frequency_pairs WHERE adapter_event_id = ?")
    .bind(attestation.eventId).first<{ ingestion_sequence: number }>();
  if (replayed) return null;
  return adapter;
}

function serverDecision(
  proposal: First100Proposal,
  trustedAdapter: FrequencyAdapterRow | null,
  r0ReleasedAt: string,
  releasedChannels: string,
  receivedAt: string,
): First100Reason {
  if (!trustedAdapter) return "MALFORMED_PREINSPECTION_RECORD";
  const acquisition = proposal.acquisition;
  const r0 = Date.parse(r0ReleasedAt);
  if (r0ReleasedAt === "UNSET" || !Number.isFinite(r0) || r0 > Date.parse(receivedAt)) return "BEFORE_R0";
  if (!acquisition.external || acquisition.runClass === "INTERNAL_OR_MAINTAINER") return "INTERNAL_OR_MAINTAINER";
  if (acquisition.runClass === "DEMO_OR_CORPUS") return "DEMO_OR_CORPUS";
  if (acquisition.runClass === "CI_RETRY") return "CI_RETRY";
  if (!acquisition.optedIn) return "CONSENT_WITHDRAWN_BEFORE_INSPECTION";
  if (!acquisition.realUpdateIntent) return "NO_REAL_UPDATE_INTENT";
  if (!releasedChannels.split(",").map((item) => item.trim()).includes(acquisition.channel)) return "UNSUPPORTED_CHANNEL";
  if (acquisition.identityClass !== "IMMUTABLE") return "MUTABLE_IDENTITY";
  if (acquisition.artifactClass !== "SUPPORTED") return "UNSUPPORTED_ARTIFACT";
  return "ELIGIBLE";
}

function quotaMarker(error: unknown): null | { scopeType: "GLOBAL" | "CHANNEL" | "PUBLISHER"; reason: "GLOBAL_ROW_CAP" | "CHANNEL_ROW_CAP" | "PUBLISHER_ROW_CAP" } {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("FIRST_100_GLOBAL_ROW_CAP")) return { scopeType: "GLOBAL", reason: "GLOBAL_ROW_CAP" };
  if (message.includes("FIRST_100_CHANNEL_ROW_CAP")) return { scopeType: "CHANNEL", reason: "CHANNEL_ROW_CAP" };
  if (message.includes("FIRST_100_PUBLISHER_ROW_CAP")) return { scopeType: "PUBLISHER", reason: "PUBLISHER_ROW_CAP" };
  return null;
}

async function recordFirst100Stop(
  db: D1Database,
  input: {
    scopeType: "GLOBAL" | "CHANNEL" | "PUBLISHER" | "SAMPLE";
    scopeId: string;
    reason: "GLOBAL_ROW_CAP" | "CHANNEL_ROW_CAP" | "PUBLISHER_ROW_CAP" | "INCLUDED_SAMPLE_CLOSED";
    publisherKeyId: string;
    channel: First100Channel;
    requestId: string;
    requestBodySha256: string;
    observedAt: string;
  },
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO frequency_stop_events
      (event_id, scope_type, scope_id, reason, publisher_key_id, channel,
       request_id, request_body_sha256, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.scopeType, input.scopeId, input.reason, input.publisherKeyId,
    input.channel, input.requestId, input.requestBodySha256, input.observedAt,
  ).run();
}

export async function registerFirst100Pair(
  db: D1Database,
  proposal: First100Proposal,
  config: {
    r0ReleasedAt: string;
    releasedChannels: string;
    receivedAt: string;
    publisherKeyId: string;
    requestId: string;
    operatorKeyId: string;
  },
): Promise<First100AcquisitionReceipt> {
  const bodySha256 = await sha256(canonical(proposal));
  const replay = await db.prepare(
    "SELECT ingestion_sequence, publisher_key_id, received_body_sha256 FROM frequency_pairs WHERE request_id = ?",
  ).bind(config.requestId).first<{ ingestion_sequence: number; publisher_key_id: string; received_body_sha256: string }>();
  if (replay) {
    if (replay.publisher_key_id !== config.publisherKeyId || replay.received_body_sha256 !== bodySha256) {
      throw new Error("first-100 request ID conflicts with different signed content");
    }
    const existing = await getFirst100Entry(db, replay.ingestion_sequence);
    if (!existing) throw new Error("first-100 replay record is unavailable");
    const replayHandle = await db.prepare("SELECT acquisition_handle FROM frequency_pairs WHERE ingestion_sequence = ?")
      .bind(replay.ingestion_sequence).first<{ acquisition_handle: string }>();
    if (!replayHandle?.acquisition_handle) throw new Error("first-100 replay acquisition handle is unavailable");
    return {
      schemaVersion: "agent-vigil-first-100-acquisition-receipt/v1",
      acquisitionHandle: replayHandle.acquisition_handle,
      artifactAccess: existing.eligibility.decision === "INCLUDED" ? "REQUIRES_TRUSTED_ADAPTER_GRANT" : "GATE_INELIGIBLE",
      entry: existing,
    };
  }
  const completed = await db.prepare(
    "SELECT ingestion_sequence FROM frequency_pairs WHERE eligibility_decision = 'INCLUDED' ORDER BY ingestion_sequence ASC LIMIT 1 OFFSET 99",
  ).first<{ ingestion_sequence: number }>();
  if (completed) {
    await recordFirst100Stop(db, {
      scopeType: "SAMPLE", scopeId: FIRST_100_REGISTRATION_ID, reason: "INCLUDED_SAMPLE_CLOSED",
      publisherKeyId: config.publisherKeyId, channel: proposal.acquisition.channel, requestId: config.requestId,
      requestBodySha256: bodySha256, observedAt: config.receivedAt,
    });
    throw new Error("first-100 sample is closed");
  }
  const trustedAdapter = await trustedAdapterForProposal(
    db, proposal, config.publisherKeyId, config.operatorKeyId, config.receivedAt,
  );
  const pair = {
    ...proposal.acquisition.pair,
    realUpdateIntent: proposal.acquisition.realUpdateIntent,
  };
  const dedupKey = await sha256(canonical(proposal.acquisition.pair));
  let reason = serverDecision(proposal, trustedAdapter, config.r0ReleasedAt, config.releasedChannels, config.receivedAt);
  if (reason === "ELIGIBLE") {
    const duplicate = await db.prepare("SELECT ingestion_sequence FROM frequency_pairs WHERE dedup_key = ? LIMIT 1")
      .bind(dedupKey).first<{ ingestion_sequence: number }>();
    if (duplicate) reason = "DUPLICATE_PAIR";
  }
  const acquisitionHandle = crypto.randomUUID();
  const attestationSha256 = proposal.adapterAttestation === undefined
    ? null
    : await sha256(canonical(proposal.adapterAttestation));
  const insert = async (
    decision: "INCLUDED" | "EXCLUDED",
    finalReason: First100Reason,
    includedDedupKey: string | null,
    adapter: FrequencyAdapterRow | null = trustedAdapter,
  ): Promise<number> => {
    const result = await db.prepare(
      `INSERT INTO frequency_pairs
        (schema_version, kind, registration_id, publisher_key_id, request_id, received_at, channel, external, opted_in, inspection_started,
         eligibility_decision, eligibility_decided_at, eligibility_reason, ecosystem, component_identity,
         current_exact_identity, candidate_exact_identity, real_update_intent, dedup_key, included_dedup_key, received_body_sha256,
         acquisition_handle, raw_event_sha256, adapter_key_id, adapter_version, adapter_event_id,
         adapter_observed_at, adapter_attestation_sha256)
        VALUES (?, 'pair', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      FIRST_100_SCHEMA,
      FIRST_100_REGISTRATION_ID,
      config.publisherKeyId,
      config.requestId,
      config.receivedAt,
      proposal.acquisition.channel,
      proposal.acquisition.external ? 1 : 0,
      proposal.acquisition.optedIn ? 1 : 0,
      decision,
      config.receivedAt,
      finalReason,
      pair.ecosystem,
      pair.componentIdentity,
      pair.currentExactIdentity,
      pair.candidateExactIdentity,
      pair.realUpdateIntent ? 1 : 0,
      dedupKey,
      includedDedupKey,
      bodySha256,
      acquisitionHandle,
      proposal.acquisition.rawEventSha256,
      adapter?.key_id ?? null,
      adapter?.version ?? null,
      adapter === null ? null : proposal.adapterAttestation!.eventId,
      adapter === null ? null : proposal.adapterAttestation!.observedAt,
      attestationSha256,
    ).run();
    return Number(result.meta.last_row_id);
  };
  let sequence: number;
  if (reason === "ELIGIBLE") {
    const componentCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM frequency_pairs WHERE eligibility_decision = 'INCLUDED' AND component_identity = ?",
    ).bind(pair.componentIdentity).first<{ count: number }>();
    if (Number(componentCount?.count ?? 0) >= 20) reason = "COMPONENT_CAP";
  }
  try {
    sequence = await insert(reason === "ELIGIBLE" ? "INCLUDED" : "EXCLUDED", reason, reason === "ELIGIBLE" ? dedupKey : null);
  } catch (error) {
    const requestReplay = await db.prepare(
      "SELECT ingestion_sequence, publisher_key_id, received_body_sha256 FROM frequency_pairs WHERE request_id = ?",
    ).bind(config.requestId).first<{ ingestion_sequence: number; publisher_key_id: string; received_body_sha256: string }>();
    if (requestReplay) {
      if (requestReplay.publisher_key_id !== config.publisherKeyId || requestReplay.received_body_sha256 !== bodySha256) {
        throw new Error("first-100 request ID conflicts with different signed content");
      }
      const existing = await getFirst100Entry(db, requestReplay.ingestion_sequence);
      if (existing) {
        const handle = await db.prepare("SELECT acquisition_handle FROM frequency_pairs WHERE ingestion_sequence = ?")
          .bind(requestReplay.ingestion_sequence).first<{ acquisition_handle: string }>();
        if (!handle?.acquisition_handle) throw new Error("first-100 replay acquisition handle is unavailable");
        return {
          schemaVersion: "agent-vigil-first-100-acquisition-receipt/v1",
          acquisitionHandle: handle.acquisition_handle,
          artifactAccess: existing.eligibility.decision === "INCLUDED" ? "REQUIRES_TRUSTED_ADAPTER_GRANT" : "GATE_INELIGIBLE",
          entry: existing,
        };
      }
    }
    const quota = quotaMarker(error);
    if (quota) {
      const scopeId = quota.scopeType === "GLOBAL" ? FIRST_100_REGISTRATION_ID
        : quota.scopeType === "CHANNEL" ? proposal.acquisition.channel
        : config.publisherKeyId;
      await recordFirst100Stop(db, {
        ...quota, scopeId, publisherKeyId: config.publisherKeyId, channel: proposal.acquisition.channel,
        requestId: config.requestId, requestBodySha256: bodySha256, observedAt: config.receivedAt,
      });
      throw new Error(`first-100 ${quota.reason.toLowerCase().replaceAll("_", " ")} reached`);
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("FIRST_100_SAMPLE_CLOSED")) {
      await recordFirst100Stop(db, {
        scopeType: "SAMPLE", scopeId: FIRST_100_REGISTRATION_ID, reason: "INCLUDED_SAMPLE_CLOSED",
        publisherKeyId: config.publisherKeyId, channel: proposal.acquisition.channel, requestId: config.requestId,
        requestBodySha256: bodySha256, observedAt: config.receivedAt,
      });
      throw new Error("first-100 sample is closed");
    }
    let fallbackAdapter = trustedAdapter;
    if (message.includes("frequency_pairs.adapter_event_id") && trustedAdapter !== null) {
      reason = "MALFORMED_PREINSPECTION_RECORD";
      fallbackAdapter = null;
    } else {
      if (reason !== "ELIGIBLE") throw error;
      if (message.includes("FIRST_100_COMPONENT_CAP")) reason = "COMPONENT_CAP";
      else if (message.includes("frequency_pairs.included_dedup_key")) reason = "DUPLICATE_PAIR";
      else throw error;
    }
    try {
      sequence = await insert("EXCLUDED", reason, null, fallbackAdapter);
    } catch (fallbackError) {
      const fallbackQuota = quotaMarker(fallbackError);
      if (!fallbackQuota) throw fallbackError;
      const scopeId = fallbackQuota.scopeType === "GLOBAL" ? FIRST_100_REGISTRATION_ID
        : fallbackQuota.scopeType === "CHANNEL" ? proposal.acquisition.channel
        : config.publisherKeyId;
      await recordFirst100Stop(db, {
        ...fallbackQuota, scopeId, publisherKeyId: config.publisherKeyId, channel: proposal.acquisition.channel,
        requestId: config.requestId, requestBodySha256: bodySha256, observedAt: config.receivedAt,
      });
      throw new Error(`first-100 ${fallbackQuota.reason.toLowerCase().replaceAll("_", " ")} reached`);
    }
  }
  const entry: First100Entry = {
    schemaVersion: FIRST_100_SCHEMA,
    kind: "pair",
    registrationId: FIRST_100_REGISTRATION_ID,
    receivedAt: config.receivedAt,
    ingestionSequence: sequence,
    channel: proposal.acquisition.channel,
    external: proposal.acquisition.external,
    optedIn: proposal.acquisition.optedIn,
    inspectionStarted: false,
    eligibility: {
      decision: reason === "ELIGIBLE" ? "INCLUDED" : "EXCLUDED",
      decidedAt: config.receivedAt,
      reason,
    },
    pair,
  };
  return {
    schemaVersion: "agent-vigil-first-100-acquisition-receipt/v1",
    acquisitionHandle,
    artifactAccess: entry.eligibility.decision === "INCLUDED" ? "REQUIRES_TRUSTED_ADAPTER_GRANT" : "GATE_INELIGIBLE",
    entry,
  };
}

function rowToFirst100Entry(row: FrequencyRow): First100Entry {
  return {
    schemaVersion: FIRST_100_SCHEMA,
    kind: "pair",
    registrationId: FIRST_100_REGISTRATION_ID,
    receivedAt: row.received_at,
    ingestionSequence: row.ingestion_sequence,
    channel: row.channel,
    external: row.external === 1,
    optedIn: row.opted_in === 1,
    inspectionStarted: false,
    eligibility: {
      decision: row.eligibility_decision,
      decidedAt: row.eligibility_decided_at,
      reason: row.eligibility_reason,
    },
    pair: {
      ecosystem: row.ecosystem,
      componentIdentity: row.component_identity,
      currentExactIdentity: row.current_exact_identity,
      candidateExactIdentity: row.candidate_exact_identity,
      realUpdateIntent: row.real_update_intent === 1,
    },
    ...(row.started_at === null ? {} : {
      evaluation: {
        startedAt: row.started_at,
        completedAt: row.completed_at!,
        verdict: row.verdict!,
        receiptHash: row.receipt_hash!,
        falseCompatible: row.false_compatible === 1,
        materiality: {
          classification: row.materiality_classification!,
          evidenceComplete: row.evidence_complete === 1,
          workflowConsequences: JSON.parse(row.workflow_consequences_json!) as string[],
        },
      },
    }),
  };
}

async function getFirst100Entry(db: D1Database, ingestionSequence: number): Promise<First100Entry | null> {
  const row = await db.prepare(
    `SELECT p.ingestion_sequence, p.received_at, p.channel, p.external, p.opted_in,
            p.eligibility_decision, p.eligibility_decided_at, p.eligibility_reason, p.ecosystem,
            p.component_identity, p.current_exact_identity, p.candidate_exact_identity, p.real_update_intent,
            e.started_at, e.completed_at, e.verdict, e.receipt_hash, e.false_compatible,
            e.materiality_classification, e.evidence_complete, e.workflow_consequences_json,
            p.acquisition_handle
       FROM frequency_pairs p
       LEFT JOIN frequency_evaluations e ON e.ingestion_sequence = p.ingestion_sequence
      WHERE p.ingestion_sequence = ?`,
  ).bind(ingestionSequence).first<FrequencyRow>();
  return row ? rowToFirst100Entry(row) : null;
}

export function validateFirst100AccessGrantRequest(input: unknown): First100AccessGrantRequest {
  const root = object(input, "first-100 artifact access request");
  exact(root, [
    "schemaVersion", "registrationId", "acquisitionHandle", "adapterKeyId", "eventId", "requestedAt", "signature",
  ], "first-100 artifact access request");
  if (root.schemaVersion !== "agent-vigil-frequency-artifact-access-request/v1"
    || root.registrationId !== FIRST_100_REGISTRATION_ID) throw new Error("first-100 artifact access request is invalid");
  return {
    schemaVersion: "agent-vigil-frequency-artifact-access-request/v1",
    registrationId: FIRST_100_REGISTRATION_ID,
    acquisitionHandle: text(root.acquisitionHandle, "first-100 acquisition handle", 36, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    adapterKeyId: text(root.adapterKeyId, "first-100 adapter key ID", 71, 71, /^sha256:[0-9a-f]{64}$/),
    eventId: text(root.eventId, "first-100 access event ID", 36, 36, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    requestedAt: timestamp(root.requestedAt, "first-100 access requestedAt"),
    signature: text(root.signature, "first-100 access signature", 1, 512),
  };
}

export function first100AccessGrantMessage(value: First100AccessGrantRequest, publisherKeyId: string): string {
  return [
    "agent-vigil-frequency-artifact-access-request/v1",
    publisherKeyId,
    value.registrationId,
    value.acquisitionHandle,
    value.adapterKeyId,
    value.eventId,
    value.requestedAt,
  ].join("\n");
}

export async function grantFirst100ArtifactAccess(
  db: D1Database,
  value: First100AccessGrantRequest,
  config: { publisherKeyId: string; operatorKeyId: string; grantedAt: string },
): Promise<{ created: boolean; ingestionSequence: number; grantedAt: string }> {
  if (value.adapterKeyId === config.publisherKeyId || value.adapterKeyId === config.operatorKeyId
    || config.publisherKeyId === config.operatorKeyId) throw new Error("FIRST_100_KEY_DUTY_CONFLICT");
  const requestSha256 = await sha256(canonical(value));
  const existing = await db.prepare(
    `SELECT ingestion_sequence, acquisition_handle, publisher_key_id, adapter_key_id, granted_at, request_sha256
       FROM frequency_artifact_access_grants WHERE event_id = ?`,
  ).bind(value.eventId).first<{
    ingestion_sequence: number;
    acquisition_handle: string;
    publisher_key_id: string;
    adapter_key_id: string;
    granted_at: string;
    request_sha256: string;
  }>();
  if (existing) {
    if (existing.acquisition_handle !== value.acquisitionHandle || existing.publisher_key_id !== config.publisherKeyId
      || existing.adapter_key_id !== value.adapterKeyId || existing.request_sha256 !== requestSha256) {
      throw new Error("first-100 access event ID conflicts with different content");
    }
    return { created: false, ingestionSequence: existing.ingestion_sequence, grantedAt: existing.granted_at };
  }
  const pair = await db.prepare(
    `SELECT ingestion_sequence, publisher_key_id, adapter_key_id, received_at, eligibility_decision
       FROM frequency_pairs WHERE acquisition_handle = ?`,
  ).bind(value.acquisitionHandle).first<{
    ingestion_sequence: number;
    publisher_key_id: string;
    adapter_key_id: string | null;
    received_at: string;
    eligibility_decision: string;
  }>();
  if (!pair || pair.publisher_key_id !== config.publisherKeyId || pair.adapter_key_id !== value.adapterKeyId
    || pair.eligibility_decision !== "INCLUDED") throw new Error("FIRST_100_ACCESS_GRANT_INVALID");
  if (Date.parse(value.requestedAt) < Date.parse(pair.received_at)
    || Date.parse(value.requestedAt) > Date.parse(config.grantedAt) + 5 * 60_000
    || Date.parse(value.requestedAt) < Date.parse(config.grantedAt) - 5 * 60_000) {
    throw new Error("FIRST_100_ACCESS_GRANT_TIME_INVALID");
  }
  const adapter = await getFrequencyAdapter(db, value.adapterKeyId);
  if (!adapter || adapter.status !== "ACTIVE") throw new Error("FIRST_100_ADAPTER_NOT_ACTIVE");
  if (!(await verifyDetachedEd25519(adapter.public_key_b64, value.signature, first100AccessGrantMessage(value, config.publisherKeyId)))) {
    throw new Error("FIRST_100_ACCESS_GRANT_SIGNATURE_INVALID");
  }
  await db.prepare(
    `INSERT INTO frequency_artifact_access_grants
      (event_id, acquisition_handle, ingestion_sequence, publisher_key_id, adapter_key_id,
       requested_at, granted_at, request_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    value.eventId, value.acquisitionHandle, pair.ingestion_sequence, config.publisherKeyId,
    value.adapterKeyId, value.requestedAt, config.grantedAt, requestSha256,
  ).run();
  return { created: true, ingestionSequence: pair.ingestion_sequence, grantedAt: config.grantedAt };
}

export async function storeFirst100Evaluation(
  db: D1Database,
  value: First100Evaluation,
  recordedAt: string,
): Promise<{ created: boolean }> {
  const pair = await db.prepare(
    `SELECT pair.eligibility_decision, pair.received_at, publisher.status AS publisher_status,
            access.granted_at AS artifact_access_granted_at
       FROM frequency_pairs pair
       JOIN publishers publisher ON publisher.key_id = pair.publisher_key_id
       LEFT JOIN frequency_artifact_access_grants access ON access.ingestion_sequence = pair.ingestion_sequence
      WHERE pair.ingestion_sequence = ?`,
  ).bind(value.ingestionSequence).first<{
    eligibility_decision: string;
    received_at: string;
    publisher_status: "ACTIVE" | "SUSPENDED" | "REVOKED";
    artifact_access_granted_at: string | null;
  }>();
  if (!pair || pair.eligibility_decision !== "INCLUDED") throw new Error("evaluation requires an included pre-inspection entry");
  if (pair.publisher_status !== "ACTIVE") throw new Error("FIRST_100_PUBLISHER_NOT_ACTIVE");
  if (pair.artifact_access_granted_at === null
    || Date.parse(value.evaluation.startedAt) < Date.parse(pair.artifact_access_granted_at)) {
    throw new Error("FIRST_100_ARTIFACT_ACCESS_NOT_GRANTED");
  }
  if (Date.parse(value.evaluation.startedAt) < Date.parse(pair.received_at)) throw new Error("evaluation started before server registration");
  const existing = await db.prepare("SELECT receipt_hash FROM frequency_evaluations WHERE ingestion_sequence = ?")
    .bind(value.ingestionSequence).first<{ receipt_hash: string }>();
  if (existing) {
    if (existing.receipt_hash !== value.evaluation.receiptHash) throw new Error("evaluation conflicts with append-only state");
    return { created: false };
  }
  await db.prepare(
    `INSERT INTO frequency_evaluations
      (ingestion_sequence, started_at, completed_at, verdict, receipt_hash, false_compatible,
       materiality_classification, evidence_complete, workflow_consequences_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    value.ingestionSequence,
    value.evaluation.startedAt,
    value.evaluation.completedAt,
    value.evaluation.verdict,
    value.evaluation.receiptHash,
    value.evaluation.falseCompatible ? 1 : 0,
    value.evaluation.materiality.classification,
    value.evaluation.materiality.evidenceComplete ? 1 : 0,
    canonical(value.evaluation.materiality.workflowConsequences),
    recordedAt,
  ).run();
  return { created: true };
}

async function queryFirst100Bundle(db: D1Database): Promise<First100BundleRow[]> {
  const result = await db.prepare(
    `SELECT p.ingestion_sequence, p.received_at, p.channel, p.external, p.opted_in,
            p.eligibility_decision, p.eligibility_decided_at, p.eligibility_reason, p.ecosystem,
            p.component_identity, p.current_exact_identity, p.candidate_exact_identity, p.real_update_intent,
            e.started_at, e.completed_at, e.verdict, e.receipt_hash, e.false_compatible,
            e.materiality_classification, e.evidence_complete, e.workflow_consequences_json,
            p.publisher_key_id, publisher.status AS publisher_status, publisher.updated_at AS publisher_updated_at,
            p.acquisition_handle, p.raw_event_sha256, p.adapter_key_id, p.adapter_version,
            p.adapter_event_id, p.adapter_observed_at, adapter.status AS adapter_status,
            access.granted_at AS artifact_access_granted_at
       FROM frequency_pairs p
       JOIN publishers publisher ON publisher.key_id = p.publisher_key_id
       LEFT JOIN frequency_adapters adapter ON adapter.key_id = p.adapter_key_id
       LEFT JOIN frequency_artifact_access_grants access ON access.ingestion_sequence = p.ingestion_sequence
       LEFT JOIN frequency_evaluations e ON e.ingestion_sequence = p.ingestion_sequence
      ORDER BY p.ingestion_sequence ASC
      LIMIT 1001`,
  ).all<First100BundleRow>();
  if (result.results.length > FIRST_100_GLOBAL_ROW_CAP) throw new Error("FIRST_100_EXPORT_ROW_CAP_BREACHED");
  return result.results;
}

function rowToFirst100Provenance(row: First100ProvenanceRow): First100ProvenanceRecord {
  const adapterRevoked = row.adapter_key_id !== null && row.adapter_status !== "ACTIVE";
  const activeIncluded = row.eligibility_decision === "INCLUDED" && row.publisher_status === "ACTIVE" && !adapterRevoked;
  const quarantined = row.publisher_status !== "ACTIVE" || adapterRevoked;
  return {
    schemaVersion: "agent-vigil-first-100-provenance/v2",
    kind: "publisher-provenance",
    registrationId: FIRST_100_REGISTRATION_ID,
    ingestionSequence: row.ingestion_sequence,
    publisher: {
      keyId: row.publisher_key_id,
      status: row.publisher_status,
      statusUpdatedAt: row.publisher_updated_at,
    },
    frozenEligibility: {
      decision: row.eligibility_decision,
      reason: row.eligibility_reason,
    },
    effectiveEligibility: {
      decision: quarantined ? "QUARANTINED" : row.eligibility_decision,
      reason: quarantined
        ? (row.publisher_status === "REVOKED" ? "PUBLISHER_REVOKED"
          : row.publisher_status === "SUSPENDED" ? "PUBLISHER_SUSPENDED" : "ADAPTER_REVOKED")
        : row.eligibility_reason,
      gateEligible: activeIncluded,
    },
    acquisition: {
      handle: row.acquisition_handle,
      rawEventSha256: row.raw_event_sha256,
      trustedAdapter: row.adapter_key_id === null ? null : {
        keyId: row.adapter_key_id,
        version: row.adapter_version!,
        eventId: row.adapter_event_id!,
        observedAt: row.adapter_observed_at!,
        status: row.adapter_status!,
      },
      registeredBeforeArtifactAccess: row.artifact_access_granted_at === null
        || Date.parse(row.received_at) <= Date.parse(row.artifact_access_granted_at),
      artifactAccessGrantedAt: row.artifact_access_granted_at,
    },
    chronologyMutable: false,
  };
}

export async function exportFirst100Bundle(
  db: D1Database,
): Promise<{ entries: First100Entry[]; provenance: First100ProvenanceRecord[] }> {
  const rows = await queryFirst100Bundle(db);
  return {
    entries: rows.map(rowToFirst100Entry),
    provenance: rows.map(rowToFirst100Provenance),
  };
}

export async function exportFirst100Entries(db: D1Database): Promise<First100Entry[]> {
  return (await exportFirst100Bundle(db)).entries;
}

export function first100Jsonl(entries: First100Entry[]): string {
  const anchor = {
    schemaVersion: "diffwitness-first-100-ledger/v1",
    kind: "registration-anchor",
    registrationId: FIRST_100_REGISTRATION_ID,
    registrationSha256: FIRST_100_REGISTRATION_SHA256,
    // The frozen ledger anchor is immutable. Pair entries are append-only lines
    // after it; changing this field would break the signed corpus validator.
    pairEntries: 0,
  };
  return `${[anchor, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export async function first100ProvenanceJsonl(
  records: First100ProvenanceRecord[],
  rawLedger: string,
): Promise<string> {
  const recordsBody = records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const anchor = {
    schemaVersion: "agent-vigil-first-100-provenance-ledger/v2",
    kind: "provenance-anchor",
    registrationId: FIRST_100_REGISTRATION_ID,
    registrationSha256: FIRST_100_REGISTRATION_SHA256,
    rawLedgerSha256: await sha256(rawLedger),
    rawLedgerPairEntries: Math.max(0, rawLedger.trimEnd().split("\n").length - 1),
    provenanceRecords: records.length,
    provenanceRecordsSha256: await sha256(recordsBody),
    rawLedgerGateEligibleWithoutProvenance: false,
    chronologyMutable: false,
  };
  return `${JSON.stringify(anchor)}\n${recordsBody}`;
}

type FrequencyOperatorSigning = {
  keyId: string;
  privateKeyPkcs8Base64: string;
};

type FrequencyCheckpoint = {
  sequence: number;
  eventId: string;
  eventSha256: string;
};

type FrequencySnapshotMarker = {
  pairCount: number;
  pairSequence: number;
  evaluationCount: number;
  grantSequence: number;
  publisherCheckpoint: number;
  adapterCheckpoint: number;
  stopSequence: number;
};

type FrequencyStopEvent = {
  stopSequence: number;
  eventId: string;
  scopeType: "GLOBAL" | "CHANNEL" | "PUBLISHER" | "SAMPLE";
  scopeId: string;
  reason: "GLOBAL_ROW_CAP" | "CHANNEL_ROW_CAP" | "PUBLISHER_ROW_CAP" | "INCLUDED_SAMPLE_CLOSED";
  publisherKeyId: string;
  channel: string;
  requestId: string;
  requestBodySha256: string;
  observedAt: string;
};

type First100ChunkDescriptor = {
  index: number;
  cursorAfter: number;
  firstSequence: number | null;
  lastSequence: number | null;
  rowCount: number;
  rawRecordsSha256: string;
  provenanceRecordsSha256: string;
  previousChunkSha256: string | null;
  chunkSha256: string;
};

type SignedDocument<TSchema extends string, TPayload> = {
  schemaVersion: TSchema;
  payload: TPayload;
  signature: { algorithm: "Ed25519"; keyId: string; value: string };
};

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let canonicalValue = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    canonicalValue += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  if (btoa(canonicalValue) !== value) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function signDocument<TSchema extends string, TPayload>(
  schemaVersion: TSchema,
  payload: TPayload,
  signing: FrequencyOperatorSigning,
): Promise<SignedDocument<TSchema, TPayload>> {
  if (!/^sha256:[0-9a-f]{64}$/.test(signing.keyId)) throw new Error("frequency operator key ID is invalid");
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeCanonicalBase64(signing.privateKeyPkcs8Base64, "frequency operator private key"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const message = canonical({ schemaVersion, payload });
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(message));
  return {
    schemaVersion,
    payload,
    signature: { algorithm: "Ed25519", keyId: signing.keyId, value: encodeBase64(signature) },
  };
}

async function currentFrequencyCheckpoint(db: D1Database): Promise<FrequencyCheckpoint> {
  const row = await db.prepare(
    `SELECT checkpoint_sequence, event_id, key_id, status, reason_class, occurred_at
       FROM frequency_publisher_checkpoints
      ORDER BY checkpoint_sequence DESC LIMIT 1`,
  ).first<{
    checkpoint_sequence: number;
    event_id: string;
    key_id: string;
    status: string;
    reason_class: string;
    occurred_at: string;
  }>();
  if (!row) {
    return {
      sequence: 0,
      eventId: "GENESIS",
      eventSha256: await sha256(canonical({ registrationId: FIRST_100_REGISTRATION_ID, genesis: true })),
    };
  }
  return {
    sequence: row.checkpoint_sequence,
    eventId: row.event_id,
    eventSha256: await sha256(canonical({
      sequence: row.checkpoint_sequence,
      eventId: row.event_id,
      keyId: row.key_id,
      status: row.status,
      reasonClass: row.reason_class,
      occurredAt: row.occurred_at,
    })),
  };
}

async function currentFrequencySnapshotMarker(db: D1Database): Promise<FrequencySnapshotMarker> {
  const marker = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM frequency_pairs) AS pair_count,
       COALESCE((SELECT MAX(ingestion_sequence) FROM frequency_pairs), 0) AS pair_sequence,
       (SELECT COUNT(*) FROM frequency_evaluations) AS evaluation_count,
       COALESCE((SELECT MAX(grant_sequence) FROM frequency_artifact_access_grants), 0) AS grant_sequence,
       COALESCE((SELECT MAX(checkpoint_sequence) FROM frequency_publisher_checkpoints), 0) AS publisher_checkpoint,
       COALESCE((SELECT MAX(event_sequence) FROM frequency_adapter_status_events), 0) AS adapter_checkpoint,
       COALESCE((SELECT MAX(stop_sequence) FROM frequency_stop_events), 0) AS stop_sequence`,
  ).first<{
    pair_count: number;
    pair_sequence: number;
    evaluation_count: number;
    grant_sequence: number;
    publisher_checkpoint: number;
    adapter_checkpoint: number;
    stop_sequence: number;
  }>();
  if (!marker) throw new Error("FIRST_100_EXPORT_SNAPSHOT_UNAVAILABLE");
  return {
    pairCount: Number(marker.pair_count),
    pairSequence: Number(marker.pair_sequence),
    evaluationCount: Number(marker.evaluation_count),
    grantSequence: Number(marker.grant_sequence),
    publisherCheckpoint: Number(marker.publisher_checkpoint),
    adapterCheckpoint: Number(marker.adapter_checkpoint),
    stopSequence: Number(marker.stop_sequence),
  };
}

type FrequencyPublisherState = { keyId: string; status: string; updatedAt: string };
type FrequencyAdapterState = { keyId: string; version: string; status: string; updatedAt: string };

async function frequencyAuthorityState(db: D1Database): Promise<{
  publisherStates: FrequencyPublisherState[];
  adapterStates: FrequencyAdapterState[];
  publisherStateSha256: string;
  adapterStateSha256: string;
  operatorDutySeparated: true;
}> {
  const publishers = await db.prepare(
    `SELECT DISTINCT publisher.key_id, publisher.status, publisher.updated_at
       FROM publishers publisher
       JOIN frequency_pairs pair ON pair.publisher_key_id = publisher.key_id
      ORDER BY publisher.key_id ASC LIMIT 1001`,
  ).all<{ key_id: string; status: string; updated_at: string }>();
  const adapters = await db.prepare(
    `SELECT DISTINCT adapter.key_id, adapter.version, adapter.status, adapter.updated_at
       FROM frequency_adapters adapter
       JOIN frequency_pairs pair ON pair.adapter_key_id = adapter.key_id
      ORDER BY adapter.key_id ASC LIMIT 1001`,
  ).all<{ key_id: string; version: string; status: string; updated_at: string }>();
  if (publishers.results.length > FIRST_100_GLOBAL_ROW_CAP || adapters.results.length > FIRST_100_GLOBAL_ROW_CAP) {
    throw new Error("FIRST_100_AUTHORITY_STATE_CAP_BREACHED");
  }
  const publisherStates = publishers.results.map((row) => ({
    keyId: row.key_id, status: row.status, updatedAt: row.updated_at,
  }));
  const adapterStates = adapters.results.map((row) => ({
    keyId: row.key_id, version: row.version, status: row.status, updatedAt: row.updated_at,
  }));
  return {
    publisherStates,
    adapterStates,
    publisherStateSha256: await sha256(canonical(publisherStates)),
    adapterStateSha256: await sha256(canonical(adapterStates)),
    operatorDutySeparated: true,
  };
}

async function frequencyStopEvents(db: D1Database): Promise<FrequencyStopEvent[]> {
  const result = await db.prepare(
    `SELECT stop_sequence, event_id, scope_type, scope_id, reason, publisher_key_id,
            channel, request_id, request_body_sha256, observed_at
       FROM frequency_stop_events ORDER BY stop_sequence ASC LIMIT 1025`,
  ).all<{
    stop_sequence: number;
    event_id: string;
    scope_type: FrequencyStopEvent["scopeType"];
    scope_id: string;
    reason: FrequencyStopEvent["reason"];
    publisher_key_id: string;
    channel: string;
    request_id: string;
    request_body_sha256: string;
    observed_at: string;
  }>();
  if (result.results.length > 1_024) throw new Error("FIRST_100_STOP_EVENT_CAP_BREACHED");
  return result.results.map((row) => ({
    stopSequence: row.stop_sequence,
    eventId: row.event_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    reason: row.reason,
    publisherKeyId: row.publisher_key_id,
    channel: row.channel,
    requestId: row.request_id,
    requestBodySha256: row.request_body_sha256,
    observedAt: row.observed_at,
  }));
}

async function assertOperatorDutySeparated(db: D1Database, operatorKeyId: string): Promise<void> {
  const [publisher, adapter] = await Promise.all([
    db.prepare("SELECT key_id FROM publishers WHERE key_id = ?").bind(operatorKeyId).first<{ key_id: string }>(),
    db.prepare("SELECT key_id FROM frequency_adapters WHERE key_id = ?").bind(operatorKeyId).first<{ key_id: string }>(),
  ]);
  if (publisher || adapter) throw new Error("FIRST_100_OPERATOR_KEY_DUTY_CONFLICT");
}

export async function buildFirst100SignedExport(
  db: D1Database,
  signing: FrequencyOperatorSigning,
  issuedAt: string,
): Promise<{
  rawLedger: string;
  provenance: string;
  manifest: SignedDocument<"agent-vigil-first-100-export-manifest/v1", Record<string, unknown>>;
  trustedHead: SignedDocument<"agent-vigil-first-100-trusted-head/v1", Record<string, unknown>>;
  chunks: Array<{
    descriptor: First100ChunkDescriptor;
    document: SignedDocument<"agent-vigil-first-100-export-chunk/v1", Record<string, unknown>>;
  }>;
}> {
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued) || new Date(issued).toISOString() !== issuedAt) throw new Error("frequency export issuedAt is invalid");
  await assertOperatorDutySeparated(db, signing.keyId);
  const snapshotBefore = await currentFrequencySnapshotMarker(db);
  const expiresAt = new Date(issued + FIRST_100_EXPORT_TTL_MS).toISOString();
  const bundle = await exportFirst100Bundle(db);
  const rawLedger = first100Jsonl(bundle.entries);
  const provenance = await first100ProvenanceJsonl(bundle.provenance, rawLedger);
  const [checkpoint, authority, stopEvents] = await Promise.all([
    currentFrequencyCheckpoint(db),
    frequencyAuthorityState(db),
    frequencyStopEvents(db),
  ]);
  const descriptors: First100ChunkDescriptor[] = [];
  let previousChunkSha256: string | null = null;
  for (let offset = 0; offset < bundle.entries.length; offset += FIRST_100_EXPORT_CHUNK_ROWS) {
    const entries = bundle.entries.slice(offset, offset + FIRST_100_EXPORT_CHUNK_ROWS);
    const records = bundle.provenance.slice(offset, offset + FIRST_100_EXPORT_CHUNK_ROWS);
    const rawRecords = entries.length === 0 ? "" : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const provenanceRecords = records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const unsignedDescriptor = {
      index: descriptors.length,
      cursorAfter: offset === 0 ? 0 : bundle.entries[offset - 1]!.ingestionSequence,
      firstSequence: entries[0]?.ingestionSequence ?? null,
      lastSequence: entries.at(-1)?.ingestionSequence ?? null,
      rowCount: entries.length,
      rawRecordsSha256: await sha256(rawRecords),
      provenanceRecordsSha256: await sha256(provenanceRecords),
      previousChunkSha256,
    };
    const chunkSha256 = await sha256(canonical(unsignedDescriptor));
    descriptors.push({ ...unsignedDescriptor, chunkSha256 });
    previousChunkSha256 = chunkSha256;
  }
  const stopEventsSha256 = await sha256(canonical(stopEvents));
  const manifestPayload = {
    registrationId: FIRST_100_REGISTRATION_ID,
    registrationSha256: FIRST_100_REGISTRATION_SHA256,
    issuedAt,
    expiresAt,
    moderationCheckpoint: checkpoint,
    publisherStates: authority.publisherStates,
    adapterStates: authority.adapterStates,
    publisherStateSha256: authority.publisherStateSha256,
    adapterStateSha256: authority.adapterStateSha256,
    operatorDutySeparated: authority.operatorDutySeparated,
    rawLedgerSha256: await sha256(rawLedger),
    rawLedgerPairEntries: bundle.entries.length,
    provenanceSha256: await sha256(provenance),
    provenanceRecords: bundle.provenance.length,
    chunkRowsMaximum: FIRST_100_EXPORT_CHUNK_ROWS,
    chunks: descriptors,
    chunkRootSha256: previousChunkSha256 ?? await sha256(canonical([])),
    stopEvents,
    stopEventsSha256,
    globalRowCap: FIRST_100_GLOBAL_ROW_CAP,
    channelRowCap: FIRST_100_CHANNEL_ROW_CAP,
    publisherRowCap: FIRST_100_PUBLISHER_ROW_CAP,
  };
  const manifest = await signDocument("agent-vigil-first-100-export-manifest/v1", manifestPayload, signing);
  const manifestPayloadSha256 = await sha256(canonical(manifestPayload));
  const trustedHeadPayload = {
    registrationId: FIRST_100_REGISTRATION_ID,
    registrationSha256: FIRST_100_REGISTRATION_SHA256,
    issuedAt,
    expiresAt,
    manifestPayloadSha256,
    rawLedgerSha256: manifestPayload.rawLedgerSha256,
    provenanceSha256: manifestPayload.provenanceSha256,
    chunkRootSha256: manifestPayload.chunkRootSha256,
    stopEventsSha256,
    moderationCheckpoint: checkpoint,
    publisherStateSha256: authority.publisherStateSha256,
    adapterStateSha256: authority.adapterStateSha256,
    operatorDutySeparated: true,
  };
  const trustedHead = await signDocument("agent-vigil-first-100-trusted-head/v1", trustedHeadPayload, signing);
  const chunks = await Promise.all(descriptors.map(async (descriptor) => {
    const offset = descriptor.index * FIRST_100_EXPORT_CHUNK_ROWS;
    const payload = {
      registrationId: FIRST_100_REGISTRATION_ID,
      issuedAt,
      expiresAt,
      manifestPayloadSha256,
      descriptor,
      entries: bundle.entries.slice(offset, offset + FIRST_100_EXPORT_CHUNK_ROWS),
      provenance: bundle.provenance.slice(offset, offset + FIRST_100_EXPORT_CHUNK_ROWS),
    };
    return {
      descriptor,
      document: await signDocument("agent-vigil-first-100-export-chunk/v1", payload, signing),
    };
  }));
  const snapshotAfter = await currentFrequencySnapshotMarker(db);
  if (canonical(snapshotBefore) !== canonical(snapshotAfter)) throw new Error("FIRST_100_EXPORT_SNAPSHOT_CHANGED");
  return { rawLedger, provenance, manifest, trustedHead, chunks };
}
