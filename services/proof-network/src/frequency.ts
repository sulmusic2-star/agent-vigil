import { canonical, sha256 } from "./contracts";

export const FIRST_100_SCHEMA = "diffwitness-first-100-entry/v1" as const;
export const FIRST_100_REGISTRATION_ID = "d0a44ad6-acfc-4542-a5fa-84c68ff37067" as const;
export const FIRST_100_REGISTRATION_SHA256 = "9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da" as const;

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

export type First100Proposal = {
  schemaVersion: typeof FIRST_100_SCHEMA;
  kind: "pair";
  registrationId: typeof FIRST_100_REGISTRATION_ID;
  channel: First100Channel;
  external: boolean;
  optedIn: boolean;
  inspectionStarted: false;
  eligibility: { decision: "INCLUDED" | "EXCLUDED"; reason: First100Reason };
  pair: {
    ecosystem: string;
    componentIdentity: string;
    currentExactIdentity: string;
    candidateExactIdentity: string;
    realUpdateIntent: boolean;
  };
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
  pair: First100Proposal["pair"];
  evaluation?: First100Evaluation["evaluation"];
};

export type First100ProvenanceRecord = {
  schemaVersion: "agent-vigil-first-100-provenance/v1";
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
    reason: First100Reason | "PUBLISHER_SUSPENDED" | "PUBLISHER_REVOKED";
    gateEligible: boolean;
  };
  chronologyMutable: false;
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
};

