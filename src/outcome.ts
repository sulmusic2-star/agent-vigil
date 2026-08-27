import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical, recomputeReceiptHash, type ReportStatus, type TrustReport } from "./report.ts";
import { publicKeyDer, signingKeyId, verifyReport } from "./signature.ts";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const ADAPTERS = new Set(["generic", "a2a", "ap2", "x402", "erc-8004", "vcap"]);

export type OutcomeVerdict = ReportStatus;
export type SettlementAction = "RELEASE" | "REFUND" | "ESCALATE";
export type OutcomeAdapter = "generic" | "a2a" | "ap2" | "x402" | "erc-8004" | "vcap";

export type OutcomeMandatePayload = {
  schemaVersion: "0.1";
  type: "agent-vigil/outcome-mandate";
  createdAt: string;
  expiresAt: string;
  requester: { id: string };
  provider?: { id: string };
  task: {
    id: string;
    class: string;
    description: string;
    base: string;
    head: string;
  };
  acceptance: {
    requiredReportStatus: "PASS";
    minMeaningfulVerified: number;
    requireNoContradictions: true;
    requiredRuleIds: string[];
    requireSignedEvidence: boolean;
    trustedEvidenceSignerKeyIds: string[];
    missingEvidenceVerdict: "INCONCLUSIVE";
  };
  limits: {
    maxAttempts: number;
    maxBudgetUsd?: number;
  };
  verifier: {
    trustedKeyIds: string[];
  };
  settlement: {
    mode: "signal-only";
    adapter: OutcomeAdapter;
    reference?: string;
    networkAction: "NONE";
  };
};

export type OutcomeMandate = OutcomeMandatePayload & {
  mandateId: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
    value: string;
  };
};

export type OutcomeCheck = {
  id: string;
  verdict: OutcomeVerdict;
  evidence: string;
};

export type OutcomeReceiptPayload = {
  schemaVersion: "0.1";
  type: "agent-vigil/outcome-receipt";
  mandateId: string;
  issuedAt: string;
  verifierKeyId: string;
  verdict: OutcomeVerdict;
  reasonCodes: string[];
  checks: OutcomeCheck[];
  sourceEvidence: {
    type: "agent-vigil/trust-report";
    reportHash: string;
    base: string;
    head: string;
    status: OutcomeVerdict;
    signerKeyId?: string;
  };
  settlementSignal: {
    mode: "signal-only";
    adapter: OutcomeAdapter;
    action: SettlementAction;
    reference?: string;
    dryRun: true;
    networkAction: "NONE";
  };
};

export type OutcomeReceipt = OutcomeReceiptPayload & {
  outcomeHash: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    publicKey: string;
    value: string;
  };
};

export type OutcomeMandateInput = {
  createdAt?: string;
  expiresAt: string;
  requesterId: string;
  providerId?: string;
  taskId: string;
  taskClass: string;
  description: string;
  base: string;
  head: string;
  minMeaningfulVerified?: number;
  requiredRuleIds?: string[];
  requireSignedEvidence?: boolean;
  trustedEvidenceSignerKeyIds?: string[];
  maxAttempts?: number;
  maxBudgetUsd?: number;
  verifierKeyIds: string[];
  adapter?: OutcomeAdapter;
  settlementReference?: string;
};

export type VerificationResult = {
  valid: boolean;
  hashValid: boolean;
  signatureValid: boolean;
  keyPinned: boolean;
  expired: boolean;
  keyId?: string;
  errors: string[];
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function requireObjectKeys(value: unknown, label: string, allowed: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unexpected = Object.keys(value as Record<string, unknown>).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported field(s): ${unexpected.sort().join(", ")}`);
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an RFC3339-compatible timestamp`);
  return parsed;
}

function requireId(value: string, label: string): string {
  if (!ID.test(value)) throw new Error(`${label} must be 1-200 characters using letters, numbers, dot, colon, slash, at, underscore, or hyphen`);
  return value;
}

