import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { canonical, VERSION } from "./report.ts";
import {
  createAsyncDescriptorSink,
  createPrivateFileSink,
  type AsyncDescriptorSink,
  type PrivateFileSink,
} from "./safe-output.ts";
import {
  RunTelemetryMonitor,
  type RunTelemetryObservation,
  type RunTrajectoryLimits,
  type TelemetryBreach,
  type TelemetryTransport,
} from "./run-telemetry.ts";

const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAX_TIME_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const POST_KILL_WAIT_MS = 2_000;
const POLL_INTERVAL_MS = 100;
const STDOUT_STREAM_DRAIN_WAIT_MS = 1_000;
const CAPTURE_FLUSH_WAIT_MS = 5_000;
const STDOUT_RELAY_FLUSH_WAIT_MS = 1_000;
const MAX_STDOUT_RELAY_QUEUE_BYTES = 1024 * 1024;

export type ProtectedRunStopCode =
  | "TIME_LIMIT"
  | TelemetryBreach["code"]
  | "ORPHANED_DESCENDANTS"
  | "SUPERVISOR_SIGNAL"
  | "EXECUTABLE_CHANGED"
  | "SUPERVISOR_ERROR";

export type ProtectedRunReceipt = {
  schemaVersion: "agent-vigil-protected-run/v1";
  kind: "agent-vigil-protected-run";
  generatedAt: string;
  receiptHash: string;
  supervisor: { name: "agent-vigil"; version: string };
  state: "EXITED" | "STOPPED" | "ERROR";
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  command: {
    executableBasename: string;
    executableSha256: string;
    executablePathSha256: string;
    executableIdentityStable: boolean | "NOT_CHECKED";
    argvSha256: string;
    argumentCount: number;
    cwdSha256: string;
    launchedWithoutShell: true;
  };
  limits: {
    timeLimitMs: number;
    terminationGraceMs: number;
    trajectory?: RunTrajectoryLimits;
  };
  stop?: {
    code: ProtectedRunStopCode;
    observed?: number;
    limit?: number;
    signal?: NodeJS.Signals;
    detailSha256?: string;
  };
  process: {
    platform: NodeJS.Platform;
    leaderPid?: number;
    processGroupId?: number;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    termSent: boolean;
    killSent: boolean;
    processGroupTerminationConfirmed: boolean;
  };
  telemetry?: RunTelemetryObservation;
  outcome: {
    commandCompletion: "OBSERVED_ONLY";
    economicResult: "NOT_CHECKED";
  };
  evidenceBoundary: string[];
};

export type ProtectedRunInput = {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeLimitMs: number;
  terminationGraceMs: number;
  trajectoryLimits: RunTrajectoryLimits;
  telemetryGraceMs: number;
  transcript?: { path: string; transport: TelemetryTransport };
};

export type ProtectedRunResult = {
  exitCode: number;
  receipt: ProtectedRunReceipt;
};

type ExecutableEvidence = {
  path: string;
  basename: string;
  sha256: string;
  pathSha256: string;
  identity: string;
};

