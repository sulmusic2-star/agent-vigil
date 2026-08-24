import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendContinuityEvent, initializeContinuityChain, verifyContinuityChain } from "./chain.ts";
import { canonicalSha256, sha256, validateContinuityPolicy, type ContinuityEventDraft, type ContinuityRoot, type LoadedContinuityPolicy } from "./contracts.ts";
import { evaluateContinuity } from "./decision.ts";
import { importGitHubOutcome } from "./github.ts";
import { buildReport, type CheckResult } from "../report.ts";
import { generateSigningKey, publicKeyId, signReport } from "../signature.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "3".repeat(40);
const MERGE = "4".repeat(40);
const REVERT = "5".repeat(40);
const TIMES = [
  "2026-08-23T12:00:00.000Z",
  "2026-08-23T12:01:00.000Z",
  "2026-08-23T12:02:00.000Z",
  "2026-08-23T12:03:00.000Z",
  "2026-08-23T12:04:00.000Z",
];

export type ContinuityDemoResult = {
  schemaVersion: "agent-vigil-continuity-demo/v1";
  steps: Array<{
    step: number;
    evidence: string;
    result: "PASS" | "CURRENT" | "REVOKED";
    deployment: "not evaluated" | "allowed" | "stopped";
    explanation: string;
  }>;
  history: string[];
};

function event(root: ContinuityRoot, sequence: number, at: string): ContinuityEventDraft {
  const suffix = String(sequence).padStart(12, "0");
  return {
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: `urn:uuid:00000000-0000-4000-8000-${suffix}`,
    subject: root.subject,
    source: {
      kind: "verification",
      issuer: sha256(`demo-verifier-${sequence}`),
      evidenceHash: sha256(`demo-evidence-${sequence}`),
      deliveryIdHash: null,
    },
    event: {
      kind: "verification_refreshed",
      disposition: "affirm",
      reasonCode: "verification.passed",
      targetHash: sha256(`demo-verification-target-${sequence}`),
      freshUntil: "2026-08-23T13:00:00.000Z",
      supersedesEventId: null,
    },
    observedAt: at,
    effectiveAt: at,
    privacyTier: "receipt",
  };
}

function signedWebhook(path: string, payload: unknown, secret: string): { path: string; deliverySignature: string } {
  const bytes = Buffer.from(JSON.stringify(payload));
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    path,
    deliverySignature: `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`,
  };
}

