import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runContinuityCommand } from "../src/continuity/cli.ts";
import { sha256, type ContinuityRoot } from "../src/continuity/contracts.ts";
import { renderGuardContinuityDemo, runGuardContinuityDemo } from "../src/continuity/guard-demo.ts";
import { guardRouteBindingHash, guardRouteContinuityEvent, validateGuardRouteReport } from "../src/continuity/guard.ts";
import { recomputeGuardRouteReceiptHash, type GuardRouteReport } from "../src/guard-route.ts";

function route(host: "claude" | "codex"): GuardRouteReport {
  const report: GuardRouteReport = {
    schemaVersion: "agent-vigil-live-host-route/v1",
    vigilVersion: "0.20.0-test",
    generatedAt: host === "claude" ? "2026-08-25T18:00:00.000Z" : "2026-08-25T18:00:01.000Z",
    nonce: host === "claude" ? "claude_route_fixture_000000001" : "codex_route_fixture_0000000001",
    scope: "LIVE_HOST_ROUTING",
    status: "PASS",
    deployment: { state: "HOLD", reasonCodes: ["OTHER_HOST_ROUTE_NOT_PROVEN", "NON_DEPLOYING_DRILL"] },
    nextGate: { state: "ONE_HOST_PROVEN", requirement: "BOTH_CURRENT_HOSTS_MUST_PASS" },
    challengePack: { id: "agent-vigil-harmless-live-host-route/v1", sha256: sha256("challenge-pack") },
    host: {
      kind: host,
      version: host === "claude" ? "2.1.245" : "0.149.1",
      executableSha256: sha256(`${host}-executable`),
      invocationSha256: sha256(`${host}-invocation`),
      process: { process: "EXITED", exit: "ZERO", output: "JSON" },
    },
    control: {
      name: "Agent Vigil temporary route control",
      version: "1",
      launcherSha256: sha256("launcher"),
      artifactSha256: sha256(`${host}-artifact`),
      policySha256: sha256(`${host}-policy`),
      configurationSha256: sha256(`${host}-configuration`),
    },
    processConformance: { status: "PASS", receiptHash: sha256(`${host}-process-receipt`) },
    bindings: {
      profileMarkerSha256: sha256("profile-marker"),
      operatingSystem: {
        platform: "darwin",
        type: "Darwin",
        release: "25.6.0",
        architecture: "arm64",
        machineIdentitySha256: sha256("machine"),
      },
    },
    challenges: [
      {
        id: "allow-route",
        expectedDecision: "ALLOW",
        actualDecision: "ALLOW",
        expectedExecution: true,
        observedExecution: true,
        commandSha256: sha256(`${host}-allow-command`),
        toolUseIdSha256: sha256(`${host}-allow-call`),
        sessionIdSha256: sha256(`${host}-session`),
        passed: true,
      },
      {
        id: "deny-route",
        expectedDecision: "DENY",
        actualDecision: "DENY",
        expectedExecution: false,
        observedExecution: false,
        commandSha256: sha256(`${host}-deny-command`),
        toolUseIdSha256: sha256(`${host}-deny-call`),
        sessionIdSha256: sha256(`${host}-session`),
        passed: true,
      },
    ],
    summary: { passed: 2, total: 2, routedCalls: 2, unexpectedCalls: 0 },
    cleanup: {
      temporaryConfigurationRemoved: true,
      ordinaryConfigurationUnchanged: true,
      disposableProfileRemoval: "OPERATOR_REQUIRED",
    },
    reproduction: `vigil guard-route --host ${host} --host-version <same> --host-executable <same> --profile-home <fresh-disposable-profile>`,
    limitations: ["Reduced deterministic fixture receipt."],
    receiptHash: sha256("placeholder"),
  };
  report.receiptHash = recomputeGuardRouteReceiptHash(report);
  return report;
}

function root(): ContinuityRoot {
  return {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: sha256("receipt-file"),
    receiptHash: sha256("receipt"),
    rootHash: sha256("root"),
    subject: {
      episodeReceiptHash: sha256("episode"),
      repositoryHash: sha256("repository"),
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    },
    historicalVerification: "PASS",
    createdAt: "2026-08-25T17:59:59.000Z",
  };
}

