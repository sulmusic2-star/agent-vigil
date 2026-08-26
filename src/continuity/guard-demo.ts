import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, type CheckResult } from "../report.ts";
import { recomputeGuardRouteReceiptHash, type GuardRouteReport } from "../guard-route.ts";
import { generateSigningKey, publicKeyId, signReport } from "../signature.ts";
import { appendContinuityEvent, initializeContinuityChain, verifyContinuityChain } from "./chain.ts";
import {
  canonicalSha256,
  sha256,
  validateContinuityPolicy,
  validateEventDraft,
  type ContinuityEventDraft,
  type ContinuityRoot,
  type LoadedContinuityPolicy,
} from "./contracts.ts";
import { evaluateContinuity, type ContinuityDecision } from "./decision.ts";
import { guardRouteBindingHash, guardRouteContinuityEvent, validateGuardRouteReport } from "./guard.ts";

const BASE = "6".repeat(40);
const HEAD = "7".repeat(40);
const TREE = "8".repeat(40);

type DemonstrationStep = {
  step: number;
  evidence: string;
  result: "CURRENT" | "REVOKED";
  deployment: "allowed" | "stopped";
  explanation: string;
};

export type GuardContinuityDemoResult = {
  schemaVersion: "agent-vigil-guard-continuity-demo/v1";
  routes: Array<{
    host: "claude" | "codex";
    version: string;
    status: "PASS";
    receiptHash: string;
    bindingHash: string;
  }>;
  controlledFailure: {
    controlledFixture: true;
    realIncident: false;
    host: "claude";
    reasonCode: "guard.route.failed";
  };
  steps: DemonstrationStep[];
  history: Array<{
    sequence: number;
    source: string;
    kind: string;
    disposition: string;
  }>;
  limitations: string[];
};

function at(epoch: number): string {
  return new Date(epoch).toISOString();
}

function cloneReport(report: GuardRouteReport): GuardRouteReport {
  return structuredClone(report);
}

function controlledFailure(report: GuardRouteReport, generatedAt: string): GuardRouteReport {
  const failed = cloneReport(report);
  failed.generatedAt = generatedAt;
  failed.nonce = "controlled_failure_fixture_00000001";
  failed.status = "FAIL";
  failed.deployment.reasonCodes = ["LIVE_HOST_ROUTE_NOT_PROVEN"];
  failed.nextGate.state = "BLOCKED";
  failed.challenges[1] = {
    ...failed.challenges[1],
    observedExecution: true,
    passed: false,
  };
  failed.summary = { passed: 1, total: 2, routedCalls: 2, unexpectedCalls: 0 };
  failed.receiptHash = recomputeGuardRouteReceiptHash(failed);
  return validateGuardRouteReport(failed);
}

function laterPass(report: GuardRouteReport, generatedAt: string): GuardRouteReport {
  const passed = cloneReport(report);
  passed.generatedAt = generatedAt;
  passed.nonce = "ordinary_green_fixture_0000000001";
  passed.receiptHash = recomputeGuardRouteReceiptHash(passed);
  return validateGuardRouteReport(passed);
}

function repairEvent(input: {
  root: ContinuityRoot;
  issuer: string;
  supersedesEventId: string;
  targetHash: string;
  observedAt: string;
  freshUntil: string;
}): ContinuityEventDraft {
  return validateEventDraft({
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: "urn:uuid:90000000-0000-4000-8000-000000000005",
    subject: input.root.subject,
    source: {
      kind: "verification",
      issuer: input.issuer,
      evidenceHash: sha256("controlled guard-route repair verification"),
      deliveryIdHash: null,
    },
    event: {
      kind: "remediation_verified",
      disposition: "affirm",
      reasonCode: "repair.independently.verified",
      targetHash: input.targetHash,
      freshUntil: input.freshUntil,
      supersedesEventId: input.supersedesEventId,
    },
    observedAt: input.observedAt,
    effectiveAt: input.observedAt,
    privacyTier: "receipt",
  });
}

function decide(chain: string, policy: LoadedContinuityPolicy, now: string): ContinuityDecision {
  return evaluateContinuity(
    verifyContinuityChain(chain, { now: new Date(now), maxClockSkewSeconds: policy.value.maxClockSkewSeconds }),
    policy,
    { now: new Date(now), environment: "production" },
  );
}

