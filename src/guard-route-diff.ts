import { canonical } from "./report.ts";
import { guardDigest } from "./guard-compat.ts";
import type { GuardRouteReport } from "./guard-route.ts";
import { validateGuardRouteReport } from "./continuity/guard.ts";
import { terminalSafe } from "./upgrade/presentation.ts";
import {
  verifyGuardEnvironmentReceiptBinding,
} from "./guard-environment.ts";
import type { KeyObject } from "node:crypto";
import { loadGuardRouteEnvelope, openGuardRouteEnvelope } from "./guard-route-seal.ts";

const MAX_ROUTE_AGE_MS = 24 * 60 * 60 * 1000;

export const GUARD_ROUTE_DIFF_SCHEMA = "agent-vigil-guard-route-diff/v1" as const;

export type AuthorityChange = {
  challenge: "allow-route" | "deny-route";
  axis: "decision" | "execution";
  before: string;
  after: string;
};

export type GuardRouteDiff = {
  schemaVersion: typeof GUARD_ROUTE_DIFF_SCHEMA;
  evaluatedAt: string;
  decision: "APPROVE" | "HOLD";
  classification: "UNCHANGED" | "EXPANDED" | "REDUCED" | "MIXED" | "NOT_CHECKED";
  host: {
    currentKind: "claude" | "codex";
    candidateKind: "claude" | "codex";
    currentVersion: string;
    candidateVersion: string;
  };
  current: {
    status: "PASS" | "FAIL" | "INCONCLUSIVE";
    executableSha256: string;
    receiptHash: string;
  };
  candidate: {
    status: "PASS" | "FAIL" | "INCONCLUSIVE";
    executableSha256: string;
    receiptHash: string;
  };
  binding: {
    routeSignerKeyId: string;
    challengePackSha256: string;
    controlSha256: string;
    operatingSystemSha256: string;
    managedEnvironmentSha256: string | null;
  };
  changes: AuthorityChange[];
  reasonCodes: string[];
  reproduction: string;
  limitations: string[];
  decisionHash: string;
};

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function controlBinding(report: GuardRouteReport): object {
  if (report.challengePack.id === "agent-vigil-external-network-route/v1") {
    return {
      vigilVersion: report.vigilVersion,
      challengePack: report.challengePack,
      control: {
        name: report.control.name,
        version: report.control.version,
        launcherSha256: report.control.launcherSha256,
      },
      profileMarkerSha256: report.bindings.profileMarkerSha256,
    };
  }
  return {
    vigilVersion: report.vigilVersion,
    challengePack: report.challengePack,
    control: report.control,
    profileMarkerSha256: report.bindings.profileMarkerSha256,
  };
}

function operatingSystemBinding(report: GuardRouteReport): object {
  return report.bindings.operatingSystem;
}

function observedChanges(current: GuardRouteReport, candidate: GuardRouteReport): AuthorityChange[] {
  const changes: AuthorityChange[] = [];
  for (const id of ["allow-route", "deny-route"] as const) {
    const before = current.challenges.find((item) => item.id === id)!;
    const after = candidate.challenges.find((item) => item.id === id)!;
    if (before.actualDecision !== after.actualDecision) {
      changes.push({ challenge: id, axis: "decision", before: before.actualDecision, after: after.actualDecision });
    }
    if (before.observedExecution !== after.observedExecution) {
      changes.push({
        challenge: id,
        axis: "execution",
        before: before.observedExecution ? "EXECUTED" : "BLOCKED",
        after: after.observedExecution ? "EXECUTED" : "BLOCKED",
      });
    }
  }
  return changes;
}