function requireSha(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be a SHA-256 key ID`);
  return value;
}

function requireGitOid(value: string, label: string): string {
  if (!GIT_OID.test(value)) throw new Error(`${label} must be an exact 40-64 character lowercase Git object ID`);
  return value;
}

function uniqueStrings(values: string[], label: string, maximum = 64): string[] {
  if (!Array.isArray(values) || values.length > maximum) throw new Error(`${label} must contain no more than ${maximum} values`);
  if (values.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`${label} must contain non-empty strings`);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
  return [...values].sort();
}

function outcomeAction(verdict: OutcomeVerdict): SettlementAction {
  if (verdict === "PASS") return "RELEASE";
  if (verdict === "FAIL") return "REFUND";
  return "ESCALATE";
}

function payloadOfMandate(mandate: OutcomeMandate): OutcomeMandatePayload {
  const { mandateId: _id, signature: _signature, ...payload } = mandate;
  return payload;
}

function payloadOfReceipt(receipt: OutcomeReceipt): OutcomeReceiptPayload {
  const { outcomeHash: _hash, signature: _signature, ...payload } = receipt;
  return payload;
}

function validateMandateShape(input: unknown): OutcomeMandate {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("outcome mandate must be an object");
  const mandate = input as OutcomeMandate;
  requireObjectKeys(mandate, "outcome mandate", ["schemaVersion", "type", "createdAt", "expiresAt", "requester", "provider", "task", "acceptance", "limits", "verifier", "settlement", "mandateId", "signature"]);
  if (mandate.schemaVersion !== "0.1" || mandate.type !== "agent-vigil/outcome-mandate") throw new Error("unsupported outcome mandate schema or type");
  requireSha(mandate.mandateId, "mandateId");
  parseTime(mandate.createdAt, "createdAt");
  parseTime(mandate.expiresAt, "expiresAt");
  if (Date.parse(mandate.expiresAt) <= Date.parse(mandate.createdAt)) throw new Error("expiresAt must be later than createdAt");
  if (Date.parse(mandate.expiresAt) - Date.parse(mandate.createdAt) > 366 * 24 * 60 * 60 * 1000) throw new Error("outcome mandates may not be valid for more than 366 days");
  requireObjectKeys(mandate.requester, "requester", ["id"]);
  requireId(mandate.requester?.id, "requester.id");
  if (mandate.provider) { requireObjectKeys(mandate.provider, "provider", ["id"]); requireId(mandate.provider.id, "provider.id"); }
  requireObjectKeys(mandate.task, "task", ["id", "class", "description", "base", "head"]);
  requireId(mandate.task?.id, "task.id");
  requireId(mandate.task?.class, "task.class");
  if (typeof mandate.task?.description !== "string" || mandate.task.description.trim().length < 3 || mandate.task.description.length > 2000) throw new Error("task.description must contain 3-2000 characters");
  requireGitOid(mandate.task.base, "task.base");
  requireGitOid(mandate.task.head, "task.head");
  if (mandate.task.base === mandate.task.head) throw new Error("task.base and task.head must differ");
  requireObjectKeys(mandate.acceptance, "acceptance", ["requiredReportStatus", "minMeaningfulVerified", "requireNoContradictions", "requiredRuleIds", "requireSignedEvidence", "trustedEvidenceSignerKeyIds", "missingEvidenceVerdict"]);
  if (mandate.acceptance?.requiredReportStatus !== "PASS") throw new Error("acceptance.requiredReportStatus must be PASS");
  if (!Number.isInteger(mandate.acceptance?.minMeaningfulVerified) || mandate.acceptance.minMeaningfulVerified < 1 || mandate.acceptance.minMeaningfulVerified > 10000) throw new Error("acceptance.minMeaningfulVerified must be an integer between 1 and 10000");
  if (mandate.acceptance?.requireNoContradictions !== true) throw new Error("acceptance.requireNoContradictions must be true");
  uniqueStrings(mandate.acceptance?.requiredRuleIds, "acceptance.requiredRuleIds").forEach((value) => requireId(value, "acceptance.requiredRuleIds entry"));
  if (typeof mandate.acceptance?.requireSignedEvidence !== "boolean") throw new Error("acceptance.requireSignedEvidence must be boolean");
  uniqueStrings(mandate.acceptance?.trustedEvidenceSignerKeyIds, "acceptance.trustedEvidenceSignerKeyIds").forEach((value) => requireSha(value, "trusted evidence signer key ID"));
  if (mandate.acceptance.requireSignedEvidence && mandate.acceptance.trustedEvidenceSignerKeyIds.length < 1) throw new Error("signed evidence requires at least one trusted evidence signer key ID");
  if (mandate.acceptance.missingEvidenceVerdict !== "INCONCLUSIVE") throw new Error("missing evidence must resolve to INCONCLUSIVE");
  requireObjectKeys(mandate.limits, "limits", ["maxAttempts", "maxBudgetUsd"]);
  if (!Number.isInteger(mandate.limits?.maxAttempts) || mandate.limits.maxAttempts < 1 || mandate.limits.maxAttempts > 100) throw new Error("limits.maxAttempts must be an integer between 1 and 100");
  if (mandate.limits.maxBudgetUsd !== undefined && (!Number.isFinite(mandate.limits.maxBudgetUsd) || mandate.limits.maxBudgetUsd <= 0 || mandate.limits.maxBudgetUsd > 100000000)) throw new Error("limits.maxBudgetUsd must be greater than zero and no more than 100000000");
  requireObjectKeys(mandate.verifier, "verifier", ["trustedKeyIds"]);
  const verifierKeys = uniqueStrings(mandate.verifier?.trustedKeyIds, "verifier.trustedKeyIds");
  if (verifierKeys.length < 1) throw new Error("verifier.trustedKeyIds must contain at least one key ID");
  verifierKeys.forEach((value) => requireSha(value, "verifier trusted key ID"));
  requireObjectKeys(mandate.settlement, "settlement", ["mode", "adapter", "reference", "networkAction"]);
  if (mandate.settlement?.mode !== "signal-only" || mandate.settlement.networkAction !== "NONE") throw new Error("settlement must be signal-only with networkAction NONE");
  if (!ADAPTERS.has(mandate.settlement.adapter)) throw new Error("settlement.adapter is unsupported");
  if (mandate.settlement.reference !== undefined && (typeof mandate.settlement.reference !== "string" || !mandate.settlement.reference.trim() || mandate.settlement.reference.length > 500)) throw new Error("settlement.reference must be a non-empty string of at most 500 characters");
  requireObjectKeys(mandate.signature, "mandate signature", ["algorithm", "keyId", "publicKey", "value"]);
  if (mandate.signature?.algorithm !== "Ed25519") throw new Error("mandate signature algorithm must be Ed25519");
  requireSha(mandate.signature?.keyId, "mandate signature keyId");
  if (typeof mandate.signature?.publicKey !== "string" || typeof mandate.signature?.value !== "string") throw new Error("mandate signature fields are required");
  return mandate;
}

export function createOutcomeMandate(input: OutcomeMandateInput, requesterPrivateKeyPath: string): OutcomeMandate {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const created = parseTime(createdAt, "createdAt");
  const expires = parseTime(input.expiresAt, "expiresAt");
  if (expires <= created) throw new Error("expiresAt must be later than createdAt");
  if (expires - created > 366 * 24 * 60 * 60 * 1000) throw new Error("outcome mandates may not be valid for more than 366 days");
  const privateKey = createPrivateKey(readFileSync(requesterPrivateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("requester signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  const verifierKeyIds = uniqueStrings(input.verifierKeyIds, "verifierKeyIds").map((value) => requireSha(value, "verifier key ID"));
  if (verifierKeyIds.length < 1) throw new Error("at least one verifier key ID is required");
  const evidenceKeys = uniqueStrings(input.trustedEvidenceSignerKeyIds ?? [], "trustedEvidenceSignerKeyIds").map((value) => requireSha(value, "trusted evidence key ID"));
  const requireSignedEvidence = input.requireSignedEvidence ?? false;
  if (requireSignedEvidence && evidenceKeys.length < 1) throw new Error("--require-signed-evidence requires at least one trusted evidence signer key ID");
  const adapter = input.adapter ?? "generic";
  if (!ADAPTERS.has(adapter)) throw new Error("unsupported settlement adapter");
  if (input.settlementReference !== undefined && (!input.settlementReference.trim() || input.settlementReference.length > 500)) throw new Error("settlementReference must contain 1-500 characters");
  const payload: OutcomeMandatePayload = {
    schemaVersion: "0.1",
    type: "agent-vigil/outcome-mandate",
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    requester: { id: requireId(input.requesterId, "requesterId") },
    ...(input.providerId ? { provider: { id: requireId(input.providerId, "providerId") } } : {}),
    task: {
      id: requireId(input.taskId, "taskId"),
      class: requireId(input.taskClass, "taskClass"),
      description: input.description.trim(),
      base: requireGitOid(input.base, "base"),
      head: requireGitOid(input.head, "head"),
    },
    acceptance: {
      requiredReportStatus: "PASS",
      minMeaningfulVerified: input.minMeaningfulVerified ?? 1,
      requireNoContradictions: true,
      requiredRuleIds: uniqueStrings(input.requiredRuleIds ?? [], "requiredRuleIds").map((value) => requireId(value, "required rule ID")),
      requireSignedEvidence,
      trustedEvidenceSignerKeyIds: evidenceKeys,
      missingEvidenceVerdict: "INCONCLUSIVE",
    },
    limits: {
      maxAttempts: input.maxAttempts ?? 3,
      ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    },
    verifier: { trustedKeyIds: verifierKeyIds },
    settlement: {
      mode: "signal-only",
      adapter,
      ...(input.settlementReference ? { reference: input.settlementReference } : {}),
      networkAction: "NONE",
    },
  };
  if (payload.task.description.length < 3 || payload.task.description.length > 2000) throw new Error("description must contain 3-2000 characters");
  if (!Number.isInteger(payload.acceptance.minMeaningfulVerified) || payload.acceptance.minMeaningfulVerified < 1 || payload.acceptance.minMeaningfulVerified > 10000) throw new Error("minMeaningfulVerified must be an integer between 1 and 10000");
  if (!Number.isInteger(payload.limits.maxAttempts) || payload.limits.maxAttempts < 1 || payload.limits.maxAttempts > 100) throw new Error("maxAttempts must be an integer between 1 and 100");
  if (payload.limits.maxBudgetUsd !== undefined && (!Number.isFinite(payload.limits.maxBudgetUsd) || payload.limits.maxBudgetUsd <= 0 || payload.limits.maxBudgetUsd > 100000000)) throw new Error("maxBudgetUsd must be greater than zero and no more than 100000000");
  const mandateId = digest(payload);
  return {
    ...payload,
    mandateId,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(mandateId), privateKey).toString("base64"),
    },
  };
}

export function verifyOutcomeMandate(input: unknown, requesterPublicKeyPath?: string, asOf = new Date()): VerificationResult {
  const errors: string[] = [];
  if (!Number.isFinite(asOf.getTime())) return { valid: false, hashValid: false, signatureValid: false, keyPinned: Boolean(requesterPublicKeyPath), expired: false, errors: ["verification time is invalid"] };
  let mandate: OutcomeMandate;
  try { mandate = validateMandateShape(input); }
  catch (error) { return { valid: false, hashValid: false, signatureValid: false, keyPinned: Boolean(requesterPublicKeyPath), expired: false, errors: [(error as Error).message] }; }
  const hashValid = digest(payloadOfMandate(mandate)) === mandate.mandateId;
  if (!hashValid) errors.push("mandate content hash is invalid");
  const expired = asOf.getTime() > Date.parse(mandate.expiresAt);
  if (expired) errors.push("mandate is expired");
  let signatureValid = false;
  let keyId: string | undefined;
  try {
    const embedded = createPublicKey({ key: Buffer.from(mandate.signature.publicKey, "base64"), type: "spki", format: "der" });
    if (embedded.asymmetricKeyType !== "ed25519") throw new Error("embedded requester key must be Ed25519");
    const selected = requesterPublicKeyPath ? createPublicKey(readFileSync(requesterPublicKeyPath)) : embedded;
    if (selected.asymmetricKeyType !== "ed25519") throw new Error("requester public key must be Ed25519");
    keyId = signingKeyId(publicKeyDer(selected));
    signatureValid = keyId === mandate.signature.keyId
      && verify(null, Buffer.from(mandate.mandateId), selected, Buffer.from(mandate.signature.value, "base64"));
    if (!signatureValid) errors.push("mandate signature is invalid or does not match the pinned requester key");
  } catch (error) { errors.push(`mandate signature could not be read: ${(error as Error).message}`); }
  return { valid: errors.length === 0, hashValid, signatureValid, keyPinned: Boolean(requesterPublicKeyPath), expired, ...(keyId ? { keyId } : {}), errors };
}

function check(id: string, verdict: OutcomeVerdict, evidence: string): OutcomeCheck {
  return { id, verdict, evidence };
}

function reasonCodes(checks: OutcomeCheck[]): string[] {
  return checks.filter((item) => item.verdict !== "PASS").map((item) => item.id).sort();
}

function overallVerdict(checks: OutcomeCheck[]): OutcomeVerdict {
  if (checks.some((item) => item.verdict === "FAIL")) return "FAIL";
  if (checks.some((item) => item.verdict === "INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASS";
}

function reportSummaryConsistency(report: TrustReport): { valid: boolean; evidence: string } {
  if (!report || typeof report !== "object" || report.schemaVersion !== "2" || !Array.isArray(report.results) || !report.summary || !report.policy) {
    return { valid: false, evidence: "trust report is missing required schema 2 result, summary, or policy fields" };
  }
  const verdicts = report.results.map((item) => item?.verdict);
  if (verdicts.some((value) => !new Set(["verified", "contradicted", "unverifiable"]).has(value))) {
    return { valid: false, evidence: "trust report contains an unsupported result verdict" };
  }
  const verified = verdicts.filter((value) => value === "verified").length;
  const contradicted = verdicts.filter((value) => value === "contradicted").length;
  const unverifiable = verdicts.filter((value) => value === "unverifiable").length;
  const meaningfulVerified = report.results.filter((item) => item.verdict === "verified" && item.contributesToPass !== false).length;
  if (!Number.isInteger(report.policy.minVerified) || report.policy.minVerified < 1 || typeof report.policy.strict !== "boolean") {
    return { valid: false, evidence: "trust report policy has an invalid evidence minimum or strict-mode value" };
  }
  let status: OutcomeVerdict;
  if (contradicted > 0) status = "FAIL";
  else if (meaningfulVerified < report.policy.minVerified
    || report.results.some((item) => item.verdict === "unverifiable" && item.blocksPass)
    || (report.policy.strict && unverifiable > 0)) status = "INCONCLUSIVE";
  else status = "PASS";
  const expected = { verified, contradicted, unverifiable, meaningfulVerified, status, pass: status === "PASS" };
  return canonical(report.summary) === canonical(expected)
    ? { valid: true, evidence: `summary is consistent with ${report.results.length} result(s)` }
    : { valid: false, evidence: "trust report summary disagrees with its result records and policy" };
}

export function assessOutcome(
  mandateInput: unknown,
  report: TrustReport,
  verifierPrivateKeyPath: string,
  options: { requesterPublicKeyPath: string; issuedAt?: string },
): OutcomeReceipt {
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const issuedDate = new Date(parseTime(issuedAt, "issuedAt"));
  const mandate = validateMandateShape(mandateInput);
  const privateKey = createPrivateKey(readFileSync(verifierPrivateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("verifier signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  const verifierKeyId = signingKeyId(der);
  if (!mandate.verifier.trustedKeyIds.includes(verifierKeyId)) throw new Error("verifier signing key is not trusted by the mandate");

  const checks: OutcomeCheck[] = [];
  const mandateVerification = verifyOutcomeMandate(mandate, options.requesterPublicKeyPath, issuedDate);
  checks.push(check("mandate-integrity", mandateVerification.hashValid && mandateVerification.signatureValid ? "PASS" : "FAIL", mandateVerification.errors.join("; ") || "mandate hash and requester signature are valid"));
  checks.push(check("mandate-expiry", mandateVerification.expired ? "FAIL" : "PASS", mandateVerification.expired ? `mandate expired at ${mandate.expiresAt}` : `mandate is current until ${mandate.expiresAt}`));

  const reportHashValid = recomputeReceiptHash(report) === report.receiptHash;
  checks.push(check("evidence-integrity", reportHashValid ? "PASS" : "FAIL", reportHashValid ? `trust report hash ${report.receiptHash} is valid` : "trust report content does not match its receipt hash"));
  const reportConsistency = reportSummaryConsistency(report);
  checks.push(check("evidence-summary", reportConsistency.valid ? "PASS" : "FAIL", reportConsistency.evidence));
  checks.push(check("exact-base", report.base === mandate.task.base ? "PASS" : "FAIL", `mandate ${mandate.task.base}; observed ${report.base}`));
  checks.push(check("exact-head", report.head === mandate.task.head ? "PASS" : "FAIL", `mandate ${mandate.task.head}; observed ${report.head}`));

  if (mandate.acceptance.requireSignedEvidence) {
    if (!report.signature) checks.push(check("evidence-signature", "INCONCLUSIVE", "the mandate requires signed evidence but the trust report has no signature"));
    else {
      const verification = verifyReport(report);
      const trusted = Boolean(verification.keyId) && mandate.acceptance.trustedEvidenceSignerKeyIds.includes(verification.keyId!);
      checks.push(check("evidence-signature", verification.signatureValid && trusted ? "PASS" : "FAIL", verification.signatureValid && trusted ? `evidence signer ${verification.keyId} is trusted` : "evidence signature is invalid or its signer is not trusted by the mandate"));
    }
  } else checks.push(check("evidence-signature", "PASS", "the mandate permits unsigned trust-report evidence"));

  const statusVerdict: OutcomeVerdict = report.summary.status === "PASS" ? "PASS" : report.summary.status === "FAIL" ? "FAIL" : "INCONCLUSIVE";
  checks.push(check("required-report-status", statusVerdict, `required PASS; observed ${report.summary.status}`));
  checks.push(check("no-contradictions", report.summary.contradicted === 0 ? "PASS" : "FAIL", `observed ${report.summary.contradicted} contradicted claim(s)`));
  checks.push(check("minimum-meaningful-verification", report.summary.meaningfulVerified >= mandate.acceptance.minMeaningfulVerified ? "PASS" : "INCONCLUSIVE", `required ${mandate.acceptance.minMeaningfulVerified}; observed ${report.summary.meaningfulVerified}`));

  for (const ruleId of mandate.acceptance.requiredRuleIds) {
    const matches = report.results.filter((item) => item.ruleId === ruleId);
    if (!matches.length) checks.push(check(`required-rule:${ruleId}`, "INCONCLUSIVE", "required rule was not present in the trust report"));
    else if (matches.some((item) => item.verdict === "contradicted")) checks.push(check(`required-rule:${ruleId}`, "FAIL", "required rule was contradicted"));
    else if (matches.some((item) => item.verdict === "verified")) checks.push(check(`required-rule:${ruleId}`, "PASS", "required rule was independently verified"));
    else checks.push(check(`required-rule:${ruleId}`, "INCONCLUSIVE", "required rule was present but unverifiable"));
  }

  const verdict = overallVerdict(checks);
  const payload: OutcomeReceiptPayload = {
    schemaVersion: "0.1",
    type: "agent-vigil/outcome-receipt",
    mandateId: mandate.mandateId,
    issuedAt: issuedDate.toISOString(),
    verifierKeyId,
    verdict,
    reasonCodes: reasonCodes(checks),
    checks,
    sourceEvidence: {
      type: "agent-vigil/trust-report",
      reportHash: report.receiptHash,
      base: report.base,
      head: report.head,
      status: report.summary.status,
      ...(report.signature?.keyId ? { signerKeyId: report.signature.keyId } : {}),
    },
    settlementSignal: {
      mode: "signal-only",
      adapter: mandate.settlement.adapter,
      action: outcomeAction(verdict),
      ...(mandate.settlement.reference ? { reference: mandate.settlement.reference } : {}),
      dryRun: true,
      networkAction: "NONE",
    },
  };
  const outcomeHash = digest(payload);
  return {
    ...payload,
    outcomeHash,
    signature: {
      algorithm: "Ed25519",
      keyId: verifierKeyId,
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(outcomeHash), privateKey).toString("base64"),
    },
  };
}

function validateReceiptShape(input: unknown): OutcomeReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("outcome receipt must be an object");
  const receipt = input as OutcomeReceipt;
  requireObjectKeys(receipt, "outcome receipt", ["schemaVersion", "type", "mandateId", "issuedAt", "verifierKeyId", "verdict", "reasonCodes", "checks", "sourceEvidence", "settlementSignal", "outcomeHash", "signature"]);
  if (receipt.schemaVersion !== "0.1" || receipt.type !== "agent-vigil/outcome-receipt") throw new Error("unsupported outcome receipt schema or type");
  requireSha(receipt.mandateId, "mandateId");
  requireSha(receipt.outcomeHash, "outcomeHash");
  parseTime(receipt.issuedAt, "issuedAt");
  requireSha(receipt.verifierKeyId, "verifierKeyId");
  if (!new Set(["PASS", "FAIL", "INCONCLUSIVE"]).has(receipt.verdict)) throw new Error("receipt verdict is invalid");
  if (!Array.isArray(receipt.reasonCodes) || receipt.reasonCodes.length > 2048 || !Array.isArray(receipt.checks) || receipt.checks.length < 1 || receipt.checks.length > 2048) throw new Error("receipt must contain 1-2048 checks and no more than 2048 reason codes");
  if (new Set(receipt.reasonCodes).size !== receipt.reasonCodes.length) throw new Error("receipt reasonCodes must not contain duplicates");
  for (const item of receipt.checks) {
    requireObjectKeys(item, "receipt check", ["id", "verdict", "evidence"]);
    requireId(item.id, "check.id");
    if (!new Set(["PASS", "FAIL", "INCONCLUSIVE"]).has(item.verdict)) throw new Error("check verdict is invalid");
    if (typeof item.evidence !== "string" || !item.evidence || item.evidence.length > 4000) throw new Error("check evidence must contain 1-4000 characters");
  }
  const expectedVerdict = overallVerdict(receipt.checks);
  if (receipt.verdict !== expectedVerdict) throw new Error(`receipt verdict ${receipt.verdict} disagrees with its checks (${expectedVerdict})`);
  const expectedReasonCodes = reasonCodes(receipt.checks);
  if (canonical(receipt.reasonCodes) !== canonical(expectedReasonCodes)) throw new Error("receipt reasonCodes disagree with its checks");
  requireObjectKeys(receipt.sourceEvidence, "sourceEvidence", ["type", "reportHash", "base", "head", "status", "signerKeyId"]);
  if (receipt.sourceEvidence?.type !== "agent-vigil/trust-report") throw new Error("source evidence type is unsupported");
  requireSha(receipt.sourceEvidence.reportHash, "sourceEvidence.reportHash");
  requireGitOid(receipt.sourceEvidence.base, "sourceEvidence.base");
  requireGitOid(receipt.sourceEvidence.head, "sourceEvidence.head");
  if (!new Set(["PASS", "FAIL", "INCONCLUSIVE"]).has(receipt.sourceEvidence.status)) throw new Error("source evidence status is invalid");
  if (receipt.sourceEvidence.signerKeyId) requireSha(receipt.sourceEvidence.signerKeyId, "sourceEvidence.signerKeyId");
  requireObjectKeys(receipt.settlementSignal, "settlementSignal", ["mode", "adapter", "action", "reference", "dryRun", "networkAction"]);
  if (receipt.settlementSignal?.mode !== "signal-only" || receipt.settlementSignal.dryRun !== true || receipt.settlementSignal.networkAction !== "NONE") throw new Error("receipt settlement signal must be dry-run signal-only with networkAction NONE");
  if (!ADAPTERS.has(receipt.settlementSignal.adapter)) throw new Error("receipt settlement adapter is unsupported");
  if (receipt.settlementSignal.action !== outcomeAction(receipt.verdict)) throw new Error("receipt settlement action disagrees with verdict");
  if (receipt.settlementSignal.reference !== undefined && (typeof receipt.settlementSignal.reference !== "string" || !receipt.settlementSignal.reference.trim() || receipt.settlementSignal.reference.length > 500)) throw new Error("receipt settlement reference must be a non-empty string of at most 500 characters");
  requireObjectKeys(receipt.signature, "receipt signature", ["algorithm", "keyId", "publicKey", "value"]);
  if (receipt.signature?.algorithm !== "Ed25519") throw new Error("receipt signature algorithm must be Ed25519");
  requireSha(receipt.signature?.keyId, "receipt signature keyId");
  if (receipt.signature.keyId !== receipt.verifierKeyId) throw new Error("receipt signature key does not match verifierKeyId");
  if (typeof receipt.signature.publicKey !== "string" || typeof receipt.signature.value !== "string" || !receipt.signature.publicKey || !receipt.signature.value) throw new Error("receipt signature fields are required");
  return receipt;
}

export function verifyOutcomeReceipt(input: unknown, verifierPublicKeyPath?: string, trustedKeyIds: string[] = []): VerificationResult {
  const errors: string[] = [];
  try { uniqueStrings(trustedKeyIds, "trustedKeyIds").forEach((value) => requireSha(value, "trusted verifier key ID")); }
  catch (error) { return { valid: false, hashValid: false, signatureValid: false, keyPinned: Boolean(verifierPublicKeyPath || trustedKeyIds.length), expired: false, errors: [(error as Error).message] }; }
  let receipt: OutcomeReceipt;
  try { receipt = validateReceiptShape(input); }
  catch (error) { return { valid: false, hashValid: false, signatureValid: false, keyPinned: Boolean(verifierPublicKeyPath || trustedKeyIds.length), expired: false, errors: [(error as Error).message] }; }
  const hashValid = digest(payloadOfReceipt(receipt)) === receipt.outcomeHash;
  if (!hashValid) errors.push("outcome receipt content hash is invalid");
  let signatureValid = false;
  let keyId: string | undefined;
  try {
    const embedded = createPublicKey({ key: Buffer.from(receipt.signature.publicKey, "base64"), type: "spki", format: "der" });
    if (embedded.asymmetricKeyType !== "ed25519") throw new Error("embedded verifier key must be Ed25519");
    const selected = verifierPublicKeyPath ? createPublicKey(readFileSync(verifierPublicKeyPath)) : embedded;
    if (selected.asymmetricKeyType !== "ed25519") throw new Error("verifier public key must be Ed25519");
    keyId = signingKeyId(publicKeyDer(selected));
    signatureValid = keyId === receipt.signature.keyId
      && verify(null, Buffer.from(receipt.outcomeHash), selected, Buffer.from(receipt.signature.value, "base64"));
    if (!signatureValid) errors.push("outcome receipt signature is invalid or does not match the pinned verifier key");
  } catch (error) { errors.push(`outcome receipt signature could not be read: ${(error as Error).message}`); }
  const keyPinned = Boolean(verifierPublicKeyPath) || (Boolean(keyId) && trustedKeyIds.includes(keyId!));
  if (trustedKeyIds.length && (!keyId || !trustedKeyIds.includes(keyId))) errors.push("verifier key ID is not trusted");
  return { valid: errors.length === 0, hashValid, signatureValid, keyPinned, expired: false, ...(keyId ? { keyId } : {}), errors };
}

export function buildSettlementAdapterPayload(
  receiptInput: unknown,
  adapterOverride: OutcomeAdapter | undefined,
  trust: { verifierPublicKeyPath?: string; trustedKeyIds?: string[] },
): Record<string, unknown> {
  const receipt = validateReceiptShape(receiptInput);
  if (!trust.verifierPublicKeyPath && !(trust.trustedKeyIds?.length)) throw new Error("signal rendering requires a pinned verifier public key or trusted verifier key ID");
  const verification = verifyOutcomeReceipt(receipt, trust.verifierPublicKeyPath, trust.trustedKeyIds ?? []);
  if (!verification.valid || !verification.keyPinned) throw new Error(`cannot render a signal from an invalid or untrusted outcome receipt: ${verification.errors.join("; ") || "verifier key is not pinned"}`);
  const adapter = adapterOverride ?? receipt.settlementSignal.adapter;
  if (!ADAPTERS.has(adapter)) throw new Error("unsupported settlement adapter");
  const decision = receipt.verdict === "PASS" ? "accept" : receipt.verdict === "FAIL" ? "reject" : "escalate";
  const common = {
    draft: true,
    networkAction: "NONE",
    mandateId: receipt.mandateId,
    outcomeReceiptHash: receipt.outcomeHash,
    verdict: receipt.verdict,
    action: receipt.settlementSignal.action,
    ...(receipt.settlementSignal.reference ? { reference: receipt.settlementSignal.reference } : {}),
  };
  if (adapter === "a2a") return {
    type: "agent-vigil/a2a-acceptance-extension-draft",
    extensionUri: "https://sulmusic2-star.github.io/agent-vigil/extensions/outcome/v0.1",
    metadata: { decision, reasonCodes: receipt.reasonCodes, receiptHash: receipt.outcomeHash },
    ...common,
  };
  if (adapter === "ap2") return {
    type: "agent-vigil/ap2-outcome-extension-draft",
    releaseCondition: "delivery-confirmation",
    decision,
    ...common,
  };
  if (adapter === "x402") return {
    type: "agent-vigil/x402-outcome-signal-draft",
    settlementDecision: receipt.settlementSignal.action.toLowerCase(),
    ...common,
  };
  if (adapter === "erc-8004") return {
    type: "agent-vigil/erc-8004-validation-draft",
    validationTag: "agent-vigil-outcome-v0.1",
    response: receipt.verdict === "PASS" ? 100 : receipt.verdict === "FAIL" ? 0 : 50,
    ...common,
  };
  if (adapter === "vcap") return {
    type: "agent-vigil/vcap-verification-callback-draft",
    messageType: "verification_callback",
    decision,
    ...common,
  };
  return { type: "agent-vigil/outcome-signal", decision, ...common };
}

export function loadOutcomeJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("outcome JSON exceeds the 2 MiB limit");
  try { return JSON.parse(raw); }
  catch { throw new Error(`outcome JSON is invalid: ${path}`); }
}