function failed(value: GuardRouteReport): GuardRouteReport {
  const report = structuredClone(value);
  report.status = "FAIL";
  report.deployment.reasonCodes = ["LIVE_HOST_ROUTE_NOT_PROVEN"];
  report.nextGate.state = "BLOCKED";
  report.challenges[1].observedExecution = true;
  report.challenges[1].passed = false;
  report.summary.passed = 1;
  report.receiptHash = recomputeGuardRouteReceiptHash(report);
  return report;
}

function inconclusive(value: GuardRouteReport): GuardRouteReport {
  const report = structuredClone(value);
  report.status = "INCONCLUSIVE";
  report.deployment.reasonCodes = ["LIVE_HOST_ROUTE_NOT_PROVEN", "PROCESS_CONFORMANCE_NOT_PROVEN", "HOST_UNAVAILABLE_BEFORE_ROUTE"];
  report.nextGate.state = "BLOCKED";
  report.host.process = { process: "EXITED", exit: "NONZERO", output: "TEXT" };
  report.processConformance.status = "INCONCLUSIVE";
  report.challenges = report.challenges.map((item) => ({
    id: item.id,
    expectedDecision: item.expectedDecision,
    actualDecision: "UNKNOWN",
    expectedExecution: item.expectedExecution,
    observedExecution: false,
    commandSha256: item.commandSha256,
    passed: false,
  }));
  report.summary = { passed: 0, total: 2, routedCalls: 0, unexpectedCalls: 0 };
  report.receiptHash = recomputeGuardRouteReceiptHash(report);
  return report;
}

test("strict guard-route validation rejects self-consistent tampering and impossible PASS evidence", () => {
  const report = route("claude");
  assert.equal(validateGuardRouteReport(report).receiptHash, report.receiptHash);
  const tampered = structuredClone(report);
  tampered.host.version = "tampered";
  assert.throws(() => validateGuardRouteReport(tampered), /receipt hash is invalid/);
  const impossible = structuredClone(report);
  impossible.challenges[1].toolUseIdSha256 = impossible.challenges[0].toolUseIdSha256;
  impossible.receiptHash = recomputeGuardRouteReceiptHash(impossible);
  assert.throws(() => validateGuardRouteReport(impossible), /distinct calls/);
  const wrongReasons = structuredClone(report);
  wrongReasons.deployment.reasonCodes = ["MADE_UP"];
  wrongReasons.receiptHash = recomputeGuardRouteReceiptHash(wrongReasons);
  assert.throws(() => validateGuardRouteReport(wrongReasons), /reason codes/);
  const sameCommand = structuredClone(report);
  sameCommand.challenges[1].commandSha256 = sameCommand.challenges[0].commandSha256;
  sameCommand.receiptHash = recomputeGuardRouteReceiptHash(sameCommand);
  assert.throws(() => validateGuardRouteReport(sameCommand), /distinct commands/);
});