type ExitObservation = { code: number | null; signal: NodeJS.Signals | null };
type StopRequest = {
  code: ProtectedRunStopCode;
  observed?: number;
  limit?: number;
  signal?: NodeJS.Signals;
  detailSha256?: string;
};

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function invocationDigest(executablePath: string, args: string[]): string {
  const hash = createHash("sha256");
  for (const value of [executablePath, ...args]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function resolveExecutable(command: string, cwd: string, environment: NodeJS.ProcessEnv): string {
  if (!command || command.includes("\0")) throw new Error("run command executable is invalid");
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (environment.PATH ?? "").split(delimiter).map((entry) => join(entry || cwd, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`run executable was not found or is not executable: ${basename(command)}`);
}

function receiptSafeBasename(path: string): string {
  return basename(path).replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
}

function hashExecutable(path: string): ExecutableEvidence {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("run executable must resolve to a regular file");
    if (before.size > BigInt(MAX_EXECUTABLE_BYTES)) {
      throw new Error(`run executable exceeds the ${MAX_EXECUTABLE_BYTES}-byte hashing limit`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (!count) throw new Error("run executable changed while it was hashed");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("run executable changed while it was hashed");
    }
    return {
      path,
      basename: receiptSafeBasename(path),
      sha256: `sha256:${hash.digest("hex")}`,
      pathSha256: sha256(path),
      identity: [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":"),
    };
  } finally {
    closeSync(descriptor);
  }
}

class PostLaunchVerificationCancelledError extends Error {
  constructor() {
    super("post-launch executable verification was cancelled");
    this.name = "PostLaunchVerificationCancelledError";
  }
}

function postLaunchVerificationCancelled(error: unknown): error is PostLaunchVerificationCancelledError {
  return error instanceof PostLaunchVerificationCancelledError;
}

async function hashExecutableAfterLaunch(path: string, signal: AbortSignal): Promise<ExecutableEvidence> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await openFile(path, fsConstants.O_RDONLY | noFollow);
  try {
    if (signal.aborted) throw new PostLaunchVerificationCancelledError();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("run executable must resolve to a regular file");
    if (before.size > BigInt(MAX_EXECUTABLE_BYTES)) {
      throw new Error(`run executable exceeds the ${MAX_EXECUTABLE_BYTES}-byte hashing limit`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      if (signal.aborted) throw new PostLaunchVerificationCancelledError();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (!bytesRead) throw new Error("run executable changed while it was hashed");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (signal.aborted) throw new PostLaunchVerificationCancelledError();
    const after = await handle.stat({ bigint: true });
    if (signal.aborted) throw new PostLaunchVerificationCancelledError();
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("run executable changed while it was hashed");
    }
    return {
      path,
      basename: receiptSafeBasename(path),
      sha256: `sha256:${hash.digest("hex")}`,
      pathSha256: sha256(path),
      identity: [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].join(":"),
    };
  } finally {
    await handle.close();
  }
}

type LinuxProcessGroupState = "active" | "zombie-only" | "unknown";

type LinuxTaskStat = {
  state: string;
  processGroupId: number;
  threadCount: number;
  startTimeTicks: string;
};

function parseLinuxTaskStat(stat: string): LinuxTaskStat | undefined {
  const commandEnd = stat.lastIndexOf(")");
  const fields = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/) : [];
  const state = fields[0];
  const processGroupId = fields[2] && /^\d+$/.test(fields[2]) ? Number(fields[2]) : undefined;
  const threadCount = fields[17] && /^\d+$/.test(fields[17]) ? Number(fields[17]) : undefined;
  const startTimeTicks = fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : undefined;
  if (!state || !/^[A-Za-z]$/.test(state)
    || processGroupId === undefined
    || threadCount === undefined
    || startTimeTicks === undefined
    || !Number.isSafeInteger(processGroupId)
    || !Number.isSafeInteger(threadCount)
    || threadCount < 1) return undefined;
  return { state, processGroupId, threadCount, startTimeTicks };
}

function linuxTaskCanExecute(state: string): boolean {
  return state !== "Z" && state !== "X" && state !== "x";
}

type LinuxProcessGroupSnapshot =
  | { state: "active" | "unknown" }
  | { state: "zombie-only"; fingerprint: string };

function numericDirectoryNames(entries: Array<{ name: string; isDirectory(): boolean }>): string[] {
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function sameNames(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function isHidepidEntryOutsideSameUserBoundary(pid: string, processGroupId: number): boolean {
  if (pid === String(processGroupId) || typeof process.geteuid !== "function") return false;
  try {
    return statSync(join("/proc", pid)).uid !== process.geteuid();
  } catch {
    return false;
  }
}

function snapshotLinuxProcessGroup(processGroupId: number): LinuxProcessGroupSnapshot {
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return { state: "unknown" };
  }

  const memberFingerprints: string[] = [];
  let incomplete = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let stat: string;
    try {
      stat = readFileSync(join("/proc", entry.name, "stat"), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      if ((code === "EACCES" || code === "EPERM")
        && isHidepidEntryOutsideSameUserBoundary(entry.name, processGroupId)) continue;
      incomplete = true;
      continue;
    }

    const leaderBefore = parseLinuxTaskStat(stat);
    if (!leaderBefore) {
      incomplete = true;
      continue;
    }
    if (leaderBefore.processGroupId !== processGroupId) continue;
    if (linuxTaskCanExecute(leaderBefore.state)) return { state: "active" };

    const taskDirectory = join("/proc", entry.name, "task");
    let taskEntriesBefore;
    try {
      taskEntriesBefore = readdirSync(taskDirectory, { withFileTypes: true });
    } catch {
      // A vanished leader and a live thread group can both make this directory unavailable.
      incomplete = true;
      continue;
    }

    const taskNamesBefore = numericDirectoryNames(taskEntriesBefore);
    const taskFingerprints: string[] = [];
    let memberIncomplete = taskNamesBefore.length !== leaderBefore.threadCount;
    for (const taskName of taskNamesBefore) {
      let taskStatText: string;
      try {
        taskStatText = readFileSync(join(taskDirectory, taskName, "stat"), "utf8");
      } catch (error) {
        memberIncomplete = true;
        continue;
      }

      const taskStat = parseLinuxTaskStat(taskStatText);
      if (!taskStat
        || taskStat.processGroupId !== processGroupId
        || taskStat.threadCount !== leaderBefore.threadCount) {
        memberIncomplete = true;
        continue;
      }
      if (linuxTaskCanExecute(taskStat.state)) return { state: "active" };
      taskFingerprints.push(`${taskName}:${taskStat.startTimeTicks}:${taskStat.state}`);
    }

    let taskEntriesAfter;
    let leaderAfterText: string;
    try {
      taskEntriesAfter = readdirSync(taskDirectory, { withFileTypes: true });
      leaderAfterText = readFileSync(join("/proc", entry.name, "stat"), "utf8");
    } catch (error) {
      // Disappearance is still incomplete evidence while kill(0) reports the group present.
      incomplete = true;
      continue;
    }

    const taskNamesAfter = numericDirectoryNames(taskEntriesAfter);
    const leaderAfter = parseLinuxTaskStat(leaderAfterText);
    if (!leaderAfter
      || leaderAfter.processGroupId !== processGroupId
      || linuxTaskCanExecute(leaderAfter.state)) {
      if (leaderAfter && leaderAfter.processGroupId === processGroupId && linuxTaskCanExecute(leaderAfter.state)) {
        return { state: "active" };
      }
      incomplete = true;
      continue;
    }
    if (leaderAfter.startTimeTicks !== leaderBefore.startTimeTicks
      || leaderAfter.state !== leaderBefore.state
      || leaderAfter.threadCount !== leaderBefore.threadCount
      || !sameNames(taskNamesBefore, taskNamesAfter)
      || taskFingerprints.length !== taskNamesBefore.length) {
      memberIncomplete = true;
    }
    if (memberIncomplete) {
      incomplete = true;
      continue;
    }
    memberFingerprints.push(
      `${entry.name}:${leaderBefore.startTimeTicks}:${leaderBefore.state}:${leaderBefore.threadCount}`
      + `[${taskFingerprints.join(",")}]`,
    );
  }

  if (incomplete || memberFingerprints.length === 0) return { state: "unknown" };
  return { state: "zombie-only", fingerprint: memberFingerprints.sort().join("|") };
}

function linuxProcessGroupState(processGroupId: number): LinuxProcessGroupState {
  const first = snapshotLinuxProcessGroup(processGroupId);
  if (first.state !== "zombie-only") return first.state;
  const second = snapshotLinuxProcessGroup(processGroupId);
  if (second.state !== "zombie-only") return second.state;
  return first.fingerprint === second.fingerprint ? "zombie-only" : "unknown";
}

function processGroupHasLiveMembers(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (process.platform !== "linux") return true;
  return linuxProcessGroupState(pid) !== "zombie-only";
}

function sendGroupSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, milliseconds);
    void promise.then(
      () => { clearTimeout(timer); resolveWait(); },
      () => { clearTimeout(timer); resolveWait(); },
    );
  });
}

