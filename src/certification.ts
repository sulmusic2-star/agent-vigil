import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { canonical } from "./report.ts";
import { decideControlProof, type ControlProofChallenge, type ControlProofReport } from "./control-proof.ts";
import { readBoundedJson } from "./upgrade/contracts.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export const CERTIFICATE_SCHEMA = "agent-vigil-control-certificate/v1" as const;
export const CORPUS_ENTRY_SCHEMA = "agent-vigil-control-corpus-entry/v1" as const;
export const POLICY_SCHEMA = "agent-vigil-control-policy/v1" as const;
export const REPORT_SCHEMA = "agent-vigil-control-status/v1" as const;

export type ControlIdentity = {
  vendor: string;
  product: string;
  adapter: string;
  version: string;
};

export type ControlCertificate = {
  schemaVersion: typeof CERTIFICATE_SCHEMA;
  organization: string;
  repository: string;
  requiredCheck: string;
  control: ControlIdentity;
  proof: ControlProofReport;
  certificateHash: string;
};

export type CorpusEntry = {
  schemaVersion: typeof CORPUS_ENTRY_SCHEMA;
  sequence: number;
  previousEntryHash: string | null;
  certificate: ControlCertificate;
  entryHash: string;
};

export type CertificationPolicy = {
  schemaVersion: typeof POLICY_SCHEMA;
  policyId: string;
  organization: string;
  maxAgeHours: number;
  repositories: {
    repository: string;
    requiredCheck: string;
    allowedControls: string[];
    requiredChallenges: string[];
  }[];
};

export type ControlStatusReport = {
  schemaVersion: typeof REPORT_SCHEMA;
  policyId: string;
  organization: string;
  asOf: string;
  maxAgeHours: number;
  status: "PASS" | "HOLD";
  summary: { fresh: number; stale: number; missing: number; held: number; total: number };
  repositories: {
    repository: string;
    requiredCheck: string;
    state: "FRESH" | "STALE" | "MISSING" | "HOLD";
    reason: string;
    proofGeneratedAt?: string;
    ageHours?: number;
    certificateHash?: string;
    control?: string;
  }[];
  reportHash: string;
};

export const CONTROL_POLICY_PACKS = {
  baseline: ["clean-control", "skipped-test", "disposable-cleanup"],
  authority: [
    "clean-control",
    "unapproved-mcp-server",
    "candidate-self-approval",
    "unreadable-authority-config",
    "sandbox-weakening",
    "skipped-test",
    "disposable-cleanup",
  ],
} as const;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (canonical(actual) !== canonical(expected)) throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
}

function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} must be plain text between 1 and ${maximum} characters`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  return text(value, label, 160).replace(/^\s+|\s+$/g, "");
}

function repositoryName(value: unknown, label = "repository"): string {
  const parsed = identifier(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed)) throw new Error(`${label} must be owner/name`);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  }
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const parsed = text(value, label, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label} must be sha256:<64 lowercase hex characters>`);
  return parsed;
}

function commitSha(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!/^[a-f0-9]{40}$/.test(parsed)) throw new Error(`${label} must be a full lowercase Git commit SHA`);
  return parsed;
}

function challenge(value: unknown, index: number): Pick<ControlProofChallenge, "id" | "expected" | "actual" | "passed"> {
  const item = record(value, `proof.challenges[${index}]`);
  exactKeys(item, ["id", "expected", "actual", "passed"], `proof.challenges[${index}]`);
  const expected = item.expected;
  const actual = item.actual;
  if (!new Set(["PASS", "BLOCK", "HOLD"]).has(String(expected))) throw new Error(`proof.challenges[${index}].expected is invalid`);
  if (!new Set(["PASS", "BLOCK", "HOLD", "ERROR"]).has(String(actual))) throw new Error(`proof.challenges[${index}].actual is invalid`);
  if (typeof item.passed !== "boolean") throw new Error(`proof.challenges[${index}].passed must be boolean`);
  if (item.passed !== (actual === expected)) throw new Error(`proof.challenges[${index}] has inconsistent decision fields`);
  return {
    id: identifier(item.id, `proof.challenges[${index}].id`),
    expected: expected as ControlProofChallenge["expected"],
    actual: actual as ControlProofChallenge["actual"],
    passed: item.passed,
  };
}

