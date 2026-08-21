#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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
  checkWorkspaceBinding,
  checkWorkspaceMutation,
  gitRefExists,
  resolveGitRef,
} from "./detectors/reality.ts";
import { buildReport, VERSION, type CheckResult } from "./report.ts";
import type { TrustReport } from "./report.ts";
import { renderMarkdown, renderText, toSarif, writeOutputs } from "./output.ts";
import { runDemo } from "./demo.ts";
import { loadPolicy } from "./config.ts";
import { doctorRepository, initRepository, renderDoctor } from "./setup.ts";
import { generateSigningKey, signReport, verifyReport } from "./signature.ts";

type Options = {
  transcript?: string;
  repo: string;
  testCmd?: string;
  base: string;
  head: string;
  format: "text" | "json" | "markdown" | "sarif";
  output?: string;
  sarif?: string;
  policy?: string;
  policyRef?: string;
  signingKey?: string;
  githubSummary: boolean;
  strict?: boolean;
  minVerified?: number;
};

function usage(): string {
  return `agent-vigil ${VERSION}

Usage:
  vigil <transcript.jsonl|summary.md> [options]
  vigil demo
  vigil init [--repo <path>] [--force]
  vigil doctor [--repo <path>] [--policy <path>] [--transcript <path>]
  vigil keygen --private <path> --public <path>
  vigil verify <receipt.json> [--public-key <path>]

Options:
  --repo <path>          Repository to verify (default: .)
  --base <sha>           Baseline commit (default: GITHUB_BASE_SHA or HEAD~1)
  --head <sha>           Head commit (default: GITHUB_HEAD_SHA or HEAD)
  --test-cmd <command>   Explicit verification command
  --format <kind>        text, json, markdown, or sarif
  --json                 Alias for --format json
  --output <path>        Write the full JSON receipt
  --sarif <path>         Also write SARIF 2.1.0
  --policy <path>        Policy JSON (default: .agent-vigil.json when present)
  --policy-ref <sha>     Load policy from a trusted Git commit instead of the worktree
  --signing-key <path>   Sign the receipt with an Ed25519 private key
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
  };
  const takesValue = new Set(["--repo", "--base", "--head", "--test-cmd", "--format", "--output", "--sarif", "--min-verified", "--policy", "--policy-ref", "--signing-key"]);
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
    if (arg === "--policy") options.policy = value;
    if (arg === "--policy-ref") options.policyRef = value;
    if (arg === "--signing-key") options.signingKey = value;
    if (arg === "--min-verified") options.minVerified = Number(value);
  }
  if (options.minVerified !== undefined && (!Number.isInteger(options.minVerified) || options.minVerified < 1)) {
    throw new Error("--min-verified must be a positive integer");
  }
  return options;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function runInit(args: string[]): number {
  try {
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    const result = initRepository(repo, args.includes("--force"));
    console.log("Agent Vigil initialized.\n");
    for (const path of result.created) console.log(`  created ${path}`);
    for (const path of result.kept) console.log(`  kept    ${path} (use --force to replace)`);
    console.log("\nNext: replace .agent-vigil/session.md with a real agent transcript or summary, push one PR, then require the Agent Vigil evidence status check.");
    return 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runDoctor(args: string[]): number {
  try {
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    const checks = doctorRepository(repo, optionValue(args, "--policy"), optionValue(args, "--transcript"));
    console.log(renderDoctor(checks));
    return checks.some((check) => check.status === "FAIL") ? 2 : 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runKeygen(args: string[]): number {
  try {
    const privatePath = optionValue(args, "--private");
    const publicPath = optionValue(args, "--public");
    if (!privatePath || !publicPath) throw new Error("keygen requires --private and --public paths");
    generateSigningKey(resolve(privatePath), resolve(publicPath));
    console.log(`Created Ed25519 private key ${privatePath} and public key ${publicPath}. Keep the private key out of Git.`);
    return 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runVerify(args: string[]): number {
  try {
    const receiptPath = args.find((arg, index) => index > 0 && !arg.startsWith("--") && args[index - 1] !== "--public-key");
    if (!receiptPath) throw new Error("verify requires a receipt JSON path");
    const report = JSON.parse(readFileSync(resolve(receiptPath), "utf8")) as TrustReport;
    if (report.schemaVersion !== "2") throw new Error(`unsupported receipt schema: ${String(report.schemaVersion)}`);
    const publicKey = optionValue(args, "--public-key");
    const result = verifyReport(report, publicKey ? resolve(publicKey) : undefined);
    console.log(`Receipt hash: ${result.hashValid ? "VALID" : "INVALID"}`);
    if (result.signatureValid !== undefined) {
      console.log(`Ed25519 signature: ${result.signatureValid ? "VALID" : "INVALID"} · ${result.keyPinned ? "pinned public key" : "embedded self-asserted key"}`);
      if (!result.keyPinned) console.log("Identity is not established until the public key is pinned through a trusted channel.");
    } else console.log("Signature: absent (content hash only)");
    return result.hashValid && result.signatureValid !== false ? 0 : 1;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function git(repo: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return undefined; }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function run(argv = process.argv.slice(2)): number {
  if (argv[0] === "demo") return runDemo(run);
  if (argv[0] === "init") return runInit(argv);
  if (argv[0] === "doctor") return runDoctor(argv);
  if (argv[0] === "keygen") return runKeygen(argv);
  if (argv[0] === "verify") return runVerify(argv);
  if (argv.includes("--help")) { console.log(usage()); return 0; }
  if (argv.includes("--version")) { console.log(VERSION); return 0; }
  let options: Options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(`agent-vigil: ${(error as Error).message}\n\n${usage()}`); return 2; }
  const repo = resolve(options.repo);
  let policy;
  try { policy = loadPolicy(repo, options.policy, options.policyRef); }
  catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
  const transcript = options.transcript ?? policy.value.transcript;
  if (!transcript) { console.error(usage()); return 2; }
  const transcriptPath = isAbsolute(transcript) ? transcript : resolve(repo, transcript);
  const testCmd = options.testCmd ?? policy.value.testCommand;
  const strict = options.strict ?? policy.value.strict ?? false;
  const minVerified = options.minVerified ?? policy.value.minVerified ?? 1;
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
    // Bind the execution context before a test command can create caches,
    // coverage files, build outputs, or other Git-visible artifacts.
    const workspaceInputs = [
      transcriptPath,
      ...(policy.path ? [policy.path] : []),
      ...(options.signingKey ? [resolve(options.signingKey)] : []),
    ];
    results.push(...checkWorkspaceBinding(repo, head, workspaceInputs));
    results.push(...checkTestsPass(claims, repo, testCmd));
    results.push(...checkWorkspaceMutation(repo, workspaceInputs));
    results.push(...checkFilesChanged(claims, repo, base, head));
    const changedClaims = new Set(claims.filter((claim) => claim.kind === "file_changed").map((claim) => claim.subject));
    results.push(...checkPathsExist(claims.filter((claim) => !changedClaims.has(claim.subject)), repo));
    results.push(...checkRunClaims(runClaims, loaded.toolCalls));
    results.push(...checkStepRepetition(loaded.toolCalls));
    results.push(...checkIntegrity(repo, base, head));
    results.push(...checkCompletion(claims, repo, base, head, results));

    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative(repo, policy.path) : undefined;
    const remote = git(repo, ["config", "--get", "remote.origin.url"]);
    const tree = head === "WORKTREE" ? undefined : git(repo, ["rev-parse", `${head}^{tree}`]);
    const relativeTranscript = relative(repo, transcriptPath) || transcript;
    const reproduction = [
      "vigil", shellQuote(relativeTranscript), "--repo", ".", "--base", base, "--head", head,
      ...(options.testCmd ? ["--test-cmd", shellQuote(options.testCmd)] : []),
      ...(policy.gitPath ? ["--policy", shellQuote(policy.gitPath)] : policySource ? ["--policy", shellQuote(policySource)] : []),
      ...(policy.ref ? ["--policy-ref", policy.ref] : []),
      ...(strict && !policy.value.strict ? ["--strict"] : []),
      ...(options.minVerified !== undefined ? ["--min-verified", String(options.minVerified)] : []),
    ].join(" ");
    let report = buildReport({
      transcript: relativeTranscript,
      transcriptSha256: loaded.transcriptSha256,
      transcriptFormat: loaded.format,
      repo,
      base,
      head,
      results,
      policy: { minVerified, strict, source: policySource, sha256: policy.sha256 },
      repository: { ...(remote ? { remote } : {}), ...(tree ? { tree } : {}) },
      reproduction,
    });
    if (options.signingKey) report = signReport(report, resolve(options.signingKey));
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
