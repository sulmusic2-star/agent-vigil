import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadUpgradeConfig,
  UPGRADE_CONFIG_SCHEMA,
} from "../src/upgrade/contracts.ts";
import { runUpgradeCommand } from "../src/upgrade/cli.ts";
import { runUpgradeEvaluation } from "../src/upgrade/receipt.ts";
import { renderUpgradeDoctor, type UpgradeDoctorResult } from "../src/upgrade/setup.ts";

const IMAGE = `example.invalid/upgrade-runner@sha256:${"a".repeat(64)}`;
const UNSAFE_TERMINAL = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;
const POSIX_FAKE_DOCKER = process.platform !== "win32";

function configDocument(canaryDirectory: string): Record<string, unknown> {
  return {
    schemaVersion: UPGRADE_CONFIG_SCHEMA,
    component: {
      ecosystem: "agent-plugin",
      name: "single-read-fixture",
      manifestPath: "package.json",
      identityField: "name",
      versionField: "version",
      capabilityFields: [],
    },
    runner: {
      engine: "docker",
      image: IMAGE,
      trials: 2,
      memoryMiB: 128,
      cpus: 0.25,
      pids: 16,
    },
    canaryDirectory,
    canaries: [{
      id: "stable-fixture",
      command: ["node", "/canaries/canary.mjs"],
      timeoutSeconds: 1,
    }],
  };
}

type EvaluationFixture = {
  repository: string;
  current: string;
  candidate: string;
  configPath: string;
  configDocument: Record<string, unknown>;
};

function evaluationFixture(): EvaluationFixture {
  const repository = mkdtempSync(join(tmpdir(), "vigil-config-checkpoint-"));
  const current = join(repository, "current");
  const candidate = join(repository, "candidate");
  const canaries = join(repository, "canaries");
  mkdirSync(current);
  mkdirSync(candidate);
  mkdirSync(canaries);
  writeFileSync(join(current, "package.json"), JSON.stringify({ name: "single-read-fixture", version: "1.0.0" }));
  writeFileSync(join(candidate, "package.json"), JSON.stringify({ name: "single-read-fixture", version: "1.1.0" }));
  writeFileSync(join(canaries, "canary.mjs"), "process.stdout.write('{}');\n");
  const configPath = join(repository, "config.json");
  const document = configDocument("canaries");
  writeFileSync(configPath, JSON.stringify(document));
  return { repository, current, candidate, configPath, configDocument: document };
}

function mutatingDocker(fixture: EvaluationFixture, mutation: "changed" | "malformed" | "missing" | "moved"): string {
  const docker = join(fixture.repository, `fake-docker-${mutation}.mjs`);
  const marker = join(fixture.repository, `.mutated-${mutation}`);
  const changed = structuredClone(fixture.configDocument) as any;
  changed.runner.pids = 17;
  const operations = {
    changed: `writeFileSync(configPath, ${JSON.stringify(JSON.stringify(changed))});`,
    malformed: `writeFileSync(configPath, "{malformed");`,
    missing: "unlinkSync(configPath);",
    moved: `renameSync(configPath, configPath + ".moved"); writeFileSync(configPath, ${JSON.stringify(JSON.stringify(fixture.configDocument))});`,
  };
  writeFileSync(docker, `#!/usr/bin/env node
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
const configPath = ${JSON.stringify(fixture.configPath)};
const marker = ${JSON.stringify(marker)};
if (!existsSync(marker)) {
  writeFileSync(marker, "mutated");
  ${operations[mutation]}
}
const args = process.argv.slice(2);
if (args[0] === "context" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify("unix:///var/run/docker.sock"));
} else if (args[0] === "image" && args[1] === "inspect") {
  process.stdout.write("[]");
}
`);
  chmodSync(docker, 0o755);
  return docker;
}

test("evaluation rejects a stale supplied configuration snapshot at entry", () => {
  const fixture = evaluationFixture();
  const loaded = loadUpgradeConfig(fixture.configPath);
  writeFileSync(fixture.configPath, "{not valid JSON");

  const receipt = runUpgradeEvaluation({
    configPath: fixture.configPath,
    config: loaded,
    repository: fixture.repository,
    currentDirectory: fixture.current,
    candidateDirectory: fixture.candidate,
    dockerBin: "/usr/bin/false",
  });
  assert.equal(receipt.component.name, "single-read-fixture");
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.match(receipt.summary.reasons.join(" "), /config could not be re-resolved and re-read at evaluation entry/i);
});

