import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.ts";
import {
  compareGuardRoutes,
  recomputeGuardRouteDiffHash,
  renderGuardRouteDiff,
} from "../src/guard-route-diff.ts";
import { guardDigest } from "../src/guard-compat.ts";
import { guardEnvironmentBindingHash } from "../src/guard-environment.ts";
import { publicKeyDer, signingKeyId } from "../src/signature.ts";
import {
  GUARD_ROUTE_PAYLOAD_TYPE,
  openGuardRouteEnvelope,
  sealGuardRoute,
  type GuardRouteEnvelope,
} from "../src/guard-route-seal.ts";
import { validateGuardRouteReport } from "../src/continuity/guard.ts";
import {
  recomputeGuardRouteReceiptHash,
  type GuardRouteReport,
  type GuardRouteReportV1,
  type GuardRouteReportV2,
} from "../src/guard-route.ts";

const ENVIRONMENT_KEYS = generateKeyPairSync("ed25519");
const ENVIRONMENT_KEY_ID = signingKeyId(publicKeyDer(ENVIRONMENT_KEYS.publicKey));
const ROUTE_KEYS = generateKeyPairSync("ed25519");

function routeEnvelope(report: unknown, keys = ROUTE_KEYS): GuardRouteEnvelope {
  const payload = Buffer.from(JSON.stringify(validateGuardRouteReport(report)), "utf8");
  const type = Buffer.from(GUARD_ROUTE_PAYLOAD_TYPE, "utf8");
  const pae = Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "ascii"), type,
    Buffer.from(` ${payload.length} `, "ascii"), payload,
  ]);
  return {
    payloadType: GUARD_ROUTE_PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{
      keyid: signingKeyId(publicKeyDer(keys.publicKey)),
      sig: sign(null, pae, keys.privateKey).toString("base64"),
    }],
  };
}

function managedEnvironment(policySeed = "same-policy-set", host: "claude" | "codex" = "claude") {
  const unsigned = {
    schemaVersion: "agent-vigil-guard-environment-binding/v1" as const,
    statementHash: guardDigest("same-managed-environment-statement"),
    signerKeyId: ENVIRONMENT_KEY_ID,
    environmentIdSha256: guardDigest("engineering-production"),
    host,
    profileIdentitySha256: guardDigest("unique-disposable-profile"),
    policySetSha256: guardDigest(policySeed),
    validFrom: "2026-09-02T13:00:00.000Z",
    validUntil: "2026-09-02T15:00:00.000Z",
  };
  const bindingHash = guardDigest(unsigned);
  return {
    ...unsigned,
    bindingHash,
    signature: {
      algorithm: "Ed25519" as const,
      value: sign(null, Buffer.from(bindingHash, "utf8"), ENVIRONMENT_KEYS.privateKey).toString("base64"),
    },
  };
}

function compare(input: { current: unknown; candidate: unknown }) {
  return compareGuardRoutes({
    current: routeEnvelope(input.current),
    candidate: routeEnvelope(input.candidate),
    trustedEnvironmentPublicKey: ENVIRONMENT_KEYS.publicKey,
    trustedRoutePublicKey: ROUTE_KEYS.publicKey,
    evaluatedAt: "2026-09-02T14:06:00.000Z",
  });
}

