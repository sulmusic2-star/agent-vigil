import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { canonical } from "../report.ts";
import type { ContainmentProbe, CanaryTrial } from "./sandbox.ts";
import { parseExactJson, type UpgradeCanaryConfig, type UpgradeComponentConfig, type UpgradeVerdict } from "./contracts.ts";

const MAX_FILES = 4_096;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export type CapabilitySnapshot = {
  field: string;
  count: number;
  sha256: string;
};

export type TargetSnapshot = {
  ecosystem: string;
  name: string;
  version: string;
  treeSha256: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
  capabilities: CapabilitySnapshot[];
};

export type ArtifactInventory = {
  treeSha256: string;
  fileCount: number;
  totalBytes: number;
};

export type CapabilityChange = {
  field: string;
  currentCount: number;
  candidateCount: number;
  changed: boolean;
};

export type CanaryAggregate = {
  state: "PASS" | "FAIL" | "HOLD";
  observationSha256?: string;
  observationCount?: number;
  trials: number;
  stable: boolean;
  reason: string;
};

export type CanaryComparison = {
  id: string;
  publicId?: string;
  idSha256: string;
  commandSha256: string;
  current: CanaryAggregate;
  candidate: CanaryAggregate;
  changed: boolean;
  comparable: boolean;
};

export type UpgradeDecision = {
  verdict: UpgradeVerdict;
  reasons: string[];
  capabilities: CapabilityChange[];
  canaries: CanaryComparison[];
};

function hash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

type ExpectedArtifactFile = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type HashedArtifactFile = {
  bytes: number;
  mode: number;
  sha256: string;
};

function hashRegularFile(
  path: string,
  expected: ExpectedArtifactFile,
  maximumFileBytes: number,
  maximumRemainingBytes: number,
): HashedArtifactFile {
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()
      || before.dev !== expected.dev || before.ino !== expected.ino
      || before.size !== expected.size || before.mode !== expected.mode
      || before.mtimeNs !== expected.mtimeNs || before.ctimeNs !== expected.ctimeNs) {
      throw new Error("artifact entry changed while it was being opened for inventory");
    }
    if (before.size > BigInt(maximumFileBytes)) throw new Error(`target file exceeds ${maximumFileBytes} bytes`);
    if (before.size > BigInt(maximumRemainingBytes)) throw new Error(`target exceeds ${MAX_TOTAL_BYTES} total bytes`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0n;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      total += BigInt(read);
      if (total > BigInt(maximumFileBytes)) throw new Error(`target file exceeds ${maximumFileBytes} bytes`);
      if (total > BigInt(maximumRemainingBytes)) throw new Error(`target exceeds ${MAX_TOTAL_BYTES} total bytes`);
      digest.update(buffer.subarray(0, read));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mode !== after.mode || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || total !== after.size || after.dev !== afterPath.dev || after.ino !== afterPath.ino
      || after.size !== afterPath.size || after.mode !== afterPath.mode || afterPath.isSymbolicLink()) {
      throw new Error("artifact entry changed while it was being inventoried");
    }
    return {
      bytes: Number(total),
      mode: Number(before.mode & 0o777n),
      sha256: `sha256:${digest.digest("hex")}`,
    };
  } finally {
    closeSync(descriptor);
  }
}

