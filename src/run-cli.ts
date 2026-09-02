import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { executeProtectedRun, type ProtectedRunReceipt } from "./run-supervisor.ts";
import type { RunTrajectoryLimits } from "./run-telemetry.ts";
import { validatePrivateFileDestination, writePrivateFileAtomic } from "./safe-output.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

const VALUE_OPTIONS = new Set([
  "--time-limit",
  "--termination-grace",
  "--transcript",
  "--capture-jsonl",
  "--telemetry-grace",
  "--no-progress",
  "--max-tool-calls",
  "--max-failed-tool-calls",
  "--max-identical-tool-calls",
  "--max-consecutive-failures",
  "--max-observed-tokens",
  "--budget-usd",
  "--format",
  "--output",
]);
const FLAG_OPTIONS = new Set(["--json"]);
const MAX_TIME_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

export function protectedRunUsage(): string {
  return `Agent Vigil protected run

Usage:
  vigil run --time-limit <duration> [trajectory options] -- <executable> [arguments...]

Required:
  --time-limit <duration>              External wall-clock limit (ms, s, m, or h)
  --                                  End Vigil options; the command is executed without a shell

Trajectory options (require a transcript source):
  --transcript <path>                 Observe an append-only agent JSONL transcript
  --capture-jsonl <new-path>          Capture and observe the command's JSONL stdout
  --no-progress <duration>            Stop without a completed write, test, build, or commit
  --max-tool-calls <n>                Stop after more than n observed tool calls
  --max-failed-tool-calls <n>         Stop after more than n observed failed tool calls
  --max-identical-tool-calls <n>      Stop after more than n identical observed calls
  --max-consecutive-failures <n>      Stop after more than n consecutive observed failures
  --max-observed-tokens <n>           Stop after more than n transcript-observed tokens

Output options:
  --termination-grace <duration>      SIGTERM grace before SIGKILL (default: 2s)
  --telemetry-grace <duration>        Unreadable JSONL grace period (default: 5s)
  --format <text|json>                Terminal receipt format (default: text)
  --json                              Alias for --format json
  --output <path>                     Write the complete receipt privately and atomically

Exact dollar enforcement is intentionally unavailable. --budget-usd refuses
to start a command until an authoritative live-cost adapter exists.

Exit codes: child code on normal exit | 124 limit stop | 125 supervisor error | 2 usage error`;
}

type Parsed = {
  values: Map<string, string>;
  flags: Set<string>;
  command: string[];
};

function parse(args: string[]): Parsed {
  const boundary = args.indexOf("--");
  const optionArguments = boundary < 0 ? args : args.slice(0, boundary);
  if (optionArguments.includes("--help")) return { values: new Map(), flags: new Set(["--help"]), command: [] };
  if (boundary < 0) throw new Error("run requires -- before the executable");
  const options = args.slice(0, boundary);
  const command = args.slice(boundary + 1);
  if (!command.length) throw new Error("run requires an executable after --");
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (!option.startsWith("--")) throw new Error(`unexpected run argument before --: ${option}`);
    if (VALUE_OPTIONS.has(option)) {
      if (values.has(option)) throw new Error(`duplicate option: ${option}`);
      const value = options[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
      values.set(option, value);
      continue;
    }
    if (FLAG_OPTIONS.has(option)) {
      if (flags.has(option)) throw new Error(`duplicate option: ${option}`);
      flags.add(option);
      continue;
    }
    throw new Error(`unknown run option: ${option}`);
  }
  return { values, flags, command };
}

function duration(raw: string | undefined, name: string, options: { required?: boolean; allowZero?: boolean; maximum?: number } = {}): number | undefined {
  if (raw === undefined) {
    if (options.required) throw new Error(`${name} is required`);
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw);
  if (!match) throw new Error(`${name} must use ms, s, m, or h (for example 30m)`);
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1000 : match[2] === "m" ? 60_000 : 3_600_000;
  const value = Number(match[1]) * multiplier;
  const minimum = options.allowZero ? 0 : 100;
  if (!Number.isSafeInteger(value) || value < minimum || value > (options.maximum ?? MAX_TIME_LIMIT_MS)) {
    throw new Error(`${name} must be between ${minimum}ms and ${options.maximum ?? MAX_TIME_LIMIT_MS}ms`);
  }
  return value;
}