type First100ProvenanceRow = {
  ingestion_sequence: number;
  publisher_key_id: string;
  publisher_status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  publisher_updated_at: string;
  eligibility_decision: "INCLUDED" | "EXCLUDED";
  eligibility_reason: First100Reason;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
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
  exact(root, ["schemaVersion", "kind", "registrationId", "channel", "external", "optedIn", "inspectionStarted", "eligibility", "pair"], "first-100 proposal");
  if (root.schemaVersion !== FIRST_100_SCHEMA || root.kind !== "pair" || root.registrationId !== FIRST_100_REGISTRATION_ID) {
    throw new Error("first-100 proposal does not match the frozen registration");
  }
  if (!CHANNELS.has(String(root.channel))) throw new Error("first-100 proposal channel is unsupported");
  if (typeof root.external !== "boolean" || typeof root.optedIn !== "boolean" || root.inspectionStarted !== false) {
    throw new Error("first-100 proposal must be recorded before inspection with explicit external and consent state");
  }
  const eligibility = object(root.eligibility, "first-100 proposal eligibility");
  exact(eligibility, ["decision", "reason"], "first-100 proposal eligibility");
  if ((eligibility.decision !== "INCLUDED" && eligibility.decision !== "EXCLUDED") || !REASONS.has(String(eligibility.reason))) {
    throw new Error("first-100 proposal eligibility is invalid");
  }
  if ((eligibility.decision === "INCLUDED") !== (eligibility.reason === "ELIGIBLE")) {
    throw new Error("first-100 proposal eligibility decision and reason conflict");
  }
  const pair = object(root.pair, "first-100 proposal pair");
  exact(pair, ["ecosystem", "componentIdentity", "currentExactIdentity", "candidateExactIdentity", "realUpdateIntent"], "first-100 proposal pair");
  if (typeof pair.realUpdateIntent !== "boolean") throw new Error("first-100 real update intent must be boolean");
  const currentExactIdentity = text(pair.currentExactIdentity, "first-100 current exact identity", 8, 256, /^[A-Za-z0-9][A-Za-z0-9@:+._-]*$/);
  const candidateExactIdentity = text(pair.candidateExactIdentity, "first-100 candidate exact identity", 8, 256, /^[A-Za-z0-9][A-Za-z0-9@:+._-]*$/);
  if (currentExactIdentity === candidateExactIdentity) throw new Error("first-100 exact identities must be distinct");
  return {
    schemaVersion: FIRST_100_SCHEMA,
    kind: "pair",
    registrationId: FIRST_100_REGISTRATION_ID,
    channel: root.channel as First100Channel,
    external: root.external,
    optedIn: root.optedIn,
    inspectionStarted: false,
    eligibility: { decision: eligibility.decision, reason: eligibility.reason as First100Reason },
    pair: {
      ecosystem: text(pair.ecosystem, "first-100 ecosystem", 1, 64, /^[a-z0-9][a-z0-9._-]*$/),
      componentIdentity: text(pair.componentIdentity, "first-100 component identity", 1, 160, /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/),
      currentExactIdentity,
      candidateExactIdentity,
      realUpdateIntent: pair.realUpdateIntent,
    },
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
  return {
    ingestionSequence: Number(root.ingestionSequence),
    evaluation: {
      startedAt,
      completedAt,
      verdict: evaluation.verdict as "SAFE" | "CHANGED" | "HOLD",
      receiptHash: text(evaluation.receiptHash, "first-100 receipt hash", 71, 71, /^sha256:[0-9a-f]{64}$/),
      falseCompatible: evaluation.falseCompatible,
      materiality: {
        classification: materiality.classification as "MATERIAL" | "NON_MATERIAL" | "INCONCLUSIVE",
        evidenceComplete: materiality.evidenceComplete,
        workflowConsequences: materiality.workflowConsequences as string[],
      },
    },
  };
}

function serverDecision(proposal: First100Proposal, r0ReleasedAt: string, releasedChannels: string, receivedAt: string): First100Reason {
  const r0 = Date.parse(r0ReleasedAt);
  if (r0ReleasedAt === "UNSET" || !Number.isFinite(r0) || r0 > Date.parse(receivedAt)) return "BEFORE_R0";
  if (!proposal.external) return "INTERNAL_OR_MAINTAINER";
  if (!proposal.optedIn) return "CONSENT_WITHDRAWN_BEFORE_INSPECTION";
  if (!proposal.pair.realUpdateIntent) return "NO_REAL_UPDATE_INTENT";
  if (!releasedChannels.split(",").map((item) => item.trim()).includes(proposal.channel)) return "UNSUPPORTED_CHANNEL";
  if (proposal.eligibility.decision === "EXCLUDED") return proposal.eligibility.reason;
  return "ELIGIBLE";
}

export async function registerFirst100Pair(
  db: D1Database,
  proposal: First100Proposal,
  config: { r0ReleasedAt: string; releasedChannels: string; receivedAt: string; publisherKeyId: string; requestId: string },
): Promise<First100Entry> {
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
    return existing;
  }
  const completed = await db.prepare(
    "SELECT ingestion_sequence FROM frequency_pairs WHERE eligibility_decision = 'INCLUDED' ORDER BY ingestion_sequence ASC LIMIT 1 OFFSET 99",
  ).first<{ ingestion_sequence: number }>();
  if (completed) throw new Error("first-100 sample is closed");
  const dedupKey = await sha256(canonical(proposal.pair));
  let reason = serverDecision(proposal, config.r0ReleasedAt, config.releasedChannels, config.receivedAt);
  if (reason === "ELIGIBLE") {
    const duplicate = await db.prepare("SELECT ingestion_sequence FROM frequency_pairs WHERE dedup_key = ? LIMIT 1")
      .bind(dedupKey).first<{ ingestion_sequence: number }>();
    if (duplicate) reason = "DUPLICATE_PAIR";
  }
  const insert = async (decision: "INCLUDED" | "EXCLUDED", finalReason: First100Reason, includedDedupKey: string | null): Promise<number> => {
    const result = await db.prepare(
      `INSERT INTO frequency_pairs
        (schema_version, kind, registration_id, publisher_key_id, request_id, received_at, channel, external, opted_in, inspection_started,
         eligibility_decision, eligibility_decided_at, eligibility_reason, ecosystem, component_identity,
         current_exact_identity, candidate_exact_identity, real_update_intent, dedup_key, included_dedup_key, received_body_sha256)
        VALUES (?, 'pair', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      FIRST_100_SCHEMA,
      FIRST_100_REGISTRATION_ID,
      config.publisherKeyId,
      config.requestId,
      config.receivedAt,
      proposal.channel,
      proposal.external ? 1 : 0,
      proposal.optedIn ? 1 : 0,
      decision,
      config.receivedAt,
      finalReason,
      proposal.pair.ecosystem,
      proposal.pair.componentIdentity,
      proposal.pair.currentExactIdentity,
      proposal.pair.candidateExactIdentity,
      proposal.pair.realUpdateIntent ? 1 : 0,
      dedupKey,
      includedDedupKey,
      bodySha256,
    ).run();
    return Number(result.meta.last_row_id);
  };
  let sequence: number;
  if (reason === "ELIGIBLE") {
    const componentCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM frequency_pairs WHERE eligibility_decision = 'INCLUDED' AND ecosystem = ? AND component_identity = ?",
    ).bind(proposal.pair.ecosystem, proposal.pair.componentIdentity).first<{ count: number }>();
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
      if (existing) return existing;
    }
    if (reason !== "ELIGIBLE") throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("FIRST_100_SAMPLE_CLOSED")) throw new Error("first-100 sample is closed");
    reason = message.includes("FIRST_100_COMPONENT_CAP") ? "COMPONENT_CAP" : "DUPLICATE_PAIR";
    sequence = await insert("EXCLUDED", reason, null);
  }
  return {
    schemaVersion: FIRST_100_SCHEMA,
    kind: "pair",
    registrationId: FIRST_100_REGISTRATION_ID,
    receivedAt: config.receivedAt,
    ingestionSequence: sequence,
    channel: proposal.channel,
    external: proposal.external,
    optedIn: proposal.optedIn,
    inspectionStarted: false,
    eligibility: {
      decision: reason === "ELIGIBLE" ? "INCLUDED" : "EXCLUDED",
      decidedAt: config.receivedAt,
      reason,
    },
    pair: proposal.pair,
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
            e.materiality_classification, e.evidence_complete, e.workflow_consequences_json
       FROM frequency_pairs p
       LEFT JOIN frequency_evaluations e ON e.ingestion_sequence = p.ingestion_sequence
      WHERE p.ingestion_sequence = ?`,
  ).bind(ingestionSequence).first<FrequencyRow>();
  return row ? rowToFirst100Entry(row) : null;
}

export async function storeFirst100Evaluation(
  db: D1Database,
  value: First100Evaluation,
  recordedAt: string,
): Promise<{ created: boolean }> {
  const pair = await db.prepare(
    `SELECT pair.eligibility_decision, pair.received_at, publisher.status AS publisher_status
       FROM frequency_pairs pair
       JOIN publishers publisher ON publisher.key_id = pair.publisher_key_id
      WHERE pair.ingestion_sequence = ?`,
  ).bind(value.ingestionSequence).first<{
    eligibility_decision: string;
    received_at: string;
    publisher_status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  }>();
  if (!pair || pair.eligibility_decision !== "INCLUDED") throw new Error("evaluation requires an included pre-inspection entry");
  if (pair.publisher_status !== "ACTIVE") throw new Error("FIRST_100_PUBLISHER_NOT_ACTIVE");
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

export async function exportFirst100Entries(db: D1Database): Promise<First100Entry[]> {
  const cutoff = await db.prepare(
    "SELECT ingestion_sequence FROM frequency_pairs WHERE eligibility_decision = 'INCLUDED' ORDER BY ingestion_sequence ASC LIMIT 1 OFFSET 99",
  ).first<{ ingestion_sequence: number }>();
  const result = await db.prepare(
    `SELECT p.ingestion_sequence, p.received_at, p.channel, p.external, p.opted_in,
            p.eligibility_decision, p.eligibility_decided_at, p.eligibility_reason, p.ecosystem,
            p.component_identity, p.current_exact_identity, p.candidate_exact_identity, p.real_update_intent,
            e.started_at, e.completed_at, e.verdict, e.receipt_hash, e.false_compatible,
            e.materiality_classification, e.evidence_complete, e.workflow_consequences_json
       FROM frequency_pairs p
       LEFT JOIN frequency_evaluations e ON e.ingestion_sequence = p.ingestion_sequence
      WHERE ? IS NULL OR p.ingestion_sequence <= ?
      ORDER BY p.ingestion_sequence ASC`,
  ).bind(cutoff?.ingestion_sequence ?? null, cutoff?.ingestion_sequence ?? null).all<FrequencyRow>();
  return result.results.map(rowToFirst100Entry);
}

export async function exportFirst100Provenance(db: D1Database): Promise<First100ProvenanceRecord[]> {
  const cutoff = await db.prepare(
    "SELECT ingestion_sequence FROM frequency_pairs WHERE eligibility_decision = 'INCLUDED' ORDER BY ingestion_sequence ASC LIMIT 1 OFFSET 99",
  ).first<{ ingestion_sequence: number }>();
  const result = await db.prepare(
    `SELECT pair.ingestion_sequence, pair.publisher_key_id,
            publisher.status AS publisher_status, publisher.updated_at AS publisher_updated_at,
            pair.eligibility_decision, pair.eligibility_reason
       FROM frequency_pairs pair
       JOIN publishers publisher ON publisher.key_id = pair.publisher_key_id
      WHERE ? IS NULL OR pair.ingestion_sequence <= ?
      ORDER BY pair.ingestion_sequence ASC`,
  ).bind(cutoff?.ingestion_sequence ?? null, cutoff?.ingestion_sequence ?? null).all<First100ProvenanceRow>();
  return result.results.map((row) => {
    const activeIncluded = row.eligibility_decision === "INCLUDED" && row.publisher_status === "ACTIVE";
    const quarantined = row.eligibility_decision === "INCLUDED" && row.publisher_status !== "ACTIVE";
    return {
      schemaVersion: "agent-vigil-first-100-provenance/v1",
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
          ? (row.publisher_status === "REVOKED" ? "PUBLISHER_REVOKED" : "PUBLISHER_SUSPENDED")
          : row.eligibility_reason,
        gateEligible: activeIncluded,
      },
      chronologyMutable: false,
    };
  });
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

export function first100ProvenanceJsonl(records: First100ProvenanceRecord[]): string {
  const anchor = {
    schemaVersion: "agent-vigil-first-100-provenance-ledger/v1",
    kind: "provenance-anchor",
    registrationId: FIRST_100_REGISTRATION_ID,
    registrationSha256: FIRST_100_REGISTRATION_SHA256,
    rawLedgerPath: "/api/v1/frequency/first-100.jsonl",
    rawLedgerGateEligibleWithoutProvenance: false,
    chronologyMutable: false,
  };
  return `${[anchor, ...records].map((record) => JSON.stringify(record)).join("\n")}\n`;
}
