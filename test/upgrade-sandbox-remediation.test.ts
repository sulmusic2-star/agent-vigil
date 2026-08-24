import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  UPGRADE_CONFIG_SCHEMA,
  validateUpgradeConfig,
  type UpgradeCanaryConfig,
  type UpgradeConfig,
} from "../src/upgrade/contracts.ts";
import {
  inspectDockerDaemon,
  isLocalDockerEndpoint,
  probeContainment,
  resolveDockerClient,
  resolveDockerBinary,
  runCanaryTrial,
} from "../src/upgrade/sandbox.ts";

const IMAGE = `example.invalid/upgrade-runner@sha256:${"a".repeat(64)}`;
const POSIX_FAKE_DOCKER = process.platform !== "win32";
const POSIX_FAKE_DOCKER_REASON = "the fake Docker executable harness uses POSIX shebang execution";

function config(image = IMAGE): UpgradeConfig {
  return validateUpgradeConfig({
    schemaVersion: UPGRADE_CONFIG_SCHEMA,
    component: {
      ecosystem: "agent-plugin",
      name: "sandbox-fixture",
      manifestPath: "package.json",
      identityField: "name",
      versionField: "version",
      capabilityFields: [],
    },
    runner: {
      engine: "docker",
      image,
      trials: 2,
      memoryMiB: 128,
      cpus: 0.25,
      pids: 16,
    },
    canaryDirectory: "canaries",
    canaries: [{
      id: "sandbox",
      command: ["node", "canary.cjs"],
      timeoutSeconds: 1,
    }],
  });
}

function fixture(): { root: string; target: string; canaries: string } {
  const root = mkdtempSync(join(tmpdir(), "vigil-sandbox-remediation-"));
  const target = join(root, "target");
  const canaries = join(root, "canaries");
  mkdirSync(target);
  mkdirSync(canaries);
  return { root, target, canaries };
}

type FakeDockerCall = {
  rawArgs: string[];
  commandArgs: string[];
  dockerEnv: Record<string, string>;
};

