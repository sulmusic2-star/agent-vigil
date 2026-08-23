export const ENTRY_SCHEMA = "agent-vigil-compatibility-entry/v1" as const;
export const RESOLUTION_SCHEMA = "agent-vigil-compatibility-resolution/v1" as const;
export const LIFECYCLE_SCHEMA = "agent-vigil-lifecycle-event/v1" as const;

export type Verdict = "SAFE" | "CHANGED" | "HOLD";

export type PublicSignature = {
  algorithm: "Ed25519";
  keyId: string;
  publicKey: string;
  value: string;
};

export type PublicCompatibilityEntry = {
  schemaVersion: typeof ENTRY_SCHEMA;
  vigilVersion: string;
  generatedAt: string;
  component: {
    ecosystem: string;
    name: string;
    currentVersion: string;
    candidateVersion: string;
    currentArtifactSha256: string;
    candidateArtifactSha256: string;
  };
  runner: {
    imageDigest: string;
    trials: number;
    localEndpoint: boolean;
    networkBlocked: boolean;
    readOnly: boolean;
    environmentIsolated: boolean;
    configSha256: string;
    canaryHarnessSha256: string;
  };
  verdict: Verdict;
  changedCapabilities: string[];
  canaries: Array<{
    publicId?: string;
    idSha256: string;
    current: "PASS" | "FAIL" | "HOLD";
    candidate: "PASS" | "FAIL" | "HOLD";
    matched: boolean;
  }>;
  privateReceiptCommitment: string;
  limitations: string[];
  entryHash: string;
  signature: PublicSignature;
};

export type CompatibilityResolution = {
  schemaVersion: typeof RESOLUTION_SCHEMA;
  vigilVersion: string;
  generatedAt: string;
  component: { ecosystem: string; name: string };
  broken: {
    entryHash: string;
    baselineVersion: string;
    brokenVersion: string;
    brokenArtifactSha256: string;
  };
  fixed: {
    entryHash: string;
    baselineVersion: string;
    fixedVersion: string;
    fixedArtifactSha256: string;
  };
  relation: "RESTORED_RECORDED_COMPATIBILITY";
  limitations: string[];
  resolutionHash: string;
  signature: PublicSignature;
};