type TimedSettlement =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown }
  | { status: "timed-out" };

function settlementWithin(promise: Promise<unknown>, milliseconds: number): Promise<TimedSettlement> {
  return new Promise((resolveSettlement) => {
    let settled = false;
    const finish = (result: TimedSettlement): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSettlement(result);
    };
    const timer = setTimeout(() => finish({ status: "timed-out" }), milliseconds);
    void promise.then(
      () => finish({ status: "fulfilled" }),
      (error: unknown) => finish({ status: "rejected", error }),
    );
  });
}

async function waitForGroupExit(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = monotonicNowMs() + milliseconds;
  while (processGroupHasLiveMembers(pid) && monotonicNowMs() < deadline) {
    await delay(Math.min(25, Math.max(1, deadline - monotonicNowMs())));
  }
  return !processGroupHasLiveMembers(pid);
}

async function terminateProcessGroup(pid: number, graceMs: number): Promise<{ termSent: boolean; killSent: boolean; confirmed: boolean }> {
  const termSent = sendGroupSignal(pid, "SIGTERM");
  if (!termSent || await waitForGroupExit(pid, graceMs)) return { termSent, killSent: false, confirmed: true };
  const killSent = sendGroupSignal(pid, "SIGKILL");
  const confirmed = !killSent || await waitForGroupExit(pid, POST_KILL_WAIT_MS);
  return { termSent, killSent, confirmed };
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  return 128 + (osConstants.signals[signal] ?? 0);
}