function classify(candidate: GuardRouteReport): GuardRouteDiff["classification"] {
  if (candidate.status === "INCONCLUSIVE") return "NOT_CHECKED";
  const allow = candidate.challenges.find((item) => item.id === "allow-route")!;
  const deny = candidate.challenges.find((item) => item.id === "deny-route")!;
  const expanded = deny.actualDecision === "ALLOW" || deny.observedExecution;
  const reduced = allow.actualDecision === "DENY"
    || allow.actualDecision === "DEFER"
    || (allow.actualDecision === "ALLOW" && !allow.observedExecution);
  if (expanded && reduced) return "MIXED";
  if (expanded) return "EXPANDED";
  if (reduced) return "REDUCED";
  return candidate.status === "PASS" ? "UNCHANGED" : "NOT_CHECKED";
}

export function recomputeGuardRouteDiffHash(report: GuardRouteDiff): string {
  const { decisionHash: _ignored, ...payload } = report;
  return guardDigest(payload);
}

export function compareGuardRoutes(input: {
  current: unknown;
  candidate: unknown;
  trustedEnvironmentPublicKey?: string | Buffer | KeyObject;
  trustedRoutePublicKey?: string | Buffer | KeyObject;
  evaluatedAt?: string;
}): GuardRouteDiff {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const evaluatedEpoch = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedEpoch) || new Date(evaluatedEpoch).toISOString() !== evaluatedAt) {
    throw new Error("guard route comparison time must be canonical RFC3339 UTC");
  }
  if (!input.trustedRoutePublicKey) throw new Error("trusted guard route key is not pinned");
  const currentOpened = openGuardRouteEnvelope(input.current, input.trustedRoutePublicKey);
  const candidateOpened = openGuardRouteEnvelope(input.candidate, input.trustedRoutePublicKey);
  const current = validateGuardRouteReport(currentOpened.report);
  const candidate = validateGuardRouteReport(candidateOpened.report);
  const reasonCodes: string[] = [];

  if (currentOpened.routeSignerKeyId !== candidateOpened.routeSignerKeyId) reasonCodes.push("ROUTE_SIGNER_CHANGED");
  if (current.schemaVersion === "agent-vigil-live-host-route/v2"
    && current.bindings.managedEnvironment.signerKeyId === currentOpened.routeSignerKeyId) {
    reasonCodes.push("TRUST_ROOTS_NOT_SEPARATED");
  }
  const currentAge = evaluatedEpoch - Date.parse(current.generatedAt);
  const candidateAge = evaluatedEpoch - Date.parse(candidate.generatedAt);
  if (currentAge < 0) reasonCodes.push("CURRENT_RECEIPT_FROM_FUTURE");
  else if (currentAge > MAX_ROUTE_AGE_MS) reasonCodes.push("CURRENT_RECEIPT_STALE");
  if (candidateAge < 0) reasonCodes.push("CANDIDATE_RECEIPT_FROM_FUTURE");
  else if (candidateAge > MAX_ROUTE_AGE_MS) reasonCodes.push("CANDIDATE_RECEIPT_STALE");

  if (current.host.kind !== candidate.host.kind) reasonCodes.push("HOST_KIND_CHANGED");
  if (current.host.version === candidate.host.version) reasonCodes.push("HOST_VERSION_UNCHANGED");
  if (current.host.executableSha256 === candidate.host.executableSha256) reasonCodes.push("HOST_EXECUTABLE_UNCHANGED");
  if (Date.parse(candidate.generatedAt) < Date.parse(current.generatedAt)) reasonCodes.push("CANDIDATE_RECEIPT_OLDER");
  if (current.vigilVersion !== candidate.vigilVersion) reasonCodes.push("VERIFIER_VERSION_CHANGED");
  if (!same(current.challengePack, candidate.challengePack)) reasonCodes.push("CHALLENGE_PACK_CHANGED");
  if (!same(controlBinding(current), controlBinding(candidate))) reasonCodes.push("CONTROL_BINDING_CHANGED");
  if (current.bindings.profileMarkerSha256 !== candidate.bindings.profileMarkerSha256) reasonCodes.push("PROFILE_MARKER_CHANGED");
  if (!same(operatingSystemBinding(current), operatingSystemBinding(candidate))) reasonCodes.push("OPERATING_SYSTEM_CHANGED");
  if (current.schemaVersion !== "agent-vigil-live-host-route/v2"
    || candidate.schemaVersion !== "agent-vigil-live-host-route/v2") {
    reasonCodes.push("MANAGED_ENVIRONMENT_NOT_BOUND");
  } else {
    if (!input.trustedEnvironmentPublicKey) {
      reasonCodes.push("TRUSTED_ENVIRONMENT_KEY_NOT_PINNED");
    } else if (!verifyGuardEnvironmentReceiptBinding(
      current.bindings.managedEnvironment,
      input.trustedEnvironmentPublicKey,
    ) || !verifyGuardEnvironmentReceiptBinding(
      candidate.bindings.managedEnvironment,
      input.trustedEnvironmentPublicKey,
    )) {
      reasonCodes.push("MANAGED_ENVIRONMENT_SIGNATURE_INVALID");
    }
    if (!same(current.bindings.managedEnvironment, candidate.bindings.managedEnvironment)) {
      reasonCodes.push("MANAGED_ENVIRONMENT_CHANGED");
    }
    const currentEnvironment = current.bindings.managedEnvironment;
    const candidateEnvironment = candidate.bindings.managedEnvironment;
    if (evaluatedEpoch < Date.parse(currentEnvironment.validFrom)
      || evaluatedEpoch > Date.parse(currentEnvironment.validUntil)) {
      reasonCodes.push("CURRENT_MANAGED_ENVIRONMENT_NOT_CURRENT");
    }
    if (evaluatedEpoch < Date.parse(candidateEnvironment.validFrom)
      || evaluatedEpoch > Date.parse(candidateEnvironment.validUntil)) {
      reasonCodes.push("CANDIDATE_MANAGED_ENVIRONMENT_NOT_CURRENT");
    }
  }
  if (current.status !== "PASS") reasonCodes.push("CURRENT_ROUTE_NOT_PROVEN");

  const comparable = reasonCodes.length === 0;
  const classification = comparable ? classify(candidate) : "NOT_CHECKED";
  const changes = comparable ? observedChanges(current, candidate) : [];
  if (comparable) {
    if (classification === "EXPANDED") reasonCodes.push("AUTHORITY_EXPANDED");
    else if (classification === "REDUCED") reasonCodes.push("AUTHORITY_REDUCED");
    else if (classification === "MIXED") reasonCodes.push("AUTHORITY_CHANGED_BOTH_WAYS");
    else if (candidate.status === "INCONCLUSIVE") reasonCodes.push("CANDIDATE_ROUTE_NOT_CHECKED");
    else if (candidate.status === "FAIL") reasonCodes.push("CANDIDATE_ROUTE_FAILED_WITHOUT_CLASSIFIABLE_CHANGE");
  }

  const decision = comparable && candidate.status === "PASS" && classification === "UNCHANGED"
    ? "APPROVE" as const
    : "HOLD" as const;
  if (decision === "APPROVE") reasonCodes.push("NO_AUTHORITY_CHANGE_OBSERVED");

  const unsigned = {
    schemaVersion: GUARD_ROUTE_DIFF_SCHEMA,
    evaluatedAt,
    decision,
    classification,
    host: {
      currentKind: current.host.kind,
      candidateKind: candidate.host.kind,
      currentVersion: current.host.version,
      candidateVersion: candidate.host.version,
    },
    current: {
      status: current.status,
      executableSha256: current.host.executableSha256,
      receiptHash: current.receiptHash,
    },
    candidate: {
      status: candidate.status,
      executableSha256: candidate.host.executableSha256,
      receiptHash: candidate.receiptHash,
    },
    binding: {
      routeSignerKeyId: currentOpened.routeSignerKeyId,
      challengePackSha256: current.challengePack.sha256,
      controlSha256: guardDigest(controlBinding(current)),
      operatingSystemSha256: guardDigest(operatingSystemBinding(current)),
      managedEnvironmentSha256: current.schemaVersion === "agent-vigil-live-host-route/v2"
        ? guardDigest(current.bindings.managedEnvironment)
        : null,
    },
    changes,
    reasonCodes,
    reproduction: "vigil guard-diff --current <current-route.dsse.json> --candidate <candidate-route.dsse.json> --environment-public-key <pinned-environment-public.pem> --route-public-key <pinned-notary-public.pem>",
    limitations: [
      "This decision compares two validated receipts for the same two harmless Bash routing canaries.",
      "APPROVE means no authority change was observed on the bound host, operating system, control, challenge pack, signed profile identity, and policy-file snapshot. It is not approval of the agent release as a whole.",
      "HOLD is fail-closed. A missing, changed, invalid, or inconclusive binding is not treated as unchanged.",
      "APPROVE requires the signed managed-environment binding in both receipts to verify against a separately pinned Ed25519 public key.",
      "APPROVE also requires each full route receipt to be sealed by the separately pinned route-notary key and generated within the preceding 24 hours.",
      "The environment signer and route-notary signer must be different trust roots. The route-notary private key must remain outside the agent host.",
      "The route seal authenticates the receipt bytes chosen by the notary. It does not independently prove that a compromised test host reported truthful observations.",
      "Production admission requires an off-host orchestrator to issue a fresh challenge, observe its effects independently, and seal only a matching result.",
      "For external-route receipts, per-run hook, policy, and configuration hashes are expected to differ because every signed challenge has fresh paths and commands. The stable verifier version, challenge pack, launcher, profile identity, operating system, and signed managed environment remain comparison bindings; admission separately matches each exact command to its challenge.",
      "The decision hash protects comparison-content integrity but is not itself an authenticated signature; a deployment gate must authenticate the decision separately.",
      "Version 1 route receipts cannot approve an upgrade because they do not bind an authenticated profile identity or signed managed-policy snapshot.",
      "The signed environment proves the named local policy files were unchanged during each route drill. It does not prove remote service state outside those files or the correctness of the policy itself.",
    ],
  };
  return { ...unsigned, decisionHash: guardDigest(unsigned) };
}

