import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { arch, hostname, platform, release, tmpdir, type } from "node:os";
import { join } from "node:path";
import { canonical } from "./report.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export const GUARD_COMPAT_SCHEMA = "agent-vigil-guard-compatibility/v1" as const;
export const GUARD_CHALLENGE_PACK = "agent-vigil-harmless-shell-canaries/v1" as const;

export type GuardHost = "claude" | "codex";
export type GuardDecision = "ALLOW" | "DENY" | "DEFER" | "ERROR" | "UNKNOWN";
export type GuardCheckStatus = "PASS" | "FAIL" | "INCONCLUSIVE";

export type FileIdentity = {
  realPath: string;
  sha256: string;
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedNanoseconds: bigint;
};

export type GuardProcessObservation = {
  decision: GuardDecision;
  rule: string;
  process: "EXITED" | "TIMED_OUT" | "SPAWN_ERROR" | "SIGNALED" | "OUTPUT_LIMIT";
  exit: "ZERO" | "TWO" | "OTHER" | "NONE";
  output: "EMPTY" | "TEXT" | "JSON" | "INVALID_JSON" | "UNREADABLE";
};

export type GuardChallengeResult = {
  id: "allow-canary" | "deny-canary";
  expected: "ALLOW" | "DENY";
  actual: GuardDecision;
  passed: boolean;
  canarySha256: string;
  observation: Omit<GuardProcessObservation, "decision">;
};

export type GuardCompatibilityReport = {
  schemaVersion: typeof GUARD_COMPAT_SCHEMA;
  vigilVersion: string;
  generatedAt: string;
  nonce: string;
  scope: "PROCESS_CONFORMANCE";
  status: GuardCheckStatus;
  deployment: {
    state: "HOLD";
    reasonCodes: string[];
  };
  challengePack: {
    id: typeof GUARD_CHALLENGE_PACK;
    sha256: string;
  };
  host: {
    kind: GuardHost;
    version: string;
    executableSha256: string;
  };
  control: {
    name: string;
    version: string;
    launcherSha256: string;
    artifactSha256: string;
    argumentsSha256: string;
  };
  bindings: {
    policySha256: string;
    configurationSha256: string;
    operatingSystem: {
      platform: NodeJS.Platform;
      type: string;
      release: string;
      architecture: string;
      machineIdentitySha256: string;
    };
  };
  challenges: GuardChallengeResult[];
  summary: {
    passed: number;
    total: number;
    decisions: Record<GuardDecision, number>;
  };
  reproduction: string;
  limitations: string[];
  receiptHash: string;
};

export type GuardCompatibilityInput = {
  host: GuardHost;
  hostVersion: string;
  hostExecutable: string;
  controlName: string;
  controlVersion: string;
  controlExecutable: string;
  controlArtifact?: string;
  controlArguments?: string[];
  policyPath: string;
  configurationPath: string;
  vigilVersion: string;
  timeoutMs?: number;
  generatedAt?: string;
  nonce?: string;
};

const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_LENGTH = 4_096;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

