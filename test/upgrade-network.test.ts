import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { canonical } from "../src/report.ts";
import { runUpgradeCommand } from "../src/upgrade/cli.ts";
import { inspectArtifactTree } from "../src/upgrade/decision.ts";
import { enforceFleetPolicy, validateFleetPolicy, type FleetPolicy } from "../src/upgrade/fleet.ts";
import { createUpdatePlan } from "../src/upgrade/manager-plan.ts";
import {
  createCompatibilityRegistry,
  createCompatibilityResolution,
  renderBadgeEndpoint,
  renderCompatibilityRegistryPage,
  renderMaintainerEvidence,
  validateCompatibilityResolution,
  verifyCompatibilityResolution,
  type CompatibilityResolution,
} from "../src/upgrade/network.ts";
import {
  createPublicCompatibilityEntry,
  recomputeUpgradeReceiptHash,
  type PublicCompatibilityEntry,
  type UpgradePrivateReceipt,
} from "../src/upgrade/receipt.ts";
import { withoutInheritedNodeCoverage } from "./subprocess-env.ts";

const IMAGE = `node:22@sha256:${"a".repeat(64)}`;

function temp(prefix = "vigil-upgrade-network-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha(label: string): string {
  return `sha256:${Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function capturedUpgrade(args: string[]): { status: number; messages: string } {
  const messages: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  try {
    return { status: runUpgradeCommand(args), messages: messages.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function sourceManagerPlan(manager: "skills" | "apm", current: string, candidate: string): { status: number; output: string; messages: string } {
  const repository = temp(`vigil-${manager}-source-plan-`);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  const output = join(repository, "plan.json");
  const messages: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  try {
    const status = runUpgradeCommand([
      "plan", "--manager", manager, "--current", current, "--candidate", candidate,
      "--repo", repository, "--output", "plan.json",
    ]);
    return { status, output, messages: messages.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function bundledManagerPlan(manager: "skills" | "apm", current: string, candidate: string) {
  const repository = temp(`vigil-${manager}-bundled-plan-`);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  const output = join(repository, "plan.json");
  const result = spawnSync(process.execPath, [
    resolve("dist/cli.js"), "upgrade", "plan", "--manager", manager,
    "--current", current, "--candidate", candidate,
    "--repo", repository, "--output", "plan.json",
  ], { cwd: repository, encoding: "utf8", env: withoutInheritedNodeCoverage() });
  return { result, output };
}

function spawnedSourceManagerPlan(manager: "skills" | "apm", current: string, candidate: string) {
  const repository = temp(`vigil-${manager}-spawned-source-plan-`);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  const output = join(repository, "plan.json");
  const result = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/cli.ts"), "upgrade", "plan", "--manager", manager,
    "--current", current, "--candidate", candidate,
    "--repo", repository, "--output", "plan.json",
  ], { cwd: resolve("."), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: withoutInheritedNodeCoverage() });
  return { result, output };
}

function signingKeys(): { privateKeyPath: string; publicKeyPath: string } {
  const directory = temp("vigil-upgrade-network-keys-");
  const privateKeyPath = join(directory, "private.pem");
  const publicKeyPath = join(directory, "public.pem");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }));
  return { privateKeyPath, publicKeyPath };
}

function receipt(verdict: "SAFE" | "CHANGED", candidateVersion: string, candidateLabel: string, nonce: string): UpgradePrivateReceipt {
  const aggregate = (observation: string) => ({
    state: "PASS" as const,
    observationSha256: sha(observation),
    observationCount: 2,
    trials: 2,
    stable: true,
    reason: "repeated trials produced one stable observation",
  });
  const current = {
    ecosystem: "agent-plugin",
    name: "fixture-agent",
    version: "1.0.0",
    treeSha256: sha("baseline-tree"),
    manifestSha256: sha("baseline-manifest"),
    fileCount: 3,
    totalBytes: 120,
    capabilities: [{ field: "tools", count: 1, sha256: sha("one-tool") }],
  };
  const candidate = {
    ecosystem: "agent-plugin",
    name: "fixture-agent",
    version: candidateVersion,
    treeSha256: sha(candidateLabel),
    manifestSha256: sha(`${candidateLabel}-manifest`),
    fileCount: 3,
    totalBytes: 122,
    capabilities: [{ field: "tools", count: 1, sha256: sha("one-tool") }],
  };
  const value: UpgradePrivateReceipt = {
    schemaVersion: "agent-vigil-upgrade-receipt/v1",
    vigilVersion: "0.13.0-test",
    generatedAt: verdict === "CHANGED" ? "2026-08-23T10:00:00.000Z" : "2026-08-23T11:00:00.000Z",
    nonce,
    component: { ecosystem: "agent-plugin", name: "fixture-agent" },
    configSha256: sha("same-config"),
    runner: {
      engine: "docker", image: IMAGE, trials: 2,
      network: "none", filesystem: "read-only", environment: "explicit",
    },
    containment: {
      status: "PASS", localEndpoint: true, imagePresent: true, networkBlocked: true,
      targetReadOnly: true, rootReadOnly: true, inheritedSecretAbsent: true, proxiesCleared: true,
      reason: "contained",
    },
    current,
    candidate,
    canaryHarness: { treeSha256: sha("same-harness"), fileCount: 1, totalBytes: 80 },
    capabilities: [{ field: "tools", currentCount: 1, candidateCount: 1, changed: false }],
    canaries: [{
      id: "private-behavior",
      publicId: "startup-contract",
      idSha256: sha("private-behavior"),
      commandSha256: sha("private-command"),
      current: aggregate("baseline-observation"),
      candidate: aggregate(verdict === "SAFE" ? "baseline-observation" : "changed-observation"),
      changed: verdict === "CHANGED",
      comparable: true,
    }],
    summary: {
      verdict,
      reasons: [verdict === "SAFE" ? "recorded behavior matched" : "recorded behavior changed"],
      comparedCanaries: 1,
      changedCanaries: verdict === "CHANGED" ? 1 : 0,
      changedCapabilities: 0,
    },
    limitations: ["Bounded to this exact recorded pair."],
    receiptHash: "",
  };
  value.receiptHash = recomputeUpgradeReceiptHash(value);
  return value;
}

function entries(): {
  broken: PublicCompatibilityEntry;
  fixed: PublicCompatibilityEntry;
  privateKeyPath: string;
  publicKeyPath: string;
} {
  const keys = signingKeys();
  return {
    broken: createPublicCompatibilityEntry(receipt("CHANGED", "2.0.0", "broken-tree", "broken-nonce"), keys.privateKeyPath),
    fixed: createPublicCompatibilityEntry(receipt("SAFE", "2.0.1", "fixed-tree", "fixed-nonce"), keys.privateKeyPath),
    ...keys,
  };
}

function fleetPolicy(entry: PublicCompatibilityEntry): FleetPolicy {
  return validateFleetPolicy({
    schemaVersion: "agent-vigil-fleet-policy/v1",
    policyId: "platform-agent-updates",
    allowedPublisherKeyIds: [entry.signature.keyId],
    allowedComponents: [{ ecosystem: entry.component.ecosystem, name: entry.component.name }],
    allowedRunnerImages: [entry.runner.imageDigest],
    allowedConfigSha256: [entry.runner.configSha256],
    allowedCanaryHarnessSha256: [entry.runner.canaryHarnessSha256],
    maxEvidenceAgeHours: 72,
    minimumCanaries: 1,
  });
}

function fleetIntent(entry: PublicCompatibilityEntry) {
  return {
    currentVersion: entry.component.currentVersion,
    candidateVersion: entry.component.candidateVersion,
    currentArtifactSha256: entry.component.currentArtifactSha256,
    candidateArtifactSha256: entry.component.candidateArtifactSha256,
  };
}

test("APM and skills manager adapters identify exact behavior-preflight pairs", () => {
  const directory = temp();
  const apmCurrent = join(directory, "current.lock.yaml");
  const apmCandidate = join(directory, "candidate.lock.yaml");
  writeFileSync(apmCurrent, `lockfile_version: "1"\ndependencies:\n  - repo_url: github.com/example/plugin\n    name: example-plugin\n    version: 1.0.0\n    resolved_commit: ${"a".repeat(40)}\n`);
  writeFileSync(apmCandidate, `lockfile_version: "1"\ndependencies:\n  - repo_url: github.com/example/plugin\n    name: example-plugin\n    version: 1.1.0\n    resolved_commit: ${"b".repeat(40)}\n`);
  const apm = createUpdatePlan({ manager: "apm", currentPath: apmCurrent, candidatePath: apmCandidate, generatedAt: "2026-08-23T12:00:00.000Z" });
  assert.equal(apm.summary.eligiblePairs, 1);
  assert.equal(apm.changes[0].behavioralPreflight, "REQUIRED");
  assert.equal(apm.changes[0].current?.integrityKind, "git-commit");

  const skillsCurrent = join(directory, "skills-current.json");
  const skillsCandidate = join(directory, "skills-candidate.json");
  const locked = (folderHash: string) => ({
    version: 3,
    skills: {
      deploy: {
        source: "example/skills", sourceType: "github", sourceUrl: "https://github.com/example/skills",
        ref: "main", skillPath: "skills/deploy/SKILL.md", skillFolderHash: folderHash,
        installedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });
  writeJson(skillsCurrent, locked("c".repeat(40)));
  writeJson(skillsCandidate, locked("d".repeat(40)));
  const skills = createUpdatePlan({ manager: "skills", currentPath: skillsCurrent, candidatePath: skillsCandidate, generatedAt: "2026-08-23T12:00:00.000Z" });
  assert.equal(skills.summary.eligiblePairs, 1);
  assert.equal(skills.changes[0].componentType, "skill");
  assert.equal(skills.changes[0].candidate?.integrity, "d".repeat(40));
});

test("Skills v3 binds every update route, integrity, ownership, and additive entry field", () => {
  const directory = temp();
  const current = join(directory, "current.json");
  const candidate = join(directory, "candidate.json");
  const baseSkill = {
    source: "example/skills",
    sourceType: "github",
    sourceUrl: "https://github.com/example/skills.git",
    ref: "main",
    skillPath: "skills/deploy/SKILL.md",
    skillFolderHash: "a".repeat(40),
    installedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    pluginName: "deploy-tools",
  };
  const lock = (skill: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    version: 3,
    skills: { deploy: skill },
    ...extra,
  });
  const cases = [
    {
      name: "sourceUrl",
      change: { sourceUrl: "https://mirror.example/skills.git" },
      total: 2,
      eligible: 0,
      reason: /added|removed/,
    },
    {
      name: "pluginName",
      change: { pluginName: "production-deploy-tools" },
      total: 2,
      eligible: 0,
      reason: /added|removed/,
    },
    {
      name: "unknown additive entry field",
      change: { futureExecutionPolicy: { network: "allow", permissions: ["deploy"] } },
      total: 1,
      eligible: 0,
      reason: /additive entry state/,
    },
  ] as const;

  for (const fixture of cases) {
    writeJson(current, lock(baseSkill));
    writeJson(candidate, lock({ ...baseSkill, ...fixture.change }));
    const plan = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate, generatedAt: "2026-08-23T12:00:00.000Z" });
    assert.equal(plan.summary.total, fixture.total, fixture.name);
    assert.equal(plan.summary.eligiblePairs, fixture.eligible, fixture.name);
    assert.ok(plan.changes.every((change) => change.componentType === "skill"), fixture.name);
    assert.match(plan.changes.flatMap((change) => change.reasons).join(" "), fixture.reason, fixture.name);
  }

  const baseWellKnown = {
    source: "catalog.example",
    sourceType: "well-known",
    sourceUrl: "https://catalog.example/.well-known/agent-skills/deploy/SKILL.md",
    sourceBaseUrl: "https://catalog.example",
    skillFolderHash: "",
    installedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    wellKnownDigest: `sha256:${"b".repeat(64)}`,
  };
  writeJson(current, lock(baseWellKnown));
  writeJson(candidate, lock({ ...baseWellKnown, sourceBaseUrl: "https://mirror.catalog.example" }));
  const routeReplacement = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(routeReplacement.summary.total, 2);
  assert.equal(routeReplacement.summary.eligiblePairs, 0);

  writeJson(candidate, lock({ ...baseWellKnown, wellKnownDigest: `sha256:${"c".repeat(64)}` }));
  const digestUpdate = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(digestUpdate.summary.total, 1);
  assert.equal(digestUpdate.summary.eligiblePairs, 1);
  assert.match(digestUpdate.changes[0].reasons.join(" "), /exact content identity/);

  writeJson(current, lock(baseSkill, { futureManagerPolicy: { mode: "review" } }));
  writeJson(candidate, lock(baseSkill, { futureManagerPolicy: { mode: "enforce" } }));
  const topLevel = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(topLevel.summary.total, 1);
  assert.equal(topLevel.summary.eligiblePairs, 1);
  assert.equal(topLevel.changes[0].componentType, "skills-workspace");
  assert.notDeepEqual(topLevel.changes[0].current, topLevel.changes[0].candidate);
  assert.match(topLevel.changes[0].reasons.join(" "), /additive manager state/);
});

test("Skills v3 excludes only entry timestamps and accepts well-known digest identity", () => {
  const directory = temp();
  const current = join(directory, "current.json");
  const candidate = join(directory, "candidate.json");
  const regular = (installedAt: string, updatedAt: string) => ({
    source: "example/skills",
    sourceType: "github",
    sourceUrl: "https://github.com/example/skills.git",
    skillPath: "skills/deploy/SKILL.md",
    skillFolderHash: "a".repeat(40),
    installedAt,
    updatedAt,
  });
  writeJson(current, {
    version: 3,
    skills: { deploy: regular("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z") },
    dismissed: { findSkillsPrompt: false },
    lastSelectedAgents: ["codex"],
  });
  writeJson(candidate, {
    version: 3,
    skills: { deploy: regular("2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z") },
    dismissed: { findSkillsPrompt: false },
    lastSelectedAgents: ["codex"],
  });
  const diagnostic = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(diagnostic.summary.total, 0);
  assert.notEqual(diagnostic.source.currentSha256, diagnostic.source.candidateSha256);

  writeJson(candidate, {
    version: 3,
    skills: { deploy: regular("2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z") },
    dismissed: { findSkillsPrompt: true },
    lastSelectedAgents: ["claude-code"],
  });
  const preferences = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(preferences.summary.total, 1);
  assert.equal(preferences.summary.eligiblePairs, 1);
  assert.equal(preferences.changes[0].componentType, "skills-workspace");
  assert.match(preferences.changes[0].reasons.join(" "), /prompt or installation-target preference/);

  const wellKnown = (digest: string) => ({
    version: 3,
    skills: {
      deploy: {
        source: "catalog.example",
        sourceType: "well-known",
        sourceUrl: "https://catalog.example/.well-known/agent-skills/deploy/SKILL.md",
        sourceBaseUrl: "https://catalog.example",
        skillFolderHash: "",
        wellKnownDigest: digest,
        installedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });
  writeJson(current, wellKnown(`sha256:${"b".repeat(64)}`));
  writeJson(candidate, wellKnown(`sha256:${"c".repeat(64)}`));
  const exactDigest = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(exactDigest.summary.total, 1);
  assert.equal(exactDigest.summary.eligiblePairs, 1);
  assert.equal(exactDigest.changes[0].current?.integrityKind, "sha256");
  assert.equal(exactDigest.changes[0].current?.integrity, `sha256:${"b".repeat(64)}`);
  assert.equal(exactDigest.changes[0].candidate?.integrity, `sha256:${"c".repeat(64)}`);
});

test("Skills v3 rejects malformed native state through source and bundled CLIs", {
  skip: Boolean(process.env.NODE_V8_COVERAGE),
}, () => {
  const directory = temp("vigil-skills-invalid-state-");
  const current = join(directory, "current.json");
  const candidate = join(directory, "candidate.json");
  const regular = (overrides: Record<string, unknown> = {}) => ({
    source: "example/skills",
    sourceType: "github",
    sourceUrl: "https://github.com/example/skills.git",
    ref: "main",
    skillPath: "skills/deploy/SKILL.md",
    skillFolderHash: "a".repeat(40),
    installedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
  const wellKnown = (overrides: Record<string, unknown> = {}) => ({
    source: "catalog.example",
    sourceType: "well-known",
    sourceUrl: "https://catalog.example/.well-known/agent-skills/deploy/SKILL.md",
    sourceBaseUrl: "https://catalog.example",
    skillFolderHash: "",
    wellKnownDigest: `sha256:${"b".repeat(64)}`,
    installedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
  const missingInstalled = regular();
  delete (missingInstalled as Record<string, unknown>).installedAt;
  const missingWellKnownBase = wellKnown();
  delete (missingWellKnownBase as Record<string, unknown>).sourceBaseUrl;
  const cases: Array<{ label: string; name?: string; entry: Record<string, unknown> }> = [
    { label: "39-character hash", entry: regular({ skillFolderHash: "a".repeat(39) }) },
    { label: "41-character hash", entry: regular({ skillFolderHash: "a".repeat(41) }) },
    { label: "63-character hash", entry: regular({ skillFolderHash: "a".repeat(63) }) },
    { label: "65-character hash", entry: regular({ skillFolderHash: "a".repeat(65) }) },
    { label: "missing installedAt", entry: missingInstalled },
    { label: "null installedAt", entry: regular({ installedAt: null }) },
    { label: "object updatedAt", entry: regular({ updatedAt: { value: "2026-08-01T00:00:00.000Z" } }) },
    { label: "non-canonical timestamp", entry: regular({ updatedAt: "2026-08-01T00:00:00Z" }) },
    { label: "null ref", entry: regular({ ref: null }) },
    { label: "null skillPath", entry: regular({ skillPath: null }) },
    { label: "null pluginName", entry: regular({ pluginName: null }) },
    { label: "unknown source type", entry: regular({ sourceType: "future-opaque" }) },
    { label: "invalid remote source URL", entry: regular({ sourceUrl: "not-a-url" }) },
    { label: "traversing skill path", entry: regular({ skillPath: "../../evil/SKILL.md" }) },
    { label: "non-GitHub 40-character tree", entry: regular({ sourceType: "git", skillFolderHash: "a".repeat(40) }) },
    { label: "noncanonical skill key", name: "Deploy.Tools", entry: regular() },
    { label: "GitHub well-known digest", entry: regular({ wellKnownDigest: `sha256:${"b".repeat(64)}` }) },
    { label: "GitHub well-known base URL", entry: regular({ sourceBaseUrl: "https://catalog.example" }) },
    { label: "well-known nonempty folder hash", entry: wellKnown({ skillFolderHash: "a".repeat(40) }) },
    { label: "well-known missing source base", entry: missingWellKnownBase },
    { label: "well-known invalid source base", entry: wellKnown({ sourceBaseUrl: "not-a-url" }) },
    { label: "well-known bare digest", entry: wellKnown({ wellKnownDigest: "b".repeat(64) }) },
  ];

  for (const fixture of cases) {
    writeJson(current, { version: 3, skills: { [fixture.name ?? "deploy"]: fixture.entry } });
    writeJson(candidate, { version: 3, skills: { [fixture.name ?? "deploy"]: fixture.entry } });
    assert.throws(
      () => createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate }),
      fixture.label,
    );
    const source = sourceManagerPlan("skills", current, candidate);
    assert.equal(source.status, 2, `source: ${fixture.label}`);
    assert.equal(existsSync(source.output), false, `source output: ${fixture.label}`);
    const bundled = bundledManagerPlan("skills", current, candidate);
    assert.equal(bundled.result.status, 2, `bundle: ${fixture.label}: ${bundled.result.stderr || bundled.result.stdout}`);
    assert.equal(existsSync(bundled.output), false, `bundle output: ${fixture.label}`);
  }

  writeFileSync(current, `{"version":3.0000000000000001,"skills":{}}\n`);
  writeFileSync(candidate, `{"version":3,"skills":{}}\n`);
  assert.throws(() => createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate }), /exact integer 3/);
  assert.equal(sourceManagerPlan("skills", current, candidate).status, 2);
  assert.equal(bundledManagerPlan("skills", current, candidate).result.status, 2);

  writeJson(current, { version: 3, skills: { deploy: regular({ ref: "main" }) } });
  writeJson(candidate, { version: 3, skills: { deploy: regular({ ref: "release" }) } });
  const refOnly = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(refOnly.summary.total, 1);
  assert.equal(refOnly.summary.eligiblePairs, 0);
  assert.equal(refOnly.changes[0].behavioralPreflight, "UNAVAILABLE");
  assert.equal(refOnly.changes[0].current?.integrity, refOnly.changes[0].candidate?.integrity);
  const sourceRefOnly = sourceManagerPlan("skills", current, candidate);
  assert.equal(sourceRefOnly.status, 1);
  assert.equal(JSON.parse(readFileSync(sourceRefOnly.output, "utf8")).summary.eligiblePairs, 0);
  const bundledRefOnly = bundledManagerPlan("skills", current, candidate);
  assert.equal(bundledRefOnly.result.status, 1, bundledRefOnly.result.stderr || bundledRefOnly.result.stdout);
  assert.equal(JSON.parse(readFileSync(bundledRefOnly.output, "utf8")).summary.eligiblePairs, 0);

  const capacityLock = (count: number, owner: string, agent: string, folderHash: string) => ({
    version: 3,
    skills: Object.fromEntries(Array.from({ length: count }, (_, index) => {
      const name = `skill-${index}`;
      return [name, regular({
        source: `${owner}/skills-${index}`,
        sourceUrl: `https://github.com/${owner}/skills-${index}.git`,
        skillPath: `skills/${name}/SKILL.md`,
        skillFolderHash: folderHash,
      })];
    })),
    lastSelectedAgents: [agent],
  });
  writeJson(current, capacityLock(2_048, "current", "codex", "a".repeat(40)));
  writeJson(candidate, capacityLock(2_048, "candidate", "claude-code", "b".repeat(40)));
  const boundary = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(boundary.summary.total, 4_097);
  assert.equal(boundary.summary.added, 2_048);
  assert.equal(boundary.summary.removed, 2_048);
  assert.equal(boundary.summary.updated, 1);
  const schema = JSON.parse(readFileSync(resolve("docs/update-plan-v1.schema.json"), "utf8")) as {
    properties: { changes: { maxItems: number }; summary: { properties: { total: { maximum: number } } } };
    $defs: { change: { allOf: Array<{ then?: { required?: string[]; not?: { required: string[] } } }> } };
  };
  assert.equal(schema.properties.changes.maxItems, 4_097);
  assert.equal(schema.properties.summary.properties.total.maximum, 4_097);
  assert.ok(boundary.summary.total <= schema.properties.changes.maxItems);
  const addedRule = schema.$defs.change.allOf.find((rule) => rule.then?.required?.includes("candidate")
    && rule.then?.not?.required.includes("current"));
  const removedRule = schema.$defs.change.allOf.find((rule) => rule.then?.required?.includes("current")
    && rule.then?.not?.required.includes("candidate"));
  assert.deepEqual(addedRule?.then?.not, { required: ["current"] });
  assert.deepEqual(removedRule?.then?.not, { required: ["candidate"] });
  const endpointPresenceAllowed = (
    rule: typeof addedRule,
    value: { current?: unknown; candidate?: unknown },
  ) => Boolean(rule?.then?.required?.every((field) => Object.hasOwn(value, field))
    && !rule.then.not?.required.every((field) => Object.hasOwn(value, field)));
  assert.equal(endpointPresenceAllowed(addedRule, { current: {}, candidate: {} }), false);
  assert.equal(endpointPresenceAllowed(removedRule, { current: {}, candidate: {} }), false);
  assert.throws(
    () => createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate, generatedAt: "not-a-date" }),
    /exact UTC ISO timestamp/,
  );
  assert.throws(
    () => createUpdatePlan({
      manager: "skills",
      currentPath: current,
      candidatePath: candidate,
      generatedAt: `2026-08-23T12:00:00.000Z${"x".repeat(65)}`,
    }),
    /bounded non-empty string/,
  );
  const sourceBoundary = spawnedSourceManagerPlan("skills", current, candidate);
  assert.equal(sourceBoundary.result.status, 1, sourceBoundary.result.stderr || sourceBoundary.result.stdout);
  assert.equal(JSON.parse(readFileSync(sourceBoundary.output, "utf8")).summary.total, 4_097);
  const bundledBoundary = bundledManagerPlan("skills", current, candidate);
  assert.equal(bundledBoundary.result.status, 1, bundledBoundary.result.stderr || bundledBoundary.result.stdout);
  assert.equal(JSON.parse(readFileSync(bundledBoundary.output, "utf8")).summary.total, 4_097);

  writeJson(current, capacityLock(2_049, "current", "codex", "a".repeat(40)));
  writeJson(candidate, capacityLock(2_049, "candidate", "claude-code", "b".repeat(40)));
  assert.throws(
    () => createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate }),
    /more than 4097 bounded changes/,
  );
  const sourceOverflow = spawnedSourceManagerPlan("skills", current, candidate);
  assert.equal(sourceOverflow.result.status, 2, sourceOverflow.result.stderr || sourceOverflow.result.stdout);
  assert.equal(existsSync(sourceOverflow.output), false);
  const bundledOverflow = bundledManagerPlan("skills", current, candidate);
  assert.equal(bundledOverflow.result.status, 2, bundledOverflow.result.stderr || bundledOverflow.result.stdout);
  assert.equal(existsSync(bundledOverflow.output), false);
});