function hasTrajectoryLimits(limits: RunTrajectoryLimits): boolean {
  return Object.values(limits).some((value) => value !== undefined);
}

function validateProtectedRunInput(input: ProtectedRunInput): void {
  if (!Number.isSafeInteger(input.timeLimitMs) || input.timeLimitMs < 100 || input.timeLimitMs > MAX_TIME_LIMIT_MS) {
    throw new Error("protected run time limit is outside the supported range");
  }
  if (!Number.isSafeInteger(input.terminationGraceMs) || input.terminationGraceMs < 0 || input.terminationGraceMs > 30_000) {
    throw new Error("protected run termination grace is outside the supported range");
  }
  if (!Number.isSafeInteger(input.telemetryGraceMs) || input.telemetryGraceMs < 100 || input.telemetryGraceMs > 60_000) {
    throw new Error("protected run telemetry grace is outside the supported range");
  }
  if (!Array.isArray(input.args) || input.args.some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("protected run arguments must be NUL-free strings");
  }
  for (const [name, value] of Object.entries(input.trajectoryLimits)) {
    const minimum = name === "noProgressMs" ? 100 : 0;
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
      throw new Error(`protected run ${name} is outside the supported range`);
    }
  }
  if (hasTrajectoryLimits(input.trajectoryLimits) && !input.transcript) {
    throw new Error("protected run trajectory limits require a transcript source");
  }
}

function stopFromBreach(breach: TelemetryBreach): StopRequest {
  return { code: breach.code, observed: breach.observed, limit: breach.limit };
}

function receiptBoundary(input: ProtectedRunInput): string[] {
  const boundaries = [
    "The supervisor observed process behavior; a zero exit code is not proof that the work was correct or valuable.",
    "The resolved executable bytes were hashed, but scripts, models, remote services, and later-loaded code were not authenticated.",
    "POSIX process-group termination covers ordinary descendants; a hostile same-user process can escape by creating a new session.",
    "Command arguments and transcript content are omitted from this receipt; their hashes are commitments, not encryption.",
    "Economic outcome and exact provider-billed cost remain NOT_CHECKED.",
  ];
  if (input.transcript) {
    boundaries.push("Transcript trajectory evidence is emitted by the child and is not provider-signed or independently trusted.");
  }
  return boundaries;
}

function buildReceipt(input: {
  run: ProtectedRunInput;
  executable: ExecutableEvidence;
  stable: boolean | "NOT_CHECKED";
  state: ProtectedRunReceipt["state"];
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
  child?: ChildProcess;
  exit: ExitObservation;
  stop?: StopRequest;
  termSent: boolean;
  killSent: boolean;
  processGroupTerminationConfirmed: boolean;
  telemetry?: RunTelemetryObservation;
}): ProtectedRunReceipt {
  const payload: Omit<ProtectedRunReceipt, "receiptHash"> = {
    schemaVersion: "agent-vigil-protected-run/v1",
    kind: "agent-vigil-protected-run",
    generatedAt: new Date(input.finishedAtMs).toISOString(),
    supervisor: { name: "agent-vigil", version: VERSION },
    state: input.state,
    startedAt: new Date(input.startedAtMs).toISOString(),
    finishedAt: new Date(input.finishedAtMs).toISOString(),
    elapsedMs: Math.max(0, input.elapsedMs),
    command: {
      executableBasename: input.executable.basename,
      executableSha256: input.executable.sha256,
      executablePathSha256: input.executable.pathSha256,
      executableIdentityStable: input.stable,
      argvSha256: invocationDigest(input.executable.path, input.run.args),
      argumentCount: input.run.args.length,
      cwdSha256: sha256(resolve(input.run.cwd)),
      launchedWithoutShell: true,
    },
    limits: {
      timeLimitMs: input.run.timeLimitMs,
      terminationGraceMs: input.run.terminationGraceMs,
      ...(hasTrajectoryLimits(input.run.trajectoryLimits) ? { trajectory: input.run.trajectoryLimits } : {}),
    },
    ...(input.stop ? { stop: input.stop } : {}),
    process: {
      platform: process.platform,
      ...(input.child?.pid ? { leaderPid: input.child.pid, processGroupId: input.child.pid } : {}),
      exitCode: input.exit.code,
      exitSignal: input.exit.signal,
      termSent: input.termSent,
      killSent: input.killSent,
      processGroupTerminationConfirmed: input.processGroupTerminationConfirmed,
    },
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    outcome: { commandCompletion: "OBSERVED_ONLY", economicResult: "NOT_CHECKED" },
    evidenceBoundary: receiptBoundary(input.run),
  };
  return { ...payload, receiptHash: sha256(canonical(payload)) };
}