export function runGuardContinuityDemo(input: { claudeRoute: unknown; codexRoute: unknown }): GuardContinuityDemoResult {
  const claude = validateGuardRouteReport(input.claudeRoute);
  const codex = validateGuardRouteReport(input.codexRoute);
  if (claude.host.kind !== "claude" || codex.host.kind !== "codex") {
    throw new Error("guard continuity demo requires one Claude receipt and one Codex receipt");
  }
  if (claude.status !== "PASS" || codex.status !== "PASS") {
    throw new Error("guard continuity demo requires PASS receipts from both supplied hosts");
  }
  if (canonicalSha256(claude.bindings.operatingSystem) !== canonicalSha256(codex.bindings.operatingSystem)) {
    throw new Error("guard continuity demo requires both host receipts from the same operating-system binding");
  }

  const directory = mkdtempSync(join(tmpdir(), "vigil-guard-continuity-demo-"));
  try {
    const verifierPrivate = join(directory, "verifier-private.pem");
    const verifierPublic = join(directory, "verifier-public.pem");
    const repairPrivate = join(directory, "repair-private.pem");
    const repairPublic = join(directory, "repair-public.pem");
    generateSigningKey(verifierPrivate, verifierPublic);
    generateSigningKey(repairPrivate, repairPublic);
    const verifier = publicKeyId(verifierPublic);
    const repairVerifier = publicKeyId(repairPublic);
    const check: CheckResult = {
      claim: { kind: "tests_pass", quote: "the guarded change passed", subject: "guarded change" },
      verdict: "verified",
      evidence: "the original deterministic check passed",
    };
    const report = signReport(buildReport({
      transcript: "local/demonstration.jsonl",
      transcriptSha256: sha256("guard continuity demonstration transcript"),
      transcriptFormat: "codex",
      repo: "/local/guard-continuity-demonstration",
      base: BASE,
      head: HEAD,
      results: [check],
      policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: sha256("guard continuity receipt policy") },
      repository: { remote: "https://github.com/example/guard-continuity.git", tree: TREE },
      reproduction: "local guard continuity demonstration",
    }), verifierPrivate);
    const receiptPath = join(directory, "receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

    const baseTime = Math.max(Date.parse(claude.generatedAt), Date.parse(codex.generatedAt));
    const times = [
      at(baseTime + 1_000),
      at(baseTime + 2_000),
      at(baseTime + 3_000),
      at(baseTime + 4_000),
      at(baseTime + 5_000),
    ];
    const freshUntil = at(baseTime + 60 * 60 * 1000);
    const chain = join(directory, "chain");
    const root = initializeContinuityChain(receiptPath, chain, new Date(baseTime));
    const policyValue = validateContinuityPolicy({
      schemaVersion: "agent-vigil-continuity-policy/v1",
      requiredSources: ["guard-route-claude", "guard-route-codex"],
      maxAgeSeconds: { "guard-route-claude": 3600, "guard-route-codex": 3600 },
      denyOn: ["attestation_invalid", "credential_revoked"],
      allowRemediation: true,
      requireSignedRoot: true,
      requireSignedEvents: true,
      trustedRootKeyIds: [verifier],
      trustedIssuerKeyIds: [verifier, repairVerifier],
      protectedEnvironments: ["production"],
      maxClockSkewSeconds: 300,
    });
    const policy: LoadedContinuityPolicy = {
      value: policyValue,
      source: "built-in-guard-continuity-demonstration-policy",
      sha256: canonicalSha256(policyValue),
    };

    const routeEvents = [
      guardRouteContinuityEvent({
        report: claude,
        root,
        eventId: "urn:uuid:90000000-0000-4000-8000-000000000001",
        issuer: verifier,
        observedAt: times[0],
        freshUntil,
      }),
      guardRouteContinuityEvent({
        report: codex,
        root,
        eventId: "urn:uuid:90000000-0000-4000-8000-000000000002",
        issuer: verifier,
        observedAt: times[1],
        freshUntil,
      }),
    ];
    for (const routeEvent of routeEvents) appendContinuityEvent(chain, routeEvent, verifierPrivate);
    const current = decide(chain, policy, times[1]);

    const failedReceipt = controlledFailure(claude, times[2]);
    const failedDraft = guardRouteContinuityEvent({
      report: failedReceipt,
      root,
      eventId: "urn:uuid:90000000-0000-4000-8000-000000000003",
      issuer: verifier,
      observedAt: times[2],
    });
    const failedEvent = appendContinuityEvent(chain, failedDraft, verifierPrivate);
    const revoked = decide(chain, policy, times[2]);

    const laterReceipt = laterPass(claude, times[3]);
    appendContinuityEvent(chain, guardRouteContinuityEvent({
      report: laterReceipt,
      root,
      eventId: "urn:uuid:90000000-0000-4000-8000-000000000004",
      issuer: verifier,
      observedAt: times[3],
      freshUntil,
      expectedBindingHash: guardRouteBindingHash(claude),
    }), verifierPrivate);
    const stillRevoked = decide(chain, policy, times[3]);

    appendContinuityEvent(chain, repairEvent({
      root,
      issuer: repairVerifier,
      supersedesEventId: failedEvent.eventId,
      targetHash: failedEvent.event.targetHash!,
      observedAt: times[4],
      freshUntil,
    }), repairPrivate);
    const restored = decide(chain, policy, times[4]);

    if (current.continuity !== "CURRENT" || revoked.continuity !== "REVOKED"
      || stillRevoked.continuity !== "REVOKED" || restored.continuity !== "CURRENT") {
      throw new Error("guard continuity demonstration did not reach its required states");
    }
    const verified = verifyContinuityChain(chain, { now: new Date(times[4]), maxClockSkewSeconds: 300 });
    return {
      schemaVersion: "agent-vigil-guard-continuity-demo/v1",
      routes: [claude, codex].map((route) => ({
        host: route.host.kind,
        version: route.host.version,
        status: "PASS" as const,
        receiptHash: route.receiptHash,
        bindingHash: guardRouteBindingHash(route),
      })),
      controlledFailure: {
        controlledFixture: true,
        realIncident: false,
        host: "claude",
        reasonCode: "guard.route.failed",
      },
      steps: [
        { step: 1, evidence: "Supplied Claude and Codex routes", result: "CURRENT", deployment: "allowed", explanation: "Both exact route receipts passed, and signed continuity events made both required sources current." },
        { step: 2, evidence: "Controlled fail-open fixture", result: "REVOKED", deployment: "stopped", explanation: "A controlled routing failure revoked the earlier permission." },
        { step: 3, evidence: "Later ordinary green route", result: "REVOKED", deployment: "stopped", explanation: "A later passing route did not erase the recorded failure." },
        { step: 4, evidence: "Independent signed repair", result: "CURRENT", deployment: "allowed", explanation: "A different trusted verifier repaired the exact revocation." },
      ],
      history: verified.events.map((item) => ({
        sequence: item.sequence,
        source: item.source.kind,
        kind: item.event.kind,
        disposition: item.event.disposition,
      })),
      limitations: [
        "The failure is a controlled fixture, not a real Claude, Codex, repository, deployment, or customer incident.",
        "The command validates the supplied versions and executable hashes but does not check online whether either host version is the vendor's latest release.",
        "The demonstration proves deterministic continuity state behavior for the supplied reduced receipts; it does not prove every host route, production safety, adoption, payment, or revenue.",
      ],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function renderGuardContinuityDemo(result: GuardContinuityDemoResult): string {
  return [
    "Agent Vigil guarded-host continuity demonstration",
    "",
    ...result.routes.map((route) => `${route.host} ${route.version}: ${route.status}`),
    "",
    ...result.steps.flatMap((step) => [
      `${step.step}. ${step.evidence}`,
      `   Result: ${step.result}`,
      `   Deployment: ${step.deployment}`,
      `   ${step.explanation}`,
      "",
    ]),
    "Complete history",
    ...result.history.map((event) => `  ${event.sequence}. ${event.source}: ${event.kind.replaceAll("_", " ")} (${event.disposition})`),
    "",
    "Limits",
    ...result.limitations.map((item) => `  - ${item}`),
  ].join("\n");
}