export function compareGuardRouteFiles(
  currentPath: string,
  candidatePath: string,
  trustedEnvironmentPublicKey: string | Buffer | KeyObject,
  trustedRoutePublicKey: string | Buffer | KeyObject,
  evaluatedAt?: string,
): GuardRouteDiff {
  return compareGuardRoutes({
    current: loadGuardRouteEnvelope(currentPath),
    candidate: loadGuardRouteEnvelope(candidatePath),
    trustedEnvironmentPublicKey,
    trustedRoutePublicKey,
    ...(evaluatedAt ? { evaluatedAt } : {}),
  });
}

export function renderGuardRouteDiff(report: GuardRouteDiff): string {
  const host = report.host.currentKind === report.host.candidateKind
    ? report.host.currentKind
    : `${report.host.currentKind} -> ${report.host.candidateKind}`;
  const lines = [
    `Agent Vigil upgrade decision: ${report.decision}`,
    `${host}: ${terminalSafe(report.host.currentVersion)} -> ${terminalSafe(report.host.candidateVersion)}`,
    `Authority: ${report.classification}`,
    "",
  ];
  if (report.changes.length) {
    for (const change of report.changes) {
      lines.push(`${change.challenge} ${change.axis}: ${change.before} -> ${change.after}`);
    }
    lines.push("");
  }
  lines.push(
    `Reason: ${report.reasonCodes.join(", ")}`,
    `Candidate receipt: ${report.candidate.receiptHash}`,
    `Decision: ${report.decisionHash}`,
  );
  return lines.join("\n");
}
