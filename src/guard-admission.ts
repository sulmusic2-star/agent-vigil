import type { KeyObject } from "node:crypto";
import { guardDigest } from "./guard-compat.ts";
import {
  EXTERNAL_ROUTE_PACK,
  GUARD_CONTROL_ADMISSION_SCHEMA,
  openGuardControlChallenge,
  openGuardControlObservation,
  signGuardControlAdmission,
  type GuardControlChallenge,
  type GuardControlObservation,
} from "./guard-control-protocol.ts";
import { compareGuardRoutes, type GuardRouteDiff } from "./guard-route-diff.ts";
import { openGuardRouteEnvelope, type GuardRouteEnvelope } from "./guard-route-seal.ts";
import type { GuardSigner } from "./guard-signing.ts";
import type { GuardRouteReportV2 } from "./guard-route.ts";

const ADMISSION_LIFETIME_MS = 60 * 60 * 1000;
const MAX_OBSERVATION_TO_DECISION_MS = 15 * 60 * 1000;

export type GuardControlEvidenceBundle = {
  route: GuardRouteEnvelope;
  challenge: unknown;
  observation: unknown;
};

type PublicKeyValue = string | Buffer | KeyObject;

function pairReasonCodes(input: {
  label: "CURRENT" | "CANDIDATE";
  challenge: GuardControlChallenge;
  observation: GuardControlObservation;
  route: GuardRouteReportV2;
  evaluatedAt: string;
}): string[] {
  const { label, challenge, observation, route } = input;
  const reasons: string[] = [];
  const add = (reason: string) => reasons.push(`${label}_${reason}`);
  if (observation.challengeHash !== challenge.challengeHash) add("OBSERVATION_CHALLENGE_MISMATCH");
  if (observation.observerOriginSha256 !== guardDigest(challenge.observer.origin)) add("OBSERVER_ORIGIN_MISMATCH");
  if (observation.status !== "PASS") add("OBSERVATION_NOT_PASS");
  if (route.status !== "PASS") add("ROUTE_NOT_PASS");
  if (route.challengePack.id !== EXTERNAL_ROUTE_PACK || route.challengePack.sha256 !== challenge.pack.sha256) {
    add("CHALLENGE_PACK_MISMATCH");
  }
  if (route.nonce !== challenge.nonce) add("NONCE_MISMATCH");
  if (route.host.kind !== challenge.target.host || route.host.version !== challenge.target.version
    || route.host.executableSha256 !== challenge.target.executableSha256) add("ARTIFACT_MISMATCH");
  if (guardDigest(route.bindings.managedEnvironment) !== challenge.target.managedEnvironmentSha256) {
    add("ENVIRONMENT_MISMATCH");
  }
  const allow = route.challenges.filter((item) => item.id === "allow-route");
  const deny = route.challenges.filter((item) => item.id === "deny-route");
  if (allow.length !== 1 || allow[0].commandSha256 !== challenge.commands.allowSha256) add("ALLOW_COMMAND_MISMATCH");
  if (deny.length !== 1 || deny[0].commandSha256 !== challenge.commands.denySha256) add("DENY_COMMAND_MISMATCH");
  const observedAllow = observation.events.filter((event) => event.route === "ALLOW");
  if (observedAllow.length !== 1
    || observedAllow[0].pathSha256 !== guardDigest(challenge.observer.allowPath)
    || observedAllow[0].bodySha256 !== challenge.observer.bodySha256
    || observedAllow[0].method !== challenge.observer.method) add("ALLOW_EFFECT_MISMATCH");
  if (observation.events.some((event) => event.route !== "ALLOW")) add("FORBIDDEN_OR_UNEXPECTED_EFFECT");
  const issued = Date.parse(challenge.issuedAt);
  const expires = Date.parse(challenge.expiresAt);
  const opened = Date.parse(observation.openedAt);
  const closed = Date.parse(observation.closedAt);
  const generated = Date.parse(route.generatedAt);
  const evaluated = Date.parse(input.evaluatedAt);
  if (opened < issued || closed > expires || closed < opened) add("OBSERVATION_WINDOW_MISMATCH");
  if (generated < opened || generated > closed) add("ROUTE_OUTSIDE_OBSERVATION_WINDOW");
  if (observation.events.some((event) => Date.parse(event.observedAt) < opened || Date.parse(event.observedAt) > closed)) {
    add("EVENT_OUTSIDE_OBSERVATION_WINDOW");
  }
  if (evaluated < closed || evaluated - closed > MAX_OBSERVATION_TO_DECISION_MS) add("OBSERVATION_NOT_FRESH");
  return reasons;
}

