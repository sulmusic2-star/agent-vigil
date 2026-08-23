import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import { canonical } from "../report.ts";
import {
  compareCanaryAggregates,
  decideUpgrade,
  artifactInventoryFromFileCommitments,
  inspectArtifactTree,
  targetSnapshotFromManifestBytes,
  type ArtifactFileCommitment,
  type ArtifactInventory,
  type CanaryAggregate,
  type CanaryComparison,
  type TargetSnapshot,
} from "./decision.ts";
import {
  loadUpgradeConfig,
  trustedDirectoryInside,
  trustedRegularFileInside,
  type UpgradeConfig,
} from "./contracts.ts";
import {
  ApmMaterializationHold,
  createUpdatePlan,
  recomputeUpdatePlanHash,
  selectApmMaterialization,
  type ApmMaterializationEndpoint,
  type ApmMaterializationSelection,
  type UpdatePlan,
} from "./manager-plan.ts";
import { isCrossPlatformSafeSegment } from "./portable-path.ts";
import {
  recomputeUpgradeReceiptHash,
  renderUpgradeReceipt,
  runUpgradeEvaluation,
  type UpgradePrivateReceipt,
} from "./receipt.ts";
import { commandDigest, type ContainmentProbe } from "./sandbox.ts";

export const APM_PREFLIGHT_SCHEMA = "agent-vigil-apm-preflight/v1" as const;

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = 272 * 1024 * 1024;
const MAX_FILES = 4_096;
const MAX_DIRECTORIES = 4_096;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_APM_MANIFEST_EVIDENCE_BYTES = 64 * 1024;
const MAX_PREFLIGHT_RECEIPT_BYTES = 4 * 1024 * 1024;
const SESSION_PREFIX = "agent-vigil-apm-";

type ManifestEvidence = {
  path: string;
  contentBase64: string;
};

type MaterializedProof = {
  routeSha256: string;
  rowSha256: string;
  commit: string;
  expectedTreeSha256: string;
  fetchedSha256: string;
  fetchedBytes: number;
  materializedTreeSha256: string;
  fileCount: number;
  totalBytes: number;
  files: ArtifactFileCommitment[];
  manifestEvidence: ManifestEvidence;
  selectedArtifact: ArtifactInventory;
};

export type ApmAutomaticPreflightReceipt = {
  schemaVersion: typeof APM_PREFLIGHT_SCHEMA;
  generatedAt: string;
  nonce: string;
  plan: UpdatePlan;
  selection?: {
    identity: string;
    selectedChangeSha256: string;
    currentRowSha256: string;
    candidateRowSha256: string;
  };
  materialization?: {
    current?: MaterializedProof;
    candidate?: MaterializedProof;
  };
  upgradeReceipt?: UpgradePrivateReceipt;
  restoration: {
    status: "RESTORED" | "HOLD";
    hostMutation: "NONE";
    sessionRemoved: boolean;
    reasonCode: string;
  };
  summary: {
    verdict: "SAFE" | "CHANGED" | "HOLD";
    reasonCodes: string[];
  };
  limitations: string[];
  receiptHash: string;
};

export type ArchiveFetcher = (url: string, destination: string) => void;

export type ApmAutomaticPreflightInput = {
  repository: string;
  currentLockPath: string;
  candidateLockPath: string;
  configPath: string;
  identity?: string;
  suppliedPlan?: unknown;
  dockerBin?: string;
  fetchBin?: string;
  workDirectory?: string;
  generatedAt?: string;
  nonce?: string;
};

type ApmAutomaticDependencies = {
  fetchArchive?: ArchiveFetcher;
  evaluate?: typeof runUpgradeEvaluation;
  removeSession?: (path: string) => boolean;
};

type TarFile = { path: string; bytes: Buffer; executable: boolean };
type ParsedArchive = {
  files: TarFile[];
  directories: string[];
  paxCommit?: string;
  treeSha256: string;
  fileCount: number;
  totalBytes: number;
};

const LIMITATIONS = [
  "This receipt is eligible only when the bound update plan contains exactly one total change: the selected exact APM package pair.",
  "Automatic acquisition supports only credential-free public github.com git rows pinned by both a lowercase 40-character commit and APM tree_sha256.",
  "Archives containing links, special files, unsupported extension records, unsafe names, or entries beyond the documented bounds return HOLD.",
  "The configured manifest must be at most 64 KiB so its exact lock-bound bytes fit inside the 4 MiB independently verifiable receipt.",
  "Exact manifest bytes remain private wrapper evidence and are not copied into the privacy-minimized public compatibility entry.",
  "No APM installer, package lifecycle script, repository hook, or host update is executed; only temporary exact artifacts are mounted read-only into the existing contained check.",
];

class PreflightHold extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}

function hash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function finalizeReceipt(receipt: Omit<ApmAutomaticPreflightReceipt, "receiptHash">): ApmAutomaticPreflightReceipt {
  const finalized = { ...receipt, receiptHash: hash(canonical(receipt)) };
  if (Buffer.byteLength(`${JSON.stringify(finalized, null, 2)}\n`, "utf8") <= MAX_PREFLIGHT_RECEIPT_BYTES) {
    return finalized;
  }
  const boundedHold = {
    schemaVersion: receipt.schemaVersion,
    generatedAt: receipt.generatedAt,
    nonce: receipt.nonce,
    plan: receipt.plan,
    restoration: receipt.restoration,
    summary: { verdict: "HOLD" as const, reasonCodes: ["RECEIPT_SIZE_EXCEEDED"] },
    limitations: receipt.limitations,
  };
  const result = { ...boundedHold, receiptHash: hash(canonical(boundedHold)) };
  if (Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, "utf8") > MAX_PREFLIGHT_RECEIPT_BYTES) {
    throw new Error("automatic APM preflight plan cannot fit inside the 4 MiB receipt bound");
  }
  return result;
}

export function recomputeApmPreflightReceiptHash(receipt: ApmAutomaticPreflightReceipt): string {
  const { receiptHash: _ignored, ...payload } = receipt;
  return hash(canonical(payload));
}

function receiptObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function receiptExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length || required.some((key) => !(key in value))) throw new Error(`${label} has an invalid shape`);
}

function receiptSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function receiptText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function receiptInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function portableManifestPath(path: string): string {
  return path.split(sep).join("/");
}

function exactManifestEvidenceBytes(value: unknown, label: string): Buffer {
  const maximumEncodedLength = Math.ceil(MAX_APM_MANIFEST_EVIDENCE_BYTES / 3) * 4;
  if (typeof value !== "string" || value.length < 4 || value.length > maximumEncodedLength
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical bounded base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > MAX_APM_MANIFEST_EVIDENCE_BYTES || bytes.toString("base64") !== value) {
    throw new Error(`${label} is not canonical bounded base64`);
  }
  return bytes;
}

function validateManifestEvidence(
  input: unknown,
  files: readonly ArtifactFileCommitment[],
  label: string,
): ManifestEvidence & { content: Buffer } {
  const value = receiptObject(input, label);
  receiptExactKeys(value, ["path", "contentBase64"], ["path", "contentBase64"], label);
  const path = receiptText(value.path, `${label} path`, 256);
  const parts = path.split("/");
  if (path.startsWith("/") || parts.some((part) => !isCrossPlatformSafeSegment(part))) {
    throw new Error(`${label} path is invalid`);
  }
  const contentBase64 = receiptText(
    value.contentBase64,
    `${label} content`,
    Math.ceil(MAX_APM_MANIFEST_EVIDENCE_BYTES / 3) * 4,
  );
  const content = exactManifestEvidenceBytes(contentBase64, `${label} content`);
  const commitment = files.find((file) => file.path === path);
  if (!commitment || commitment.bytes !== content.length || commitment.sha256 !== hash(content)) {
    throw new Error(`${label} does not match the exact selected-tree file commitment`);
  }
  return { path, contentBase64, content };
}