export function verifyControlProof(input: unknown): ControlProofReport {
  const proof = record(input, "control proof");
  exactKeys(proof, ["schemaVersion", "vigilVersion", "status", "sourceCommit", "generatedAt", "receiptHash", "challenges", "summary", "reproduction", "limits"], "control proof");
  if (proof.schemaVersion !== "agent-vigil-control-proof/v1") throw new Error("only the verified Agent Vigil control-proof/v1 adapter is currently supported");
  const receiptHash = sha256(proof.receiptHash, "control proof receiptHash");
  const { receiptHash: _receiptHash, ...payload } = proof;
  if (digest(payload) !== receiptHash) throw new Error("control proof receipt hash is invalid");
  const generatedAt = timestamp(proof.generatedAt, "control proof generatedAt");
  const sourceCommit = commitSha(proof.sourceCommit, "control proof sourceCommit");
  const vigilVersion = identifier(proof.vigilVersion, "control proof vigilVersion");
  const reproduction = text(proof.reproduction, "control proof reproduction", 1000);
  if (!Array.isArray(proof.limits) || proof.limits.length > 100) throw new Error("control proof limits must be an array with at most 100 items");
  const limits = proof.limits.map((item, index) => text(item, `control proof limits[${index}]`, 1000));
  if (proof.status !== "PASS" && proof.status !== "HOLD") throw new Error("control proof status must be PASS or HOLD");
  if (!Array.isArray(proof.challenges) || proof.challenges.length === 0 || proof.challenges.length > 100) throw new Error("control proof challenges must contain 1 to 100 items");
  const ids = new Set<string>();
  const parsedChallenges: ControlProofChallenge[] = [];
  for (const [index, raw] of proof.challenges.entries()) {
    const full = record(raw, `control proof challenges[${index}]`);
    exactKeys(full, ["id", "claim", "expected", "actual", "passed", "base", "head", "evidence"], `control proof challenges[${index}]`);
    const parsed = challenge({ id: full.id, expected: full.expected, actual: full.actual, passed: full.passed }, index);
    if (ids.has(parsed.id)) throw new Error(`duplicate control proof challenge: ${parsed.id}`);
    if (parsed.passed !== (parsed.actual === parsed.expected)) throw new Error(`control proof challenge ${parsed.id} has inconsistent decision fields`);
    const enriched: ControlProofChallenge = {
      ...parsed,
      claim: text(full.claim, `control proof challenges[${index}].claim`, 500),
      base: commitSha(full.base, `control proof challenges[${index}].base`),
      head: commitSha(full.head, `control proof challenges[${index}].head`),
      evidence: text(full.evidence, `control proof challenges[${index}].evidence`, 1000),
    };
    ids.add(parsed.id);
    parsedChallenges.push(enriched);
  }
  const summary = record(proof.summary, "control proof summary");
  exactKeys(summary, ["passed", "total"], "control proof summary");
  const passed = parsedChallenges.filter((item) => item.passed).length;
  if (summary.passed !== passed || summary.total !== parsedChallenges.length) throw new Error("control proof summary does not match its challenges");
  if (proof.status !== decideControlProof(parsedChallenges)) throw new Error("control proof status does not match its challenge decisions");
  return {
    schemaVersion: "agent-vigil-control-proof/v1",
    vigilVersion,
    status: proof.status,
    sourceCommit,
    generatedAt,
    receiptHash,
    challenges: parsedChallenges,
    summary: { passed, total: parsedChallenges.length },
    reproduction,
    limits,
  } as ControlProofReport;
}

