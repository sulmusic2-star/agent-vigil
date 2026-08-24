import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { canonical } from "./report.ts";
import { writePrivateFileAtomic } from "./safe-output.ts";
import type { ControlProofActual, ControlProofExpected, ControlProofReport } from "./control-proof.ts";

export const CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE = "https://sulmusic2-star.github.io/agent-vigil/control-proof-predicate-v1.schema.json";

export type ControlProofPredicate = {
  predicateVersion: "1";
  proof: {
    schemaVersion: "agent-vigil-control-proof/v1";
    receiptHash: string;
    fileSha256: string;
    status: "PASS" | "HOLD";
    sourceCommit: string;
    generatedAt: string;
    vigilVersion: string;
    passed: number;
    total: number;
    challengeSetSha256: string;
  };
  privacy: {
    claimsIncluded: false;
    evidenceIncluded: false;
    repositoryPathIncluded: false;
  };
};

export type ControlProofAttestationVerification = {
  valid: boolean;
  proofHashValid: boolean;
  subjectDigestValid: boolean;
  predicateValid: boolean;
  statementCount: number;
  predicate?: ControlProofPredicate;
};

export type ControlProofAttestationTrust = {
  signerWorkflow?: string;
  signerDigest?: string;
  allowSelfHosted?: boolean;
};

type GhAttestationExecutor = (args: string[]) => string;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PLAIN = /^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u;
const EXPECTED = new Set<ControlProofExpected>(["PASS", "BLOCK", "HOLD"]);
const ACTUAL = new Set<ControlProofActual>(["PASS", "BLOCK", "HOLD", "ERROR"]);

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function plain(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || !PLAIN.test(value)) {
    throw new Error(`${label} must be plain text between 1 and ${maximum} characters`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const selected = plain(value, label, 40);
  const parsed = Date.parse(selected);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== selected) throw new Error(`${label} must be canonical RFC3339 UTC`);
  return selected;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function validateControlProof(value: unknown): ControlProofReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("control proof must be an object");
  const proof = value as Record<string, unknown>;
  if (!exactKeys(proof, ["schemaVersion", "vigilVersion", "status", "sourceCommit", "generatedAt", "receiptHash", "challenges", "summary", "reproduction", "limits"])) {
    throw new Error("control proof has unsupported or missing fields");
  }
  if (proof.schemaVersion !== "agent-vigil-control-proof/v1") throw new Error("unsupported control proof schema");
  const vigilVersion = plain(proof.vigilVersion, "control proof vigilVersion", 80);
  if (proof.status !== "PASS" && proof.status !== "HOLD") throw new Error("control proof status must be PASS or HOLD");
  const sourceCommit = plain(proof.sourceCommit, "control proof sourceCommit", 40);
  if (!COMMIT.test(sourceCommit)) throw new Error("control proof sourceCommit must be a full lowercase commit SHA");
  const generatedAt = timestamp(proof.generatedAt, "control proof generatedAt");
  if (!Array.isArray(proof.challenges) || proof.challenges.length < 1 || proof.challenges.length > 100) {
    throw new Error("control proof must contain 1 to 100 challenges");
  }
  const ids = new Set<string>();
  const challenges = proof.challenges.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`control proof challenge ${index} must be an object`);
    const item = value as Record<string, unknown>;
    if (!exactKeys(item, ["id", "claim", "expected", "actual", "passed", "base", "head", "evidence"])) {
      throw new Error(`control proof challenge ${index} has unsupported or missing fields`);
    }
    const id = plain(item.id, `control proof challenge ${index} id`, 80);
    if (!/^[A-Za-z0-9_.-]+$/.test(id) || ids.has(id)) throw new Error(`control proof challenge ${index} id is invalid or duplicated`);
    ids.add(id);
    const claim = plain(item.claim, `control proof challenge ${index} claim`, 400);
    const evidence = plain(item.evidence, `control proof challenge ${index} evidence`, 1000);
    if (!EXPECTED.has(item.expected as ControlProofExpected) || !ACTUAL.has(item.actual as ControlProofActual)) {
      throw new Error(`control proof challenge ${index} has an unsupported decision`);
    }
    if (typeof item.passed !== "boolean" || item.passed !== (item.expected === item.actual)) {
      throw new Error(`control proof challenge ${index} has inconsistent decision fields`);
    }
    const base = plain(item.base, `control proof challenge ${index} base`, 40);
    const head = plain(item.head, `control proof challenge ${index} head`, 40);
    if (!COMMIT.test(base) || !COMMIT.test(head)) throw new Error(`control proof challenge ${index} must use full lowercase commit SHAs`);
    return {
      id,
      claim,
      expected: item.expected as ControlProofExpected,
      actual: item.actual as ControlProofActual,
      passed: item.passed,
      base,
      head,
      evidence,
    };
  });
  if (!proof.summary || typeof proof.summary !== "object" || Array.isArray(proof.summary)
    || !exactKeys(proof.summary, ["passed", "total"])) throw new Error("control proof summary is invalid");
  const summary = proof.summary as Record<string, unknown>;
  const passed = count(summary.passed, "control proof summary.passed");
  const total = count(summary.total, "control proof summary.total");
  if (passed !== challenges.filter((item) => item.passed).length || total !== challenges.length) throw new Error("control proof summary does not match its challenges");
  if (proof.status !== (passed === total ? "PASS" : "HOLD")) throw new Error("control proof status does not match its challenges");
  const reproduction = plain(proof.reproduction, "control proof reproduction", 400);
  if (!Array.isArray(proof.limits) || proof.limits.length > 32) throw new Error("control proof limits must be an array with at most 32 entries");
  const limits = proof.limits.map((item, index) => plain(item, `control proof limit ${index}`, 600));
  const receiptHash = plain(proof.receiptHash, "control proof receiptHash", 71);
  if (!SHA256.test(receiptHash)) throw new Error("control proof receiptHash must be a lowercase SHA-256 identifier");
  const parsed: ControlProofReport = {
    schemaVersion: "agent-vigil-control-proof/v1",
    vigilVersion,
    status: proof.status,
    sourceCommit,
    generatedAt,
    receiptHash,
    challenges,
    summary: { passed, total },
    reproduction,
    limits,
  };
  const { receiptHash: _receiptHash, ...payload } = parsed;
  if (sha256(canonical(payload)) !== receiptHash) throw new Error("control proof content does not match receiptHash");
  return parsed;
}

