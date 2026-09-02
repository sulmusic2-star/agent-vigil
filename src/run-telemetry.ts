import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeTrajectory, classifyTranscriptActions, type ActionClass, type TrajectoryMetrics } from "./authority.ts";
import { readRegularFileSnapshot } from "./safe-fs.ts";
import { MAX_TRANSCRIPT_BYTES, parseTranscript, type LoadedTranscript, type TranscriptFormat } from "./transcript.ts";

export type RunTrajectoryLimits = {
  noProgressMs?: number;
  maxToolCalls?: number;
  maxFailedToolCalls?: number;
  maxIdenticalToolCalls?: number;
  maxConsecutiveFailures?: number;
  maxObservedTokens?: number;
};

export type TelemetryTransport = "external-file" | "supervisor-captured-stdout";

export type TelemetryBreach = {
  code:
    | "TELEMETRY_INTEGRITY"
    | "TELEMETRY_UNREADABLE"
    | "TELEMETRY_MISSING"
    | "TOKEN_USAGE_UNAVAILABLE"
    | "TRANSCRIPT_SIZE"
    | "NO_PROGRESS"
    | "TOOL_CALL_LIMIT"
    | "FAILED_TOOL_CALL_LIMIT"
    | "IDENTICAL_TOOL_CALL_LIMIT"
    | "CONSECUTIVE_FAILURE_LIMIT"
    | "OBSERVED_TOKEN_LIMIT";
  observed: number;
  limit: number;
};

export type RunTelemetryObservation = {
  configured: true;
  authority: "child-controlled";
  transport: TelemetryTransport;
  pathSha256: string;
  parserStatus: "WAITING" | "READY" | "PARTIAL" | "UNREADABLE";
  format?: TranscriptFormat;
  baselineSha256?: string;
  latestSha256?: string;
  appendOnly: boolean;
  toolCalls: number;
  failedToolCalls: number;
  maxIdenticalToolCalls: number;
  maxConsecutiveFailedToolCalls: number;
  completedProgressActions: number;
  observedTokens?: number;
  lastProgressElapsedMs: number;
  parseErrorSha256?: string;
};

type ParsedLive = {
  transcript: LoadedTranscript;
  partial: boolean;
};

const PROGRESS_CLASSES = new Set<ActionClass>(["repository_write", "test_execute", "build_execute", "git_commit"]);
const EMPTY_METRICS: TrajectoryMetrics = {
  toolCalls: 0,
  failedToolCalls: 0,
  maxIdenticalToolCalls: 0,
  repeatedActionGroups: 0,
  maxConsecutiveFailedToolCalls: 0,
  progressBearingActions: 0,
};

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseLive(raw: string, path: string): ParsedLive {
  try {
    return { transcript: parseTranscript(raw, path), partial: false };
  } catch (error) {
    if (!/\.(?:jsonl|ndjson)$/i.test(path) || raw.endsWith("\n")) throw error;
    const boundary = raw.lastIndexOf("\n");
    if (boundary < 0 || !raw.slice(0, boundary).trim()) throw error;
    return { transcript: parseTranscript(raw.slice(0, boundary + 1), path), partial: true };
  }
}

function breached(observed: number, limit: number | undefined): boolean {
  return limit !== undefined && observed > limit;
}

export class RunTelemetryMonitor {
  readonly path: string;
  readonly transport: TelemetryTransport;
  readonly limits: RunTrajectoryLimits;
  readonly telemetryGraceMs: number;

  private startedAtMs: number;
  private lastProgressAtMs: number;
  private baselineToolCalls = 0;
  private baselineTokens = 0;
  private baselineSha256: string | undefined;
  private expectedDevice: bigint | undefined;
  private expectedInode: bigint | undefined;
  private expectedSize: bigint | undefined;
  private expectedMtimeNs: bigint | undefined;
  private expectedCtimeNs: bigint | undefined;
  private previousBytes: Buffer | undefined;
  private capturedChunks: Buffer[] = [];
  private capturedLength = 0;
  private capturedSnapshot = Buffer.alloc(0);
  private capturedDirty = false;
  private format: TranscriptFormat | undefined;
  private parseErrorSinceMs: number | undefined;
  private partialSinceMs: number | undefined;
  private parseErrorSha256: string | undefined;
  private parserStatus: RunTelemetryObservation["parserStatus"] = "WAITING";
  private metrics: TrajectoryMetrics = EMPTY_METRICS;
  private observedTokens: number | undefined;
  private completedProgress = new Set<string>();
  private latestSha256: string | undefined;
  private integrityBreach: TelemetryBreach | undefined;