function receipt(version: string, generatedAt: string): GuardRouteReport {
  const report: GuardRouteReportV2 = {
    schemaVersion: "agent-vigil-live-host-route/v2",
    vigilVersion: "0.23.3-test",
    generatedAt,
    nonce: guardDigest(version).slice("sha256:".length, "sha256:".length + 32),
    scope: "LIVE_HOST_ROUTING",
    status: "PASS",
    deployment: { state: "HOLD", reasonCodes: ["OTHER_HOST_ROUTE_NOT_PROVEN", "NON_DEPLOYING_DRILL"] },
    nextGate: { state: "ONE_HOST_PROVEN", requirement: "BOTH_CURRENT_HOSTS_MUST_PASS" },
    challengePack: { id: "agent-vigil-harmless-live-host-route/v1", sha256: guardDigest("same-pack") },
    host: {
      kind: "claude",
      version,
      executableSha256: guardDigest(`executable-${version}`),
      invocationSha256: guardDigest(`invocation-${version}`),
      process: { process: "EXITED", exit: "ZERO", output: "JSON" },
    },
    control: {
      name: "Agent Vigil temporary route control",
      version: "1",
      launcherSha256: guardDigest("launcher"),
      artifactSha256: guardDigest("artifact"),
      policySha256: guardDigest("policy"),
      configurationSha256: guardDigest("configuration"),
    },
    processConformance: { status: "PASS", receiptHash: guardDigest(`process-${version}`) },
    bindings: {
      profileMarkerSha256: guardDigest("profile-marker"),
      operatingSystem: {
        platform: "darwin",
        type: "Darwin",
        release: "25.6.0",
        architecture: "arm64",
        machineIdentitySha256: guardDigest("machine"),
      },
      managedEnvironment: managedEnvironment(),
    },
    challenges: [
      {
        id: "allow-route", expectedDecision: "ALLOW", actualDecision: "ALLOW",
        expectedExecution: true, observedExecution: true,
        commandSha256: guardDigest(`allow-${version}`),
        toolUseIdSha256: guardDigest(`allow-call-${version}`),
        sessionIdSha256: guardDigest(`session-${version}`), passed: true,
      },
      {
        id: "deny-route", expectedDecision: "DENY", actualDecision: "DENY",
        expectedExecution: false, observedExecution: false,
        commandSha256: guardDigest(`deny-${version}`),
        toolUseIdSha256: guardDigest(`deny-call-${version}`),
        sessionIdSha256: guardDigest(`session-${version}`), passed: true,
      },
    ],
    summary: { passed: 2, total: 2, routedCalls: 2, unexpectedCalls: 0 },
    cleanup: {
      temporaryConfigurationRemoved: true,
      ordinaryConfigurationUnchanged: true,
      disposableProfileRemoval: "OPERATOR_REQUIRED",
    },
    reproduction: "vigil guard-route --host claude --host-version <same> --host-executable <same> --profile-home <fresh-disposable-profile>",
    limitations: ["Synthetic exact-version route fixture."],
    receiptHash: guardDigest("placeholder"),
  };
  report.receiptHash = recomputeGuardRouteReceiptHash(report);
  return report;
}

function legacyReceipt(version: string, generatedAt: string): GuardRouteReportV1 {
  const modern = receipt(version, generatedAt) as GuardRouteReportV2;
  const report: GuardRouteReportV1 = {
    ...modern,
    schemaVersion: "agent-vigil-live-host-route/v1",
    bindings: {
      profileMarkerSha256: modern.bindings.profileMarkerSha256,
      operatingSystem: modern.bindings.operatingSystem,
    },
  };
  report.receiptHash = recomputeGuardRouteReceiptHash(report);
  return report;
}

function failure(candidate: GuardRouteReport, kind: "expanded" | "reduced" | "mixed" | "inconclusive"): GuardRouteReport {
  const report = structuredClone(candidate);
  report.status = kind === "inconclusive" ? "INCONCLUSIVE" : "FAIL";
  report.nextGate.state = "BLOCKED";
  report.deployment.reasonCodes = kind === "inconclusive"
    ? ["LIVE_HOST_ROUTE_NOT_PROVEN", "PROCESS_CONFORMANCE_NOT_PROVEN", "HOST_UNAVAILABLE_BEFORE_ROUTE"]
    : ["LIVE_HOST_ROUTE_NOT_PROVEN"];
  if (kind === "inconclusive") {
    report.host.process = { process: "EXITED", exit: "NONZERO", output: "TEXT" };
    report.processConformance.status = "INCONCLUSIVE";
    report.challenges = report.challenges.map((item) => ({
      id: item.id, expectedDecision: item.expectedDecision, actualDecision: "UNKNOWN",
      expectedExecution: item.expectedExecution, observedExecution: false,
      commandSha256: item.commandSha256, passed: false,
    }));
    report.summary = { passed: 0, total: 2, routedCalls: 0, unexpectedCalls: 0 };
  } else {
    if (kind === "expanded" || kind === "mixed") {
      report.challenges[1].actualDecision = "ALLOW";
      report.challenges[1].observedExecution = true;
      report.challenges[1].passed = false;
    }
    if (kind === "reduced" || kind === "mixed") {
      report.challenges[0].actualDecision = "DENY";
      report.challenges[0].observedExecution = false;
      report.challenges[0].passed = false;
    }
    report.summary.passed = kind === "mixed" ? 0 : 1;
  }
  report.receiptHash = recomputeGuardRouteReceiptHash(report);
  return report;
}

