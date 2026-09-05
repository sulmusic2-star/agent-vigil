import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildRunAutopsy, renderRunAutopsy } from "./autopsy.ts";
import { discoverAutopsyCandidates, type AutopsyCandidate, type AutopsyDiscovery } from "./autopsy-discovery.ts";
import { buildCursorExactCostEvidence, validateExactCostEvidence, type ExactCostEvidence } from "./cost-evidence.ts";
import { loadReceipt } from "./attestation.ts";
import { readRegularFileSnapshot } from "./safe-fs.ts";
import { writePrivateFileAtomic } from "./safe-output.ts";
import { verifyReport } from "./signature.ts";
import { loadTranscript, MAX_TRANSCRIPT_BYTES } from "./transcript.ts";
import { terminalSafe } from "./upgrade/presentation.ts";
import type { ChangeOutcome, MaintainerDisposition } from "./value.ts";

const MAX_COST_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_ACCEPTANCE_EVIDENCE_BYTES = 16 * 1024 * 1024;

const VALUE_OPTIONS = new Set([
  "--receipt",
  "--public-key",
  "--cost-evidence",
  "--cursor-usage-export",
  "--budget-usd",
  "--disposition",
  "--review-evidence",
  "--outcome",
  "--outcome-evidence",
  "--outcome-as-of",
  "--format",
  "--output",
]);
const FLAG_OPTIONS = new Set(["--list", "--json"]);
const DISPOSITIONS = new Set<MaintainerDisposition>(["accepted", "dismissed", "changes-requested", "unreviewed"]);
const OUTCOMES = new Set<ChangeOutcome>(["merged", "closed", "reverted", "hotfixed", "incident-linked", "unknown"]);

export function autopsyUsage(): string {
  return `Agent Vigil run autopsy

Usage:
  vigil autopsy [<transcript.jsonl>] [evidence options]
  vigil autopsy --list [--format text|json]

Evidence options:
  --receipt <receipt.json>              Exact Agent Vigil change receipt
  --public-key <public.pem>             Pin the receipt signer; required for EARNED
  --cost-evidence <cost.json>           Existing exact provider cost evidence
  --cursor-usage-export <usage.json>    Build exact Cursor cost evidence locally
  --budget-usd <amount>                 Compare exact cost with a declared budget
  --disposition <kind>                  accepted, dismissed, changes-requested, or unreviewed
  --review-evidence <path>              Hash the maintainer decision artifact
  --outcome <kind>                      merged, closed, reverted, hotfixed, incident-linked, or unknown
  --outcome-evidence <path>             Hash the downstream outcome artifact
  --outcome-as-of <time>                RFC3339 downstream observation time
  --format <kind>                       text or json
  --output <path>                       Write a private, atomic result file

Without a transcript path, Agent Vigil lists recent Codex and Claude Code runs
and asks you to choose when more than one is plausible. Transcript content,
prompts, and provider exports stay local and are never included in the result.

Exit codes: 0 EARNED | 1 NOT_EARNED | 2 NOT_CHECKED or usage error`;
}

type Parsed = {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
};

function parse(args: string[]): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      if (values.has(arg)) throw new Error(`duplicate option: ${arg}`);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      continue;
    }
    if (FLAG_OPTIONS.has(arg)) {
      if (flags.has(arg)) throw new Error(`duplicate option: ${arg}`);
      flags.add(arg);
      continue;
    }
    if (arg === "--help") { flags.add(arg); continue; }
    throw new Error(`unknown autopsy option: ${arg}`);
  }
  if (positional.length > 1) throw new Error("autopsy accepts at most one transcript path");
  return { positional, values, flags };
}

function discoveryRoots(environment: NodeJS.ProcessEnv) {
  const home = environment.HOME || homedir();
  const codexHome = environment.CODEX_HOME || join(home, ".codex");
  const claudeHome = environment.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return [
    { agent: "codex" as const, path: join(codexHome, "sessions"), maxDepth: 6 },
    { agent: "claude-code" as const, path: join(claudeHome, "projects"), maxDepth: 3 },
  ];
}