  constructor(input: {
    path: string;
    transport: TelemetryTransport;
    limits: RunTrajectoryLimits;
    telemetryGraceMs: number;
    startedAtMs: number;
  }) {
    this.path = resolve(input.path);
    this.transport = input.transport;
    this.limits = input.limits;
    this.telemetryGraceMs = input.telemetryGraceMs;
    this.startedAtMs = input.startedAtMs;
    this.lastProgressAtMs = input.startedAtMs;
    if (this.transport === "external-file" && existsSync(this.path)) this.establishExternalBaseline();
  }

  appendCaptured(bytes: Buffer): TelemetryBreach | undefined {
    if (this.transport !== "supervisor-captured-stdout") throw new Error("captured bytes require supervisor-captured stdout");
    const total = this.capturedLength + bytes.length;
    if (total > MAX_TRANSCRIPT_BYTES) {
      this.integrityBreach = { code: "TRANSCRIPT_SIZE", observed: total, limit: MAX_TRANSCRIPT_BYTES };
      return this.integrityBreach;
    }
    this.capturedChunks.push(Buffer.from(bytes));
    this.capturedLength = total;
    this.capturedDirty = true;
    return undefined;
  }

  poll(nowMs = Date.now(), enforce = true): { observation: RunTelemetryObservation; breach?: TelemetryBreach } {
    if (this.integrityBreach) return { observation: this.observation(nowMs), breach: this.integrityBreach };
    let raw: Buffer | undefined;
    let sourceIsEmpty = false;
    if (this.transport === "supervisor-captured-stdout") {
      if (this.capturedDirty) {
        this.capturedSnapshot = Buffer.concat(this.capturedChunks, this.capturedLength);
        this.capturedDirty = false;
        raw = this.capturedSnapshot;
      }
      sourceIsEmpty = this.capturedLength === 0;
    }
    else {
      try {
        if (existsSync(this.path)) {
          const linked = lstatSync(this.path, { bigint: true });
          if (linked.isSymbolicLink() || !linked.isFile()) {
            this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
          } else if (this.expectedDevice !== undefined && (linked.dev !== this.expectedDevice || linked.ino !== this.expectedInode)) {
            this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
          } else if (linked.size > BigInt(MAX_TRANSCRIPT_BYTES)) {
            this.integrityBreach = { code: "TRANSCRIPT_SIZE", observed: Number(linked.size), limit: MAX_TRANSCRIPT_BYTES };
          } else {
            const unchanged = this.expectedDevice !== undefined
              && linked.size === this.expectedSize
              && linked.mtimeNs === this.expectedMtimeNs
              && linked.ctimeNs === this.expectedCtimeNs;
            if (!unchanged) {
              const snapshot = readRegularFileSnapshot(this.path, MAX_TRANSCRIPT_BYTES, "live transcript");
              if (this.expectedDevice !== undefined && (snapshot.device !== this.expectedDevice || snapshot.inode !== this.expectedInode)) {
                this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
              }
              if (!this.integrityBreach && this.previousBytes && (snapshot.bytes.length < this.previousBytes.length
                || !snapshot.bytes.subarray(0, this.previousBytes.length).equals(this.previousBytes))) {
                this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
              }
              if (!this.integrityBreach) {
                this.rememberSnapshot(snapshot);
                raw = snapshot.bytes;
              }
            }
          }
          sourceIsEmpty = this.previousBytes?.length === 0;
        } else if (this.expectedDevice !== undefined) {
          this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/changed while it was (?:opened|read)/.test(message)) {
          this.parserStatus = "UNREADABLE";
          this.parseErrorSinceMs ??= nowMs;
          this.parseErrorSha256 = sha256(message);
        } else if ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.expectedDevice !== undefined) {
          this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
          this.parseErrorSha256 = sha256(message);
        }
      }
    }
    if (this.integrityBreach) return { observation: this.observation(nowMs), breach: this.integrityBreach };

