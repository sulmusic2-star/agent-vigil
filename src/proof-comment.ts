import { validateTrustReport, type CheckResult } from "./report.ts";
import { verifyReport } from "./signature.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export const PROOF_COMMENT_MARKER = "<!-- agent-vigil-proof-comment:v1 -->";

export type ProofCommentOptions = {
  verifyUrl?: string;
};

function code(value: string): string {
  return `\`${terminalSafe(value).replace(/`/g, "\\`")}\``;
}

function count(results: CheckResult[], ruleId: string, verdict?: CheckResult["verdict"]): number {
  return results.filter((result) => result.ruleId === ruleId && (!verdict || result.verdict === verdict)).length;
}

function verifiedUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.length > 2048) throw new Error("proof comment verify URL exceeds 2048 characters");
  let value: URL;
  try { value = new URL(raw); }
  catch { throw new Error("proof comment verify URL must be an absolute HTTPS URL"); }
  if (value.protocol !== "https:" || value.username || value.password) {
    throw new Error("proof comment verify URL must be an absolute HTTPS URL without credentials");
  }
  return value.toString();
}

export function renderProofComment(value: unknown, options: ProofCommentOptions = {}): string {
  const report = validateTrustReport(value);
  const verification = verifyReport(report);
  if (!verification.hashValid) throw new Error("proof comment receipt content does not match receiptHash");
  if (verification.signatureValid === false) throw new Error("proof comment receipt signature is invalid");
  const results = report.results ?? [];
  const differentialEarned = count(results, "differential-test", "verified");
  const differentialAlsoPassedBase = count(results, "differential-base-fail", "contradicted");
  const integrityChanges = results.filter((result) =>
    result.verdict === "contradicted"
    && (result.claim.kind === "integrity" || result.ruleId?.startsWith("integrity-")),
  ).length;
  const authorityBlocks = results.filter((result) =>
    result.verdict === "contradicted"
    && result.ruleId !== "authority-plan"
    && result.ruleId?.startsWith("authority-"),
  ).length;
  const signature = verification.signatureValid
    ? "valid embedded Ed25519 signature; signer identity is not pinned"
    : "absent; content hash only";
  const url = verifiedUrl(options.verifyUrl);
  const title = report.summary.status === "PASS"
    ? "Required evidence is present for this exact change"
    : report.summary.status === "FAIL"
      ? "Required evidence was contradicted for this exact change"
      : "Evidence is incomplete for this exact change";
  const facts = [
    `- **Evidence:** ${report.summary.verified} verified, ${report.summary.contradicted} contradicted, ${report.summary.unverifiable} unresolved`,
    `- **Candidate-only regression checks:** ${differentialEarned} verified`,
    `- **Changed regression checks that also passed on base:** ${differentialAlsoPassedBase}`,
    `- **Integrity-control contradictions:** ${integrityChanges}`,
    `- **Unapproved authority contradictions:** ${authorityBlocks}`,
  ];

  return [
    PROOF_COMMENT_MARKER,
    `### Agent Vigil: ${report.summary.status}`,
    "",
    title,
    "",
    ...facts,
    "",
    `**Change:** ${code(report.base)} -> ${code(report.head)}  `,
    `**Policy:** ${code(report.policy.sha256)}  `,
    `**Receipt:** ${code(report.receiptHash)}  `,
    `**Signature:** ${signature}`,
    ...(url ? ["", `[Verify this receipt](${url.replace(/[()]/g, (character) => `\\${character}`)})`] : []),
    "",
    "The retained receipt contains the check details. This result does not prove that the code is bug-free or that unobserved actions did not occur.",
    "",
  ].join("\n");
}