function validateArtifactInventory(input: unknown, label: string): ArtifactInventory {
  const value = receiptObject(input, label);
  receiptExactKeys(value, ["treeSha256", "fileCount", "totalBytes"],
    ["treeSha256", "fileCount", "totalBytes"], label);
  return {
    treeSha256: receiptSha256(value.treeSha256, `${label} tree hash`),
    fileCount: receiptInteger(value.fileCount, `${label} file count`, 0, MAX_FILES),
    totalBytes: receiptInteger(value.totalBytes, `${label} total bytes`, 0, MAX_TOTAL_BYTES),
  };
}

function validateTargetSnapshot(input: unknown, label: string): TargetSnapshot {
  const value = receiptObject(input, label);
  receiptExactKeys(value, [
    "ecosystem", "name", "version", "treeSha256", "manifestSha256", "fileCount", "totalBytes", "capabilities",
  ], [
    "ecosystem", "name", "version", "treeSha256", "manifestSha256", "fileCount", "totalBytes", "capabilities",
  ], label);
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 32) {
    throw new Error(`${label} capabilities are invalid`);
  }
  const capabilities = value.capabilities.map((inputCapability, index) => {
    const capability = receiptObject(inputCapability, `${label} capability ${index}`);
    receiptExactKeys(capability, ["field", "count", "sha256"], ["field", "count", "sha256"], `${label} capability ${index}`);
    return {
      field: receiptText(capability.field, `${label} capability field`, 128),
      count: receiptInteger(capability.count, `${label} capability count`, 0, 100_000),
      sha256: receiptSha256(capability.sha256, `${label} capability hash`),
    };
  });
  if (new Set(capabilities.map((capability) => capability.field)).size !== capabilities.length) {
    throw new Error(`${label} capability fields are invalid`);
  }
  return {
    ecosystem: receiptText(value.ecosystem, `${label} ecosystem`, 80),
    name: receiptText(value.name, `${label} name`, 160),
    version: receiptText(value.version, `${label} version`, 128),
    treeSha256: receiptSha256(value.treeSha256, `${label} tree hash`),
    manifestSha256: receiptSha256(value.manifestSha256, `${label} manifest hash`),
    fileCount: receiptInteger(value.fileCount, `${label} file count`, 0, MAX_FILES),
    totalBytes: receiptInteger(value.totalBytes, `${label} total bytes`, 0, MAX_TOTAL_BYTES),
    capabilities,
  };
}

function validateCanaryAggregate(
  input: unknown,
  label: string,
  expectedTrials: number,
  requiredComparableSide: "current" | "candidate",
): CanaryAggregate {
  const value = receiptObject(input, label);
  receiptExactKeys(value, ["state", "observationSha256", "observationCount", "trials", "stable", "reason"],
    ["state", "observationSha256", "observationCount", "trials", "stable", "reason"], label);
  if ((requiredComparableSide === "current" && value.state !== "PASS")
    || (requiredComparableSide === "candidate" && value.state !== "PASS" && value.state !== "FAIL")
    || value.stable !== true) {
    throw new Error(`${label} is not stable comparable evidence`);
  }
  return {
    state: value.state as "PASS" | "FAIL",
    observationSha256: receiptSha256(value.observationSha256, `${label} observation hash`),
    observationCount: receiptInteger(value.observationCount, `${label} observation count`, 1, 64),
    trials: receiptInteger(value.trials, `${label} trials`, expectedTrials, expectedTrials),
    stable: true,
    reason: receiptText(value.reason, `${label} reason`, 1_024),
  };
}

type TrustedNestedContext = {
  repository: string;
  configPath: string;
};

type TrustedUpgradeInputs = { config: UpgradeConfig; canaryHarness: ArtifactInventory };

function trustedUpgradeConfig(context: TrustedNestedContext): TrustedUpgradeInputs {
  const configFile = trustedRegularFileInside(context.repository, context.configPath, "upgrade config");
  const config = loadUpgradeConfig(configFile);
  const canaryDirectory = trustedDirectoryInside(
    context.repository,
    resolve(context.repository, config.canaryDirectory),
    "canary directory",
  );
  return { config, canaryHarness: inspectArtifactTree(canaryDirectory) };
}

function validateManifestTargetBinding(
  proof: MaterializedProof,
  nestedTarget: TargetSnapshot,
  trusted: TrustedUpgradeInputs,
  label: "current" | "candidate",
): void {
  const evidence = validateManifestEvidence(proof.manifestEvidence, proof.files, `${label} manifest evidence`);
  if (evidence.path !== portableManifestPath(trusted.config.component.manifestPath)) {
    throw new Error(`${label} manifest evidence does not match the trusted manifest path`);
  }
  const artifact = validateArtifactInventory(proof.selectedArtifact, `${label} selected artifact`);
  const independentlyDerived = targetSnapshotFromManifestBytes(
    evidence.content,
    trusted.config.component,
    artifact,
  );
  if (canonical(independentlyDerived) !== canonical(nestedTarget)) {
    throw new Error(`${label} nested target is not derived from the exact selected-tree manifest evidence`);
  }
}

function validateManifestTargetBindings(
  materialization: { current?: MaterializedProof; candidate?: MaterializedProof },
  nested: UpgradePrivateReceipt,
  trusted: TrustedUpgradeInputs,
): void {
  if (!materialization.current || !materialization.candidate || !nested.current || !nested.candidate) {
    throw new Error("automatic preflight manifest target evidence is incomplete");
  }
  validateManifestTargetBinding(materialization.current, nested.current, trusted, "current");
  validateManifestTargetBinding(materialization.candidate, nested.candidate, trusted, "candidate");
}