function fakeDocker(root: string): { executable: string; log: string } {
  const executable = join(root, "fake-docker.mjs");
  const log = join(root, "docker-argv.jsonl");
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--host" ? rawArgs.slice(2) : rawArgs;
const dockerEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("DOCKER_")));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({rawArgs,commandArgs:args,dockerEnv}) + "\\n");
if (args[0] === "context" && args[1] === "inspect") {
  if (process.env.VIGIL_FAKE_DOCKER_CONTEXT_ERROR === "1") process.exitCode = 70;
  else if (process.env.VIGIL_FAKE_DOCKER_CONTEXT_MALFORMED === "1") process.stdout.write("not-json");
  else process.stdout.write(JSON.stringify(process.env.VIGIL_FAKE_DOCKER_ENDPOINT || "unix:///var/run/docker.sock"));
} else if (args[0] === "image" && args[1] === "inspect") {
  const selected = args.at(-1);
  const digest = selected.slice(selected.lastIndexOf("@") + 1);
  process.stdout.write(JSON.stringify({
    Descriptor:{mediaType:process.env.VIGIL_FAKE_DOCKER_MEDIA_TYPE||"application/vnd.oci.image.manifest.v1+json",digest},
    Os:process.env.VIGIL_FAKE_DOCKER_OS||"linux",
    Architecture:process.env.VIGIL_FAKE_DOCKER_ARCH||"amd64",
    Variant:process.env.VIGIL_FAKE_DOCKER_VARIANT||"",
    RepoDigests:[selected]
  }));
} else if (args[0] === "run") {
  if (process.env.VIGIL_FAKE_DOCKER_HANG === "1") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else if (args.includes("-e")) {
    process.stdout.write(JSON.stringify({networkBlocked:true,targetReadOnly:true,rootReadOnly:true,inheritedSecretAbsent:true,proxiesCleared:true}));
  } else {
    process.stdout.write(JSON.stringify({schemaVersion:"agent-vigil-upgrade-canary/v1",outcome:"PASS",observations:{stable:true}}));
  }
} else if (args[0] === "container" && args[1] === "rm") {
  if (process.env.VIGIL_FAKE_DOCKER_RM_ERROR === "1") process.exitCode = 71;
} else if (args[0] === "container" && args[1] === "ls") {
  if (process.env.VIGIL_FAKE_DOCKER_LS_ERROR === "1") process.exitCode = 72;
  else process.stdout.write("");
}
`);
  chmodSync(executable, 0o755);
  return { executable, log };
}

function fakeDockerCalls(log: string): FakeDockerCall[] {
  return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FakeDockerCall);
}

function withoutDockerOverrides<T>(callback: () => T): T {
  const host = process.env.DOCKER_HOST;
  const context = process.env.DOCKER_CONTEXT;
  delete process.env.DOCKER_HOST;
  delete process.env.DOCKER_CONTEXT;
  try {
    return callback();
  } finally {
    if (host === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = host;
    if (context === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = context;
  }
}

test("Docker daemon endpoint parsing accepts only local transports", () => {
  for (const endpoint of [
    "unix:///var/run/docker.sock",
    "unix:///Users/example/.docker/run/docker.sock",
  ]) assert.equal(isLocalDockerEndpoint(endpoint), true, endpoint);
  assert.equal(isLocalDockerEndpoint("npipe:////./pipe/docker_engine", "win32"), true);

  for (const endpoint of [
    "ssh://builder.example",
    "tcp://127.0.0.1:2375",
    "http://localhost:2375",
    "https://localhost:2376",
    "npipe:////./pipe/docker_engine",
    "unix://builder.example/var/run/docker.sock",
    "unix:///",
    "unix:///var/run/docker.sock?remote=1",
    "not-an-endpoint",
    "unix:///var/run/docker.sock\nssh://builder.example",
  ]) assert.equal(isLocalDockerEndpoint(endpoint, "linux"), false, endpoint);
});

test("daemon inspection rejects a remote context endpoint", { skip: POSIX_FAKE_DOCKER ? false : POSIX_FAKE_DOCKER_REASON }, () => {
  const { root } = fixture();
  const fake = fakeDocker(root);
  const previous = process.env.VIGIL_FAKE_DOCKER_ENDPOINT;
  process.env.VIGIL_FAKE_DOCKER_ENDPOINT = "ssh://builder.example";
  try {
    const result = withoutDockerOverrides(() => inspectDockerDaemon(fake.executable));
    assert.equal(result.local, false);
    assert.match(result.reason, /not a local/);
  } finally {
    if (previous === undefined) delete process.env.VIGIL_FAKE_DOCKER_ENDPOINT;
    else process.env.VIGIL_FAKE_DOCKER_ENDPOINT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("context inspection errors and malformed output force containment HOLD", { skip: POSIX_FAKE_DOCKER ? false : POSIX_FAKE_DOCKER_REASON }, () => {
  for (const failure of ["VIGIL_FAKE_DOCKER_CONTEXT_ERROR", "VIGIL_FAKE_DOCKER_CONTEXT_MALFORMED"] as const) {
    const { root, target, canaries } = fixture();
    const fake = fakeDocker(root);
    const previous = process.env[failure];
    process.env[failure] = "1";
    try {
      const result = withoutDockerOverrides(() => probeContainment(
        config(), target, canaries, fake.executable,
      ));
      assert.equal(result.status, "HOLD", failure);
      assert.match(result.reason, /endpoint.*(?:inspected|malformed)/);
    } finally {
      if (previous === undefined) delete process.env[failure];
      else process.env[failure] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a bare repository PATH executable is not accepted as the Docker client", () => {
  const { root } = fixture();
  const executable = join(root, "repository-docker");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous ?? ""}`;
  try {
    assert.throws(
      () => resolveDockerBinary("repository-docker"),
      /explicit absolute path/,
    );
    assert.equal(resolveDockerBinary(executable), realpathSync(executable));
  } finally {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("containment uses a random named container and verifies exact cleanup", { skip: POSIX_FAKE_DOCKER ? false : POSIX_FAKE_DOCKER_REASON }, () => {
  const { root, target, canaries } = fixture();
  const fake = fakeDocker(root);
  try {
    const result = withoutDockerOverrides(() => probeContainment(config(), target, canaries, fake.executable));
    assert.equal(result.status, "PASS", result.reason);
    const calls = fakeDockerCalls(fake.log);
    const runCall = calls.find((call) => call.commandArgs[0] === "run");
    const run = runCall?.commandArgs;
    assert.ok(run);
    const nameIndex = run.indexOf("--name");
    assert.ok(nameIndex > 0);
    const name = run[nameIndex + 1];
    assert.match(name, /^agent-vigil-upgrade-[0-9a-f]{24}$/);
    assert.ok(calls.some((call) => call.commandArgs.join("\0")
      === ["container", "rm", "--force", "--volumes", name].join("\0")));
    assert.ok(calls.some((call) => call.commandArgs.includes(`name=^/${name}$`)));
    for (const call of calls.filter((value) => value.commandArgs[0] !== "context")) {
      assert.deepEqual(call.rawArgs.slice(0, 2), ["--host", "unix:///var/run/docker.sock"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a multi-platform index or non-linux-amd64 image cannot satisfy the exact runner identity", {
  skip: POSIX_FAKE_DOCKER ? false : POSIX_FAKE_DOCKER_REASON,
}, () => {
  const { root, target, canaries } = fixture();
  const fake = fakeDocker(root);
  const cases = [
    ["VIGIL_FAKE_DOCKER_MEDIA_TYPE", "application/vnd.oci.image.index.v1+json"],
    ["VIGIL_FAKE_DOCKER_ARCH", "arm64"],
    ["VIGIL_FAKE_DOCKER_OS", "windows"],
    ["VIGIL_FAKE_DOCKER_VARIANT", "v8"],
  ] as const;
  try {
    for (const [name, value] of cases) {
      process.env[name] = value;
      const result = withoutDockerOverrides(() => probeContainment(config(), target, canaries, fake.executable));
      assert.equal(result.status, "HOLD", name);
      assert.equal(result.imagePresent, false, name);
      delete process.env[name];
    }
  } finally {
    for (const [name] of cases) delete process.env[name];
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SIGTERM-ignoring Docker client is killed on deadline and its exact container is cleaned", { skip: POSIX_FAKE_DOCKER ? false : POSIX_FAKE_DOCKER_REASON }, () => {
  const { root, target, canaries } = fixture();
  const fake = fakeDocker(root);
  const canary: UpgradeCanaryConfig = {
    id: "timeout",
    command: ["node", "canary.cjs"],
    timeoutSeconds: 1,
  };
  const previous = process.env.VIGIL_FAKE_DOCKER_HANG;
  process.env.VIGIL_FAKE_DOCKER_HANG = "1";
  try {
    const started = performance.now();
    const result = withoutDockerOverrides(() => runCanaryTrial(
      config(), canary, target, canaries, fake.executable,
    ));
    const elapsed = performance.now() - started;
    assert.equal(result.state, "HOLD");
    assert.match(result.reason, /timed out/);
    assert.ok(elapsed < 5_000, `deadline and cleanup took ${elapsed.toFixed(0)}ms`);

    const calls = fakeDockerCalls(fake.log);
    const run = calls.find((call) => call.commandArgs[0] === "run")?.commandArgs;
    assert.ok(run);
    const name = run[run.indexOf("--name") + 1];
    assert.ok(calls.some((call) => call.commandArgs.join("\0")
      === ["container", "rm", "--force", "--volumes", name].join("\0")));
    assert.ok(calls.some((call) => call.commandArgs.includes(`name=^/${name}$`)));
  } finally {
    if (previous === undefined) delete process.env.VIGIL_FAKE_DOCKER_HANG;
    else process.env.VIGIL_FAKE_DOCKER_HANG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("one resolved client pins every Docker call despite hostile endpoint and TLS environment changes", { skip: POSIX_FAKE_DOCKER ? false : POSIX_FAKE_DOCKER_REASON }, () => {
  const { root, target, canaries } = fixture();
  const fake = fakeDocker(root);
  const controlledNames = [
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "Docker_Host",
  ] as const;
  const previous = Object.fromEntries(controlledNames.map((name) => [name, process.env[name]]));
  const endpoint = "unix:///private/tmp/vigil-pinned-docker.sock";
  process.env.VIGIL_FAKE_DOCKER_ENDPOINT = endpoint;
  process.env.DOCKER_CONTEXT = "attacker-selected-context";
  process.env.DOCKER_HOST = "ssh://ignored-because-context-wins.example";
  process.env.DOCKER_TLS = "1";
  process.env.DOCKER_TLS_VERIFY = "1";
  process.env.DOCKER_CERT_PATH = join(root, "attacker-certificates");
  process.env.DOCKER_CONFIG = join(root, "attacker-config");
  process.env.Docker_Host = "tcp://case-variant-must-be-stripped.example:2375";
  try {
    const client = resolveDockerClient(fake.executable);
    assert.equal(client.endpoint, endpoint);
    for (const name of controlledNames) assert.equal(client.env[name], undefined, name);

    process.env.DOCKER_CONTEXT = "second-context";
    process.env.DOCKER_HOST = "tcp://127.0.0.1:2375";
    process.env.DOCKER_TLS_VERIFY = "attack-after-resolution";

    const containment = probeContainment(config(), target, canaries, client);
    assert.equal(containment.status, "PASS", containment.reason);
    assert.equal(containment.localEndpoint, true);
    const trial = runCanaryTrial(
      config(),
      { id: "pinned", command: ["node", "canary.cjs"], timeoutSeconds: 1 },
      target,
      canaries,
      client,
    );
    assert.equal(trial.state, "PASS", trial.reason);

    const calls = fakeDockerCalls(fake.log);
    assert.equal(calls.filter((call) => call.commandArgs[0] === "context").length, 1);
    const controlled = calls.filter((call) => ["image", "run", "container"].includes(call.commandArgs[0]));
    assert.ok(controlled.length >= 7);
    assert.equal(calls.some((call) => call.commandArgs.some((arg) => arg.includes("VIGIL_PHASE"))), false);
    for (const call of controlled) {
      assert.deepEqual(call.rawArgs.slice(0, 2), ["--host", endpoint]);
      for (const name of controlledNames) assert.equal(call.dockerEnv[name], undefined, `${name}: ${call.commandArgs.join(" ")}`);
    }
  } finally {
    delete process.env.VIGIL_FAKE_DOCKER_ENDPOINT;
    for (const name of controlledNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup and absence-list command errors force HOLD", { skip: POSIX_FAKE_DOCKER ? false : POSIX_FAKE_DOCKER_REASON }, () => {
  for (const failure of ["VIGIL_FAKE_DOCKER_RM_ERROR", "VIGIL_FAKE_DOCKER_LS_ERROR"] as const) {
    const { root, target, canaries } = fixture();
    const fake = fakeDocker(root);
    const previous = process.env[failure];
    process.env[failure] = "1";
    try {
      const result = withoutDockerOverrides(() => runCanaryTrial(
        config(),
        { id: "cleanup", command: ["node", "canary.cjs"], timeoutSeconds: 1 },
        target,
        canaries,
        fake.executable,
      ));
      assert.equal(result.state, "HOLD", failure);
      assert.match(result.reason, failure.endsWith("RM_ERROR") ? /force-removed/ : /absence check failed/);
    } finally {
      if (previous === undefined) delete process.env[failure];
      else process.env[failure] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const REAL_DOCKER_ENABLED = process.env.VIGIL_UPGRADE_DOCKER_TESTS === "1"
  && typeof process.env.VIGIL_UPGRADE_DOCKER_IMAGE === "string";

test("real Docker timeout removes a candidate that ignores SIGTERM", { skip: !REAL_DOCKER_ENABLED }, () => {
  const root = mkdtempSync(join(process.cwd(), ".vigil-upgrade-timeout-"));
  const target = join(root, "target");
  const canaries = join(root, "canaries");
  mkdirSync(target);
  mkdirSync(canaries);
  const canary: UpgradeCanaryConfig = {
    id: "ignore-sigterm",
    command: ["node", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    timeoutSeconds: 1,
  };
  const endpointEnvironment = [
    "DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY",
  ] as const;
  const previous = Object.fromEntries(endpointEnvironment.map((name) => [name, process.env[name]]));
  try {
    const client = withoutDockerOverrides(() => resolveDockerClient(
      process.env.VIGIL_UPGRADE_DOCKER_BIN ?? "docker",
    ));
    process.env.DOCKER_CONTEXT = "must-not-redirect-resolved-client";
    process.env.DOCKER_HOST = "ssh://must-not-redirect.example";
    process.env.DOCKER_TLS = "1";
    process.env.DOCKER_TLS_VERIFY = "1";
    process.env.DOCKER_CERT_PATH = join(root, "must-not-be-read");
    process.env.DOCKER_CONFIG = join(root, "must-not-be-read");
    const started = performance.now();
    const result = runCanaryTrial(
      config(process.env.VIGIL_UPGRADE_DOCKER_IMAGE!),
      canary,
      target,
      canaries,
      client,
    );
    const elapsed = performance.now() - started;
    assert.equal(result.state, "HOLD");
    assert.match(result.reason, /timed out/);
    assert.ok(elapsed < 6_000, `real Docker deadline and cleanup took ${elapsed.toFixed(0)}ms`);
  } finally {
    for (const name of endpointEnvironment) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