const CURRENT_TIME = "2026-09-02T14:00:00.000Z";
const CANDIDATE_TIME = "2026-09-02T14:05:00.000Z";

test("matching exact bindings and preserved paired routes approve a distinct candidate version", () => {
  const report = compare({
    current: receipt("2.1.245", CURRENT_TIME),
    candidate: receipt("2.1.246", CANDIDATE_TIME),
  });
  assert.equal(report.decision, "APPROVE");
  assert.equal(report.classification, "UNCHANGED");
  assert.deepEqual(report.changes, []);
  assert.deepEqual(report.reasonCodes, ["NO_AUTHORITY_CHANGE_OBSERVED"]);
  assert.equal(recomputeGuardRouteDiffHash(report), report.decisionHash);
  assert.match(renderGuardRouteDiff(report), /upgrade decision: APPROVE/);
});

test("the offline seal authenticates the complete normalized receipt with DSSE", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-route-seal-"));
  const privateKeyPath = join(directory, "route-private.pem");
  try {
    writeFileSync(privateKeyPath, ROUTE_KEYS.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const envelope = sealGuardRoute(receipt("2.1.245", CURRENT_TIME), privateKeyPath);
    const opened = openGuardRouteEnvelope(envelope, ROUTE_KEYS.publicKey);
    assert.equal(opened.report.host.version, "2.1.245");
    assert.equal(opened.report.receiptHash, receipt("2.1.245", CURRENT_TIME).receiptHash);

    const tampered = structuredClone(envelope);
    const payload = JSON.parse(Buffer.from(tampered.payload, "base64").toString("utf8"));
    payload.host.version = "2.1.999";
    tampered.payload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    assert.throws(() => openGuardRouteEnvelope(tampered, ROUTE_KEYS.publicKey), /receipt hash is invalid|signature is invalid/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("guard-route-seal writes a verifiable envelope and refuses in-place output", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-route-seal-cli-"));
  const receiptPath = join(directory, "route.json");
  const privateKeyPath = join(directory, "route-private.pem");
  const outputPath = join(directory, "route.dsse.json");
  try {
    writeFileSync(receiptPath, JSON.stringify(receipt("2.1.245", CURRENT_TIME)));
    writeFileSync(privateKeyPath, ROUTE_KEYS.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (() => undefined) as typeof console.log;
    console.error = (() => undefined) as typeof console.error;
    try {
      assert.equal(run(["guard-route-seal", "--receipt", receiptPath, "--signing-key", privateKeyPath, "--output", outputPath]), 0);
      assert.equal(run(["guard-route-seal", "--receipt", receiptPath, "--signing-key", privateKeyPath, "--output", receiptPath]), 2);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    const opened = openGuardRouteEnvelope(JSON.parse(readFileSync(outputPath, "utf8")), ROUTE_KEYS.publicKey);
    assert.equal(opened.report.receiptHash, receipt("2.1.245", CURRENT_TIME).receiptHash);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("approval fails closed without a pinned key or with a forged managed-environment signature", () => {
  assert.throws(() => compareGuardRoutes({
    current: routeEnvelope(receipt("2.1.245", CURRENT_TIME)),
    candidate: routeEnvelope(receipt("2.1.246", CANDIDATE_TIME)),
    trustedEnvironmentPublicKey: ENVIRONMENT_KEYS.publicKey,
  }), /trusted guard route key is not pinned/);

  const withoutEnvironmentKey = compareGuardRoutes({
    current: routeEnvelope(receipt("2.1.245", CURRENT_TIME)),
    candidate: routeEnvelope(receipt("2.1.246", CANDIDATE_TIME)),
    trustedRoutePublicKey: ROUTE_KEYS.publicKey,
    evaluatedAt: "2026-09-02T14:06:00.000Z",
  });
  assert.equal(withoutEnvironmentKey.decision, "HOLD");
  assert.ok(withoutEnvironmentKey.reasonCodes.includes("TRUSTED_ENVIRONMENT_KEY_NOT_PINNED"));

  const forged = receipt("2.1.246", CANDIDATE_TIME) as GuardRouteReportV2;
  forged.bindings.managedEnvironment.signature.value = Buffer.alloc(64).toString("base64");
  forged.receiptHash = recomputeGuardRouteReceiptHash(forged);
  const rejected = compare({ current: receipt("2.1.245", CURRENT_TIME), candidate: forged });
  assert.equal(rejected.decision, "HOLD");
  assert.ok(rejected.reasonCodes.includes("MANAGED_ENVIRONMENT_SIGNATURE_INVALID"));

  const wrongKey = generateKeyPairSync("ed25519").publicKey;
  const substituted = compareGuardRoutes({
    current: routeEnvelope(receipt("2.1.245", CURRENT_TIME)),
    candidate: routeEnvelope(receipt("2.1.246", CANDIDATE_TIME)),
    trustedEnvironmentPublicKey: wrongKey,
    trustedRoutePublicKey: ROUTE_KEYS.publicKey,
    evaluatedAt: "2026-09-02T14:06:00.000Z",
  });
  assert.equal(substituted.decision, "HOLD");
  assert.ok(substituted.reasonCodes.includes("MANAGED_ENVIRONMENT_SIGNATURE_INVALID"));
});

test("legacy receipts fail closed before sealing because they do not bind a signed managed environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-legacy-route-seal-"));
  const privateKeyPath = join(directory, "route-private.pem");
  try {
    writeFileSync(privateKeyPath, ROUTE_KEYS.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    assert.throws(
      () => sealGuardRoute(legacyReceipt("2.1.245", CURRENT_TIME), privateKeyPath),
      /only live-host route v2 receipts can be sealed/,
    );
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("new authority, lost authority, and both changes are distinguished and held", () => {
  for (const [kind, expected] of [
    ["expanded", "EXPANDED"],
    ["reduced", "REDUCED"],
    ["mixed", "MIXED"],
  ] as const) {
    const report = compare({
      current: receipt("2.1.245", CURRENT_TIME),
      candidate: failure(receipt("2.1.246", CANDIDATE_TIME), kind),
    });
    assert.equal(report.decision, "HOLD", kind);
    assert.equal(report.classification, expected, kind);
    assert.ok(report.changes.length >= (kind === "mixed" ? 4 : 2), kind);
  }
});

test("inconclusive evidence and comparison-binding drift cannot become unchanged", () => {
  const notChecked = compare({
    current: receipt("2.1.245", CURRENT_TIME),
    candidate: failure(receipt("2.1.246", CANDIDATE_TIME), "inconclusive"),
  });
  assert.equal(notChecked.decision, "HOLD");
  assert.equal(notChecked.classification, "NOT_CHECKED");
  assert.ok(notChecked.reasonCodes.includes("CANDIDATE_ROUTE_NOT_CHECKED"));

  const otherMachine = receipt("2.1.246", CANDIDATE_TIME);
  otherMachine.bindings.operatingSystem.machineIdentitySha256 = guardDigest("other-machine");
  otherMachine.receiptHash = recomputeGuardRouteReceiptHash(otherMachine);
  const drifted = compare({ current: receipt("2.1.245", CURRENT_TIME), candidate: otherMachine });
  assert.equal(drifted.decision, "HOLD");
  assert.equal(drifted.classification, "NOT_CHECKED");
  assert.deepEqual(drifted.changes, []);
  assert.ok(drifted.reasonCodes.includes("OPERATING_SYSTEM_CHANGED"));

  const sameVersion = compare({
    current: receipt("2.1.245", CURRENT_TIME), candidate: receipt("2.1.245", CANDIDATE_TIME),
  });
  assert.equal(sameVersion.decision, "HOLD");
  assert.ok(sameVersion.reasonCodes.includes("HOST_VERSION_UNCHANGED"));

  const olderCandidate = compare({
    current: receipt("2.1.245", CANDIDATE_TIME), candidate: receipt("2.1.246", CURRENT_TIME),
  });
  assert.equal(olderCandidate.decision, "HOLD");
  assert.ok(olderCandidate.reasonCodes.includes("CANDIDATE_RECEIPT_OLDER"));
});

test("every verifier, host, pack, control, profile, managed-environment, and operating-system binding fails closed", () => {
  const cases: Array<[string, (value: GuardRouteReport) => void, string]> = [
    ["verifier", (value) => { value.vigilVersion = "0.23.4-test"; }, "VERIFIER_VERSION_CHANGED"],
    ["host", (value) => {
      value.host.kind = "codex";
      if (value.schemaVersion === "agent-vigil-live-host-route/v2") {
        value.bindings.managedEnvironment = managedEnvironment("same-policy-set", "codex");
      }
    }, "HOST_KIND_CHANGED"],
    ["pack", (value) => { value.challengePack.sha256 = guardDigest("different-pack"); }, "CHALLENGE_PACK_CHANGED"],
    ["control", (value) => { value.control.policySha256 = guardDigest("different-policy"); }, "CONTROL_BINDING_CHANGED"],
    ["profile marker", (value) => { value.bindings.profileMarkerSha256 = guardDigest("different-profile-marker"); }, "PROFILE_MARKER_CHANGED"],
    ["os", (value) => { value.bindings.operatingSystem.release = "25.7.0"; }, "OPERATING_SYSTEM_CHANGED"],
    ["managed environment", (value) => {
      if (value.schemaVersion === "agent-vigil-live-host-route/v2") {
        value.bindings.managedEnvironment = managedEnvironment("different-policy-set");
      }
    }, "MANAGED_ENVIRONMENT_CHANGED"],
  ];
  for (const [label, mutate, reason] of cases) {
    const candidate = receipt("2.1.246", CANDIDATE_TIME);
    mutate(candidate);
    candidate.receiptHash = recomputeGuardRouteReceiptHash(candidate);
    const report = compare({ current: receipt("2.1.245", CURRENT_TIME), candidate });
    assert.equal(report.decision, "HOLD", label);
    assert.equal(report.classification, "NOT_CHECKED", label);
    assert.ok(report.reasonCodes.includes(reason), label);
    assert.deepEqual(report.changes, [], label);
  }
});

test("extra routed activity and an unproven current baseline cannot be approved", () => {
  const noisy = receipt("2.1.246", CANDIDATE_TIME);
  noisy.status = "FAIL";
  noisy.deployment.reasonCodes = ["LIVE_HOST_ROUTE_NOT_PROVEN"];
  noisy.nextGate.state = "BLOCKED";
  noisy.summary.unexpectedCalls = 1;
  noisy.receiptHash = recomputeGuardRouteReceiptHash(noisy);
  const extra = compare({ current: receipt("2.1.245", CURRENT_TIME), candidate: noisy });
  assert.equal(extra.decision, "HOLD");
  assert.equal(extra.classification, "NOT_CHECKED");
  assert.ok(extra.reasonCodes.includes("CANDIDATE_ROUTE_FAILED_WITHOUT_CLASSIFIABLE_CHANGE"));

  const baseline = failure(receipt("2.1.245", CURRENT_TIME), "expanded");
  const unproven = compare({ current: baseline, candidate: receipt("2.1.246", CANDIDATE_TIME) });
  assert.equal(unproven.decision, "HOLD");
  assert.equal(unproven.classification, "NOT_CHECKED");
  assert.ok(unproven.reasonCodes.includes("CURRENT_ROUTE_NOT_PROVEN"));
});

test("tampered source receipts are rejected even when their visible fields look favorable", () => {
  const candidate = receipt("2.1.246", CANDIDATE_TIME);
  candidate.host.version = "2.1.999";
  assert.throws(() => compare({ current: receipt("2.1.245", CURRENT_TIME), candidate }), /receipt hash is invalid/);
});

test("a forged full route receipt, stale receipt, or reused trust root cannot approve", () => {
  const attacker = generateKeyPairSync("ed25519");
  assert.throws(() => compareGuardRoutes({
    current: routeEnvelope(receipt("2.1.245", CURRENT_TIME), attacker),
    candidate: routeEnvelope(receipt("2.1.246", CANDIDATE_TIME), attacker),
    trustedEnvironmentPublicKey: ENVIRONMENT_KEYS.publicKey,
    trustedRoutePublicKey: ROUTE_KEYS.publicKey,
    evaluatedAt: "2026-09-02T14:06:00.000Z",
  }), /signature is invalid/);

  const stale = compareGuardRoutes({
    current: routeEnvelope(receipt("2.1.245", CURRENT_TIME)),
    candidate: routeEnvelope(receipt("2.1.246", CANDIDATE_TIME)),
    trustedEnvironmentPublicKey: ENVIRONMENT_KEYS.publicKey,
    trustedRoutePublicKey: ROUTE_KEYS.publicKey,
    evaluatedAt: "2026-09-03T15:00:00.000Z",
  });
  assert.equal(stale.decision, "HOLD");
  assert.ok(stale.reasonCodes.includes("CURRENT_RECEIPT_STALE"));
  assert.ok(stale.reasonCodes.includes("CANDIDATE_RECEIPT_STALE"));

  const sameRoot = compareGuardRoutes({
    current: routeEnvelope(receipt("2.1.245", CURRENT_TIME), ENVIRONMENT_KEYS),
    candidate: routeEnvelope(receipt("2.1.246", CANDIDATE_TIME), ENVIRONMENT_KEYS),
    trustedEnvironmentPublicKey: ENVIRONMENT_KEYS.publicKey,
    trustedRoutePublicKey: ENVIRONMENT_KEYS.publicKey,
    evaluatedAt: "2026-09-02T14:06:00.000Z",
  });
  assert.equal(sameRoot.decision, "HOLD");
  assert.ok(sameRoot.reasonCodes.includes("TRUST_ROOTS_NOT_SEPARATED"));
});

test("the CLI emits a machine-readable HOLD and refuses to overwrite either input", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-guard-diff-cli-"));
  const currentPath = join(directory, "current.json");
  const candidatePath = join(directory, "candidate.json");
  const outputPath = join(directory, "decision.json");
  const publicKeyPath = join(directory, "environment-public.pem");
  const routePublicKeyPath = join(directory, "route-public.pem");
  try {
    writeFileSync(currentPath, JSON.stringify(routeEnvelope(receipt("2.1.245", CURRENT_TIME))));
    writeFileSync(candidatePath, JSON.stringify(routeEnvelope(failure(receipt("2.1.246", CANDIDATE_TIME), "expanded"))));
    writeFileSync(publicKeyPath, ENVIRONMENT_KEYS.publicKey.export({ format: "pem", type: "spki" }));
    writeFileSync(routePublicKeyPath, ROUTE_KEYS.publicKey.export({ format: "pem", type: "spki" }));
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (() => undefined) as typeof console.log;
    console.error = (() => undefined) as typeof console.error;
    try {
      assert.equal(run(["guard-diff", "--current", currentPath, "--candidate", candidatePath, "--environment-public-key", publicKeyPath, "--route-public-key", routePublicKeyPath, "--format", "json", "--output", outputPath, "--evaluated-at", "2026-09-02T14:06:00.000Z"]), 1);
      assert.equal(run(["guard-diff", "--current", currentPath, "--candidate", candidatePath, "--environment-public-key", publicKeyPath, "--route-public-key", routePublicKeyPath, "--output", currentPath]), 2);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("hostile version text cannot control the terminal presentation", () => {
  const current = receipt("2.1.245", CURRENT_TIME);
  const candidate = receipt("2.1.246", CANDIDATE_TIME);
  const report = compare({ current, candidate });
  report.host.candidateVersion = "2.1.246\u001b[31m\u202E";
  const rendered = renderGuardRouteDiff(report);
  assert.equal(rendered.includes("\u001b"), false);
  assert.equal(rendered.includes("\u202E"), false);
  assert.match(rendered, /\\u\{001B\}/);
  assert.match(rendered, /\\u\{202E\}/);
});