function validateNestedNonHoldReceipt(
  input: unknown,
  expectedVerdict: "SAFE" | "CHANGED",
  trustedContext?: TrustedNestedContext,
): UpgradePrivateReceipt {
  const root = receiptObject(input, "automatic preflight nested receipt");
  receiptExactKeys(root, [
    "schemaVersion", "vigilVersion", "generatedAt", "nonce", "component", "configSha256", "runner",
    "containment", "current", "candidate", "canaryHarness", "capabilities", "canaries", "summary",
    "limitations", "receiptHash",
  ], [
    "schemaVersion", "vigilVersion", "generatedAt", "nonce", "component", "configSha256", "runner",
    "containment", "current", "candidate", "canaryHarness", "capabilities", "canaries", "summary",
    "limitations", "receiptHash",
  ], "automatic preflight nested receipt");
  if (root.schemaVersion !== "agent-vigil-upgrade-receipt/v1") throw new Error("nested receipt schema is invalid");
  receiptText(root.vigilVersion, "nested receipt version", 40);
  receiptText(root.generatedAt, "nested receipt timestamp", 64);
  if (receiptText(root.nonce, "nested receipt nonce", 128).length < 16) throw new Error("nested receipt nonce is invalid");
  receiptSha256(root.configSha256, "nested receipt config hash");

  const component = receiptObject(root.component, "nested receipt component");
  receiptExactKeys(component, ["ecosystem", "name"], ["ecosystem", "name"], "nested receipt component");
  receiptText(component.ecosystem, "nested receipt component ecosystem", 80);
  receiptText(component.name, "nested receipt component name", 160);

  const runner = receiptObject(root.runner, "nested receipt runner");
  receiptExactKeys(runner, ["engine", "image", "trials", "network", "filesystem", "environment"],
    ["engine", "image", "trials", "network", "filesystem", "environment"], "nested receipt runner");
  if (runner.engine !== "docker" || runner.network !== "none" || runner.filesystem !== "read-only"
    || runner.environment !== "explicit" || typeof runner.image !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._/:~-]{0,246}@sha256:[0-9a-f]{64}$/.test(runner.image)) {
    throw new Error("nested receipt runner is invalid");
  }
  const trials = receiptInteger(runner.trials, "nested receipt runner trials", 2, 5);

  const containment = receiptObject(root.containment, "nested receipt containment");
  receiptExactKeys(containment, [
    "status", "localEndpoint", "imagePresent", "networkBlocked", "targetReadOnly", "rootReadOnly",
    "inheritedSecretAbsent", "proxiesCleared", "reason",
  ], [
    "status", "localEndpoint", "imagePresent", "networkBlocked", "targetReadOnly", "rootReadOnly",
    "inheritedSecretAbsent", "proxiesCleared", "reason",
  ], "nested receipt containment");
  for (const field of [
    "localEndpoint", "imagePresent", "networkBlocked", "targetReadOnly", "rootReadOnly",
    "inheritedSecretAbsent", "proxiesCleared",
  ] as const) {
    if (containment[field] !== true) throw new Error("nested receipt containment controls are incomplete");
  }
  if (containment.status !== "PASS") throw new Error("nested receipt containment did not pass");
  receiptText(containment.reason, "nested receipt containment reason", 1_024);

  const current = validateTargetSnapshot(root.current, "nested receipt current target");
  const candidate = validateTargetSnapshot(root.candidate, "nested receipt candidate target");
  const canaryHarness = validateArtifactInventory(root.canaryHarness, "nested receipt canary harness");

  if (!Array.isArray(root.capabilities) || root.capabilities.length > 32) {
    throw new Error("nested receipt capability changes are invalid");
  }
  const capabilities = root.capabilities.map((inputCapability, index) => {
    const capability = receiptObject(inputCapability, `nested receipt capability change ${index}`);
    receiptExactKeys(capability, ["field", "currentCount", "candidateCount", "changed"],
      ["field", "currentCount", "candidateCount", "changed"], `nested receipt capability change ${index}`);
    if (typeof capability.changed !== "boolean") throw new Error("nested receipt capability change is invalid");
    return {
      field: receiptText(capability.field, "nested receipt capability field", 128),
      currentCount: receiptInteger(capability.currentCount, "nested receipt current capability count", 0, 100_000),
      candidateCount: receiptInteger(capability.candidateCount, "nested receipt candidate capability count", 0, 100_000),
      changed: capability.changed,
    };
  });

  if (!Array.isArray(root.canaries) || root.canaries.length < 1 || root.canaries.length > 32) {
    throw new Error("nested receipt canaries are invalid");
  }
  const canaries = root.canaries.map((inputCanary, index): CanaryComparison => {
    const canary = receiptObject(inputCanary, `nested receipt canary ${index}`);
    receiptExactKeys(canary, [
      "id", "publicId", "idSha256", "commandSha256", "current", "candidate", "changed", "comparable",
    ], [
      "id", "idSha256", "commandSha256", "current", "candidate", "changed", "comparable",
    ], `nested receipt canary ${index}`);
    const id = receiptText(canary.id, `nested receipt canary ${index} id`, 80);
    const publicId = canary.publicId === undefined
      ? undefined
      : receiptText(canary.publicId, `nested receipt canary ${index} public id`, 80);
    const commandSha256 = receiptSha256(canary.commandSha256, `nested receipt canary ${index} command hash`);
    if (receiptSha256(canary.idSha256, `nested receipt canary ${index} id hash`) !== hash(id)) {
      throw new Error("nested receipt canary identity hash is invalid");
    }
    const currentAggregate = validateCanaryAggregate(canary.current, `nested receipt canary ${index} current`, trials, "current");
    const candidateAggregate = validateCanaryAggregate(canary.candidate, `nested receipt canary ${index} candidate`, trials, "candidate");
    const derived = compareCanaryAggregates({ id, ...(publicId ? { publicId } : {}) }, commandSha256, currentAggregate, candidateAggregate);
    if (canary.changed !== derived.changed || canary.comparable !== derived.comparable) {
      throw new Error("nested receipt canary comparison is not derived from its evidence");
    }
    return derived;
  });
  if (new Set(canaries.map((canary) => canary.id)).size !== canaries.length) {
    throw new Error("nested receipt canary identities are invalid");
  }
  const publicIds = canaries.flatMap((canary) => canary.publicId ? [canary.publicId] : []);
  if (new Set(publicIds).size !== publicIds.length) throw new Error("nested receipt public canary identities are invalid");

  const summary = receiptObject(root.summary, "nested receipt summary");
  receiptExactKeys(summary, ["verdict", "reasons", "comparedCanaries", "changedCanaries", "changedCapabilities"],
    ["verdict", "reasons", "comparedCanaries", "changedCanaries", "changedCapabilities"], "nested receipt summary");
  if (summary.verdict !== expectedVerdict || !Array.isArray(summary.reasons)
    || summary.reasons.length < 1 || summary.reasons.length > 16) {
    throw new Error("nested receipt summary is invalid");
  }
  summary.reasons.forEach((reason, index) => receiptText(reason, `nested receipt reason ${index}`, 1_024));
  receiptInteger(summary.comparedCanaries, "nested receipt compared canaries", 0, 32);
  receiptInteger(summary.changedCanaries, "nested receipt changed canaries", 0, 32);
  receiptInteger(summary.changedCapabilities, "nested receipt changed capabilities", 0, 32);
  if (!Array.isArray(root.limitations) || root.limitations.length < 1 || root.limitations.length > 16) {
    throw new Error("nested receipt limitations are invalid");
  }
  root.limitations.forEach((limitation, index) => receiptText(limitation, `nested receipt limitation ${index}`, 1_024));
  receiptSha256(root.receiptHash, "nested receipt hash");

  const nested = root as unknown as UpgradePrivateReceipt;
  if (recomputeUpgradeReceiptHash(nested) !== nested.receiptHash) throw new Error("nested receipt hash is invalid");
  const derivedDecision = decideUpgrade(containment as unknown as ContainmentProbe, current, candidate, canaries);
  if (derivedDecision.verdict !== expectedVerdict
    || canonical(derivedDecision.capabilities) !== canonical(capabilities)
    || canonical(derivedDecision.reasons) !== canonical(summary.reasons)
    || summary.comparedCanaries !== canaries.filter((canary) => canary.comparable).length
    || summary.changedCanaries !== canaries.filter((canary) => canary.changed).length
    || summary.changedCapabilities !== capabilities.filter((capability) => capability.changed).length) {
    throw new Error("nested receipt decision is invalid");
  }

  if (trustedContext) {
    const trusted = trustedUpgradeConfig(trustedContext);
    if (root.configSha256 !== hash(canonical(trusted.config))
      || component.ecosystem !== trusted.config.component.ecosystem
      || component.name !== trusted.config.component.name
      || current.ecosystem !== trusted.config.component.ecosystem
      || candidate.ecosystem !== trusted.config.component.ecosystem
      || current.name !== trusted.config.component.name
      || candidate.name !== trusted.config.component.name
      || runner.image !== trusted.config.runner.image
      || runner.trials !== trusted.config.runner.trials
      || canonical(canaryHarness) !== canonical(trusted.canaryHarness)
      || canonical(current.capabilities.map((item) => item.field)) !== canonical(trusted.config.component.capabilityFields)
      || canonical(candidate.capabilities.map((item) => item.field)) !== canonical(trusted.config.component.capabilityFields)
      || canaries.length !== trusted.config.canaries.length) {
      throw new Error("nested receipt does not match the trusted upgrade configuration or canary harness");
    }
    for (let index = 0; index < canaries.length; index += 1) {
      const expected = trusted.config.canaries[index];
      const actual = canaries[index];
      if (actual.id !== expected.id || actual.publicId !== expected.publicId
        || actual.commandSha256 !== commandDigest(expected)) {
        throw new Error("nested receipt canary does not match the trusted upgrade configuration");
      }
    }
  }
  return nested;
}