function renderCandidate(candidate: AutopsyCandidate, index: number): string {
  const repository = candidate.repository ? terminalSafe(candidate.repository) : "repository not identified";
  const branch = candidate.branch ? terminalSafe(candidate.branch) : "branch not identified";
  const selectable = candidate.selectable ? "ready" : "too large for the 50 MiB parser limit";
  return [
    `${index + 1}. ${terminalSafe(candidate.modifiedAt)} | ${candidate.agent} | ${selectable}`,
    `   ${repository} | ${branch}`,
    `   ${terminalSafe(candidate.path)}`,
  ].join("\n");
}

function renderDiscovery(discovery: AutopsyDiscovery): string {
  const lines = [
    "Agent Vigil found recent local agent runs.",
    `Scanned ${discovery.scannedFiles} transcript file(s); ${discovery.skippedOversized} exceed the parser limit.`,
  ];
  if (discovery.truncated) lines.push("Discovery reached its safety bound; results are partial.");
  if (!discovery.candidates.length) lines.push("No Codex or Claude Code JSONL transcripts were found.");
  else {
    lines.push("Choose one by passing its exact path to vigil autopsy:", "");
    discovery.candidates.forEach((candidate, index) => lines.push(renderCandidate(candidate, index)));
  }
  return `${lines.join("\n")}\n`;
}

function writeOrPrint(content: string, output: string | undefined): void {
  if (output) writePrivateFileAtomic(resolve(output), content);
  else process.stdout.write(content);
}

function discoveryResult(parsed: Parsed, environment: NodeJS.ProcessEnv): { path?: string; exitCode?: number } {
  const discovery = discoverAutopsyCandidates(discoveryRoots(environment));
  const format = parsed.flags.has("--json") ? "json" : parsed.values.get("--format") ?? "text";
  if (format !== "text" && format !== "json") throw new Error("autopsy --format must be text or json");
  const rendered = format === "json" ? `${JSON.stringify(discovery, null, 2)}\n` : renderDiscovery(discovery);
  const output = parsed.values.get("--output");
  if (parsed.flags.has("--list")) {
    assertOutputDistinct(output, discovery.candidates.map((candidate) => candidate.path));
    writeOrPrint(rendered, output);
    return { exitCode: 0 };
  }
  if (discovery.candidates.length === 1 && discovery.candidates[0].selectable) return { path: discovery.candidates[0].path };
  process.stdout.write(rendered);
  return { exitCode: 2 };
}

function sha256Evidence(path: string, label: string): string {
  const snapshot = readRegularFileSnapshot(resolve(path), MAX_ACCEPTANCE_EVIDENCE_BYTES, label);
  return `sha256:${createHash("sha256").update(snapshot.bytes).digest("hex")}`;
}

function numberOption(parsed: Parsed, name: string): number | undefined {
  const raw = parsed.values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function dispositionOption(parsed: Parsed): MaintainerDisposition | undefined {
  const raw = parsed.values.get("--disposition");
  if (raw === undefined) return undefined;
  if (!DISPOSITIONS.has(raw as MaintainerDisposition)) throw new Error("--disposition has an unsupported value");
  return raw as MaintainerDisposition;
}

function outcomeOption(parsed: Parsed): ChangeOutcome | undefined {
  const raw = parsed.values.get("--outcome");
  if (raw === undefined) return undefined;
  if (!OUTCOMES.has(raw as ChangeOutcome)) throw new Error("--outcome has an unsupported value");
  return raw as ChangeOutcome;
}

function assertOutputDistinct(output: string | undefined, inputs: string[]): void {
  if (!output) return;
  const selected = resolve(output);
  const selectedExists = existsSync(selected);
  const selectedStatus = selectedExists ? lstatSync(selected) : undefined;
  const selectedReal = selectedExists && !selectedStatus!.isSymbolicLink() ? realpathSync(selected) : selected;
  for (const input of inputs) {
    const inputPath = resolve(input);
    if (selected === inputPath) throw new Error("autopsy output must not replace an input file");
    if (!existsSync(inputPath) || selectedReal !== realpathSync(inputPath)) {
      if (!selectedExists || !existsSync(inputPath) || selectedStatus!.isSymbolicLink()) continue;
      const inputStatus = statSync(inputPath);
      if (selectedStatus!.dev !== inputStatus.dev || selectedStatus!.ino !== inputStatus.ino) continue;
    }
    throw new Error("autopsy output must not replace or alias an input file");
  }
}

function loadExactCost(parsed: Parsed, transcriptPath: string): ExactCostEvidence | undefined {
  const evidencePath = parsed.values.get("--cost-evidence");
  const usageExportPath = parsed.values.get("--cursor-usage-export");
  if (evidencePath && usageExportPath) throw new Error("use --cost-evidence or --cursor-usage-export, not both");
  if (evidencePath) {
    const bytes = readRegularFileSnapshot(resolve(evidencePath), MAX_COST_EVIDENCE_BYTES, "exact cost evidence").bytes;
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("exact cost evidence is not valid JSON"); }
    return validateExactCostEvidence(value);
  }
  if (usageExportPath) {
    return buildCursorExactCostEvidence({
      transcript: readRegularFileSnapshot(resolve(transcriptPath), MAX_TRANSCRIPT_BYTES, "transcript").bytes,
      usageExport: readRegularFileSnapshot(resolve(usageExportPath), MAX_PROVIDER_EXPORT_BYTES, "Cursor usage export").bytes,
    });
  }
  return undefined;
}

