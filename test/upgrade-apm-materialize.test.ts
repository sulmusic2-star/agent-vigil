import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonical } from "../src/report.ts";
import {
  parseApmGitHubArchive,
  recomputeApmPreflightReceiptHash,
  runApmAutomaticPreflight,
  validateBoundApmAutomaticPreflightReceipt,
  type ArchiveFetcher,
} from "../src/upgrade/apm-materialize.ts";
import { inspectArtifactTree, inspectTarget, type TargetSnapshot } from "../src/upgrade/decision.ts";
import { loadUpgradeConfig } from "../src/upgrade/contracts.ts";
import { createUpdatePlan } from "../src/upgrade/manager-plan.ts";
import {
  recomputeUpgradeReceiptHash,
  type UpgradePrivateReceipt,
} from "../src/upgrade/receipt.ts";
import { runUpgradeCommand } from "../src/upgrade/cli.ts";
import { commandDigest } from "../src/upgrade/sandbox.ts";
import { withoutInheritedNodeCoverage } from "./subprocess-env.ts";

const IMAGE = `node:22@sha256:${"a".repeat(64)}`;

function temp(prefix = "vigil-apm-materialize-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

function tarHeader(name: string, size: number, type: "0" | "2" | "5" | "g", mode: number): Buffer {
  assert.ok(Buffer.byteLength(name) <= 100, "fixture path exceeds basic tar header");
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  octal(mode, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "binary");
  block.write("00", 263, 2, "ascii");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(block, 148);
  return block;
}

function archive(
  commit: string,
  files: Record<string, string>,
  extra?: { path: string; type: "2" | "5" },
  paxCommit?: string,
): Buffer {
  const root = `fixture-${commit}`;
  const blocks: Buffer[] = [];
  if (paxCommit) {
    const pax = Buffer.from(`52 comment=${paxCommit}\n`, "utf8");
    assert.equal(pax.length, 52);
    blocks.push(tarHeader("pax_global_header", pax.length, "g", 0o666), pax, Buffer.alloc(512 - pax.length));
  }
  blocks.push(tarHeader(root, 0, "5", 0o775));
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  for (const directory of [...directories].sort()) {
    blocks.push(tarHeader(`${root}/${directory}`, 0, "5", 0o775));
  }
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.from(content, "utf8");
    blocks.push(tarHeader(`${root}/${path}`, bytes.length, "0", 0o664), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  if (extra) blocks.push(tarHeader(`${root}/${extra.path}`, 0, extra.type, 0o777));
  blocks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(blocks));
}

test("GitHub codeload's exact global PAX commit header is metadata, not an archive-root entry", () => {
  const commit = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
  const plain = parseApmGitHubArchive(archive(commit, { README: "Hello World!\n" }));
  const codeload = parseApmGitHubArchive(archive(commit, { README: "Hello World!\n" }, undefined, commit));
  assert.equal(codeload.paxCommit, commit);
  assert.equal(codeload.treeSha256, plain.treeSha256);
  assert.equal(codeload.treeSha256, "sha256:d81ff032f90a3e47b11fede18685a9ac8fd7ea477d24e113622d20ee847e59bd");
});

test("opt-in live GitHub codeload archive parses with an independently calculated tree commitment", {
  skip: process.env.VIGIL_APM_NETWORK_TESTS !== "1" || process.platform === "win32",
}, () => {
  const commit = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
  const fetched = spawnSync("/usr/bin/curl", [
    "-q", "--fail", "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https",
    "--max-redirs", "0", `https://codeload.github.com/octocat/Hello-World/tar.gz/${commit}`,
  ], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(fetched.status, 0, fetched.stderr.toString("utf8"));
  const parsed = parseApmGitHubArchive(fetched.stdout);
  assert.equal(parsed.paxCommit, commit);
  assert.equal(parsed.treeSha256, "sha256:d81ff032f90a3e47b11fede18685a9ac8fd7ea477d24e113622d20ee847e59bd");
});

function lock(path: string, commit: string, treeSha256?: string, extra = ""): void {
  writeFileSync(path, [
    'lockfile_version: "1"',
    "dependencies:",
    "  - repo_url: example/fixture",
    "    host: github.com",
    `    resolved_commit: ${commit}`,
    ...(treeSha256 ? [`    tree_sha256: ${treeSha256}`] : []),
    ...(extra ? [`    ${extra}`] : []),
    "",
  ].join("\n"));
}

function apmRow(repository: string, commit: string, treeSha256: string, extra: string[] = []): string[] {
  return [
    `  - repo_url: ${repository}`,
    "    host: github.com",
    `    resolved_commit: ${commit}`,
    `    tree_sha256: ${treeSha256}`,
    ...extra.map((line) => `    ${line}`),
  ];
}

function lockRows(path: string, rows: string[][], workspace: string[] = []): void {
  writeFileSync(path, [
    'lockfile_version: "1"',
    ...workspace,
    "dependencies:",
    ...rows.flat(),
    "",
  ].join("\n"));
}

function target(directory: string): TargetSnapshot {
  return inspectTarget(directory, {
    ecosystem: "agent-plugin",
    name: "fixture-agent",
    manifestPath: "package.json",
    identityField: "name",
    versionField: "version",
    capabilityFields: ["tools"],
  });
}

function fakeReceipt(
  currentDirectory: string,
  candidateDirectory: string,
  generatedAt: string,
  nonce: string,
  repository: string,
  configPath: string,
): UpgradePrivateReceipt {
  const config = loadUpgradeConfig(configPath);
  const current = target(currentDirectory);
  const candidate = target(candidateDirectory);
  const stable = {
    state: "PASS" as const,
    observationSha256: digest("stable-observation"),
    observationCount: 1,
    trials: 2,
    stable: true,
    reason: "repeated trials produced one stable observation",
  };
  const value: UpgradePrivateReceipt = {
    schemaVersion: "agent-vigil-upgrade-receipt/v1",
    vigilVersion: "0.15.0-test",
    generatedAt,
    nonce,
    component: { ecosystem: config.component.ecosystem, name: config.component.name },
    configSha256: digest(canonical(config)),
    runner: {
      engine: "docker", image: config.runner.image, trials: config.runner.trials,
      network: "none", filesystem: "read-only", environment: "explicit",
    },
    containment: {
      status: "PASS", localEndpoint: true, imagePresent: true, networkBlocked: true,
      targetReadOnly: true, rootReadOnly: true, inheritedSecretAbsent: true,
      proxiesCleared: true, reason: "contained",
    },
    current,
    candidate,
    canaryHarness: inspectArtifactTree(join(repository, config.canaryDirectory)),
    capabilities: [{
      field: "tools",
      currentCount: current.capabilities[0].count,
      candidateCount: candidate.capabilities[0].count,
      changed: current.capabilities[0].sha256 !== candidate.capabilities[0].sha256,
    }],
    canaries: [{
      id: config.canaries[0].id, publicId: config.canaries[0].publicId,
      idSha256: digest(config.canaries[0].id),
      commandSha256: commandDigest(config.canaries[0]), current: { ...stable }, candidate: { ...stable },
      changed: false, comparable: true,
    }],
    summary: {
      verdict: "SAFE", reasons: ["no material change was detected by these exact canaries under the recorded contained runner"],
      comparedCanaries: 1, changedCanaries: 0, changedCapabilities: 0,
    },
    limitations: ["Bounded fixture."],
    receiptHash: "",
  };
  value.receiptHash = recomputeUpgradeReceiptHash(value);
  return value;
}

function fixture() {
  const repository = temp();
  const workDirectory = join(repository, "work");
  const currentLockPath = join(repository, "current.lock.yaml");
  const candidateLockPath = join(repository, "candidate.lock.yaml");
  const configPath = join(repository, "config.json");
  const currentCommit = "a".repeat(40);
  const candidateCommit = "b".repeat(40);
  mkdirSync(join(repository, "canaries"));
  writeFileSync(join(repository, "canaries", "behavior.mjs"), "process.stdout.write('{}')\n");
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: "agent-vigil-upgrade-config/v1",
    component: {
      ecosystem: "agent-plugin",
      name: "fixture-agent",
      manifestPath: "package.json",
      identityField: "name",
      versionField: "version",
      capabilityFields: ["tools"],
    },
    runner: {
      engine: "docker",
      image: IMAGE,
      trials: 2,
      memoryMiB: 256,
      cpus: 1,
      pids: 64,
    },
    canaryDirectory: "canaries",
    canaries: [{
      id: "behavior",
      publicId: "behavior-v1",
      command: ["node", "/canaries/behavior.mjs"],
      timeoutSeconds: 30,
    }],
  }, null, 2)}\n`);
  return {
    repository, workDirectory, currentLockPath, candidateLockPath, configPath,
    currentCommit, candidateCommit,
  };
}

test("automatic APM preflight binds fetch, tree, plan, check, and restoration without disclosing the source route", () => {
  const value = fixture();
  mkdirSync(value.workDirectory);
  const currentArchive = archive(value.currentCommit, {
    "package.json": `${JSON.stringify({ name: "fixture-agent", version: "1.0.0", tools: ["read"] })}\n`,
    "behavior.txt": "stable\n",
  });
  const candidateArchive = archive(value.candidateCommit, {
    "package.json": `${JSON.stringify({ name: "fixture-agent", version: "1.1.0", tools: ["read"] })}\n`,
    "behavior.txt": "stable\n",
  });
  const supportedMetadata = "materialization_repo_url: Example/Fixture\n    is_dev: false\n    target_subset:\n      - codex";
  lock(value.currentLockPath, value.currentCommit, parseApmGitHubArchive(currentArchive).treeSha256, supportedMetadata);
  lock(value.candidateLockPath, value.candidateCommit, parseApmGitHubArchive(candidateArchive).treeSha256, supportedMetadata);
  const fetched: string[] = [];
  const fetchArchive: ArchiveFetcher = (url, destination) => {
    fetched.push(url);
    writeFileSync(destination, url.endsWith(value.currentCommit) ? currentArchive : candidateArchive);
  };
  let materializedRoots: string[] = [];
  const receipt = runApmAutomaticPreflight({
    repository: value.repository,
    currentLockPath: value.currentLockPath,
    candidateLockPath: value.candidateLockPath,
    configPath: value.configPath,
    workDirectory: value.workDirectory,
    generatedAt: "2026-08-23T20:00:00.000Z",
    nonce: "automatic-apm-test-nonce",
  }, {
    fetchArchive,
    evaluate: (input) => {
      materializedRoots = [input.currentDirectory, input.candidateDirectory];
      assert.ok(materializedRoots.every(existsSync));
      return fakeReceipt(
        input.currentDirectory,
        input.candidateDirectory,
        input.generatedAt!,
        input.nonce!,
        value.repository,
        value.configPath,
      );
    },
  });
  assert.equal(receipt.summary.verdict, "SAFE");
  assert.deepEqual(receipt.summary.reasonCodes, ["NO_MATERIAL_CHANGE"]);
  assert.equal(receipt.restoration.status, "RESTORED");
  assert.equal(receipt.restoration.sessionRemoved, true);
  assert.ok(materializedRoots.every((path) => !existsSync(path)));
  assert.equal(readdirSync(value.workDirectory).length, 0);
  assert.equal(fetched.length, 2);
  assert.ok(fetched.every((url) => /^https:\/\/codeload\.github\.com\/Example\/Fixture\/tar\.gz\/[ab]{40}$/.test(url)));
  assert.equal(receipt.materialization?.current?.fetchedSha256, `sha256:${createHash("sha256").update(currentArchive).digest("hex")}`);
  assert.equal(receipt.materialization?.candidate?.materializedTreeSha256, parseApmGitHubArchive(candidateArchive).treeSha256);
  assert.equal(receipt.materialization?.current?.manifestEvidence.path, "package.json");
  assert.deepEqual(
    Buffer.from(receipt.materialization!.current!.manifestEvidence.contentBase64, "base64"),
    Buffer.from(`${JSON.stringify({ name: "fixture-agent", version: "1.0.0", tools: ["read"] })}\n`),
  );
  assert.ok(Buffer.byteLength(`${JSON.stringify(receipt, null, 2)}\n`) < 4 * 1024 * 1024);
  assert.equal(recomputeApmPreflightReceiptHash(receipt), receipt.receiptHash);
  const trustedContext = { repository: value.repository, configPath: value.configPath };
  assert.equal(
    validateBoundApmAutomaticPreflightReceipt(
      receipt,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ).receiptHash,
    receipt.receiptHash,
  );
  const receiptPath = join(value.repository, "bound-preflight.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    assert.equal(runUpgradeCommand([
      "verify-preflight", receiptPath,
      "--current-lock", value.currentLockPath,
      "--candidate-lock", value.candidateLockPath,
      "--repo", value.repository,
      "--config", "config.json",
    ]), 0);
  } finally { process.stdout.write = originalWrite; }
  const bundledVerify = spawnSync(process.execPath, [
    resolve("dist/cli.js"), "upgrade", "verify-preflight", receiptPath,
    "--current-lock", value.currentLockPath,
    "--candidate-lock", value.candidateLockPath,
    "--repo", value.repository,
    "--config", "config.json",
  ], { encoding: "utf8", env: withoutInheritedNodeCoverage() });
  assert.equal(bundledVerify.status, 0, bundledVerify.stderr);
  assert.deepEqual(JSON.parse(bundledVerify.stdout), {
    schemaVersion: "agent-vigil-apm-preflight/v1",
    verdict: "SAFE",
    receiptHash: receipt.receiptHash,
    valid: true,
  });
  const wrongExitVerdict = structuredClone(receipt);
  wrongExitVerdict.summary.verdict = "CHANGED";
  wrongExitVerdict.summary.reasonCodes = ["MATERIAL_CHANGE_DETECTED"];
  wrongExitVerdict.receiptHash = recomputeApmPreflightReceiptHash(wrongExitVerdict);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(wrongExitVerdict, value.currentLockPath, value.candidateLockPath, {
      repository: value.repository,
      configPath: value.configPath,
    }),
    /nested receipt binding|nested decision|nested receipt summary/,
  );
  const wrongCommit = structuredClone(receipt);
  wrongCommit.materialization!.candidate!.commit = "c".repeat(40);
  wrongCommit.receiptHash = recomputeApmPreflightReceiptHash(wrongCommit);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(wrongCommit, value.currentLockPath, value.candidateLockPath, {
      repository: value.repository,
      configPath: value.configPath,
    }),
    /materialization does not match/,
  );
  const forgedManifestEvidence = structuredClone(receipt);
  forgedManifestEvidence.materialization!.current!.manifestEvidence.contentBase64 = Buffer.from(
    `${JSON.stringify({ name: "fixture-agent", version: "9.9.9", tools: [] })}\n`,
  ).toString("base64");
  forgedManifestEvidence.receiptHash = recomputeApmPreflightReceiptHash(forgedManifestEvidence);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedManifestEvidence,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /does not match the exact selected-tree file commitment/,
  );
  const substitutedManifestPath = structuredClone(receipt);
  substitutedManifestPath.materialization!.current!.manifestEvidence = {
    path: "behavior.txt",
    contentBase64: Buffer.from("stable\n").toString("base64"),
  };
  substitutedManifestPath.upgradeReceipt!.current!.manifestSha256 = digest("stable\n");
  substitutedManifestPath.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(substitutedManifestPath.upgradeReceipt!);
  substitutedManifestPath.receiptHash = recomputeApmPreflightReceiptHash(substitutedManifestPath);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      substitutedManifestPath,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /does not match the trusted manifest path/,
  );
  const forgedManifestHash = structuredClone(receipt);
  forgedManifestHash.upgradeReceipt!.current!.manifestSha256 = digest("forged current manifest");
  forgedManifestHash.upgradeReceipt!.candidate!.manifestSha256 = digest("forged candidate manifest");
  forgedManifestHash.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(forgedManifestHash.upgradeReceipt!);
  forgedManifestHash.receiptHash = recomputeApmPreflightReceiptHash(forgedManifestHash);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedManifestHash,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /selected artifact binding/,
  );
  const forgedVersions = structuredClone(receipt);
  forgedVersions.upgradeReceipt!.current!.version = "9.9.8";
  forgedVersions.upgradeReceipt!.candidate!.version = "9.9.9";
  forgedVersions.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(forgedVersions.upgradeReceipt!);
  forgedVersions.receiptHash = recomputeApmPreflightReceiptHash(forgedVersions);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedVersions,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /nested target is not derived from the exact selected-tree manifest evidence/,
  );
  const forgedCapabilities = structuredClone(receipt);
  for (const side of ["current", "candidate"] as const) {
    forgedCapabilities.upgradeReceipt![side]!.capabilities[0].count = 99;
    forgedCapabilities.upgradeReceipt![side]!.capabilities[0].sha256 = digest("forged capability");
  }
  forgedCapabilities.upgradeReceipt!.capabilities[0].currentCount = 99;
  forgedCapabilities.upgradeReceipt!.capabilities[0].candidateCount = 99;
  forgedCapabilities.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(forgedCapabilities.upgradeReceipt!);
  forgedCapabilities.receiptHash = recomputeApmPreflightReceiptHash(forgedCapabilities);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedCapabilities,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /nested target is not derived from the exact selected-tree manifest evidence/,
  );
  const forgedContainment = structuredClone(receipt);
  Object.assign(forgedContainment.upgradeReceipt!.containment, {
    networkBlocked: false,
    targetReadOnly: false,
    rootReadOnly: false,
    inheritedSecretAbsent: false,
    proxiesCleared: false,
  });
  forgedContainment.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(forgedContainment.upgradeReceipt!);
  forgedContainment.receiptHash = recomputeApmPreflightReceiptHash(forgedContainment);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedContainment,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /containment controls|nested receipt decision/,
  );
  const forgedComparison = structuredClone(receipt);
  forgedComparison.upgradeReceipt!.canaries[0].candidate.state = "FAIL";
  forgedComparison.upgradeReceipt!.canaries[0].candidate.observationSha256 = digest("different observation");
  forgedComparison.upgradeReceipt!.canaries[0].changed = false;
  forgedComparison.upgradeReceipt!.canaries[0].comparable = true;
  forgedComparison.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(forgedComparison.upgradeReceipt!);
  forgedComparison.receiptHash = recomputeApmPreflightReceiptHash(forgedComparison);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedComparison,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /comparison is not derived/,
  );
  const forgedCommand = structuredClone(receipt);
  forgedCommand.upgradeReceipt!.canaries[0].commandSha256 = digest("attacker command");
  forgedCommand.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(forgedCommand.upgradeReceipt!);
  forgedCommand.receiptHash = recomputeApmPreflightReceiptHash(forgedCommand);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedCommand,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /trusted upgrade configuration/,
  );
  const forgedIdentity = structuredClone(receipt);
  Object.assign(forgedIdentity.upgradeReceipt!.current!, {
    ecosystem: "forged-ecosystem",
    name: "forged-component",
    version: "999.0.0",
  });
  Object.assign(forgedIdentity.upgradeReceipt!.candidate!, {
    ecosystem: "forged-ecosystem",
    name: "forged-component",
    version: "999.0.1",
  });
  forgedIdentity.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(forgedIdentity.upgradeReceipt!);
  forgedIdentity.receiptHash = recomputeApmPreflightReceiptHash(forgedIdentity);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedIdentity,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /trusted upgrade configuration/,
  );
  const forgedTrees = structuredClone(receipt);
  for (const [side, label] of [["current", "forged-current"], ["candidate", "forged-candidate"]] as const) {
    const inventory = { treeSha256: digest(label), fileCount: 0, totalBytes: 0 };
    forgedTrees.materialization![side]!.selectedArtifact = inventory;
    Object.assign(forgedTrees.upgradeReceipt![side]!, inventory);
  }
  forgedTrees.upgradeReceipt!.receiptHash = recomputeUpgradeReceiptHash(forgedTrees.upgradeReceipt!);
  forgedTrees.receiptHash = recomputeApmPreflightReceiptHash(forgedTrees);
  assert.throws(
    () => validateBoundApmAutomaticPreflightReceipt(
      forgedTrees,
      value.currentLockPath,
      value.candidateLockPath,
      trustedContext,
    ),
    /exact lock-bound repository tree/,
  );
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /github\.com\/example\/fixture/);
  assert.doesNotMatch(serialized, /codeload/);
});

test("automatic APM preflight returns HOLD before fetch for unbound or unsupported source rows", () => {
  for (const fixtureCase of [
    { label: "missing tree", extra: "", expected: "SOURCE_INTEGRITY_UNAVAILABLE", withTree: false },
    { label: "registry", extra: "resolved_url: https://registry.example/archive.tgz", expected: "SOURCE_ROUTE_UNSUPPORTED", withTree: true },
    { label: "Windows-reserved virtual path", extra: "virtual_path: CON", expected: "SOURCE_ROUTE_UNSUPPORTED", withTree: true },
    { label: "virtual subtree lacks a v1 proof", extra: "virtual_path: packages/one", expected: "SOURCE_ROUTE_UNSUPPORTED", withTree: true },
    { label: "future route field", extra: "x-download-route: https://example.invalid/archive", expected: "SOURCE_SHAPE_UNSUPPORTED", withTree: true },
  ]) {
    const value = fixture();
    mkdirSync(value.workDirectory);
    const currentArchive = archive(value.currentCommit, { "package.json": "{}\n" });
    const candidateArchive = archive(value.candidateCommit, { "package.json": "{\"x\":1}\n" });
    lock(value.currentLockPath, value.currentCommit, fixtureCase.withTree ? parseApmGitHubArchive(currentArchive).treeSha256 : undefined, fixtureCase.extra);
    lock(value.candidateLockPath, value.candidateCommit, fixtureCase.withTree ? parseApmGitHubArchive(candidateArchive).treeSha256 : undefined, fixtureCase.extra);
    let fetched = false;
    const receipt = runApmAutomaticPreflight({
      repository: value.repository,
      currentLockPath: value.currentLockPath,
      candidateLockPath: value.candidateLockPath,
      configPath: value.configPath,
      workDirectory: value.workDirectory,
      generatedAt: "2026-08-23T20:00:00.000Z",
    }, { fetchArchive: () => { fetched = true; } });
    assert.equal(receipt.summary.verdict, "HOLD", fixtureCase.label);
    assert.deepEqual(receipt.summary.reasonCodes, [fixtureCase.expected], fixtureCase.label);
    assert.equal(fetched, false, fixtureCase.label);
  }
});

test("automatic APM preflight holds before evaluation when exact manifest evidence exceeds 64 KiB", () => {
  const value = fixture();
  mkdirSync(value.workDirectory);
  const oversizedManifest = (version: string) => `${JSON.stringify({
    name: "fixture-agent",
    version,
    tools: ["read"],
    padding: "x".repeat(64 * 1024),
  })}\n`;
  const currentArchive = archive(value.currentCommit, { "package.json": oversizedManifest("1.0.0") });
  const candidateArchive = archive(value.candidateCommit, { "package.json": oversizedManifest("1.1.0") });
  lock(value.currentLockPath, value.currentCommit, parseApmGitHubArchive(currentArchive).treeSha256);
  lock(value.candidateLockPath, value.candidateCommit, parseApmGitHubArchive(candidateArchive).treeSha256);
  let evaluated = false;
  const receipt = runApmAutomaticPreflight({
    repository: value.repository,
    currentLockPath: value.currentLockPath,
    candidateLockPath: value.candidateLockPath,
    configPath: value.configPath,
    workDirectory: value.workDirectory,
    generatedAt: "2026-08-23T20:00:00.000Z",
  }, {
    fetchArchive: (url, destination) => writeFileSync(
      destination,
      url.endsWith(value.currentCommit) ? currentArchive : candidateArchive,
    ),
    evaluate: () => { evaluated = true; throw new Error("must not evaluate"); },
  });
  assert.equal(evaluated, false);
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.deepEqual(receipt.summary.reasonCodes, ["MANIFEST_EVIDENCE_SIZE_EXCEEDED"]);
  assert.equal(receipt.restoration.status, "RESTORED");
  assert.equal(readdirSync(value.workDirectory).length, 0);
});

test("automatic APM materialization is invariant across restrictive host umasks", () => {
  const originalUmask = process.umask();
  const commitments: string[] = [];
  try {
    for (const mask of [0o022, 0o077]) {
      const value = fixture();
      try {
        mkdirSync(value.workDirectory);
        const currentArchive = archive(value.currentCommit, {
          "package.json": `${JSON.stringify({ name: "fixture-agent", version: "1.0.0", tools: ["read"] })}\n`,
        });
        const candidateArchive = archive(value.candidateCommit, {
          "package.json": `${JSON.stringify({ name: "fixture-agent", version: "1.1.0", tools: ["read"] })}\n`,
        });
        lock(value.currentLockPath, value.currentCommit, parseApmGitHubArchive(currentArchive).treeSha256);
        lock(value.candidateLockPath, value.candidateCommit, parseApmGitHubArchive(candidateArchive).treeSha256);
        process.umask(mask);
        const receipt = runApmAutomaticPreflight({
          repository: value.repository,
          currentLockPath: value.currentLockPath,
          candidateLockPath: value.candidateLockPath,
          configPath: value.configPath,
          workDirectory: value.workDirectory,
          generatedAt: "2026-08-23T20:00:00.000Z",
          nonce: "umask-invariance-nonce",
        }, {
          fetchArchive: (url, destination) => writeFileSync(
            destination,
            url.endsWith(value.currentCommit) ? currentArchive : candidateArchive,
          ),
          evaluate: (input) => fakeReceipt(
            input.currentDirectory,
            input.candidateDirectory,
            input.generatedAt!,
            input.nonce!,
            value.repository,
            value.configPath,
          ),
        });
        assert.equal(receipt.summary.verdict, "SAFE");
        commitments.push(receipt.materialization!.current!.selectedArtifact.treeSha256);
      } finally {
        rmSync(value.repository, { recursive: true, force: true });
      }
    }
  } finally { process.umask(originalUmask); }
  assert.equal(commitments.length, 2);
  assert.equal(commitments[0], commitments[1]);
});

test("a failed restoration can never preserve a SAFE nested verdict", () => {
  const value = fixture();
  mkdirSync(value.workDirectory);
  const currentArchive = archive(value.currentCommit, {
    "package.json": `${JSON.stringify({ name: "fixture-agent", version: "1.0.0", tools: [] })}\n`,
  });
  const candidateArchive = archive(value.candidateCommit, {
    "package.json": `${JSON.stringify({ name: "fixture-agent", version: "1.1.0", tools: [] })}\n`,
  });
  lock(value.currentLockPath, value.currentCommit, parseApmGitHubArchive(currentArchive).treeSha256);
  lock(value.candidateLockPath, value.candidateCommit, parseApmGitHubArchive(candidateArchive).treeSha256);
  const receipt = runApmAutomaticPreflight({
    repository: value.repository,
    currentLockPath: value.currentLockPath,
    candidateLockPath: value.candidateLockPath,
    configPath: value.configPath,
    workDirectory: value.workDirectory,
    generatedAt: "2026-08-23T20:00:00.000Z",
  }, {
    fetchArchive: (url, destination) => writeFileSync(
      destination,
      url.endsWith(value.currentCommit) ? currentArchive : candidateArchive,
    ),
    evaluate: (input) => fakeReceipt(
      input.currentDirectory,
      input.candidateDirectory,
      input.generatedAt!,
      input.nonce!,
      value.repository,
      value.configPath,
    ),
    removeSession: () => false,
  });
  assert.equal(receipt.upgradeReceipt?.summary.verdict, "SAFE");
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.deepEqual(receipt.summary.reasonCodes, ["RESTORATION_FAILED"]);
  assert.deepEqual(receipt.restoration, {
    status: "HOLD", hostMutation: "NONE", sessionRemoved: false, reasonCode: "RESTORATION_FAILED",
  });
  for (const entry of readdirSync(value.workDirectory)) {
    rmSync(join(value.workDirectory, entry), { recursive: true, force: true });
  }
});

test("archive traversal, links, collisions, and tree mismatch fail closed and restore the temporary session", () => {
  const value = fixture();
  mkdirSync(value.workDirectory);
  const good = archive(value.currentCommit, { "package.json": "{}\n" });
  const linked = archive(value.candidateCommit, { "package.json": "{}\n" }, { path: "escape", type: "2" });
  lock(value.currentLockPath, value.currentCommit, parseApmGitHubArchive(good).treeSha256);
  // The expected hash is deliberately unrelated; link rejection must occur
  // before any candidate tree can be trusted.
  lock(value.candidateLockPath, value.candidateCommit, digest("candidate"));
  const receipt = runApmAutomaticPreflight({
    repository: value.repository,
    currentLockPath: value.currentLockPath,
    candidateLockPath: value.candidateLockPath,
    configPath: value.configPath,
    workDirectory: value.workDirectory,
    generatedAt: "2026-08-23T20:00:00.000Z",
  }, {
    fetchArchive: (url, destination) => writeFileSync(destination, url.endsWith(value.currentCommit) ? good : linked),
  });
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.deepEqual(receipt.summary.reasonCodes, ["ARCHIVE_ENTRY_UNSUPPORTED"]);
  assert.equal(receipt.restoration.status, "RESTORED");
  assert.equal(readdirSync(value.workDirectory).length, 0);

  assert.throws(() => parseApmGitHubArchive(archive("c".repeat(40), {
    "Case.txt": "one",
    "case.txt": "two",
  })), /ARCHIVE_PATH_COLLISION/);
  assert.throws(() => parseApmGitHubArchive(archive("d".repeat(40), {
    "package.json": "{}\n",
  }, { path: "unbound-empty-directory", type: "5" })), /ARCHIVE_ENTRY_UNSUPPORTED/);
  for (const path of ["CON", "NUL.txt", "stream:ads", "terminal.", "terminal "]) {
    assert.throws(
      () => parseApmGitHubArchive(archive("e".repeat(40), { [path]: "unsafe\n" })),
      /ARCHIVE_PATH_UNSAFE/,
      path,
    );
  }
});

test("a codeload PAX commit that differs from the selected exact endpoint returns HOLD", () => {
  const value = fixture();
  mkdirSync(value.workDirectory);
  const currentArchive = archive(value.currentCommit, { "package.json": "{}\n" }, undefined, "f".repeat(40));
  const candidateArchive = archive(value.candidateCommit, { "package.json": "{\"x\":1}\n" }, undefined, value.candidateCommit);
  lock(value.currentLockPath, value.currentCommit, parseApmGitHubArchive(currentArchive).treeSha256);
  lock(value.candidateLockPath, value.candidateCommit, parseApmGitHubArchive(candidateArchive).treeSha256);
  const receipt = runApmAutomaticPreflight({
    repository: value.repository,
    currentLockPath: value.currentLockPath,
    candidateLockPath: value.candidateLockPath,
    configPath: value.configPath,
    workDirectory: value.workDirectory,
    generatedAt: "2026-08-23T20:00:00.000Z",
  }, {
    fetchArchive: (url, destination) => writeFileSync(destination, url.endsWith(value.currentCommit) ? currentArchive : candidateArchive),
  });
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.deepEqual(receipt.summary.reasonCodes, ["ARCHIVE_COMMIT_MISMATCH"]);
  assert.equal(receipt.restoration.status, "RESTORED");
  assert.equal(readdirSync(value.workDirectory).length, 0);
});

test("one favorable pair cannot green added, removed, workspace, or second-update plan changes", () => {
  const variants = ["added", "removed", "workspace", "second-update"] as const;
  for (const variant of variants) {
    const value = fixture();
    mkdirSync(value.workDirectory);
    const currentArchive = archive(value.currentCommit, { "package.json": "{}\n" });
    const candidateArchive = archive(value.candidateCommit, { "package.json": "{\"x\":1}\n" });
    const currentTree = parseApmGitHubArchive(currentArchive).treeSha256;
    const candidateTree = parseApmGitHubArchive(candidateArchive).treeSha256;
    const currentRows = [apmRow("example/fixture", value.currentCommit, currentTree)];
    const candidateRows = [apmRow("example/fixture", value.candidateCommit, candidateTree)];
    let currentWorkspace: string[] = [];
    let candidateWorkspace: string[] = [];
    if (variant === "added") candidateRows.push(apmRow("example/added", "c".repeat(40), candidateTree));
    if (variant === "removed") currentRows.push(apmRow("example/removed", "d".repeat(40), currentTree));
    if (variant === "workspace") {
      currentWorkspace = ["mcp_configs: {}"];
      candidateWorkspace = ["mcp_configs:", "  github:", "    command: changed-mcp"];
    }
    if (variant === "second-update") {
      currentRows.push(apmRow("example/second", "e".repeat(40), currentTree, ["resolved_ref: main"]));
      candidateRows.push(apmRow("example/second", "e".repeat(40), currentTree, ["resolved_ref: release"]));
    }
    lockRows(value.currentLockPath, currentRows, currentWorkspace);
    lockRows(value.candidateLockPath, candidateRows, candidateWorkspace);
    const plan = createUpdatePlan({
      manager: "apm",
      currentPath: value.currentLockPath,
      candidatePath: value.candidateLockPath,
      generatedAt: "2026-08-23T20:00:00.000Z",
    });
    const selected = plan.changes.find((change) => change.componentType === "apm-package"
      && change.behavioralPreflight === "REQUIRED");
    assert.ok(selected, variant);
    let fetched = false;
    const receipt = runApmAutomaticPreflight({
      repository: value.repository,
      currentLockPath: value.currentLockPath,
      candidateLockPath: value.candidateLockPath,
      configPath: value.configPath,
      workDirectory: value.workDirectory,
      identity: selected.identity,
      generatedAt: "2026-08-23T20:00:00.000Z",
    }, { fetchArchive: () => { fetched = true; } });
    assert.equal(receipt.summary.verdict, "HOLD", variant);
    assert.deepEqual(receipt.summary.reasonCodes, ["UNASSESSED_PLAN_CHANGES"], variant);
    assert.equal(fetched, false, variant);
    assert.equal(readdirSync(value.workDirectory).length, 0, variant);
  }
});

test("unmaterialized APM row policy and deployment selection changes hold before fetch", () => {
  const variants = [
    { label: "skill subset", current: ["skill_subset:", "  - review"], candidate: ["skill_subset:", "  - deploy"] },
    { label: "target subset", current: ["target_subset:", "  - codex"], candidate: ["target_subset:", "  - claude"] },
    { label: "package type", current: ["package_type: skill"], candidate: ["package_type: plugin"] },
    { label: "virtual path", current: ["virtual_path: packages/one"], candidate: ["virtual_path: packages/two"] },
    { label: "deployment ledger", current: ["deployed_files:", "  - one.md"], candidate: ["deployed_files:", "  - two.md"] },
  ];
  for (const variant of variants) {
    const value = fixture();
    mkdirSync(value.workDirectory);
    try {
      const currentArchive = archive(value.currentCommit, { "package.json": "{}\n" });
      const candidateArchive = archive(value.candidateCommit, { "package.json": "{\"x\":1}\n" });
      lockRows(value.currentLockPath, [apmRow(
        "example/fixture", value.currentCommit, parseApmGitHubArchive(currentArchive).treeSha256, variant.current,
      )]);
      lockRows(value.candidateLockPath, [apmRow(
        "example/fixture", value.candidateCommit, parseApmGitHubArchive(candidateArchive).treeSha256, variant.candidate,
      )]);
      const plan = createUpdatePlan({
        manager: "apm",
        currentPath: value.currentLockPath,
        candidatePath: value.candidateLockPath,
        generatedAt: "2026-08-23T20:00:00.000Z",
      });
      assert.equal(plan.summary.total, 1, variant.label);
      assert.equal(plan.summary.eligiblePairs, 1, variant.label);
      let fetched = false;
      const receipt = runApmAutomaticPreflight({
        repository: value.repository,
        currentLockPath: value.currentLockPath,
        candidateLockPath: value.candidateLockPath,
        configPath: value.configPath,
        workDirectory: value.workDirectory,
        generatedAt: "2026-08-23T20:00:00.000Z",
      }, { fetchArchive: () => { fetched = true; } });
      assert.equal(receipt.summary.verdict, "HOLD", variant.label);
      assert.deepEqual(receipt.summary.reasonCodes, ["UNMATERIALIZED_ROW_STATE_CHANGED"], variant.label);
      assert.equal(fetched, false, variant.label);
      assert.equal(readdirSync(value.workDirectory).length, 0, variant.label);
    } finally {
      rmSync(value.repository, { recursive: true, force: true });
    }
  }
});

test("a supplied plan must exactly match the current lockfile pair before any acquisition", () => {
  const value = fixture();
  mkdirSync(value.workDirectory);
  const currentArchive = archive(value.currentCommit, { "package.json": "{}\n" });
  const candidateArchive = archive(value.candidateCommit, { "package.json": "{\"x\":1}\n" });
  lock(value.currentLockPath, value.currentCommit, parseApmGitHubArchive(currentArchive).treeSha256);
  lock(value.candidateLockPath, value.candidateCommit, parseApmGitHubArchive(candidateArchive).treeSha256);
  let fetched = false;
  const receipt = runApmAutomaticPreflight({
    repository: value.repository,
    currentLockPath: value.currentLockPath,
    candidateLockPath: value.candidateLockPath,
    configPath: value.configPath,
    workDirectory: value.workDirectory,
    suppliedPlan: { schemaVersion: "agent-vigil-update-plan/v1", generatedAt: "2026-08-23T20:00:00.000Z" },
  }, { fetchArchive: () => { fetched = true; } });
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.deepEqual(receipt.summary.reasonCodes, ["PLAN_MISMATCH"]);
  assert.equal(fetched, false);

  const malformedTimestamp = runApmAutomaticPreflight({
    repository: value.repository,
    currentLockPath: value.currentLockPath,
    candidateLockPath: value.candidateLockPath,
    configPath: value.configPath,
    workDirectory: value.workDirectory,
    suppliedPlan: { schemaVersion: "agent-vigil-update-plan/v1", generatedAt: "not-a-timestamp" },
  }, { fetchArchive: () => { fetched = true; } });
  assert.equal(malformedTimestamp.summary.verdict, "HOLD");
  assert.deepEqual(malformedTimestamp.summary.reasonCodes, ["PLAN_MISMATCH"]);
  assert.equal(fetched, false);
});

test("lock state changed during acquisition cannot reach the contained check", () => {
  const value = fixture();
  mkdirSync(value.workDirectory);
  const currentArchive = archive(value.currentCommit, { "package.json": "{}\n" });
  const candidateArchive = archive(value.candidateCommit, { "package.json": "{\"x\":1}\n" });
  const currentTree = parseApmGitHubArchive(currentArchive).treeSha256;
  const candidateTree = parseApmGitHubArchive(candidateArchive).treeSha256;
  lock(value.currentLockPath, value.currentCommit, currentTree);
  lock(value.candidateLockPath, value.candidateCommit, candidateTree);
  let evaluated = false;
  const receipt = runApmAutomaticPreflight({
    repository: value.repository,
    currentLockPath: value.currentLockPath,
    candidateLockPath: value.candidateLockPath,
    configPath: value.configPath,
    workDirectory: value.workDirectory,
    generatedAt: "2026-08-23T20:00:00.000Z",
  }, {
    fetchArchive: (url, destination) => {
      const candidate = url.endsWith(value.candidateCommit);
      writeFileSync(destination, candidate ? candidateArchive : currentArchive);
      if (candidate) writeFileSync(value.candidateLockPath, `${readFileSync(value.candidateLockPath, "utf8")}x-policy: changed\n`);
    },
    evaluate: () => { evaluated = true; throw new Error("must not run"); },
  });
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.deepEqual(receipt.summary.reasonCodes, ["SOURCE_STATE_CHANGED"]);
  assert.equal(evaluated, false);
  assert.equal(receipt.restoration.status, "RESTORED");
  assert.equal(readdirSync(value.workDirectory).length, 0);
});

test("preflight CLI writes a structured HOLD receipt and uses exit 2 before unsupported acquisition", () => {
  const value = fixture();
  mkdirSync(value.workDirectory);
  lock(value.currentLockPath, value.currentCommit);
  lock(value.candidateLockPath, value.candidateCommit);
  const output = join(value.repository, "preflight.json");
  const originalWrite = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let status: number;
  try {
    status = runUpgradeCommand([
      "preflight", "--repo", value.repository, "--config", "config.json",
      "--current-lock", value.currentLockPath, "--candidate-lock", value.candidateLockPath,
      "--work-directory", value.workDirectory, "--output", output,
    ]);
  } finally { process.stdout.write = originalWrite; }
  assert.equal(status, 2);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.schemaVersion, "agent-vigil-apm-preflight/v1");
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.deepEqual(receipt.summary.reasonCodes, ["SOURCE_INTEGRITY_UNAVAILABLE"]);
  assert.equal(receipt.restoration.sessionRemoved, true);

  const bundledOutput = join(value.repository, "bundled-preflight.json");
  const bundled = spawnSync(process.execPath, [
    resolve("dist/cli.js"),
    "upgrade", "preflight", "--repo", value.repository, "--config", "config.json",
    "--current-lock", value.currentLockPath, "--candidate-lock", value.candidateLockPath,
    "--work-directory", value.workDirectory, "--output", bundledOutput,
  ], { encoding: "utf8", env: withoutInheritedNodeCoverage() });
  assert.equal(bundled.status, 2);
  assert.equal(bundled.stderr, "");
  const bundledReceipt = JSON.parse(readFileSync(bundledOutput, "utf8"));
  assert.equal(bundledReceipt.summary.verdict, "HOLD");
  assert.deepEqual(bundledReceipt.summary.reasonCodes, ["SOURCE_INTEGRITY_UNAVAILABLE"]);
});

test("the published APM wrapper schema names stable Action fields and fail-closed restoration", () => {
  const schema = JSON.parse(readFileSync(new URL("../docs/apm-preflight-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.properties.schemaVersion.const, "agent-vigil-apm-preflight/v1");
  assert.deepEqual(schema.properties.summary.properties.verdict.enum, ["SAFE", "CHANGED", "HOLD"]);
  assert.equal(schema.properties.receiptHash.$ref, "#/$defs/sha256");
  assert.deepEqual(schema.properties.restoration.properties.status.enum, ["RESTORED", "HOLD"]);
  assert.deepEqual(schema.allOf[0].then.required, ["selection", "materialization", "upgradeReceipt"]);
  assert.equal(schema.allOf[0].then.properties.restoration.properties.sessionRemoved.const, true);
  assert.equal(schema.allOf[3].then.properties.restoration.properties.sessionRemoved.const, true);
  assert.equal(schema.allOf[3].else.properties.restoration.properties.sessionRemoved.const, false);
  assert.equal(schema.$defs.materializedProof.properties.fetchedBytes.maximum, 64 * 1024 * 1024);
  assert.ok(schema.$defs.materializedProof.required.includes("manifestEvidence"));
  assert.equal(
    schema.$defs.materializedProof.properties.manifestEvidence.properties.contentBase64.maxLength,
    Math.ceil((64 * 1024) / 3) * 4,
  );
  assert.equal(schema.additionalProperties, false);
});

const DOCKER_ENABLED = process.env.VIGIL_UPGRADE_DOCKER_TESTS === "1"
  && typeof process.env.VIGIL_UPGRADE_DOCKER_IMAGE === "string";

test("opt-in real Docker runs the complete fake-network APM materialize-check-restore path", {
  skip: !DOCKER_ENABLED,
}, () => {
  const repository = mkdtempSync(join(process.cwd(), ".vigil-apm-docker-"));
  try {
    const workDirectory = join(repository, "work");
    const canaryDirectory = join(repository, "canaries");
    mkdirSync(workDirectory, { mode: 0o755 });
    mkdirSync(canaryDirectory, { mode: 0o755 });
    const configPath = join(repository, "config.json");
    const currentLockPath = join(repository, "current.lock.yaml");
    const candidateLockPath = join(repository, "candidate.lock.yaml");
    const currentCommit = "c".repeat(40);
    const candidateCommit = "d".repeat(40);
    const artifact = (commit: string, version: string) => archive(commit, {
      "package.json": `${JSON.stringify({ name: "fixture-agent", version, behavior: "stable", tools: ["read"] })}\n`,
      "behavior.txt": "stable\n",
    });
    const currentArchive = artifact(currentCommit, "1.0.0");
    const candidateArchive = artifact(candidateCommit, "1.1.0");
    lock(currentLockPath, currentCommit, parseApmGitHubArchive(currentArchive).treeSha256);
    lock(candidateLockPath, candidateCommit, parseApmGitHubArchive(candidateArchive).treeSha256);
    writeFileSync(join(canaryDirectory, "behavior.cjs"), String.raw`
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.VIGIL_TARGET + "/package.json", "utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: "agent-vigil-upgrade-canary/v1",
  outcome: "PASS",
  observations: { behavior: value.behavior, toolCount: value.tools.length }
}));
`);
    writeFileSync(configPath, `${JSON.stringify({
      schemaVersion: "agent-vigil-upgrade-config/v1",
      component: {
        ecosystem: "agent-plugin", name: "fixture-agent", manifestPath: "package.json",
        identityField: "name", versionField: "version", capabilityFields: ["tools"],
      },
      runner: {
        engine: "docker", image: process.env.VIGIL_UPGRADE_DOCKER_IMAGE,
        trials: 2, memoryMiB: 256, cpus: 0.5, pids: 64,
      },
      canaryDirectory: "canaries",
      canaries: [{
        id: "behavior-contract", publicId: "behavior-contract-v1",
        command: ["node", "/canaries/behavior.cjs"], timeoutSeconds: 15,
      }],
    }, null, 2)}\n`);
    for (const path of [repository, workDirectory, canaryDirectory]) chmodSync(path, 0o755);
    for (const path of [configPath, join(canaryDirectory, "behavior.cjs")]) chmodSync(path, 0o644);
    const receipt = runApmAutomaticPreflight({
      repository,
      currentLockPath,
      candidateLockPath,
      configPath,
      workDirectory,
      dockerBin: process.env.VIGIL_UPGRADE_DOCKER_BIN ?? "docker",
      generatedAt: "2026-08-23T20:00:00.000Z",
    }, {
      fetchArchive: (url, destination) => writeFileSync(
        destination,
        url.endsWith(currentCommit) ? currentArchive : candidateArchive,
      ),
    });
    assert.equal(receipt.summary.verdict, "SAFE", receipt.summary.reasonCodes.join(", "));
    assert.equal(receipt.upgradeReceipt?.containment.status, "PASS");
    assert.equal(receipt.restoration.status, "RESTORED");
    assert.equal(readdirSync(workDirectory).length, 0);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
