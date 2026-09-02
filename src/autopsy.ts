import { createHash } from "node:crypto";
import { canonical, recomputeReceiptHash, validateTrustReport, type ReportStatus, type TrustReport } from "./report.ts";
import type { VerificationResult } from "./signature.ts";
import { validateExactCostEvidence, type ExactCostEvidence } from "./cost-evidence.ts";
import type { LoadedTranscript, SessionUsage, TranscriptFormat } from "./transcript.ts";
import type { ChangeOutcome, MaintainerDisposition } from "./value.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export type AutopsyDecision = "EARNED" | "NOT_EARNED" | "NOT_CHECKED";
export type ReceiptAuthority = "VALID_PINNED" | "VALID_SELF_ASSERTED" | "UNSIGNED" | "INVALID" | "NOT_CHECKED";
export type EvidenceJoin = "MATCHED" | "MISMATCH" | "NOT_CHECKED";

export type RunAutopsy = {
  schemaVersion: "agent-vigil-run-autopsy/v1";
  generatedAt: string;
  autopsyHash: string;
  run: {
    runId: string;
    agent: TranscriptFormat;
    modelIds: string[];
    transcriptSha256: string;
    startedAt?: string;
    endedAt?: string;
    observations: {
      assistantMessages: number;
      toolCalls: number;
      failedToolCalls: number;
      usage: SessionUsage | { status: "NOT_CHECKED" };
    };
  };
  change: {
    verification: ReportStatus | "NOT_CHECKED";
    receiptAuthority: ReceiptAuthority;
    transcriptJoin: EvidenceJoin;
    strictPolicy: boolean | "NOT_CHECKED";
    receiptHash?: string;
    policySha256?: string;
    repositoryRefSha256?: string;
    base?: string;
    head?: string;
    tree?: string;
  };
  cost: {
    evidence: "PROVIDER_EXPORTED" | "NOT_CHECKED";
    transcriptJoin: EvidenceJoin;
    amountUsd?: number;
    evidenceHash?: string;
    budgetUsd?: number;
    budgetStatus: "WITHIN" | "EXCEEDED" | "NOT_CHECKED";
  };
  acceptance: {
    disposition: MaintainerDisposition;
    reviewEvidence: "HASHED" | "NOT_CHECKED";
    reviewEvidenceSha256?: string;
    outcome: ChangeOutcome;
    outcomeEvidence: "HASHED" | "NOT_CHECKED";
    outcomeEvidenceSha256?: string;
    outcomeAsOf?: string;
  };
  decision: AutopsyDecision;
  reason: string;
  reasonCodes: string[];
  evidenceGaps: string[];
  privacy: {
    localOnly: true;
    transcriptIncluded: false;
    promptIncluded: false;
    providerExportIncluded: false;
  };
};