export function runContinuityDemo(): ContinuityDemoResult {
  const directory = mkdtempSync(join(tmpdir(), "vigil-continuity-demo-"));
  try {
    const rootPrivate = join(directory, "root-private.pem");
    const rootPublic = join(directory, "root-public.pem");
    const repairPrivate = join(directory, "repair-private.pem");
    const repairPublic = join(directory, "repair-public.pem");
    generateSigningKey(rootPrivate, rootPublic);
    generateSigningKey(repairPrivate, repairPublic);
    const check: CheckResult = {
      claim: { kind: "tests_pass", quote: "the reviewed change passed", subject: "reviewed change" },
      verdict: "verified",
      evidence: "the required check completed",
    };
    const report = signReport(buildReport({
      transcript: "private/session.jsonl",
      transcriptSha256: sha256("private demonstration transcript"),
      transcriptFormat: "codex",
      repo: "/private/demonstration-repository",
      base: BASE,
      head: HEAD,
      results: [check],
      policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: sha256("demonstration receipt policy") },
      repository: { remote: "https://github.com/example/demonstration.git", tree: TREE },
      reproduction: "private demonstration command",
    }), rootPrivate);
    const receiptPath = join(directory, "receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    const chain = join(directory, "chain");
    const root = initializeContinuityChain(receiptPath, chain, new Date(TIMES[0]));
    const policyValue = validateContinuityPolicy({
      schemaVersion: "agent-vigil-continuity-policy/v1",
      requiredSources: ["verification", "github-outcome"],
      maxAgeSeconds: { verification: 3600, "github-outcome": 3600 },
      denyOn: ["revert_observed", "incident_linked", "attestation_invalid", "credential_revoked"],
      allowRemediation: true,
      requireSignedRoot: true,
      requireSignedEvents: false,
      trustedRootKeyIds: [publicKeyId(rootPublic)],
      trustedIssuerKeyIds: [publicKeyId(repairPublic)],
      protectedEnvironments: ["production"],
      maxClockSkewSeconds: 300,
    });
    const policy: LoadedContinuityPolicy = {
      value: policyValue,
      source: "built-in-demonstration-policy",
      sha256: canonicalSha256(policyValue),
    };
    const decide = (at: string) => evaluateContinuity(
      verifyContinuityChain(chain, { now: new Date(at), maxClockSkewSeconds: 300 }),
      policy,
      { now: new Date(at), environment: "production" },
    );

    appendContinuityEvent(chain, event(root, 1, TIMES[0]));
    const secret = "demonstration-only-webhook-secret";
    const secretPath = join(directory, "webhook-secret.txt");
    writeFileSync(secretPath, secret, { mode: 0o600 });
    const merge = signedWebhook(join(directory, "merge.json"), {
      action: "closed",
      repository: { full_name: "example/demonstration" },
      pull_request: {
        number: 14,
        state: "closed",
        merged: true,
        merged_at: TIMES[1],
        merge_commit_sha: MERGE,
        base: { sha: BASE },
        head: { sha: HEAD },
        labels: [],
      },
    }, secret);
    importGitHubOutcome({
      chain,
      eventPath: merge.path,
      deliveryId: "11111111-1111-4111-8111-111111111111",
      webhookSignature: merge.deliverySignature,
      webhookSecretPath: secretPath,
    });
    const current = decide(TIMES[1]);

    const revert = signedWebhook(join(directory, "revert.json"), {
      repository: { full_name: "example/demonstration" },
      after: REVERT,
      commits: [{ id: REVERT, message: `This reverts commit ${HEAD}`, timestamp: TIMES[2] }],
      head_commit: { timestamp: TIMES[2] },
    }, secret);
    const revokedRecord = importGitHubOutcome({
      chain,
      eventPath: revert.path,
      deliveryId: "22222222-2222-4222-8222-222222222222",
      webhookSignature: revert.deliverySignature,
      webhookSecretPath: secretPath,
    });
    const revoked = decide(TIMES[2]);

    appendContinuityEvent(chain, event(root, 2, TIMES[3]));
    const stillRevoked = decide(TIMES[3]);

    const repair: ContinuityEventDraft = {
      schemaVersion: "agent-vigil-continuity-event/v1",
      eventId: "urn:uuid:33333333-3333-4333-8333-333333333333",
      subject: root.subject,
      source: {
        kind: "verification",
        issuer: publicKeyId(repairPublic),
        evidenceHash: sha256("independent repair evidence"),
        deliveryIdHash: null,
      },
      event: {
        kind: "remediation_verified",
        disposition: "affirm",
        reasonCode: "repair.independently.verified",
        targetHash: sha256("verified repaired change"),
        freshUntil: "2026-08-23T13:04:00.000Z",
        supersedesEventId: revokedRecord.eventId,
      },
      observedAt: TIMES[4],
      effectiveAt: TIMES[4],
      privacyTier: "receipt",
    };
    appendContinuityEvent(chain, repair, repairPrivate);
    const restored = decide(TIMES[4]);

    if (current.continuity !== "CURRENT" || revoked.continuity !== "REVOKED"
      || stillRevoked.continuity !== "REVOKED" || restored.continuity !== "CURRENT") {
      throw new Error("the continuity demonstration did not reach its required states");
    }
    return {
      schemaVersion: "agent-vigil-continuity-demo/v1",
      steps: [
        { step: 1, evidence: "Original change check", result: "PASS", deployment: "not evaluated", explanation: "The change passed its original check." },
        { step: 2, evidence: "Verified merge and a fresh check", result: "CURRENT", deployment: "allowed", explanation: "The required records are present and current." },
        { step: 3, evidence: "Authenticated revert", result: "REVOKED", deployment: "stopped", explanation: "The revert contradicts the earlier approval." },
        { step: 4, evidence: "Later ordinary green check", result: "REVOKED", deployment: "stopped", explanation: "A later green check does not erase the recorded revert." },
        { step: 5, evidence: "Independent signed repair check", result: "CURRENT", deployment: "allowed", explanation: "Independent repair evidence closes the exact revocation." },
      ],
      history: verifyContinuityChain(chain).events.map((item) => item.event.kind),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function renderContinuityDemo(result: ContinuityDemoResult): string {
  return [
    "Agent Vigil continuity demonstration",
    "",
    ...result.steps.flatMap((step) => [
      `${step.step}. ${step.evidence}`,
      `   Result: ${step.result}`,
      `   Deployment: ${step.deployment}`,
      `   ${step.explanation}`,
      "",
    ]),
    "Complete history",
    ...result.history.map((kind, index) => `  ${index + 1}. ${kind.replaceAll("_", " ")}`),
  ].join("\n");
}
