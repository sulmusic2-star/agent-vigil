import { isAbsolute, relative, resolve } from "node:path";
import { writePrivateFileAtomic } from "../safe-output.ts";
import { publicKeyId } from "../signature.ts";
import { terminalSafe } from "../upgrade/presentation.ts";
import { appendContinuityEvent, initializeContinuityChain, verifyContinuityChain } from "./chain.ts";
import { loadContinuityPolicy, loadEventDraft } from "./contracts.ts";
import { evaluateContinuity } from "./decision.ts";
import { publicChainVerification, renderChainVerification, renderContinuityDecision } from "./presentation.ts";

const VALUE_FLAGS = new Set([
  "--output", "--chain", "--event", "--signing-key", "--public-key", "--format",
  "--policy", "--policy-ref", "--repo", "--now", "--environment",
]);
const BOOLEAN_FLAGS = new Set(["--json"]);

function usage(): string {
  return `Agent Vigil continuity — offline successor evidence for one exact receipt

Usage:
  vigil continuity init <receipt.json> --output <chain-directory>
  vigil continuity append --chain <directory> --event <event.json> [--signing-key <private.pem>]
  vigil continuity verify --chain <directory> [--public-key <public.pem>] [--format text|json] [--output <file>]
  vigil continuity status --chain <directory> --policy <policy.json> [--repo <path> --policy-ref <sha>] [--environment <name>] [--now <RFC3339>] [--format text|json] [--output <file>]

Examples:
  vigil continuity init agent-vigil-report.json --output .agent-vigil/continuity
  vigil continuity append --chain .agent-vigil/continuity --event refreshed.json --signing-key operator.pem
  vigil continuity verify --chain .agent-vigil/continuity --json
  vigil continuity status --chain .agent-vigil/continuity --policy .agent-vigil-continuity.json --repo . --policy-ref <base-commit-sha> --environment production

Exit codes:
  0 valid or CURRENT
  1 invalid or REVOKED
  2 usage or schema error
  3 HOLD
  4 EXPIRED`;
}

type Parsed = { positional: string[]; values: Map<string, string>; flags: Set<string> };

function allowed(parsed: Parsed, values: string[], flags: string[] = []): void {
  for (const key of parsed.values.keys()) if (!values.includes(key)) throw new Error(`${key} is not valid for this continuity command`);
  for (const key of parsed.flags) if (!flags.includes(key)) throw new Error(`${key} is not valid for this continuity command`);
}

function protectOutput(parsed: Parsed, chain: string, inputs: string[] = []): void {
  const output = parsed.values.get("--output");
  if (!output) return;
  const selected = resolve(output);
  const chainRoot = resolve(chain);
  const fromChain = relative(chainRoot, selected);
  if (!fromChain || (!fromChain.startsWith("..") && !isAbsolute(fromChain))) {
    throw new Error("--output must be outside the continuity chain directory");
  }
  if (inputs.some((input) => input && resolve(input) === selected)) throw new Error("--output must not replace a continuity input");
}

function parse(args: string[]): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) {
      if (values.has(arg)) throw new Error(`${arg} may be provided only once`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      index += 1;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      if (flags.has(arg)) throw new Error(`${arg} may be provided only once`);
      flags.add(arg);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown continuity option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, values, flags };
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.values.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function selectedFormat(parsed: Parsed): "text" | "json" {
  if (parsed.flags.has("--json") && parsed.values.has("--format")) throw new Error("use either --json or --format, not both");
  const format = parsed.flags.has("--json") ? "json" : parsed.values.get("--format") ?? "text";
  if (format !== "text" && format !== "json") throw new Error("--format must be text or json");
  return format;
}

function selectedNow(parsed: Parsed): Date {
  const raw = parsed.values.get("--now");
  if (!raw) return new Date();
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== raw) throw new Error("--now must be canonical RFC3339 UTC");
  return new Date(epoch);
}