export function createCertificate(input: {
  proof: unknown;
  organization: string;
  repository: string;
  requiredCheck: string;
}): ControlCertificate {
  const proof = verifyControlProof(input.proof);
  const payload = {
    schemaVersion: CERTIFICATE_SCHEMA,
    organization: identifier(input.organization, "organization"),
    repository: repositoryName(input.repository),
    requiredCheck: identifier(input.requiredCheck, "requiredCheck"),
    control: {
      vendor: "sulmusic2-star",
      product: "agent-vigil",
      adapter: "agent-vigil/control-proof-v1",
      version: identifier(proof.vigilVersion, "control version"),
    },
    proof,
  };
  return { ...payload, certificateHash: digest(payload) };
}

export function validateCertificate(input: unknown): ControlCertificate {
  const root = record(input, "certificate");
  exactKeys(root, ["schemaVersion", "organization", "repository", "requiredCheck", "control", "proof", "certificateHash"], "certificate");
  if (root.schemaVersion !== CERTIFICATE_SCHEMA) throw new Error(`certificate schemaVersion must be ${CERTIFICATE_SCHEMA}`);
  const control = record(root.control, "certificate.control");
  exactKeys(control, ["vendor", "product", "adapter", "version"], "certificate.control");
  const proof = verifyControlProof(root.proof);
  if (control.adapter !== "agent-vigil/control-proof-v1") throw new Error("certificate adapter and proof schema are not supported");
  if (control.vendor !== "sulmusic2-star" || control.product !== "agent-vigil") throw new Error("certificate control identity does not match its verified adapter");
  const parsed = {
    schemaVersion: CERTIFICATE_SCHEMA,
    organization: identifier(root.organization, "certificate.organization"),
    repository: repositoryName(root.repository, "certificate.repository"),
    requiredCheck: identifier(root.requiredCheck, "certificate.requiredCheck"),
    control: {
      vendor: identifier(control.vendor, "certificate.control.vendor"),
      product: identifier(control.product, "certificate.control.product"),
      adapter: identifier(control.adapter, "certificate.control.adapter"),
      version: identifier(control.version, "certificate.control.version"),
    },
    proof,
  };
  if (parsed.control.version !== proof.vigilVersion) throw new Error("certificate control version does not match its proof");
  const certificateHash = sha256(root.certificateHash, "certificate.certificateHash");
  if (digest(parsed) !== certificateHash) throw new Error("certificate hash is invalid");
  return { ...parsed, certificateHash };
}

export function parseCorpus(content: string): CorpusEntry[] {
  if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("certification corpus exceeds 64 MiB");
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const entries: CorpusEntry[] = [];
  let previous: string | null = null;
  const certificates = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error(`corpus line ${index + 1} exceeds 2 MiB`);
    const root = record(JSON.parse(line), `corpus line ${index + 1}`);
    exactKeys(root, ["schemaVersion", "sequence", "previousEntryHash", "certificate", "entryHash"], `corpus line ${index + 1}`);
    if (root.schemaVersion !== CORPUS_ENTRY_SCHEMA || root.sequence !== index + 1 || root.previousEntryHash !== previous) throw new Error(`corpus chain is invalid at line ${index + 1}`);
    const certificate = validateCertificate(root.certificate);
    if (certificates.has(certificate.certificateHash)) throw new Error(`duplicate certificate at corpus line ${index + 1}`);
    const payload = { schemaVersion: CORPUS_ENTRY_SCHEMA, sequence: index + 1, previousEntryHash: previous, certificate };
    const entryHash = sha256(root.entryHash, `corpus line ${index + 1} entryHash`);
    if (digest(payload) !== entryHash) throw new Error(`corpus entry hash is invalid at line ${index + 1}`);
    entries.push({ ...payload, entryHash });
    certificates.add(certificate.certificateHash);
    previous = entryHash;
  }
  return entries;
}