test("Skills v3 distinguishes Git tree and content-digest identities", () => {
  const directory = temp("vigil-skills-hash-kinds-");
  const current = join(directory, "current.json");
  const candidate = join(directory, "candidate.json");
  const lock = (folderHash: string) => ({
    version: 3,
    skills: {
      deploy: {
        source: "example/skills",
        sourceType: "github",
        sourceUrl: "https://github.com/example/skills.git",
        skillPath: "skills/deploy/SKILL.md",
        skillFolderHash: folderHash,
        installedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });
  writeJson(current, lock("a".repeat(64)));
  writeJson(candidate, lock("b".repeat(64)));
  const direct = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(direct.summary.eligiblePairs, 1);
  assert.equal(direct.changes[0].current?.integrityKind, "sha256");
  assert.equal(direct.changes[0].current?.integrity, `sha256:${"a".repeat(64)}`);
  assert.equal(direct.changes[0].candidate?.integrity, `sha256:${"b".repeat(64)}`);
  if (!process.env.NODE_V8_COVERAGE) {
    const source = sourceManagerPlan("skills", current, candidate);
    assert.equal(source.status, 1);
    assert.equal(JSON.parse(readFileSync(source.output, "utf8")).changes[0].current.integrityKind, "sha256");
    const bundled = bundledManagerPlan("skills", current, candidate);
    assert.equal(bundled.result.status, 1, bundled.result.stderr || bundled.result.stdout);
    assert.equal(JSON.parse(readFileSync(bundled.output, "utf8")).changes[0].current.integrityKind, "sha256");
  }

  const localLock = (folderHash: string) => ({
    version: 3,
    skills: {
      deploy: {
        source: "./skills",
        sourceType: "local",
        sourceUrl: "./skills",
        skillPath: "deploy/SKILL.md",
        skillFolderHash: folderHash,
        installedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });
  writeJson(current, localLock("a".repeat(64)));
  writeJson(candidate, localLock("b".repeat(64)));
  const local = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(local.summary.total, 1);
  assert.equal(local.summary.eligiblePairs, 0);
  assert.equal(local.changes[0].behavioralPreflight, "UNAVAILABLE");
  assert.equal(local.changes[0].current?.integrityKind, "unbound");
  if (!process.env.NODE_V8_COVERAGE) {
    const bundledLocal = bundledManagerPlan("skills", current, candidate);
    assert.equal(bundledLocal.result.status, 1, bundledLocal.result.stderr || bundledLocal.result.stdout);
    assert.equal(JSON.parse(readFileSync(bundledLocal.output, "utf8")).summary.eligiblePairs, 0);
  }
});

test("Skills v3 treats a same-name source replacement as removed and added", () => {
  const directory = temp("vigil-skills-lineage-");
  const current = join(directory, "current.json");
  const candidate = join(directory, "candidate.json");
  const lock = (source: string, sourceUrl: string, folderHash: string) => ({
    version: 3,
    skills: {
      deploy: {
        source,
        sourceType: "github",
        sourceUrl,
        skillPath: "skills/deploy/SKILL.md",
        skillFolderHash: folderHash,
        installedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });
  writeJson(current, lock("good/skills", "https://github.com/good/skills.git", "a".repeat(40)));
  writeJson(candidate, lock("attacker/skills", "https://github.com/attacker/skills.git", "b".repeat(40)));
  const direct = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
  assert.equal(direct.summary.total, 2);
  assert.equal(direct.summary.added, 1);
  assert.equal(direct.summary.removed, 1);
  assert.equal(direct.summary.eligiblePairs, 0);
  if (!process.env.NODE_V8_COVERAGE) {
    const source = sourceManagerPlan("skills", current, candidate);
    assert.equal(source.status, 1);
    assert.equal(JSON.parse(readFileSync(source.output, "utf8")).summary.eligiblePairs, 0);
    const bundled = bundledManagerPlan("skills", current, candidate);
    assert.equal(bundled.result.status, 1, bundled.result.stderr || bundled.result.stdout);
    assert.equal(JSON.parse(readFileSync(bundled.output, "utf8")).summary.eligiblePairs, 0);
  }
});

test("strict manager JSON binds exact number source through source and bundled CLIs", {
  skip: Boolean(process.env.NODE_V8_COVERAGE),
}, () => {
  const directory = temp("vigil-skills-json-numbers-");
  const current = join(directory, "current.json");
  const candidate = join(directory, "candidate.json");
  const rawLock = (entryExtra = "", rootExtra = "") => (
    `{"version":3,"skills":{"deploy":{"source":"example/skills","sourceType":"github",`
    + `"sourceUrl":"https://github.com/example/skills.git","skillPath":"skills/deploy/SKILL.md",`
    + `"skillFolderHash":"${"a".repeat(40)}","installedAt":"2026-08-01T00:00:00.000Z",`
    + `"updatedAt":"2026-08-01T00:00:00.000Z"${entryExtra}}}${rootExtra}}\n`
  );
  const pairs = [
    [rawLock(",\"futureLimit\":9007199254740992"), rawLock(",\"futureLimit\":9007199254740993")],
    [rawLock(",\"futureLimit\":1e400"), rawLock(",\"futureLimit\":1e401")],
    [rawLock(",\"futureLimit\":0"), rawLock(",\"futureLimit\":-0")],
    [rawLock("", ",\"futureManagerLimit\":1e400"), rawLock("", ",\"futureManagerLimit\":-1e400")],
    [rawLock("", ",\"futureManagerLimit\":1e-400"), rawLock("", ",\"futureManagerLimit\":-1e-400")],
  ] as const;
  for (const [before, after] of pairs) {
    writeFileSync(current, before);
    writeFileSync(candidate, after);
    const direct = createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate });
    assert.equal(direct.summary.total, 1);
    const source = sourceManagerPlan("skills", current, candidate);
    assert.equal(source.status, 1);
    assert.equal(JSON.parse(readFileSync(source.output, "utf8")).summary.total, 1);
    const bundled = bundledManagerPlan("skills", current, candidate);
    assert.equal(bundled.result.status, 1, bundled.result.stderr || bundled.result.stdout);
    assert.equal(JSON.parse(readFileSync(bundled.output, "utf8")).summary.total, 1);
  }
});

test("manager inputs reject malformed UTF-8 and never expose parser source excerpts", {
  skip: Boolean(process.env.NODE_V8_COVERAGE),
}, () => {
  const directory = temp("vigil-manager-input-privacy-");
  const current = join(directory, "current.json");
  const candidate = join(directory, "candidate.json");
  const template = Buffer.from(
    `{"version":3,"skills":{"deploy":{"source":"example/skills","sourceType":"github",`
    + `"sourceUrl":"https://github.com/example/skills.git","skillFolderHash":"${"a".repeat(40)}",`
    + `"installedAt":"2026-08-01T00:00:00.000Z","updatedAt":"2026-08-01T00:00:00.000Z",`
    + `"futureText":"PLACEHOLDER"}}}\n`,
  );
  const marker = template.indexOf("PLACEHOLDER");
  const malformed = (byte: number) => Buffer.concat([
    template.subarray(0, marker), Buffer.from([byte]), template.subarray(marker + "PLACEHOLDER".length),
  ]);
  writeFileSync(current, malformed(0x80));
  writeFileSync(candidate, malformed(0x81));
  assert.throws(() => createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate }), /not valid UTF-8/);
  assert.equal(sourceManagerPlan("skills", current, candidate).status, 2);
  assert.equal(bundledManagerPlan("skills", current, candidate).result.status, 2);

  const jsonSecret = "JSON_SUPERSECRET";
  writeFileSync(current,
    `{"version":3,"skills":{"deploy":{"source":"example/skills","sourceType":"github",`
    + `"sourceUrl":"https://user:${jsonSecret}@example.com/a","sourceUrl":"https://github.com/example/skills.git",`
    + `"skillFolderHash":"${"a".repeat(40)}","installedAt":"2026-08-01T00:00:00.000Z",`
    + `"updatedAt":"2026-08-01T00:00:00.000Z"}}}\n`,
  );
  writeFileSync(candidate, readFileSync(current));
  assert.throws(
    () => createUpdatePlan({ manager: "skills", currentPath: current, candidatePath: candidate }),
    (error: unknown) => error instanceof Error && !error.message.includes(jsonSecret) && /invalid JSON/.test(error.message),
  );
  const sourceJson = sourceManagerPlan("skills", current, candidate);
  assert.equal(sourceJson.status, 2);
  assert.doesNotMatch(sourceJson.messages, new RegExp(jsonSecret));
  const bundledJson = bundledManagerPlan("skills", current, candidate);
  assert.equal(bundledJson.result.status, 2);
  assert.doesNotMatch(`${bundledJson.result.stdout}${bundledJson.result.stderr}`, new RegExp(jsonSecret));

  const apmCurrent = join(directory, "current.yaml");
  const apmCandidate = join(directory, "candidate.yaml");
  const apmSecret = "APM_SUPERSECRET";
  writeFileSync(apmCurrent,
    `lockfile_version: "1"\ndependencies:\n  - repo_url: "https://user:${apmSecret}@example.com/a"\n`
    + `    repo_url: "https://example.com/a"\n    resolved_commit: ${"a".repeat(40)}\n`,
  );
  writeFileSync(apmCandidate, readFileSync(apmCurrent));
  assert.throws(
    () => createUpdatePlan({ manager: "apm", currentPath: apmCurrent, candidatePath: apmCandidate }),
    (error: unknown) => error instanceof Error && !error.message.includes(apmSecret) && /invalid YAML/.test(error.message),
  );
  const sourceApm = sourceManagerPlan("apm", apmCurrent, apmCandidate);
  assert.equal(sourceApm.status, 2);
  assert.doesNotMatch(sourceApm.messages, new RegExp(apmSecret));
  const bundledApm = bundledManagerPlan("apm", apmCurrent, apmCandidate);
  assert.equal(bundledApm.result.status, 2);
  assert.doesNotMatch(`${bundledApm.result.stdout}${bundledApm.result.stderr}`, new RegExp(apmSecret));
});

test("APM plans retain pseudonymous change identity without emitting manager text", {
  skip: Boolean(process.env.NODE_V8_COVERAGE),
}, () => {
  const directory = temp("vigil-apm-plan-privacy-");
  const current = join(directory, "current.yaml");
  const candidate = join(directory, "candidate.yaml");
  const secrets = [
    "APM_MISSING_NAME_REPO_PASSWORD",
    "APM_REPO_PASSWORD",
    "APM_NAME_SECRET",
    "APM_VERSION_SECRET",
    "APM_TAG_SECRET",
    "APM_REF_SECRET",
    "APM_HASH_SECRET",
    "APM_CONTENT_SECRET",
    "APM_HOST_SECRET",
    "APM_SOURCE_SECRET",
    "APM_PATH_SECRET",
    "APM_ADDITIVE_SECRET",
  ];
  const lock = (commit: string) => [
    'lockfile_version: "1"',
    "dependencies:",
    `  - repo_url: "https://user:${secrets[0]}@example.com/missing-name.git"`,
    `    resolved_commit: ${commit}`,
    `  - repo_url: "https://user:${secrets[1]}@example.com/private.git"`,
    `    name: "${secrets[2]}"`,
    `    version: "${secrets[3]}"`,
    `    resolved_tag: "${secrets[4]}"`,
    `    resolved_ref: "${secrets[5]}"`,
    `    resolved_hash: "${secrets[6]}"`,
    `    content_hash: "${secrets[7]}"`,
    `    host: "${secrets[8]}"`,
    `    source: "${secrets[9]}"`,
    `    local_path: "${secrets[10]}"`,
    `    future_private_field: "${secrets[11]}"`,
    `    resolved_commit: ${commit}`,
    "",
  ].join("\n");
  writeFileSync(current, lock("a".repeat(40)));
  writeFileSync(candidate, lock("b".repeat(40)));

  const plan = createUpdatePlan({
    manager: "apm",
    currentPath: current,
    candidatePath: candidate,
    generatedAt: "2026-08-23T12:00:00.000Z",
  });
  assert.equal(plan.summary.updated, 2);
  assert.equal(plan.summary.eligiblePairs, 2);
  for (const change of plan.changes) {
    assert.match(change.identity, /^apm:[0-9a-f]{64}$/);
    assert.equal(change.displayName, `APM dependency ${change.identity.slice(4, 16)}`);
    assert.equal(change.current?.version, `commit:${"a".repeat(12)}`);
    assert.equal(change.candidate?.version, `commit:${"b".repeat(12)}`);
  }
  for (const secret of secrets) assert.doesNotMatch(JSON.stringify(plan), new RegExp(secret));

  const source = sourceManagerPlan("apm", current, candidate);
  assert.equal(source.status, 1);
  const sourceSurface = `${source.messages}\n${readFileSync(source.output, "utf8")}`;
  for (const secret of secrets) assert.doesNotMatch(sourceSurface, new RegExp(secret));

  const bundled = bundledManagerPlan("apm", current, candidate);
  assert.equal(bundled.result.status, 1, bundled.result.stderr || bundled.result.stdout);
  const bundledSurface = `${bundled.result.stdout}\n${bundled.result.stderr}\n${readFileSync(bundled.output, "utf8")}`;
  for (const secret of secrets) assert.doesNotMatch(bundledSurface, new RegExp(secret));
});

test("APM duplicate dependency diagnostics never emit credential-bearing identity inputs", {
  skip: Boolean(process.env.NODE_V8_COVERAGE),
}, () => {
  const directory = temp("vigil-apm-duplicate-privacy-");
  const current = join(directory, "current.yaml");
  const candidate = join(directory, "candidate.yaml");
  const repoSecret = "APM_DUPLICATE_REPO_PASSWORD";
  const nameSecret = "APM_DUPLICATE_NAME_SECRET";
  const versionSecret = "APM_DUPLICATE_VERSION_SECRET";
  const dependency = [
    `  - repo_url: "https://user:${repoSecret}@example.com/private.git"`,
    `    name: "${nameSecret}"`,
    `    version: "${versionSecret}"`,
    `    resolved_commit: ${"a".repeat(40)}`,
  ].join("\n");
  writeFileSync(current, `lockfile_version: "1"\ndependencies:\n${dependency}\n${dependency}\n`);
  writeFileSync(candidate, readFileSync(current));

  assert.throws(
    () => createUpdatePlan({ manager: "apm", currentPath: current, candidatePath: candidate }),
    (error: unknown) => error instanceof Error
      && /duplicate dependency identity/.test(error.message)
      && !error.message.includes(repoSecret)
      && !error.message.includes(nameSecret)
      && !error.message.includes(versionSecret),
  );
  const source = sourceManagerPlan("apm", current, candidate);
  assert.equal(source.status, 2);
  assert.doesNotMatch(source.messages, new RegExp(`${repoSecret}|${nameSecret}|${versionSecret}`));
  const bundled = bundledManagerPlan("apm", current, candidate);
  assert.equal(bundled.result.status, 2);
  assert.doesNotMatch(`${bundled.result.stdout}${bundled.result.stderr}`, new RegExp(`${repoSecret}|${nameSecret}|${versionSecret}`));
});

test("Skills v3 security-bearing field matrix is nonzero through source and bundled CLIs", {
  // Executing the generated bundle under Node's source-coverage collector adds
  // a second generated copy of the program to the source denominator.
  skip: Boolean(process.env.NODE_V8_COVERAGE),
}, () => {
  const fixtureRoot = resolve("test/fixtures/skills-v3");
  const current = join(fixtureRoot, "current.json");
  const candidates = [
    { name: "source-url-candidate.json", current: "current.json", total: 2, eligible: 0 },
    { name: "source-base-url-candidate.json", current: "well-known-current.json", total: 2, eligible: 0 },
    { name: "well-known-digest-candidate.json", current: "well-known-current.json", total: 1, eligible: 1 },
    { name: "plugin-name-candidate.json", current: "current.json", total: 2, eligible: 0 },
    { name: "unknown-entry-candidate.json", current: "current.json", total: 1, eligible: 0 },
  ];
  for (const fixture of candidates) {
    const fixtureCurrent = join(fixtureRoot, fixture.current);
    const candidate = join(fixtureRoot, fixture.name);
    const sourceRepository = temp("vigil-skills-source-cli-");
    execFileSync("git", ["init", "-q"], { cwd: sourceRepository });
    const sourceOutput = join(sourceRepository, "plan.json");
    assert.equal(runUpgradeCommand([
      "plan", "--manager", "skills", "--current", fixtureCurrent, "--candidate", candidate,
      "--repo", sourceRepository, "--output", "plan.json",
    ]), 1, `source CLI: ${fixture.name}`);
    const sourcePlan = JSON.parse(readFileSync(sourceOutput, "utf8"));
    assert.equal(sourcePlan.summary.total, fixture.total, `source CLI total: ${fixture.name}`);
    assert.equal(sourcePlan.summary.eligiblePairs, fixture.eligible, `source CLI eligible: ${fixture.name}`);
    for (const change of sourcePlan.changes.filter((item: { behavioralPreflight: string }) => item.behavioralPreflight === "REQUIRED")) {
      assert.notDeepEqual(change.current, change.candidate, `source CLI exact pair: ${fixture.name}`);
    }

    const bundledRepository = temp("vigil-skills-bundled-cli-");
    execFileSync("git", ["init", "-q"], { cwd: bundledRepository });
    const bundledOutput = join(bundledRepository, "plan.json");
    const bundled = spawnSync(process.execPath, [
      resolve("dist/cli.js"), "upgrade", "plan", "--manager", "skills",
      "--current", fixtureCurrent, "--candidate", candidate,
      "--repo", bundledRepository, "--output", "plan.json",
    ], { cwd: bundledRepository, encoding: "utf8", env: withoutInheritedNodeCoverage() });
    assert.equal(bundled.status, 1, `${fixture.name}: ${bundled.stderr || bundled.stdout}`);
    const bundledPlan = JSON.parse(readFileSync(bundledOutput, "utf8"));
    assert.equal(bundledPlan.summary.total, fixture.total, `bundled CLI total: ${fixture.name}`);
    assert.equal(bundledPlan.summary.eligiblePairs, fixture.eligible, `bundled CLI eligible: ${fixture.name}`);
    for (const change of bundledPlan.changes.filter((item: { behavioralPreflight: string }) => item.behavioralPreflight === "REQUIRED")) {
      assert.notDeepEqual(change.current, change.candidate, `bundled CLI exact pair: ${fixture.name}`);
    }
  }
});

test("APM adapter fail-closes on dependency, workspace, and additive state changes", () => {
  const directory = temp();
  const dependency = (extra = "") => `  - repo_url: github.com/example/plugin\n    name: example-plugin\n    version: 1.0.0\n    resolved_commit: ${"a".repeat(40)}\n${extra}`;
  const lock = (dependencyExtra = "", workspace = "", generatedAt = "2026-08-23T12:00:00.000Z", apmVersion = "0.6.4") => (
    `lockfile_version: "1"\ngenerated_at: "${generatedAt}"\napm_version: "${apmVersion}"\ndependencies:\n${dependency(dependencyExtra)}${workspace}`
  );
  const workspaceCases = [
    {
      name: "MCP command and arguments",
      current: "mcp_servers: [github]\nmcp_configs:\n  github:\n    type: stdio\n    command: node\n    args: [old.js]\n",
      candidate: "mcp_servers: [github]\nmcp_configs:\n  github:\n    type: stdio\n    command: node\n    args: [new.js]\n",
      reason: /MCP command, arguments/,
    },
    {
      name: "MCP server inventory",
      current: "mcp_servers: [github]\n",
      candidate: "mcp_servers: [github, local]\n",
      reason: /MCP command, arguments/,
    },
    {
      name: "local deployment state",
      current: `local_deployed_files: [.claude/skills/old/SKILL.md]\nlocal_deployed_file_hashes:\n  .claude/skills/old/SKILL.md: ${"b".repeat(64)}\n`,
      candidate: `local_deployed_files: [.claude/skills/new/SKILL.md]\nlocal_deployed_file_hashes:\n  .claude/skills/new/SKILL.md: ${"c".repeat(64)}\n`,
      reason: /local deployment state/,
    },
    {
      name: "canonical deployment ledger",
      current: `deployments:\n  - kind: uri\n    target: mcp\n    value: mcp://github\n    runtime: codex\n    scope: project\n    owners: [github.com/example/plugin]\n    active_owner: github.com/example/plugin\n    content_hash: sha256:${"d".repeat(64)}\n`,
      candidate: `deployments:\n  - kind: uri\n    target: mcp\n    value: mcp://github\n    runtime: claude\n    scope: project\n    owners: [github.com/example/plugin]\n    active_owner: github.com/example/plugin\n    content_hash: sha256:${"d".repeat(64)}\n`,
      reason: /canonical deployment ledger/,
    },
    {
      name: "unknown additive top-level field",
      current: "x-future-runtime-state:\n  mode: old\n",
      candidate: "x-future-runtime-state:\n  mode: new\n",
      reason: /other APM additive workspace state/,
    },
    {
      name: "non-finite additive scalar",
      current: "x-future-runtime-state: null\n",
      candidate: "x-future-runtime-state: .nan\n",
      reason: /other APM additive workspace state/,
    },
    {
      name: "coercion-prone scalar spelling",
      current: "x-future-runtime-state:\n  args: [01]\n",
      candidate: "x-future-runtime-state:\n  args: [1]\n",
      reason: /other APM additive workspace state/,
    },
  ] as const;

  for (const fixture of workspaceCases) {
    const current = join(directory, `${fixture.name.replaceAll(" ", "-")}-current.yaml`);
    const candidate = join(directory, `${fixture.name.replaceAll(" ", "-")}-candidate.yaml`);
    writeFileSync(current, lock("", fixture.current));
    writeFileSync(candidate, lock("", fixture.candidate));
    const plan = createUpdatePlan({ manager: "apm", currentPath: current, candidatePath: candidate, generatedAt: "2026-08-23T12:00:00.000Z" });
    assert.equal(plan.summary.total, 1, fixture.name);
    assert.equal(plan.summary.eligiblePairs, 1, fixture.name);
    assert.equal(plan.changes[0].componentType, "apm-workspace", fixture.name);
    assert.equal(plan.changes[0].behavioralPreflight, "REQUIRED", fixture.name);
    assert.notEqual(plan.changes[0].current?.integrity, plan.changes[0].candidate?.integrity, fixture.name);
    assert.match(plan.changes[0].reasons.join(" "), fixture.reason, fixture.name);
  }

  const deployedCurrent = join(directory, "deployed-current.yaml");
  const deployedCandidate = join(directory, "deployed-candidate.yaml");
  writeFileSync(deployedCurrent, lock("    deployed_files: [.claude/skills/old/SKILL.md]\n"));
  writeFileSync(deployedCandidate, lock("    deployed_files: [.claude/skills/new/SKILL.md]\n"));
  const deployed = createUpdatePlan({ manager: "apm", currentPath: deployedCurrent, candidatePath: deployedCandidate });
  assert.equal(deployed.summary.total, 1);
  assert.equal(deployed.changes[0].componentType, "apm-package");
  assert.equal(deployed.changes[0].behavioralPreflight, "UNAVAILABLE");
  assert.deepEqual(deployed.changes[0].current, deployed.changes[0].candidate);

  const diagnosticCurrent = join(directory, "diagnostic-current.yaml");
  const diagnosticCandidate = join(directory, "diagnostic-candidate.yaml");
  writeFileSync(diagnosticCurrent, lock("", "", "2026-08-23T12:00:00.000Z", "0.6.4"));
  writeFileSync(diagnosticCandidate, lock("", "", "2026-08-24T12:00:00.000Z", "0.7.0"));
  const diagnosticOnly = createUpdatePlan({ manager: "apm", currentPath: diagnosticCurrent, candidatePath: diagnosticCandidate });
  assert.equal(diagnosticOnly.summary.total, 0);
  assert.notEqual(diagnosticOnly.source.currentSha256, diagnosticOnly.source.candidateSha256);

  execFileSync("git", ["init", "-q"], { cwd: directory });
  assert.equal(runUpgradeCommand([
    "plan", "--manager", "apm", "--current", workspaceCases[0] ? join(directory, `${workspaceCases[0].name.replaceAll(" ", "-")}-current.yaml`) : "",
    "--candidate", workspaceCases[0] ? join(directory, `${workspaceCases[0].name.replaceAll(" ", "-")}-candidate.yaml`) : "",
    "--repo", directory, "--output", "apm-plan.json",
  ]), 1);
});

test("APM identities cannot collide through delimiter-controlled manager fields", () => {
  const directory = temp();
  const state = join(directory, "state.lock.yaml");
  writeFileSync(state, `lockfile_version: "1"\ndependencies:\n  - host: a\n    source: "b:c"\n    repo_url: d\n    resolved_commit: ${"a".repeat(40)}\n  - host: "a:b"\n    source: c\n    repo_url: d\n    resolved_commit: ${"b".repeat(40)}\n`);
  const plan = createUpdatePlan({ manager: "apm", currentPath: state, candidatePath: state, generatedAt: "2026-08-23T12:00:00.000Z" });
  assert.equal(plan.summary.total, 0);
});

test("manager JSON rejects duplicate keys instead of silently selecting one update state", () => {
  const directory = temp();
  const state = join(directory, "skills.json");
  writeFileSync(state, `{"version":3,"skills":{"deploy":{"source":"first/source","source":"second/source","sourceType":"github","skillFolderHash":"${"a".repeat(40)}"}}}`);
  assert.throws(
    () => createUpdatePlan({ manager: "skills", currentPath: state, candidatePath: state }),
    /invalid|Map keys must be unique/,
  );
});

test("manager adapters fail closed on malformed states and classify add/remove changes", () => {
  const directory = temp();
  const invalidApm = join(directory, "invalid-apm.yaml");
  writeFileSync(invalidApm, "lockfile_version: \"9\"\ndependencies: []\n");
  assert.throws(
    () => createUpdatePlan({ manager: "apm", currentPath: invalidApm, candidatePath: invalidApm }),
    /lockfile_version must be 1 or 2/,
  );
  writeFileSync(invalidApm, "lockfile_version: \"1\"\nx-runtime: !custom value\ndependencies: []\n");
  assert.throws(
    () => createUpdatePlan({ manager: "apm", currentPath: invalidApm, candidatePath: invalidApm }),
    /unsupported YAML syntax/,
  );
  writeFileSync(invalidApm, "lockfile_version: \"1\"\nx-runtime: &runtime value\nx-copy: *runtime\ndependencies: []\n");
  assert.throws(
    () => createUpdatePlan({ manager: "apm", currentPath: invalidApm, candidatePath: invalidApm }),
    /anchors and aliases|unsupported nodes/,
  );

  const invalidSkills = join(directory, "invalid-skills.json");
  writeJson(invalidSkills, { version: 2, skills: {} });
  assert.throws(
    () => createUpdatePlan({ manager: "skills", currentPath: invalidSkills, candidatePath: invalidSkills }),
    /exact integer 3/,
  );
  writeJson(invalidSkills, {
    version: 3,
    skills: {
      "../escape": { source: "example/skills", sourceType: "github", skillFolderHash: "a".repeat(40) },
    },
  });
  assert.throws(
    () => createUpdatePlan({ manager: "skills", currentPath: invalidSkills, candidatePath: invalidSkills }),
    /unsupported skill name/,
  );
  writeJson(invalidSkills, {
    version: 3,
    skills: {
      deploy: {
        source: "example/skills", sourceType: "github",
        sourceUrl: "https://github.com/example/skills.git", skillPath: "skills/deploy/SKILL.md",
        skillFolderHash: "not-a-tree", installedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  });
  assert.throws(
    () => createUpdatePlan({ manager: "skills", currentPath: invalidSkills, candidatePath: invalidSkills }),
    /not an exact/,
  );

  const current = join(directory, "current.lock.yaml");
  const candidate = join(directory, "candidate.lock.yaml");
  writeFileSync(current, `lockfile_version: "1"\ndependencies:\n  - repo_url: github.com/example/removed\n    resolved_commit: ${"a".repeat(40)}\n`);
  writeFileSync(candidate, `lockfile_version: "1"\ndependencies:\n  - repo_url: github.com/example/added\n    resolved_commit: ${"b".repeat(40)}\n`);
  const plan = createUpdatePlan({ manager: "apm", currentPath: current, candidatePath: candidate });
  assert.equal(plan.summary.added, 1);
  assert.equal(plan.summary.removed, 1);
  assert.equal(plan.summary.eligiblePairs, 0);

  const pluginCurrent = join(directory, "plugin-current");
  const pluginCandidate = join(directory, "plugin-candidate");
  for (const [root, version] of [[pluginCurrent, "1.0.0"], [pluginCandidate, "1.1.0"]] as const) {
    mkdirSync(root);
    writeJson(join(root, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "minimal-plugin",
      version,
    });
  }
  const pluginPlan = createUpdatePlan({ manager: "agent-plugin", currentPath: pluginCurrent, candidatePath: pluginCandidate });
  assert.equal(pluginPlan.summary.eligiblePairs, 1);
  assert.ok(pluginPlan.changes[0].reasons.includes("resolved version changed"));
});

test("artifact inventory streams real-world bundles above the former 4 MiB ceiling", () => {
  const directory = temp();
  const bytes = Buffer.alloc(5 * 1024 * 1024, 0x61);
  writeFileSync(join(directory, "client-bundle.js"), bytes);
  const inventory = inspectArtifactTree(directory);
  assert.equal(inventory.fileCount, 1);
  assert.equal(inventory.totalBytes, bytes.length);
  assert.match(inventory.treeSha256, /^sha256:[0-9a-f]{64}$/);
});

test("artifact inventory binds lstat metadata to the opened bytes and fails closed on replacement", () => {
  const directory = temp("vigil-artifact-open-race-");
  const target = join(directory, "bundle.js");
  const displaced = join(directory, "bundle.original.js");
  const replacement = join(directory, "bundle.replacement.js");
  writeFileSync(target, "nine-byte");
  writeFileSync(replacement, Buffer.alloc(5 * 1024 * 1024, 0x62));

  let injected = false;
  assert.throws(
    () => inspectArtifactTree(directory, {
      afterEntryLstat(path) {
        if (injected || basename(path) !== "bundle.js") return;
        injected = true;
        renameSync(target, displaced);
        renameSync(replacement, target);
      },
    }),
    /changed while it was being opened for inventory/,
  );
  assert.equal(injected, true);
});

test("Agent Plugins adapter binds the exact package tree and declared component surface", () => {
  const directory = temp();
  const current = join(directory, "current");
  const candidate = join(directory, "candidate");
  for (const root of [current, candidate]) mkdirSync(join(root, "skills", "review"), { recursive: true });
  writeJson(join(current, "plugin.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review-tools", version: "1.0.0",
  });
  writeJson(join(candidate, "plugin.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review-tools", version: "1.1.0",
  });
  writeFileSync(join(current, "skills", "review", "SKILL.md"), "---\nname: review\n---\nOld\n");
  writeFileSync(join(candidate, "skills", "review", "SKILL.md"), "---\nname: review\n---\nNew\n");
  writeJson(join(current, "mcp.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {},
  });
  writeJson(join(candidate, "mcp.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { local: { type: "stdio", command: "node" } },
  });
  const plan = createUpdatePlan({ manager: "agent-plugin", currentPath: current, candidatePath: candidate, generatedAt: "2026-08-23T12:00:00.000Z" });
  assert.equal(plan.summary.eligiblePairs, 1);
  assert.equal(plan.changes[0].componentType, "agent-plugin");
  assert.ok(plan.changes[0].reasons.includes("declared component surface changed"));
  assert.notEqual(plan.source.currentSha256, plan.source.candidateSha256);
});

test("Agent Plugins plan refuses an output inside either exact input tree", () => {
  const directory = temp();
  execFileSync("git", ["init", "-q"], { cwd: directory });
  const current = join(directory, "current");
  const candidate = join(directory, "candidate");
  for (const [root, version] of [[current, "1.0.0"], [candidate, "1.1.0"]] as const) {
    mkdirSync(root);
    writeJson(join(root, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "review-tools", version,
    });
  }
  assert.equal(runUpgradeCommand([
    "plan", "--manager", "agent-plugin", "--current", current, "--candidate", candidate,
    "--repo", directory, "--output", "current/plan.json",
  ]), 2);
  assert.throws(() => readFileSync(join(current, "plan.json")), /ENOENT/);
});

test("signed restoration records require one baseline, publisher, runner, and a CHANGED to SAFE transition", () => {
  const { broken, fixed, privateKeyPath, publicKeyPath } = entries();
  const resolution = createCompatibilityResolution({
    broken, fixed, privateKeyPath,
    generatedAt: "2026-08-23T12:00:00.000Z",
  });
  assert.deepEqual(validateCompatibilityResolution(resolution), resolution);
  const checked = verifyCompatibilityResolution(resolution, publicKeyPath);
  assert.equal(checked.hashValid, true);
  assert.equal(checked.signatureValid, true);
  assert.equal(resolution.broken.entryHash, broken.entryHash);
  assert.equal(resolution.fixed.entryHash, fixed.entryHash);

  const wrongBaseline = structuredClone(fixed);
  wrongBaseline.component.currentArtifactSha256 = sha("different-baseline");
  assert.throws(
    () => createCompatibilityResolution({ broken, fixed: wrongBaseline, privateKeyPath }),
    /valid signed compatibility entries|same exact baseline/,
  );
});

test("resolution and registry public artifacts reject every external URL locator", () => {
  const { broken, fixed, privateKeyPath, publicKeyPath } = entries();
  const clean = createCompatibilityResolution({
    broken, fixed, privateKeyPath,
    generatedAt: "2026-08-23T12:00:00.000Z",
  });
  assert.equal("evidenceUrl" in clean, false);
  assert.deepEqual(validateCompatibilityResolution(clean), clean);

  const sensitiveUrls = [
    ["QUERY_CANARY", "https://example.test/issues/42?token=QUERY_CANARY"],
    ["USERINFO_CANARY", "https://USERINFO_CANARY:PASSWORD_CANARY@example.test/issues/42"],
    ["FRAGMENT_CANARY", "https://example.test/issues/42#FRAGMENT_CANARY"],
    ["PATH_CANARY", "https://example.test/access_token=PATH_CANARY/issues/42"],
  ] as const;
  for (const [canary, evidenceUrl] of sensitiveUrls) {
    const createInput = {
      broken, fixed, privateKeyPath,
      generatedAt: "2026-08-23T12:00:00.000Z",
      evidenceUrl,
    } as unknown as Parameters<typeof createCompatibilityResolution>[0];
    assert.throws(
      () => createCompatibilityResolution(createInput),
      /compatibility resolution input contains unknown field\(s\): evidenceUrl/,
    );

    const injected = { ...clean, evidenceUrl } as unknown as CompatibilityResolution;
    assert.throws(
      () => validateCompatibilityResolution(injected),
      /compatibility resolution contains unknown field\(s\): evidenceUrl/,
    );
    assert.doesNotMatch(
      String(assert.throws(() => validateCompatibilityResolution(injected))),
      new RegExp(canary),
    );
  }

  const evidenceUrl = sensitiveUrls[3][1];
  const unsigned = {
    ...Object.fromEntries(Object.entries(clean).filter(([key]) => key !== "resolutionHash" && key !== "signature")),
    evidenceUrl,
  };
  const injected = structuredClone(clean) as CompatibilityResolution & { evidenceUrl: string };
  injected.evidenceUrl = evidenceUrl;
  injected.resolutionHash = `sha256:${createHash("sha256").update(canonical(unsigned)).digest("hex")}`;
  injected.signature.value = sign(
    null,
    Buffer.from(injected.resolutionHash),
    createPrivateKey(readFileSync(privateKeyPath)),
  ).toString("base64");
  assert.equal(verifyCompatibilityResolution(injected).signatureValid, true);
  assert.throws(
    () => createCompatibilityRegistry([broken, fixed], [injected]),
    /compatibility resolution contains unknown field\(s\): evidenceUrl/,
  );

  const directory = temp("vigil-resolution-url-privacy-");
  const brokenPath = join(directory, "broken.json");
  const fixedPath = join(directory, "fixed.json");
  writeJson(brokenPath, broken);
  writeJson(fixedPath, fixed);
  for (const [canary, url] of sensitiveUrls) {
    const sourceOutput = join(directory, `${canary}-source-resolution.json`);
    const source = capturedUpgrade([
      "resolve", "--broken", brokenPath, "--fixed", fixedPath,
      "--output", sourceOutput, "--public-key", publicKeyPath,
      "--signing-key", privateKeyPath, "--evidence-url", url,
    ]);
    assert.equal(source.status, 2);
    assert.equal(existsSync(sourceOutput), false);
    assert.doesNotMatch(source.messages, new RegExp(canary));

    const bundledOutput = join(directory, `${canary}-bundled-resolution.json`);
    const bundled = spawnSync(process.execPath, [
      resolve("dist/cli.js"), "upgrade", "resolve",
      "--broken", brokenPath, "--fixed", fixedPath,
      "--output", bundledOutput, "--public-key", publicKeyPath,
      "--signing-key", privateKeyPath, "--evidence-url", url,
    ], { cwd: resolve("."), encoding: "utf8", env: withoutInheritedNodeCoverage() });
    assert.equal(bundled.status, 2);
    assert.equal(existsSync(bundledOutput), false);
    assert.doesNotMatch(`${bundled.stdout}${bundled.stderr}`, new RegExp(canary));
  }

  const savedPath = join(directory, "injected-resolution.json");
  const registryPath = join(directory, "registry.json");
  const pagePath = join(directory, "index.html");
  writeJson(savedPath, injected);
  const saved = capturedUpgrade(["verify", savedPath, "--public-key", publicKeyPath]);
  assert.equal(saved.status, 2);
  assert.doesNotMatch(saved.messages, /PATH_CANARY/);
  const indexed = capturedUpgrade([
    "index", brokenPath, fixedPath, savedPath,
    "--output", pagePath, "--api-output", registryPath,
    "--public-key", publicKeyPath,
  ]);
  assert.equal(indexed.status, 2);
  assert.equal(existsSync(pagePath), false);
  assert.equal(existsSync(registryPath), false);
  assert.doesNotMatch(indexed.messages, /PATH_CANARY/);

  const sourceHelp = capturedUpgrade(["resolve", "--help"]);
  assert.equal(sourceHelp.status, 0);
  assert.doesNotMatch(sourceHelp.messages, /evidence-url/);
  const bundledHelp = spawnSync(process.execPath, [resolve("dist/cli.js"), "upgrade", "resolve", "--help"], {
    cwd: resolve("."), encoding: "utf8", env: withoutInheritedNodeCoverage(),
  });
  assert.equal(bundledHelp.status, 0);
  assert.doesNotMatch(`${bundledHelp.stdout}${bundledHelp.stderr}`, /evidence-url/);

  const schema = JSON.parse(readFileSync(resolve("docs/compatibility-resolution-v1.schema.json"), "utf8")) as {
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.equal("evidenceUrl" in schema.properties, false);
});

test("registry rejects a validly signed resolution that contradicts its referenced entries", () => {
  const { broken, fixed, privateKeyPath } = entries();
  const resolution = createCompatibilityResolution({ broken, fixed, privateKeyPath, generatedAt: "2026-08-23T12:00:00.000Z" });
  const contradictory = structuredClone(resolution);
  contradictory.broken.brokenVersion = "9.9.9";
  const { resolutionHash: _oldHash, signature: _oldSignature, ...unsigned } = contradictory;
  contradictory.resolutionHash = `sha256:${createHash("sha256").update(canonical(unsigned)).digest("hex")}`;
  contradictory.signature.value = sign(null, Buffer.from(contradictory.resolutionHash), createPrivateKey(readFileSync(privateKeyPath))).toString("base64");
  assert.equal(verifyCompatibilityResolution(contradictory).signatureValid, true);
  assert.throws(() => createCompatibilityRegistry([broken, fixed], [contradictory]), /inconsistent/);
});

test("registry page, JSON API model, badge, and maintainer packet form a privacy-safe distribution loop", () => {
  const { broken, fixed, privateKeyPath } = entries();
  const resolution = createCompatibilityResolution({ broken, fixed, privateKeyPath, generatedAt: "2026-08-23T12:00:00.000Z" });
  const registry = createCompatibilityRegistry([broken, fixed], [resolution]);
  assert.equal(registry.summary.entries, 2);
  assert.equal(registry.summary.resolvedBreakages, 1);
  const page = renderCompatibilityRegistryPage(registry);
  assert.match(page, /Agent compatibility proof registry/);
  assert.match(page, /Search proofs/);
  assert.match(page, /restored by a later verified pair/);
  assert.match(page, /script-src 'sha256-/);
  assert.doesNotMatch(page, /private-behavior|private-command|broken-nonce|fixed-nonce/);
  assert.deepEqual(JSON.parse(renderBadgeEndpoint(broken)), {
    schemaVersion: 1, label: "agent update", message: "changed", color: "d38b16",
  });
  const evidence = renderMaintainerEvidence(broken);
  assert.match(evidence, /Agent update evidence: CHANGED/);
  assert.match(evidence, new RegExp(broken.entryHash));
  assert.doesNotMatch(evidence, /private-behavior|private-command|broken-nonce/);
});

test("maintainer Markdown cannot be forged through signed version or limitation text", () => {
  const keys = signingKeys();
  const maliciousReceipt = receipt("CHANGED", "2.0.0 | **forged**\n# injected", "broken-tree", "broken-nonce");
  maliciousReceipt.limitations = ["bounded | </table>\n# forged section"];
  maliciousReceipt.receiptHash = recomputeUpgradeReceiptHash(maliciousReceipt);
  const entry = createPublicCompatibilityEntry(maliciousReceipt, keys.privateKeyPath);
  const rendered = renderMaintainerEvidence(entry);
  assert.doesNotMatch(rendered, /\| \*\*forged\*\*|\n# injected|<\/table>|\n# forged section/);
  assert.match(rendered, /&#124; \*\*forged\*\*\\u\{000A\}# injected/);
});

test("fleet policy allows only fresh SAFE evidence under exact organization-owned commitments", () => {
  const { broken, fixed } = entries();
  const policy = fleetPolicy(fixed);
  const allowed = enforceFleetPolicy({ policy, entry: fixed, deploymentIntent: fleetIntent(fixed), evaluatedAt: "2026-08-23T12:00:00.000Z" });
  assert.equal(allowed.status, "ALLOW");
  assert.match(allowed.reasons[0], /satisfies every fleet policy constraint/);

  const changed = enforceFleetPolicy({ policy, entry: broken, deploymentIntent: fleetIntent(broken), evaluatedAt: "2026-08-23T12:00:00.000Z" });
  assert.equal(changed.status, "BLOCK");
  assert.ok(changed.reasons.some((reason) => /requires SAFE/.test(reason)));

  const stale = enforceFleetPolicy({ policy, entry: fixed, deploymentIntent: fleetIntent(fixed), evaluatedAt: "2026-09-23T12:00:00.000Z" });
  assert.equal(stale.status, "BLOCK");
  assert.ok(stale.reasons.some((reason) => /older/.test(reason)));

  const blockedCases: Array<[keyof FleetPolicy, unknown, RegExp]> = [
    ["allowedPublisherKeyIds", [sha("wrong-publisher")], /publisher key/],
    ["allowedComponents", [{ ecosystem: "agent-plugin", name: "other-agent" }], /component is not allowed/],
    ["allowedRunnerImages", [sha("wrong-image")], /runner image/],
    ["allowedConfigSha256", [sha("wrong-config")], /configuration/],
    ["allowedCanaryHarnessSha256", [sha("wrong-harness")], /canary harness/],
    ["minimumCanaries", 2, /fewer canaries/],
  ];
  for (const [field, replacement, expected] of blockedCases) {
    const changedPolicy = structuredClone(policy) as Record<string, unknown>;
    changedPolicy[field] = replacement;
    const decision = enforceFleetPolicy({ policy: validateFleetPolicy(changedPolicy), entry: fixed, deploymentIntent: fleetIntent(fixed), evaluatedAt: "2026-08-23T12:00:00.000Z" });
    assert.equal(decision.status, "BLOCK");
    assert.ok(decision.reasons.some((reason) => expected.test(reason)));
  }
  const future = enforceFleetPolicy({ policy, entry: fixed, deploymentIntent: fleetIntent(fixed), evaluatedAt: "2026-08-23T10:30:00.000Z" });
  assert.ok(future.reasons.some((reason) => /future/.test(reason)));
  assert.throws(() => enforceFleetPolicy({ policy, entry: fixed, deploymentIntent: fleetIntent(fixed), evaluatedAt: "not-a-time" }), /exact UTC/);
  assert.throws(
    () => validateFleetPolicy({ ...policy, allowedPublisherKeyIds: [policy.allowedPublisherKeyIds[0], policy.allowedPublisherKeyIds[0]] }),
    /duplicates/,
  );
});

test("CLI produces maintainer evidence, a signed restoration, searchable HTML, JSON API, and badge files", () => {
  const directory = temp();
  execFileSync("git", ["init", "-q"], { cwd: directory });
  const { broken, fixed, privateKeyPath, publicKeyPath } = entries();
  const brokenPath = join(directory, "broken.json");
  const fixedPath = join(directory, "fixed.json");
  const evidencePath = join(directory, "issue.md");
  const resolutionPath = join(directory, "resolution.json");
  const pagePath = join(directory, "index.html");
  const htmlOnlyPath = join(directory, "legacy-index.html");
  const apiPath = join(directory, "registry.json");
  const policyPath = join(directory, "fleet-policy.json");
  const decisionPath = join(directory, "fleet-decision.json");
  const badges = join(directory, "badges");
  mkdirSync(badges);
  writeJson(brokenPath, broken);
  writeJson(fixedPath, fixed);
  writeJson(policyPath, fleetPolicy(fixed));
  assert.equal(runUpgradeCommand(["evidence", brokenPath, "--output", evidencePath, "--public-key", publicKeyPath]), 0);
  assert.equal(runUpgradeCommand([
    "resolve", "--broken", brokenPath, "--fixed", fixedPath, "--output", resolutionPath,
    "--public-key", publicKeyPath, "--signing-key", privateKeyPath,
  ]), 0);
  assert.equal(runUpgradeCommand([
    "index", fixedPath, "--output", htmlOnlyPath, "--public-key", publicKeyPath,
  ]), 0);
  assert.equal(runUpgradeCommand(["verify", resolutionPath, "--public-key", publicKeyPath]), 0);
  assert.equal(runUpgradeCommand(["verify", resolutionPath, "--public-key", signingKeys().publicKeyPath]), 1);
  assert.equal(runUpgradeCommand([
    "enforce", fixedPath, "--policy", policyPath, "--public-key", publicKeyPath, "--output", decisionPath,
    "--expected-current-version", fixed.component.currentVersion,
    "--expected-candidate-version", fixed.component.candidateVersion,
    "--expected-current-artifact-sha256", fixed.component.currentArtifactSha256,
    "--expected-candidate-artifact-sha256", fixed.component.candidateArtifactSha256,
  ]), 0);
  assert.equal(runUpgradeCommand([
    "index", brokenPath, fixedPath, resolutionPath,
    "--output", pagePath, "--api-output", apiPath,
    "--badge-directory", badges, "--public-key", publicKeyPath,
  ]), 0);
  assert.match(readFileSync(evidencePath, "utf8"), /Agent update evidence/);
  assert.match(readFileSync(pagePath, "utf8"), /Search proofs/);
  assert.match(readFileSync(htmlOnlyPath, "utf8"), /Search proofs/);
  const api = JSON.parse(readFileSync(apiPath, "utf8")) as { entries: unknown[]; resolutions: unknown[] };
  assert.equal(api.entries.length, 2);
  assert.equal(api.resolutions.length, 1);
  assert.equal(JSON.parse(readFileSync(decisionPath, "utf8")).status, "ALLOW");
  assert.equal(JSON.parse(readFileSync(join(badges, `${broken.entryHash.slice(7)}.json`), "utf8")).message, "changed");
});
