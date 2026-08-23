#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  duplicateOptionError,
  invalidGitRangeError,
  missingTranscriptError,
  optionRequiresValueError,
  portableSigningKeyError,
  receiptIntegrityError,
  reportCliError,
  repositoryUnavailableError,
  transcriptUnavailableError,
  unexpectedPositionalError,
  unknownOptionError,
} from "./cli-errors.ts";
import { loadTranscript, extractClaims, extractRunClaims } from "./transcript.ts";
import {
  checkCompletion,
  checkFilesChanged,
  checkIntegrity,
  checkIntegrityDiff,
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
import { routeIntegrity } from "./integrity-policy.ts";
import { compareReceipts, renderReceiptDelta } from "./receipt-diff.ts";
import { buildMergeGroupReport } from "./merge-group.ts";
import { appendPrivateFileAtomic, writePrivateFileAtomic } from "./safe-output.ts";
import { analyzeTrajectory, authorityContractTemplate, buildAuthorityChecks, classifyTranscriptActions, loadAuthorityContract } from "./authority.ts";
import {
  buildValueCard,
  renderValueCardHtml,
  renderValueCardMarkdown,
  renderValueCardText,
  type ChangeOutcome,
  type CostSource,
  type MaintainerDisposition,
} from "./value.ts";
import { buildGitHubEvidence, loadGitHubEvidence, type GitHubEvidenceInputs, type GitHubEvidenceSourceKind } from "./github-evidence.ts";
import { compareValueCards, loadValueCard, renderValueComparisonHtml, renderValueComparisonText } from "./value-compare.ts";
import {
  ATTESTATION_PREDICATE_TYPE,
  buildNotaryCheck,
  loadReceipt,
  verifyGitHubAttestation,
  writeAttestationPredicate,
} from "./attestation.ts";
import { runUpgradeCommand } from "./upgrade/cli.ts";
import { authorityPlanChecks, buildAuthorityPlan, renderAuthorityPlan, renderAuthorityPlanMarkdown } from "./authority-plan.ts";
import { renderProofComment } from "./proof-comment.ts";
import { buildControlProof, renderControlProof } from "./control-proof.ts";
import {
  CONTROL_POLICY_PACKS,
  appendCorpusEntry,
  buildStatusReport,
  createCertificate,
  createSingleRepositoryPolicy,
  loadCorpus,
  loadPolicy as loadCertificationPolicy,
  renderStatusReport,
  validateCertificate,
} from "./certification.ts";
import { readBoundedJson } from "./upgrade/contracts.ts";

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
  vigil init [--repo <path>] [--force] [--attest] [--portable --public-key <path>]
  vigil init --profile maintainer [--repo <path>] [--force] [--attest]
  vigil init --profile authority [--repo <path>] [--force] [--attest]
  vigil protect [--repo <path>] [--force] [--attest]
  vigil prove [--repo <path>] [--base <sha>] [--format text|json] [--output <path>]
  vigil certify record <control-proof.json> --organization <name> --repository <owner/name> --required-check <name> --output <path>
  vigil certify add <certificate.json> --corpus <corpus.jsonl>
  vigil certify status --corpus <corpus.jsonl> --policy <policy.json> [--as-of <time>] [--format text|json] [--output <path>]
  vigil certify policy --organization <name> --repository <owner/name> --required-check <name> --pack baseline|authority --output <path>
  vigil plan [--repo <path>] [--base <sha>] [--head <sha>] [--policy <path>] [--format text|json] [--output <path>]
  vigil proof-comment <receipt.json> [--verify-url <https-url>] [--output <path>]
  vigil test-integrity [--repo <path>] [--base <sha>] [--head <sha>] [--strict] [--format <kind>] [--output <path>]
  vigil doctor [--repo <path>] [--policy <path>] [--transcript <path>]
  vigil keygen --private <path> --public <path>
  vigil verify <receipt.json> [--public-key <path>]
  vigil attest <receipt.json> --predicate-output <path>
  vigil verify-attestation <receipt.json> --repository <owner/name> [--signer-workflow <path>] [--allow-self-hosted]
  vigil notary <receipt.json> --repository <owner/name> --head <sha> --policy-sha256 <digest> [--signer-workflow <path>] [--allow-self-hosted] [--output <path>]
  vigil compare <before-receipt.json> <after-receipt.json> [--format text|json] [--output <path>]
  vigil github-evidence --event <event.json> [GitHub API exports] [--output <path>]
  vigil value <receipt.json> [--transcript <session.jsonl>] [--cost-usd <amount>] [options]
  vigil compare-value <card.json>... [--format text|json|html] [--output <path>]
  vigil audit <change.diff> [--strict] [--format <kind>] [--output <path>] [--sarif <path>]
  vigil authority init [--output <path>]
  vigil authority <transcript.jsonl> --contract <authority.json> [--contract-ref <sha>] [options]
  vigil gate <portable-receipt.json> [options]
  vigil maintainer --event <event.json> [options]
  vigil merge-group --event <event.json> [options]
  vigil upgrade <init|doctor|plan|preflight|check|verify|evidence|resolve|enforce|index|publish|telemetry-register|telemetry> [options]

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
  --strict               Block on unresolved claims; for audit, block on static findings
  --min-verified <n>     Minimum objective verified claims (default: 1)
  --version              Print the version
  --help                 Show this help

Value options:
  --transcript <path>    Bind supported token usage to the receipt digest
  --github-evidence <p>  Import a hash-verified normalized GitHub evidence bundle
  --cost-usd <amount>    Attributed task cost; requires --cost-source
  --cost-source <kind>   provider-billed, subscription-allocated, or user-estimated
  --cost-evidence <path> Hash a local billing artifact without copying its contents
  --budget-usd <amount>  Predeclared task budget for WITHIN / EXCEEDED status
  --review-minutes <n>   Explicit human review duration
  --disposition <kind>   accepted, dismissed, changes-requested, or unreviewed
  --review-evidence <p>  Hash review or disposition evidence without copying it
  --outcome <kind>       merged, closed, reverted, hotfixed, incident-linked, or unknown
  --outcome-as-of <time> RFC3339-compatible downstream observation time
  --outcome-evidence <p> Hash merge or downstream evidence without copying it
  --task-class <name>    Local comparison category, such as bugfix or refactor
  --format <kind>        text, json, markdown, or html

Exit codes: 0 PASS · 1 FAIL · 2 INCONCLUSIVE or usage error`;
}

function runProve(args: string[]): number {
  try {
    const allowed = new Set(["prove", "--repo", "--base", "--format", "--output", "--json"]);
    const takesValue = new Set(["--repo", "--base", "--format", "--output"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed.has(arg)) {
        throw (arg.startsWith("--") ? unknownOptionError(arg) : unexpectedPositionalError());
      }
      if (takesValue.has(arg)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw optionRequiresValueError(arg);
        index += 1;
      }
    }
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    const baseRef = optionValue(args, "--base") ?? process.env.GITHUB_SHA ?? "HEAD";
    if (!existsSync(repo)) throw new Error(`repository not found: ${repo}`);
    if (!gitRefExists(repo, baseRef)) throw new Error(`invalid Git commit ${baseRef}`);
    const format = args.includes("--json") ? "json" : optionValue(args, "--format") ?? "text";
    if (!new Set(["text", "json"]).has(format)) throw new Error("prove --format must be text or json");
    const report = buildControlProof(repo, baseRef, VERSION);
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    console.log(format === "json" ? JSON.stringify(report, null, 2) : renderControlProof(report));
    return report.status === "PASS" ? 0 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runCertify(args: string[]): number {
  try {
    const command = args[1];
    if (command === "record") {
      const parsed = parseCommandArgs(args.slice(1), new Set(["--organization", "--repository", "--required-check", "--output"]));
      if (parsed.positional.length !== 1) throw new Error("certify record requires exactly one control-proof JSON path");
      const organization = parsed.values.get("--organization");
      const repository = parsed.values.get("--repository");
      const requiredCheck = parsed.values.get("--required-check");
      const output = parsed.values.get("--output");
      if (!organization || !repository || !requiredCheck || !output) throw new Error("certify record requires --organization, --repository, --required-check, and --output");
      const proof = readBoundedJson(resolve(parsed.positional[0]), 2 * 1024 * 1024, "control proof");
      const certificate = createCertificate({ proof, organization, repository, requiredCheck });
      writePrivateFileAtomic(resolve(output), `${JSON.stringify(certificate, null, 2)}\n`);
      console.log(`Control certificate: ${certificate.proof.status} · ${certificate.certificateHash}`);
      return certificate.proof.status === "PASS" ? 0 : 2;
    }
    if (command === "add") {
      const parsed = parseCommandArgs(args.slice(1), new Set(["--corpus"]));
      const corpus = parsed.values.get("--corpus");
      if (parsed.positional.length !== 1 || !corpus) throw new Error("certify add requires <certificate.json> --corpus <corpus.jsonl>");
      const certificate = validateCertificate(readBoundedJson(resolve(parsed.positional[0]), 2 * 1024 * 1024, "control certificate"));
      const corpusPath = resolve(corpus);
      const current = loadCorpus(corpusPath).map((entry) => JSON.stringify(entry)).join("\n");
      const { entry, line } = appendCorpusEntry(current, certificate);
      appendPrivateFileAtomic(corpusPath, line);
      console.log(`Added certificate ${entry.sequence} · ${entry.entryHash}`);
      return 0;
    }
    if (command === "status") {
      const parsed = parseCommandArgs(args.slice(1), new Set(["--corpus", "--policy", "--as-of", "--format", "--output"]));
      const corpus = parsed.values.get("--corpus");
      const policy = parsed.values.get("--policy");
      if (!corpus || !policy || parsed.positional.length) throw new Error("certify status requires --corpus <corpus.jsonl> --policy <policy.json>");
      const format = parsed.values.get("--format") ?? "text";
      if (format !== "text" && format !== "json") throw new Error("certify status --format must be text or json");
      const report = buildStatusReport(loadCertificationPolicy(resolve(policy)), loadCorpus(resolve(corpus)), parsed.values.get("--as-of") ?? new Date().toISOString());
      const rendered = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${renderStatusReport(report)}\n`;
      const output = parsed.values.get("--output");
      if (output) writePrivateFileAtomic(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(rendered);
      return report.status === "PASS" ? 0 : 2;
    }
    if (command === "policy") {
      const parsed = parseCommandArgs(args.slice(1), new Set(["--organization", "--repository", "--required-check", "--pack", "--max-age-hours", "--output"]));
      const organization = parsed.values.get("--organization");
      const repository = parsed.values.get("--repository");
      const requiredCheck = parsed.values.get("--required-check");
      const output = parsed.values.get("--output");
      const pack = parsed.values.get("--pack") ?? "authority";
      if (!organization || !repository || !requiredCheck || !output || parsed.positional.length) throw new Error("certify policy requires --organization, --repository, --required-check, and --output");
      if (!(pack in CONTROL_POLICY_PACKS)) throw new Error("certify policy --pack must be baseline or authority");
      const maxAgeRaw = parsed.values.get("--max-age-hours");
      const maxAgeHours = maxAgeRaw === undefined ? undefined : Number(maxAgeRaw);
      const generated = createSingleRepositoryPolicy({ organization, repository, requiredCheck, pack: pack as keyof typeof CONTROL_POLICY_PACKS, ...(maxAgeHours === undefined ? {} : { maxAgeHours }) });
      writePrivateFileAtomic(resolve(output), `${JSON.stringify(generated, null, 2)}\n`);
      console.log(`Created ${pack} control policy with a ${generated.maxAgeHours}-hour proof window.`);
      return 0;
    }
    throw new Error("certify requires record, add, status, or policy");
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runPlan(args: string[]): number {
  try {
    const allowed = new Set(["plan", "--repo", "--base", "--head", "--policy", "--format", "--output", "--json", "--github-summary"]);
    const takesValue = new Set(["--repo", "--base", "--head", "--policy", "--format", "--output"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed.has(arg)) {
        throw (arg.startsWith("--") ? unknownOptionError(arg) : unexpectedPositionalError());
      }
      if (takesValue.has(arg)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw optionRequiresValueError(arg);
        index += 1;
      }
    }
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    const baseRef = optionValue(args, "--base") ?? process.env.GITHUB_BASE_SHA ?? "HEAD~1";
    const headRef = optionValue(args, "--head") ?? process.env.GITHUB_HEAD_SHA ?? "HEAD";
    if (!existsSync(repo)) throw new Error(`repository not found: ${repo}`);
    if (!gitRefExists(repo, baseRef) || !gitRefExists(repo, headRef)) throw new Error(`invalid git range ${baseRef}..${headRef}`);
    const format = args.includes("--json") ? "json" : optionValue(args, "--format") ?? "text";
    if (!new Set(["text", "json", "markdown"]).has(format)) throw new Error("plan --format must be text, json, or markdown");
    const policyPath = optionValue(args, "--policy");
    if (policyPath && (isAbsolute(policyPath) || policyPath === ".." || policyPath.startsWith("../") || policyPath.includes("\\"))) {
      throw new Error("plan --policy must be a repository-relative POSIX path");
    }
    const report = buildAuthorityPlan(repo, baseRef, headRef, VERSION, policyPath);
    const rendered = format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : format === "markdown"
        ? renderAuthorityPlanMarkdown(report)
        : `${renderAuthorityPlan(report)}\n`;
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(rendered);
    if (args.includes("--github-summary")) {
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (!summaryPath) throw new Error("--github-summary requires GITHUB_STEP_SUMMARY");
      appendPrivateFileAtomic(resolve(summaryPath), renderAuthorityPlanMarkdown(report));
    }
    return report.status === "PASS" ? 0 : report.status === "BLOCK" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runProofComment(args: string[]): number {
  try {
    const parsed = parseCommandArgs(args, new Set(["--verify-url", "--output"]));
    if (parsed.positional.length !== 1) throw new Error("proof-comment requires exactly one full receipt JSON path");
    let report: TrustReport;
    try { ({ report } = loadReceipt(resolve(parsed.positional[0]))); }
    catch { throw receiptIntegrityError(); }
    const rendered = renderProofComment(report, { verifyUrl: parsed.values.get("--verify-url") });
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) { return reportCliError("agent-vigil", error); }
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
    if (!takesValue.has(arg)) {
      throw (arg.startsWith("--") ? unknownOptionError(arg) : unexpectedPositionalError());
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw optionRequiresValueError(arg);
    if (arg === "--repo") options.repo = value;
    if (arg === "--base") options.base = value;
    if (arg === "--head") options.head = value;
    if (arg === "--test-cmd") options.testCmd = value;
    if (arg === "--format") {
      if (!new Set(["text", "json", "markdown", "sarif"]).has(value)) throw new Error("--format must be text, json, markdown, or sarif");
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
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw optionRequiresValueError(name);
  return args[index + 1];
}

function runInit(args: string[]): number {
  try {
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    const portable = args.includes("--portable");
    const attest = args.includes("--attest");
    const profile = optionValue(args, "--profile") ?? "default";
    if (!new Set(["default", "maintainer", "authority", "protect"]).has(profile)) throw new Error("init --profile must be default, maintainer, authority, or protect");
    const publicKey = optionValue(args, "--public-key");
    if (portable && profile !== "default") throw new Error("init --portable cannot be combined with a named profile");
    if (portable && !publicKey) throw new Error("init --portable requires --public-key <Ed25519 public key>");
    if (!portable && publicKey) throw new Error("init --public-key is only valid with --portable");
    const result = initRepository(repo, args.includes("--force"), publicKey ? publicKeyId(resolve(publicKey)) : undefined, profile as "default" | "maintainer" | "authority" | "protect", attest);
    console.log("Agent Vigil initialized.\n");
    for (const path of result.created) console.log(`  created ${path}`);
    for (const path of result.kept) console.log(`  kept    ${path} (use --force to replace)`);
    console.log(profile === "maintainer"
      ? "\nNext: replace the PR-template login, review the base-anchored limits, merge this setup first, then open a code PR with a regression test that fails on base and passes on head."
      : profile === "authority"
      ? "\nNext: replace the task ID, paths, action classes, and expiry; point the workflow at a structured agent transcript; merge the contract before the code change."
      : portable
      ? "\nNext: merge this base policy first, then generate a portable receipt after each code commit with --portable-output."
      : attest
      ? "\nNext: replace .agent-vigil/session.md with real evidence, push one PR, verify its GitHub attestation, then require the Agent Vigil evidence status check."
      : "\nNext: replace .agent-vigil/session.md with a real agent transcript or summary, push one PR, then require the Agent Vigil evidence status check.");
    if (attest && profile !== "default") {
      console.log("Next for signing: push one pull request, download agent-vigil-report.json, and run vigil verify-attestation before making the check required.");
    }
    return 0;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runProtect(args: string[]): number {
  try {
    const allowed = new Set(["protect", "--repo", "--force", "--attest"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed.has(arg)) {
        throw (arg.startsWith("--") ? unknownOptionError(arg) : unexpectedPositionalError());
      }
      if (arg === "--repo") index += 1;
    }
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    const result = initRepository(repo, args.includes("--force"), undefined, "protect", args.includes("--attest"));
    console.log("Agent Vigil protection installed.\n");
    for (const path of result.created) console.log(`  created ${path}`);
    for (const path of result.kept) console.log(`  kept    ${path} (use --force to replace)`);
    const checks = doctorRepository(repo);
    console.log(`\n${renderDoctor(checks)}\n`);
    console.log("Next: review the discovered commands and limits in .agent-vigil.json, commit the setup, push one pull request, then require the Agent Vigil evidence check.");
    return checks.some((check) => check.status === "FAIL") ? 2 : 0;
  } catch (error) { return reportCliError("agent-vigil", error); }
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
    const advisories: CheckResult[] = [];
    results.push(...buildMaintainerChecks(repo, base, head, evidence, policy.value.maintainer));
    const authorityPlan = authorityPlanChecks(buildAuthorityPlan(repo, base, head, VERSION));
    results.push(...authorityPlan.results);
    advisories.push(...authorityPlan.advisories);
    if (policy.value.testCommand) {
      results.push(...checkTestsPass([{ kind: "tests_pass", quote: "base policy requires the candidate test suite to pass", subject: "fresh candidate test suite" }], repo, policy.value.testCommand));
      results.push(...checkWorkspaceMutation(repo, inputs, head));
    }
    const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
    results.push(...integrity.results);
    advisories.push(...integrity.advisories);
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
      advisories,
      policy: { minVerified: policy.value.minVerified ?? 1, strict: policy.value.strict ?? true, source: policySource, sha256: policy.sha256 },
      repository: { ...(remote ? { remote } : {}), ...(tree ? { tree } : {}) },
      reproduction,
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runMergeGroup(args: string[]): number {
  try {
    const eventOption = optionValue(args, "--event");
    if (!eventOption) throw new Error("merge-group requires --event <merge_group event JSON>");
    const options = parseArgs(withoutOption(args.slice(1), "--event"));
    if (!options.policy || !options.policyRef) throw new Error("merge-group requires --policy and a base-anchored --policy-ref");
    const report = buildMergeGroupReport({
      repo: options.repo,
      eventPath: eventOption,
      base: options.base,
      head: options.head,
      policy: options.policy,
      policyRef: options.policyRef,
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runDoctor(args: string[]): number {
  try {
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    const checks = doctorRepository(repo, optionValue(args, "--policy"), optionValue(args, "--transcript"));
    console.log(renderDoctor(checks));
    return checks.some((check) => check.status === "FAIL") ? 2 : 0;
  } catch (error) { return reportCliError("agent-vigil", error); }
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
  } catch (error) { return reportCliError("agent-vigil", error); }
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
  } catch (error) { return reportCliError("agent-vigil", error); }
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
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function parseCommandArgs(args: string[], valueOptions: Set<string>, booleanOptions = new Set<string>()): {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
} {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (valueOptions.has(arg)) {
      if (values.has(arg)) throw duplicateOptionError(arg);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw optionRequiresValueError(arg);
      values.set(arg, value);
      continue;
    }
    if (booleanOptions.has(arg)) {
      if (flags.has(arg)) throw duplicateOptionError(arg);
      flags.add(arg);
      continue;
    }
    throw unknownOptionError(arg);
  }
  return { positional, values, flags };
}

function runAttest(args: string[]): number {
  try {
    const parsed = parseCommandArgs(args, new Set(["--predicate-output"]));
    const predicateOutput = parsed.values.get("--predicate-output");
    if (parsed.positional.length !== 1 || !predicateOutput) throw new Error("attest requires <receipt.json> and --predicate-output <path>");
    const receiptPath = parsed.positional[0];
    const predicate = writeAttestationPredicate(resolve(receiptPath), resolve(predicateOutput));
    console.log("Agent Vigil attestation predicate prepared.");
    console.log(`  receipt:  ${predicate.receipt.receiptHash}`);
    console.log(`  decision: ${predicate.receipt.status}`);
    console.log(`  change:   ${predicate.receipt.base}..${predicate.receipt.head}`);
    console.log(`  output:   ${predicateOutput}`);
    console.log(`  type:     ${ATTESTATION_PREDICATE_TYPE}`);
    console.log("The predicate contains hashes, SHAs, counts, and the decision. It does not contain source code, prompts, or transcript text.");
    return 0;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runVerifyAttestation(args: string[]): number {
  try {
    const parsed = parseCommandArgs(args, new Set(["--repository", "--signer-workflow"]), new Set(["--allow-self-hosted"]));
    const repository = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    if (parsed.positional.length !== 1 || !repository) throw new Error("verify-attestation requires <receipt.json> and --repository <owner/name>");
    const receiptPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository}/.github/workflows/agent-vigil.yml`;
    const verification = verifyGitHubAttestation(resolve(receiptPath), repository, { signerWorkflow, allowSelfHosted: parsed.flags.has("--allow-self-hosted") });
    const { report } = loadReceipt(resolve(receiptPath));
    console.log(`GitHub attestation: ${verification.valid ? "VALID" : "INVALID"}`);
    console.log(`Receipt file: ${verification.subjectDigestValid ? "VALID" : "INVALID"}`);
    console.log(`Receipt contents: ${verification.receiptHashValid && verification.predicateValid ? "VALID" : "INVALID"}`);
    console.log(`Decision: ${report.summary.status}`);
    console.log(`Change: ${report.base}..${report.head}`);
    console.log(`Receipt: ${report.receiptHash}`);
    console.log(`Signer workflow: ${signerWorkflow}`);
    return verification.valid ? 0 : 1;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runNotary(args: string[]): number {
  try {
    const values = new Set(["--repository", "--head", "--policy-sha256", "--signer-workflow", "--output"]);
    const parsed = parseCommandArgs(args, values, new Set(["--allow-self-hosted"]));
    const repository = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    const head = parsed.values.get("--head");
    const policySha256 = parsed.values.get("--policy-sha256");
    if (parsed.positional.length !== 1 || !repository || !head || !policySha256) {
      throw new Error("notary requires <receipt.json>, --repository <owner/name>, --head <sha>, and --policy-sha256 <digest>");
    }
    const receiptPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository}/.github/workflows/agent-vigil.yml`;
    const verification = verifyGitHubAttestation(resolve(receiptPath), repository, { signerWorkflow, allowSelfHosted: parsed.flags.has("--allow-self-hosted") });
    const payload = buildNotaryCheck(resolve(receiptPath), verification, head, policySha256);
    const rendered = `${JSON.stringify(payload, null, 2)}\n`;
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return payload.conclusion === "success" ? 0 : payload.conclusion === "failure" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runCompare(args: string[]): number {
  try {
    const values = args.slice(1).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--format" && all[index - 1] !== "--output");
    if (values.length !== 2) throw new Error("compare requires before and after full receipt JSON paths");
    const format = optionValue(args, "--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("compare --format must be text or json");
    const before = JSON.parse(readFileSync(resolve(values[0]), "utf8")) as TrustReport;
    const after = JSON.parse(readFileSync(resolve(values[1]), "utf8")) as TrustReport;
    if (before.schemaVersion !== "2" || after.schemaVersion !== "2") throw new Error("compare supports full receipt schema 2 only");
    const delta = compareReceipts(before, after);
    const rendered = format === "json" ? `${JSON.stringify(delta, null, 2)}\n` : `${renderReceiptDelta(delta)}\n`;
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return delta.status === "PASS" ? 0 : delta.status === "FAIL" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

type ValueCliOptions = {
  receipt: string;
  transcript?: string;
  publicKey?: string;
  githubEvidence?: string;
  costUsd?: number;
  costSource?: CostSource;
  costEvidence?: string;
  budgetUsd?: number;
  reviewMinutes?: number;
  disposition?: MaintainerDisposition;
  reviewEvidence?: string;
  outcome?: ChangeOutcome;
  outcomeAsOf?: string;
  outcomeEvidence?: string;
  taskClass?: string;
  format: "text" | "json" | "markdown" | "html";
  output?: string;
};

function valueNumber(value: string, name: string): number {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error(`${name} must be a non-negative decimal number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a non-negative decimal number`);
  return parsed;
}

function parseValueArgs(args: string[]): ValueCliOptions {
  const takesValue = new Set([
    "--transcript", "--public-key", "--github-evidence", "--cost-usd", "--cost-source", "--cost-evidence",
    "--budget-usd", "--review-minutes", "--disposition", "--review-evidence", "--outcome", "--outcome-as-of", "--outcome-evidence",
    "--task-class", "--format", "--output",
  ]);
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!takesValue.has(arg)) throw unknownOptionError(arg);
    if (values.has(arg)) throw duplicateOptionError(arg);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw optionRequiresValueError(arg);
    values.set(arg, value);
  }
  if (positional.length !== 1) throw new Error("value requires exactly one full receipt JSON path");
  const format = values.get("--format") ?? "text";
  if (!new Set(["text", "json", "markdown", "html"]).has(format)) throw new Error("value --format must be text, json, markdown, or html");
  const costSource = values.get("--cost-source");
  if (costSource && !new Set(["provider-billed", "subscription-allocated", "user-estimated"]).has(costSource)) {
    throw new Error("value --cost-source must be provider-billed, subscription-allocated, or user-estimated");
  }
  const disposition = values.get("--disposition");
  if (disposition && !new Set(["accepted", "dismissed", "changes-requested", "unreviewed"]).has(disposition)) {
    throw new Error("value --disposition must be accepted, dismissed, changes-requested, or unreviewed");
  }
  const outcome = values.get("--outcome");
  if (outcome && !new Set(["merged", "closed", "reverted", "hotfixed", "incident-linked", "unknown"]).has(outcome)) {
    throw new Error("value --outcome must be merged, closed, reverted, hotfixed, incident-linked, or unknown");
  }
  const taskClass = values.get("--task-class");
  if (taskClass && (taskClass.length > 80 || /[\x00-\x1f\x7f]/.test(taskClass))) throw new Error("value --task-class must be at most 80 printable characters");
  return {
    receipt: positional[0],
    ...(values.get("--transcript") ? { transcript: values.get("--transcript") } : {}),
    ...(values.get("--public-key") ? { publicKey: values.get("--public-key") } : {}),
    ...(values.get("--github-evidence") ? { githubEvidence: values.get("--github-evidence") } : {}),
    ...(values.get("--cost-usd") ? { costUsd: valueNumber(values.get("--cost-usd")!, "value --cost-usd") } : {}),
    ...(costSource ? { costSource: costSource as CostSource } : {}),
    ...(values.get("--cost-evidence") ? { costEvidence: values.get("--cost-evidence") } : {}),
    ...(values.get("--budget-usd") ? { budgetUsd: valueNumber(values.get("--budget-usd")!, "value --budget-usd") } : {}),
    ...(values.get("--review-minutes") ? { reviewMinutes: valueNumber(values.get("--review-minutes")!, "value --review-minutes") } : {}),
    ...(disposition ? { disposition: disposition as MaintainerDisposition } : {}),
    ...(values.get("--review-evidence") ? { reviewEvidence: values.get("--review-evidence") } : {}),
    ...(outcome ? { outcome: outcome as ChangeOutcome } : {}),
    ...(values.get("--outcome-as-of") ? { outcomeAsOf: values.get("--outcome-as-of") } : {}),
    ...(values.get("--outcome-evidence") ? { outcomeEvidence: values.get("--outcome-evidence") } : {}),
    ...(taskClass ? { taskClass } : {}),
    format: format as ValueCliOptions["format"],
    ...(values.get("--output") ? { output: values.get("--output") } : {}),
  };
}

function readBoundedFile(path: string, maximumBytes: number, label: string): Buffer {
  const size = statSync(path).size;
  if (size > maximumBytes) throw new Error(`${label} is ${size} bytes; maximum is ${maximumBytes}`);
  return readFileSync(path);
}

function runValue(args: string[]): number {
  try {
    const options = parseValueArgs(args);
    const receiptPath = resolve(options.receipt);
    const rawReceipt = readBoundedFile(receiptPath, 16 * 1024 * 1024, "value receipt");
    const report = JSON.parse(rawReceipt.toString("utf8")) as TrustReport;
    if (report.schemaVersion !== "2" || !report.summary || typeof report.receiptHash !== "string") {
      throw new Error("value requires a full Agent Vigil receipt schema 2");
    }
    const verification = verifyReport(report, options.publicKey ? resolve(options.publicKey) : undefined);
    if (!verification.hashValid) throw new Error("value receipt hash is invalid");
    if (verification.signatureValid === false) throw new Error("value receipt signature is invalid");

    let transcriptPath: string | undefined;
    if (options.transcript) transcriptPath = resolve(options.transcript);
    else if (new Set(["codex", "claude-code", "authority/codex", "authority/claude-code"]).has(report.transcriptFormat)) {
      const candidates = [
        resolve(dirname(receiptPath), report.transcript),
        ...(isAbsolute(report.repo) ? [resolve(report.repo, report.transcript)] : []),
      ];
      transcriptPath = candidates.find((candidate) => existsSync(candidate));
    }
    let loaded;
    if (transcriptPath) {
      loaded = loadTranscript(transcriptPath);
      if (loaded.transcriptSha256 !== report.transcriptSha256) throw new Error("value transcript digest does not match the receipt");
    }

    const evidenceHash = (path: string | undefined, label: string): string | undefined => {
      if (!path) return undefined;
      const evidence = readBoundedFile(resolve(path), 64 * 1024 * 1024, label);
      return `sha256:${createHash("sha256").update(evidence).digest("hex")}`;
    };
    const costEvidenceSha256 = evidenceHash(options.costEvidence, "cost evidence");
    const github = options.githubEvidence ? loadGitHubEvidence(resolve(options.githubEvidence)) : undefined;
    const inferredDisposition = options.disposition ?? github?.inference.disposition;
    const inferredOutcome = options.outcome ?? github?.inference.outcome;
    const inferredOutcomeAsOf = options.outcomeAsOf ?? github?.inference.outcomeAsOf;
    const reviewEvidenceSha256 = evidenceHash(options.reviewEvidence, "review evidence")
      ?? (github && inferredDisposition === github.inference.disposition && github.inference.reviewEvidence === "EVIDENCE_HASHED" ? github.evidenceHash : undefined);
    const outcomeEvidenceSha256 = evidenceHash(options.outcomeEvidence, "outcome evidence")
      ?? (github && inferredOutcome === github.inference.outcome && github.inference.outcomeEvidence === "EVIDENCE_HASHED" ? github.evidenceHash : undefined);
    const card = buildValueCard({
      report,
      hashValid: true,
      signatureValid: verification.signatureValid,
      keyPinned: verification.keyPinned,
      usage: loaded?.usage,
      toolCalls: loaded?.toolCalls.length,
      failedToolCalls: loaded?.toolCalls.filter((call) => call.isError).length,
      values: {
        taskClass: options.taskClass,
        budgetUsd: options.budgetUsd,
        costUsd: options.costUsd,
        costSource: options.costSource,
        costEvidenceSha256,
        reviewMinutes: options.reviewMinutes,
        disposition: inferredDisposition,
        reviewEvidenceSha256,
        outcome: inferredOutcome,
        outcomeAsOf: inferredOutcomeAsOf,
        outcomeEvidenceSha256,
        ...(github ? { github: {
          evidenceHash: github.evidenceHash,
          ...(github.pullRequest ? { pullRequestNumber: github.pullRequest.number } : {}),
          ...(github.reviews ? { approvals: github.reviews.approved, changesRequested: github.reviews.changesRequested } : {}),
          ...(github.reviewComments ? { reviewComments: github.reviewComments.records } : {}),
          ...(github.actions?.runDurationSeconds !== undefined ? { actionsRunDurationSeconds: github.actions.runDurationSeconds } : {}),
          ...(github.actions?.jobDurationSeconds !== undefined ? { actionsJobDurationSeconds: github.actions.jobDurationSeconds } : {}),
          ...(github.actions?.jobs !== undefined ? { actionsJobs: github.actions.jobs } : {}),
          ...(github.actions?.failedJobs !== undefined ? { actionsFailedJobs: github.actions.failedJobs } : {}),
          actionsBilling: "UNAVAILABLE" as const,
        } } : {}),
        ...(loaded ? { trajectory: analyzeTrajectory(classifyTranscriptActions(loaded)) } : {}),
      },
    });
    const rendered = options.format === "json" ? `${JSON.stringify(card, null, 2)}\n`
      : options.format === "markdown" ? renderValueCardMarkdown(card)
        : options.format === "html" ? renderValueCardHtml(card)
          : renderValueCardText(card);
    if (options.output) writePrivateFileAtomic(resolve(options.output), rendered);
    else process.stdout.write(rendered);
    return card.valueVerdict === "POSITIVE" ? 0 : card.valueVerdict === "NEGATIVE" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runGitHubEvidence(args: string[]): number {
  try {
    const flagKinds: Record<string, GitHubEvidenceSourceKind> = {
      "--event": "event",
      "--pull-request": "pull-request",
      "--reviews": "reviews",
      "--review-comments": "review-comments",
      "--actions-run": "actions-run",
      "--actions-jobs": "actions-jobs",
      "--revert-commit": "revert-commit",
      "--hotfix-pull-request": "hotfix-pull-request",
      "--incident-issue": "incident-issue",
    };
    const inputs: Partial<GitHubEvidenceInputs> = {};
    let output: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index];
      if (!flag.startsWith("--")) throw unexpectedPositionalError();
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw optionRequiresValueError(flag);
      if (flag === "--output") { if (output) throw new Error("duplicate --output"); output = value; continue; }
      const kind = flagKinds[flag];
      if (!kind) throw unknownOptionError(flag);
      if ((inputs as any)[kind]) throw duplicateOptionError(flag);
      (inputs as any)[kind] = value;
    }
    if (!inputs.event) throw new Error("github-evidence requires --event <event.json>");
    const bundle = buildGitHubEvidence(inputs as GitHubEvidenceInputs);
    const rendered = `${JSON.stringify(bundle, null, 2)}\n`;
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runCompareValue(args: string[]): number {
  try {
    const paths: string[] = [];
    type ComparisonFormat = "text" | "json" | "html";
    let format: ComparisonFormat = "text";
    let output: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--format" || arg === "--output") {
        const value = args[++index];
        if (value === undefined || value.startsWith("--")) throw optionRequiresValueError(arg);
        if (arg === "--format") {
          if (!new Set(["text", "json", "html"]).has(value)) throw new Error("compare-value --format must be text, json, or html");
          format = value as ComparisonFormat;
        } else output = value;
      } else if (arg.startsWith("--")) throw unknownOptionError(arg);
      else paths.push(arg);
    }
    if (!paths.length) throw new Error("compare-value requires at least one Agent Value Card JSON path");
    const cards = paths.map(loadValueCard);
    const comparison = compareValueCards(cards, paths.length);
    const rendered = format === "json" ? `${JSON.stringify(comparison, null, 2)}\n`
      : format === "html" ? renderValueComparisonHtml(comparison) : renderValueComparisonText(comparison);
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return comparison.status === "COMPARABLE" ? 0 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runAudit(args: string[]): number {
  try {
    const options = parseArgs(args.slice(1));
    const diffPath = options.transcript;
    if (!diffPath) throw new Error("audit requires a unified Git diff path");
    const absolute = resolve(diffPath);
    const raw = readFileSync(absolute);
    if (raw.byteLength > 64 * 1024 * 1024) throw new Error("audit input exceeds the 64 MiB limit");
    const diff = raw.toString("utf8");
    const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const integrity = routeIntegrity(checkIntegrityDiff(diff), options.strict ? "blocking" : "advisory");
    if (!integrity.results.length && integrity.advisories.length) {
      integrity.results.push({
        claim: { kind: "integrity", quote: "static unified-diff audit", subject: "parseable unified Git diff audited" },
        verdict: "verified",
        evidence: `${integrity.advisories.length} heuristic finding(s) recorded as non-blocking advisories`,
        ruleId: "diff-audit-complete",
      });
    }
    const report = buildReport({
      transcript: relative(process.cwd(), absolute) || absolute,
      transcriptSha256: digest,
      transcriptFormat: "unified-git-diff",
      repo: "static-diff-audit",
      base: "unavailable",
      head: digest,
      results: integrity.results,
      advisories: integrity.advisories,
      policy: { minVerified: 1, strict: true, source: options.strict ? "built-in strict static diff policy" : "built-in advisory static diff policy", sha256: `sha256:${createHash("sha256").update(`agent-vigil-static-diff-v2:${options.strict ? "blocking" : "advisory"}`).digest("hex")}` },
      reproduction: `vigil audit ${shellQuote(diffPath)}${options.strict ? " --strict" : ""}`,
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runTestIntegrity(args: string[]): number {
  try {
    const options = parseArgs(args.slice(1));
    const repo = resolve(options.repo);
    if (!gitRefExists(repo, options.base) || (options.head !== "WORKTREE" && !gitRefExists(repo, options.head))) {
      throw new Error(`invalid git range ${options.base}..${options.head}`);
    }
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const checks = checkIntegrity(repo, base, head);
    const integrity = routeIntegrity(checks, options.strict ? "blocking" : "calibrated");
    for (const check of integrity.results) {
      if (check.ruleId === "integrity-scan" && check.verdict === "verified") check.contributesToPass = true;
    }
    const diffArgs = head === "WORKTREE" ? ["diff", "--no-color", base] : ["diff", "--no-color", base, head];
    const diff = execFileSync("git", diffArgs, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const digest = `sha256:${createHash("sha256").update(diff).digest("hex")}`;
    const policyName = options.strict ? "all static integrity findings block" : "calibrated high-confidence test integrity rules block";
    const report = buildReport({
      transcript: `${base}..${head}`,
      transcriptSha256: digest,
      transcriptFormat: "test-integrity-diff",
      repo,
      base,
      head,
      results: integrity.results,
      advisories: integrity.advisories,
      policy: {
        minVerified: 1,
        strict: true,
        source: policyName,
        sha256: `sha256:${createHash("sha256").update(`agent-vigil-test-integrity-v1:${options.strict ? "blocking" : "calibrated"}`).digest("hex")}`,
      },
      repository: {
        ...(git(repo, ["config", "--get", "remote.origin.url"]) ? { remote: git(repo, ["config", "--get", "remote.origin.url"]) } : {}),
        ...(head !== "WORKTREE" && git(repo, ["rev-parse", `${head}^{tree}`]) ? { tree: git(repo, ["rev-parse", `${head}^{tree}`]) } : {}),
      },
      reproduction: `vigil test-integrity --repo . --base ${base} --head ${head}${options.strict ? " --strict" : ""}`,
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function runAuthority(args: string[]): number {
  try {
    if (args[1] === "init") {
      const output = optionValue(args, "--output");
      const rendered = authorityContractTemplate();
      if (output) {
        writePrivateFileAtomic(resolve(output), rendered);
        console.log(`Created task-scoped authority contract ${output}. Review every allowed action and replace the task ID before use.`);
      } else process.stdout.write(rendered);
      return 0;
    }
    const contractOption = optionValue(args, "--contract");
    if (!contractOption) throw new Error("authority requires --contract <authority.json>");
    const contractRef = optionValue(args, "--contract-ref");
    let stripped = withoutOption(args.slice(1), "--contract");
    if (contractRef) stripped = withoutOption(stripped, "--contract-ref");
    const options = parseArgs(stripped);
    const transcriptOption = options.transcript;
    if (!transcriptOption) throw new Error("authority requires a structured agent transcript");
    const repo = resolve(options.repo);
    if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) throw new Error(`invalid git range ${options.base}..${options.head}`);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const transcriptPath = isAbsolute(transcriptOption) ? transcriptOption : resolve(repo, transcriptOption);
    if (!existsSync(transcriptPath)) throw new Error(`transcript not found: ${transcriptPath}`);
    const contract = loadAuthorityContract(repo, contractOption, contractRef);
    const loaded = loadTranscript(transcriptPath);
    const inputs = [transcriptPath, ...(contract.path ? [contract.path] : [])];
    const results: CheckResult[] = [...checkWorkspaceBinding(repo, head, inputs)];
    const advisories: CheckResult[] = [];
    const authority = buildAuthorityChecks(repo, base, head, loaded, contract.value);
    results.push(...authority.results);
    if (!contract.ref) advisories.push({
      claim: { kind: "authority_scope", subject: "authority trust root", quote: contract.source },
      verdict: "unverifiable",
      evidence: "the contract was loaded from the local filesystem; use --contract-ref <trusted-base-sha> in CI so candidate changes cannot widen their own authority",
      ruleId: "authority-contract-anchor",
      contributesToPass: false,
    });
    const remote = git(repo, ["config", "--get", "remote.origin.url"]);
    const tree = git(repo, ["rev-parse", `${head}^{tree}`]);
    const relativeTranscript = relative(repo, transcriptPath) || transcriptOption;
    const reproduction = [
      "vigil authority", shellQuote(relativeTranscript), "--contract", shellQuote(contract.gitPath ?? contractOption),
      ...(contract.ref ? ["--contract-ref", contract.ref] : []),
      "--repo", ".", "--base", base, "--head", head,
    ].join(" ");
    let report = buildReport({
      transcript: relativeTranscript,
      transcriptSha256: loaded.transcriptSha256,
      transcriptFormat: `authority/${loaded.format}`,
      repo,
      base,
      head,
      results,
      advisories,
      policy: { minVerified: 1, strict: true, source: contract.source, sha256: contract.sha256 },
      repository: { ...(remote ? { remote } : {}), ...(tree ? { tree } : {}) },
      reproduction,
    });
    if (options.signingKey) report = signReport(report, resolve(options.signingKey));
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) { return reportCliError("agent-vigil", error); }
}

function git(repo: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return undefined; }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function run(
  argv: ["upgrade", "publish" | "telemetry-register" | "telemetry", ...string[]],
): Promise<number>;
export function run(argv?: string[]): number;
export function run(argv = process.argv.slice(2)): number | Promise<number> {
  if (argv[0] === "demo") return runDemo(run);
  if (argv[0] === "upgrade") return runUpgradeCommand(argv.slice(1));
  if (argv[0] === "protect") return runProtect(argv);
  if (argv[0] === "prove") return runProve(argv);
  if (argv[0] === "certify") return runCertify(argv);
  if (argv[0] === "plan") return runPlan(argv);
  if (argv[0] === "proof-comment") return runProofComment(argv);
  if (argv[0] === "test-integrity") return runTestIntegrity(argv);
  if (argv[0] === "init") return runInit(argv);
  if (argv[0] === "doctor") return runDoctor(argv);
  if (argv[0] === "keygen") return runKeygen(argv);
  if (argv[0] === "verify") return runVerify(argv);
  if (argv[0] === "attest") return runAttest(argv);
  if (argv[0] === "verify-attestation") return runVerifyAttestation(argv);
  if (argv[0] === "notary") return runNotary(argv);
  if (argv[0] === "compare") return runCompare(argv);
  if (argv[0] === "github-evidence") return runGitHubEvidence(argv);
  if (argv[0] === "value") return runValue(argv);
  if (argv[0] === "compare-value") return runCompareValue(argv);
  if (argv[0] === "audit") return runAudit(argv);
  if (argv[0] === "authority") return runAuthority(argv);
  if (argv[0] === "gate") return runGate(argv);
  if (argv[0] === "maintainer") return runMaintainer(argv);
  if (argv[0] === "merge-group") return runMergeGroup(argv);
  if (argv.includes("--help")) { console.log(usage()); return 0; }
  if (argv.includes("--version")) { console.log(VERSION); return 0; }
  let options: Options;
  try { options = parseArgs(argv); }
  catch (error) { return reportCliError("agent-vigil", error); }
  const repo = resolve(options.repo);
  if (options.portableOutput && !options.signingKey) {
    return reportCliError("agent-vigil", portableSigningKeyError());
  }
  let policy;
  try { policy = loadPolicy(repo, options.policy, options.policyRef); }
  catch (error) { return reportCliError("agent-vigil", error); }
  const transcript = options.transcript ?? policy.value.transcript;
  if (!transcript) return reportCliError("agent-vigil", missingTranscriptError());
  const transcriptPath = isAbsolute(transcript) ? transcript : resolve(repo, transcript);
  const testCmd = options.testCmd ?? policy.value.testCommand;
  const strict = options.strict ?? policy.value.strict ?? false;
  const minVerified = options.minVerified ?? policy.value.minVerified ?? 1;
  if (!existsSync(transcriptPath)) return reportCliError("agent-vigil", transcriptUnavailableError());
  if (!existsSync(repo)) return reportCliError("agent-vigil", repositoryUnavailableError());
  if (!gitRefExists(repo, options.base) || (options.head !== "WORKTREE" && !gitRefExists(repo, options.head))) {
    return reportCliError("agent-vigil", invalidGitRangeError());
  }

  try {
    const loaded = loadTranscript(transcriptPath);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const claims = extractClaims(loaded.narrative);
    const runClaims = extractRunClaims(loaded.narrative);
    const results: CheckResult[] = [];
    const advisories: CheckResult[] = [];
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
    results.push(...checkWorkspaceMutation(repo, workspaceInputs, head));
    results.push(...checkFilesChanged(claims, repo, base, head));
    const changedClaims = new Set(claims.filter((claim) => claim.kind === "file_changed").map((claim) => claim.subject));
    results.push(...checkPathsExist(claims.filter((claim) => !changedClaims.has(claim.subject)), repo));
    results.push(...checkRunClaims(runClaims, loaded.toolCalls));
    results.push(...checkStepRepetition(loaded.toolCalls));
    const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
    results.push(...integrity.results);
    advisories.push(...integrity.advisories);
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
      advisories,
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
    return reportCliError("agent-vigil", error);
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) {
  Promise.resolve(run()).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = 2; },
  );
}
