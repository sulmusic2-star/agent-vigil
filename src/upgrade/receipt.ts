import {
  createPrivateKey,
  createPublicKey,
  createHash,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonical, VERSION } from "../report.ts";
import { publicKeyDer, signingKeyId, type VerificationResult } from "../signature.ts";
import { terminalSafe } from "./presentation.ts";
import {
  PRIVATE_RECEIPT_SCHEMA,
  PUBLIC_ENTRY_SCHEMA,
  trustedDirectoryInside,
  trustedRegularFileInside,
  validateUpgradeConfig,
  type UpgradeConfig,
  type UpgradeVerdict,
} from "./contracts.ts";
import { loadUpgradeConfig } from "./contracts.ts";
import {
  compareCanary,
  decideUpgrade,
  inspectArtifactTree,
  inspectTarget,
  type ArtifactInventory,
  type CapabilityChange,
  type CanaryComparison,
  type TargetSnapshot,
} from "./decision.ts";
import {
  commandDigest,
  probeContainment,
  resolveDockerClient,
  runCanaryTrial,
  type ContainmentProbe,
  type ResolvedDockerClient,
} from "./sandbox.ts";

export type UpgradePrivateReceipt = {
  schemaVersion: typeof PRIVATE_RECEIPT_SCHEMA;
  vigilVersion: string;
  generatedAt: string;
  nonce: string;
  component: { ecosystem: string; name: string };
  configSha256: string;
  runner: {
    engine: "docker";
    image: string;
    trials: number;
    network: "none";
    filesystem: "read-only";
    environment: "explicit";
  };
  containment: ContainmentProbe;
  current?: TargetSnapshot;
  candidate?: TargetSnapshot;
  canaryHarness?: ArtifactInventory;
  capabilities: CapabilityChange[];
  canaries: CanaryComparison[];
  summary: {
    verdict: UpgradeVerdict;
    reasons: string[];
    comparedCanaries: number;
    changedCanaries: number;
    changedCapabilities: number;
  };
  limitations: string[];
  receiptHash: string;
};

export type PublicSignature = {
  algorithm: "Ed25519";
  keyId: string;
  publicKey: string;
  value: string;
};

export type PublicCompatibilityEntry = {
  schemaVersion: typeof PUBLIC_ENTRY_SCHEMA;
  vigilVersion: string;
  generatedAt: string;
  component: {
    ecosystem: string;
    name: string;
    currentVersion: string;
    candidateVersion: string;
    currentArtifactSha256: string;
    candidateArtifactSha256: string;
  };
  runner: {
    imageDigest: string;
    trials: number;
    localEndpoint: boolean;
    networkBlocked: boolean;
    readOnly: boolean;
    environmentIsolated: boolean;
    configSha256: string;
    canaryHarnessSha256: string;
  };
  verdict: UpgradeVerdict;
  changedCapabilities: string[];
  canaries: Array<{
    publicId?: string;
    idSha256: string;
    current: "PASS" | "FAIL" | "HOLD";
    candidate: "PASS" | "FAIL" | "HOLD";
    matched: boolean;
  }>;
  privateReceiptCommitment: string;
  limitations: string[];
  entryHash: string;
  signature: PublicSignature;
};

const LIMITATIONS = [
  "The verdict applies only to the exact pre/post-stable artifacts, runner image, configuration, canary harness, and observations recorded here.",
  "SAFE means no material change was detected by these canaries; it is not a universal safety or semantic-correctness claim.",
  "The validated local-transport Docker endpoint, selected client, daemon/socket routing, host kernel, runner image, and trusted canary harness remain trust assumptions.",
  "Network-disabled offline canaries do not establish live provider, model-alias, authentication, or production behavior.",
];

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function publicCanaryPseudonym(receiptNonce: string, privateCanaryId: string): string {
  return hash(canonical({
    domain: "agent-vigil-public-canary-id/v1",
    receiptNonce,
    privateCanaryId,
  }));
}

function configDigest(config: UpgradeConfig): string {
  return hash(canonical(config));
}

function receiptPayload(receipt: Omit<UpgradePrivateReceipt, "receiptHash">): string {
  return canonical(receipt);
}

function finalizeReceipt(receipt: Omit<UpgradePrivateReceipt, "receiptHash">): UpgradePrivateReceipt {
  return { ...receipt, receiptHash: hash(receiptPayload(receipt)) };
}