test("evaluation rejects a valid on-disk config that differs from the supplied snapshot", () => {
  const fixture = evaluationFixture();
  const loaded = loadUpgradeConfig(fixture.configPath);
  const changed = structuredClone(fixture.configDocument) as any;
  changed.runner.pids = 17;
  writeFileSync(fixture.configPath, JSON.stringify(changed));

  const receipt = runUpgradeEvaluation({
    configPath: fixture.configPath,
    config: loaded,
    repository: fixture.repository,
    currentDirectory: fixture.current,
    candidateDirectory: fixture.candidate,
    dockerBin: "/usr/bin/false",
  });
  assert.equal(receipt.summary.verdict, "HOLD");
  assert.match(receipt.summary.reasons.join(" "), /no longer matches the validated configuration supplied by the caller/i);
});

for (const mutation of ["changed", "malformed", "missing", "moved"] as const) {
  test(`evaluation becomes HOLD when its config is ${mutation} after entry validation`, {
    skip: POSIX_FAKE_DOCKER ? false : "the mutation harness uses POSIX shebang execution",
  }, () => {
    const fixture = evaluationFixture();
    const loaded = loadUpgradeConfig(fixture.configPath);
    const receipt = runUpgradeEvaluation({
      configPath: fixture.configPath,
      config: loaded,
      repository: fixture.repository,
      currentDirectory: fixture.current,
      candidateDirectory: fixture.candidate,
      dockerBin: mutatingDocker(fixture, mutation),
    });
    assert.equal(receipt.summary.verdict, "HOLD");
    if (mutation === "changed") assert.match(receipt.summary.reasons.join(" "), /config changed while the evaluation was running/i);
    else if (mutation === "moved") assert.match(receipt.summary.reasons.join(" "), /config moved or was replaced while the evaluation was running/i);
    else assert.match(receipt.summary.reasons.join(" "), /config could not be re-resolved and re-read after evaluation/i);
  });
}

function withoutFramingNewlines(value: string): string {
  return value.replaceAll("\n", "");
}

test("upgrade CLI errors escape terminal controls from untrusted arguments", () => {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  try {
    assert.equal(runUpgradeCommand(["unknown\u001b[2J\r\n\u202E\u200B\uFE0Fcommand"]), 2);
  } finally {
    console.error = original;
  }
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], UNSAFE_TERMINAL);
  assert.match(messages[0], /unknown\\u\{001B\}\[2J\\u\{000D\}\\u\{000A\}\\u\{202E\}\\u\{200B\}\\u\{FE0F\}command/);
});

test("doctor presentation escapes dynamic paths, labels, details, and invisible text", () => {
  const hostile = "value\u001b[2J\r\n\u202E\u200B\uFE0Fend";
  const result: UpgradeDoctorResult = {
    status: "HOLD",
    configPath: hostile,
    imagePresent: false,
    templateCanary: false,
    containment: {
      status: "HOLD",
      localEndpoint: false,
      imagePresent: false,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: hostile,
    },
    checks: [{ status: "HOLD", label: hostile, detail: hostile }],
  };
  const output = renderUpgradeDoctor(result);
  assert.doesNotMatch(withoutFramingNewlines(output), UNSAFE_TERMINAL);
  assert.match(output, /value\\u\{001B\}\[2J\\u\{000D\}\\u\{000A\}\\u\{202E\}\\u\{200B\}\\u\{FE0F\}end/);
});

test("init success output escapes a repository path containing terminal controls", {
  skip: process.platform === "win32" ? "Windows rejects control characters in path components" : false,
}, () => {
  const parent = mkdtempSync(join(tmpdir(), "vigil-terminal-init-"));
  const repository = join(parent, "repo\u001b[2J\r\u202E\u200B");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  const messages: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  try {
    assert.equal(runUpgradeCommand(["init", "--repo", repository]), 0);
  } finally {
    console.log = original;
  }
  const output = messages.join("\n");
  assert.doesNotMatch(withoutFramingNewlines(output), UNSAFE_TERMINAL);
  assert.match(output, /repo\\u\{001B\}\[2J\\u\{000D\}\\u\{202E\}\\u\{200B\}/);
});

test("index argument errors cannot inject terminal controls", () => {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  try {
    assert.equal(runUpgradeCommand([
      "index",
      "entry.json",
      "--output", "bad\u001b[2J\r\n\u202E\u200B.html",
      "--public-key", "publisher.pem",
    ]), 2);
  } finally {
    console.error = original;
  }
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], UNSAFE_TERMINAL);
  assert.match(messages[0], /bad\\u\{001B\}\[2J\\u\{000D\}\\u\{000A\}\\u\{202E\}\\u\{200B\}\.html/);
});
