import { recomputeGuardRouteReceiptHash, type GuardRouteReport } from "../guard-route.ts";
import { resolve } from "node:path";
import { canonicalSha256, readBoundedJson, validateEventDraft, type ContinuityEventDraft, type ContinuityRoot } from "./contracts.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID_URN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_GUARD_ROUTE_RECEIPT_BYTES = 1024 * 1024;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function text(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maximum || /\p{C}/u.test(value)) {
    throw new Error(`${label} must be safe non-empty text`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const selected = text(value, label, 71);
  if (!DIGEST.test(selected)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return selected;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const selected = text(value, label, 200) as T;
  if (!allowed.includes(selected)) throw new Error(`${label} is unsupported`);
  return selected;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function canonicalTimestamp(value: unknown, label: string): string {
  const selected = text(value, label, 40);
  const epoch = Date.parse(selected);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== selected) {
    throw new Error(`${label} must be canonical RFC3339 UTC`);
  }
  return selected;
}

function challenge(value: unknown, index: number): GuardRouteReport["challenges"][number] {
  const selected = record(value, `challenges[${index}]`);
  const optional = ["toolUseIdSha256", "sessionIdSha256"].filter((key) => key in selected);
  exactKeys(selected, [
    "id", "expectedDecision", "actualDecision", "expectedExecution", "observedExecution", "commandSha256", "passed", ...optional,
  ], `challenges[${index}]`);
  return {
    id: oneOf(selected.id, ["allow-route", "deny-route"] as const, `challenges[${index}].id`),
    expectedDecision: oneOf(selected.expectedDecision, ["ALLOW", "DENY"] as const, `challenges[${index}].expectedDecision`),
    actualDecision: oneOf(selected.actualDecision, ["ALLOW", "DENY", "DEFER", "ERROR", "UNKNOWN"] as const, `challenges[${index}].actualDecision`),
    expectedExecution: boolean(selected.expectedExecution, `challenges[${index}].expectedExecution`),
    observedExecution: boolean(selected.observedExecution, `challenges[${index}].observedExecution`),
    commandSha256: digest(selected.commandSha256, `challenges[${index}].commandSha256`),
    ...(selected.toolUseIdSha256 === undefined ? {} : { toolUseIdSha256: digest(selected.toolUseIdSha256, `challenges[${index}].toolUseIdSha256`) }),
    ...(selected.sessionIdSha256 === undefined ? {} : { sessionIdSha256: digest(selected.sessionIdSha256, `challenges[${index}].sessionIdSha256`) }),
    passed: boolean(selected.passed, `challenges[${index}].passed`),
  };
}

export function validateGuardRouteReport(value: unknown): GuardRouteReport {
  const selected = record(value, "live-host route receipt");
  exactKeys(selected, [
    "schemaVersion", "vigilVersion", "generatedAt", "nonce", "scope", "status", "deployment", "nextGate",
    "challengePack", "host", "control", "processConformance", "bindings", "challenges", "summary", "cleanup",
    "reproduction", "limitations", "receiptHash",
  ], "live-host route receipt");
  if (selected.schemaVersion !== "agent-vigil-live-host-route/v1" || selected.scope !== "LIVE_HOST_ROUTING") {
    throw new Error("unsupported live-host route receipt");
  }

  const deployment = record(selected.deployment, "deployment");
  exactKeys(deployment, ["state", "reasonCodes"], "deployment");
  if (deployment.state !== "HOLD" || !Array.isArray(deployment.reasonCodes) || !deployment.reasonCodes.length) {
    throw new Error("deployment must keep the live-host drill on HOLD with reason codes");
  }
  const reasonCodes = deployment.reasonCodes.map((item, index) => text(item, `deployment.reasonCodes[${index}]`, 200));
  if (new Set(reasonCodes).size !== reasonCodes.length) throw new Error("deployment reason codes must be unique");

  const nextGate = record(selected.nextGate, "nextGate");
  exactKeys(nextGate, ["state", "requirement"], "nextGate");
  if (nextGate.requirement !== "BOTH_CURRENT_HOSTS_MUST_PASS") throw new Error("live-host receipt has the wrong next gate");

  const challengePack = record(selected.challengePack, "challengePack");
  exactKeys(challengePack, ["id", "sha256"], "challengePack");
  if (challengePack.id !== "agent-vigil-harmless-live-host-route/v1") throw new Error("live-host receipt has the wrong challenge pack");

  const host = record(selected.host, "host");
  exactKeys(host, ["kind", "version", "executableSha256", "invocationSha256", "process"], "host");
  const process = record(host.process, "host.process");
  exactKeys(process, ["process", "exit", "output"], "host.process");

  const control = record(selected.control, "control");
  exactKeys(control, ["name", "version", "launcherSha256", "artifactSha256", "policySha256", "configurationSha256"], "control");
  if (control.name !== "Agent Vigil temporary route control" || control.version !== "1") {
    throw new Error("live-host receipt names an unsupported route control");
  }

  const conformance = record(selected.processConformance, "processConformance");
  exactKeys(conformance, ["status", "receiptHash"], "processConformance");

  const bindings = record(selected.bindings, "bindings");
  exactKeys(bindings, ["profileMarkerSha256", "operatingSystem"], "bindings");
  const operatingSystem = record(bindings.operatingSystem, "bindings.operatingSystem");
  exactKeys(operatingSystem, ["platform", "type", "release", "architecture", "machineIdentitySha256"], "bindings.operatingSystem");

  if (!Array.isArray(selected.challenges) || selected.challenges.length !== 2) throw new Error("live-host receipt must contain two challenges");
  const challenges = selected.challenges.map(challenge) as GuardRouteReport["challenges"];
  if (challenges[0].id !== "allow-route" || challenges[1].id !== "deny-route") {
    throw new Error("live-host challenges must be ordered allow then deny");
  }
  if (challenges[0].expectedDecision !== "ALLOW" || !challenges[0].expectedExecution
    || challenges[1].expectedDecision !== "DENY" || challenges[1].expectedExecution) {
    throw new Error("live-host challenge expectations are invalid");
  }
  if (challenges[0].commandSha256 === challenges[1].commandSha256) {
    throw new Error("live-host allow and deny challenges must use distinct commands");
  }

  const summary = record(selected.summary, "summary");
  exactKeys(summary, ["passed", "total", "routedCalls", "unexpectedCalls"], "summary");
  const passed = integer(summary.passed, "summary.passed", 2);
  if (summary.total !== 2 || passed !== challenges.filter((item) => item.passed).length) {
    throw new Error("live-host summary does not match its challenges");
  }

  const cleanup = record(selected.cleanup, "cleanup");
  exactKeys(cleanup, ["temporaryConfigurationRemoved", "ordinaryConfigurationUnchanged", "disposableProfileRemoval"], "cleanup");
  if (cleanup.disposableProfileRemoval !== "OPERATOR_REQUIRED") throw new Error("live-host receipt has an unsupported profile-removal claim");

  const limitations = selected.limitations;
  if (!Array.isArray(limitations) || !limitations.length) throw new Error("live-host receipt must state its limitations");
  const status = oneOf(selected.status, ["PASS", "FAIL", "INCONCLUSIVE"] as const, "status");
  const validated: GuardRouteReport = {
    schemaVersion: "agent-vigil-live-host-route/v1",
    vigilVersion: text(selected.vigilVersion, "vigilVersion", 200),
    generatedAt: canonicalTimestamp(selected.generatedAt, "generatedAt"),
    nonce: text(selected.nonce, "nonce", 128),
    scope: "LIVE_HOST_ROUTING",
    status,
    deployment: { state: "HOLD", reasonCodes },
    nextGate: {
      state: oneOf(nextGate.state, ["ONE_HOST_PROVEN", "BLOCKED"] as const, "nextGate.state"),
      requirement: "BOTH_CURRENT_HOSTS_MUST_PASS",
    },
    challengePack: { id: "agent-vigil-harmless-live-host-route/v1", sha256: digest(challengePack.sha256, "challengePack.sha256") },
    host: {
      kind: oneOf(host.kind, ["claude", "codex"] as const, "host.kind"),
      version: text(host.version, "host.version", 200),
      executableSha256: digest(host.executableSha256, "host.executableSha256"),
      invocationSha256: digest(host.invocationSha256, "host.invocationSha256"),
      process: {
        process: oneOf(process.process, ["EXITED", "TIMED_OUT", "SPAWN_ERROR", "SIGNALED", "OUTPUT_LIMIT"] as const, "host.process.process"),
        exit: oneOf(process.exit, ["ZERO", "NONZERO", "NONE"] as const, "host.process.exit"),
        output: oneOf(process.output, ["EMPTY", "TEXT", "JSON", "INVALID_JSON", "UNREADABLE"] as const, "host.process.output"),
      },
    },
    control: {
      name: "Agent Vigil temporary route control",
      version: "1",
      launcherSha256: digest(control.launcherSha256, "control.launcherSha256"),
      artifactSha256: digest(control.artifactSha256, "control.artifactSha256"),
      policySha256: digest(control.policySha256, "control.policySha256"),
      configurationSha256: digest(control.configurationSha256, "control.configurationSha256"),
    },
    processConformance: {
      status: oneOf(conformance.status, ["PASS", "FAIL", "INCONCLUSIVE"] as const, "processConformance.status"),
      receiptHash: digest(conformance.receiptHash, "processConformance.receiptHash"),
    },
    bindings: {
      profileMarkerSha256: digest(bindings.profileMarkerSha256, "bindings.profileMarkerSha256"),
      operatingSystem: {
        platform: text(operatingSystem.platform, "bindings.operatingSystem.platform", 100) as NodeJS.Platform,
        type: text(operatingSystem.type, "bindings.operatingSystem.type", 100),
        release: text(operatingSystem.release, "bindings.operatingSystem.release", 200),
        architecture: text(operatingSystem.architecture, "bindings.operatingSystem.architecture", 100),
        machineIdentitySha256: digest(operatingSystem.machineIdentitySha256, "bindings.operatingSystem.machineIdentitySha256"),
      },
    },
    challenges,
    summary: {
      passed,
      total: 2,
      routedCalls: integer(summary.routedCalls, "summary.routedCalls", 32),
      unexpectedCalls: integer(summary.unexpectedCalls, "summary.unexpectedCalls", 32),
    },
    cleanup: {
      temporaryConfigurationRemoved: boolean(cleanup.temporaryConfigurationRemoved, "cleanup.temporaryConfigurationRemoved"),
      ordinaryConfigurationUnchanged: boolean(cleanup.ordinaryConfigurationUnchanged, "cleanup.ordinaryConfigurationUnchanged"),
      disposableProfileRemoval: "OPERATOR_REQUIRED",
    },
    reproduction: text(selected.reproduction, "reproduction", 2_000),
    limitations: limitations.map((item, index) => text(item, `limitations[${index}]`, 2_000)),
    receiptHash: digest(selected.receiptHash, "receiptHash"),
  };

  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(validated.nonce)) throw new Error("live-host receipt nonce is invalid");
  if (recomputeGuardRouteReceiptHash(validated) !== validated.receiptHash) throw new Error("live-host receipt hash is invalid");
  const passShape = validated.processConformance.status === "PASS"
    && validated.host.process.process === "EXITED" && validated.host.process.exit === "ZERO"
    && validated.challenges.every((item) => item.passed)
    && validated.summary.passed === 2 && validated.summary.routedCalls === 2 && validated.summary.unexpectedCalls === 0
    && validated.cleanup.temporaryConfigurationRemoved && validated.cleanup.ordinaryConfigurationUnchanged;
  if ((validated.status === "PASS") !== passShape) throw new Error("live-host PASS does not match the observed evidence");
  if (validated.status === "PASS" && validated.nextGate.state !== "ONE_HOST_PROVEN") throw new Error("passing live-host receipt has the wrong next-gate state");
  if (validated.status !== "PASS" && validated.nextGate.state !== "BLOCKED") throw new Error("non-passing live-host receipt has the wrong next-gate state");
  const expectedReasonCodes = validated.status === "PASS"
    ? ["OTHER_HOST_ROUTE_NOT_PROVEN", "NON_DEPLOYING_DRILL"]
    : [
        "LIVE_HOST_ROUTE_NOT_PROVEN",
        ...(validated.processConformance.status === "PASS" ? [] : ["PROCESS_CONFORMANCE_NOT_PROVEN"]),
        ...(validated.summary.routedCalls === 0 && validated.host.process.exit !== "ZERO" ? ["HOST_UNAVAILABLE_BEFORE_ROUTE"] : []),
      ];
  if (JSON.stringify(validated.deployment.reasonCodes) !== JSON.stringify(expectedReasonCodes)) {
    throw new Error("live-host deployment reason codes do not match the observed evidence");
  }
  const challengeShape = validated.challenges.every((item) => {
    if (!item.passed) return true;
    if (!item.toolUseIdSha256 || !item.sessionIdSha256) return false;
    return item.id === "allow-route"
      ? item.actualDecision === "ALLOW" && item.observedExecution
      : item.actualDecision === "DENY" && !item.observedExecution;
  });
  if (!challengeShape) throw new Error("a passing live-host challenge lacks matching route evidence");
  if (validated.status === "PASS") {
    if (!validated.challenges.every((item) => item.toolUseIdSha256 && item.sessionIdSha256)
      || validated.challenges[0].toolUseIdSha256 === validated.challenges[1].toolUseIdSha256
      || validated.challenges[0].sessionIdSha256 !== validated.challenges[1].sessionIdSha256) {
      throw new Error("live-host PASS must contain two distinct calls from one host session");
    }
  }
  const noRouteBeforeHostFailure = validated.summary.routedCalls === 0 && validated.host.process.exit !== "ZERO";
  const expectedStatus = passShape
    ? "PASS"
    : validated.processConformance.status === "INCONCLUSIVE" || noRouteBeforeHostFailure
      ? "INCONCLUSIVE"
      : "FAIL";
  if (validated.status !== expectedStatus) throw new Error("live-host status does not match the observed evidence");
  return validated;
}

