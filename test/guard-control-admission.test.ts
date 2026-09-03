import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildGuardControlAdmission } from "../src/guard-admission.ts";
import { runGuardAdmissionCommand, runGuardDeployGateCommand } from "../src/guard-admission-cli.ts";
import {
  buildGuardControlObservation,
  classifyObserverRequest,
  gateGuardControlAdmission,
  issueGuardControlChallenge,
  signGuardControlIsolationAttestation,
  signGuardControlAdmission,
  openGuardControlAdmission,
  type GuardControlChallenge,
  type GuardControlObservation,
} from "../src/guard-control-protocol.ts";
import { guardDigest } from "../src/guard-compat.ts";
import { guardEnvironmentBindingHash } from "../src/guard-environment.ts";
import { recomputeGuardRouteReceiptHash, type GuardRouteReportV2 } from "../src/guard-route.ts";
import { sealGuardRoute } from "../src/guard-route-seal.ts";
import { localGuardSigner } from "../src/guard-signing.ts";
import { publicKeyDer, signingKeyId } from "../src/signature.ts";

const TIMES = {
  currentIssued: "2026-09-03T14:00:00.000Z",
  currentRoute: "2026-09-03T14:01:00.000Z",
  currentEvent: "2026-09-03T14:01:30.000Z",
  currentClosed: "2026-09-03T14:02:00.000Z",
  candidateIssued: "2026-09-03T14:03:00.000Z",
  candidateRoute: "2026-09-03T14:04:00.000Z",
  candidateEvent: "2026-09-03T14:04:30.000Z",
  candidateClosed: "2026-09-03T14:05:00.000Z",
  evaluated: "2026-09-03T14:06:00.000Z",
  validUntil: "2026-09-03T14:36:00.000Z",
};

