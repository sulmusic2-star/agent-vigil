import { createHash } from "node:crypto";
import { canonical } from "../report.ts";
import type { PublicCompatibilityEntry } from "./receipt.ts";
import { terminalSafe } from "./presentation.ts";

export const FLEET_POLICY_SCHEMA = "agent-vigil-fleet-policy/v1" as const;
export const FLEET_DECISION_SCHEMA = "agent-vigil-fleet-decision/v1" as const;

export type FleetPolicy = {
  schemaVersion: typeof FLEET_POLICY_SCHEMA;
  policyId: string;
  allowedPublisherKeyIds: string[];
  allowedComponents: Array<{ ecosystem: string; name: string }>;
  allowedRunnerImages: string[];
  allowedConfigSha256: string[];
  allowedCanaryHarnessSha256: string[];
  maxEvidenceAgeHours: number;
  minimumCanaries: number;
};

export type FleetDeploymentIntent = {
  currentVersion: string;
  candidateVersion: string;
  currentArtifactSha256: string;
  candidateArtifactSha256: string;
};

export type FleetDecision = {
  schemaVersion: typeof FLEET_DECISION_SCHEMA;
  evaluatedAt: string;
  policyId: string;
  policySha256: string;
  entryHash: string;
  component: { ecosystem: string; name: string; currentVersion: string; candidateVersion: string };
  deploymentIntent: FleetDeploymentIntent & { source: "trusted-caller" };
  status: "ALLOW" | "BLOCK";
  reasons: string[];
  decisionHash: string;
};

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function text(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0") || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stringList(value: unknown, label: string, maximum: number, validator: (item: unknown, index: number) => string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new Error(`${label} must contain from 1 to ${maximum} entries`);
  const result = value.map(validator);
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}

function sha256(value: unknown, label: string): string {
  return text(value, label, 71, /^sha256:[0-9a-f]{64}$/);
}

export function validateFleetPolicy(input: unknown): FleetPolicy {
  const root = record(input, "fleet policy");
  exactKeys(root, ["schemaVersion", "policyId", "allowedPublisherKeyIds", "allowedComponents", "allowedRunnerImages", "allowedConfigSha256", "allowedCanaryHarnessSha256", "maxEvidenceAgeHours", "minimumCanaries"], "fleet policy");
  if (root.schemaVersion !== FLEET_POLICY_SCHEMA) throw new Error(`fleet policy schemaVersion must be ${FLEET_POLICY_SCHEMA}`);
  if (!Array.isArray(root.allowedComponents) || root.allowedComponents.length < 1 || root.allowedComponents.length > 256) {
    throw new Error("allowedComponents must contain from 1 to 256 entries");
  }
  const allowedComponents = root.allowedComponents.map((item, index) => {
    const component = record(item, `allowedComponents[${index}]`);
    exactKeys(component, ["ecosystem", "name"], `allowedComponents[${index}]`);
    return {
      ecosystem: text(component.ecosystem, `allowedComponents[${index}].ecosystem`, 80, /^[a-z0-9][a-z0-9._-]*$/),
      name: text(component.name, `allowedComponents[${index}].name`, 160, /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/),
    };
  });
  if (new Set(allowedComponents.map((item) => `${item.ecosystem}:${item.name}`)).size !== allowedComponents.length) {
    throw new Error("allowedComponents must not contain duplicates");
  }
  if (!Number.isInteger(root.maxEvidenceAgeHours) || Number(root.maxEvidenceAgeHours) < 1 || Number(root.maxEvidenceAgeHours) > 8_760) {
    throw new Error("maxEvidenceAgeHours must be an integer from 1 to 8760");
  }
  if (!Number.isInteger(root.minimumCanaries) || Number(root.minimumCanaries) < 1 || Number(root.minimumCanaries) > 32) {
    throw new Error("minimumCanaries must be an integer from 1 to 32");
  }
  return {
    schemaVersion: FLEET_POLICY_SCHEMA,
    policyId: text(root.policyId, "policyId", 128, /^[a-z0-9][a-z0-9._-]*$/),
    allowedPublisherKeyIds: stringList(root.allowedPublisherKeyIds, "allowedPublisherKeyIds", 32, (item, index) => sha256(item, `allowedPublisherKeyIds[${index}]`)),
    allowedComponents,
    allowedRunnerImages: stringList(root.allowedRunnerImages, "allowedRunnerImages", 32, (item, index) => sha256(item, `allowedRunnerImages[${index}]`)),
    allowedConfigSha256: stringList(root.allowedConfigSha256, "allowedConfigSha256", 64, (item, index) => sha256(item, `allowedConfigSha256[${index}]`)),
    allowedCanaryHarnessSha256: stringList(root.allowedCanaryHarnessSha256, "allowedCanaryHarnessSha256", 64, (item, index) => sha256(item, `allowedCanaryHarnessSha256[${index}]`)),
    maxEvidenceAgeHours: Number(root.maxEvidenceAgeHours),
    minimumCanaries: Number(root.minimumCanaries),
  };
}