export function loadControlProof(path: string): { proof: ControlProofReport; bytes: Buffer; fileSha256: string } {
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("control proof must be a regular file, not a symbolic link");
  if (metadata.size > 2 * 1024 * 1024) throw new Error("control proof exceeds the 2 MB attestation limit");
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== metadata.size) throw new Error("control proof changed while it was being opened");
    bytes = readFileSync(descriptor);
    if (bytes.length !== opened.size) throw new Error("control proof changed while it was being read");
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("control proof is not valid JSON"); }
  return { proof: validateControlProof(parsed), bytes, fileSha256: sha256(bytes) };
}

function challengeSetSha256(proof: ControlProofReport): string {
  return sha256(canonical(proof.challenges.map(({ id, expected, actual, passed }) => ({ id, expected, actual, passed }))));
}

export function buildControlProofPredicate(path: string): ControlProofPredicate {
  const { proof, fileSha256 } = loadControlProof(path);
  return {
    predicateVersion: "1",
    proof: {
      schemaVersion: "agent-vigil-control-proof/v1",
      receiptHash: proof.receiptHash,
      fileSha256,
      status: proof.status,
      sourceCommit: proof.sourceCommit,
      generatedAt: proof.generatedAt,
      vigilVersion: proof.vigilVersion,
      passed: proof.summary.passed,
      total: proof.summary.total,
      challengeSetSha256: challengeSetSha256(proof),
    },
    privacy: { claimsIncluded: false, evidenceIncluded: false, repositoryPathIncluded: false },
  };
}

export function writeControlProofPredicate(path: string, output: string): ControlProofPredicate {
  const predicate = buildControlProofPredicate(path);
  writePrivateFileAtomic(resolve(output), `${JSON.stringify(predicate, null, 2)}\n`);
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
    return (name === expectedName || name.endsWith(`/${expectedName}`)) && `sha256:${String(digest.sha256 ?? "")}` === expectedDigest;
  });
}