function outputJson(path: string | undefined, value: unknown): void {
  if (path) writePrivateFileAtomic(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function runInit(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--output"]);
  if (parsed.positional.length !== 1) throw new Error("continuity init requires exactly one Agent Vigil receipt path");
  const output = required(parsed, "--output");
  const root = initializeContinuityChain(resolve(parsed.positional[0]), resolve(output));
  process.stdout.write([
    "Agent Vigil continuity chain initialized",
    `  historical verification: ${root.historicalVerification}`,
    `  root: ${root.rootHash}`,
    "  events: 0",
    "  next: append a typed observation, then evaluate it under a protected policy",
    "",
  ].join("\n"));
  return 0;
}

function runAppend(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--chain", "--event", "--signing-key"]);
  if (parsed.positional.length) throw new Error("continuity append accepts only named options");
  const chain = required(parsed, "--chain");
  const eventPath = required(parsed, "--event");
  const draft = loadEventDraft(resolve(eventPath));
  const event = appendContinuityEvent(resolve(chain), draft, parsed.values.get("--signing-key") ? resolve(parsed.values.get("--signing-key")!) : undefined);
  process.stdout.write([
    "Agent Vigil continuity event appended",
    `  sequence: ${event.sequence}`,
    `  kind: ${event.event.kind}`,
    `  event: ${event.eventId}`,
    `  hash: ${event.eventHash}`,
    `  signature: ${event.signature ? event.signature.keyId : "absent"}`,
    "",
  ].join("\n"));
  return 0;
}

function runVerify(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--chain", "--public-key", "--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity verify accepts only named options");
  const chain = required(parsed, "--chain");
  protectOutput(parsed, chain, [parsed.values.get("--public-key") ?? ""]);
  const pinned = parsed.values.get("--public-key") ? [publicKeyId(resolve(parsed.values.get("--public-key")!))] : undefined;
  const verified = verifyContinuityChain(resolve(chain), { pinnedEventKeyIds: pinned });
  const publicValue = publicChainVerification(verified);
  outputJson(parsed.values.get("--output"), publicValue);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(publicValue, null, 2)}\n` : `${renderChainVerification(verified)}\n`);
  return verified.valid ? 0 : 1;
}

function runStatus(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--chain", "--policy", "--policy-ref", "--repo", "--now", "--environment", "--public-key", "--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity status accepts only named options");
  const chain = required(parsed, "--chain");
  const policyPath = required(parsed, "--policy");
  protectOutput(parsed, chain, [policyPath, parsed.values.get("--public-key") ?? ""]);
  const policyRef = parsed.values.get("--policy-ref");
  const repo = parsed.values.get("--repo");
  if (Boolean(policyRef) !== Boolean(repo)) throw new Error("--policy-ref and --repo must be provided together");
  const policy = loadContinuityPolicy({ path: policyPath, ...(repo ? { repo: resolve(repo) } : {}), ...(policyRef ? { ref: policyRef } : {}) });
  const now = selectedNow(parsed);
  const pinned = parsed.values.get("--public-key") ? [publicKeyId(resolve(parsed.values.get("--public-key")!))] : undefined;
  const verified = verifyContinuityChain(resolve(chain), {
    now,
    maxClockSkewSeconds: policy.value.maxClockSkewSeconds,
    pinnedEventKeyIds: pinned,
  });
  const decision = evaluateContinuity(verified, policy, { now, environment: parsed.values.get("--environment") });
  outputJson(parsed.values.get("--output"), decision);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(decision, null, 2)}\n` : `${renderContinuityDecision(decision)}\n`);
  if (decision.continuity === "CURRENT") return 0;
  if (decision.continuity === "REVOKED") return 1;
  if (decision.continuity === "HOLD") return 3;
  return 4;
}

export function runContinuityCommand(args: string[]): number {
  if (!args.length || args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(usage());
    return 0;
  }
  const [command, ...rest] = args;
  try {
    if (command === "init") return runInit(rest);
    if (command === "append") return runAppend(rest);
    if (command === "verify") return runVerify(rest);
    if (command === "status") return runStatus(rest);
    throw new Error(`unknown continuity command: ${command}`);
  } catch (error) {
    console.error(`agent-vigil: ${terminalSafe(error instanceof Error ? error.message : String(error))}`);
    return 2;
  }
}
