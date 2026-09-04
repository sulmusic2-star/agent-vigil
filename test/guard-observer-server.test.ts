import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import test from "node:test";
import { canaryBody, openGuardControlChallenge, openGuardControlObservation } from "../src/guard-control-protocol.ts";
import { guardDigest } from "../src/guard-compat.ts";
import { runGuardObserverCommand } from "../src/guard-observer-server.ts";

test("observer help keeps the multi-line command readable", async () => {
  const original = console.log;
  const lines: string[] = [];
  try {
    console.log = ((value?: unknown) => { lines.push(String(value ?? "")); }) as typeof console.log;
    assert.equal(await runGuardObserverCommand(["--help"]), 0);
    const output = lines.join("\n");
    assert.match(output, /vigil guard-observer \\\n    --host/);
    assert.match(output, /--runner-node <absolute-worker-node-path>/);
  } finally { console.log = original; }
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runObserver(route: "allow" | "deny") {
  const directory = mkdtempSync(join(tmpdir(), "vigil-observer-integration-"));
  const challengeKeys = generateKeyPairSync("ed25519");
  const observerKeys = generateKeyPairSync("ed25519");
  const challengeKey = join(directory, "challenge.pem");
  const observerKey = join(directory, "observer.pem");
  const challengeOutput = join(directory, "challenge.json");
  const observationOutput = join(directory, "observation.json");
  const readyOutput = join(directory, "ready.json");
  writeFileSync(challengeKey, challengeKeys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(observerKey, observerKeys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const logs = { log: console.log, error: console.error };
  console.log = (() => undefined) as typeof console.log;
  console.error = (() => undefined) as typeof console.error;
  try {
    const running = runGuardObserverCommand([
      "--host", "claude", "--host-version", "2.1.246",
      "--host-executable-sha256", guardDigest("candidate"),
      "--managed-environment-sha256", guardDigest("environment"),
      "--runner-node", process.execPath,
      "--challenge-key", challengeKey, "--observer-key", observerKey,
      "--challenge-output", challengeOutput, "--observation-output", observationOutput,
      "--ready-output", readyOutput, "--duration-ms", "300",
    ]);
    await waitForFile(readyOutput);
    const challengeEnvelope = JSON.parse(readFileSync(challengeOutput, "utf8"));
    const { challenge } = openGuardControlChallenge(challengeEnvelope, challengeKeys.publicKey);
    const path = route === "allow" ? challenge.observer.allowPath : challenge.observer.denyPath;
    const response = await fetch(`${challenge.observer.origin}${path}`, { method: "POST", body: canaryBody() });
    assert.equal(response.status, 204);
    const code = await running;
    const observationEnvelope = JSON.parse(readFileSync(observationOutput, "utf8"));
    const { observation } = openGuardControlObservation(observationEnvelope, observerKeys.publicKey);
    return { directory, code, challenge, observation };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    console.log = logs.log;
    console.error = logs.error;
  }
}

test("off-host observer signs PASS only after the exact allow effect", async () => {
  const result = await runObserver("allow");
  try {
    assert.equal(result.code, 0);
    assert.equal(result.observation.status, "PASS");
    assert.deepEqual(result.observation.summary, { allowRequests: 1, denyRequests: 0, unexpectedRequests: 0 });
    assert.equal(result.observation.challengeHash, result.challenge.challengeHash);
    assert.ok(Date.parse(result.observation.closedAt) <= Date.parse(result.challenge.expiresAt));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
});

test("off-host observer records a deny canary effect and fails closed", async () => {
  const result = await runObserver("deny");
  try {
    assert.equal(result.code, 1);
    assert.equal(result.observation.status, "FAIL");
    assert.equal(result.observation.summary.denyRequests, 1);
    assert.ok(result.observation.reasonCodes.includes("DENY_EFFECT_OBSERVED"));
  } finally { rmSync(result.directory, { recursive: true, force: true }); }
});

test("a slow request is destroyed at the signed observation deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-observer-slow-request-"));
  const challengeKeys = generateKeyPairSync("ed25519");
  const observerKeys = generateKeyPairSync("ed25519");
  const challengeKey = join(directory, "challenge.pem");
  const observerKey = join(directory, "observer.pem");
  const challengeOutput = join(directory, "challenge.json");
  const observationOutput = join(directory, "observation.json");
  const readyOutput = join(directory, "ready.json");
  writeFileSync(challengeKey, challengeKeys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(observerKey, observerKeys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const logs = { log: console.log, error: console.error };
  console.log = (() => undefined) as typeof console.log;
  console.error = (() => undefined) as typeof console.error;
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    const started = Date.now();
    const running = runGuardObserverCommand([
      "--host", "claude", "--host-version", "2.1.246",
      "--host-executable-sha256", guardDigest("candidate"),
      "--managed-environment-sha256", guardDigest("environment"),
      "--runner-node", process.execPath,
      "--challenge-key", challengeKey, "--observer-key", observerKey,
      "--challenge-output", challengeOutput, "--observation-output", observationOutput,
      "--ready-output", readyOutput, "--duration-ms", "100",
    ]);
    await waitForFile(readyOutput);
    const { challenge } = openGuardControlChallenge(JSON.parse(readFileSync(challengeOutput, "utf8")), challengeKeys.publicKey);
    const origin = new URL(challenge.observer.origin);
    socket = createConnection({ host: origin.hostname, port: Number(origin.port) });
    await new Promise<void>((resolveConnected, reject) => {
      socket!.once("connect", resolveConnected);
      socket!.once("error", reject);
    });
    socket.write(`POST ${challenge.observer.allowPath} HTTP/1.1\r\nHost: ${origin.host}\r\nContent-Length: 10\r\nConnection: keep-alive\r\n\r\nx`);
    const code = await running;
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 3_000, "observer must not wait for an untrusted body after the deadline");
    const { observation } = openGuardControlObservation(JSON.parse(readFileSync(observationOutput, "utf8")), observerKeys.publicKey);
    assert.ok(Date.parse(observation.closedAt) <= Date.parse(challenge.expiresAt));
  } finally {
    socket?.destroy();
    console.log = logs.log;
    console.error = logs.error;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("observer refuses to overwrite a signing key or collide its outputs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-observer-collision-"));
  const challengeKeys = generateKeyPairSync("ed25519");
  const observerKeys = generateKeyPairSync("ed25519");
  const challengeKey = join(directory, "challenge.pem");
  const observerKey = join(directory, "observer.pem");
  const observationOutput = join(directory, "observation.json");
  const original = observerKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(challengeKey, challengeKeys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(observerKey, original, { mode: 0o600 });
  const oldError = console.error;
  console.error = (() => undefined) as typeof console.error;
  try {
    const code = await runGuardObserverCommand([
      "--host", "claude", "--host-version", "2.1.246",
      "--host-executable-sha256", guardDigest("candidate"),
      "--managed-environment-sha256", guardDigest("environment"), "--runner-node", process.execPath,
      "--challenge-key", challengeKey, "--observer-key", observerKey,
      "--challenge-output", observerKey, "--observation-output", observationOutput,
    ]);
    assert.equal(code, 2);
    assert.equal(readFileSync(observerKey, "utf8"), original);
  } finally { console.error = oldError; rmSync(directory, { recursive: true, force: true }); }
});
