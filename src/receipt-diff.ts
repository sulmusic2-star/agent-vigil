import { createHash } from "node:crypto";
import type { CheckResult, ReportStatus, TrustReport, Verdict } from "./report.ts";
import { canonical } from "./report.ts";
import { verifyReport } from "./signature.ts";

export type ReceiptDelta = {
  schemaVersion: "agent-vigil-receipt-delta/v1";
  generatedAt: string;
  before: ReceiptIdentity;
  after: ReceiptIdentity;
  status: ReportStatus;
  deltaHash: string;
  policy: { same: boolean; weakened: string[] };
  range: { related: boolean; relationship: "same-base" | "chained" | "unrelated" };
  signer: { continuity: "same" | "changed" | "added" | "removed" | "unsigned"; before?: string; after?: string };
  regressions: DeltaItem[];
  improvements: DeltaItem[];
  newAdvisories: DeltaItem[];
  resolvedAdvisories: DeltaItem[];
  unchangedChecks: number;
  notes: string[];
};

type ReceiptIdentity = {
  receiptHash: string;
  hashValid: boolean;
  signature: "valid" | "invalid" | "absent";
  internallyConsistent: boolean;
  keyId?: string;
  base: string;
  head: string;
  policySha256: string;
  status: ReportStatus;
};

function consistencyErrors(report: TrustReport): string[] {
  const errors: string[] = [];
  const count = (verdict: Verdict) => report.results.filter((row) => row.verdict === verdict).length;
  const meaningfulVerified = report.results.filter((row) => row.verdict === "verified" && row.contributesToPass !== false).length;
  const expectedStatus: ReportStatus = count("contradicted") > 0
    ? "FAIL"
    : meaningfulVerified < report.policy.minVerified
      || report.results.some((row) => row.verdict === "unverifiable" && row.blocksPass)
      || (report.policy.strict && count("unverifiable") > 0)
      ? "INCONCLUSIVE"
      : "PASS";
  if (report.summary.verified !== count("verified")) errors.push("verified count does not match results");
  if (report.summary.contradicted !== count("contradicted")) errors.push("contradicted count does not match results");
  if (report.summary.unverifiable !== count("unverifiable")) errors.push("unverifiable count does not match results");
  if (report.summary.meaningfulVerified !== meaningfulVerified) errors.push("meaningfulVerified count does not match results");
  if (report.summary.status !== expectedStatus) errors.push(`status ${report.summary.status} should be ${expectedStatus}`);
  if (report.summary.pass !== (report.summary.status === "PASS")) errors.push("pass boolean does not match status");
  if (!Number.isInteger(report.policy.minVerified) || report.policy.minVerified < 1) errors.push("minVerified is invalid");
  return errors;
}

export type DeltaItem = {
  key: string;
  ruleId: string;
  subject: string;
  before?: Verdict | "advisory" | "absent";
  after?: Verdict | "advisory" | "absent";
  reason: string;
};

function checkKey(check: CheckResult): string {
  return `${check.ruleId ?? check.claim.kind}|${check.claim.kind}|${check.claim.subject}`;
}

function advisoryKey(check: CheckResult): string {
  return `${checkKey(check)}|${check.evidence}`;
}

function item(check: CheckResult, values: Omit<DeltaItem, "key" | "ruleId" | "subject">): DeltaItem {
  return {
    key: checkKey(check),
    ruleId: check.ruleId ?? check.claim.kind,
    subject: check.claim.subject,
    ...values,
  };
}

function verification(report: TrustReport): ReceiptIdentity {
  const internallyConsistent = consistencyErrors(report).length === 0;
  try {
    const verified = verifyReport(report);
    return {
      receiptHash: report.receiptHash,
      hashValid: verified.hashValid,
      signature: report.signature ? (verified.signatureValid ? "valid" : "invalid") : "absent",
      internallyConsistent,
      ...(report.signature ? { keyId: report.signature.keyId } : {}),
      base: report.base,
      head: report.head,
      policySha256: report.policy.sha256,
      status: report.summary.status,
    };
  } catch {
    return {
      receiptHash: report.receiptHash,
      hashValid: false,
      signature: report.signature ? "invalid" : "absent",
      internallyConsistent,
      base: report.base,
      head: report.head,
      policySha256: report.policy.sha256,
      status: report.summary.status,
    };
  }
}