function digest(value: string | Buffer | object): string {
  const body = Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? Buffer.from(value, "utf8")
      : Buffer.from(canonical(value), "utf8");
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export const guardDigest = digest;

function modifiedNanoseconds(status: BigIntStats): bigint {
  return status.mtimeNs;
}

function hashRegularFile(requestedPath: string, label: string): FileIdentity {
  const realPath = realpathSync(requestedPath);
  const before = lstatSync(realPath, { bigint: true });
  if (!before.isFile()) throw new Error(`${label} must resolve to a regular file`);
  const descriptor = openSync(realPath, "r");
  const hash = createHash("sha256");
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was opened`);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.size !== opened.size || modifiedNanoseconds(after) !== modifiedNanoseconds(opened)) {
      throw new Error(`${label} changed while it was hashed`);
    }
    return {
      realPath,
      sha256: `sha256:${hash.digest("hex")}`,
      device: after.dev,
      inode: after.ino,
      size: after.size,
      modifiedNanoseconds: modifiedNanoseconds(after),
    };
  } finally {
    closeSync(descriptor);
  }
}

export const hashGuardFile = hashRegularFile;

function assertFileUnchanged(identity: FileIdentity, label: string): void {
  const status = lstatSync(identity.realPath, { bigint: true });
  if (
    !status.isFile()
    || status.dev !== identity.device
    || status.ino !== identity.inode
    || status.size !== identity.size
    || modifiedNanoseconds(status) !== identity.modifiedNanoseconds
  ) throw new Error(`${label} changed during the process-conformance check`);
  if (hashRegularFile(identity.realPath, label).sha256 !== identity.sha256) {
    throw new Error(`${label} content changed during the process-conformance check`);
  }
}

export const assertGuardFileUnchanged = assertFileUnchanged;

function validateText(value: string, label: string, maximum = 200): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  if (Buffer.byteLength(trimmed, "utf8") > maximum) throw new Error(`${label} is too long`);
  if (/\p{Cc}|\p{Cf}/u.test(trimmed)) throw new Error(`${label} contains control characters`);
  return trimmed;
}

function validateArguments(values: string[]): string[] {
  if (values.length > MAX_ARGUMENTS) throw new Error(`control arguments cannot exceed ${MAX_ARGUMENTS} entries`);
  for (const value of values) {
    if (typeof value !== "string") throw new Error("every control argument must be a string");
    if (Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_LENGTH) throw new Error("a control argument is too long");
    if (value.includes("\0")) throw new Error("control arguments cannot contain NUL bytes");
  }
  return [...values];
}

function argumentsNameFile(values: string[], realPath: string): boolean {
  return values.some((value) => {
    try { return realpathSync(value) === realPath; }
    catch { return false; }
  });
}

export function loadControlArguments(path: string): string[] {
  const identity = hashRegularFile(path, "control arguments file");
  if (identity.size > 64n * 1024n) throw new Error("control arguments file exceeds 64 KiB");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(identity.realPath, "utf8")); }
  catch { throw new Error("control arguments file must contain valid JSON"); }
  if (!Array.isArray(parsed)) throw new Error("control arguments file must contain a JSON array");
  return validateArguments(parsed as string[]);
}

function harmlessCommand(kind: "allow" | "deny", nonce: string): string {
  const token = `AGENT_VIGIL_PROCESS_CONFORMANCE_${kind.toUpperCase()}_V1_${nonce}`;
  return `printf '%s\\n' '${token}'`;
}

function hookPayload(host: GuardHost, command: string, cwd: string, transcriptPath: string, nonce: string, id: string): string {
  const common = {
    session_id: `agent-vigil-${nonce}`,
    transcript_path: transcriptPath,
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: `${id}-${nonce}`,
  };
  return JSON.stringify(host === "codex"
    ? { ...common, model: "agent-vigil-process-conformance", turn_id: `turn-${nonce}` }
    : { ...common, prompt_id: `prompt-${nonce}` });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function interpretedDecision(host: GuardHost, value: Record<string, unknown>): { decision: GuardDecision; rule: string } {
  if (host === "codex" && ["continue", "stopReason", "suppressOutput"].some((key) => key in value)) {
    return { decision: "ERROR", rule: "CODEX_UNSUPPORTED_PRE_TOOL_FIELD" };
  }
  if (["permissionDecision", "updatedInput", "permissionDecisionReason"].some((key) => key in value)) {
    return { decision: "ERROR", rule: "MISPLACED_PERMISSION_FIELD" };
  }
  const specific = objectValue(value.hookSpecificOutput);
  if (value.hookSpecificOutput !== undefined && !specific) {
    return { decision: "ERROR", rule: "MALFORMED_HOOK_SPECIFIC_OUTPUT" };
  }
  if (specific && ["decision", "permission"].some((key) => key in specific)) {
    return { decision: "ERROR", rule: "MISPLACED_HOOK_DECISION_FIELD" };
  }
  if (specific && specific.hookEventName !== "PreToolUse") {
    return { decision: "ERROR", rule: "WRONG_HOOK_EVENT_NAME" };
  }
  const nested = specific?.permissionDecision;
  const legacy = value.decision;
  if (nested !== undefined && typeof nested !== "string") {
    return { decision: "ERROR", rule: "MALFORMED_PERMISSION_DECISION" };
  }
  if (legacy !== undefined && typeof legacy !== "string") {
    return { decision: "ERROR", rule: "MALFORMED_LEGACY_DECISION" };
  }

  if (typeof nested === "string") {
    const normalized = nested.toLowerCase();
    if (normalized === "allow") {
      if (specific?.updatedInput !== undefined) {
        const updated = objectValue(specific.updatedInput);
        if (!updated || typeof updated.command !== "string") {
          return { decision: "ERROR", rule: "MALFORMED_UPDATED_INPUT" };
        }
      }
      if (legacy !== undefined && legacy !== "approve") {
        return { decision: "ERROR", rule: "CONFLICTING_DECISIONS" };
      }
      return { decision: "ALLOW", rule: `${host.toUpperCase()}_STRUCTURED_ALLOW` };
    }
    if (normalized === "deny") {
      if (specific?.updatedInput !== undefined) return { decision: "ERROR", rule: "UPDATED_INPUT_WITH_DENY" };
      if (legacy !== undefined && legacy !== "block") {
        return { decision: "ERROR", rule: "CONFLICTING_DECISIONS" };
      }
      return { decision: "DENY", rule: `${host.toUpperCase()}_STRUCTURED_DENY` };
    }
    if (host === "claude" && (normalized === "ask" || normalized === "defer")) {
      return { decision: "DEFER", rule: `CLAUDE_STRUCTURED_${normalized.toUpperCase()}` };
    }
    if (host === "codex" && normalized === "ask") {
      return { decision: "ERROR", rule: "CODEX_UNSUPPORTED_ASK" };
    }
    return { decision: "UNKNOWN", rule: "UNRECOGNIZED_PERMISSION_DECISION" };
  }

  if (typeof legacy === "string") {
    const normalized = legacy.toLowerCase();
    if (normalized === "block") return { decision: "DENY", rule: `${host.toUpperCase()}_LEGACY_BLOCK` };
    if (host === "claude" && normalized === "approve") return { decision: "ALLOW", rule: "CLAUDE_LEGACY_APPROVE" };
    if (host === "codex" && normalized === "approve") return { decision: "ERROR", rule: "CODEX_UNSUPPORTED_APPROVE" };
    return { decision: "UNKNOWN", rule: "UNRECOGNIZED_LEGACY_DECISION" };
  }

  if (specific?.updatedInput !== undefined) return { decision: "ERROR", rule: "UPDATED_INPUT_WITHOUT_ALLOW" };
  return { decision: "DEFER", rule: "NO_CONTROL_DECISION" };
}

function outputKind(stdout: string): GuardProcessObservation["output"] {
  const trimmed = stdout.trimStart();
  if (!trimmed) return "EMPTY";
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? "JSON" : "TEXT";
}

export function interpretGuardProcess(input: {
  host: GuardHost;
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  errorCode?: string;
}): GuardProcessObservation {
  const stdout = input.stdout ?? "";
  const initialOutput = outputKind(stdout);
  if (input.errorCode === "ETIMEDOUT") {
    return { decision: "ERROR", rule: "CONTROL_TIMEOUT", process: "TIMED_OUT", exit: "NONE", output: "UNREADABLE" };
  }
  if (input.errorCode === "ENOBUFS") {
    return { decision: "ERROR", rule: "CONTROL_OUTPUT_LIMIT", process: "OUTPUT_LIMIT", exit: "NONE", output: "UNREADABLE" };
  }
  if (input.errorCode) {
    return { decision: "ERROR", rule: "CONTROL_SPAWN_ERROR", process: "SPAWN_ERROR", exit: "NONE", output: "UNREADABLE" };
  }
  if (input.signal || input.status === null) {
    return { decision: "ERROR", rule: "CONTROL_DID_NOT_EXIT", process: "SIGNALED", exit: "NONE", output: initialOutput };
  }
  if (input.status === 2) {
    return { decision: "DENY", rule: `${input.host.toUpperCase()}_EXIT_TWO`, process: "EXITED", exit: "TWO", output: initialOutput };
  }

  const exit = input.status === 0 ? "ZERO" as const : "OTHER" as const;
  if (initialOutput === "EMPTY") {
    return input.status === 0
      ? { decision: "DEFER", rule: "ZERO_EXIT_NO_DECISION", process: "EXITED", exit, output: "EMPTY" }
      : { decision: "ERROR", rule: "NONZERO_EXIT_NO_DECISION", process: "EXITED", exit, output: "EMPTY" };
  }
  if (initialOutput === "TEXT") {
    return input.status === 0
      ? { decision: "DEFER", rule: `${input.host.toUpperCase()}_PLAIN_TEXT_IGNORED`, process: "EXITED", exit, output: "TEXT" }
      : { decision: "ERROR", rule: "NONZERO_EXIT_PLAIN_TEXT", process: "EXITED", exit, output: "TEXT" };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(stdout); }
  catch {
    return { decision: "ERROR", rule: "INVALID_JSON_OUTPUT", process: "EXITED", exit, output: "INVALID_JSON" };
  }
  const object = objectValue(parsed);
  if (!object) return { decision: "ERROR", rule: "JSON_OUTPUT_NOT_OBJECT", process: "EXITED", exit, output: "JSON" };
  const interpreted = interpretedDecision(input.host, object);
  if (input.status !== 0 && input.host === "codex") {
    return { decision: "ERROR", rule: "CODEX_NONZERO_EXIT", process: "EXITED", exit, output: "JSON" };
  }
  if (input.status !== 0 && interpreted.decision === "DEFER") {
    return { decision: "ERROR", rule: "NONZERO_EXIT_NO_DECISION", process: "EXITED", exit, output: "JSON" };
  }
  return { ...interpreted, process: "EXITED", exit, output: "JSON" };
}

function minimalEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENT_VIGIL_PROCESS_CONFORMANCE: "1",
    HOME: home,
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "",
    TMPDIR: home,
    TEMP: home,
    TMP: home,
  };
  for (const name of ["SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function reportStatus(challenges: GuardChallengeResult[]): GuardCheckStatus {
  if (challenges.some((challenge) => challenge.actual === "UNKNOWN")) return "INCONCLUSIVE";
  return challenges.length === 2 && challenges.every((challenge) => challenge.passed) ? "PASS" : "FAIL";
}

function challengePackDigest(): string {
  return digest({
    id: GUARD_CHALLENGE_PACK,
    payload: "PreToolUse/Bash",
    allow: "printf marker AGENT_VIGIL_PROCESS_CONFORMANCE_ALLOW_V1_<nonce>",
    deny: "printf marker AGENT_VIGIL_PROCESS_CONFORMANCE_DENY_V1_<nonce>",
  });
}

export function recomputeGuardCompatibilityReceiptHash(report: GuardCompatibilityReport): string {
  const { receiptHash: _ignored, ...payload } = report;
  return digest(payload);
}

export function runGuardCompatibility(input: GuardCompatibilityInput): GuardCompatibilityReport {
  const vigilVersion = validateText(input.vigilVersion, "Agent Vigil version");
  const hostVersion = validateText(input.hostVersion, "host version");
  const controlName = validateText(input.controlName, "control name");
  const controlVersion = validateText(input.controlVersion, "control version");
  const controlArguments = validateArguments(input.controlArguments ?? []);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60_000) {
    throw new Error("timeout must be an integer from 50 to 60000 milliseconds");
  }
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) throw new Error("nonce must be 16 to 128 safe characters");
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("generated time must be an RFC3339-compatible timestamp");

  const identities = {
    host: hashRegularFile(input.hostExecutable, "host executable"),
    launcher: hashRegularFile(input.controlExecutable, "control executable"),
    artifact: hashRegularFile(input.controlArtifact ?? input.controlExecutable, "control artifact"),
    policy: hashRegularFile(input.policyPath, "policy"),
    configuration: hashRegularFile(input.configurationPath, "configuration"),
  };
  if (
    identities.artifact.realPath !== identities.launcher.realPath
    && !argumentsNameFile(controlArguments, identities.artifact.realPath)
  ) {
    throw new Error("a separate control artifact must be named by a control argument");
  }
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-guard-compat-"));
  const home = join(root, "home");
  const transcriptPath = join(root, "transcript.jsonl");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(transcriptPath, "", { mode: 0o600 });
  const challenges: GuardChallengeResult[] = [];
  try {
    for (const challenge of [
      { id: "allow-canary" as const, expected: "ALLOW" as const, kind: "allow" as const },
      { id: "deny-canary" as const, expected: "DENY" as const, kind: "deny" as const },
    ]) {
      const command = harmlessCommand(challenge.kind, nonce);
      const completed = spawnSync(identities.launcher.realPath, controlArguments, {
        cwd: root,
        env: minimalEnvironment(home),
        input: hookPayload(input.host, command, root, transcriptPath, nonce, challenge.id),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: "SIGKILL",
        windowsHide: true,
      });
      const outputExceeded = Buffer.byteLength(completed.stdout ?? "", "utf8") >= MAX_OUTPUT_BYTES
        || Buffer.byteLength(completed.stderr ?? "", "utf8") >= MAX_OUTPUT_BYTES;
      const observed = interpretGuardProcess({
        host: input.host,
        status: completed.status,
        signal: completed.signal,
        stdout: completed.stdout ?? "",
        errorCode: outputExceeded ? "ENOBUFS" : (completed.error as NodeJS.ErrnoException | undefined)?.code,
      });
      challenges.push({
        id: challenge.id,
        expected: challenge.expected,
        actual: observed.decision,
        passed: observed.decision === challenge.expected,
        canarySha256: digest(command),
        observation: {
          rule: observed.rule,
          process: observed.process,
          exit: observed.exit,
          output: observed.output,
        },
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  for (const [label, identity] of Object.entries(identities)) assertFileUnchanged(identity, label);

  const status = reportStatus(challenges);
  const decisions = Object.fromEntries(
    (["ALLOW", "DENY", "DEFER", "ERROR", "UNKNOWN"] as GuardDecision[])
      .map((decision) => [decision, challenges.filter((challenge) => challenge.actual === decision).length]),
  ) as Record<GuardDecision, number>;
  const operatingSystem = {
    platform: platform(),
    type: type(),
    release: release(),
    architecture: arch(),
    machineIdentitySha256: digest({ hostname: hostname(), platform: platform(), type: type(), release: release(), architecture: arch() }),
  };
  const reasonCodes = ["LIVE_HOST_ROUTE_NOT_PROVEN"];
  if (status !== "PASS") reasonCodes.push("PROCESS_CONFORMANCE_NOT_PROVEN");
  const unsigned = {
    schemaVersion: GUARD_COMPAT_SCHEMA,
    vigilVersion,
    generatedAt,
    nonce,
    scope: "PROCESS_CONFORMANCE" as const,
    status,
    deployment: { state: "HOLD" as const, reasonCodes },
    challengePack: { id: GUARD_CHALLENGE_PACK, sha256: challengePackDigest() },
    host: { kind: input.host, version: hostVersion, executableSha256: identities.host.sha256 },
    control: {
      name: controlName,
      version: controlVersion,
      launcherSha256: identities.launcher.sha256,
      artifactSha256: identities.artifact.sha256,
      argumentsSha256: digest(controlArguments),
    },
    bindings: {
      policySha256: identities.policy.sha256,
      configurationSha256: identities.configuration.sha256,
      operatingSystem,
    },
    challenges,
    summary: { passed: challenges.filter((challenge) => challenge.passed).length, total: challenges.length, decisions },
    reproduction: `vigil guard-compat --host ${input.host} <same exact host, control, policy, configuration, and arguments>`,
    limitations: [
      "This is a process-conformance check. It does not launch Claude Code or Codex and does not prove that a live host routed a real tool call through the control.",
      "Both shell canaries use printf and are harmless if executed. The deny marker must be covered by the supplied policy for a PASS.",
      "The supplied control process runs with the current user's operating-system authority. This check is not a sandbox for untrusted controls.",
      "File commitments prove which policy, configuration, and artifact were named. They do not prove that the control actually read the policy or configuration, or that the selected host executable is authentic.",
      "The receipt binds file contents, arguments, host version, challenge pack, machine fingerprint, and operating-system details. It does not authenticate the operator-supplied version labels.",
      "No PASS from this command permits deployment. Deployment remains on HOLD until a separate real-host routing test succeeds.",
    ],
  };
  return { ...unsigned, receiptHash: digest(unsigned) };
}

export function renderGuardCompatibility(report: GuardCompatibilityReport): string {
  const lines = [
    `Agent Vigil guard compatibility: ${report.status}`,
    `Host: ${report.host.kind} ${terminalSafe(report.host.version)}`,
    `Control: ${terminalSafe(report.control.name)} ${terminalSafe(report.control.version)}`,
    "",
  ];
  for (const challenge of report.challenges) {
    lines.push(`${challenge.passed ? "PASS" : "FAIL"} ${challenge.id}: expected ${challenge.expected}; observed ${challenge.actual} (${challenge.observation.rule})`);
  }
  lines.push(
    "",
    `${report.summary.passed}/${report.summary.total} expected decisions observed`,
    `Deployment: HOLD (${report.deployment.reasonCodes.join(", ")})`,
    `Receipt: ${report.receiptHash}`,
    "A process PASS is not live-host routing proof.",
  );
  return lines.join("\n");
}