function trustedDirectoryRoot(path: string, label: string): string {
  const requested = resolve(path);
  const status = lstatSync(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a regular directory, not a symbolic link`);
  }
  return realpathSync(requested);
}

function assertDisjointRoots(roots: Array<[label: string, path: string]>): void {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const [leftLabel, leftPath] = roots[left];
      const [rightLabel, rightPath] = roots[right];
      const leftToRight = relative(leftPath, rightPath);
      const rightToLeft = relative(rightPath, leftPath);
      const inside = (rel: string): boolean => rel === ""
        || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
      const overlap = inside(leftToRight) || inside(rightToLeft);
      if (overlap) throw new Error(`${leftLabel} and ${rightLabel} must be separate, non-overlapping directories`);
    }
  }
}

export function recomputeUpgradeReceiptHash(receipt: UpgradePrivateReceipt): string {
  const { receiptHash: _ignored, ...payload } = receipt;
  return hash(receiptPayload(payload));
}

function unevaluatedContainment(): ContainmentProbe {
  return {
    status: "HOLD", localEndpoint: false, imagePresent: false, networkBlocked: false, targetReadOnly: false,
    rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
    reason: "containment was not evaluated",
  };
}

type ConfigCheckpoint = {
  path: string;
  identity: string;
  config: UpgradeConfig;
};

function readConfigCheckpoint(repository: string, requestedPath: string): ConfigCheckpoint {
  const path = trustedRegularFileInside(repository, requestedPath, "upgrade config");
  const before = lstatSync(path, { bigint: true });
  const config = loadUpgradeConfig(path);
  const after = lstatSync(path, { bigint: true });
  const beforeIdentity = `${before.dev}:${before.ino}`;
  const afterIdentity = `${after.dev}:${after.ino}`;
  if (beforeIdentity !== afterIdentity) throw new Error("upgrade config moved or was replaced while it was being read");
  return { path, identity: afterIdentity, config };
}

function holdReceipt(
  config: UpgradeConfig,
  containment: ContainmentProbe,
  generatedAt: string,
  nonce: string,
  reason: string,
  current?: TargetSnapshot,
  candidate?: TargetSnapshot,
  canaryHarness?: ArtifactInventory,
): UpgradePrivateReceipt {
  return finalizeReceipt({
    schemaVersion: PRIVATE_RECEIPT_SCHEMA,
    vigilVersion: VERSION,
    generatedAt,
    nonce,
    component: { ecosystem: config.component.ecosystem, name: config.component.name },
    configSha256: configDigest(config),
    runner: {
      engine: "docker", image: config.runner.image, trials: config.runner.trials,
      network: "none", filesystem: "read-only", environment: "explicit",
    },
    containment,
    ...(current ? { current } : {}),
    ...(candidate ? { candidate } : {}),
    ...(canaryHarness ? { canaryHarness } : {}),
    capabilities: [],
    canaries: [],
    summary: {
      verdict: "HOLD",
      reasons: [reason],
      comparedCanaries: 0,
      changedCanaries: 0,
      changedCapabilities: 0,
    },
    limitations: LIMITATIONS,
  });
}

export function runUpgradeEvaluation(input: {
  configPath: string;
  config?: UpgradeConfig;
  repository: string;
  currentDirectory: string;
  candidateDirectory: string;
  dockerBin?: string;
  generatedAt?: string;
  nonce?: string;
}): UpgradePrivateReceipt {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  const suppliedConfig = input.config ? validateUpgradeConfig(input.config) : undefined;
  let configCheckpoint: ConfigCheckpoint;
  try {
    configCheckpoint = readConfigCheckpoint(input.repository, input.configPath);
  } catch (error) {
    if (!suppliedConfig) throw error;
    return holdReceipt(
      suppliedConfig,
      unevaluatedContainment(),
      generatedAt,
      nonce,
      `upgrade config could not be re-resolved and re-read at evaluation entry: ${(error as Error).message}`,
    );
  }
  const config = configCheckpoint.config;
  if (suppliedConfig && canonical(suppliedConfig) !== canonical(config)) {
    return holdReceipt(
      suppliedConfig,
      unevaluatedContainment(),
      generatedAt,
      nonce,
      "upgrade config no longer matches the validated configuration supplied by the caller",
    );
  }
  let current: TargetSnapshot | undefined;
  let candidate: TargetSnapshot | undefined;
  let canaryHarness: ArtifactInventory | undefined;
  const emptyContainment = unevaluatedContainment();
  let canaryDirectory: string;
  try {
    canaryDirectory = trustedDirectoryInside(
      input.repository,
      resolve(input.repository, config.canaryDirectory),
      "canary directory",
    );
  }
  catch (error) { return holdReceipt(config, emptyContainment, generatedAt, nonce, `canary directory could not be trusted: ${(error as Error).message}`); }
  let currentRoot: string;
  let candidateRoot: string;
  try {
    currentRoot = trustedDirectoryRoot(input.currentDirectory, "current artifact");
    candidateRoot = trustedDirectoryRoot(input.candidateDirectory, "candidate artifact");
    assertDisjointRoots([
      ["current artifact", currentRoot],
      ["candidate artifact", candidateRoot],
      ["canary harness", canaryDirectory],
    ]);
  } catch (error) {
    return holdReceipt(config, emptyContainment, generatedAt, nonce, (error as Error).message);
  }
  try { canaryHarness = inspectArtifactTree(canaryDirectory); }
  catch (error) { return holdReceipt(config, emptyContainment, generatedAt, nonce, `canary harness could not be inventoried: ${(error as Error).message}`); }
  try { current = inspectTarget(input.currentDirectory, config.component); }
  catch (error) { return holdReceipt(config, emptyContainment, generatedAt, nonce, `current artifact could not be inspected: ${(error as Error).message}`, undefined, undefined, canaryHarness); }
  try { candidate = inspectTarget(input.candidateDirectory, config.component); }
  catch (error) { return holdReceipt(config, emptyContainment, generatedAt, nonce, `candidate artifact could not be inspected: ${(error as Error).message}`, current, undefined, canaryHarness); }

  let dockerClient: ResolvedDockerClient;
  try {
    dockerClient = resolveDockerClient(input.dockerBin ?? "docker");
  } catch (error) {
    return holdReceipt(
      config,
      emptyContainment,
      generatedAt,
      nonce,
      `Docker client and local endpoint could not be bound for this evaluation: ${(error as Error).message}`,
      current,
      candidate,
      canaryHarness,
    );
  }

  const containment = probeContainment(
    config,
    input.currentDirectory,
    canaryDirectory,
    dockerClient,
  );
  const canaries: CanaryComparison[] = config.canaries.map((canary) => {
    const currentTrials = containment.status === "PASS"
      ? Array.from({ length: config.runner.trials }, () => runCanaryTrial(
          config, canary, input.currentDirectory, canaryDirectory, dockerClient,
        ))
      : [];
    const candidateTrials = containment.status === "PASS"
      ? Array.from({ length: config.runner.trials }, () => runCanaryTrial(
          config, canary, input.candidateDirectory, canaryDirectory, dockerClient,
        ))
      : [];
    return compareCanary(canary, commandDigest(canary), currentTrials, candidateTrials);
  });
  let mutationReason: string | undefined;
  try {
    const configAfter = readConfigCheckpoint(input.repository, input.configPath);
    if (configAfter.path !== configCheckpoint.path || configAfter.identity !== configCheckpoint.identity) {
      mutationReason = "upgrade config moved or was replaced while the evaluation was running";
    } else if (canonical(configAfter.config) !== canonical(config)) {
      mutationReason = "upgrade config changed while the evaluation was running";
    }
  } catch (error) {
    mutationReason = `upgrade config could not be re-resolved and re-read after evaluation: ${(error as Error).message}`;
  }
  try {
    const currentAfter = inspectTarget(input.currentDirectory, config.component);
    const candidateAfter = inspectTarget(input.candidateDirectory, config.component);
    const harnessAfter = inspectArtifactTree(canaryDirectory);
    if (!mutationReason && canonical(currentAfter) !== canonical(current)) mutationReason = "current artifact changed while the evaluation was running";
    else if (!mutationReason && canonical(candidateAfter) !== canonical(candidate)) mutationReason = "candidate artifact changed while the evaluation was running";
    else if (!mutationReason && canonical(harnessAfter) !== canonical(canaryHarness)) mutationReason = "canary harness changed while the evaluation was running";
  } catch (error) {
    if (!mutationReason) mutationReason = `evaluation inputs could not be re-inventoried: ${(error as Error).message}`;
  }
  const initialDecision = decideUpgrade(containment, current, candidate, canaries);
  const decision = mutationReason
    ? { ...initialDecision, verdict: "HOLD" as const, reasons: [mutationReason] }
    : initialDecision;
  return finalizeReceipt({
    schemaVersion: PRIVATE_RECEIPT_SCHEMA,
    vigilVersion: VERSION,
    generatedAt,
    nonce,
    component: { ecosystem: config.component.ecosystem, name: config.component.name },
    configSha256: configDigest(config),
    runner: {
      engine: "docker", image: config.runner.image, trials: config.runner.trials,
      network: "none", filesystem: "read-only", environment: "explicit",
    },
    containment,
    current,
    candidate,
    canaryHarness,
    capabilities: decision.capabilities,
    canaries,
    summary: {
      verdict: decision.verdict,
      reasons: decision.reasons,
      comparedCanaries: canaries.filter((canary) => canary.comparable).length,
      changedCanaries: canaries.filter((canary) => canary.changed).length,
      changedCapabilities: decision.capabilities.filter((capability) => capability.changed).length,
    },
    limitations: LIMITATIONS,
  });
}

const PUBLIC_CAPABILITIES = new Set(["tools", "hooks", "mcpServers", "permissions", "skills", "agents", "commands", "dependencies"]);

function publicCapability(field: string): string {
  const leaf = field.split(".").at(-1) ?? "other";
  return PUBLIC_CAPABILITIES.has(leaf) ? leaf : "other";
}

function publicEntryPayload(entry: Omit<PublicCompatibilityEntry, "entryHash" | "signature">): string {
  return canonical(entry);
}

export function createPublicCompatibilityEntry(receipt: UpgradePrivateReceipt, privateKeyPath: string): PublicCompatibilityEntry {
  if (recomputeUpgradeReceiptHash(receipt) !== receipt.receiptHash) throw new Error("private upgrade receipt hash is invalid");
  if (!receipt.current || !receipt.candidate || !receipt.canaryHarness) {
    throw new Error("public compatibility output requires exact current, candidate, and canary harness identities");
  }
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("public compatibility signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  const unsigned = {
    schemaVersion: PUBLIC_ENTRY_SCHEMA,
    vigilVersion: receipt.vigilVersion,
    generatedAt: receipt.generatedAt,
    component: {
      ecosystem: receipt.current.ecosystem,
      name: receipt.current.name,
      currentVersion: receipt.current.version,
      candidateVersion: receipt.candidate.version,
      currentArtifactSha256: receipt.current.treeSha256,
      candidateArtifactSha256: receipt.candidate.treeSha256,
    },
    runner: {
      imageDigest: receipt.runner.image.slice(receipt.runner.image.lastIndexOf("@") + 1),
      trials: receipt.runner.trials,
      localEndpoint: receipt.containment.localEndpoint,
      networkBlocked: receipt.containment.networkBlocked,
      readOnly: receipt.containment.targetReadOnly && receipt.containment.rootReadOnly,
      environmentIsolated: receipt.containment.inheritedSecretAbsent && receipt.containment.proxiesCleared,
      configSha256: receipt.configSha256,
      canaryHarnessSha256: receipt.canaryHarness.treeSha256,
    },
    verdict: receipt.summary.verdict,
    changedCapabilities: [...new Set(receipt.capabilities.filter((item) => item.changed).map((item) => publicCapability(item.field)))].sort(),
    canaries: receipt.canaries.map((canary) => ({
      ...(canary.publicId ? { publicId: canary.publicId } : {}),
      idSha256: publicCanaryPseudonym(receipt.nonce, canary.id),
      current: canary.current.state,
      candidate: canary.candidate.state,
      matched: canary.comparable && !canary.changed,
    })),
    privateReceiptCommitment: receipt.receiptHash,
    limitations: receipt.limitations,
  } satisfies Omit<PublicCompatibilityEntry, "entryHash" | "signature">;
  const entryHash = hash(publicEntryPayload(unsigned));
  const entry: PublicCompatibilityEntry = {
    ...unsigned,
    entryHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(entryHash), privateKey).toString("base64"),
    },
  };
  validatePublicCompatibilityEntry(entry);
  return entry;
}

export function verifyPublicCompatibilityEntry(entry: PublicCompatibilityEntry, publicKeyPath?: string): VerificationResult {
  const { entryHash: _hash, signature: _signature, ...unsigned } = entry;
  const hashValid = hash(publicEntryPayload(unsigned)) === entry.entryHash;
  if (entry.signature.algorithm !== "Ed25519") return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  try {
    const embedded = createPublicKey({ key: Buffer.from(entry.signature.publicKey, "base64"), type: "spki", format: "der" });
    const embeddedId = signingKeyId(publicKeyDer(embedded));
    const selected = publicKeyPath ? createPublicKey(readFileSync(publicKeyPath)) : embedded;
    const selectedId = signingKeyId(publicKeyDer(selected));
    const signatureValid = embeddedId === entry.signature.keyId
      && selectedId === embeddedId
      && verify(null, Buffer.from(entry.entryHash), selected, Buffer.from(entry.signature.value, "base64"));
    return { hashValid, signatureValid, keyPinned: Boolean(publicKeyPath), keyId: selectedId };
  } catch {
    return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function patternedText(value: unknown, label: string, pattern: RegExp, maximum = 512): string {
  const result = text(value, label, maximum);
  if (!pattern.test(result)) throw new Error(`${label} has an unsupported value`);
  return result;
}

function sha256Text(value: unknown, label: string): string {
  return patternedText(value, label, /^sha256:[0-9a-f]{64}$/, 71);
}

export function validatePublicCompatibilityEntry(input: unknown): PublicCompatibilityEntry {
  const root = record(input, "public compatibility entry");
  exact(root, ["schemaVersion", "vigilVersion", "generatedAt", "component", "runner", "verdict", "changedCapabilities", "canaries", "privateReceiptCommitment", "limitations", "entryHash", "signature"], "public compatibility entry");
  if (root.schemaVersion !== PUBLIC_ENTRY_SCHEMA) throw new Error(`public entry schemaVersion must be ${PUBLIC_ENTRY_SCHEMA}`);
  if (!new Set(["SAFE", "CHANGED", "HOLD"]).has(String(root.verdict))) throw new Error("public entry verdict is invalid");
  const component = record(root.component, "public entry component");
  exact(component, ["ecosystem", "name", "currentVersion", "candidateVersion", "currentArtifactSha256", "candidateArtifactSha256"], "public entry component");
  const runner = record(root.runner, "public entry runner");
  exact(runner, ["imageDigest", "trials", "localEndpoint", "networkBlocked", "readOnly", "environmentIsolated", "configSha256", "canaryHarnessSha256"], "public entry runner");
  if (!Number.isInteger(runner.trials) || Number(runner.trials) < 2 || Number(runner.trials) > 5) throw new Error("public entry trials are invalid");
  for (const field of ["localEndpoint", "networkBlocked", "readOnly", "environmentIsolated"] as const) {
    if (typeof runner[field] !== "boolean") throw new Error(`public entry runner.${field} must be boolean`);
  }
  if (!Array.isArray(root.changedCapabilities) || root.changedCapabilities.length > 16 || root.changedCapabilities.some((item) => typeof item !== "string" || !new Set([...PUBLIC_CAPABILITIES, "other"]).has(item))) {
    throw new Error("public entry changedCapabilities are invalid");
  }
  if (new Set(root.changedCapabilities).size !== root.changedCapabilities.length) throw new Error("public entry changedCapabilities contain duplicates");
  if (!Array.isArray(root.canaries) || root.canaries.length > 32) throw new Error("public entry canaries are invalid");
  const canaries = root.canaries.map((item, index) => {
    const canary = record(item, `public entry canaries[${index}]`);
    exact(canary, ["publicId", "idSha256", "current", "candidate", "matched"], `public entry canaries[${index}]`);
    if (!new Set(["PASS", "FAIL", "HOLD"]).has(String(canary.current)) || !new Set(["PASS", "FAIL", "HOLD"]).has(String(canary.candidate))) {
      throw new Error(`public entry canaries[${index}] has an invalid state`);
    }
    if (typeof canary.matched !== "boolean") throw new Error(`public entry canaries[${index}].matched must be boolean`);
    return {
      ...(canary.publicId === undefined ? {} : { publicId: patternedText(canary.publicId, `public entry canaries[${index}].publicId`, /^[a-z0-9][a-z0-9._-]*$/, 80) }),
      idSha256: sha256Text(canary.idSha256, `public entry canaries[${index}].idSha256`),
      current: canary.current as "PASS" | "FAIL" | "HOLD",
      candidate: canary.candidate as "PASS" | "FAIL" | "HOLD",
      matched: canary.matched,
    };
  });
  const signature = record(root.signature, "public entry signature");
  exact(signature, ["algorithm", "keyId", "publicKey", "value"], "public entry signature");
  if (signature.algorithm !== "Ed25519") throw new Error("public entry signature algorithm must be Ed25519");
  if (!Array.isArray(root.limitations) || root.limitations.length > 16 || root.limitations.some((item) => typeof item !== "string" || item.length > 1_024)) {
    throw new Error("public entry limitations are invalid");
  }
  const generatedAt = text(root.generatedAt, "public entry generatedAt", 64);
  if (!Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error("public entry generatedAt must be an exact UTC ISO timestamp");
  }
  const entry: PublicCompatibilityEntry = {
    schemaVersion: PUBLIC_ENTRY_SCHEMA,
    vigilVersion: patternedText(root.vigilVersion, "public entry vigilVersion", /^[0-9][0-9A-Za-z.+-]*$/, 40),
    generatedAt,
    component: {
      ecosystem: patternedText(component.ecosystem, "public entry component.ecosystem", /^[a-z0-9][a-z0-9._-]*$/, 80),
      name: patternedText(component.name, "public entry component.name", /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/, 160),
      currentVersion: text(component.currentVersion, "public entry currentVersion", 128),
      candidateVersion: text(component.candidateVersion, "public entry candidateVersion", 128),
      currentArtifactSha256: sha256Text(component.currentArtifactSha256, "public entry currentArtifactSha256"),
      candidateArtifactSha256: sha256Text(component.candidateArtifactSha256, "public entry candidateArtifactSha256"),
    },
    runner: {
      imageDigest: sha256Text(runner.imageDigest, "public entry runner.imageDigest"),
      trials: Number(runner.trials),
      localEndpoint: runner.localEndpoint as boolean,
      networkBlocked: runner.networkBlocked as boolean,
      readOnly: runner.readOnly as boolean,
      environmentIsolated: runner.environmentIsolated as boolean,
      configSha256: sha256Text(runner.configSha256, "public entry runner.configSha256"),
      canaryHarnessSha256: sha256Text(runner.canaryHarnessSha256, "public entry runner.canaryHarnessSha256"),
    },
    verdict: root.verdict as UpgradeVerdict,
    changedCapabilities: root.changedCapabilities as string[],
    canaries,
    privateReceiptCommitment: sha256Text(root.privateReceiptCommitment, "public entry privateReceiptCommitment"),
    limitations: root.limitations as string[],
    entryHash: sha256Text(root.entryHash, "public entry entryHash"),
    signature: {
      algorithm: "Ed25519",
      keyId: sha256Text(signature.keyId, "public entry signature.keyId"),
      publicKey: text(signature.publicKey, "public entry signature.publicKey", 512),
      value: text(signature.value, "public entry signature.value", 512),
    },
  };
  if (new Set(canaries.map((canary) => canary.idSha256)).size !== canaries.length) throw new Error("public entry canary pseudonyms contain duplicates");
  const publicIds = canaries.flatMap((canary) => canary.publicId ? [canary.publicId] : []);
  if (new Set(publicIds).size !== publicIds.length) throw new Error("public entry canary public IDs contain duplicates");
  if (entry.component.currentVersion === entry.component.candidateVersion || entry.component.currentArtifactSha256 === entry.component.candidateArtifactSha256) {
    throw new Error("public entry must compare distinct exact versions and artifacts");
  }
  if (entry.verdict === "SAFE") {
    if (!entry.runner.localEndpoint || !entry.runner.networkBlocked || !entry.runner.readOnly || !entry.runner.environmentIsolated || !entry.canaries.length
      || entry.changedCapabilities.length || entry.canaries.some((canary) => canary.current !== "PASS" || canary.candidate !== "PASS" || !canary.matched)) {
      throw new Error("SAFE public entry is inconsistent with its containment or canary evidence");
    }
  }
  return entry;
}

export { terminalSafe } from "./presentation.ts";

export function renderUpgradeReceipt(receipt: UpgradePrivateReceipt): string {
  const safe = (value: string): string => terminalSafe(value);
  const lines = [
    `Agent Vigil Upgrade Guard ${safe(receipt.vigilVersion)}`,
    `  component: ${safe(receipt.component.name)}`,
    `  versions:  ${safe(receipt.current?.version ?? "unknown")} -> ${safe(receipt.candidate?.version ?? "unknown")}`,
    `  runner:    ${safe(receipt.runner.image)}`,
    `  canaries:  ${receipt.summary.comparedCanaries} comparable; ${receipt.summary.changedCanaries} changed`,
    `  surfaces:  ${receipt.summary.changedCapabilities} capability class change(s)`,
    `  ${safe(receipt.summary.verdict)} · ${safe(receipt.receiptHash)}`,
  ];
  for (const reason of receipt.summary.reasons) lines.push(`  ${receipt.summary.verdict === "SAFE" ? "✓" : receipt.summary.verdict === "CHANGED" ? "!" : "?"} ${safe(reason)}`);
  lines.push("  SAFE is bounded to these exact artifacts, canaries, and contained runner; it is not a universal safety claim.");
  return `${lines.join("\n")}\n`;
}

function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderBreakageIndex(entries: PublicCompatibilityEntry[]): string {
  const ordered = [...entries].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  const rows = ordered.map((entry) => `<tr>
    <td><strong>${html(entry.component.name)}</strong><small>${html(entry.component.ecosystem)}</small></td>
    <td>${html(entry.component.currentVersion)} <span aria-hidden="true">→</span> ${html(entry.component.candidateVersion)}</td>
    <td><span class="status ${entry.verdict.toLowerCase()}">${html(entry.verdict)}</span></td>
    <td>${entry.canaries.filter((canary) => canary.matched).length}/${entry.canaries.length}</td>
    <td>${html(entry.changedCapabilities.join(", ") || "none observed")}</td>
    <td><code>${html(entry.entryHash.slice(0, 22))}…</code></td>
  </tr>`).join("\n");
  const safe = ordered.filter((entry) => entry.verdict === "SAFE").length;
  const changed = ordered.filter((entry) => entry.verdict === "CHANGED").length;
  const hold = ordered.filter((entry) => entry.verdict === "HOLD").length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Agent compatibility evidence</title><style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:1120px;margin:0 auto;padding:48px 24px;background:#07111f;color:#e7eef8}h1{font-size:clamp(2rem,5vw,4rem);margin:0 0 12px}.lede{max-width:760px;color:#a9b8ca;font-size:1.1rem;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:32px 0}.card{padding:20px;border:1px solid #2a3a50;border-radius:16px;background:#0d1a2b}.card strong{display:block;font-size:2rem}.table{overflow:auto;border:1px solid #2a3a50;border-radius:16px}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:15px;border-bottom:1px solid #213147}th{color:#93a7bf;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}td small{display:block;color:#7f94ac;margin-top:4px}.status{font-weight:800}.safe{color:#69e6a6}.changed{color:#ffcb6b}.hold{color:#ff8e9b}code{color:#b8c7db}footer{margin-top:28px;color:#8598ae;font-size:.9rem}@media(max-width:640px){body{padding:28px 16px}.cards{grid-template-columns:1fr}}
</style></head><body><main><h1>Agent compatibility evidence</h1>
<p class="lede">Signed, privacy-minimized results for exact coding-agent dependency version pairs. SAFE means no material change was detected by the recorded canaries under the recorded contained runner—not that an update is universally safe.</p>
<section class="cards" aria-label="Verdict counts"><div class="card"><strong>${safe}</strong>SAFE</div><div class="card"><strong>${changed}</strong>CHANGED</div><div class="card"><strong>${hold}</strong>HOLD</div></section>
<section class="table"><table><thead><tr><th>Component</th><th>Version pair</th><th>Verdict</th><th>Matched canaries</th><th>Changed surfaces</th><th>Entry commitment</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No signed entries were supplied.</td></tr>'}</tbody></table></section>
<footer>Generated by Agent Vigil Upgrade Guard. Raw repositories, commands, outputs, prompts, paths, and secrets are excluded from public entries.</footer></main></body></html>`;
}

export function privateReceiptDirectory(path: string): string {
  return dirname(resolve(path));
}
