#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTranscript, extractClaims, extractRunClaims } from "./transcript.ts";
import {
  checkCompletion,
  checkFilesChanged,
  checkIntegrity,
  checkPathsExist,
  checkRunClaims,
  checkStepRepetition,
  checkTestsPass,
  gitRefExists,
  resolveGitRef,
} from "./detectors/reality.ts";
import { buildReport, VERSION, type CheckResult } from "./report.ts";
import { renderMarkdown, renderText, toSarif, writeOutputs } from "./output.ts";
import { runDemo } from "./demo.ts";

type Options = {
  transcript?: string;
  repo: string;
  testCmd?: string;
  base: string;
  head: string;
  format: "text" | "json" | "markdown" | "sarif";
  output?: string;
  sarif?: string;
  githubSummary: boolean;
  strict: boolean;
  minVerified: number;
};

function usage(): string {
  return `agent-vigil ${VERSION}

Usage:
  vigil <transcript.jsonl|summary.md> [options]
  vigil demo

Options:
  --repo <path>          Repository to verify (default: .)
  --base <sha>           Baseline commit (default: GITHUB_BASE_SHA or HEAD~1)
  --head <sha>           Head commit (default: GITHUB_HEAD_SHA or HEAD)
  --test-cmd <command>   Explicit verification command
  --format <kind>        text, json, markdown, or sarif
  --json                 Alias for --format json
  --output <path>        Write the full JSON receipt
  --sarif <path>         Also write SARIF 2.1.0
  --github-summary       Append Markdown to GITHUB_STEP_SUMMARY
  --strict               INCONCLUSIVE when any claim remains unresolved
  --min-verified <n>     Minimum objective verified claims (default: 1)
  --version              Print the version
  --help                 Show this help

Exit codes: 0 PASS · 1 FAIL · 2 INCONCLUSIVE or usage error`;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    repo: ".",
    base: process.env.GITHUB_BASE_SHA || "HEAD~1",
    head: process.env.GITHUB_HEAD_SHA || "HEAD",
    format: "text",
    githubSummary: false,
    strict: false,
    minVerified: 1,
  };
  const takesValue = new Set(["--repo", "--base", "--head", "--test-cmd", "--format", "--output", "--sarif", "--min-verified"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--") && !options.transcript) { options.transcript = arg; continue; }
    if (arg === "--json") { options.format = "json"; continue; }
    if (arg === "--strict") { options.strict = true; continue; }
    if (arg === "--github-summary") { options.githubSummary = true; continue; }
    if (arg === "--help" || arg === "--version") continue;
    if (!takesValue.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = args[++index];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--repo") options.repo = value;
    if (arg === "--base") options.base = value;
    if (arg === "--head") options.head = value;
    if (arg === "--test-cmd") options.testCmd = value;
    if (arg === "--format") {
      if (!new Set(["text", "json", "markdown", "sarif"]).has(value)) throw new Error(`unsupported format: ${value}`);
      options.format = value as Options["format"];
    }
    if (arg === "--output") options.output = value;
    if (arg === "--sarif") options.sarif = value;
    if (arg === "--min-verified") options.minVerified = Number(value);
  }
  if (!Number.isInteger(options.minVerified) || options.minVerified < 1) throw new Error("--min-verified must be a positive integer");
  return options;
}

export function run(argv = process.argv.slice(2)): number {
  if (argv[0] === "demo") return runDemo(run);
  if (argv.includes("--help")) { console.log(usage()); return 0; }
  if (argv.includes("--version")) { console.log(VERSION); return 0; }
  let options: Options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(`agent-vigil: ${(error as Error).message}\n\n${usage()}`); return 2; }
  if (!options.transcript) { console.error(usage()); return 2; }

  const transcriptPath = resolve(options.transcript);
  const repo = resolve(options.repo);
  if (!existsSync(transcriptPath)) { console.error(`agent-vigil: transcript not found: ${transcriptPath}`); return 2; }
  if (!existsSync(repo)) { console.error(`agent-vigil: repository not found: ${repo}`); return 2; }
  if (!gitRefExists(repo, options.base) || (options.head !== "WORKTREE" && !gitRefExists(repo, options.head))) {
    console.error(`agent-vigil: invalid git range ${options.base}..${options.head}`);
    return 2;
  }

  try {
    const loaded = loadTranscript(transcriptPath);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const claims = extractClaims(loaded.narrative);
    const runClaims = extractRunClaims(loaded.narrative);
    const results: CheckResult[] = [];
    results.push(...checkTestsPass(claims, repo, options.testCmd));
    results.push(...checkFilesChanged(claims, repo, base, head));
    const changedClaims = new Set(claims.filter((claim) => claim.kind === "file_changed").map((claim) => claim.subject));
    results.push(...checkPathsExist(claims.filter((claim) => !changedClaims.has(claim.subject)), repo));
    results.push(...checkRunClaims(runClaims, loaded.toolCalls));
    results.push(...checkStepRepetition(loaded.toolCalls));
    results.push(...checkIntegrity(repo, base, head));
    results.push(...checkCompletion(claims, repo, base, head, results));

    const report = buildReport({
      transcript: options.transcript,
      transcriptSha256: loaded.transcriptSha256,
      transcriptFormat: loaded.format,
      repo,
      base,
      head,
      results,
      policy: { minVerified: options.minVerified, strict: options.strict },
    });
    writeOutputs(report, options);
    if (options.format === "json") console.log(JSON.stringify(report, null, 2));
    else if (options.format === "markdown") console.log(renderMarkdown(report));
    else if (options.format === "sarif") console.log(JSON.stringify(toSarif(report), null, 2));
    else console.log(renderText(report));
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${(error as Error).message}`);
    return 2;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) process.exit(run());