test("guard-route receipts map to fail-closed typed continuity events", () => {
  const continuityRoot = root();
  const issuer = sha256("issuer");
  const pass = route("claude");
  const binding = guardRouteBindingHash(pass);
  assert.equal(binding, guardRouteBindingHash(structuredClone(pass)));
  const passEvent = guardRouteContinuityEvent({
    report: pass,
    root: continuityRoot,
    eventId: "urn:uuid:10000000-0000-4000-8000-000000000001",
    issuer,
    freshUntil: "2026-08-25T19:00:00.000Z",
  });
  assert.deepEqual([passEvent.event.kind, passEvent.event.disposition, passEvent.event.reasonCode], ["verification_refreshed", "affirm", "guard.route.passed"]);
  assert.equal(passEvent.event.targetHash, binding);
  const failedEvent = guardRouteContinuityEvent({
    report: failed(pass), root: continuityRoot,
    eventId: "urn:uuid:10000000-0000-4000-8000-000000000002", issuer,
  });
  assert.deepEqual([failedEvent.event.disposition, failedEvent.event.reasonCode], ["revoke", "guard.route.failed"]);
  const heldEvent = guardRouteContinuityEvent({
    report: inconclusive(pass), root: continuityRoot,
    eventId: "urn:uuid:10000000-0000-4000-8000-000000000003", issuer,
  });
  assert.deepEqual([heldEvent.event.kind, heldEvent.event.disposition, heldEvent.event.reasonCode], ["coverage_gap", "hold", "guard.route.inconclusive"]);
  const changedEvent = guardRouteContinuityEvent({
    report: pass, root: continuityRoot,
    eventId: "urn:uuid:10000000-0000-4000-8000-000000000004", issuer,
    expectedBindingHash: sha256("different-binding"),
  });
  assert.deepEqual([changedEvent.event.disposition, changedEvent.event.reasonCode], ["revoke", "guard.route.binding.changed"]);
  assert.throws(() => guardRouteContinuityEvent({
    report: pass, root: continuityRoot,
    eventId: "urn:uuid:10000000-0000-4000-8000-000000000005", issuer,
    observedAt: "2026-08-25T17:59:59.000Z",
    freshUntil: "2026-08-25T19:00:00.000Z",
  }), /must not be earlier/);
  for (const forbidden of [pass.host.version, pass.bindings.operatingSystem.release, pass.reproduction]) {
    assert.equal(JSON.stringify(passEvent).includes(forbidden), false);
  }
});

test("the guarded-host demo preserves revocation until independent signed repair", () => {
  const result = runGuardContinuityDemo({ claudeRoute: route("claude"), codexRoute: route("codex") });
  assert.deepEqual(result.steps.map((item) => item.result), ["CURRENT", "REVOKED", "REVOKED", "CURRENT"]);
  assert.deepEqual(result.steps.map((item) => item.deployment), ["allowed", "stopped", "stopped", "allowed"]);
  assert.deepEqual(result.history.map((item) => item.kind), [
    "verification_refreshed",
    "verification_refreshed",
    "verification_refreshed",
    "verification_refreshed",
    "remediation_verified",
  ]);
  assert.equal(result.controlledFailure.controlledFixture, true);
  assert.equal(result.controlledFailure.realIncident, false);
  const rendered = renderGuardContinuityDemo(result);
  assert.match(rendered, /controlled fail-open fixture/i);
  assert.match(rendered, /later passing route did not erase/i);
  assert.match(rendered, /not a real Claude, Codex, repository, deployment, or customer incident/i);
});

test("the guard demo refuses a missing host pass or an operating-system mismatch", () => {
  assert.throws(() => runGuardContinuityDemo({ claudeRoute: failed(route("claude")), codexRoute: route("codex") }), /PASS receipts/);
  const otherMachine = route("codex");
  otherMachine.bindings.operatingSystem.machineIdentitySha256 = sha256("different-machine");
  otherMachine.receiptHash = recomputeGuardRouteReceiptHash(otherMachine);
  assert.throws(() => runGuardContinuityDemo({ claudeRoute: route("claude"), codexRoute: otherMachine }), /same operating-system binding/);
});

test("the continuity guard-demo CLI writes a reduced result without replacing inputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-continuity-guard-cli-"));
  try {
    const claudePath = join(directory, "claude.json");
    const codexPath = join(directory, "codex.json");
    const outputPath = join(directory, "result.json");
    writeFileSync(claudePath, `${JSON.stringify(route("claude"))}\n`);
    writeFileSync(codexPath, `${JSON.stringify(route("codex"))}\n`);
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      assert.equal(runContinuityCommand([
        "guard-demo", "--claude-route", claudePath, "--codex-route", codexPath,
        "--format", "json", "--output", outputPath,
      ]), 0);
      assert.equal(runContinuityCommand([
        "guard-demo", "--claude-route", claudePath, "--codex-route", codexPath,
        "--output", claudePath,
      ]), 2);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    const saved = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.deepEqual(saved.steps.map((item: { result: string }) => item.result), ["CURRENT", "REVOKED", "REVOKED", "CURRENT"]);
    assert.equal(JSON.stringify(saved).includes(directory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