export function appendCorpusEntry(content: string, certificateInput: unknown): { entry: CorpusEntry; line: string } {
  const entries = parseCorpus(content);
  const certificate = validateCertificate(certificateInput);
  if (entries.some((item) => item.certificate.certificateHash === certificate.certificateHash)) throw new Error("certificate already exists in corpus");
  const payload = {
    schemaVersion: CORPUS_ENTRY_SCHEMA,
    sequence: entries.length + 1,
    previousEntryHash: entries.at(-1)?.entryHash ?? null,
    certificate,
  };
  const entry = { ...payload, entryHash: digest(payload) };
  return { entry, line: `${JSON.stringify(entry)}\n` };
}

export function loadCorpus(path: string): CorpusEntry[] {
  if (!existsSync(path)) return [];
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("certification corpus must be a regular non-symbolic-link file");
  if (status.size > 64 * 1024 * 1024) throw new Error("certification corpus exceeds 64 MiB");
  return parseCorpus(readFileSync(path, "utf8"));
}

export function validatePolicy(input: unknown): CertificationPolicy {
  const root = record(input, "certification policy");
  exactKeys(root, ["schemaVersion", "policyId", "organization", "maxAgeHours", "repositories"], "certification policy");
  if (root.schemaVersion !== POLICY_SCHEMA) throw new Error(`certification policy schemaVersion must be ${POLICY_SCHEMA}`);
  if (!Number.isInteger(root.maxAgeHours) || Number(root.maxAgeHours) < 1 || Number(root.maxAgeHours) > 8760) throw new Error("maxAgeHours must be an integer from 1 to 8760");
  if (!Array.isArray(root.repositories) || root.repositories.length === 0 || root.repositories.length > 10000) throw new Error("repositories must contain 1 to 10000 entries");
  const seen = new Set<string>();
  const repositories = root.repositories.map((value, index) => {
    const item = record(value, `repositories[${index}]`);
    exactKeys(item, ["repository", "requiredCheck", "allowedControls", "requiredChallenges"], `repositories[${index}]`);
    const repository = repositoryName(item.repository, `repositories[${index}].repository`);
    const requiredCheck = identifier(item.requiredCheck, `repositories[${index}].requiredCheck`);
    if (seen.has(repository)) throw new Error(`duplicate policy repository: ${repository}`);
    seen.add(repository);
    if (!Array.isArray(item.allowedControls) || item.allowedControls.length === 0) throw new Error(`repositories[${index}].allowedControls must not be empty`);
    if (!Array.isArray(item.requiredChallenges) || item.requiredChallenges.length === 0) throw new Error(`repositories[${index}].requiredChallenges must not be empty`);
    return {
      repository,
      requiredCheck,
      allowedControls: [...new Set(item.allowedControls.map((value) => identifier(value, `repositories[${index}].allowedControls`)))],
      requiredChallenges: [...new Set(item.requiredChallenges.map((value) => identifier(value, `repositories[${index}].requiredChallenges`)))],
    };
  });
  return {
    schemaVersion: POLICY_SCHEMA,
    policyId: identifier(root.policyId, "policyId"),
    organization: identifier(root.organization, "organization"),
    maxAgeHours: Number(root.maxAgeHours),
    repositories,
  };
}

export function loadPolicy(path: string): CertificationPolicy {
  return validatePolicy(readBoundedJson(path, 2 * 1024 * 1024, "certification policy"));
}

export function createSingleRepositoryPolicy(input: {
  organization: string;
  repository: string;
  requiredCheck: string;
  pack: keyof typeof CONTROL_POLICY_PACKS;
  maxAgeHours?: number;
}): CertificationPolicy {
  return validatePolicy({
    schemaVersion: POLICY_SCHEMA,
    policyId: `${input.pack}-weekly-v1`,
    organization: input.organization,
    maxAgeHours: input.maxAgeHours ?? 168,
    repositories: [{
      repository: input.repository,
      requiredCheck: input.requiredCheck,
      allowedControls: ["sulmusic2-star/agent-vigil"],
      requiredChallenges: [...CONTROL_POLICY_PACKS[input.pack]],
    }],
  });
}