    if (raw?.length) this.updateParsed(raw, nowMs);
    else if (sourceIsEmpty) this.parserStatus = "WAITING";

    const breach = enforce ? this.limitBreach(nowMs) : undefined;
    return { observation: this.observation(nowMs), ...(breach ? { breach } : {}) };
  }

  private establishExternalBaseline(): void {
    const snapshot = readRegularFileSnapshot(this.path, MAX_TRANSCRIPT_BYTES, "live transcript");
    this.rememberSnapshot(snapshot);
    this.baselineSha256 = sha256(snapshot.bytes);
    if (!snapshot.bytes.length) return;
    const parsed = parseLive(snapshot.bytes.toString("utf8"), this.path);
    const actions = classifyTranscriptActions(parsed.transcript);
    this.baselineToolCalls = actions.length;
    this.baselineTokens = parsed.transcript.usage?.totalTokens ?? 0;
    this.format = parsed.transcript.format;
    this.parserStatus = parsed.partial ? "PARTIAL" : "READY";
    if (parsed.partial) this.partialSinceMs = this.startedAtMs;
  }

  private rememberSnapshot(snapshot: ReturnType<typeof readRegularFileSnapshot>): void {
    this.expectedDevice = snapshot.device;
    this.expectedInode = snapshot.inode;
    this.expectedSize = snapshot.size;
    this.expectedMtimeNs = snapshot.mtimeNs;
    this.expectedCtimeNs = snapshot.ctimeNs;
    this.previousBytes = Buffer.from(snapshot.bytes);
  }

  private updateParsed(raw: Buffer, nowMs: number): void {
    const digest = sha256(raw);
    if (digest === this.latestSha256) return;
    this.latestSha256 = digest;
    try {
      const parsed = parseLive(raw.toString("utf8"), this.path);
      if (this.format && parsed.transcript.format !== this.format) {
        this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
        return;
      }
      this.format = parsed.transcript.format;
      this.parserStatus = parsed.partial ? "PARTIAL" : "READY";
      if (parsed.partial) this.partialSinceMs ??= nowMs;
      else this.partialSinceMs = undefined;
      this.parseErrorSinceMs = undefined;
      this.parseErrorSha256 = undefined;
      const actions = classifyTranscriptActions(parsed.transcript);
      if (actions.length < this.baselineToolCalls) {
        this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
        return;
      }
      const runActions = actions.slice(this.baselineToolCalls);
      this.metrics = analyzeTrajectory(runActions);
      const totalTokens = parsed.transcript.usage?.totalTokens;
      if (totalTokens !== undefined && totalTokens < this.baselineTokens) {
        this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: totalTokens, limit: this.baselineTokens };
        return;
      }
      this.observedTokens = totalTokens === undefined ? undefined : totalTokens - this.baselineTokens;
      for (const action of runActions) {
        if (!action.completed || action.failed || !action.classes.some((item) => PROGRESS_CLASSES.has(item))) continue;
        const key = `${action.sequence}\0${action.toolCallId}\0${action.identitySha256}`;
        if (this.completedProgress.has(key)) continue;
        this.completedProgress.add(key);
        this.lastProgressAtMs = nowMs;
      }
    } catch (error) {
      this.parserStatus = "UNREADABLE";
      this.parseErrorSinceMs ??= nowMs;
      this.parseErrorSha256 = sha256(error instanceof Error ? error.message : String(error));
    }
  }

  private limitBreach(nowMs: number): TelemetryBreach | undefined {
    if (this.integrityBreach) return this.integrityBreach;
    if (this.parserStatus === "WAITING" && Object.values(this.limits).some((value) => value !== undefined)
      && nowMs - this.startedAtMs >= this.telemetryGraceMs) {
      return { code: "TELEMETRY_MISSING", observed: nowMs - this.startedAtMs, limit: this.telemetryGraceMs };
    }
    if (this.parseErrorSinceMs !== undefined && nowMs - this.parseErrorSinceMs >= this.telemetryGraceMs) {
      return { code: "TELEMETRY_UNREADABLE", observed: nowMs - this.parseErrorSinceMs, limit: this.telemetryGraceMs };
    }
    if (this.partialSinceMs !== undefined && nowMs - this.partialSinceMs >= this.telemetryGraceMs) {
      return { code: "TELEMETRY_UNREADABLE", observed: nowMs - this.partialSinceMs, limit: this.telemetryGraceMs };
    }
    if (this.limits.maxObservedTokens !== undefined && this.observedTokens === undefined
      && (this.parserStatus === "READY" || this.parserStatus === "PARTIAL")
      && nowMs - this.startedAtMs >= this.telemetryGraceMs) {
      return { code: "TOKEN_USAGE_UNAVAILABLE", observed: 0, limit: this.limits.maxObservedTokens };
    }
    if (breached(this.metrics.toolCalls, this.limits.maxToolCalls)) {
      return { code: "TOOL_CALL_LIMIT", observed: this.metrics.toolCalls, limit: this.limits.maxToolCalls! };
    }
    if (breached(this.metrics.failedToolCalls, this.limits.maxFailedToolCalls)) {
      return { code: "FAILED_TOOL_CALL_LIMIT", observed: this.metrics.failedToolCalls, limit: this.limits.maxFailedToolCalls! };
    }
    if (breached(this.metrics.maxIdenticalToolCalls, this.limits.maxIdenticalToolCalls)) {
      return { code: "IDENTICAL_TOOL_CALL_LIMIT", observed: this.metrics.maxIdenticalToolCalls, limit: this.limits.maxIdenticalToolCalls! };
    }
    if (breached(this.metrics.maxConsecutiveFailedToolCalls, this.limits.maxConsecutiveFailures)) {
      return { code: "CONSECUTIVE_FAILURE_LIMIT", observed: this.metrics.maxConsecutiveFailedToolCalls, limit: this.limits.maxConsecutiveFailures! };
    }
    if (this.observedTokens !== undefined && breached(this.observedTokens, this.limits.maxObservedTokens)) {
      return { code: "OBSERVED_TOKEN_LIMIT", observed: this.observedTokens, limit: this.limits.maxObservedTokens! };
    }
    if (this.limits.noProgressMs !== undefined && nowMs - this.lastProgressAtMs > this.limits.noProgressMs) {
      return { code: "NO_PROGRESS", observed: nowMs - this.lastProgressAtMs, limit: this.limits.noProgressMs };
    }
    return undefined;
  }

  private observation(nowMs: number): RunTelemetryObservation {
    return {
      configured: true,
      authority: "child-controlled",
      transport: this.transport,
      pathSha256: sha256(this.path),
      parserStatus: this.parserStatus,
      ...(this.format ? { format: this.format } : {}),
      ...(this.baselineSha256 ? { baselineSha256: this.baselineSha256 } : {}),
      ...(this.latestSha256 ? { latestSha256: this.latestSha256 } : {}),
      appendOnly: !this.integrityBreach,
      toolCalls: this.metrics.toolCalls,
      failedToolCalls: this.metrics.failedToolCalls,
      maxIdenticalToolCalls: this.metrics.maxIdenticalToolCalls,
      maxConsecutiveFailedToolCalls: this.metrics.maxConsecutiveFailedToolCalls,
      completedProgressActions: this.completedProgress.size,
      ...(this.observedTokens !== undefined ? { observedTokens: this.observedTokens } : {}),
      lastProgressElapsedMs: Math.max(0, nowMs - this.lastProgressAtMs),
      ...(this.parseErrorSha256 ? { parseErrorSha256: this.parseErrorSha256 } : {}),
    };
  }
}