export type BuildRunAutopsyInput = {
  transcript: LoadedTranscript;
  report?: TrustReport;
  receiptVerification?: VerificationResult;
  exactCost?: ExactCostEvidence;
  budgetUsd?: number;
  disposition?: MaintainerDisposition;
  reviewEvidenceSha256?: string;
  outcome?: ChangeOutcome;
  outcomeEvidenceSha256?: string;
  outcomeAsOf?: string;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_BUDGET_USD = 1_000_000;
const MAX_MODEL_IDS = 32;
const MAX_MODEL_ID_BYTES = 200;

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requireDigest(value: string | undefined, label: string): void {
  if (value !== undefined && !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
}

function canonicalTime(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an RFC3339-compatible timestamp`);
  return parsed.toISOString();
}

function uniquePush(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function receiptAuthority(report: TrustReport | undefined, verification: VerificationResult | undefined): ReceiptAuthority {
  if (!report) return "NOT_CHECKED";
  if (!verification?.hashValid) return "INVALID";
  if (!report.signature) return "UNSIGNED";
  if (verification.signatureValid !== true) return "INVALID";
  return verification.keyPinned ? "VALID_PINNED" : "VALID_SELF_ASSERTED";
}

function observedTimes(transcript: LoadedTranscript, cost: ExactCostEvidence | undefined, costJoined: boolean): string[] {
  const values = transcript.toolCalls
    .map((call) => canonicalTime(call.timestamp, "tool-call timestamp"))
    .filter((value): value is string => value !== undefined);
  if (cost && costJoined) values.push(cost.startedAt, cost.endedAt);
  return values.sort();
}

function normalizedUsage(usage: SessionUsage | undefined): SessionUsage | undefined {
  if (!usage) return undefined;
  const countFields = [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
    usage.recordsObserved,
    usage.accountedUnits,
  ];
  if (countFields.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("transcript usage counters must be non-negative safe integers");
  }
  if (usage.modelIds.length > MAX_MODEL_IDS) throw new Error(`transcript exposes more than ${MAX_MODEL_IDS} model identifiers`);
  const modelIds = [...new Set(usage.modelIds)].sort();
  if (modelIds.some((value) => !value || Buffer.byteLength(value) > MAX_MODEL_ID_BYTES || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error("transcript model identifiers must be bounded printable strings");
  }
  return { ...usage, modelIds };
}

function autopsyPayload(record: Omit<RunAutopsy, "autopsyHash">): string {
  const { generatedAt: _generatedAt, ...evidence } = record;
  return canonical(evidence);
}

export function recomputeRunAutopsyHash(record: RunAutopsy): string {
  const { autopsyHash: _autopsyHash, ...withoutHash } = record;
  return hash(autopsyPayload(withoutHash));
}

export function buildRunAutopsy(input: BuildRunAutopsyInput): RunAutopsy {
  if (!SHA256.test(input.transcript.transcriptSha256)) throw new Error("transcript digest is invalid");
  if (input.budgetUsd !== undefined
    && (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 0 || input.budgetUsd > MAX_BUDGET_USD)) {
    throw new Error(`budget USD must be between 0 and ${MAX_BUDGET_USD}`);
  }
  requireDigest(input.reviewEvidenceSha256, "review evidence digest");
  requireDigest(input.outcomeEvidenceSha256, "outcome evidence digest");
  const outcomeAsOf = canonicalTime(input.outcomeAsOf, "outcome as-of");
  if (outcomeAsOf && (!input.outcome || input.outcome === "unknown")) {
    throw new Error("outcome as-of requires a known outcome");
  }
  if (input.outcomeEvidenceSha256 && (!input.outcome || input.outcome === "unknown")) {
    throw new Error("outcome evidence requires a known outcome");
  }
  if (input.reviewEvidenceSha256 && !input.disposition) {
    throw new Error("review evidence requires an explicit disposition");
  }
  if (Boolean(input.report) !== Boolean(input.receiptVerification)) {
    throw new Error("a verification result must accompany the receipt");
  }

  const report = input.report ? validateTrustReport(input.report) : undefined;
  if (report && (!GIT_OBJECT_ID.test(report.base) || !GIT_OBJECT_ID.test(report.head)
    || !report.repository.tree || !GIT_OBJECT_ID.test(report.repository.tree)
    || !SHA256.test(report.policy.sha256))) {
    throw new Error("autopsy receipts require full base, head, tree, and policy identities");
  }
  const reportHashValid = report ? recomputeReceiptHash(report) === report.receiptHash : undefined;
  const verification = input.receiptVerification && reportHashValid === false
    ? { ...input.receiptVerification, hashValid: false }
    : input.receiptVerification;
  const authority = receiptAuthority(report, verification);
  const receiptJoined = report
    ? report.transcriptSha256 === input.transcript.transcriptSha256 ? "MATCHED" : "MISMATCH"
    : "NOT_CHECKED";

  const exactCost = input.exactCost ? validateExactCostEvidence(input.exactCost) : undefined;
  const costJoined = exactCost?.transcriptSha256 === input.transcript.transcriptSha256;
  const costJoin: EvidenceJoin = exactCost ? costJoined ? "MATCHED" : "MISMATCH" : "NOT_CHECKED";
  const amountUsd = exactCost && costJoined ? exactCost.amountUsd : undefined;
  const budgetStatus = input.budgetUsd === undefined || amountUsd === undefined
    ? "NOT_CHECKED"
    : amountUsd <= input.budgetUsd ? "WITHIN" : "EXCEEDED";

  const disposition = input.disposition ?? "unreviewed";
  const outcome = input.outcome ?? "unknown";
  const reviewEvidence = input.reviewEvidenceSha256 ? "HASHED" : "NOT_CHECKED";
  const outcomeEvidence = input.outcomeEvidenceSha256 ? "HASHED" : "NOT_CHECKED";
  const evidenceBackedAcceptance = (disposition === "accepted" && reviewEvidence === "HASHED")
    || (outcome === "merged" && outcomeEvidence === "HASHED");

  const reasonCodes: string[] = [];
  const evidenceGaps: string[] = [];
  const negativeReasons: string[] = [];
  const trustedReceipt = authority === "VALID_PINNED" && receiptJoined === "MATCHED";

  if (budgetStatus === "EXCEEDED") {
    uniquePush(reasonCodes, "cost-budget-exceeded");
    negativeReasons.push("Exact provider-exported cost exceeded the declared budget.");
  }
  if (trustedReceipt && report?.summary.status === "FAIL") {
    uniquePush(reasonCodes, "verification-failed");
    negativeReasons.push("The pinned verification receipt failed.");
  }
  if (trustedReceipt && report?.base === report?.head) {
    uniquePush(reasonCodes, "no-change-produced");
    negativeReasons.push("The verified base and head are identical.");
  }
  if ((disposition === "dismissed" || disposition === "changes-requested") && reviewEvidence === "HASHED") {
    uniquePush(reasonCodes, disposition === "dismissed" ? "maintainer-dismissed" : "changes-requested");
    negativeReasons.push(disposition === "dismissed"
      ? "Evidence records that the maintainer dismissed the change."
      : "Evidence records that the change still requires work.");
  }
  if (new Set<ChangeOutcome>(["closed", "reverted", "hotfixed", "incident-linked"]).has(outcome)
    && outcomeEvidence === "HASHED") {
    uniquePush(reasonCodes, `outcome-${outcome}`);
    negativeReasons.push(`Evidence records the downstream outcome as ${outcome}.`);
  }

  if (!report) {
    uniquePush(reasonCodes, "verification-missing");
    evidenceGaps.push("No Agent Vigil verification receipt was supplied.");
  } else {
    if (receiptJoined === "MISMATCH") {
      uniquePush(reasonCodes, "verification-transcript-mismatch");
      evidenceGaps.push("The verification receipt is bound to a different transcript.");
    }
    if (authority === "INVALID") {
      uniquePush(reasonCodes, "verification-receipt-invalid");
      evidenceGaps.push("The verification receipt hash or signature is invalid.");
    } else if (authority === "UNSIGNED") {
      uniquePush(reasonCodes, "verification-signature-missing");
      evidenceGaps.push("The verification receipt is unsigned.");
    } else if (authority === "VALID_SELF_ASSERTED") {
      uniquePush(reasonCodes, "verification-key-unpinned");
      evidenceGaps.push("The receipt signature is valid, but its signer was not pinned through a trusted key.");
    }
    if (report.summary.status === "INCONCLUSIVE") {
      uniquePush(reasonCodes, "verification-inconclusive");
      evidenceGaps.push("The verification receipt is inconclusive.");
    }
    if (!report.policy.strict) {
      uniquePush(reasonCodes, "verification-policy-not-strict");
      evidenceGaps.push("The verification receipt did not use strict evidence policy.");
    }
  }

  if (!exactCost) {
    uniquePush(reasonCodes, "cost-missing");
    evidenceGaps.push("Exact provider cost evidence was not supplied.");
  } else if (!costJoined) {
    uniquePush(reasonCodes, "cost-transcript-mismatch");
    evidenceGaps.push("The provider cost evidence is bound to a different transcript.");
  }

  if (!evidenceBackedAcceptance) {
    if (disposition === "unreviewed" && outcome === "unknown") {
      uniquePush(reasonCodes, "acceptance-missing");
      evidenceGaps.push("No evidence-backed maintainer acceptance or merged outcome was supplied.");
    } else {
      uniquePush(reasonCodes, "acceptance-evidence-missing");
      evidenceGaps.push("The stated disposition or outcome lacks a hashed evidence artifact.");
    }
  }

  let decision: AutopsyDecision;
  let reason: string;
  if (negativeReasons.length) {
    decision = "NOT_EARNED";
    reason = negativeReasons[0];
  } else if (evidenceGaps.length || !trustedReceipt || report?.summary.status !== "PASS" || !costJoined || !evidenceBackedAcceptance) {
    decision = "NOT_CHECKED";
    reason = evidenceGaps[0] ?? "Required evidence did not establish that this run earned its cost.";
  } else {
    decision = "EARNED";
    reason = "A pinned PASS receipt, exact provider cost, and evidence-backed acceptance were joined to this run.";
    uniquePush(reasonCodes, "verified-accepted-change-with-exact-cost");
  }

  const times = observedTimes(input.transcript, exactCost, costJoined);
  const usage = normalizedUsage(input.transcript.usage);
  const repositoryRefSha256 = report ? hash(report.repository.remote ?? report.repo) : undefined;
  const withoutHash: Omit<RunAutopsy, "autopsyHash"> = {
    schemaVersion: "agent-vigil-run-autopsy/v1",
    generatedAt: new Date().toISOString(),
    run: {
      runId: input.transcript.transcriptSha256,
      agent: input.transcript.format,
      modelIds: usage?.modelIds ?? [],
      transcriptSha256: input.transcript.transcriptSha256,
      ...(times.length ? { startedAt: times[0], endedAt: times.at(-1)! } : {}),
      observations: {
        assistantMessages: input.transcript.assistantMessages.length,
        toolCalls: input.transcript.toolCalls.length,
        failedToolCalls: input.transcript.toolCalls.filter((call) => call.isError).length,
        usage: usage ?? { status: "NOT_CHECKED" },
      },
    },
    change: {
      verification: report?.summary.status ?? "NOT_CHECKED",
      receiptAuthority: authority,
      transcriptJoin: receiptJoined,
      strictPolicy: report?.policy.strict ?? "NOT_CHECKED",
      ...(report ? {
        receiptHash: report.receiptHash,
        policySha256: report.policy.sha256,
        repositoryRefSha256,
        base: report.base,
        head: report.head,
        ...(report.repository.tree ? { tree: report.repository.tree } : {}),
      } : {}),
    },
    cost: {
      evidence: exactCost && costJoined ? "PROVIDER_EXPORTED" : "NOT_CHECKED",
      transcriptJoin: costJoin,
      ...(amountUsd !== undefined ? { amountUsd } : {}),
      ...(exactCost && costJoined ? { evidenceHash: exactCost.evidenceHash } : {}),
      ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
      budgetStatus,
    },
    acceptance: {
      disposition,
      reviewEvidence,
      ...(input.reviewEvidenceSha256 ? { reviewEvidenceSha256: input.reviewEvidenceSha256 } : {}),
      outcome,
      outcomeEvidence,
      ...(input.outcomeEvidenceSha256 ? { outcomeEvidenceSha256: input.outcomeEvidenceSha256 } : {}),
      ...(outcomeAsOf ? { outcomeAsOf } : {}),
    },
    decision,
    reason,
    reasonCodes,
    evidenceGaps,
    privacy: {
      localOnly: true,
      transcriptIncluded: false,
      promptIncluded: false,
      providerExportIncluded: false,
    },
  };
  return { ...withoutHash, autopsyHash: hash(autopsyPayload(withoutHash)) };
}

function money(value: number | undefined): string {
  return value === undefined ? "not checked" : `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

export function renderRunAutopsy(record: RunAutopsy): string {
  const models = record.run.modelIds.length ? record.run.modelIds.map(terminalSafe).join(", ") : "not checked";
  const change = record.change.base && record.change.head
    ? `${terminalSafe(record.change.base)}..${terminalSafe(record.change.head)}`
    : "not checked";
  const lines = [
    `Agent Vigil Run Autopsy: ${record.decision}`,
    `  agent:        ${terminalSafe(record.run.agent)} | ${models}`,
    `  change:       ${change}`,
    `  verification: ${record.change.verification} | ${record.change.receiptAuthority}`,
    `  cost:         ${money(record.cost.amountUsd)} | ${record.cost.evidence}`,
    `  budget:       ${money(record.cost.budgetUsd)} | ${record.cost.budgetStatus}`,
    `  acceptance:   ${record.acceptance.disposition} | ${record.acceptance.outcome}`,
    `  decision:     ${record.decision}`,
    `  reason:       ${terminalSafe(record.reason)}`,
    `  record:       ${record.autopsyHash}`,
  ];
  if (record.evidenceGaps.length) {
    lines.push("  evidence gaps:");
    for (const gap of record.evidenceGaps) lines.push(`    - ${terminalSafe(gap)}`);
  }
  lines.push("  privacy:      local only; transcript, prompts, and provider export are not included");
  return `${lines.join("\n")}\n`;
}