function keyFiles(directory: string) {
  const roles = ["environment", "route", "challenge", "observer", "isolation", "admission"] as const;
  return Object.fromEntries(roles.map((role) => {
    const pair = generateKeyPairSync("ed25519");
    const privatePath = join(directory, `${role}-private.pem`);
    writeFileSync(privatePath, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    return [role, { ...pair, privatePath }];
  })) as Record<typeof roles[number], ReturnType<typeof generateKeyPairSync> & { privatePath: string }>;
}

function environment(keys: ReturnType<typeof keyFiles>["environment"]) {
  const unsigned = {
    schemaVersion: "agent-vigil-guard-environment-binding/v1" as const,
    statementHash: guardDigest("managed-environment-statement"),
    signerKeyId: signingKeyId(publicKeyDer(keys.publicKey)),
    environmentIdSha256: guardDigest("engineering-production"),
    host: "claude" as const,
    profileIdentitySha256: guardDigest("profile-identity"),
    policySetSha256: guardDigest("policy-set"),
    validFrom: "2026-09-03T13:00:00.000Z",
    validUntil: "2026-09-03T15:00:00.000Z",
  };
  const bindingHash = guardDigest(unsigned);
  return {
    ...unsigned,
    bindingHash,
    signature: { algorithm: "Ed25519" as const, value: sign(null, Buffer.from(bindingHash), keys.privateKey).toString("base64") },
  };
}

function routeReceipt(input: {
  challenge: GuardControlChallenge;
  generatedAt: string;
  managedEnvironment: ReturnType<typeof environment>;
}): GuardRouteReportV2 {
  const { challenge } = input;
  const session = guardDigest(`session-${challenge.challengeHash}`);
  const report: GuardRouteReportV2 = {
    schemaVersion: "agent-vigil-live-host-route/v2",
    vigilVersion: "0.23.4-test",
    generatedAt: input.generatedAt,
    nonce: challenge.nonce,
    scope: "LIVE_HOST_ROUTING",
    status: "PASS",
    deployment: { state: "HOLD", reasonCodes: ["OTHER_HOST_ROUTE_NOT_PROVEN", "NON_DEPLOYING_DRILL"] },
    nextGate: { state: "ONE_HOST_PROVEN", requirement: "BOTH_CURRENT_HOSTS_MUST_PASS" },
    challengePack: challenge.pack,
    host: {
      kind: challenge.target.host,
      version: challenge.target.version,
      executableSha256: challenge.target.executableSha256,
      invocationSha256: guardDigest(`invocation-${challenge.challengeHash}`),
      process: { process: "EXITED", exit: "ZERO", output: "JSON" },
    },
    control: {
      name: "Agent Vigil temporary route control",
      version: "1",
      launcherSha256: guardDigest("stable-launcher"),
      artifactSha256: guardDigest(`ephemeral-hook-${challenge.challengeHash}`),
      policySha256: guardDigest(`ephemeral-policy-${challenge.challengeHash}`),
      configurationSha256: guardDigest(`ephemeral-config-${challenge.challengeHash}`),
    },
    processConformance: { status: "PASS", receiptHash: guardDigest(`process-${challenge.challengeHash}`) },
    bindings: {
      profileMarkerSha256: guardDigest("profile-marker"),
      operatingSystem: {
        platform: "darwin", type: "Darwin", release: "25.6.0", architecture: "arm64",
        machineIdentitySha256: guardDigest("isolated-worker"),
      },
      managedEnvironment: input.managedEnvironment,
    },
    challenges: [
      {
        id: "allow-route", expectedDecision: "ALLOW", actualDecision: "ALLOW", expectedExecution: true,
        observedExecution: true, commandSha256: challenge.commands.allowSha256,
        toolUseIdSha256: guardDigest(`allow-call-${challenge.challengeHash}`), sessionIdSha256: session, passed: true,
      },
      {
        id: "deny-route", expectedDecision: "DENY", actualDecision: "DENY", expectedExecution: false,
        observedExecution: false, commandSha256: challenge.commands.denySha256,
        toolUseIdSha256: guardDigest(`deny-call-${challenge.challengeHash}`), sessionIdSha256: session, passed: true,
      },
    ],
    summary: { passed: 2, total: 2, routedCalls: 2, unexpectedCalls: 0 },
    cleanup: { temporaryConfigurationRemoved: true, ordinaryConfigurationUnchanged: true, disposableProfileRemoval: "OPERATOR_REQUIRED" },
    reproduction: "vigil guard-route --external-challenge <signed-challenge>",
    limitations: ["Synthetic independent-control admission fixture."],
    receiptHash: guardDigest("placeholder"),
  };
  report.receiptHash = recomputeGuardRouteReceiptHash(report);
  return report;
}

function isolationAttestation(input: {
  challenge: GuardControlChallenge;
  report: GuardRouteReportV2;
  signer: ReturnType<typeof localGuardSigner>;
}) {
  return signGuardControlIsolationAttestation({
    schemaVersion: "agent-vigil-control-isolation/v1",
    issuedAt: input.challenge.issuedAt,
    validUntil: input.challenge.expiresAt,
    challengeHash: input.challenge.challengeHash,
    routeReceiptHash: input.report.receiptHash,
    artifactSha256: input.challenge.target.executableSha256,
    environmentSha256: input.challenge.target.managedEnvironmentSha256,
    boundary: {
      platform: "linux", candidateUid: 10001, monitorUid: 0,
      verifierState: "MONITOR_OWNED_READ_ONLY", monitorIpc: "AUTHENTICATED", egress: "OBSERVER_ONLY",
    },
    status: "PASS",
    reasonCodes: ["DISTINCT_UID_IMMUTABLE_STATE_AUTHENTICATED_MONITOR"],
  }, input.signer);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vigil-control-admission-"));
  const keys = keyFiles(directory);
  const managedEnvironment = environment(keys.environment);
  const environmentSha256 = guardDigest(managedEnvironment);
  const challengeSigner = localGuardSigner(keys.challenge.privatePath);
  const observerSigner = localGuardSigner(keys.observer.privatePath);
  const current = issueGuardControlChallenge({
    origin: "https://observer.example", host: "claude", version: "2.1.245",
    executableSha256: guardDigest("current-package"), managedEnvironmentSha256: environmentSha256,
    nodeExecutable: process.execPath, signer: challengeSigner,
    issuedAt: TIMES.currentIssued, expiresAt: "2026-09-03T14:10:00.000Z", nonce: "current_challenge_nonce_0001",
  });
  const candidate = issueGuardControlChallenge({
    origin: "https://observer.example", host: "claude", version: "2.1.246",
    executableSha256: guardDigest("candidate-package"), managedEnvironmentSha256: environmentSha256,
    nodeExecutable: process.execPath, signer: challengeSigner,
    issuedAt: TIMES.candidateIssued, expiresAt: "2026-09-03T14:13:00.000Z", nonce: "candidate_challenge_nonce_01",
  });
  const observe = (challenge: GuardControlChallenge, openedAt: string, eventAt: string, closedAt: string) => buildGuardControlObservation({
    challenge,
    openedAt,
    closedAt,
    events: [classifyObserverRequest({
      plan: { schemaVersion: "agent-vigil-external-control-plan/v1", challengeHash: challenge.challengeHash,
        allowPath: challenge.observer.allowPath, denyPath: challenge.observer.denyPath, expiresAt: challenge.expiresAt },
      path: challenge.observer.allowPath, method: "POST", body: Buffer.from("agent-vigil-external-control-canary/v1\n"), observedAt: eventAt,
    })],
    signer: observerSigner,
  });
  const currentObserved = observe(current.challenge, TIMES.currentIssued, TIMES.currentEvent, TIMES.currentClosed);
  const candidateObserved = observe(candidate.challenge, TIMES.candidateIssued, TIMES.candidateEvent, TIMES.candidateClosed);
  const currentReport = routeReceipt({ challenge: current.challenge, generatedAt: TIMES.currentRoute, managedEnvironment });
  const candidateReport = routeReceipt({ challenge: candidate.challenge, generatedAt: TIMES.candidateRoute, managedEnvironment });
  const isolationSigner = localGuardSigner(keys.isolation.privatePath);
  const currentIsolation = isolationAttestation({ challenge: current.challenge, report: currentReport, signer: isolationSigner });
  const candidateIsolation = isolationAttestation({ challenge: candidate.challenge, report: candidateReport, signer: isolationSigner });
  return {
    directory, keys, managedEnvironment, environmentSha256, current, candidate, currentObserved, candidateObserved,
    currentReport, candidateReport, currentIsolation, candidateIsolation,
    currentRoute: sealGuardRoute(currentReport, keys.route.privatePath),
    candidateRoute: sealGuardRoute(candidateReport, keys.route.privatePath),
  };
}

function admit(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return buildGuardControlAdmission({
    current: { route: f.currentRoute, challenge: f.current.envelope, observation: f.currentObserved.envelope, isolation: f.currentIsolation.envelope },
    candidate: { route: f.candidateRoute, challenge: f.candidate.envelope, observation: f.candidateObserved.envelope, isolation: f.candidateIsolation.envelope },
    challengePublicKey: f.keys.challenge.publicKey,
    observerPublicKey: f.keys.observer.publicKey,
    routePublicKey: f.keys.route.publicKey,
    environmentPublicKey: f.keys.environment.publicKey,
    isolationPublicKey: f.keys.isolation.publicKey,
    admissionSigner: localGuardSigner(f.keys.admission.privatePath),
    evaluatedAt: TIMES.evaluated,
    validUntil: TIMES.validUntil,
    ...overrides,
  });
}

test("fresh independently observed exact-version evidence creates an artifact-specific APPROVE gate", () => {
  const f = fixture();
  try {
    const result = admit(f);
    assert.equal(result.routeDecision.decision, "APPROVE");
    assert.equal(result.admission.decision, "APPROVE");
    assert.deepEqual(result.admission.reasonCodes, ["EXACT_CONTROL_ADMISSION_PROVEN"]);
    const opened = openGuardControlAdmission(result.envelope, f.keys.admission.publicKey);
    assert.equal(opened.admission.evidence.candidate.routeReceiptHash, f.candidateReport.receiptHash);
    assert.equal(gateGuardControlAdmission({
      envelope: result.envelope,
      publicKey: f.keys.admission.publicKey,
      expectedArtifactSha256: f.candidate.challenge.target.executableSha256,
      expectedEnvironmentSha256: f.environmentSha256,
      asOf: "2026-09-03T14:10:00.000Z",
    }).decision, "APPROVE");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("command substitution, deny effects, stale observations, and artifact mismatch fail closed", () => {
  const f = fixture();
  try {
    const substituted = structuredClone(f.candidateReport);
    substituted.challenges[0].commandSha256 = guardDigest("substituted-command");
    substituted.receiptHash = recomputeGuardRouteReceiptHash(substituted);
    const commandHold = admit(f, { candidate: {
      route: sealGuardRoute(substituted, f.keys.route.privatePath),
      challenge: f.candidate.envelope,
      observation: f.candidateObserved.envelope,
      isolation: f.candidateIsolation.envelope,
    } });
    assert.equal(commandHold.admission.decision, "HOLD");
    assert.ok(commandHold.admission.reasonCodes.includes("CANDIDATE_ALLOW_COMMAND_MISMATCH"));

    const denyObservation = buildGuardControlObservation({
      challenge: f.candidate.challenge,
      openedAt: TIMES.candidateIssued,
      closedAt: TIMES.candidateClosed,
      events: [
        f.candidateObserved.observation.events[0],
        classifyObserverRequest({ plan: f.candidate.plan, path: f.candidate.challenge.observer.denyPath, method: "POST",
          body: Buffer.from("agent-vigil-external-control-canary/v1\n"), observedAt: TIMES.candidateEvent }),
      ],
      signer: localGuardSigner(f.keys.observer.privatePath),
    });
    const denyHold = admit(f, { candidate: { route: f.candidateRoute, challenge: f.candidate.envelope, observation: denyObservation.envelope, isolation: f.candidateIsolation.envelope } });
    assert.equal(denyHold.admission.decision, "HOLD");
    assert.ok(denyHold.admission.reasonCodes.includes("CANDIDATE_OBSERVATION_NOT_PASS"));
    assert.ok(denyHold.admission.reasonCodes.includes("CANDIDATE_FORBIDDEN_OR_UNEXPECTED_EFFECT"));

    const stale = admit(f, { evaluatedAt: "2026-09-03T14:30:00.000Z", validUntil: "2026-09-03T15:00:00.000Z" });
    assert.equal(stale.admission.decision, "HOLD");
    assert.ok(stale.admission.reasonCodes.includes("CANDIDATE_OBSERVATION_NOT_FRESH"));

    const approved = admit(f);
    assert.throws(() => gateGuardControlAdmission({
      envelope: approved.envelope, publicKey: f.keys.admission.publicKey,
      expectedArtifactSha256: guardDigest("different-package"), expectedEnvironmentSha256: f.environmentSha256,
      asOf: "2026-09-03T14:10:00.000Z",
    }), /different artifact/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("all six trust roles must remain distinct", () => {
  const f = fixture();
  try {
    const result = buildGuardControlAdmission({
      current: { route: f.currentRoute, challenge: f.current.envelope, observation: f.currentObserved.envelope, isolation: f.currentIsolation.envelope },
      candidate: { route: f.candidateRoute, challenge: f.candidate.envelope, observation: f.candidateObserved.envelope, isolation: f.candidateIsolation.envelope },
      challengePublicKey: f.keys.challenge.publicKey,
      observerPublicKey: f.keys.observer.publicKey,
      routePublicKey: f.keys.route.publicKey,
      environmentPublicKey: f.keys.environment.publicKey,
      isolationPublicKey: f.keys.isolation.publicKey,
      admissionSigner: localGuardSigner(f.keys.challenge.privatePath),
      evaluatedAt: TIMES.evaluated,
      validUntil: TIMES.validUntil,
    });
    assert.equal(result.admission.decision, "HOLD");
    assert.ok(result.admission.reasonCodes.includes("TRUST_ROOTS_NOT_SEPARATED"));
    assert.equal(openGuardControlAdmission(result.envelope, f.keys.challenge.publicKey).admission.decision, "HOLD");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("candidate-controlled route evidence cannot pass without a separately signed isolation boundary", () => {
  const f = fixture();
  try {
    const { isolationHash: _isolationHash, ...candidateIsolation } = f.candidateIsolation.attestation;
    const forgedIsolation = signGuardControlIsolationAttestation({
      ...candidateIsolation,
      routeReceiptHash: guardDigest("candidate-forged-route"),
    }, localGuardSigner(f.keys.isolation.privatePath));
    const result = admit(f, { candidate: {
      route: f.candidateRoute,
      challenge: f.candidate.envelope,
      observation: f.candidateObserved.envelope,
      isolation: forgedIsolation.envelope,
    } });
    assert.equal(result.admission.decision, "HOLD");
    assert.ok(result.admission.reasonCodes.includes("CANDIDATE_ISOLATION_ROUTE_MISMATCH"));
    const { isolationHash: _invalidHash, ...invalidBoundary } = f.candidateIsolation.attestation;
    assert.throws(() => signGuardControlIsolationAttestation({
      ...invalidBoundary,
      boundary: { ...invalidBoundary.boundary, candidateUid: 0 },
    }, localGuardSigner(f.keys.isolation.privatePath)), /not production-grade/);
    assert.throws(() => buildGuardControlAdmission({
      current: { route: f.currentRoute, challenge: f.current.envelope, observation: f.currentObserved.envelope } as never,
      candidate: { route: f.candidateRoute, challenge: f.candidate.envelope, observation: f.candidateObserved.envelope } as never,
      challengePublicKey: f.keys.challenge.publicKey,
      observerPublicKey: f.keys.observer.publicKey,
      routePublicKey: f.keys.route.publicKey,
      environmentPublicKey: f.keys.environment.publicKey,
      isolationPublicKey: f.keys.isolation.publicKey,
      admissionSigner: localGuardSigner(f.keys.admission.privatePath),
      evaluatedAt: TIMES.evaluated,
      validUntil: TIMES.validUntil,
    }), /object/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("tampered challenges and expired or misbound admission decisions fail closed", () => {
  const f = fixture();
  try {
    const tamperedChallenge = structuredClone(f.candidate.envelope);
    const payload = JSON.parse(Buffer.from(tamperedChallenge.payload, "base64").toString("utf8"));
    payload.target.version = "2.1.999-substituted";
    tamperedChallenge.payload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    assert.throws(() => buildGuardControlAdmission({
      current: { route: f.currentRoute, challenge: f.current.envelope, observation: f.currentObserved.envelope, isolation: f.currentIsolation.envelope },
      candidate: { route: f.candidateRoute, challenge: tamperedChallenge, observation: f.candidateObserved.envelope, isolation: f.candidateIsolation.envelope },
      challengePublicKey: f.keys.challenge.publicKey,
      observerPublicKey: f.keys.observer.publicKey,
      routePublicKey: f.keys.route.publicKey,
      environmentPublicKey: f.keys.environment.publicKey,
      isolationPublicKey: f.keys.isolation.publicKey,
      admissionSigner: localGuardSigner(f.keys.admission.privatePath),
      evaluatedAt: TIMES.evaluated,
      validUntil: TIMES.validUntil,
    }), /signature is invalid/);

    const approved = admit(f);
    const { admissionHash: _hash, ...tooLong } = approved.admission;
    const excessive = signGuardControlAdmission({ ...tooLong, validUntil: "2026-09-03T15:06:00.001Z" }, localGuardSigner(f.keys.admission.privatePath));
    assert.throws(() => openGuardControlAdmission(excessive.envelope, f.keys.admission.publicKey), /at most one hour/);
    assert.throws(() => gateGuardControlAdmission({
      envelope: approved.envelope,
      publicKey: f.keys.admission.publicKey,
      expectedArtifactSha256: f.candidate.challenge.target.executableSha256,
      expectedEnvironmentSha256: f.environmentSha256,
      asOf: "2026-09-03T14:36:00.001Z",
    }), /not currently valid/);
    assert.throws(() => gateGuardControlAdmission({
      envelope: approved.envelope,
      publicKey: f.keys.admission.publicKey,
      expectedArtifactSha256: f.candidate.challenge.target.executableSha256,
      expectedEnvironmentSha256: guardDigest("substituted-environment"),
      asOf: "2026-09-03T14:10:00.000Z",
    }), /different environment/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("duplicate, malformed, and unexpected external effects cannot produce an observer PASS", () => {
  const f = fixture();
  try {
    const exact = f.candidateObserved.observation.events[0];
    const build = (events: typeof f.candidateObserved.observation.events) => buildGuardControlObservation({
      challenge: f.candidate.challenge,
      openedAt: TIMES.candidateIssued,
      closedAt: TIMES.candidateClosed,
      events,
      signer: localGuardSigner(f.keys.observer.privatePath),
    }).observation;
    const duplicate = build([exact, { ...exact, observedAt: "2026-09-03T14:04:31.000Z" }]);
    assert.equal(duplicate.status, "FAIL");
    assert.ok(duplicate.reasonCodes.includes("ALLOW_EFFECT_COUNT_MISMATCH"));

    const malformed = build([{ ...exact, method: "GET", bodySha256: guardDigest("wrong-body") }]);
    assert.equal(malformed.status, "FAIL");
    assert.ok(malformed.reasonCodes.includes("REQUEST_SHAPE_MISMATCH"));

    const unexpected = build([{ ...exact, route: "UNEXPECTED", pathSha256: guardDigest("/unrecognized") }]);
    assert.equal(unexpected.status, "FAIL");
    assert.ok(unexpected.reasonCodes.includes("UNEXPECTED_REQUEST_OBSERVED"));
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("managed-environment fixture remains internally signed", () => {
  const f = fixture();
  try { assert.equal(guardEnvironmentBindingHash(f.managedEnvironment), f.managedEnvironment.bindingHash); }
  finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("the CLI produces and enforces a real file-byte deployment gate", () => {
  const f = fixture();
  const files = {
    currentRoute: join(f.directory, "current-route.json"), currentChallenge: join(f.directory, "current-challenge.json"),
    currentObservation: join(f.directory, "current-observation.json"), candidateRoute: join(f.directory, "candidate-route.json"),
    candidateChallenge: join(f.directory, "candidate-challenge.json"), candidateObservation: join(f.directory, "candidate-observation.json"),
    currentIsolation: join(f.directory, "current-isolation.json"), candidateIsolation: join(f.directory, "candidate-isolation.json"),
    environmentPublic: join(f.directory, "environment-public.pem"), routePublic: join(f.directory, "route-public.pem"),
    challengePublic: join(f.directory, "challenge-public.pem"), observerPublic: join(f.directory, "observer-public.pem"),
    isolationPublic: join(f.directory, "isolation-public.pem"),
    admissionPublic: join(f.directory, "admission-public.pem"), admission: join(f.directory, "admission.json"),
    artifact: join(f.directory, "candidate-package.bin"),
  };
  const logs = { log: console.log, error: console.error };
  try {
    for (const [path, value] of [
      [files.currentRoute, f.currentRoute], [files.currentChallenge, f.current.envelope],
      [files.currentObservation, f.currentObserved.envelope], [files.candidateRoute, f.candidateRoute],
      [files.candidateChallenge, f.candidate.envelope], [files.candidateObservation, f.candidateObserved.envelope],
      [files.currentIsolation, f.currentIsolation.envelope], [files.candidateIsolation, f.candidateIsolation.envelope],
    ] as const) writeFileSync(path, `${JSON.stringify(value)}\n`);
    for (const [path, key] of [
      [files.environmentPublic, f.keys.environment.publicKey], [files.routePublic, f.keys.route.publicKey],
      [files.challengePublic, f.keys.challenge.publicKey], [files.observerPublic, f.keys.observer.publicKey],
      [files.isolationPublic, f.keys.isolation.publicKey],
      [files.admissionPublic, f.keys.admission.publicKey],
    ] as const) writeFileSync(path, key.export({ format: "pem", type: "spki" }));
    writeFileSync(files.artifact, "candidate-package");
    console.log = (() => undefined) as typeof console.log;
    console.error = (() => undefined) as typeof console.error;
    assert.equal(runGuardAdmissionCommand([
      "--current-route", files.currentRoute, "--current-challenge", files.currentChallenge, "--current-observation", files.currentObservation,
      "--current-isolation", files.currentIsolation,
      "--candidate-route", files.candidateRoute, "--candidate-challenge", files.candidateChallenge, "--candidate-observation", files.candidateObservation,
      "--candidate-isolation", files.candidateIsolation,
      "--environment-public-key", files.environmentPublic, "--route-public-key", files.routePublic,
      "--challenge-public-key", files.challengePublic, "--observer-public-key", files.observerPublic,
      "--isolation-public-key", files.isolationPublic,
      "--admission-key", f.keys.admission.privatePath, "--output", files.admission,
      "--evaluated-at", TIMES.evaluated, "--valid-until", TIMES.validUntil,
    ]), 0);
    assert.equal(runGuardDeployGateCommand([
      "--admission", files.admission, "--admission-public-key", files.admissionPublic,
      "--artifact", files.artifact, "--environment-sha256", f.environmentSha256,
      "--host", "claude", "--version", "2.1.246", "--as-of", "2026-09-03T14:10:00.000Z",
    ]), 0);
    assert.equal(runGuardDeployGateCommand([
      "--admission", files.admission, "--admission-public-key", files.admissionPublic,
      "--artifact", files.artifact, "--environment-sha256", f.environmentSha256,
      "--host", "claude", "--version", "2.1.999", "--as-of", "2026-09-03T14:10:00.000Z",
    ]), 1);
    writeFileSync(files.artifact, "tampered-package");
    assert.equal(runGuardDeployGateCommand([
      "--admission", files.admission, "--admission-public-key", files.admissionPublic,
      "--artifact", files.artifact, "--environment-sha256", f.environmentSha256,
      "--as-of", "2026-09-03T14:10:00.000Z",
    ]), 1);
  } finally {
    console.log = logs.log;
    console.error = logs.error;
    rmSync(f.directory, { recursive: true, force: true });
  }
});