export function buildStatusReport(policyInput: unknown, entries: CorpusEntry[], asOfInput: string): ControlStatusReport {
  const policy = validatePolicy(policyInput);
  const asOf = timestamp(asOfInput, "asOf");
  const asOfMs = Date.parse(asOf);
  const repositories = policy.repositories.map((requirement) => {
    const matches = entries
      .map((entry) => entry.certificate)
      .filter((certificate) => certificate.organization === policy.organization && certificate.repository === requirement.repository && certificate.requiredCheck === requirement.requiredCheck)
      .sort((left, right) => Date.parse(right.proof.generatedAt) - Date.parse(left.proof.generatedAt));
    const latest = matches[0];
    if (!latest) return { repository: requirement.repository, requiredCheck: requirement.requiredCheck, state: "MISSING" as const, reason: "no matching control certificate is present" };
    const control = `${latest.control.vendor}/${latest.control.product}`;
    const common = { repository: requirement.repository, requiredCheck: requirement.requiredCheck, proofGeneratedAt: latest.proof.generatedAt, certificateHash: latest.certificateHash, control };
    if (!requirement.allowedControls.includes(control)) return { ...common, state: "HOLD" as const, reason: `control ${control} is not allowed by policy` };
    const ageHours = (asOfMs - Date.parse(latest.proof.generatedAt)) / 3_600_000;
    if (ageHours < 0) return { ...common, ageHours, state: "HOLD" as const, reason: "latest proof is dated after the report time" };
    if (latest.proof.status !== "PASS") return { ...common, ageHours, state: "HOLD" as const, reason: "latest control proof did not pass" };
    const challengeMap = new Map(latest.proof.challenges.map((item) => [item.id, item]));
    const missing = requirement.requiredChallenges.filter((id) => !challengeMap.get(id)?.passed);
    if (missing.length) return { ...common, ageHours, state: "HOLD" as const, reason: `required challenge evidence is absent or unexpected: ${missing.join(", ")}` };
    if (ageHours > policy.maxAgeHours) return { ...common, ageHours, state: "STALE" as const, reason: `latest passing proof is ${ageHours.toFixed(1)} hours old; policy allows ${policy.maxAgeHours}` };
    return { ...common, ageHours, state: "FRESH" as const, reason: `required control passed ${requirement.requiredChallenges.length} challenge(s) within ${policy.maxAgeHours} hours` };
  });
  const summary = {
    fresh: repositories.filter((item) => item.state === "FRESH").length,
    stale: repositories.filter((item) => item.state === "STALE").length,
    missing: repositories.filter((item) => item.state === "MISSING").length,
    held: repositories.filter((item) => item.state === "HOLD").length,
    total: repositories.length,
  };
  const payload = { schemaVersion: REPORT_SCHEMA, policyId: policy.policyId, organization: policy.organization, asOf, maxAgeHours: policy.maxAgeHours, status: summary.fresh === summary.total ? "PASS" as const : "HOLD" as const, summary, repositories };
  return { ...payload, reportHash: digest(payload) };
}

export function renderStatusReport(report: ControlStatusReport): string {
  const lines = [
    `Agent Vigil control status: ${report.status}`,
    `${report.summary.fresh}/${report.summary.total} required repositories have fresh proof as of ${report.asOf}`,
    "",
  ];
  for (const repository of report.repositories) lines.push(terminalSafe(`${repository.state.padEnd(7)} ${repository.repository} — ${repository.reason}`));
  lines.push("", `${report.status} · ${report.reportHash}`);
  return lines.join("\n");
}