export const EVENT_NAMES = [
  "distribution_exposure_recorded_v1",
  "integration_installed_v1",
  "update_plan_created_v1",
  "artifact_pair_materialized_v1",
  "preflight_started_v1",
  "preflight_completed_v1",
  "update_disposition_recorded_v1",
  "preflight_repeated_v1",
  "proof_contribution_opted_in_v1",
  "proof_artifact_generated_v1",
  "proof_published_v1",
  "proof_consumed_v1",
  "maintainer_packet_generated_v1",
  "maintainer_link_recorded_v1",
  "maintainer_resolution_recorded_v1",
  "shared_policy_enabled_v1",
  "required_gate_enabled_v1",
  "organization_pql_qualified_v1",
  "team_offer_shown_v1",
  "checkout_started_v1",
  "payment_succeeded_v1",
  "entitlement_activated_v1",
  "payment_failed_v1",
  "refund_issued_v1",
  "subscription_renewed_v1",
  "subscription_canceled_v1",
  "entitlement_expired_v1",
  "fleet_signal_qualified_v1",
  "support_case_opened_v1",
  "support_case_closed_v1",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const CHANNELS = [
  "apm",
  "skills",
  "agent-plugin",
  "github-action",
  "github-app",
  "proof-page",
  "badge",
  "registry-api",
  "mcp-registry",
  "maintainer-link",
  "direct",
  "internal",
] as const;

export type Channel = (typeof CHANNELS)[number];

export type LifecycleEvent = {
  schema_version: typeof LIFECYCLE_SCHEMA;
  event_id: string;
  event_name: EventName;
  event_day: string;
  release_version: string;
  channel: Channel;
  external: boolean;
  demo: boolean;
  entity_scope: "INDIVIDUAL_INSTALLATION" | "ORGANIZATION";
  installation_pseudo_id: string;
  organization_pseudo_id?: string;
  first_touch_ref_token?: string;
  activation_channel?: Channel;
  assisted_channels?: Channel[];
  public_component?: { ecosystem: string; name: string };
  opaque_pair_token?: string;
  artifact_class?: "manager-lock" | "archive" | "directory" | "container" | "plugin" | "skill" | "mcp-server" | "other";
  verdict?: Verdict;
  hold_reason_class?: "containment" | "identity" | "materialization" | "configuration" | "evidence" | "timeout" | "other";
  canary_count_bucket?: "0" | "1" | "2-3" | "4-7" | "8-16" | "17-32";
  duration_bucket?: "lt-1m" | "1-3m" | "3-7m" | "7-15m" | "gt-15m";
  disposition?: "APPLY" | "DEFER" | "RESTORE" | "NO_DECISION";
  shared_policy: boolean;
  required_gate: boolean;
  public_contribution: boolean;
  organization_context: boolean;
};

export type SanitizedLifecycleEvent = Omit<LifecycleEvent, "installation_pseudo_id" | "organization_pseudo_id"> & {
  installation_pseudo_hash: string;
  organization_pseudo_hash?: string;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]*$/;
const COMPONENT_ECOSYSTEM = /^[a-z0-9][a-z0-9._-]*$/;
const COMPONENT_NAME = /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/;
const PUBLIC_ID = /^[a-z0-9][a-z0-9._-]*$/;
const PSEUDONYM = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const REF_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const CAPABILITIES = new Set(["tools", "hooks", "mcpServers", "permissions", "skills", "agents", "commands", "dependencies", "other"]);
const CANARY_STATES = new Set(["PASS", "FAIL", "HOLD"]);
const VERDICTS = new Set<Verdict>(["SAFE", "CHANGED", "HOLD"]);
const EVENT_NAME_SET = new Set<string>(EVENT_NAMES);
const CHANNEL_SET = new Set<string>(CHANNELS);

export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields`);
}

function requiredKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing required fields`);
}

function boundedText(value: unknown, label: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}

function patternedText(value: unknown, label: string, pattern: RegExp, maximum: number, minimum = 1): string {
  const result = boundedText(value, label, maximum, minimum);
  if (!pattern.test(result)) throw new Error(`${label} has an unsupported value`);
  return result;
}

function sha256Text(value: unknown, label: string): string {
  return patternedText(value, label, SHA256, 71, 71);
}

