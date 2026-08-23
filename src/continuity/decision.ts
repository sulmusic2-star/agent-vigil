import { canonicalSha256, validateProtectedEnvironment, type ContinuityEvent, type ContinuityPolicy, type ContinuityState, type LoadedContinuityPolicy } from "./contracts.ts";
import type { ChainVerification } from "./chain.ts";

export type ContinuityReason = {
  ruleId: string;
  disposition: "revoke" | "expire" | "hold" | "observe";
  eventId?: string;
  source?: string;
  message: string;
};

export type ContinuityOutcomeFact = {
  eventId: string;
  kind: "merged" | "deployed" | "reverted" | "hotfixed" | "incident_linked" | "no_known_event_through";
  observedAt: string;
};

export type ContinuityDecision = {
  schemaVersion: "agent-vigil-continuity-decision/v1";
  evaluatedAt: string;
  historicalVerification: "PASS" | "FAIL" | "INCONCLUSIVE";
  continuity: ContinuityState;
  allowsProtectedAction: boolean;
  protectedEnvironment: string | null;
  rootHash: string;
  chainTip: string;
  eventCount: number;
  policy: { sourceHash: string; sha256: string };
  outcomeFacts: ContinuityOutcomeFact[];
  reasons: ContinuityReason[];
  decisionHash: string;
};

function outcomeFact(event: ContinuityEvent): ContinuityOutcomeFact | undefined {
  const mapping: Partial<Record<ContinuityEvent["event"]["kind"], ContinuityOutcomeFact["kind"]>> = {
    merge_observed: "merged",
    deployment_observed: "deployed",
    revert_observed: "reverted",
    hotfix_observed: "hotfixed",
    incident_linked: "incident_linked",
  };
  const kind = mapping[event.event.kind]
    ?? (event.event.kind === "monitor_checkpoint" && event.event.reasonCode === "no_known_event_through" ? "no_known_event_through" : undefined);
  return kind ? { eventId: event.eventId, kind, observedAt: event.observedAt } : undefined;
}

function signedByTrustedIssuer(event: ContinuityEvent, policy: ContinuityPolicy): boolean {
  return Boolean(event.signature && policy.trustedIssuerKeyIds.includes(event.signature.keyId));
}

function linkedIncident(event: ContinuityEvent): boolean {
  return event.event.kind !== "incident_linked"
    || (event.source.kind === "github-outcome" && Boolean(event.source.deliveryIdHash) && Boolean(event.event.targetHash));
}

function sourceQualifies(event: ContinuityEvent): boolean {
  if (!new Set(["affirm", "observe"]).has(event.event.disposition)) return false;
  if (event.event.kind === "coverage_gap") return false;
  if (event.event.kind === "monitor_checkpoint" && event.event.reasonCode === "no_known_event_through") return false;
  if (new Set(["credential_revoked", "attestation_invalid", "revert_observed", "incident_linked"]).has(event.event.kind)) return false;
  return true;
}