function predicateMatches(value: unknown, proof: ControlProofReport, fileSha256: string): value is ControlProofPredicate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ControlProofPredicate>;
  const body = candidate.proof;
  const privacy = candidate.privacy;
  return candidate.predicateVersion === "1"
    && exactKeys(candidate, ["predicateVersion", "privacy", "proof"])
    && Boolean(body) && exactKeys(body!, ["challengeSetSha256", "fileSha256", "generatedAt", "passed", "receiptHash", "schemaVersion", "sourceCommit", "status", "total", "vigilVersion"])
    && Boolean(privacy) && exactKeys(privacy!, ["claimsIncluded", "evidenceIncluded", "repositoryPathIncluded"])
    && body?.schemaVersion === "agent-vigil-control-proof/v1"
    && body.receiptHash === proof.receiptHash
    && body.fileSha256 === fileSha256
    && body.status === proof.status
    && body.sourceCommit === proof.sourceCommit
    && body.generatedAt === proof.generatedAt
    && body.vigilVersion === proof.vigilVersion
    && body.passed === proof.summary.passed
    && body.total === proof.summary.total
    && body.challengeSetSha256 === challengeSetSha256(proof)
    && privacy?.claimsIncluded === false
    && privacy.evidenceIncluded === false
    && privacy.repositoryPathIncluded === false;
}

export function verifyGhControlProofAttestationOutput(path: string, ghOutput: unknown): ControlProofAttestationVerification {
  const { proof, fileSha256 } = loadControlProof(path);
  const statements = statementsFromGh(ghOutput);
  let subjectDigestValid = false;
  let predicateValid = false;
  let matched: ControlProofPredicate | undefined;
  for (const statement of statements) {
    if (statement.predicateType !== CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE) continue;
    const subjectOk = subjectMatches(statement, basename(path), fileSha256);
    const predicateOk = predicateMatches(statement.predicate, proof, fileSha256);
    subjectDigestValid ||= subjectOk;
    predicateValid ||= predicateOk;
    if (subjectOk && predicateOk) matched = statement.predicate as ControlProofPredicate;
  }
  const { receiptHash: _receiptHash, ...payload } = proof;
  const proofHashValid = sha256(canonical(payload)) === proof.receiptHash;
  return {
    valid: proofHashValid && subjectDigestValid && predicateValid && Boolean(matched),
    proofHashValid,
    subjectDigestValid,
    predicateValid,
    statementCount: statements.length,
    ...(matched ? { predicate: matched } : {}),
  };
}

const runGitHubCli: GhAttestationExecutor = (args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function verifyGitHubControlProofAttestation(
  path: string,
  repository: string,
  trust: ControlProofAttestationTrust = {},
  executeGh: GhAttestationExecutor = runGitHubCli,
): ControlProofAttestationVerification {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("repository must be owner/name");
  const signerWorkflow = trust.signerWorkflow ?? `${repository}/.github/workflows/agent-vigil-control-proof.yml`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/i.test(signerWorkflow)) {
    throw new Error("signer workflow must be owner/name/.github/workflows/file.yml");
  }
  if (trust.signerDigest !== undefined && !COMMIT.test(trust.signerDigest)) throw new Error("signer digest must be a full lowercase commit SHA");
  const { proof } = loadControlProof(path);
  const command = [
    "attestation", "verify", resolve(path),
    "--repo", repository,
    "--predicate-type", CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE,
    "--signer-workflow", signerWorkflow,
    "--source-digest", proof.sourceCommit,
    ...(trust.signerDigest ? ["--signer-digest", trust.signerDigest] : []),
    "--format", "json",
    ...(!trust.allowSelfHosted ? ["--deny-self-hosted-runners"] : []),
  ];
  let raw: string;
  try { raw = executeGh(command); }
  catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: string | Buffer }).stderr ?? "").trim()
      : "";
    throw new Error(`GitHub control-proof attestation verification failed${detail ? `: ${detail}` : "; install and authenticate a current GitHub CLI"}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("GitHub CLI returned unreadable control-proof attestation JSON"); }
  return verifyGhControlProofAttestationOutput(path, parsed);
}