export function recomputeProtectedRunHash(receipt: ProtectedRunReceipt): string {
  const { receiptHash: _receiptHash, ...payload } = receipt;
  return sha256(canonical(payload));
}

export async function executeProtectedRun(input: ProtectedRunInput): Promise<ProtectedRunResult> {
  if (process.platform === "win32") throw new Error("vigil run currently requires POSIX process-group controls (macOS or Linux)");
  validateProtectedRunInput(input);
  let startedAtMs = Date.now();
  let startedAtMonotonicMs = monotonicNowMs();
  let sink: PrivateFileSink | undefined;
  let child: ChildProcess | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;
  let exit: ExitObservation = { code: null, signal: null };
  let exitObservedAtMonotonicMs: number | undefined;
  let stopRequest: StopRequest | undefined;
  let outputFailure: StopRequest | undefined;
  let termSent = false;
  let killSent = false;
  let processGroupTerminationConfirmed = false;
  let stable: boolean | "NOT_CHECKED" = "NOT_CHECKED";
  let telemetry: RunTelemetryMonitor | undefined;
  let latestTelemetry: RunTelemetryObservation | undefined;
  let telemetryPollInFlight: Promise<void> | undefined;
  let stdoutDonePromise: Promise<void> = Promise.resolve();
  let captureClosePromise: Promise<void> | undefined;
  let stdoutRelay: AsyncDescriptorSink | undefined;
  let verificationAbortController: AbortController | undefined;
  let stopHandledPromise: Promise<StopRequest> | undefined;
  let requestStopResolve: ((request: StopRequest) => void) | undefined;
  const stopPromise = new Promise<StopRequest>((resolveStop) => { requestStopResolve = resolveStop; });
  const requestStop = (request: StopRequest): void => {
    if (stopRequest) return;
    stopRequest = request;
    requestStopResolve?.(request);
  };
  const requestSupervisorError = (error: unknown): void => {
    requestStop({
      code: "SUPERVISOR_ERROR",
      detailSha256: sha256(error instanceof Error ? error.message : String(error)),
    });
  };
  const requestOutputFailure = (error: unknown): void => {
    outputFailure ??= {
      code: "SUPERVISOR_ERROR",
      detailSha256: sha256(error instanceof Error ? error.message : String(error)),
    };
    requestStop(outputFailure);
  };
  const getStopRequest = (): StopRequest | undefined => stopRequest;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
    const handler = () => requestStop({ code: "SUPERVISOR_SIGNAL", signal });
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  let executable: ExecutableEvidence;
  try {
    executable = hashExecutable(resolveExecutable(input.executable, input.cwd, input.environment));
  } catch (error) {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    throw error;
  }
  const finishPreLaunchStop = (stop: StopRequest): ProtectedRunResult => {
    processGroupTerminationConfirmed = true;
    const finishedAtMs = Date.now();
    const receipt = buildReceipt({
      run: input,
      executable,
      stable,
      state: "STOPPED",
      startedAtMs,
      finishedAtMs,
      elapsedMs: monotonicNowMs() - startedAtMonotonicMs,
      exit,
      stop,
      termSent,
      killSent,
      processGroupTerminationConfirmed,
    });
    return {
      exitCode: stop.code === "SUPERVISOR_SIGNAL" ? signalExitCode(stop.signal ?? null) : 124,
      receipt,
    };
  };

  try {
    await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    const hashingStop = getStopRequest();
    if (hashingStop) return finishPreLaunchStop(hashingStop);

    if (input.transcript) {
      if (input.transcript.transport === "supervisor-captured-stdout") sink = createPrivateFileSink(input.transcript.path);
      telemetry = new RunTelemetryMonitor({
        path: input.transcript.path,
        transport: input.transcript.transport,
        limits: input.trajectoryLimits,
        telemetryGraceMs: input.telemetryGraceMs,
        startedAtMs: startedAtMonotonicMs,
      });
      await telemetry.ready();
    }

    const preLaunchStop = getStopRequest();
    if (preLaunchStop) return finishPreLaunchStop(preLaunchStop);

    startedAtMs = Date.now();
    startedAtMonotonicMs = monotonicNowMs();
    telemetry?.start(startedAtMonotonicMs);

    child = spawn(executable.path, input.args, {
      cwd: input.cwd,
      env: input.environment,
      detached: true,
      shell: false,
      stdio: input.transcript?.transport === "supervisor-captured-stdout"
        ? ["inherit", "pipe", "inherit"]
        : "inherit",
    });
    const enforceDeadline = (): void => {
      const elapsed = monotonicNowMs() - startedAtMonotonicMs;
      const remaining = input.timeLimitMs - elapsed;
      if (remaining > 0) {
        timeout = setTimeout(enforceDeadline, remaining);
        return;
      }
      requestStop({ code: "TIME_LIMIT", observed: elapsed, limit: input.timeLimitMs });
    };
    enforceDeadline();
    const pollTelemetry = (): void => {
      if (!telemetry || telemetryPollInFlight) return;
      const polling = telemetry.poll(monotonicNowMs()).then((result) => {
        latestTelemetry = result.observation;
        if (result.breach) requestStop(stopFromBreach(result.breach));
      }).catch((error: unknown) => {
        requestStop({ code: "SUPERVISOR_ERROR", detailSha256: sha256(error instanceof Error ? error.message : String(error)) });
      });
      telemetryPollInFlight = polling;
      void polling.finally(() => {
        if (telemetryPollInFlight === polling) telemetryPollInFlight = undefined;
      });
    };
    interval = setInterval(() => {
      pollTelemetry();
    }, POLL_INTERVAL_MS);
    const exitPromise = new Promise<ExitObservation>((resolveExit) => {
      child!.once("exit", (code, signal) => {
        exit = { code, signal };
        exitObservedAtMonotonicMs = monotonicNowMs();
        if (timeout) { clearTimeout(timeout); timeout = undefined; }
        if (interval) { clearInterval(interval); interval = undefined; }
        resolveExit(exit);
      });
    });
    const spawnPromise = new Promise<void>((resolveSpawn, rejectSpawn) => {
      child!.once("spawn", resolveSpawn);
      child!.once("error", rejectSpawn);
    });
    if (child.stdout) {
      const capturedStdout = child.stdout;
      let captureWritesInFlight = 0;
      let captureFailed = false;
      let relayFailed = false;
      stdoutRelay = createAsyncDescriptorSink(process.stdout.fd);
      const resumeCapturedStdout = (): void => {
        if (captureWritesInFlight === 0) capturedStdout.resume();
      };
      stdoutDonePromise = new Promise((resolveStdout) => {
        capturedStdout.once("end", resolveStdout);
        capturedStdout.once("close", () => {
          if (!capturedStdout.readableEnded) {
            requestOutputFailure(new Error("Captured stdout closed before EOF"));
          }
          resolveStdout();
        });
        capturedStdout.once("error", (error) => {
          requestOutputFailure(error);
          resolveStdout();
        });
      });
      capturedStdout.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        try {
          const breach = telemetry!.appendCaptured(bytes);
          if (breach) requestStop(stopFromBreach(breach));
          if (!breach && !captureFailed) {
            captureWritesInFlight += 1;
            capturedStdout.pause();
            void sink!.write(bytes).catch((error: unknown) => {
              captureFailed = true;
              requestOutputFailure(error);
            }).finally(() => {
              captureWritesInFlight -= 1;
              resumeCapturedStdout();
            });
          }
          if (!relayFailed) {
            if (stdoutRelay!.queuedBytes() + bytes.length > MAX_STDOUT_RELAY_QUEUE_BYTES) {
              relayFailed = true;
              const error = new Error("Mirrored stdout exceeded its bounded asynchronous queue");
              stdoutRelay!.abort(error);
              requestOutputFailure(error);
            } else {
              void stdoutRelay!.write(bytes).catch((error: unknown) => {
                relayFailed = true;
                stdoutRelay!.abort(error);
                requestOutputFailure(error);
              });
            }
          }
        } catch (error) {
          requestSupervisorError(error);
        }
      });
    }
    await spawnPromise;

    verificationAbortController = new AbortController();
    stopHandledPromise = stopPromise.then(async (request) => {
      verificationAbortController?.abort();
      if (timeout) { clearTimeout(timeout); timeout = undefined; }
      if (interval) { clearInterval(interval); interval = undefined; }
      if (child?.pid) {
        const termination = await terminateProcessGroup(child.pid, input.terminationGraceMs);
        termSent = termination.termSent;
        killSent = termination.killSent;
        processGroupTerminationConfirmed = termination.confirmed;
        await settleWithin(exitPromise, POST_KILL_WAIT_MS);
      } else processGroupTerminationConfirmed = true;
      return request;
    });
    const exitDescendantCheckPromise = exitPromise.then(async () => {
      await delay(25);
      if (stopRequest) return;
      if (child?.pid && processGroupHasLiveMembers(child.pid)) requestStop({ code: "ORPHANED_DESCENDANTS" });
      else processGroupTerminationConfirmed = true;
    });
    const postLaunchVerificationPromise = hashExecutableAfterLaunch(executable.path, verificationAbortController.signal).then(
      (evidence) => ({ kind: "verified" as const, evidence }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const verificationWinner = await Promise.race([
      postLaunchVerificationPromise,
      stopPromise.then((request) => ({ kind: "stop" as const, request })),
      exitPromise.then((result) => ({ kind: "exit" as const, result })),
    ]);
    if (verificationWinner.kind === "verified" && !stopRequest) {
      stable = verificationWinner.evidence.sha256 === executable.sha256
        && verificationWinner.evidence.identity === executable.identity;
      if (!stable) requestStop({ code: "EXECUTABLE_CHANGED" });
    } else if (verificationWinner.kind === "error" && !stopRequest) {
      stable = false;
      requestStop({
        code: "EXECUTABLE_CHANGED",
        detailSha256: sha256(verificationWinner.error instanceof Error ? verificationWinner.error.message : String(verificationWinner.error)),
      });
    } else if (verificationWinner.kind === "stop") {
      stable = "NOT_CHECKED";
    } else if (verificationWinner.kind === "exit") {
      const completedVerification = await postLaunchVerificationPromise;
      if (completedVerification.kind === "verified") {
        stable = completedVerification.evidence.sha256 === executable.sha256
          && completedVerification.evidence.identity === executable.identity;
        if (!stable) requestStop({ code: "EXECUTABLE_CHANGED" });
      } else if (postLaunchVerificationCancelled(completedVerification.error)) {
        stable = "NOT_CHECKED";
      } else {
        stable = false;
        requestStop({
          code: "EXECUTABLE_CHANGED",
          detailSha256: sha256(completedVerification.error instanceof Error
            ? completedVerification.error.message
            : String(completedVerification.error)),
        });
      }
    }
    if (stopRequest) {
      await Promise.all([stopHandledPromise, postLaunchVerificationPromise]);
    }

    const winner = await Promise.race([
      exitPromise.then((result) => ({ kind: "exit" as const, result })),
      stopHandledPromise.then((request) => ({ kind: "stop" as const, request })),
    ]);
    if (timeout) { clearTimeout(timeout); timeout = undefined; }
    if (interval) { clearInterval(interval); interval = undefined; }

    if (winner.kind === "exit") await exitDescendantCheckPromise;
    if (stopRequest) await stopHandledPromise;

    if (child.stdout) {
      const drain = await settlementWithin(stdoutDonePromise, STDOUT_STREAM_DRAIN_WAIT_MS);
      if (drain.status !== "fulfilled") {
        requestOutputFailure(drain.status === "rejected"
          ? drain.error
          : new Error("Captured stdout did not drain before the safety deadline"));
        child.stdout.destroy();
        await settleWithin(stdoutDonePromise, 100);
      }
    }
    if (sink) {
      captureClosePromise = sink.close();
      const captureFlush = await settlementWithin(captureClosePromise, CAPTURE_FLUSH_WAIT_MS);
      if (captureFlush.status !== "fulfilled") {
        const error = captureFlush.status === "rejected"
          ? captureFlush.error
          : new Error("Captured stdout did not flush before the safety deadline");
        sink.abort(error);
        requestOutputFailure(error);
      } else {
        sink = undefined;
      }
    }
    if (stdoutRelay) {
      const relayFlush = await settlementWithin(stdoutRelay.flush(), STDOUT_RELAY_FLUSH_WAIT_MS);
      if (relayFlush.status !== "fulfilled") {
        const error = relayFlush.status === "rejected"
          ? relayFlush.error
          : new Error("Mirrored stdout did not flush before the safety deadline");
        stdoutRelay.abort(error);
        requestOutputFailure(error);
      }
    }
    if (telemetry) {
      if (telemetryPollInFlight) await telemetryPollInFlight;
      const finalTelemetry = await telemetry.poll(exitObservedAtMonotonicMs ?? monotonicNowMs(), true, true);
      latestTelemetry = finalTelemetry.observation;
      if (finalTelemetry.breach) requestStop(stopFromBreach(finalTelemetry.breach));
    }
    if (stopRequest) await stopHandledPromise;
    const finishedAtMs = Date.now();
    const elapsedMs = monotonicNowMs() - startedAtMonotonicMs;
    const containmentFailure: StopRequest | undefined = processGroupTerminationConfirmed
      ? undefined
      : {
        code: "SUPERVISOR_ERROR",
        detailSha256: sha256("process group termination could not be confirmed after the final kill wait"),
      };
    const receiptStop = containmentFailure ?? outputFailure ?? stopRequest;
    const state: ProtectedRunReceipt["state"] = receiptStop
      ? (receiptStop.code === "SUPERVISOR_ERROR" || receiptStop.code === "EXECUTABLE_CHANGED" ? "ERROR" : "STOPPED")
      : "EXITED";
    const receipt = buildReceipt({
      run: input,
      executable,
      stable,
      state,
      startedAtMs,
      finishedAtMs,
      elapsedMs,
      child,
      exit,
      ...(receiptStop ? { stop: receiptStop } : {}),
      termSent,
      killSent,
      processGroupTerminationConfirmed,
      ...(latestTelemetry ? { telemetry: latestTelemetry } : {}),
    });
    const exitCode = state === "ERROR" ? 125
      : state === "STOPPED" ? (receiptStop?.code === "SUPERVISOR_SIGNAL" ? signalExitCode(receiptStop.signal ?? null) : 124)
        : exit.code ?? signalExitCode(exit.signal);
    return { exitCode, receipt };
  } catch (error) {
    verificationAbortController?.abort();
    const preLaunchStop = child ? undefined : getStopRequest();
    if (preLaunchStop) return finishPreLaunchStop(preLaunchStop);
    const detailSha256 = sha256(error instanceof Error ? error.message : String(error));
    if (stopRequest && stopHandledPromise) {
      try { await stopHandledPromise; } catch { processGroupTerminationConfirmed = false; }
    } else if (child?.pid && processGroupHasLiveMembers(child.pid)) {
      try {
        const termination = await terminateProcessGroup(child.pid, input.terminationGraceMs);
        termSent = termination.termSent;
        killSent = termination.killSent;
        processGroupTerminationConfirmed = termination.confirmed;
      } catch { processGroupTerminationConfirmed = false; }
    } else processGroupTerminationConfirmed = true;
    const finishedAtMs = Date.now();
    const elapsedMs = monotonicNowMs() - startedAtMonotonicMs;
    const receipt = buildReceipt({
      run: input,
      executable,
      stable,
      state: "ERROR",
      startedAtMs,
      finishedAtMs,
      elapsedMs,
      child,
      exit,
      stop: { code: "SUPERVISOR_ERROR", detailSha256 },
      termSent,
      killSent,
      processGroupTerminationConfirmed,
      ...(latestTelemetry ? { telemetry: latestTelemetry } : {}),
    });
    return { exitCode: 125, receipt };
  } finally {
    verificationAbortController?.abort();
    if (timeout) clearTimeout(timeout);
    if (interval) clearInterval(interval);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (captureClosePromise) {
      void captureClosePromise.catch(() => { /* The receipt already reports the output failure. */ });
    } else {
      try { await sink?.close(); } catch { /* A receipt still reports the supervisor failure path. */ }
    }
    try { await telemetry?.close(); } catch { /* The receipt already captures worker failures. */ }
  }
}