export function validateApmAutomaticPreflightReceipt(input: unknown): ApmAutomaticPreflightReceipt {
  let serialized: string;
  try { serialized = JSON.stringify(input); }
  catch { throw new Error("automatic preflight receipt is not serializable JSON evidence"); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PREFLIGHT_RECEIPT_BYTES) {
    throw new Error("automatic preflight receipt exceeds the 4 MiB evidence bound");
  }
  const root = receiptObject(input, "automatic preflight receipt");
  receiptExactKeys(root, [
    "schemaVersion", "generatedAt", "nonce", "plan", "selection", "materialization",
    "upgradeReceipt", "restoration", "summary", "limitations", "receiptHash",
  ], ["schemaVersion", "generatedAt", "nonce", "plan", "restoration", "summary", "limitations", "receiptHash"],
  "automatic preflight receipt");
  if (root.schemaVersion !== APM_PREFLIGHT_SCHEMA) throw new Error("automatic preflight schema is invalid");
  if (typeof root.generatedAt !== "string" || typeof root.nonce !== "string") throw new Error("automatic preflight identity is invalid");
  const plan = receiptObject(root.plan, "automatic preflight plan") as unknown as UpdatePlan;
  receiptSha256(plan.planHash, "automatic preflight plan hash");
  if (recomputeUpdatePlanHash(plan) !== plan.planHash || plan.generatedAt !== root.generatedAt) {
    throw new Error("automatic preflight plan binding is invalid");
  }
  const restoration = receiptObject(root.restoration, "automatic preflight restoration");
  receiptExactKeys(restoration, ["status", "hostMutation", "sessionRemoved", "reasonCode"],
    ["status", "hostMutation", "sessionRemoved", "reasonCode"], "automatic preflight restoration");
  if ((restoration.status !== "RESTORED" && restoration.status !== "HOLD")
    || restoration.hostMutation !== "NONE" || typeof restoration.sessionRemoved !== "boolean"
    || typeof restoration.reasonCode !== "string"
    || (restoration.status === "RESTORED") !== restoration.sessionRemoved) {
    throw new Error("automatic preflight restoration binding is invalid");
  }
  const summary = receiptObject(root.summary, "automatic preflight summary");
  receiptExactKeys(summary, ["verdict", "reasonCodes"], ["verdict", "reasonCodes"], "automatic preflight summary");
  const verdict = summary.verdict;
  if (verdict !== "SAFE" && verdict !== "CHANGED" && verdict !== "HOLD") throw new Error("automatic preflight verdict is invalid");
  if (!Array.isArray(summary.reasonCodes) || !summary.reasonCodes.length
    || summary.reasonCodes.some((reason) => typeof reason !== "string" || !reason.length)) {
    throw new Error("automatic preflight reason codes are invalid");
  }
  if (verdict !== "HOLD") {
    const expectedReason = verdict === "SAFE" ? "NO_MATERIAL_CHANGE" : "MATERIAL_CHANGE_DETECTED";
    if (summary.reasonCodes.length !== 1 || summary.reasonCodes[0] !== expectedReason) {
      throw new Error("automatic preflight reason code does not match its verdict");
    }
  }
  if (!Array.isArray(root.limitations) || root.limitations.some((value) => typeof value !== "string")) {
    throw new Error("automatic preflight limitations are invalid");
  }
  const receipt = root as unknown as ApmAutomaticPreflightReceipt;
  receiptSha256(receipt.receiptHash, "automatic preflight receipt hash");
  if (recomputeApmPreflightReceiptHash(receipt) !== receipt.receiptHash) {
    throw new Error("automatic preflight receipt hash is invalid");
  }
  if (verdict === "HOLD") return receipt;
  if (restoration.status !== "RESTORED" || plan.summary?.total !== 1
    || plan.summary?.eligiblePairs !== 1 || !Array.isArray(plan.changes) || plan.changes.length !== 1) {
    throw new Error("automatic preflight non-HOLD plan is invalid");
  }
  const selection = receiptObject(root.selection, "automatic preflight selection");
  receiptExactKeys(selection, ["identity", "selectedChangeSha256", "currentRowSha256", "candidateRowSha256"],
    ["identity", "selectedChangeSha256", "currentRowSha256", "candidateRowSha256"], "automatic preflight selection");
  if (selection.identity !== plan.changes[0].identity
    || receiptSha256(selection.selectedChangeSha256, "selected change hash") !== hash(canonical(plan.changes[0]))) {
    throw new Error("automatic preflight selection binding is invalid");
  }
  const materialization = receiptObject(root.materialization, "automatic preflight materialization");
  receiptExactKeys(materialization, ["current", "candidate"], ["current", "candidate"], "automatic preflight materialization");
  const currentProof = receiptObject(materialization.current, "current materialization");
  const candidateProof = receiptObject(materialization.candidate, "candidate materialization");
  const proofKeys = [
    "routeSha256", "rowSha256", "commit", "expectedTreeSha256", "fetchedSha256", "fetchedBytes",
    "materializedTreeSha256", "fileCount", "totalBytes", "files", "manifestEvidence", "selectedArtifact",
  ] as const;
  receiptExactKeys(currentProof, proofKeys, proofKeys, "current materialization");
  receiptExactKeys(candidateProof, proofKeys, proofKeys, "candidate materialization");
  for (const [label, proof] of [["current", currentProof], ["candidate", candidateProof]] as const) {
    for (const field of ["routeSha256", "rowSha256", "expectedTreeSha256", "fetchedSha256", "materializedTreeSha256"] as const) {
      receiptSha256(proof[field], `${label} materialization ${field}`);
    }
    if (typeof proof.commit !== "string" || !/^[0-9a-f]{40}$/.test(proof.commit)
      || !Number.isSafeInteger(proof.fetchedBytes) || (proof.fetchedBytes as number) < 1
      || (proof.fetchedBytes as number) > MAX_ARCHIVE_BYTES
      || !Number.isSafeInteger(proof.fileCount) || (proof.fileCount as number) < 1
      || (proof.fileCount as number) > MAX_FILES
      || !Number.isSafeInteger(proof.totalBytes) || (proof.totalBytes as number) < 0
      || (proof.totalBytes as number) > MAX_TOTAL_BYTES) {
      throw new Error(`${label} materialization evidence is invalid`);
    }
    if (!Array.isArray(proof.files) || proof.files.length !== proof.fileCount) {
      throw new Error(`${label} materialized file proof is invalid`);
    }
    const fileIdentities = new Set<string>();
    const files = proof.files.map((inputFile, index): ArtifactFileCommitment => {
      const file = receiptObject(inputFile, `${label} materialized file ${index}`);
      receiptExactKeys(file, ["path", "bytes", "mode", "sha256"],
        ["path", "bytes", "mode", "sha256"], `${label} materialized file ${index}`);
      const path = receiptText(file.path, `${label} materialized file path`, 256);
      const parts = path.split("/");
      if (path.startsWith("/") || parts.some((part) => !isCrossPlatformSafeSegment(part))) {
        throw new Error(`${label} materialized file path is invalid`);
      }
      const identity = portableIdentity(path);
      if (fileIdentities.has(identity)) throw new Error(`${label} materialized file identities are invalid`);
      fileIdentities.add(identity);
      if (file.mode !== 0o644 && file.mode !== 0o755) throw new Error(`${label} materialized file mode is invalid`);
      return {
        path,
        bytes: receiptInteger(file.bytes, `${label} materialized file bytes`, 0, MAX_FILE_BYTES),
        mode: file.mode,
        sha256: receiptSha256(file.sha256, `${label} materialized file hash`),
      };
    });
    const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
    if (canonical(files) !== canonical(sortedFiles)
      || files.reduce((total, file) => total + file.bytes, 0) !== proof.totalBytes
      || canonicalTreeSha256FromCommitments(files) !== proof.materializedTreeSha256) {
      throw new Error(`${label} materialized file proof does not match the exact lock-bound repository tree`);
    }
    validateManifestEvidence(proof.manifestEvidence, files, `${label} manifest evidence`);
    const artifact = validateArtifactInventory(proof.selectedArtifact, `${label} selected artifact`);
    if (canonical(artifactInventoryFromFileCommitments(files)) !== canonical(artifact)) {
      throw new Error(`${label} selected artifact is not derived from the exact lock-bound repository tree`);
    }
  }
  if (receiptSha256(selection.currentRowSha256, "current row hash") !== currentProof.rowSha256
    || receiptSha256(selection.candidateRowSha256, "candidate row hash") !== candidateProof.rowSha256
    || currentProof.expectedTreeSha256 !== currentProof.materializedTreeSha256
    || candidateProof.expectedTreeSha256 !== candidateProof.materializedTreeSha256) {
    throw new Error("automatic preflight materialization binding is invalid");
  }
  const nested = validateNestedNonHoldReceipt(
    root.upgradeReceipt,
    verdict as "SAFE" | "CHANGED",
  );
  if (nested.generatedAt !== receipt.generatedAt || nested.nonce !== receipt.nonce) {
    throw new Error("automatic preflight nested receipt binding is invalid");
  }
  const currentArtifact = receiptObject(currentProof.selectedArtifact, "current selected artifact");
  const candidateArtifact = receiptObject(candidateProof.selectedArtifact, "candidate selected artifact");
  const currentManifest = validateManifestEvidence(
    currentProof.manifestEvidence,
    currentProof.files as ArtifactFileCommitment[],
    "current manifest evidence",
  );
  const candidateManifest = validateManifestEvidence(
    candidateProof.manifestEvidence,
    candidateProof.files as ArtifactFileCommitment[],
    "candidate manifest evidence",
  );
  if (currentArtifact.treeSha256 !== nested.current?.treeSha256
    || candidateArtifact.treeSha256 !== nested.candidate?.treeSha256
    || currentArtifact.fileCount !== nested.current?.fileCount
    || candidateArtifact.fileCount !== nested.candidate?.fileCount
    || currentArtifact.totalBytes !== nested.current?.totalBytes
    || candidateArtifact.totalBytes !== nested.candidate?.totalBytes
    || hash(currentManifest.content) !== nested.current?.manifestSha256
    || hash(candidateManifest.content) !== nested.candidate?.manifestSha256) {
    throw new Error("automatic preflight selected artifact binding is invalid");
  }
  return receipt;
}