function utcTimestamp(value: unknown, label: string): string {
  const result = boundedText(value, label, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new Error(`${label} must be an exact UTC timestamp`);
  }
  return result;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function signatureValue(input: unknown, label: string): PublicSignature {
  const value = object(input, label);
  exactKeys(value, ["algorithm", "keyId", "publicKey", "value"], label);
  requiredKeys(value, ["algorithm", "keyId", "publicKey", "value"], label);
  if (value.algorithm !== "Ed25519") throw new Error(`${label}.algorithm must be Ed25519`);
  return {
    algorithm: "Ed25519",
    keyId: sha256Text(value.keyId, `${label}.keyId`),
    publicKey: boundedText(value.publicKey, `${label}.publicKey`, 512),
    value: boundedText(value.value, `${label}.value`, 512),
  };
}

function uniqueStrings(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

export function validatePublicCompatibilityEntry(input: unknown): PublicCompatibilityEntry {
  const root = object(input, "compatibility entry");
  const rootKeys = ["schemaVersion", "vigilVersion", "generatedAt", "component", "runner", "verdict", "changedCapabilities", "canaries", "privateReceiptCommitment", "limitations", "entryHash", "signature"] as const;
  exactKeys(root, rootKeys, "compatibility entry");
  requiredKeys(root, rootKeys, "compatibility entry");
  if (root.schemaVersion !== ENTRY_SCHEMA) throw new Error("compatibility entry schema is unsupported");
  if (!VERDICTS.has(root.verdict as Verdict)) throw new Error("compatibility entry verdict is invalid");

  const component = object(root.component, "compatibility entry component");
  const componentKeys = ["ecosystem", "name", "currentVersion", "candidateVersion", "currentArtifactSha256", "candidateArtifactSha256"] as const;
  exactKeys(component, componentKeys, "compatibility entry component");
  requiredKeys(component, componentKeys, "compatibility entry component");

  const runner = object(root.runner, "compatibility entry runner");
  const runnerKeys = ["imageDigest", "trials", "localEndpoint", "networkBlocked", "readOnly", "environmentIsolated", "configSha256", "canaryHarnessSha256"] as const;
  exactKeys(runner, runnerKeys, "compatibility entry runner");
  requiredKeys(runner, runnerKeys, "compatibility entry runner");
  if (!Number.isInteger(runner.trials) || Number(runner.trials) < 2 || Number(runner.trials) > 5) {
    throw new Error("compatibility entry runner trials are invalid");
  }

  if (!Array.isArray(root.changedCapabilities) || root.changedCapabilities.length > 16
    || root.changedCapabilities.some((item) => typeof item !== "string" || !CAPABILITIES.has(item))) {
    throw new Error("compatibility entry changed capabilities are invalid");
  }
  const changedCapabilities = root.changedCapabilities as string[];
  uniqueStrings(changedCapabilities, "compatibility entry changed capabilities");

  if (!Array.isArray(root.canaries) || root.canaries.length > 32) throw new Error("compatibility entry canaries are invalid");
  const canaries = root.canaries.map((item, index) => {
    const canary = object(item, `compatibility entry canary ${index}`);
    exactKeys(canary, ["publicId", "idSha256", "current", "candidate", "matched"], `compatibility entry canary ${index}`);
    requiredKeys(canary, ["idSha256", "current", "candidate", "matched"], `compatibility entry canary ${index}`);
    if (!CANARY_STATES.has(String(canary.current)) || !CANARY_STATES.has(String(canary.candidate))) {
      throw new Error(`compatibility entry canary ${index} state is invalid`);
    }
    return {
      ...(canary.publicId === undefined ? {} : { publicId: patternedText(canary.publicId, `compatibility entry canary ${index} publicId`, PUBLIC_ID, 80) }),
      idSha256: sha256Text(canary.idSha256, `compatibility entry canary ${index} id`),
      current: canary.current as "PASS" | "FAIL" | "HOLD",
      candidate: canary.candidate as "PASS" | "FAIL" | "HOLD",
      matched: booleanValue(canary.matched, `compatibility entry canary ${index} matched`),
    };
  });
  uniqueStrings(canaries.map((item) => item.idSha256), "compatibility entry canary IDs");
  uniqueStrings(canaries.flatMap((item) => item.publicId === undefined ? [] : [item.publicId]), "compatibility entry public canary IDs");

  if (!Array.isArray(root.limitations) || root.limitations.length > 16
    || root.limitations.some((item) => typeof item !== "string" || item.length > 1_024 || item.includes("\0"))) {
    throw new Error("compatibility entry limitations are invalid");
  }

  const entry: PublicCompatibilityEntry = {
    schemaVersion: ENTRY_SCHEMA,
    vigilVersion: patternedText(root.vigilVersion, "compatibility entry vigilVersion", VERSION, 40),
    generatedAt: utcTimestamp(root.generatedAt, "compatibility entry generatedAt"),
    component: {
      ecosystem: patternedText(component.ecosystem, "compatibility entry ecosystem", COMPONENT_ECOSYSTEM, 80),
      name: patternedText(component.name, "compatibility entry component name", COMPONENT_NAME, 160),
      currentVersion: boundedText(component.currentVersion, "compatibility entry current version", 128),
      candidateVersion: boundedText(component.candidateVersion, "compatibility entry candidate version", 128),
      currentArtifactSha256: sha256Text(component.currentArtifactSha256, "compatibility entry current artifact"),
      candidateArtifactSha256: sha256Text(component.candidateArtifactSha256, "compatibility entry candidate artifact"),
    },
    runner: {
      imageDigest: sha256Text(runner.imageDigest, "compatibility entry image digest"),
      trials: Number(runner.trials),
      localEndpoint: booleanValue(runner.localEndpoint, "compatibility entry local endpoint"),
      networkBlocked: booleanValue(runner.networkBlocked, "compatibility entry network blocked"),
      readOnly: booleanValue(runner.readOnly, "compatibility entry read only"),
      environmentIsolated: booleanValue(runner.environmentIsolated, "compatibility entry environment isolated"),
      configSha256: sha256Text(runner.configSha256, "compatibility entry config"),
      canaryHarnessSha256: sha256Text(runner.canaryHarnessSha256, "compatibility entry canary harness"),
    },
    verdict: root.verdict as Verdict,
    changedCapabilities,
    canaries,
    privateReceiptCommitment: sha256Text(root.privateReceiptCommitment, "compatibility entry private receipt"),
    limitations: root.limitations as string[],
    entryHash: sha256Text(root.entryHash, "compatibility entry hash"),
    signature: signatureValue(root.signature, "compatibility entry signature"),
  };
  if (entry.component.currentVersion === entry.component.candidateVersion
    || entry.component.currentArtifactSha256 === entry.component.candidateArtifactSha256) {
    throw new Error("compatibility entry must compare distinct exact artifacts");
  }
  if (entry.verdict === "SAFE" && (!entry.runner.localEndpoint || !entry.runner.networkBlocked
    || !entry.runner.readOnly || !entry.runner.environmentIsolated || entry.canaries.length === 0
    || entry.changedCapabilities.length > 0
    || entry.canaries.some((item) => item.current !== "PASS" || item.candidate !== "PASS" || !item.matched))) {
    throw new Error("SAFE compatibility entry is inconsistent with its evidence");
  }
  return entry;
}

export function validateCompatibilityResolution(input: unknown): CompatibilityResolution {
  const root = object(input, "compatibility resolution");
  const rootKeys = ["schemaVersion", "vigilVersion", "generatedAt", "component", "broken", "fixed", "relation", "limitations", "resolutionHash", "signature"] as const;
  exactKeys(root, rootKeys, "compatibility resolution");
  requiredKeys(root, rootKeys, "compatibility resolution");
  if (root.schemaVersion !== RESOLUTION_SCHEMA || root.relation !== "RESTORED_RECORDED_COMPATIBILITY") {
    throw new Error("compatibility resolution schema or relation is unsupported");
  }
  const component = object(root.component, "compatibility resolution component");
  exactKeys(component, ["ecosystem", "name"], "compatibility resolution component");
  requiredKeys(component, ["ecosystem", "name"], "compatibility resolution component");
  const broken = object(root.broken, "compatibility resolution broken");
  exactKeys(broken, ["entryHash", "baselineVersion", "brokenVersion", "brokenArtifactSha256"], "compatibility resolution broken");
  requiredKeys(broken, ["entryHash", "baselineVersion", "brokenVersion", "brokenArtifactSha256"], "compatibility resolution broken");
  const fixed = object(root.fixed, "compatibility resolution fixed");
  exactKeys(fixed, ["entryHash", "baselineVersion", "fixedVersion", "fixedArtifactSha256"], "compatibility resolution fixed");
  requiredKeys(fixed, ["entryHash", "baselineVersion", "fixedVersion", "fixedArtifactSha256"], "compatibility resolution fixed");
  if (!Array.isArray(root.limitations) || root.limitations.length < 1 || root.limitations.length > 8
    || root.limitations.some((item) => typeof item !== "string" || item.length < 1 || item.length > 1_024 || item.includes("\0"))) {
    throw new Error("compatibility resolution limitations are invalid");
  }
  const resolution: CompatibilityResolution = {
    schemaVersion: RESOLUTION_SCHEMA,
    vigilVersion: boundedText(root.vigilVersion, "compatibility resolution vigilVersion", 40),
    generatedAt: utcTimestamp(root.generatedAt, "compatibility resolution generatedAt"),
    component: {
      ecosystem: patternedText(component.ecosystem, "compatibility resolution ecosystem", COMPONENT_ECOSYSTEM, 80),
      name: patternedText(component.name, "compatibility resolution component name", COMPONENT_NAME, 160),
    },
    broken: {
      entryHash: sha256Text(broken.entryHash, "compatibility resolution broken entry"),
      baselineVersion: boundedText(broken.baselineVersion, "compatibility resolution broken baseline", 128),
      brokenVersion: boundedText(broken.brokenVersion, "compatibility resolution broken version", 128),
      brokenArtifactSha256: sha256Text(broken.brokenArtifactSha256, "compatibility resolution broken artifact"),
    },
    fixed: {
      entryHash: sha256Text(fixed.entryHash, "compatibility resolution fixed entry"),
      baselineVersion: boundedText(fixed.baselineVersion, "compatibility resolution fixed baseline", 128),
      fixedVersion: boundedText(fixed.fixedVersion, "compatibility resolution fixed version", 128),
      fixedArtifactSha256: sha256Text(fixed.fixedArtifactSha256, "compatibility resolution fixed artifact"),
    },
    relation: "RESTORED_RECORDED_COMPATIBILITY",
    limitations: root.limitations as string[],
    resolutionHash: sha256Text(root.resolutionHash, "compatibility resolution hash"),
    signature: signatureValue(root.signature, "compatibility resolution signature"),
  };
  if (resolution.broken.baselineVersion !== resolution.fixed.baselineVersion
    || resolution.broken.entryHash === resolution.fixed.entryHash
    || resolution.broken.brokenVersion === resolution.fixed.fixedVersion
    || resolution.broken.brokenArtifactSha256 === resolution.fixed.fixedArtifactSha256) {
    throw new Error("compatibility resolution does not bind distinct broken and fixed evidence");
  }
  return resolution;
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = atob(value);
  if (btoa(decoded) !== value) throw new Error(`${label} must be canonical base64`);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function publicKeyIdFromBase64(publicKeyBase64: string): Promise<string> {
  return sha256(decodeCanonicalBase64(publicKeyBase64, "public key"));
}

export async function verifyDetachedEd25519(
  publicKeyBase64: string,
  signatureBase64: string,
  message: string,
): Promise<boolean> {
  try {
    const publicKey = decodeCanonicalBase64(publicKeyBase64, "public key");
    const signature = decodeCanonicalBase64(signatureBase64, "signature");
    if (signature.length !== 64) return false;
    const key = await crypto.subtle.importKey("spki", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function verifySignature(unsigned: unknown, expectedHash: string, signature: PublicSignature): Promise<boolean> {
  try {
    const actualHash = await sha256(canonical(unsigned));
    if (actualHash !== expectedHash) return false;
    const publicKey = decodeCanonicalBase64(signature.publicKey, "public key");
    const signatureBytes = decodeCanonicalBase64(signature.value, "signature");
    if (signatureBytes.length !== 64 || await sha256(publicKey) !== signature.keyId) return false;
    const key = await crypto.subtle.importKey("spki", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signatureBytes, new TextEncoder().encode(expectedHash));
  } catch {
    return false;
  }
}

export async function verifyPublicCompatibilityEntry(entry: PublicCompatibilityEntry): Promise<boolean> {
  const { entryHash: _entryHash, signature: _signature, ...unsigned } = entry;
  return verifySignature(unsigned, entry.entryHash, entry.signature);
}

export async function verifyCompatibilityResolution(resolution: CompatibilityResolution): Promise<boolean> {
  const { resolutionHash: _resolutionHash, signature: _signature, ...unsigned } = resolution;
  return verifySignature(unsigned, resolution.resolutionHash, resolution.signature);
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value)) throw new Error(`${label} is invalid`);
  return value as T;
}

export function validateLifecycleEvent(input: unknown): LifecycleEvent {
  const root = object(input, "lifecycle event");
  const keys = [
    "schema_version", "event_id", "event_name", "event_day", "release_version", "channel", "external", "demo", "entity_scope",
    "installation_pseudo_id", "organization_pseudo_id", "first_touch_ref_token", "activation_channel", "assisted_channels",
    "public_component", "opaque_pair_token", "artifact_class", "verdict", "hold_reason_class", "canary_count_bucket",
    "duration_bucket", "disposition", "shared_policy", "required_gate", "public_contribution", "organization_context",
  ] as const;
  exactKeys(root, keys, "lifecycle event");
  requiredKeys(root, ["schema_version", "event_id", "event_name", "event_day", "release_version", "channel", "external", "demo", "entity_scope", "installation_pseudo_id", "shared_policy", "required_gate", "public_contribution", "organization_context"], "lifecycle event");
  if (root.schema_version !== LIFECYCLE_SCHEMA) throw new Error("lifecycle event schema is unsupported");
  const eventName = enumValue<EventName>(root.event_name, EVENT_NAME_SET, "lifecycle event name");
  const channel = enumValue<Channel>(root.channel, CHANNEL_SET, "lifecycle event channel");
  if (root.entity_scope !== "INDIVIDUAL_INSTALLATION" && root.entity_scope !== "ORGANIZATION") {
    throw new Error("lifecycle entity scope is invalid");
  }
  const organizationContext = booleanValue(root.organization_context, "lifecycle organization context");
  if ((root.entity_scope === "ORGANIZATION") !== organizationContext) {
    throw new Error("lifecycle organization context must match entity scope");
  }
  const organizationPseudoId = root.organization_pseudo_id === undefined
    ? undefined
    : patternedText(root.organization_pseudo_id, "lifecycle organization pseudonym", PSEUDONYM, 128, 16);
  if (organizationContext !== (organizationPseudoId !== undefined)) {
    throw new Error("organization lifecycle events require one organization pseudonym and individual events forbid it");
  }
  const publicComponent = root.public_component === undefined ? undefined : (() => {
    const value = object(root.public_component, "lifecycle public component");
    exactKeys(value, ["ecosystem", "name"], "lifecycle public component");
    requiredKeys(value, ["ecosystem", "name"], "lifecycle public component");
    return {
      ecosystem: patternedText(value.ecosystem, "lifecycle public component ecosystem", COMPONENT_ECOSYSTEM, 80),
      name: patternedText(value.name, "lifecycle public component name", COMPONENT_NAME, 160),
    };
  })();
  const opaquePairToken = root.opaque_pair_token === undefined ? undefined : sha256Text(root.opaque_pair_token, "lifecycle opaque pair token");
  if (publicComponent !== undefined && opaquePairToken !== undefined) throw new Error("lifecycle event cannot contain both a public component and opaque pair token");
  let assistedChannels: Channel[] | undefined;
  if (root.assisted_channels !== undefined) {
    if (!Array.isArray(root.assisted_channels) || root.assisted_channels.length > 3) throw new Error("lifecycle assisted channels are invalid");
    assistedChannels = root.assisted_channels.map((item) => enumValue<Channel>(item, CHANNEL_SET, "lifecycle assisted channel"));
    uniqueStrings(assistedChannels, "lifecycle assisted channels");
  }
  const verdict = root.verdict === undefined ? undefined : enumValue<Verdict>(root.verdict, VERDICTS, "lifecycle verdict");
  const disposition = root.disposition === undefined ? undefined : enumValue<LifecycleEvent["disposition"] & string>(root.disposition, new Set(["APPLY", "DEFER", "RESTORE", "NO_DECISION"]), "lifecycle disposition");
  if (eventName === "preflight_completed_v1" && verdict === undefined) throw new Error("preflight completion requires a verdict");
  if (eventName === "update_disposition_recorded_v1" && disposition === undefined) throw new Error("update disposition event requires a disposition");
  if (verdict === "HOLD" && root.hold_reason_class === undefined) throw new Error("HOLD lifecycle events require a coarse reason class");
  const organizationOnly = eventName === "shared_policy_enabled_v1" || eventName === "required_gate_enabled_v1"
    || eventName === "organization_pql_qualified_v1" || eventName === "team_offer_shown_v1"
    || eventName === "checkout_started_v1" || eventName === "payment_succeeded_v1"
    || eventName === "entitlement_activated_v1" || eventName === "payment_failed_v1"
    || eventName === "refund_issued_v1" || eventName === "subscription_renewed_v1"
    || eventName === "subscription_canceled_v1" || eventName === "entitlement_expired_v1"
    || eventName === "fleet_signal_qualified_v1";
  if (organizationOnly && !organizationContext) throw new Error("this lifecycle event is organization-only");
  const sharedPolicy = booleanValue(root.shared_policy, "lifecycle shared policy");
  const requiredGate = booleanValue(root.required_gate, "lifecycle required gate");
  const publicContribution = booleanValue(root.public_contribution, "lifecycle public contribution");
  if (eventName === "shared_policy_enabled_v1" && !sharedPolicy) throw new Error("shared policy event must record enabled policy");
  if (eventName === "required_gate_enabled_v1" && !requiredGate) throw new Error("required gate event must record an enabled gate");
  if ((eventName === "proof_contribution_opted_in_v1" || eventName === "proof_published_v1") && !publicContribution) {
    throw new Error("public proof lifecycle events require public contribution consent");
  }
  const event: LifecycleEvent = {
    schema_version: LIFECYCLE_SCHEMA,
    event_id: patternedText(root.event_id, "lifecycle event ID", UUID_V4, 36, 36),
    event_name: eventName,
    event_day: patternedText(root.event_day, "lifecycle event day", /^\d{4}-\d{2}-\d{2}$/, 10, 10),
    release_version: patternedText(root.release_version, "lifecycle release version", VERSION, 40),
    channel,
    external: booleanValue(root.external, "lifecycle external state"),
    demo: booleanValue(root.demo, "lifecycle demo state"),
    entity_scope: root.entity_scope,
    installation_pseudo_id: patternedText(root.installation_pseudo_id, "lifecycle installation pseudonym", PSEUDONYM, 128, 16),
    ...(organizationPseudoId === undefined ? {} : { organization_pseudo_id: organizationPseudoId }),
    ...(root.first_touch_ref_token === undefined ? {} : { first_touch_ref_token: patternedText(root.first_touch_ref_token, "lifecycle first touch token", REF_TOKEN, 64, 8) }),
    ...(root.activation_channel === undefined ? {} : { activation_channel: enumValue<Channel>(root.activation_channel, CHANNEL_SET, "lifecycle activation channel") }),
    ...(assistedChannels === undefined ? {} : { assisted_channels: assistedChannels }),
    ...(publicComponent === undefined ? {} : { public_component: publicComponent }),
    ...(opaquePairToken === undefined ? {} : { opaque_pair_token: opaquePairToken }),
    ...(root.artifact_class === undefined ? {} : { artifact_class: enumValue<LifecycleEvent["artifact_class"] & string>(root.artifact_class, new Set(["manager-lock", "archive", "directory", "container", "plugin", "skill", "mcp-server", "other"]), "lifecycle artifact class") }),
    ...(verdict === undefined ? {} : { verdict }),
    ...(root.hold_reason_class === undefined ? {} : { hold_reason_class: enumValue<LifecycleEvent["hold_reason_class"] & string>(root.hold_reason_class, new Set(["containment", "identity", "materialization", "configuration", "evidence", "timeout", "other"]), "lifecycle HOLD reason") }),
    ...(root.canary_count_bucket === undefined ? {} : { canary_count_bucket: enumValue<LifecycleEvent["canary_count_bucket"] & string>(root.canary_count_bucket, new Set(["0", "1", "2-3", "4-7", "8-16", "17-32"]), "lifecycle canary count bucket") }),
    ...(root.duration_bucket === undefined ? {} : { duration_bucket: enumValue<LifecycleEvent["duration_bucket"] & string>(root.duration_bucket, new Set(["lt-1m", "1-3m", "3-7m", "7-15m", "gt-15m"]), "lifecycle duration bucket") }),
    ...(disposition === undefined ? {} : { disposition }),
    shared_policy: sharedPolicy,
    required_gate: requiredGate,
    public_contribution: publicContribution,
    organization_context: organizationContext,
  };
  if (event.channel === "internal" && event.external) throw new Error("internal lifecycle channel cannot be external");
  const parsedDay = new Date(`${event.event_day}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== event.event_day) {
    throw new Error("lifecycle event day is invalid");
  }
  return event;
}

export async function hmacPseudonym(value: string, secret: string): Promise<string> {
  if (secret.length < 32 || secret.length > 512) throw new Error("telemetry HMAC key is unavailable or invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return `hmac-sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canonicalBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCanonicalBase64Url(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 512) throw new Error(`${label} must be canonical base64url`);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (canonicalBase64Url(decoded) !== value) throw new Error(`${label} must be canonical base64url`);
  return decoded;
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

/** Derive a revocable per-installation capability without storing the issued secret in D1. */
export async function lifecycleInstallationSecret(installationId: string, issuingKey: string): Promise<string> {
  if (issuingKey.length < 32 || issuingKey.length > 512) throw new Error("lifecycle issuing key is unavailable or invalid");
  const keyBytes = new TextEncoder().encode(issuingKey);
  return canonicalBase64Url(await hmacSha256(keyBytes, `agent-vigil-lifecycle-installation-secret/v1\0${installationId}`));
}

export async function signLifecycleRequest(installationSecret: string, message: string): Promise<string> {
  const keyBytes = decodeCanonicalBase64Url(installationSecret, "lifecycle installation secret");
  if (keyBytes.length !== 32) throw new Error("lifecycle installation secret is invalid");
  return canonicalBase64Url(await hmacSha256(keyBytes, message));
}

export async function verifyLifecycleRequestHmac(
  installationSecret: string,
  signature: string,
  message: string,
): Promise<boolean> {
  try {
    const keyBytes = decodeCanonicalBase64Url(installationSecret, "lifecycle installation secret");
    const signatureBytes = decodeCanonicalBase64Url(signature, "lifecycle request signature");
    if (keyBytes.length !== 32 || signatureBytes.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export async function sanitizeLifecycleEvent(event: LifecycleEvent, secret: string): Promise<SanitizedLifecycleEvent> {
  const { installation_pseudo_id, organization_pseudo_id, ...rest } = event;
  const installationPseudoHash = await hmacPseudonym(`installation\0${installation_pseudo_id}`, secret);
  const organizationPseudoHash = organization_pseudo_id === undefined
    ? undefined
    : await hmacPseudonym(`organization\0${organization_pseudo_id}`, secret);
  return {
    ...rest,
    installation_pseudo_hash: installationPseudoHash,
    ...(organizationPseudoHash === undefined ? {} : { organization_pseudo_hash: organizationPseudoHash }),
  };
}

export function assertResolutionBinding(
  resolution: CompatibilityResolution,
  broken: PublicCompatibilityEntry,
  fixed: PublicCompatibilityEntry,
): void {
  if (broken.entryHash !== resolution.broken.entryHash || fixed.entryHash !== resolution.fixed.entryHash
    || broken.verdict !== "CHANGED" || fixed.verdict !== "SAFE"
    || broken.signature.keyId !== fixed.signature.keyId || broken.signature.keyId !== resolution.signature.keyId
    || broken.component.ecosystem !== resolution.component.ecosystem || fixed.component.ecosystem !== resolution.component.ecosystem
    || broken.component.name !== resolution.component.name || fixed.component.name !== resolution.component.name
    || broken.component.currentVersion !== resolution.broken.baselineVersion
    || fixed.component.currentVersion !== resolution.fixed.baselineVersion
    || broken.component.currentArtifactSha256 !== fixed.component.currentArtifactSha256
    || broken.component.candidateVersion !== resolution.broken.brokenVersion
    || fixed.component.candidateVersion !== resolution.fixed.fixedVersion
    || broken.component.candidateArtifactSha256 !== resolution.broken.brokenArtifactSha256
    || fixed.component.candidateArtifactSha256 !== resolution.fixed.fixedArtifactSha256
    || canonical(broken.runner) !== canonical(fixed.runner)
    || Date.parse(fixed.generatedAt) <= Date.parse(broken.generatedAt)) {
    throw new Error("compatibility resolution is inconsistent with its referenced exact-pair entries");
  }
}
