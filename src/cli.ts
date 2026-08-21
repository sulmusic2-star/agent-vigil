#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
import { generateSigningKey, publicKeyId, signReport, verifyReport } from "./signature.ts";
import { createPortableReceipt, type PortableReceipt } from "./portable.ts";
import { buildPortableGateReport } from "./gate.ts";
import { buildMaintainerChecks, loadPullRequestEvidence } from "./maintainer.ts";

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
  portableOutput?: string;
  githubSummary: boolean;
  strict?: boolean;
  minVerified?: number;
};

function usage(): string {
  return `agent-vigil ${VERSION}

Usage:
  vigil <transcript.jsonl|summary.md> [options]
  vigil demo
  vigil init [--repo <path>] [--force] [--portable --public-key <path>]
  vigil init --profile maintainer [--repo <path>] [--force]
  vigil doctor [--repo <path>] [--policy <path>] [--transcript <path>]
  vigil keygen --private <path> --public <path>
  vigil verify <receipt.json> [--public-key <path>]
  vigil gate <portable-receipt.json> [options]
  vigil maintainer --event <event.json> [options]

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
  --portable-output <p>  Write a compact signed receipt; requires --signing-key
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
  const takesValue = new Set(["--repo", "--base", "--head", "--test-cmd", "--format", "--output", "--sarif", "--min-verified", "--policy", "--policy-ref", "--signing-key", "--portable-output"]);
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
    if (arg === "--portable-output") options.portableOutput = value;
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
    const portable = args.includes("--portable");
    const profile = optionValue(args, "--profile") ?? "default";
    if (!new Set(["default", "maintainer"]).has(profile)) throw new Error("init --profile must be default or maintainer");
    const publicKey = optionValue(args, "--public-key");
    if (portable && profile === "maintainer") throw new Error("init --portable cannot be combined with --profile maintainer");
    if (portable && !publicKey) throw new Error("init --portable requires --public-key <Ed25519 public key>");
    if (!portable && publicKey) throw new Error("init --public-key is only valid with --portable");
    const result = initRepository(repo, args.includes("--force"), publicKey ? publicKeyId(resolve(publicKey)) : undefined, profile as "default" | "maintainer");
    console.log("Agent Vigil initialized.\n");
    for (const path of result.created) console.log(`  created ${path}`);
    for (const path of result.kept) console.log(`  kept    ${path} (use --force to replace)`);
    console.log(profile === "maintainer"
      ? "\nNext: replace the PR-template login, review the base-anchored limits, merge this setup first, then open a code PR with a regression test that fails on base and passes on head."
      : portable
      ? "\nNext: merge this base policy first, then generate a portable receipt after each code commit with --portable-output."
      : "\nNext: replace .agent-vigil/session.md with a real agent transcript or summary, push one PR, then require the Agent Vigil evidence status check.");
    return 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function withoutOption(args: string[], name: string): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) { index += 1; continue; }
    output.push(args[index]);
  }
  return output;
}

function runMaintainer(args: string[]): number {
  try {
    const eventOption = optionValue(args, "--event");
    if (!eventOption) throw new Error("maintainer requires --event <pull_request event JSON>");
    const options = parseArgs(withoutOption(args.slice(1), "--event"));
    const repo = resolve(options.repo);
    const eventPath = resolve(eventOption);
    const policy = loadPolicy(repo, options.policy, options.policyRef);
    if (!policy.value.maintainer) throw new Error("base policy does not contain a maintainer profile");
    if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) throw new Error(`invalid git range ${options.base}..${options.head}`);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const evidence = loadPullRequestEvidence(eventPath);
    if (evidence.baseSha && resolveGitRef(repo, evidence.baseSha) !== base) throw new Error(`event base ${evidence.baseSha} does not match selected base ${base}`);
    if (evidence.headSha && resolveGitRef(repo, evidence.headSha) !== head) throw new Error(`event head ${evidence.headSha} does not match selected head ${head}`);
    const inputs = [eventPath, ...(policy.path ? [policy.path] : [])];
    const results: CheckResult[] = [...checkWorkspaceBinding(repo, head, inputs)];
    results.push(...buildMaintainerChecks(repo, base, head, evidence, policy.value.maintainer));
    if (policy.value.testCommand) {
      results.push(...checkTestsPass([{ kind: "tests_pass", quote: "base policy requires the candidate test suite to pass", subject: "fresh candidate test suite" }], repo, policy.value.testCommand));
      results.push(...checkWorkspaceMutation(repo, inputs));
    }
    results.push(...checkIntegrity(repo, base, head));
    const rawEvent = readFileSync(eventPath);
    const eventHash = `sha256:${createHash("sha256").update(rawEvent).digest("hex")}`;
    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative(repo, policy.path) : undefined;
    const remote = git(repo, ["config", "--get", "remote.origin.url"]);
    const tree = git(repo, ["rev-parse", `${head}^{tree}`]);
    const reproduction = ["vigil maintainer", "--event", shellQuote(eventOption), "--repo", ".", "--base", base, "--head", head,
      ...(policy.gitPath ? ["--policy", shellQuote(policy.gitPath)] : policySource ? ["--policy", shellQuote(policySource)] : []),
      ...(policy.ref ? ["--policy-ref", policy.ref] : []),
    ].join(" ");
    const report = buildReport({
      transcript: eventOption,
      transcriptSha256: eventHash,
      transcriptFormat: "pull-request-evidence",
      repo,
      base,
      head,
      results,
      policy: { minVerified: policy.value.minVerified ?? 1, strict: policy.value.strict ?? true, source: policySource, sha256: policy.sha256 },
      repository: { ...(remote ? { remote } : {}), ...(tree ? { tree } : {}) },
      reproduction,
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
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
    console.log(`Signer key ID: ${publicKeyId(resolve(publicPath))}`);
    return 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function printReport(report: TrustReport, options: Pick<Options, "format">): void {
  if (options.format === "json") console.log(JSON.stringify(report, null, 2));
  else if (options.format === "markdown") console.log(renderMarkdown(report));
  else if (options.format === "sarif") console.log(JSON.stringify(toSarif(report), null, 2));
  else console.log(renderText(report));
}

function runGate(args: string[]): number {
  try {
    const options = parseArgs(args.slice(1));
    const receiptPath = options.transcript;
    if (!receiptPath) throw new Error("gate requires a portable receipt JSON path");
    const absoluteReceipt = resolve(options.repo, receiptPath);
    const receipt = JSON.parse(readFileSync(absoluteReceipt, "utf8")) as PortableReceipt;
    const report = buildPortableGateReport(receipt, {
      repo: resolve(options.repo),
      receiptPath: absoluteReceipt,
      base: options.base,
      head: options.head,
      ...(options.policy ? { policy: options.policy } : {}),
      ...(options.policyRef ? { policyRef: options.policyRef } : {}),
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
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
  if (argv[0] === "gate") return runGate(argv);
  if (argv[0] === "maintainer") return runMaintainer(argv);
  if (argv.includes("--help")) { console.log(usage()); return 0; }
  if (argv.includes("--version")) { console.log(VERSION); return 0; }
  let options: Options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(`agent-vigil: ${(error as Error).message}\n\n${usage()}`); return 2; }
  const repo = resolve(options.repo);
  if (options.portableOutput && !options.signingKey) {
    console.error("agent-vigil: --portable-output requires --signing-key");
    return 2;
  }
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
      ...(options.portableOutput ? [resolve(repo, options.portableOutput)] : []),
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
      ...(options.portableOutput ? ["--portable-output", shellQuote(options.portableOutput)] : []),
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
    if (options.portableOutput) {
      const portable = createPortableReceipt(report, resolve(options.signingKey!));
      const portablePath = resolve(repo, options.portableOutput);
      mkdirSync(dirname(portablePath), { recursive: true });
      writeFileSync(portablePath, `${JSON.stringify(portable, null, 2)}\n`);
    }
    printReport(report, options);
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