export function validateBoundApmAutomaticPreflightReceipt(
  input: unknown,
  currentLockPath: string,
  candidateLockPath: string,
  trustedContext?: TrustedNestedContext,
): ApmAutomaticPreflightReceipt {
  const receipt = validateApmAutomaticPreflightReceipt(input);
  const exactPlan = createUpdatePlan({
    manager: "apm",
    currentPath: currentLockPath,
    candidatePath: candidateLockPath,
    generatedAt: receipt.generatedAt,
  });
  if (canonical(exactPlan) !== canonical(receipt.plan)) {
    throw new Error("automatic preflight receipt does not match the exact APM lockfiles");
  }
  if (receipt.summary.verdict === "HOLD") return receipt;
  const selection = selectApmMaterialization({
    currentPath: currentLockPath,
    candidatePath: candidateLockPath,
    generatedAt: receipt.generatedAt,
    identity: receipt.selection?.identity,
  });
  if (!receipt.selection || !receipt.materialization?.current || !receipt.materialization.candidate
    || canonical(selection.plan) !== canonical(receipt.plan)
    || selection.selectedChangeSha256 !== receipt.selection.selectedChangeSha256
    || selection.current.rowSha256 !== receipt.selection.currentRowSha256
    || selection.candidate.rowSha256 !== receipt.selection.candidateRowSha256) {
    throw new Error("automatic preflight selection does not match the exact APM lockfiles");
  }
  for (const [expected, proof] of [
    [selection.current, receipt.materialization.current],
    [selection.candidate, receipt.materialization.candidate],
  ] as const) {
    if (expected.commit !== proof.commit || expected.expectedTreeSha256 !== proof.expectedTreeSha256
      || expected.routeSha256 !== proof.routeSha256 || expected.rowSha256 !== proof.rowSha256) {
      throw new Error("automatic preflight materialization does not match the selected APM row");
    }
  }
  if (trustedContext) {
    const nested = validateNestedNonHoldReceipt(
      receipt.upgradeReceipt,
      receipt.summary.verdict as "SAFE" | "CHANGED",
      trustedContext,
    );
    validateManifestTargetBindings(receipt.materialization, nested, trustedUpgradeConfig(trustedContext));
  }
  return receipt;
}

function strictUtf8(bytes: Buffer, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PreflightHold(label); }
}

function tarText(block: Buffer, start: number, length: number, reasonCode: string): string {
  const field = block.subarray(start, start + length);
  const zero = field.indexOf(0);
  const textBytes = zero === -1 ? field : field.subarray(0, zero);
  if (zero !== -1 && field.subarray(zero).some((byte) => byte !== 0)) throw new PreflightHold(reasonCode);
  return strictUtf8(textBytes, reasonCode);
}

function tarOctal(block: Buffer, start: number, length: number, reasonCode: string): number {
  const field = block.subarray(start, start + length);
  if (field[0] !== undefined && (field[0] & 0x80) !== 0) throw new PreflightHold(reasonCode);
  const source = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!source) return 0;
  if (!/^[0-7]+$/.test(source)) throw new PreflightHold(reasonCode);
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value)) throw new PreflightHold(reasonCode);
  return value;
}

function validTarChecksum(block: Buffer): boolean {
  const expected = tarOctal(block, 148, 8, "ARCHIVE_INVALID");
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return actual === expected;
}

function normalizedArchivePath(value: string): { root: string; relativePath?: string } {
  if (!value || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
  }
  const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = trimmed.split("/");
  if (!parts[0] || parts.some((part) => !isCrossPlatformSafeSegment(part))) {
    throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
  }
  return { root: parts[0], ...(parts.length > 1 ? { relativePath: parts.slice(1).join("/") } : {}) };
}

function portableIdentity(path: string): string {
  return path.normalize("NFC").toUpperCase();
}

function codeloadPaxCommit(bytes: Buffer): string {
  if (bytes.length < 1 || bytes.length > 128) throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
  const value = strictUtf8(bytes, "ARCHIVE_ENTRY_UNSUPPORTED");
  const match = /^([1-9][0-9]{0,2}) comment=([0-9a-f]{40})\n$/.exec(value);
  if (!match || Number(match[1]) !== bytes.length) throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
  return match[2];
}

function parentPaths(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
}