export function evaluateContinuity(
  verification: ChainVerification,
  loadedPolicy: LoadedContinuityPolicy,
  options: { now?: Date; environment?: string } = {},
): ContinuityDecision {
  const now = options.now ?? new Date();
  const policy = loadedPolicy.value;
  const environment = options.environment === undefined ? undefined : validateProtectedEnvironment(options.environment);
  const reasons: ContinuityReason[] = [];
  const outcomeFacts = verification.events.map(outcomeFact).filter((item): item is ContinuityOutcomeFact => Boolean(item));
  let structuralRevocation = false;
  let expired = false;
  let held = false;

  if (!verification.valid) {
    structuralRevocation = true;
    reasons.push({ ruleId: "continuity-chain", disposition: "revoke", message: "the append-only chain failed structural verification" });
  }
  if (verification.root.historicalVerification === "FAIL") {
    structuralRevocation = true;
    reasons.push({ ruleId: "historical-verification", disposition: "revoke", message: "the original Agent Vigil receipt failed" });
  } else if (verification.root.historicalVerification === "INCONCLUSIVE") {
    held = true;
    reasons.push({ ruleId: "historical-verification", disposition: "hold", message: "the original Agent Vigil receipt was inconclusive" });
  }

  if (verification.rootSignature.present && !verification.rootSignature.valid) {
    structuralRevocation = true;
    reasons.push({ ruleId: "root-signature", disposition: "revoke", message: "the original receipt signature is invalid" });
  } else if (policy.requireSignedRoot && !verification.rootSignature.present) {
    held = true;
    reasons.push({ ruleId: "root-signature", disposition: "hold", message: "the protected policy requires a signed original receipt" });
  } else if (verification.rootSignature.present && !policy.trustedRootKeyIds.includes(verification.rootSignature.keyId ?? "")) {
    structuralRevocation = true;
    reasons.push({ ruleId: "root-signer-trust", disposition: "revoke", message: "the original receipt signer is not trusted by policy" });
  }

  if (environment && !policy.protectedEnvironments.includes(environment)) {
    held = true;
    reasons.push({ ruleId: "protected-environment", disposition: "hold", message: "the named environment is not covered by the protected policy" });
  }

  for (const event of verification.events) {
    if (event.signature && !policy.trustedIssuerKeyIds.includes(event.signature.keyId)) {
      structuralRevocation = true;
      reasons.push({ ruleId: "event-signer-trust", disposition: "revoke", eventId: event.eventId, message: "an event signer is not trusted by policy" });
    } else if (policy.requireSignedEvents && !event.signature) {
      held = true;
      reasons.push({ ruleId: "event-signature", disposition: "hold", eventId: event.eventId, message: "the protected policy requires every event to be signed" });
    }
  }

  const activeRevocations = new Map<string, ContinuityEvent>();
  for (const event of verification.events) {
    if (event.event.kind === "remediation_verified") {
      const target = event.event.supersedesEventId ? activeRevocations.get(event.event.supersedesEventId) : undefined;
      const fresh = Boolean(event.event.freshUntil) && Date.parse(event.event.freshUntil!) > now.getTime();
      const independent = Boolean(target) && target!.source.issuer !== event.source.issuer;
      const acceptable = policy.allowRemediation
        && event.event.disposition === "affirm"
        && event.source.kind === "verification"
        && Boolean(event.event.targetHash)
        && fresh
        && independent
        && signedByTrustedIssuer(event, policy);
      if (acceptable && target) {
        activeRevocations.delete(target.eventId);
        reasons.push({ ruleId: "remediation-verified", disposition: "observe", eventId: event.eventId, message: "fresh independent remediation superseded one recorded revocation" });
      } else {
        held = true;
        reasons.push({ ruleId: "remediation-incomplete", disposition: "hold", eventId: event.eventId, message: "a remediation event lacked fresh independent trusted verification" });
      }
      continue;
    }

    const denies = event.event.disposition === "revoke" || policy.denyOn.includes(event.event.kind);
    if (denies) {
      if (!linkedIncident(event)) {
        held = true;
        reasons.push({ ruleId: "incident-linkage", disposition: "hold", eventId: event.eventId, message: "an incident observation lacked explicit privacy-minimized GitHub linkage" });
      } else {
        activeRevocations.set(event.eventId, event);
      }
    }
    if (event.event.disposition === "hold" || event.event.kind === "coverage_gap") {
      held = true;
      reasons.push({
        ruleId: event.event.kind === "coverage_gap" ? "coverage-gap" : "event-hold",
        disposition: "hold",
        eventId: event.eventId,
        message: event.event.kind === "coverage_gap" ? "a required observer reported a coverage gap" : "an event explicitly held continuity",
      });
    }
  }

  if (activeRevocations.size) {
    for (const event of activeRevocations.values()) {
      reasons.push({ ruleId: "effective-revocation", disposition: "revoke", eventId: event.eventId, message: "a policy-denied event remains effective" });
    }
  }

  for (const source of policy.requiredSources) {
    const latest = [...verification.events].reverse().find((event) => event.source.kind === source && sourceQualifies(event));
    if (!latest) {
      held = true;
      reasons.push({ ruleId: "required-source", disposition: "hold", source, message: "a policy-required evidence source is missing" });
      continue;
    }
    const maximumAge = policy.maxAgeSeconds[source];
    if (!maximumAge) {
      held = true;
      reasons.push({ ruleId: "freshness-policy", disposition: "hold", source, message: "a required source has no declared freshness window" });
      continue;
    }
    const age = now.getTime() - Date.parse(latest.observedAt);
    if (age < -policy.maxClockSkewSeconds * 1000) {
      held = true;
      reasons.push({ ruleId: "source-clock", disposition: "hold", source, eventId: latest.eventId, message: "required evidence is implausibly future-dated" });
    } else if (age > maximumAge * 1000 || (latest.event.freshUntil && Date.parse(latest.event.freshUntil) <= now.getTime())) {
      expired = true;
      reasons.push({ ruleId: "source-expired", disposition: "expire", source, eventId: latest.eventId, message: "policy-required evidence is stale" });
    }
  }

  let continuity: ContinuityState;
  if (structuralRevocation || activeRevocations.size) continuity = "REVOKED";
  else if (expired) continuity = "EXPIRED";
  else if (held) continuity = "HOLD";
  else continuity = "CURRENT";

  const unsigned = {
    schemaVersion: "agent-vigil-continuity-decision/v1" as const,
    evaluatedAt: now.toISOString(),
    historicalVerification: verification.root.historicalVerification,
    continuity,
    allowsProtectedAction: continuity === "CURRENT",
    protectedEnvironment: environment ?? null,
    rootHash: verification.root.rootHash,
    chainTip: verification.chainTip,
    eventCount: verification.events.length,
    policy: { sourceHash: canonicalSha256(loadedPolicy.source), sha256: loadedPolicy.sha256 },
    outcomeFacts,
    reasons,
  };
  return { ...unsigned, decisionHash: canonicalSha256(unsigned) };
}
