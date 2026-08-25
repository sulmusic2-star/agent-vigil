import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { readBoundedRegularFile } from "./continuity/contracts.ts";
import type { ReportStatus, TrustReport } from "./report.ts";
import { recomputeReceiptHash, validateTrustReport } from "./report.ts";
import { writePrivateFileAtomic } from "./safe-output.ts";

export const ATTESTATION_PREDICATE_TYPE = "https://sulmusic2-star.github.io/agent-vigil/ai-change-receipt-predicate-v1.schema.json";

export type AiChangeReceiptPredicate = {
  predicateVersion: "1";
  receipt: {
    schemaVersion: "2";
    receiptHash: string;
    fileSha256: string;
    status: ReportStatus;
    base: string;
    head: string;
    tree: string;
    policySha256: string;
    vigilVersion: string;
    verified: number;
    contradicted: number;
    unresolved: number;
  };
  privacy: {
    sourceIncluded: false;
    transcriptIncluded: false;
    promptIncluded: false;
  };
};

export type AttestationVerification = {
  valid: boolean;
  receiptHashValid: boolean;
  subjectDigestValid: boolean;
  predicateValid: boolean;
  statementCount: number;
  predicate?: AiChangeReceiptPredicate;
};

export type AttestationTrust = {
  signerWorkflow?: string;
  allowSelfHosted?: boolean;
};

export type CheckRunPayload = {
  name: "Agent Vigil verified";
  head_sha: string;
  status: "completed";
  conclusion: "success" | "failure" | "action_required";
  output: {
    title: string;
    summary: string;
    text: string;
  };
};

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function fullGitHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);
}

function exactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

export function loadReceipt(path: string): { report: TrustReport; bytes: Buffer; fileSha256: string } {
  const absolute = resolve(path);
  const bytes = readBoundedRegularFile(absolute, 16 * 1024 * 1024, "receipt");
  const report = validateTrustReport(JSON.parse(bytes.toString("utf8")));
  if (!fullGitHash(report.base) || !fullGitHash(report.head)) throw new Error("attestation requires full base and head commit SHAs");
  if (!fullGitHash(report.repository?.tree)) throw new Error("attestation requires the exact committed Git tree");
  if (!/^sha256:[0-9a-f]{64}$/i.test(report.policy?.sha256)) throw new Error("attestation requires a SHA-256 policy digest");
  if (!/^sha256:[0-9a-f]{64}$/i.test(report.receiptHash)) throw new Error("receipt has an invalid receiptHash");
  if (recomputeReceiptHash(report) !== report.receiptHash) throw new Error("receipt content does not match receiptHash");
  return { report, bytes, fileSha256: sha256(bytes) };
}

export function buildAttestationPredicate(reportPath: string): AiChangeReceiptPredicate {
  const { report, fileSha256 } = loadReceipt(reportPath);
  return {
    predicateVersion: "1",
    receipt: {
      schemaVersion: "2",
      receiptHash: report.receiptHash,
      fileSha256: `sha256:${fileSha256}`,
      status: report.summary.status,
      base: report.base,
      head: report.head,
      tree: report.repository.tree!,
      policySha256: report.policy.sha256,
      vigilVersion: report.vigilVersion,
      verified: report.summary.verified,
      contradicted: report.summary.contradicted,
      unresolved: report.summary.unverifiable,
    },
    privacy: {
      sourceIncluded: false,
      transcriptIncluded: false,
      promptIncluded: false,
    },
  };
}

export function writeAttestationPredicate(reportPath: string, predicateOutput: string): AiChangeReceiptPredicate {
  const predicate = buildAttestationPredicate(reportPath);
  writePrivateFileAtomic(resolve(predicateOutput), `${JSON.stringify(predicate, null, 2)}\n`);
  return predicate;
}

function statementsFromGh(value: unknown): Array<Record<string, unknown>> {
  const roots = Array.isArray(value) ? value : [value];
  const statements: Array<Record<string, unknown>> = [];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const record = root as Record<string, unknown>;
    const verification = record.verificationResult;
    const statement = verification && typeof verification === "object"
      ? (verification as Record<string, unknown>).statement
      : record.statement ?? record;
    if (statement && typeof statement === "object") statements.push(statement as Record<string, unknown>);
  }
  return statements;
}

function subjectMatches(statement: Record<string, unknown>, expectedName: string, expectedDigest: string): boolean {
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  return subjects.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const subject = entry as Record<string, unknown>;
    const digest = subject.digest && typeof subject.digest === "object" ? subject.digest as Record<string, unknown> : {};
    const name = String(subject.name ?? "");
    return (name === expectedName || name.endsWith(`/${expectedName}`)) && digest.sha256 === expectedDigest;
  });
}