export function loadGuardRouteReport(path: string): GuardRouteReport {
  return validateGuardRouteReport(readBoundedJson(resolve(path), MAX_GUARD_ROUTE_RECEIPT_BYTES, "live-host route receipt"));
}

export function guardRouteBindingHash(value: unknown): string {
  const report = validateGuardRouteReport(value);
  return canonicalSha256({
    challengePack: report.challengePack,
    host: {
      kind: report.host.kind,
      version: report.host.version,
      executableSha256: report.host.executableSha256,
      invocationSha256: report.host.invocationSha256,
    },
    control: report.control,
    operatingSystem: report.bindings.operatingSystem,
  });
}

export function guardRouteContinuityEvent(input: {
  report: unknown;
  root: ContinuityRoot;
  eventId: string;
  issuer: string;
  observedAt?: string;
  freshUntil?: string;
  expectedBindingHash?: string;
}): ContinuityEventDraft {
  if (!UUID_URN.test(input.eventId)) throw new Error("guard-route eventId must be a lowercase UUID URN");
  const report = validateGuardRouteReport(input.report);
  const bindingHash = guardRouteBindingHash(report);
  const changedBinding = Boolean(input.expectedBindingHash) && digest(input.expectedBindingHash, "expectedBindingHash") !== bindingHash;
  const observedAt = input.observedAt === undefined ? report.generatedAt : canonicalTimestamp(input.observedAt, "observedAt");
  if (Date.parse(observedAt) < Date.parse(report.generatedAt)) {
    throw new Error("observedAt must not be earlier than the route receipt");
  }
  let disposition: ContinuityEventDraft["event"]["disposition"];
  let kind: ContinuityEventDraft["event"]["kind"];
  let reasonCode: string;
  if (changedBinding) {
    disposition = "revoke";
    kind = "verification_refreshed";
    reasonCode = "guard.route.binding.changed";
  } else if (report.status === "PASS") {
    disposition = "affirm";
    kind = "verification_refreshed";
    reasonCode = "guard.route.passed";
  } else if (report.status === "FAIL") {
    disposition = "revoke";
    kind = "verification_refreshed";
    reasonCode = "guard.route.failed";
  } else {
    disposition = "hold";
    kind = "coverage_gap";
    reasonCode = "guard.route.inconclusive";
  }
  const freshUntil = disposition === "affirm"
    ? canonicalTimestamp(input.freshUntil, "freshUntil")
    : null;
  if (freshUntil && Date.parse(freshUntil) <= Date.parse(observedAt)) throw new Error("freshUntil must be later than observedAt");
  return validateEventDraft({
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: input.eventId,
    subject: input.root.subject,
    source: {
      kind: `guard-route-${report.host.kind}`,
      issuer: digest(input.issuer, "issuer"),
      evidenceHash: report.receiptHash,
      deliveryIdHash: null,
    },
    event: {
      kind,
      disposition,
      reasonCode,
      targetHash: bindingHash,
      freshUntil,
      supersedesEventId: null,
    },
    observedAt,
    effectiveAt: observedAt,
    privacyTier: "receipt",
  });
}