function archiveFileCommitments(files: TarFile[]): ArtifactFileCommitment[] {
  return files.map((file) => ({
    path: file.path,
    bytes: file.bytes.length,
    mode: file.executable ? 0o755 : 0o644,
    sha256: hash(file.bytes),
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function manifestEvidenceFromArchive(files: readonly TarFile[], manifestPath: string): ManifestEvidence {
  const path = portableManifestPath(manifestPath);
  const file = files.find((entry) => entry.path === path);
  if (!file || !file.bytes.length) throw new PreflightHold("MANIFEST_EVIDENCE_UNAVAILABLE");
  if (file.bytes.length > MAX_APM_MANIFEST_EVIDENCE_BYTES) {
    throw new PreflightHold("MANIFEST_EVIDENCE_SIZE_EXCEEDED");
  }
  return { path, contentBase64: file.bytes.toString("base64") };
}

function canonicalTreeSha256FromCommitments(files: readonly ArtifactFileCommitment[]): string {
  const byDirectory = new Map<string, ArtifactFileCommitment[]>();
  const directories = new Set<string>([""]);
  for (const file of files) {
    const parts = file.path.split("/");
    const directory = parts.slice(0, -1).join("/");
    directories.add(directory);
    for (const parent of parentPaths(file.path)) directories.add(parent);
    const rows = byDirectory.get(directory) ?? [];
    rows.push(file);
    byDirectory.set(directory, rows);
  }
  const memo = new Map<string, string>();
  const digestDirectory = (directory: string): string => {
    const cached = memo.get(directory);
    if (cached) return cached;
    const prefix = directory ? `${directory}/` : "";
    const directDirectories = [...directories].filter((candidate) => {
      if (!candidate.startsWith(prefix) || candidate === directory) return false;
      return !candidate.slice(prefix.length).includes("/");
    });
    const entries: Array<{ name: string; line: string }> = [];
    for (const file of byDirectory.get(directory) ?? []) {
      const name = basename(file.path);
      entries.push({
        name,
        line: `${file.mode === 0o755 ? "100755" : "100644"} ${name} ${file.sha256.slice(7)}\n`,
      });
    }
    for (const child of directDirectories) {
      const name = child.slice(prefix.length);
      entries.push({ name, line: `040000 ${name} ${digestDirectory(child)}\n` });
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    const digest = createHash("sha256").update(entries.map((entry) => entry.line).join(""), "utf8").digest("hex");
    memo.set(directory, digest);
    return digest;
  };
  return `sha256:${digestDirectory("")}`;
}

function canonicalTreeSha256(files: TarFile[]): string {
  return canonicalTreeSha256FromCommitments(archiveFileCommitments(files));
}

export function parseApmGitHubArchive(compressed: Buffer): ParsedArchive {
  if (!compressed.length || compressed.length > MAX_ARCHIVE_BYTES) throw new PreflightHold("ARCHIVE_SIZE_EXCEEDED");
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: MAX_TAR_BYTES }); }
  catch { throw new PreflightHold("ARCHIVE_INVALID"); }
  if (!tar.length || tar.length % 512 !== 0 || tar.length > MAX_TAR_BYTES) throw new PreflightHold("ARCHIVE_INVALID");
  const files: TarFile[] = [];
  const directories = new Set<string>();
  const identities = new Set<string>();
  const fileIdentities = new Set<string>();
  const portablePaths = new Map<string, string>();
  const registerPortablePath = (path: string): void => {
    const identity = portableIdentity(path);
    const existing = portablePaths.get(identity);
    if (existing !== undefined && existing !== path) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
    portablePaths.set(identity, path);
  };
  let archiveRoot: string | undefined;
  let paxCommit: string | undefined;
  let offset = 0;
  let ended = false;
  let totalBytes = 0;
  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      if (offset + 1_024 > tar.length || !tar.subarray(offset, offset + 1_024).every((byte) => byte === 0)) {
        throw new PreflightHold("ARCHIVE_INVALID");
      }
      ended = true;
      if (!tar.subarray(offset).every((byte) => byte === 0)) throw new PreflightHold("ARCHIVE_INVALID");
      break;
    }
    if (!validTarChecksum(block)) throw new PreflightHold("ARCHIVE_INVALID");
    const magic = block.subarray(257, 263).toString("binary");
    if (magic !== "ustar\0" && magic !== "ustar ") throw new PreflightHold("ARCHIVE_INVALID");
    const name = tarText(block, 0, 100, "ARCHIVE_INVALID");
    const prefix = tarText(block, 345, 155, "ARCHIVE_INVALID");
    const path = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(block, 124, 12, "ARCHIVE_INVALID");
    const mode = tarOctal(block, 100, 8, "ARCHIVE_INVALID");
    const type = block[156];
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > tar.length || paddedEnd > tar.length) throw new PreflightHold("ARCHIVE_INVALID");
    if (type === 0x67) {
      if (archiveRoot !== undefined || paxCommit !== undefined || prefix || name !== "pax_global_header") {
        throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
      }
      paxCommit = codeloadPaxCommit(Buffer.from(tar.subarray(dataStart, dataEnd)));
      offset = paddedEnd;
      continue;
    }
    const normalized = normalizedArchivePath(path);
    archiveRoot ??= normalized.root;
    if (normalized.root !== archiveRoot) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
    const relativePath = normalized.relativePath;
    if (type !== 0 && type !== 0x30 && type !== 0x35) throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
    if (type === 0x35) {
      if (size !== 0) throw new PreflightHold("ARCHIVE_INVALID");
      if (relativePath) {
        if (!directories.has(relativePath) && directories.size >= MAX_DIRECTORIES) {
          throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
        }
        const identity = portableIdentity(relativePath);
        if (identities.has(identity)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
        registerPortablePath(relativePath);
        identities.add(identity);
        directories.add(relativePath);
      }
    } else {
      if (!relativePath) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
      if (files.length >= MAX_FILES) throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
      if (size > MAX_FILE_BYTES || totalBytes + size > MAX_TOTAL_BYTES) throw new PreflightHold("ARCHIVE_SIZE_EXCEEDED");
      const identity = portableIdentity(relativePath);
      if (identities.has(identity) || directories.has(relativePath)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
      registerPortablePath(relativePath);
      identities.add(identity);
      fileIdentities.add(identity);
      for (const parent of parentPaths(relativePath)) {
        registerPortablePath(parent);
        const parentIdentity = portableIdentity(parent);
        if (fileIdentities.has(parentIdentity)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
        if (!directories.has(parent) && directories.size >= MAX_DIRECTORIES) {
          throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
        }
        directories.add(parent);
      }
      files.push({
        path: relativePath,
        bytes: Buffer.from(tar.subarray(dataStart, dataEnd)),
        executable: (mode & 0o111) !== 0,
      });
      totalBytes += size;
    }
    offset = paddedEnd;
  }
  if (!ended || !archiveRoot || !files.length) throw new PreflightHold("ARCHIVE_INVALID");
  const materializedDirectories = new Set(files.flatMap((file) => parentPaths(file.path)));
  // Git cannot bind empty directories. Reject rather than materialize any
  // archive-only directory that is absent from the canonical tree commitment.
  if ([...directories].some((directory) => !materializedDirectories.has(directory))) {
    throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
  }
  return {
    files,
    directories: [...materializedDirectories].sort(),
    ...(paxCommit ? { paxCommit } : {}),
    treeSha256: canonicalTreeSha256(files),
    fileCount: files.length,
    totalBytes,
  };
}

function safeSessionParent(path: string): string {
  const requested = resolve(path);
  const status = lstatSync(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
  const canonicalParent = realpathSync(requested);
  if (!statSync(canonicalParent).isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
  return canonicalParent;
}

function createSession(parentPath: string): string {
  let root: string | undefined;
  try {
    root = mkdtempSync(join(safeSessionParent(parentPath), SESSION_PREFIX));
    // Materialized public package bytes must remain readable by the fixed
    // unprivileged container user. The containing .agent-vigil directory and
    // short lifetime keep this separate from active APM state.
    chmodSync(root, 0o755);
    const status = lstatSync(root);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
    return realpathSync(root);
  } catch (error) {
    if (root !== undefined && !safeRemoveSession(root)) {
      throw new PreflightHold("RESTORATION_FAILED");
    }
    throw error;
  }
}

function safeRemoveSession(path: string): boolean {
  try {
    const requested = resolve(path);
    if (!basename(requested).startsWith(SESSION_PREFIX)) return false;
    const status = lstatSync(requested);
    if (status.isSymbolicLink() || !status.isDirectory()) return false;
    if (realpathSync(requested) !== requested) return false;
    rmSync(requested, { recursive: true, force: false, maxRetries: 2 });
    return !existsSync(requested);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function trustedCurlLocations(): string[] {
  if (process.platform === "win32") return ["C:\\Windows\\System32\\curl.exe"];
  return ["/usr/bin/curl", "/usr/local/bin/curl", "/opt/homebrew/bin/curl"];
}

function resolveFetchBinary(requested = "curl"): string {
  const candidates = isAbsolute(requested) ? [requested]
    : requested === "curl" || requested === "curl.exe" ? trustedCurlLocations() : [];
  for (const candidate of candidates) {
    try {
      const canonicalPath = realpathSync(candidate);
      if (!statSync(canonicalPath).isFile()) continue;
      if (process.platform !== "win32") accessSync(canonicalPath, constants.X_OK);
      return canonicalPath;
    } catch {
      // Continue through fixed platform locations.
    }
  }
  throw new PreflightHold("FETCH_CLIENT_UNAVAILABLE");
}

export function curlArchiveFetcher(fetchBin = "curl"): ArchiveFetcher {
  const executable = resolveFetchBinary(fetchBin);
  return (url, destination) => {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED"); }
    if (parsed.protocol !== "https:" || parsed.hostname !== "codeload.github.com"
      || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
      || !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/tar\.gz\/[0-9a-f]{40}$/.test(parsed.pathname)) {
      throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED");
    }
    const result = spawnSync(executable, [
      "-q", "--fail", "--silent", "--show-error",
      "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "0",
      "--connect-timeout", "10", "--max-time", "90",
      "--max-filesize", String(MAX_ARCHIVE_BYTES), "--noproxy", "*",
      "--output", "-", parsed.toString(),
    ], {
      timeout: 100_000,
      killSignal: "SIGKILL",
      maxBuffer: MAX_ARCHIVE_BYTES + 64 * 1024,
      env: process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
        : { LANG: "C", LC_ALL: "C" },
    });
    if (result.status !== 0 || result.error || !Buffer.isBuffer(result.stdout)
      || result.stdout.length < 1 || result.stdout.length > MAX_ARCHIVE_BYTES) {
      throw new PreflightHold("FETCH_FAILED");
    }
    // Curl never receives a filesystem destination. This prevents its normal
    // open/truncate behavior from following a same-user replacement symlink;
    // the bounded bytes are committed through an exclusive no-follow handle.
    writeExclusiveFile(destination, result.stdout, false, 0o600);
  };
}

function writeExclusiveFile(path: string, bytes: Buffer, executable: boolean, mode?: number): void {
  const exactMode = mode ?? (executable ? 0o755 : 0o644);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    exactMode,
  );
  try {
    writeFileSync(descriptor, bytes);
    // Creation modes are filtered by the host umask. Reset the exact bounded
    // mode on the already-open descriptor so the inventoried/tested artifact
    // is identical across runners and matches the canonical Git tree model.
    fchmodSync(descriptor, exactMode);
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size !== bytes.length || (status.mode & 0o777) !== exactMode) {
      throw new PreflightHold("MATERIALIZATION_FAILED");
    }
  } finally { closeSync(descriptor); }
}

function extractArchive(archive: ParsedArchive, root: string): void {
  mkdirSync(root, { mode: 0o755 });
  chmodSync(root, 0o755);
  for (const directory of archive.directories.sort((left, right) => left.split("/").length - right.split("/").length)) {
    const output = join(root, ...directory.split("/"));
    const rel = relative(root, output);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
    if (!existsSync(output)) mkdirSync(output, { mode: 0o755 });
    chmodSync(output, 0o755);
    const status = lstatSync(output);
    if (status.isSymbolicLink() || !status.isDirectory() || (status.mode & 0o777) !== 0o755) {
      throw new PreflightHold("MATERIALIZATION_FAILED");
    }
  }
  for (const file of archive.files) {
    const output = join(root, ...file.path.split("/"));
    const parent = dirname(output);
    const parentStatus = lstatSync(parent);
    if (parentStatus.isSymbolicLink() || !parentStatus.isDirectory()) {
      throw new PreflightHold("MATERIALIZATION_FAILED");
    }
    writeExclusiveFile(output, file.bytes, file.executable);
  }
}

function materializeEndpoint(
  endpoint: ApmMaterializationEndpoint,
  label: "current" | "candidate",
  session: string,
  fetchArchive: ArchiveFetcher,
  manifestPath: string,
): { proof: MaterializedProof; selectedRoot: string } {
  const archivePath = join(session, `${label}.tar.gz`);
  const url = `https://codeload.github.com/${endpoint.repository.owner}/${endpoint.repository.name}/tar.gz/${endpoint.commit}`;
  fetchArchive(url, archivePath);
  const beforePath = lstatSync(archivePath, { bigint: true });
  if (beforePath.isSymbolicLink() || !beforePath.isFile()
    || beforePath.size < 1n || beforePath.size > BigInt(MAX_ARCHIVE_BYTES)) {
    throw new PreflightHold("FETCH_INVALID");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(archivePath, constants.O_RDONLY | noFollow);
  let compressed: Buffer;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== beforePath.dev || opened.ino !== beforePath.ino) {
      throw new PreflightHold("FETCH_INVALID");
    }
    fchmodSync(descriptor, 0o600);
    const before = fstatSync(descriptor, { bigint: true });
    compressed = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(archivePath, { bigint: true });
    if (compressed.length > MAX_ARCHIVE_BYTES || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== afterPath.dev || after.ino !== afterPath.ino || afterPath.isSymbolicLink()) {
      throw new PreflightHold("FETCH_INVALID");
    }
  } finally { closeSync(descriptor); }
  const fetchedSha256 = hash(compressed);
  const parsed = parseApmGitHubArchive(compressed);
  if (parsed.paxCommit !== undefined && parsed.paxCommit !== endpoint.commit) {
    throw new PreflightHold("ARCHIVE_COMMIT_MISMATCH");
  }
  if (parsed.treeSha256 !== endpoint.expectedTreeSha256) throw new PreflightHold("MATERIALIZED_TREE_MISMATCH");
  const files = archiveFileCommitments(parsed.files);
  const manifestEvidence = manifestEvidenceFromArchive(parsed.files, manifestPath);
  unlinkSync(archivePath);
  const materializedRoot = join(session, label);
  extractArchive(parsed, materializedRoot);
  const selectedRoot = endpoint.virtualPath
    ? join(materializedRoot, ...endpoint.virtualPath.split("/")) : materializedRoot;
  const rel = relative(materializedRoot, selectedRoot);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED");
  const selectedStatus = lstatSync(selectedRoot);
  if (selectedStatus.isSymbolicLink() || !selectedStatus.isDirectory()) throw new PreflightHold("VIRTUAL_PATH_UNAVAILABLE");
  const selectedArtifact = inspectArtifactTree(selectedRoot);
  return {
    selectedRoot,
    proof: {
      routeSha256: endpoint.routeSha256,
      rowSha256: endpoint.rowSha256,
      commit: endpoint.commit,
      expectedTreeSha256: endpoint.expectedTreeSha256,
      fetchedSha256,
      fetchedBytes: compressed.length,
      materializedTreeSha256: parsed.treeSha256,
      fileCount: parsed.fileCount,
      totalBytes: parsed.totalBytes,
      files,
      manifestEvidence,
      selectedArtifact,
    },
  };
}

function suppliedPlanTime(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const generatedAt = (value as Record<string, unknown>).generatedAt;
  return typeof generatedAt === "string" ? generatedAt : undefined;
}

function exactTimestamp(value: string | undefined): string | undefined {
  if (!value || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value : undefined;
}

function exactPlanForInput(input: ApmAutomaticPreflightInput): { plan: UpdatePlan; suppliedPlanMatches: boolean } {
  const suppliedGeneratedAt = suppliedPlanTime(input.suppliedPlan);
  const suppliedTimestamp = exactTimestamp(suppliedGeneratedAt);
  const generatedAt = input.suppliedPlan === undefined ? input.generatedAt
    : suppliedTimestamp ?? input.generatedAt;
  const plan = createUpdatePlan({
    manager: "apm",
    currentPath: input.currentLockPath,
    candidatePath: input.candidateLockPath,
    ...(generatedAt ? { generatedAt } : input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
  return {
    plan,
    suppliedPlanMatches: input.suppliedPlan === undefined
      || Boolean(suppliedTimestamp && canonical(input.suppliedPlan) === canonical(plan)),
  };
}

function holdReason(error: unknown, fallback: string): string {
  if (error instanceof PreflightHold || error instanceof ApmMaterializationHold) return error.reasonCode;
  return fallback;
}

export function runApmAutomaticPreflight(
  input: ApmAutomaticPreflightInput,
  dependencies: ApmAutomaticDependencies = {},
): ApmAutomaticPreflightReceipt {
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  if (nonce.length < 16 || nonce.length > 128 || nonce.includes("\0")) {
    throw new Error("automatic APM preflight nonce must contain from 16 to 128 characters");
  }
  const { plan, suppliedPlanMatches } = exactPlanForInput(input);
  if (!suppliedPlanMatches) {
    return finalizeReceipt({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      restoration: { status: "RESTORED", hostMutation: "NONE", sessionRemoved: true, reasonCode: "NOTHING_MATERIALIZED" },
      summary: { verdict: "HOLD", reasonCodes: ["PLAN_MISMATCH"] },
      limitations: LIMITATIONS,
    });
  }
  let selection: ApmMaterializationSelection;
  try {
    selection = selectApmMaterialization({
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt,
      ...(input.identity ? { identity: input.identity } : {}),
    });
    if (canonical(selection.plan) !== canonical(plan)) {
      throw new ApmMaterializationHold("SOURCE_STATE_CHANGED");
    }
    if (plan.summary.total !== 1 || plan.summary.eligiblePairs !== 1
      || plan.changes.length !== 1 || canonical(plan.changes[0]) !== canonical(selection.change)) {
      throw new ApmMaterializationHold("UNASSESSED_PLAN_CHANGES");
    }
  } catch (error) {
    const reasonCode = holdReason(error, "SELECTION_FAILED");
    return finalizeReceipt({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      restoration: { status: "RESTORED", hostMutation: "NONE", sessionRemoved: true, reasonCode: "NOTHING_MATERIALIZED" },
      summary: { verdict: "HOLD", reasonCodes: [reasonCode] },
      limitations: LIMITATIONS,
    });
  }

  let session: string;
  try { session = createSession(input.workDirectory ?? dirname(input.configPath)); }
  catch (error) {
    return finalizeReceipt({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      selection: {
        identity: selection.change.identity,
        selectedChangeSha256: selection.selectedChangeSha256,
        currentRowSha256: selection.current.rowSha256,
        candidateRowSha256: selection.candidate.rowSha256,
      },
      restoration: { status: "HOLD", hostMutation: "NONE", sessionRemoved: false, reasonCode: "SESSION_UNAVAILABLE" },
      summary: { verdict: "HOLD", reasonCodes: [holdReason(error, "SESSION_UNAVAILABLE")] },
      limitations: LIMITATIONS,
    });
  }

  const removeSession = dependencies.removeSession ?? safeRemoveSession;
  let cleanupAttempted = false;
  let cleanupSucceeded = false;
  const cleanup = (): boolean => {
    if (cleanupAttempted) return cleanupSucceeded;
    cleanupAttempted = true;
    try { cleanupSucceeded = removeSession(session); }
    catch { cleanupSucceeded = false; }
    return cleanupSucceeded;
  };
  const onInterrupt = (): never => {
    cleanup();
    process.exit(130);
  };
  const onTerminate = (): never => {
    cleanup();
    process.exit(143);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  const materialization: { current?: MaterializedProof; candidate?: MaterializedProof } = {};
  let upgradeReceipt: UpgradePrivateReceipt | undefined;
  const reasons: string[] = [];
  try {
    const materializationConfig = loadUpgradeConfig(
      trustedRegularFileInside(input.repository, input.configPath, "upgrade config"),
    );
    const fetchArchive = dependencies.fetchArchive ?? curlArchiveFetcher(input.fetchBin ?? "curl");
    const current = materializeEndpoint(
      selection.current,
      "current",
      session,
      fetchArchive,
      materializationConfig.component.manifestPath,
    );
    materialization.current = current.proof;
    const candidate = materializeEndpoint(
      selection.candidate,
      "candidate",
      session,
      fetchArchive,
      materializationConfig.component.manifestPath,
    );
    materialization.candidate = candidate.proof;
    const beforeCheckPlan = createUpdatePlan({
      manager: "apm",
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt,
    });
    if (canonical(beforeCheckPlan) !== canonical(plan)) throw new PreflightHold("SOURCE_STATE_CHANGED");
    const evaluate = dependencies.evaluate ?? runUpgradeEvaluation;
    upgradeReceipt = evaluate({
      configPath: input.configPath,
      repository: input.repository,
      currentDirectory: current.selectedRoot,
      candidateDirectory: candidate.selectedRoot,
      ...(input.dockerBin ? { dockerBin: input.dockerBin } : {}),
      generatedAt: plan.generatedAt,
      nonce,
    });
    if (upgradeReceipt.summary?.verdict === "SAFE" || upgradeReceipt.summary?.verdict === "CHANGED") {
      try {
        const trustedContext = {
          repository: input.repository,
          configPath: input.configPath,
        };
        const nested = validateNestedNonHoldReceipt(upgradeReceipt, upgradeReceipt.summary.verdict, trustedContext);
        validateManifestTargetBindings(materialization, nested, trustedUpgradeConfig(trustedContext));
      } catch {
        reasons.push("CHECK_RECEIPT_INVALID");
      }
    } else if (recomputeUpgradeReceiptHash(upgradeReceipt) !== upgradeReceipt.receiptHash) {
      reasons.push("CHECK_RECEIPT_INVALID");
    }
    if (!reasons.includes("CHECK_RECEIPT_INVALID") && (!upgradeReceipt.current || !upgradeReceipt.candidate
      || upgradeReceipt.current.treeSha256 !== current.proof.selectedArtifact.treeSha256
      || upgradeReceipt.candidate.treeSha256 !== candidate.proof.selectedArtifact.treeSha256)) {
      reasons.push("CHECK_BINDING_MISMATCH");
    } else if (!reasons.includes("CHECK_RECEIPT_INVALID") && upgradeReceipt.summary.verdict === "HOLD") {
      reasons.push("CHECK_HOLD");
    }
    const afterCheckPlan = createUpdatePlan({
      manager: "apm",
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt,
    });
    if (canonical(afterCheckPlan) !== canonical(plan)) reasons.push("SOURCE_STATE_CHANGED");
  } catch (error) {
    reasons.push(holdReason(error, upgradeReceipt ? "CHECK_FAILED" : "MATERIALIZATION_FAILED"));
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (!cleanup()) reasons.push("RESTORATION_FAILED");
  }
  const restoration = cleanupSucceeded
    ? { status: "RESTORED" as const, hostMutation: "NONE" as const, sessionRemoved: true, reasonCode: "TEMPORARY_ARTIFACTS_REMOVED" }
    : { status: "HOLD" as const, hostMutation: "NONE" as const, sessionRemoved: false, reasonCode: "RESTORATION_FAILED" };
  const verdict = reasons.length || !upgradeReceipt ? "HOLD" as const : upgradeReceipt.summary.verdict;
  return finalizeReceipt({
    schemaVersion: APM_PREFLIGHT_SCHEMA,
    generatedAt: plan.generatedAt,
    nonce,
    plan,
    selection: {
      identity: selection.change.identity,
      selectedChangeSha256: selection.selectedChangeSha256,
      currentRowSha256: selection.current.rowSha256,
      candidateRowSha256: selection.candidate.rowSha256,
    },
    ...(materialization.current || materialization.candidate ? { materialization } : {}),
    ...(upgradeReceipt ? { upgradeReceipt } : {}),
    restoration,
    summary: {
      verdict,
      reasonCodes: reasons.length ? [...new Set(reasons)]
        : [verdict === "SAFE" ? "NO_MATERIAL_CHANGE" : "MATERIAL_CHANGE_DETECTED"],
    },
    limitations: LIMITATIONS,
  });
}

export function renderApmAutomaticPreflight(receipt: ApmAutomaticPreflightReceipt): string {
  const lines = [
    `Agent Vigil automatic APM preflight: ${receipt.summary.verdict}`,
    `  plan ${receipt.plan.planHash}`,
  ];
  if (receipt.selection) lines.push(`  selected ${receipt.selection.identity}`);
  if (receipt.upgradeReceipt) lines.push(renderUpgradeReceipt(receipt.upgradeReceipt).trimEnd());
  lines.push(`  restoration ${receipt.restoration.status} · host mutation ${receipt.restoration.hostMutation}`);
  if (receipt.summary.reasonCodes.length) lines.push(`  ${receipt.summary.reasonCodes.join(", ")}`);
  lines.push(`  ${receipt.receiptHash}`);
  return `${lines.join("\n")}\n`;
}