function lookup(root: unknown, field: string): unknown {
  let value = root;
  for (const segment of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function capabilityCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return 1;
}

function safeFile(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("manifest escaped the target directory");
  const status = lstatSync(target);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("manifest must be a regular non-symbolic-link file");
  if (status.size > MAX_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const parent = realpathSync(dirname(target));
  if (parent !== realpathSync(root) && !parent.startsWith(`${realpathSync(root)}${sep}`)) {
    throw new Error("manifest parent escaped the target directory");
  }
  return target;
}

export type ArtifactInspectionHooks = {
  /** Deterministic test seam for a path replacement between lstat and open. */
  afterEntryLstat?: (path: string) => void;
};

export function inspectArtifactTree(root: string, hooks: ArtifactInspectionHooks = {}): ArtifactInventory {
  const canonicalRoot = realpathSync(root);
  if (!lstatSync(canonicalRoot).isDirectory()) throw new Error("target must be a directory");
  const entries: Array<{ path: string; bytes: number; mode: number; sha256: string }> = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const status = lstatSync(path, { bigint: true });
      if (status.isSymbolicLink()) throw new Error(`target contains a symbolic link: ${relative(canonicalRoot, path)}`);
      if (status.isDirectory()) {
        visit(path);
        continue;
      }
      if (!status.isFile()) throw new Error(`target contains a non-regular entry: ${relative(canonicalRoot, path)}`);
      if (status.size > BigInt(MAX_ARTIFACT_FILE_BYTES)) throw new Error(`target file exceeds ${MAX_ARTIFACT_FILE_BYTES} bytes: ${relative(canonicalRoot, path)}`);
      if (entries.length >= MAX_FILES) throw new Error(`target contains more than ${MAX_FILES} files`);
      const rel = relative(canonicalRoot, path).split(sep).join("/");
      hooks.afterEntryLstat?.(path);
      const observed = hashRegularFile(
        path,
        status,
        MAX_ARTIFACT_FILE_BYTES,
        MAX_TOTAL_BYTES - totalBytes,
      );
      totalBytes += observed.bytes;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`target exceeds ${MAX_TOTAL_BYTES} total bytes`);
      entries.push({
        path: rel,
        bytes: observed.bytes,
        mode: observed.mode,
        sha256: observed.sha256,
      });
    }
  };
  visit(canonicalRoot);
  return {
    treeSha256: hash(canonical(entries)),
    fileCount: entries.length,
    totalBytes,
  };
}

export function inspectTarget(directory: string, component: UpgradeComponentConfig): TargetSnapshot {
  const requestedStatus = lstatSync(directory);
  if (requestedStatus.isSymbolicLink() || !requestedStatus.isDirectory()) {
    throw new Error("target must be a regular directory, not a symbolic link");
  }
  const root = realpathSync(directory);
  const manifestPath = safeFile(root, component.manifestPath);
  const manifestBytes = readFileSync(manifestPath);
  let manifest: unknown;
  try { manifest = parseExactJson(manifestBytes, basename(component.manifestPath)); }
  catch { throw new Error(`${basename(component.manifestPath)} is not valid JSON`); }
  const name = lookup(manifest, component.identityField);
  const version = lookup(manifest, component.versionField);
  if (typeof name !== "string" || !name.length || name.length > 160) throw new Error("manifest identity is missing or unbounded");
  if (name !== component.name) throw new Error(`manifest identity ${name} does not match configured component ${component.name}`);
  if (typeof version !== "string" || !version.length || version.length > 128) throw new Error("manifest version is missing or unbounded");
  const capabilities = component.capabilityFields.map((field): CapabilitySnapshot => {
    const value = lookup(manifest, field);
    return {
      field,
      count: capabilityCount(value),
      sha256: hash(canonical({ present: value !== undefined, value: value ?? null })),
    };
  });
  return {
    ecosystem: component.ecosystem,
    name,
    version,
    ...inspectArtifactTree(root),
    manifestSha256: hash(manifestBytes),
    capabilities,
  };
}

export function aggregateTrials(trials: CanaryTrial[]): CanaryAggregate {
  if (!trials.length) return { state: "HOLD", trials: 0, stable: false, reason: "no canary trials ran" };
  if (trials.some((trial) => trial.state === "HOLD")) {
    return { state: "HOLD", trials: trials.length, stable: false, reason: "one or more canary trials were incomplete" };
  }
  const states = new Set(trials.map((trial) => trial.state));
  const observations = new Set(trials.map((trial) => trial.observationSha256));
  const counts = new Set(trials.map((trial) => trial.observationCount));
  if (states.size !== 1 || observations.size !== 1 || counts.size !== 1) {
    return { state: "HOLD", trials: trials.length, stable: false, reason: "repeated canary trials produced nondeterministic evidence" };
  }
  const first = trials[0];
  if (!first.observationCount || first.observationCount < 1) {
    return {
      state: "HOLD",
      trials: trials.length,
      stable: false,
      reason: "canary produced no bounded observations",
    };
  }
  return {
    state: first.state,
    observationSha256: first.observationSha256,
    observationCount: first.observationCount,
    trials: trials.length,
    stable: true,
    reason: first.state === "PASS" ? "repeated trials produced one stable observation" : "trusted canary consistently reported FAIL",
  };
}