export function validateFleetDeploymentIntent(input: unknown): FleetDeploymentIntent {
  const root = record(input, "fleet deployment intent");
  exactKeys(root, ["currentVersion", "candidateVersion", "currentArtifactSha256", "candidateArtifactSha256"], "fleet deployment intent");
  return {
    currentVersion: text(root.currentVersion, "fleet deployment intent currentVersion", 128),
    candidateVersion: text(root.candidateVersion, "fleet deployment intent candidateVersion", 128),
    currentArtifactSha256: sha256(root.currentArtifactSha256, "fleet deployment intent currentArtifactSha256"),
    candidateArtifactSha256: sha256(root.candidateArtifactSha256, "fleet deployment intent candidateArtifactSha256"),
  };
}

function decisionPayload(value: Omit<FleetDecision, "decisionHash">): string {
  return canonical(value);
}

export function enforceFleetPolicy(input: {
  policy: FleetPolicy;
  entry: PublicCompatibilityEntry;
  /**
   * Exact deployment state supplied independently by the trusted caller.
   * It must never be derived from the compatibility entry being evaluated.
   */
  deploymentIntent: FleetDeploymentIntent;
  evaluatedAt?: string;
}): FleetDecision {
  const policy = validateFleetPolicy(input.policy);
  const deploymentIntent = validateFleetDeploymentIntent(input.deploymentIntent);
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const evaluatedMilliseconds = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedMilliseconds) || new Date(evaluatedMilliseconds).toISOString() !== evaluatedAt) {
    throw new Error("fleet decision evaluatedAt must be an exact UTC ISO timestamp");
  }
  const reasons: string[] = [];
  if (deploymentIntent.currentVersion !== input.entry.component.currentVersion) {
    reasons.push("trusted deployment intent current version does not match signed entry");
  }
  if (deploymentIntent.candidateVersion !== input.entry.component.candidateVersion) {
    reasons.push("trusted deployment intent candidate version does not match signed entry");
  }
  if (deploymentIntent.currentArtifactSha256 !== input.entry.component.currentArtifactSha256) {
    reasons.push("trusted deployment intent current artifact SHA256 does not match signed entry");
  }
  if (deploymentIntent.candidateArtifactSha256 !== input.entry.component.candidateArtifactSha256) {
    reasons.push("trusted deployment intent candidate artifact SHA256 does not match signed entry");
  }
  if (input.entry.verdict !== "SAFE") reasons.push(`entry verdict is ${input.entry.verdict}; fleet policy requires SAFE`);
  if (!policy.allowedPublisherKeyIds.includes(input.entry.signature.keyId)) reasons.push("publisher key is not allowed by fleet policy");
  if (!policy.allowedComponents.some((item) => item.ecosystem === input.entry.component.ecosystem && item.name === input.entry.component.name)) {
    reasons.push("component is not allowed by fleet policy");
  }
  if (!policy.allowedRunnerImages.includes(input.entry.runner.imageDigest)) reasons.push("runner image is not allowed by fleet policy");
  if (!policy.allowedConfigSha256.includes(input.entry.runner.configSha256)) reasons.push("configuration is not allowed by fleet policy");
  if (!policy.allowedCanaryHarnessSha256.includes(input.entry.runner.canaryHarnessSha256)) reasons.push("canary harness is not allowed by fleet policy");
  if (input.entry.canaries.length < policy.minimumCanaries) reasons.push("entry has fewer canaries than fleet policy requires");
  const ageHours = (evaluatedMilliseconds - Date.parse(input.entry.generatedAt)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0) reasons.push("entry timestamp is in the future or invalid");
  else if (ageHours > policy.maxEvidenceAgeHours) reasons.push("entry is older than fleet policy permits");
  const value = {
    schemaVersion: FLEET_DECISION_SCHEMA,
    evaluatedAt,
    policyId: policy.policyId,
    policySha256: hash(canonical(policy)),
    entryHash: input.entry.entryHash,
    component: {
      ecosystem: input.entry.component.ecosystem,
      name: input.entry.component.name,
      currentVersion: input.entry.component.currentVersion,
      candidateVersion: input.entry.component.candidateVersion,
    },
    deploymentIntent: { source: "trusted-caller", ...deploymentIntent },
    status: reasons.length ? "BLOCK" : "ALLOW",
    reasons: reasons.length ? reasons : ["signed exact-pair evidence matches trusted deployment intent and satisfies every fleet policy constraint"],
  } satisfies Omit<FleetDecision, "decisionHash">;
  return { ...value, decisionHash: hash(decisionPayload(value)) };
}

export function renderFleetDecision(value: FleetDecision): string {
  const lines = [
    `Agent Vigil fleet gate: ${value.status}`,
    `  evidence: ${terminalSafe(value.component.name)} ${terminalSafe(value.component.currentVersion)} -> ${terminalSafe(value.component.candidateVersion)}`,
    `  intent:   ${terminalSafe(value.deploymentIntent.currentVersion)} -> ${terminalSafe(value.deploymentIntent.candidateVersion)}`,
    `  artifacts: ${terminalSafe(value.deploymentIntent.currentArtifactSha256)} -> ${terminalSafe(value.deploymentIntent.candidateArtifactSha256)}`,
    `  policy: ${terminalSafe(value.policyId)}`,
  ];
  for (const reason of value.reasons) lines.push(`  ${value.status === "ALLOW" ? "✓" : "!"} ${terminalSafe(reason)}`);
  lines.push(`  ${value.decisionHash}`);
  return `${lines.join("\n")}\n`;
}