function signerContinuity(before: ReceiptIdentity, after: ReceiptIdentity): ReceiptDelta["signer"] {
  if (!before.keyId && !after.keyId) return { continuity: "unsigned" };
  if (!before.keyId && after.keyId) return { continuity: "added", after: after.keyId };
  if (before.keyId && !after.keyId) return { continuity: "removed", before: before.keyId };
  return { continuity: before.keyId === after.keyId ? "same" : "changed", before: before.keyId, after: after.keyId };
}

function reportStatusRank(status: ReportStatus): number {
  return status === "PASS" ? 2 : status === "INCONCLUSIVE" ? 1 : 0;
}

function verdictRank(verdict: Verdict): number {
  return verdict === "verified" ? 2 : verdict === "unverifiable" ? 1 : 0;
}

function isInvariant(check: CheckResult): boolean {
  return check.contributesToPass === false || check.blocksPass === true || check.claim.kind === "policy_attestation" || check.claim.kind === "integrity";
}

export function compareReceipts(beforeReport: TrustReport, afterReport: TrustReport): ReceiptDelta {
  const before = verification(beforeReport);
  const after = verification(afterReport);
  const regressions: DeltaItem[] = [];
  const improvements: DeltaItem[] = [];
  const notes: string[] = [];

  if (!before.hashValid || !after.hashValid) {
    const receipt = !before.hashValid ? beforeReport : afterReport;
    regressions.push({ key: "receipt-hash", ruleId: "receipt-hash", subject: "receipt content hash", reason: `${!before.hashValid ? "before" : "after"} receipt hash is invalid` });
    notes.push(`Do not trust ${receipt.receiptHash}; its canonical payload does not match the recorded hash.`);
  }
  if (!before.internallyConsistent || !after.internallyConsistent) {
    const which = !before.internallyConsistent ? "before" : "after";
    regressions.push({ key: "receipt-consistency", ruleId: "receipt-consistency", subject: "receipt summary and policy invariants", reason: `${which} receipt is internally inconsistent` });
    notes.push(`${which} receipt: ${consistencyErrors(!before.internallyConsistent ? beforeReport : afterReport).join("; ")}`);
  }
  if (before.signature === "invalid" || after.signature === "invalid") {
    regressions.push({ key: "receipt-signature", ruleId: "receipt-signature", subject: "embedded Ed25519 signature", reason: `${before.signature === "invalid" ? "before" : "after"} receipt signature is invalid` });
  }

  const policyWeakened: string[] = [];
  if (afterReport.policy.minVerified < beforeReport.policy.minVerified) policyWeakened.push(`minVerified fell from ${beforeReport.policy.minVerified} to ${afterReport.policy.minVerified}`);
  if (beforeReport.policy.strict && !afterReport.policy.strict) policyWeakened.push("strict policy changed from true to false");
  for (const reason of policyWeakened) regressions.push({ key: `policy|${reason}`, ruleId: "policy-weakened", subject: "verification policy strength", reason });
  const samePolicy = beforeReport.policy.sha256 === afterReport.policy.sha256;
  if (!samePolicy) notes.push("Policy hashes differ; behavioral check deltas are not directly comparable.");

  const relationship: ReceiptDelta["range"]["relationship"] = beforeReport.base === afterReport.base
    ? "same-base"
    : beforeReport.head === afterReport.base
      ? "chained"
      : "unrelated";
  if (relationship === "unrelated") notes.push("Git ranges are neither same-base PR revisions nor a chained before-head to after-base sequence.");
  if (beforeReport.repository.remote && afterReport.repository.remote && beforeReport.repository.remote !== afterReport.repository.remote) {
    notes.push("Repository remotes differ.");
  }

  const beforeChecks = new Map(beforeReport.results.map((check) => [checkKey(check), check]));
  const afterChecks = new Map(afterReport.results.map((check) => [checkKey(check), check]));
  let unchangedChecks = 0;
  for (const [key, prior] of beforeChecks) {
    const current = afterChecks.get(key);
    if (!current) {
      const cleanScanBecameAdvisories = prior.ruleId === "integrity-scan" && (afterReport.advisories?.length ?? 0) > 0;
      if (isInvariant(prior) && prior.verdict === "verified" && !cleanScanBecameAdvisories) {
        regressions.push(item(prior, { before: prior.verdict, after: "absent", reason: "previously verified invariant check disappeared" }));
      }
      continue;
    }
    if (current.verdict === prior.verdict) { unchangedChecks += 1; continue; }
    if (verdictRank(current.verdict) < verdictRank(prior.verdict)) {
      regressions.push(item(current, { before: prior.verdict, after: current.verdict, reason: "check verdict weakened" }));
    } else {
      improvements.push(item(current, { before: prior.verdict, after: current.verdict, reason: "check verdict improved" }));
    }
  }
  for (const [key, current] of afterChecks) {
    if (beforeChecks.has(key)) continue;
    if (current.verdict === "contradicted") regressions.push(item(current, { before: "absent", after: current.verdict, reason: "new contradiction" }));
    else if (current.verdict === "unverifiable" && current.blocksPass) regressions.push(item(current, { before: "absent", after: current.verdict, reason: "new blocking evidence gap" }));
    else if (current.verdict === "verified") improvements.push(item(current, { before: "absent", after: current.verdict, reason: "new verified check" }));
  }
  if (reportStatusRank(afterReport.summary.status) < reportStatusRank(beforeReport.summary.status)) {
    regressions.push({ key: "report-status", ruleId: "report-status", subject: "overall receipt status", before: beforeReport.summary.status === "PASS" ? "verified" : "unverifiable", after: afterReport.summary.status === "FAIL" ? "contradicted" : "unverifiable", reason: `${beforeReport.summary.status} became ${afterReport.summary.status}` });
  } else if (reportStatusRank(afterReport.summary.status) > reportStatusRank(beforeReport.summary.status)) {
    improvements.push({ key: "report-status", ruleId: "report-status", subject: "overall receipt status", reason: `${beforeReport.summary.status} became ${afterReport.summary.status}` });
  }

  const beforeAdvisories = new Map((beforeReport.advisories ?? []).map((check) => [advisoryKey(check), check]));
  const afterAdvisories = new Map((afterReport.advisories ?? []).map((check) => [advisoryKey(check), check]));
  const newAdvisories = [...afterAdvisories].filter(([key]) => !beforeAdvisories.has(key)).map(([, check]) => item(check, { before: "absent", after: "advisory", reason: "new receipt-bound advisory" }));
  const resolvedAdvisories = [...beforeAdvisories].filter(([key]) => !afterAdvisories.has(key)).map(([, check]) => item(check, { before: "advisory", after: "absent", reason: "prior advisory is absent" }));

  const signer = signerContinuity(before, after);
  if (signer.continuity === "removed") regressions.push({ key: "signer-removed", ruleId: "signer-continuity", subject: "receipt signer", reason: "after receipt removed a previously present signature" });
  if (signer.continuity === "changed") notes.push("Signer key changed; establish the rotation through a trusted policy or separate approval.");
  if (signer.continuity === "unsigned") notes.push("Both hashes are content-integrity checks only; signer identity is unestablished.");

  let status: ReportStatus;
  if (regressions.length) status = "FAIL";
  else if (!samePolicy || relationship === "unrelated" || signer.continuity === "changed") status = "INCONCLUSIVE";
  else status = "PASS";

  const unsigned = {
    schemaVersion: "agent-vigil-receipt-delta/v1" as const,
    generatedAt: new Date().toISOString(),
    before,
    after,
    status,
    policy: { same: samePolicy, weakened: policyWeakened },
    range: { related: relationship !== "unrelated", relationship },
    signer,
    regressions,
    improvements,
    newAdvisories,
    resolvedAdvisories,
    unchangedChecks,
    notes,
  };
  return { ...unsigned, deltaHash: `sha256:${createHash("sha256").update(canonical(unsigned)).digest("hex")}` };
}

export function renderReceiptDelta(delta: ReceiptDelta): string {
  const lines = [
    `Agent Vigil receipt delta: ${delta.status}`,
    `  before: ${delta.before.receiptHash} (${delta.before.status})`,
    `  after:  ${delta.after.receiptHash} (${delta.after.status})`,
    `  policy: ${delta.policy.same ? "same" : "changed"}`,
    `  range:  ${delta.range.relationship}`,
    `  signer: ${delta.signer.continuity}`,
    `  ${delta.regressions.length} regression(s) · ${delta.improvements.length} improvement(s) · ${delta.newAdvisories.length} new advisory finding(s)`,
  ];
  for (const row of delta.regressions) lines.push(`  ✗ [${row.ruleId}] ${row.subject}: ${row.reason}`);
  for (const row of delta.improvements) lines.push(`  ✓ [${row.ruleId}] ${row.subject}: ${row.reason}`);
  for (const row of delta.newAdvisories) lines.push(`  ! [${row.ruleId}] ${row.subject}: ${row.reason}`);
  for (const note of delta.notes) lines.push(`  ? ${note}`);
  lines.push(`  ${delta.deltaHash}`);
  return lines.join("\n");
}