export function compareCanary(
  canary: UpgradeCanaryConfig,
  commandSha256: string,
  currentTrials: CanaryTrial[],
  candidateTrials: CanaryTrial[],
): CanaryComparison {
  const current = aggregateTrials(currentTrials);
  const candidate = aggregateTrials(candidateTrials);
  return compareCanaryAggregates(canary, commandSha256, current, candidate);
}

/**
 * Recompute a comparison from the aggregate evidence stored in a receipt.
 * Consumers must validate the aggregate shapes before calling this helper;
 * this function deliberately derives, rather than trusts, the two decision
 * booleans.
 */
export function compareCanaryAggregates(
  canary: Pick<UpgradeCanaryConfig, "id" | "publicId">,
  commandSha256: string,
  current: CanaryAggregate,
  candidate: CanaryAggregate,
): CanaryComparison {
  const comparable = current.stable
    && candidate.stable
    && current.state === "PASS"
    && candidate.state !== "HOLD"
    && (current.observationCount ?? 0) > 0
    && (candidate.observationCount ?? 0) > 0;
  const changed = comparable && (
    candidate.state !== "PASS"
    || current.observationSha256 !== candidate.observationSha256
    || current.observationCount !== candidate.observationCount
  );
  return {
    id: canary.id,
    ...(canary.publicId ? { publicId: canary.publicId } : {}),
    idSha256: hash(canary.id),
    commandSha256,
    current,
    candidate,
    changed,
    comparable,
  };
}

function compareCapabilities(current: TargetSnapshot, candidate: TargetSnapshot): CapabilityChange[] {
  return current.capabilities.map((item, index) => ({
    field: item.field,
    currentCount: item.count,
    candidateCount: candidate.capabilities[index]?.count ?? 0,
    changed: item.sha256 !== candidate.capabilities[index]?.sha256,
  }));
}

export function decideUpgrade(
  containment: ContainmentProbe,
  current: TargetSnapshot,
  candidate: TargetSnapshot,
  canaries: CanaryComparison[],
): UpgradeDecision {
  const reasons: string[] = [];
  const capabilities = compareCapabilities(current, candidate);
  if (containment.status !== "PASS"
    || !containment.localEndpoint
    || !containment.imagePresent
    || !containment.networkBlocked
    || !containment.targetReadOnly
    || !containment.rootReadOnly
    || !containment.inheritedSecretAbsent
    || !containment.proxiesCleared) {
    reasons.push("required containment controls were not established");
  }
  if (current.name !== candidate.name || current.ecosystem !== candidate.ecosystem) reasons.push("current and candidate identities are not comparable");
  if (current.version === candidate.version) reasons.push("current and candidate versions are identical");
  if (current.treeSha256 === candidate.treeSha256) reasons.push("current and candidate artifact digests are identical");
  if (!canaries.length) reasons.push("at least one trusted canary is required");
  if (canaries.some((canary) => !canary.comparable)) reasons.push("one or more canaries lack a stable healthy baseline and complete candidate evidence");

  if (reasons.length) return { verdict: "HOLD", reasons, capabilities, canaries };
  const changes = capabilities.filter((item) => item.changed).length + canaries.filter((item) => item.changed).length;
  if (changes) {
    return {
      verdict: "CHANGED",
      reasons: [`${changes} material capability or canary observation change(s) were detected`],
      capabilities,
      canaries,
    };
  }
  return {
    verdict: "SAFE",
    reasons: ["no material change was detected by these exact canaries under the recorded contained runner"],
    capabilities,
    canaries,
  };
}
