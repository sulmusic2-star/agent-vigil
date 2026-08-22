import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  UPGRADE_CONFIG_SCHEMA,
  validateUpgradeConfig,
  type UpgradeConfig,
} from "../src/upgrade/contracts.ts";
import { runUpgradeEvaluation } from "../src/upgrade/receipt.ts";
import { probeContainment } from "../src/upgrade/sandbox.ts";
import { runUpgradeCommand } from "../src/upgrade/cli.ts";
import { generateSigningKey } from "../src/signature.ts";

const DOCKER_ENABLED = process.env.VIGIL_UPGRADE_DOCKER_TESTS === "1";
const DOCKER_BIN = process.env.VIGIL_UPGRADE_DOCKER_BIN || "docker";
const PINNED_IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:~-]{0,246}@sha256:[0-9a-f]{64}$/;
let cachedImage: string | undefined;

function pinnedNodeImage(): string {
  if (cachedImage) return cachedImage;
  const configured = process.env.VIGIL_UPGRADE_DOCKER_IMAGE;
  if (configured) {
    assert.match(
      configured,
      PINNED_IMAGE_PATTERN,
      "VIGIL_UPGRADE_DOCKER_IMAGE must be an exact repo@sha256 digest reference",
    );
    cachedImage = configured;
    return configured;
  }

  let listed: string;
  try {
    listed = execFileSync(
      DOCKER_BIN,
      ["image", "ls", "--digests", "--format", "{{.Repository}}@{{.Digest}}"],
      { encoding: "utf8", timeout: 10_000 },
    );
  } catch (error) {
    assert.fail(`Docker opt-in was requested but the daemon is unavailable: ${(error as Error).message}`);
  }
  const image = listed
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => /^(?:node|docker\.io\/library\/node)@sha256:[0-9a-f]{64}$/.test(value));
  assert.ok(
    image,
    "Docker opt-in requires a locally present digest-pinned Node image; set VIGIL_UPGRADE_DOCKER_IMAGE. Tests never pull images.",
  );
  cachedImage = image;
  return image;
}

type DockerFixture = {
  repository: string;
  current: string;
  unchanged: string;
  changed: string;
  canaries: string;
  configPath: string;
  config: UpgradeConfig;
};

function makeReadableDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

function writeReadable(path: string, contents: string): void {
  writeFileSync(path, contents);
  if (process.platform !== "win32") chmodSync(path, 0o644);
}

function writeArtifact(path: string, version: string, behavior: string, tools: string[]): void {
  makeReadableDirectory(path);
  writeReadable(join(path, "package.json"), `${JSON.stringify({
    name: "fixture-agent",
    version,
    behavior,
    tools,
  })}\n`);
  writeReadable(join(path, "implementation.txt"), `${behavior}\n`);
}

function dockerFixture(): DockerFixture {
  // Colima and Docker Desktop do not necessarily share the host temporary
  // directory. Keep opt-in bind-mount fixtures under the checked-out tree,
  // which is already known to be shared with the active daemon.
  const repository = mkdtempSync(join(process.cwd(), ".vigil-upgrade-docker-"));
  if (process.platform !== "win32") chmodSync(repository, 0o755);
  const current = join(repository, "current");
  const unchanged = join(repository, "unchanged");
  const changed = join(repository, "changed");
  const canaries = join(repository, "canaries");
  writeArtifact(current, "1.0.0", "stable", ["read"]);
  writeArtifact(unchanged, "1.1.0", "stable", ["read"]);
  writeArtifact(changed, "2.0.0", "changed", ["read", "write"]);
  makeReadableDirectory(canaries);
  writeReadable(join(canaries, "behavior.cjs"), String.raw`
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.VIGIL_TARGET + "/package.json", "utf8"));
process.stdout.write(JSON.stringify({
  schemaVersion: "agent-vigil-upgrade-canary/v1",
  outcome: "PASS",
  observations: { behavior: manifest.behavior, toolCount: manifest.tools.length }
}));
`);

  const configInput = {
    schemaVersion: UPGRADE_CONFIG_SCHEMA,
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
      image: pinnedNodeImage(),
      trials: 2,
      memoryMiB: 256,
      cpus: 0.5,
      pids: 64,
    },
    canaryDirectory: "canaries",
    canaries: [{
      id: "behavior-contract",
      publicId: "behavior-contract-v1",
      command: ["node", "/canaries/behavior.cjs"],
      timeoutSeconds: 15,
    }],
  };
  const config = validateUpgradeConfig(configInput);
  const configPath = join(repository, "upgrade.json");
  writeReadable(configPath, `${JSON.stringify(configInput)}\n`);
  return { repository, current, unchanged, changed, canaries, configPath, config };
}