function integer(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function assertDistinctFiles(left: string | undefined, right: string | undefined): void {
  if (!left || !right) return;
  const leftPath = resolve(left);
  const rightPath = resolve(right);
  if (leftPath === rightPath) throw new Error("run receipt and transcript outputs must be different files");
  if (!existsSync(leftPath) || !existsSync(rightPath)) return;
  const leftReal = realpathSync(leftPath);
  const rightReal = realpathSync(rightPath);
  if (leftReal === rightReal) throw new Error("run receipt and transcript outputs must not alias the same file");
  const leftStatus = statSync(leftReal);
  const rightStatus = statSync(rightReal);
  if (leftStatus.dev === rightStatus.dev && leftStatus.ino === rightStatus.ino) {
    throw new Error("run receipt and transcript outputs must not alias the same file");
  }
}

function renderReceipt(receipt: ProtectedRunReceipt): string {
  const lines = [
    `Agent Vigil protected run: ${receipt.state}`,
    `Elapsed: ${receipt.elapsedMs}ms / ${receipt.limits.timeLimitMs}ms`,
  ];
  if (receipt.stop) {
    const comparison = receipt.stop.observed !== undefined && receipt.stop.limit !== undefined
      ? ` (${receipt.stop.observed} observed; limit ${receipt.stop.limit})`
      : "";
    lines.push(`Stop: ${receipt.stop.code}${comparison}`);
  } else {
    lines.push(`Command exit: ${receipt.process.exitCode ?? receipt.process.exitSignal ?? "unknown"}`);
  }
  lines.push(`Process-group termination confirmed: ${receipt.process.processGroupTerminationConfirmed ? "yes" : "no"}`);
  if (receipt.telemetry) {
    lines.push(`Observed trajectory: ${receipt.telemetry.toolCalls} calls, ${receipt.telemetry.failedToolCalls} failed, ${receipt.telemetry.completedProgressActions} completed progress actions`);
    lines.push(`Telemetry authority: ${receipt.telemetry.authority}`);
  }
  lines.push("Correctness, value, exact cost, and economic outcome: NOT CHECKED");
  return `${lines.join("\n")}\n`;
}

export async function runProtectedRunCommand(args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const parsed = parse(args);
    if (parsed.flags.has("--help")) { console.log(protectedRunUsage()); return 0; }
    if (parsed.values.has("--budget-usd")) {
      throw new Error("--budget-usd is not enforceable without an authoritative live-cost adapter; no command was started");
    }
    const timeLimitMs = duration(parsed.values.get("--time-limit"), "--time-limit", { required: true })!;
    const terminationGraceMs = duration(parsed.values.get("--termination-grace") ?? "2s", "--termination-grace", { allowZero: true, maximum: 30_000 })!;
    const telemetryGraceMs = duration(parsed.values.get("--telemetry-grace") ?? "5s", "--telemetry-grace", { maximum: 60_000 })!;
    const noProgressMs = duration(parsed.values.get("--no-progress"), "--no-progress");
    const maxToolCalls = integer(parsed.values.get("--max-tool-calls"), "--max-tool-calls");
    const maxFailedToolCalls = integer(parsed.values.get("--max-failed-tool-calls"), "--max-failed-tool-calls");
    const maxIdenticalToolCalls = integer(parsed.values.get("--max-identical-tool-calls"), "--max-identical-tool-calls");
    const maxConsecutiveFailures = integer(parsed.values.get("--max-consecutive-failures"), "--max-consecutive-failures");
    const maxObservedTokens = integer(parsed.values.get("--max-observed-tokens"), "--max-observed-tokens");
    const trajectoryLimits: RunTrajectoryLimits = {
      ...(noProgressMs !== undefined ? { noProgressMs } : {}),
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
      ...(maxFailedToolCalls !== undefined ? { maxFailedToolCalls } : {}),
      ...(maxIdenticalToolCalls !== undefined ? { maxIdenticalToolCalls } : {}),
      ...(maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures } : {}),
      ...(maxObservedTokens !== undefined ? { maxObservedTokens } : {}),
    };
    const transcriptPath = parsed.values.get("--transcript");
    const capturePath = parsed.values.get("--capture-jsonl");
    if (transcriptPath && capturePath) throw new Error("use --transcript or --capture-jsonl, not both");
    if (Object.keys(trajectoryLimits).length && !transcriptPath && !capturePath) {
      throw new Error("trajectory limits require --transcript or --capture-jsonl");
    }
    if (capturePath && existsSync(resolve(capturePath))) throw new Error("--capture-jsonl must name a new file");
    if (capturePath && !/\.(?:jsonl|ndjson)$/i.test(capturePath)) throw new Error("--capture-jsonl must end in .jsonl or .ndjson");
    if (transcriptPath && !/\.(?:jsonl|ndjson)$/i.test(transcriptPath)) throw new Error("--transcript must end in .jsonl or .ndjson");
    const output = parsed.values.get("--output");
    assertDistinctFiles(output, transcriptPath ?? capturePath);
    if (output) validatePrivateFileDestination(output);
    const format = parsed.flags.has("--json") ? "json" : parsed.values.get("--format") ?? "text";
    if (parsed.flags.has("--json") && parsed.values.has("--format")) throw new Error("use --json or --format, not both");
    if (format !== "text" && format !== "json") throw new Error("run --format must be text or json");

    const result = await executeProtectedRun({
      executable: parsed.command[0],
      args: parsed.command.slice(1),
      cwd: process.cwd(),
      environment,
      timeLimitMs,
      terminationGraceMs,
      trajectoryLimits,
      telemetryGraceMs,
      ...((transcriptPath || capturePath) ? {
        transcript: {
          path: resolve(transcriptPath ?? capturePath!),
          transport: transcriptPath ? "external-file" as const : "supervisor-captured-stdout" as const,
        },
      } : {}),
    });
    const json = `${JSON.stringify(result.receipt, null, 2)}\n`;
    if (output) writePrivateFileAtomic(resolve(output), json);
    const terminal = capturePath ? process.stderr : process.stdout;
    if (format === "json") terminal.write(json);
    else terminal.write(renderReceipt(result.receipt));
    return result.exitCode;
  } catch (error) {
    console.error(`agent-vigil: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n\n${protectedRunUsage()}`);
    return 2;
  }
}