function predicateMatches(predicate: unknown, report: TrustReport, fileSha256: string): predicate is AiChangeReceiptPredicate {
  if (!predicate || typeof predicate !== "object") return false;
  const candidate = predicate as Partial<AiChangeReceiptPredicate>;
  const receipt = candidate.receipt;
  const privacy = candidate.privacy;
  return candidate.predicateVersion === "1"
    && exactKeys(candidate, ["predicateVersion", "privacy", "receipt"])
    && Boolean(receipt) && exactKeys(receipt!, ["base", "contradicted", "fileSha256", "head", "policySha256", "receiptHash", "schemaVersion", "status", "tree", "unresolved", "verified", "vigilVersion"])
    && Boolean(privacy) && exactKeys(privacy!, ["promptIncluded", "sourceIncluded", "transcriptIncluded"])
    && receipt?.schemaVersion === "2"
    && receipt.receiptHash === report.receiptHash
    && receipt.fileSha256 === `sha256:${fileSha256}`
    && receipt.status === report.summary.status
    && receipt.base === report.base
    && receipt.head === report.head
    && receipt.tree === report.repository.tree
    && receipt.policySha256 === report.policy.sha256
    && receipt.vigilVersion === report.vigilVersion
    && receipt.verified === report.summary.verified
    && receipt.contradicted === report.summary.contradicted
    && receipt.unresolved === report.summary.unverifiable
    && privacy?.sourceIncluded === false
    && privacy.transcriptIncluded === false
    && privacy.promptIncluded === false;
}

export function verifyGhAttestationOutput(reportPath: string, ghOutput: unknown): AttestationVerification {
  const { report, fileSha256 } = loadReceipt(reportPath);
  const statements = statementsFromGh(ghOutput);
  let subjectDigestValid = false;
  let predicateValid = false;
  let matched: AiChangeReceiptPredicate | undefined;
  for (const statement of statements) {
    if (statement.predicateType !== ATTESTATION_PREDICATE_TYPE) continue;
    const subjectOk = subjectMatches(statement, basename(reportPath), fileSha256);
    const predicateOk = predicateMatches(statement.predicate, report, fileSha256);
    subjectDigestValid ||= subjectOk;
    predicateValid ||= predicateOk;
    if (subjectOk && predicateOk) matched = statement.predicate as AiChangeReceiptPredicate;
  }
  const receiptHashValid = recomputeReceiptHash(report) === report.receiptHash;
  return {
    valid: receiptHashValid && subjectDigestValid && predicateValid && Boolean(matched),
    receiptHashValid,
    subjectDigestValid,
    predicateValid,
    statementCount: statements.length,
    ...(matched ? { predicate: matched } : {}),
  };
}

type GhAttestationExecutor = (args: string[]) => string;

const runGitHubCli: GhAttestationExecutor = (args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function verifyGitHubAttestation(
  reportPath: string,
  repository: string,
  trust: AttestationTrust = {},
  executeGh: GhAttestationExecutor = runGitHubCli,
): AttestationVerification {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("repository must be owner/name");
  const signerWorkflow = trust.signerWorkflow ?? `${repository}/.github/workflows/agent-vigil.yml`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/i.test(signerWorkflow)) {
    throw new Error("signer workflow must be owner/name/.github/workflows/file.yml");
  }
  const command = [
    "attestation", "verify", resolve(reportPath),
    "--repo", repository,
    "--predicate-type", ATTESTATION_PREDICATE_TYPE,
    "--signer-workflow", signerWorkflow,
    "--format", "json",
    ...(!trust.allowSelfHosted ? ["--deny-self-hosted-runners"] : []),
  ];
  let raw: string;
  try {
    raw = executeGh(command);
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: string | Buffer }).stderr ?? "").trim()
      : "";
    throw new Error(`GitHub attestation verification failed${detail ? `: ${detail}` : "; install and authenticate a current GitHub CLI"}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("GitHub CLI returned unreadable attestation JSON"); }
  return verifyGhAttestationOutput(reportPath, parsed);
}

export function buildNotaryCheck(reportPath: string, verification: AttestationVerification, expectedHead: string, expectedPolicySha256: string): CheckRunPayload {
  const { report } = loadReceipt(reportPath);
  if (!fullGitHash(expectedHead)) throw new Error("notary expected head must be a full commit SHA");
  if (!/^sha256:[0-9a-f]{64}$/i.test(expectedPolicySha256)) throw new Error("notary expected policy must be sha256:<64 hex characters>");
  if (!verification.valid) throw new Error("notary refused an invalid GitHub attestation");
  if (report.head !== expectedHead) throw new Error(`receipt head ${report.head} does not match expected head ${expectedHead}`);
  if (report.policy.sha256 !== expectedPolicySha256) throw new Error(`receipt policy ${report.policy.sha256} does not match trusted policy ${expectedPolicySha256}`);

  const conclusion = report.summary.status === "PASS" ? "success" : report.summary.status === "FAIL" ? "failure" : "action_required";
  const explanation = report.summary.status === "PASS"
    ? "The required evidence is present for this exact commit."
    : report.summary.status === "FAIL"
    ? "One or more required checks contradicted the change or its claims."
    : "The available evidence is not enough to approve this change.";
  return {
    name: "Agent Vigil verified",
    head_sha: expectedHead,
    status: "completed",
    conclusion,
    output: {
      title: `Agent Vigil: ${report.summary.status}`,
      summary: explanation,
      text: [
        explanation,
        "",
        `Receipt: ${report.receiptHash}`,
        `Policy: ${report.policy.sha256}`,
        `Evidence: ${report.summary.verified} verified, ${report.summary.contradicted} contradicted, ${report.summary.unverifiable} unresolved.`,
        `Attestation: ${ATTESTATION_PREDICATE_TYPE}`,
      ].join("\n"),
    },
  };
}

export function verifyWebhookSignature(secret: string, body: Buffer, signatureHeader: string | undefined): boolean {
  if (!secret || !signatureHeader?.startsWith("sha256=")) return false;
  const actualExpected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signatureHeader);
  return actual.length === actualExpected.length && timingSafeEqual(actual, actualExpected);
}