export function buildGuardControlAdmission(input: {
  current: GuardControlEvidenceBundle;
  candidate: GuardControlEvidenceBundle;
  challengePublicKey: PublicKeyValue;
  observerPublicKey: PublicKeyValue;
  routePublicKey: PublicKeyValue;
  environmentPublicKey: PublicKeyValue;
  admissionSigner: GuardSigner;
  evaluatedAt?: string;
  validUntil?: string;
}): ReturnType<typeof signGuardControlAdmission> & { routeDecision: GuardRouteDiff } {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const evaluatedEpoch = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedEpoch) || new Date(evaluatedEpoch).toISOString() !== evaluatedAt) {
    throw new Error("control admission evaluation time must be canonical RFC3339 UTC");
  }
  const validUntil = input.validUntil ?? new Date(evaluatedEpoch + ADMISSION_LIFETIME_MS).toISOString();
  const validUntilEpoch = Date.parse(validUntil);
  if (!Number.isFinite(validUntilEpoch) || new Date(validUntilEpoch).toISOString() !== validUntil
    || validUntilEpoch <= evaluatedEpoch || validUntilEpoch - evaluatedEpoch > ADMISSION_LIFETIME_MS) {
    throw new Error("control admission validity must be greater than zero and at most one hour");
  }

  const currentChallenge = openGuardControlChallenge(input.current.challenge, input.challengePublicKey);
  const candidateChallenge = openGuardControlChallenge(input.candidate.challenge, input.challengePublicKey);
  const currentObservation = openGuardControlObservation(input.current.observation, input.observerPublicKey);
  const candidateObservation = openGuardControlObservation(input.candidate.observation, input.observerPublicKey);
  const currentRoute = openGuardRouteEnvelope(input.current.route, input.routePublicKey);
  const candidateRoute = openGuardRouteEnvelope(input.candidate.route, input.routePublicKey);
  const routeDecision = compareGuardRoutes({
    current: input.current.route,
    candidate: input.candidate.route,
    trustedEnvironmentPublicKey: input.environmentPublicKey,
    trustedRoutePublicKey: input.routePublicKey,
    evaluatedAt,
  });

  const reasonCodes = [
    ...pairReasonCodes({
      label: "CURRENT", challenge: currentChallenge.challenge, observation: currentObservation.observation,
      route: currentRoute.report, evaluatedAt,
    }),
    ...pairReasonCodes({
      label: "CANDIDATE", challenge: candidateChallenge.challenge, observation: candidateObservation.observation,
      route: candidateRoute.report, evaluatedAt,
    }),
  ];
  if (currentChallenge.signerKeyId !== candidateChallenge.signerKeyId) reasonCodes.push("CHALLENGE_SIGNER_CHANGED");
  if (currentObservation.signerKeyId !== candidateObservation.signerKeyId) reasonCodes.push("OBSERVER_SIGNER_CHANGED");
  if (currentRoute.routeSignerKeyId !== candidateRoute.routeSignerKeyId) reasonCodes.push("ROUTE_SIGNER_CHANGED");
  const environmentSignerKeyId = currentRoute.report.bindings.managedEnvironment.signerKeyId;
  if (environmentSignerKeyId !== candidateRoute.report.bindings.managedEnvironment.signerKeyId) {
    reasonCodes.push("ENVIRONMENT_SIGNER_CHANGED");
  }
  const roleKeys = [
    currentChallenge.signerKeyId,
    currentObservation.signerKeyId,
    currentRoute.routeSignerKeyId,
    environmentSignerKeyId,
    input.admissionSigner.keyId,
  ];
  if (new Set(roleKeys).size !== roleKeys.length) reasonCodes.push("TRUST_ROOTS_NOT_SEPARATED");
  if (routeDecision.decision !== "APPROVE") reasonCodes.push("ROUTE_DECISION_HOLD");
  if (!reasonCodes.length) reasonCodes.push("EXACT_CONTROL_ADMISSION_PROVEN");
  const decision = reasonCodes.length === 1 && reasonCodes[0] === "EXACT_CONTROL_ADMISSION_PROVEN"
    ? "APPROVE" as const
    : "HOLD" as const;
  const candidate = candidateChallenge.challenge;
  const signed = signGuardControlAdmission({
    schemaVersion: GUARD_CONTROL_ADMISSION_SCHEMA,
    evaluatedAt,
    validUntil,
    decision,
    artifact: {
      host: candidate.target.host,
      version: candidate.target.version,
      executableSha256: candidate.target.executableSha256,
    },
    environmentSha256: candidate.target.managedEnvironmentSha256,
    evidence: {
      current: {
        challengeHash: currentChallenge.challenge.challengeHash,
        observationHash: currentObservation.observation.observationHash,
        routeReceiptHash: currentRoute.report.receiptHash,
      },
      candidate: {
        challengeHash: candidateChallenge.challenge.challengeHash,
        observationHash: candidateObservation.observation.observationHash,
        routeReceiptHash: candidateRoute.report.receiptHash,
      },
      routeDecisionHash: routeDecision.decisionHash,
    },
    trust: {
      challengeSignerKeyId: currentChallenge.signerKeyId,
      observerSignerKeyId: currentObservation.signerKeyId,
      routeSignerKeyId: currentRoute.routeSignerKeyId,
      environmentSignerKeyId,
      admissionSignerKeyId: input.admissionSigner.keyId,
    },
    reasonCodes,
    limitations: [
      "APPROVE authenticates one exact candidate artifact, managed environment, route receipt, fresh challenge, external allow effect, absent deny effect, and unchanged paired control behavior against one current baseline.",
      "The observer independently proves that the allow endpoint was reached and that its deny endpoint was not reached during the signed window. It does not see local worker actions that never reach the observer.",
      "Deny-attempt and hook-routing evidence still depends on the isolated worker, host process, and route notary. A compromised worker operating system or collusion across separately pinned trust roots is outside this proof boundary.",
      "The admission is short-lived and artifact-specific. It does not prove publisher identity, complete security, production policy correctness, adoption, payment, or revenue.",
      "The deployment system must pin the admission public key and exact environment digest and must fail closed when this envelope is missing, invalid, expired, HOLD, or bound to another artifact.",
    ],
  }, input.admissionSigner);
  return { ...signed, routeDecision };
}