export function runAutopsyCommand(args: string[], environment: NodeJS.ProcessEnv = process.env): number {
  try {
    const parsed = parse(args);
    if (parsed.flags.has("--help")) { console.log(autopsyUsage()); return 0; }
    if (parsed.flags.has("--list") && parsed.positional.length) throw new Error("autopsy --list does not accept a transcript path");
    if (parsed.flags.has("--list")
      && [...parsed.values.keys()].some((name) => name !== "--format" && name !== "--output")) {
      throw new Error("autopsy --list accepts only --format and --output");
    }
    const format = parsed.flags.has("--json") ? "json" : parsed.values.get("--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("autopsy --format must be text or json");

    let transcriptPath: string | undefined = parsed.positional[0];
    if (!transcriptPath) {
      const discovered = discoveryResult(parsed, environment);
      if (discovered.exitCode !== undefined) return discovered.exitCode;
      transcriptPath = discovered.path;
    }
    if (!transcriptPath) throw new Error("autopsy could not select a transcript");
    transcriptPath = resolve(transcriptPath);

    const receiptPath = parsed.values.get("--receipt");
    const publicKeyPath = parsed.values.get("--public-key");
    if (publicKeyPath && !receiptPath) throw new Error("--public-key requires --receipt");
    const evidenceInputs = [
      transcriptPath,
      ...[receiptPath, publicKeyPath, parsed.values.get("--cost-evidence"), parsed.values.get("--cursor-usage-export"),
        parsed.values.get("--review-evidence"), parsed.values.get("--outcome-evidence")]
        .filter((value): value is string => Boolean(value)),
    ];
    assertOutputDistinct(parsed.values.get("--output"), evidenceInputs);

    const transcript = loadTranscript(transcriptPath);
    const receipt = receiptPath ? loadReceipt(resolve(receiptPath)) : undefined;
    const receiptVerification = receipt
      ? verifyReport(receipt.report, publicKeyPath ? resolve(publicKeyPath) : undefined)
      : undefined;
    const exactCost = loadExactCost(parsed, transcriptPath);
    const reviewEvidencePath = parsed.values.get("--review-evidence");
    const outcomeEvidencePath = parsed.values.get("--outcome-evidence");
    const budgetUsd = numberOption(parsed, "--budget-usd");
    const disposition = dispositionOption(parsed);
    const outcome = outcomeOption(parsed);
    const record = buildRunAutopsy({
      transcript,
      ...(receipt ? { report: receipt.report, receiptVerification } : {}),
      ...(exactCost ? { exactCost } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...(disposition ? { disposition } : {}),
      ...(reviewEvidencePath ? { reviewEvidenceSha256: sha256Evidence(reviewEvidencePath, "review evidence") } : {}),
      ...(outcome ? { outcome } : {}),
      ...(outcomeEvidencePath ? { outcomeEvidenceSha256: sha256Evidence(outcomeEvidencePath, "outcome evidence") } : {}),
      ...(parsed.values.get("--outcome-as-of") ? { outcomeAsOf: parsed.values.get("--outcome-as-of") } : {}),
    });
    const rendered = format === "json" ? `${JSON.stringify(record, null, 2)}\n` : renderRunAutopsy(record);
    writeOrPrint(rendered, parsed.values.get("--output"));
    return record.decision === "EARNED" ? 0 : record.decision === "NOT_EARNED" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n\n${autopsyUsage()}`);
    return 2;
  }
}