test("Docker containment establishes every required control", { skip: !DOCKER_ENABLED }, () => {
  const fixture = dockerFixture();
  try {
    const result = probeContainment(fixture.config, fixture.current, fixture.canaries, DOCKER_BIN);
    assert.equal(result.status, "PASS", result.reason);
    assert.equal(result.localEndpoint, true);
    assert.equal(result.imagePresent, true);
    assert.equal(result.networkBlocked, true);
    assert.equal(result.targetReadOnly, true);
    assert.equal(result.rootReadOnly, true);
    assert.equal(result.inheritedSecretAbsent, true);
    assert.equal(result.proxiesCleared, true);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test("Docker integration reports SAFE for an unchanged observed contract", { skip: !DOCKER_ENABLED }, () => {
  const fixture = dockerFixture();
  try {
    const receipt = runUpgradeEvaluation({
      configPath: fixture.configPath,
      repository: fixture.repository,
      currentDirectory: fixture.current,
      candidateDirectory: fixture.unchanged,
      dockerBin: DOCKER_BIN,
      generatedAt: "2026-08-22T12:00:00.000Z",
      nonce: "docker-unchanged-fixture",
    });
    assert.equal(receipt.containment.status, "PASS", receipt.containment.reason);
    assert.equal(receipt.summary.verdict, "SAFE", receipt.summary.reasons.join("; "));
    assert.equal(receipt.summary.comparedCanaries, 1);
    assert.equal(receipt.summary.changedCanaries, 0);
    assert.equal(receipt.summary.changedCapabilities, 0);
    assert.equal(receipt.canaries[0].current.stable, true);
    assert.equal(receipt.canaries[0].candidate.stable, true);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test("Docker integration reports CHANGED for stable capability and observation deltas", { skip: !DOCKER_ENABLED }, () => {
  const fixture = dockerFixture();
  try {
    const receipt = runUpgradeEvaluation({
      configPath: fixture.configPath,
      repository: fixture.repository,
      currentDirectory: fixture.current,
      candidateDirectory: fixture.changed,
      dockerBin: DOCKER_BIN,
      generatedAt: "2026-08-22T12:00:00.000Z",
      nonce: "docker-changed-fixture",
    });
    assert.equal(receipt.containment.status, "PASS", receipt.containment.reason);
    assert.equal(receipt.summary.verdict, "CHANGED", receipt.summary.reasons.join("; "));
    assert.equal(receipt.summary.comparedCanaries, 1);
    assert.equal(receipt.summary.changedCanaries, 1);
    assert.equal(receipt.summary.changedCapabilities, 1);
    assert.equal(receipt.canaries[0].changed, true);
    assert.equal(receipt.capabilities[0].changed, true);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});

test("Docker-backed CLI writes, verifies, and indexes a signed SAFE receipt", { skip: !DOCKER_ENABLED }, () => {
  const fixture = dockerFixture();
  try {
    const privateKey = join(fixture.repository, "compatibility-private.pem");
    const publicKey = join(fixture.repository, "compatibility-public.pem");
    const privateReceipt = join(fixture.repository, "private.json");
    const publicEntry = join(fixture.repository, "public.json");
    const index = join(fixture.repository, "index.html");
    generateSigningKey(privateKey, publicKey);
    const check = runUpgradeCommand([
      "check", "--repo", fixture.repository, "--config", fixture.configPath,
      "--current", fixture.current, "--candidate", fixture.unchanged,
      "--output", privateReceipt, "--public-output", publicEntry,
      "--signing-key", privateKey, "--docker-bin", DOCKER_BIN,
    ]);
    assert.equal(check, 0);
    assert.equal(existsSync(privateReceipt), true);
    assert.equal(existsSync(publicEntry), true);
    assert.equal(runUpgradeCommand(["verify", publicEntry, "--public-key", publicKey]), 0);
    assert.equal(runUpgradeCommand(["index", publicEntry, "--output", index, "--public-key", publicKey]), 0);
    const html = readFileSync(index, "utf8");
    assert.match(html, /fixture-agent/);
    assert.match(html, /<span class="status safe">SAFE<\/span>/);
  } finally {
    rmSync(fixture.repository, { recursive: true, force: true });
  }
});
