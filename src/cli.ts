#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { buildReport, validateTrustReport, VERSION, type CheckResult } from "./report.ts";
import type { TrustReport } from "./report.ts";
import { renderMarkdown, renderResultMarkdown, renderResultText, renderText, toSarif, writeOutputs } from "./output.ts";
import { buildReportResultView, renderResultViewHtml } from "./result-view.ts";
import { runDemo } from "./demo.ts";
import { loadPolicy } from "./config.ts";
import { doctorRepository, initRepository, renderDoctor } from "./setup.ts";
import { generateSigningKey, publicKeyId, signReport, verifyReport } from "./signature.ts";
import { createPortableReceipt, type PortableReceipt } from "./portable.ts";
import { buildPortableGateReport } from "./gate.ts";
import { buildMaintainerChecks, loadPullRequestEvidence } from "./maintainer.ts";
import { routeIntegrity } from "./integrity-policy.ts";
import { checkOutOfDagReads } from "./detectors/agentic.ts";
import { compareReceipts, renderReceiptDelta } from "./receipt-diff.ts";
import { buildMergeGroupReport } from "./merge-group.ts";
import { appendPrivateFileAtomic, writePrivateFileAtomic, writePrivateFileAtomicWithin } from "./safe-output.ts";
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
  CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE,
  loadControlProof,
  verifyGitHubControlProofAttestation,
  writeControlProofPredicate,
} from "./control-proof-attestation.ts";
import { installKeylessControlProofAction } from "./control-proof-workflow.ts";
import {
  CONTROL_POLICY_PACKS,
  appendCorpusEntry,
  buildStatusReport,
  createCertificate,
  createSignedCertificate,
  createSingleRepositoryPolicy,
  loadCorpus,
  loadPolicy as loadCertificationPolicy,
  renderStatusReport,
  validateAnyCertificate,
} from "./certification.ts";
import { signControlProof, signedControlIdentity } from "./signed-control-proof.ts";
import { readBoundedJson } from "./upgrade/contracts.ts";
import { readBoundedRegularFile } from "./continuity/contracts.ts";
import { runContinuityCommand } from "./continuity/cli.ts";
import { runPublicPrReceiptCommand } from "./public-pr-receipt-cli.ts";
import { trustedGit, trustedGitOptional } from "./trusted-git.ts";
import {
  loadControlArguments,
  renderGuardCompatibility,
  runGuardCompatibility,
  type GuardHost,
} from "./guard-compat.ts";
import { renderGuardRoute, runGuardRoute } from "./guard-route.ts";
import { outcomeUsage, runMandateCommand, runOutcomeReceiptCommand } from "./outcome-cli.ts";

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
  receiptGitPath?: string;
  githubSummary: boolean;
  strict?: boolean;
  minVerified?: number;
};

function usage(): string {
  return `agent-vigil ${VERSION}

Usage:
  vigil <transcript.jsonl|summary.md> [options]
  vigil demo
  vigil init --action-sha <40-hex> [--repo <path>] [--force] [--portable --public-key <path>]
  vigil init --profile maintainer --action-sha <40-hex> [--repo <path>] [--force]
  vigil init --profile authority --action-sha <40-hex> [--repo <path>] [--force]
  vigil protect --action-sha <40-hex> [--repo <path>] [--force]
  vigil prove [--repo <path>] [--base <sha>] [--format text|json] [--output <path>]
  vigil guard-compat --host claude|codex --host-version <version> --host-executable <path> --control-name <name> --control-version <version> --control-executable <path> --policy <path> --configuration <path> [options]
  vigil guard-route --host claude|codex --host-version <version> --host-executable <path> --profile-home <disposable-path> [options]
  vigil certify record <control-proof.json> --organization <name> --repository <owner/name> --required-check <name> --output <path>
  vigil certify sign <proof-payload.json> --private-key <pem> --output <path>
  vigil certify record-signed <signed-proof.json> --public-key <pem> --organization <name> --repository <owner/name> --required-check <name> --output <path>
  vigil certify add <certificate.json> --corpus <corpus.jsonl>
  vigil certify status --corpus <corpus.jsonl> --policy <policy.json> [--as-of <time>] [--format text|json] [--output <path>]
  vigil certify policy --organization <name> --repository <owner/name> --required-check <name> --pack baseline|authority --output <path>
  vigil certify install-action --repo <path> --action-ref <full-commit-sha> [--force]
  vigil plan [--repo <path>] [--base <sha>] [--head <sha>] [--policy <path>] [--format text|json] [--output <path>]
  vigil proof-comment <receipt.json> [--verify-url <https-url>] [--output <path>]
  vigil receipt-view <receipt.json> [--format text|markdown|html|json] [--output <path>]
  vigil test-integrity [--repo <path>] [--base <sha>] [--head <sha>] [--strict] [--format <kind>] [--output <path>]
  vigil doctor [--repo <path>] [--policy <path>] [--transcript <path>]
  vigil keygen --private <path> --public <path>
  vigil verify <receipt.json> [--public-key <path>]
  vigil attest <receipt.json> --predicate-output <path>
  vigil verify-attestation <receipt.json> --repository <owner/name> [--signer-workflow <path>] [--allow-self-hosted]
  vigil attest-control <control-proof.json> --predicate-output <path>
  vigil verify-control-attestation <control-proof.json> --repository <owner/name> [--signer-workflow <path>] [--signer-digest <sha>] [--allow-self-hosted]
  vigil notary <receipt.json> --repository <owner/name> --head <sha> --policy-sha256 <digest> [--signer-workflow <path>] [--allow-self-hosted] [--output <path>]
\n${outcomeUsage()}
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
  vigil continuity <init|append|import-github|import-github-actions|verify|status|demo|install-action> [options]
  vigil pr-receipt <https://github.com/owner/repo/pull/number> --tool-ref <full-commit-sha> [--signing-key <private.pem>] [--output <receipt.json>]
  vigil pr-receipt verify <receipt.json> [--format text|json]
  vigil upgrade <init|doctor|check|verify|index> [options]

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

function guardCompatibilityUsage(): string {
  return `Agent Vigil guard compatibility

Usage:
  vigil guard-compat \\
    --host claude|codex \\
    --host-version <version> \\
    --host-executable <path> \\
    --control-name <name> \\
    --control-version <version> \\
    --control-executable <path> \\
    --policy <path> \\
    --configuration <path> \\
    [--control-artifact <path>] \\
    [--control-args <json-array-file>] \\
    [--timeout-ms <50-60000>] \\
    [--format text|json] \\
    [--output <path>]

The two built-in Bash canaries only print distinct allow and deny markers.
The control command is executed directly, without a shell. A process PASS
still leaves deployment on HOLD until a separate live-host routing test passes.`;
}

function runGuardCompatibilityCommand(args: string[]): number {
  try {
    if (args.includes("--help")) { console.log(guardCompatibilityUsage()); return 0; }
    const parsed = parseCommandArgs(args, new Set([
      "--host", "--host-version", "--host-executable", "--control-name", "--control-version",
      "--control-executable", "--control-artifact", "--control-args", "--policy", "--configuration",
      "--timeout-ms", "--format", "--output",
    ]));
    if (parsed.positional.length) throw new Error("guard-compat accepts options only");
    const required = (name: string): string => {
      const value = parsed.values.get(name);
      if (!value) throw new Error(`guard-compat requires ${name} <value>`);
      return value;
    };
    const host = required("--host") as GuardHost;
    if (host !== "claude" && host !== "codex") throw new Error("guard-compat --host must be claude or codex");
    const format = parsed.values.get("--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("guard-compat --format must be text or json");
    const timeoutValue = parsed.values.get("--timeout-ms");
    const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
    if (timeoutValue !== undefined && !Number.isInteger(timeoutMs)) throw new Error("guard-compat --timeout-ms must be an integer");
    const hostExecutable = resolve(required("--host-executable"));
    const controlExecutable = resolve(required("--control-executable"));
    const controlArtifact = parsed.values.get("--control-artifact") ? resolve(parsed.values.get("--control-artifact")!) : undefined;
    const argumentsPath = parsed.values.get("--control-args") ? resolve(parsed.values.get("--control-args")!) : undefined;
    const policyPath = resolve(required("--policy"));
    const configurationPath = resolve(required("--configuration"));
    const output = parsed.values.get("--output");
    assertGuardOutputIsDistinct(output, [
      hostExecutable,
      controlExecutable,
      controlArtifact ?? "",
      argumentsPath ?? "",
      policyPath,
      configurationPath,
    ]);
    const report = runGuardCompatibility({
      host,
      hostVersion: required("--host-version"),
      hostExecutable,
      controlName: required("--control-name"),
      controlVersion: required("--control-version"),
      controlExecutable,
      ...(controlArtifact ? { controlArtifact } : {}),
      ...(argumentsPath ? { controlArguments: loadControlArguments(argumentsPath) } : {}),
      policyPath,
      configurationPath,
      vigilVersion: VERSION,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (output) writePrivateFileAtomic(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    console.log(format === "json" ? JSON.stringify(report, null, 2) : renderGuardCompatibility(report));
    return report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${(error as Error).message}\n\n${guardCompatibilityUsage()}`);
    return 2;
  }
}

function guardRouteUsage(): string {
  return `Agent Vigil live-host routing drill

Usage:
  vigil guard-route \\
    --host claude|codex \\
    --host-version <version> \\
    --host-executable <path> \\
    --profile-home <disposable-path> \\
    [--timeout-ms <1000-300000>] \\
    [--format text|json] \\
    [--output <path>]

The profile directory must contain a file named
.agent-vigil-disposable-profile with the exact documented marker. The drill
temporarily installs one fail-closed hook, runs only two harmless printf
canaries in an empty workspace, removes its host configuration, and leaves
the marked authentication profile for the operator to delete. A one-host
PASS does not permit deployment or satisfy the two-host next-ticket gate.`;
}

function runGuardRouteCommand(args: string[]): number {
  try {
    if (args.includes("--help")) { console.log(guardRouteUsage()); return 0; }
    const parsed = parseCommandArgs(args, new Set([
      "--host", "--host-version", "--host-executable", "--profile-home",
      "--timeout-ms", "--format", "--output",
    ]));
    if (parsed.positional.length) throw new Error("guard-route accepts options only");
    const required = (name: string): string => {
      const value = parsed.values.get(name);
      if (!value) throw new Error(`guard-route requires ${name} <value>`);
      return value;
    };
    const host = required("--host") as GuardHost;
    if (host !== "claude" && host !== "codex") throw new Error("guard-route --host must be claude or codex");
    const format = parsed.values.get("--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("guard-route --format must be text or json");
    const timeoutValue = parsed.values.get("--timeout-ms");
    const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
    if (timeoutValue !== undefined && !Number.isInteger(timeoutMs)) throw new Error("guard-route --timeout-ms must be an integer");
    const hostExecutable = resolve(required("--host-executable"));
    const profileHome = resolve(required("--profile-home"));
    const output = parsed.values.get("--output");
    assertGuardOutputIsDistinct(output, [hostExecutable, join(profileHome, ".agent-vigil-disposable-profile")]);
    const report = runGuardRoute({
      host,
      hostVersion: required("--host-version"),
      hostExecutable,
      profileHome,
      vigilVersion: VERSION,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (output) writePrivateFileAtomic(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    console.log(format === "json" ? JSON.stringify(report, null, 2) : renderGuardRoute(report));
    return report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${(error as Error).message}\n\n${guardRouteUsage()}`);
    return 2;
  }
}

function runProve(args: string[]): number {
  try {
    const allowed = new Set(["prove", "--repo", "--base", "--format", "--output", "--json"]);
    const takesValue = new Set(["--repo", "--base", "--format", "--output"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed.has(arg)) throw new Error(`unknown prove argument: ${arg}`);
      if (takesValue.has(arg)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runCertify(args: string[]): number {
  try {
    const command = args[1];
    if (command === "install-action") {
      const parsed = parseCommandArgs(args.slice(1), new Set(["--repo", "--action-ref"]), new Set(["--force"]));
      const repo = parsed.values.get("--repo") ?? ".";
      const actionRef = parsed.values.get("--action-ref");
      if (parsed.positional.length || !actionRef) throw new Error("certify install-action requires --action-ref <full-commit-sha> and accepts optional --repo <path> and --force");
      const installed = installKeylessControlProofAction(repo, actionRef, parsed.flags.has("--force"));
      for (const path of installed.created) console.log(`Created ${path}`);
      for (const path of installed.kept) console.log(`Kept existing ${path}`);
      console.log(`Agent Vigil control proof is pinned to ${installed.actionCommit}.`);
      console.log("No private signing key is required. GitHub OIDC signs each proof, and the workflow retains the proof and bundle for 90 days.");
      return 0;
    }
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
    if (command === "sign") {
      const parsed = parseCommandArgs(args.slice(1), new Set(["--private-key", "--output"]));
      const privateKey = parsed.values.get("--private-key");
      const output = parsed.values.get("--output");
      if (parsed.positional.length !== 1 || !privateKey || !output) throw new Error("certify sign requires <proof-payload.json> --private-key <pem> --output <path>");
      const proof = signControlProof(readBoundedJson(resolve(parsed.positional[0]), 2 * 1024 * 1024, "signed proof payload"), resolve(privateKey));
      writePrivateFileAtomic(resolve(output), `${JSON.stringify(proof, null, 2)}\n`);
      console.log(`Signed control proof: ${proof.payload.status}`);
      console.log(`Control identity: ${signedControlIdentity(proof)}`);
      return proof.payload.status === "PASS" ? 0 : 2;
    }
    if (command === "record-signed") {
      const parsed = parseCommandArgs(args.slice(1), new Set(["--public-key", "--organization", "--repository", "--required-check", "--output"]));
      const publicKeyPath = parsed.values.get("--public-key");
      const organization = parsed.values.get("--organization");
      const repository = parsed.values.get("--repository");
      const requiredCheck = parsed.values.get("--required-check");
      const output = parsed.values.get("--output");
      if (parsed.positional.length !== 1 || !publicKeyPath || !organization || !repository || !requiredCheck || !output) throw new Error("certify record-signed requires <signed-proof.json> --public-key <pem> --organization <name> --repository <owner/name> --required-check <name> --output <path>");
      const certificate = createSignedCertificate({
        proof: readBoundedJson(resolve(parsed.positional[0]), 2 * 1024 * 1024, "signed control proof"),
        publicKeyPath: resolve(publicKeyPath),
        organization,
        repository,
        requiredCheck,
      });
      writePrivateFileAtomic(resolve(output), `${JSON.stringify(certificate, null, 2)}\n`);
      console.log(`Signed control certificate: ${certificate.proof.payload.status} · ${certificate.certificateHash}`);
      console.log(`Control identity: ${signedControlIdentity(certificate.proof)}`);
      return certificate.proof.payload.status === "PASS" ? 0 : 2;
    }
    if (command === "add") {
      const parsed = parseCommandArgs(args.slice(1), new Set(["--corpus"]));
      const corpus = parsed.values.get("--corpus");
      if (parsed.positional.length !== 1 || !corpus) throw new Error("certify add requires <certificate.json> --corpus <corpus.jsonl>");
      const certificate = validateAnyCertificate(readBoundedJson(resolve(parsed.positional[0]), 2 * 1024 * 1024, "control certificate"));
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
    throw new Error("certify requires record, sign, record-signed, add, status, or policy");
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runPlan(args: string[]): number {
  try {
    const allowed = new Set(["plan", "--repo", "--base", "--head", "--policy", "--format", "--output", "--json", "--github-summary"]);
    const takesValue = new Set(["--repo", "--base", "--head", "--policy", "--format", "--output"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed.has(arg)) throw new Error(`unknown plan argument: ${arg}`);
      if (takesValue.has(arg)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runProofComment(args: string[]): number {
  try {
    const parsed = parseCommandArgs(args, new Set(["--verify-url", "--output"]));
    if (parsed.positional.length !== 1) throw new Error("proof-comment requires exactly one full receipt JSON path");
    const { report } = loadReceipt(resolve(parsed.positional[0]));
    const rendered = renderProofComment(report, { verifyUrl: parsed.values.get("--verify-url") });
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runReceiptView(args: string[]): number {
  try {
    const parsed = parseCommandArgs(args, new Set(["--format", "--output"]));
    if (parsed.positional.length !== 1) throw new Error("receipt-view requires exactly one full receipt JSON path");
    const format = parsed.values.get("--format") ?? "html";
    if (!new Set(["text", "markdown", "html", "json"]).has(format)) throw new Error("receipt-view --format must be text, markdown, html, or json");
    const report = readBoundedJson(resolve(parsed.positional[0]), 16 * 1024 * 1024, "receipt") as TrustReport;
    if (report.schemaVersion !== "2" || !Array.isArray(report.results) || !report.summary || !report.policy) {
      throw new Error("receipt-view requires an Agent Vigil schema 2 receipt");
    }
    const verification = verifyReport(report);
    if (!verification.hashValid) throw new Error("receipt-view receipt content does not match receiptHash");
    if (verification.signatureValid === false) throw new Error("receipt-view receipt signature is invalid");
    const view = buildReportResultView(report);
    const rendered = format === "html"
      ? renderResultViewHtml(view)
      : format === "markdown"
        ? `${renderResultMarkdown(view)}\n`
        : format === "json"
          ? `${JSON.stringify(view, null, 2)}\n`
          : `${renderResultText(view)}\n`;
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return view.verdict === "PASS" ? 0 : view.verdict === "FAIL" ? 1 : 2;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    repo: ".",
    base: process.env.GITHUB_BASE_SHA || "HEAD~1",
    head: process.env.GITHUB_HEAD_SHA || "HEAD",
    format: "text",
    githubSummary: false,
  };
  const takesValue = new Set(["--repo", "--base", "--head", "--test-cmd", "--format", "--output", "--sarif", "--min-verified", "--policy", "--policy-ref", "--signing-key", "--portable-output", "--receipt-git-path"]);
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
    if (arg === "--receipt-git-path") options.receiptGitPath = value;
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

function validateCommandArgs(args: string[], command: string, valueOptions: string[], flagOptions: string[]): void {
  const values = new Set(valueOptions);
  const flags = new Set(flagOptions);
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (!values.has(arg) && !flags.has(arg)) throw new Error(`unknown ${command} argument: ${arg}`);
    if (seen.has(arg)) throw new Error(`${command} argument ${arg} may be provided only once`);
    seen.add(arg);
    if (values.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
    }
  }
}

function runInit(args: string[]): number {
  try {
    validateCommandArgs(args, "init", ["--repo", "--action-sha", "--profile", "--public-key"], ["--portable", "--attest", "--force"]);
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    const portable = args.includes("--portable");
    const attest = args.includes("--attest");
    const actionSha = optionValue(args, "--action-sha");
    const profile = optionValue(args, "--profile") ?? "default";
    if (!new Set(["default", "maintainer", "authority", "protect"]).has(profile)) throw new Error("init --profile must be default, maintainer, authority, or protect");
    const publicKey = optionValue(args, "--public-key");
    if (portable && profile !== "default") throw new Error("init --portable cannot be combined with a named profile");
    if (portable && !publicKey) throw new Error("init --portable requires --public-key <Ed25519 public key>");
    if (!portable && publicKey) throw new Error("init --public-key is only valid with --portable");
    if (attest) throw new Error("init --attest is disabled for candidate-executing workflows until a separately controlled signer is available");
    if (!/^[0-9a-f]{40}$/.test(actionSha ?? "")) throw new Error("init requires --action-sha <40 lowercase hex>");
    const result = initRepository(repo, args.includes("--force"), publicKey ? publicKeyId(resolve(publicKey)) : undefined, profile as "default" | "maintainer" | "authority" | "protect", false, actionSha);
    console.log("Agent Vigil scaffold prepared.\n");
    for (const path of result.created) console.log(`  created ${path}`);
    for (const path of result.kept) console.log(`  kept    ${path} (use --force to replace)`);
    console.log(profile === "maintainer"
      ? "\nNext: replace the PR-template login, review the base-anchored limits, merge this setup first, then open a code PR with a regression test that fails on base and passes on head."
      : profile === "authority"
      ? "\nNext: replace the task ID, paths, action classes, and expiry; point the workflow at a structured agent transcript; merge the contract before the code change."
      : portable
      ? "\nNext: merge this base policy first, then generate a portable receipt after each code commit with --portable-output."
      : "\nNext: replace .agent-vigil/session.md with a real transcript or summary and commit the controls. The generated job is evidence only; enforce it through an externally trusted required workflow or App check bound to the exact PR head, not the job name alone.");
    return 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runProtect(args: string[]): number {
  try {
    validateCommandArgs(args, "protect", ["--repo", "--action-sha"], ["--force", "--attest"]);
    const repo = resolve(optionValue(args, "--repo") ?? ".");
    if (args.includes("--attest")) throw new Error("protect --attest is disabled for candidate-executing workflows until a separately controlled signer is available");
    const actionSha = optionValue(args, "--action-sha");
    if (!/^[0-9a-f]{40}$/.test(actionSha ?? "")) throw new Error("protect requires --action-sha <40 lowercase hex>");
    const result = initRepository(repo, args.includes("--force"), undefined, "protect", false, actionSha);
    console.log("Agent Vigil protection scaffold prepared.\n");
    for (const path of result.created) console.log(`  created ${path}`);
    for (const path of result.kept) console.log(`  kept    ${path} (use --force to replace)`);
    const checks = doctorRepository(repo);
    console.log(`\n${renderDoctor(checks)}\n`);
    console.log("Next: review and commit the generated controls, then rerun doctor. The job name alone is not a merge trust root; enforcement requires an externally trusted required workflow or App check bound to the exact PR head.");
    const pendingGeneratedCommit = result.created.length > 0;
    return pendingGeneratedCommit ? 0 : checks.some((check) => check.status === "FAIL") ? 2 : 0;
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
    const advisories: CheckResult[] = [];
    results.push(...buildMaintainerChecks(repo, base, head, evidence, policy.value.maintainer, policy.value.testCommand));
    const authorityPlan = authorityPlanChecks(buildAuthorityPlan(repo, base, head, VERSION));
    results.push(...authorityPlan.results);
    advisories.push(...authorityPlan.advisories);
    if (policy.value.testCommand) {
      const testClaim = { kind: "tests_pass" as const, quote: "base policy requires the candidate test suite to pass", subject: "fresh candidate test suite" };
      const automatedReview = policy.value.maintainer.reviewMode === "automated" ? policy.value.maintainer.automatedReview : undefined;
      if (automatedReview?.commands.includes(policy.value.testCommand)) {
        if (!results.some((check) => check.ruleId === "tests-pass" && check.claim.quote === testClaim.quote)) results.push({
          claim: testClaim,
          verdict: "unverifiable",
          evidence: "the exact top-level test command was configured in automated review but was not reached after an earlier review failure",
          ruleId: "tests-pass",
          blocksPass: true,
        });
      } else {
        results.push(...checkTestsPass([testClaim], repo, policy.value.testCommand, automatedReview?.setupCommand, base, head));
      }
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
    const receiptRaw = readBoundedRegularFile(absoluteReceipt, 16 * 1024 * 1024, "portable receipt").toString("utf8");
    const receipt = JSON.parse(receiptRaw) as PortableReceipt;
    const report = buildPortableGateReport(receipt, {
      repo: resolve(options.repo),
      receiptPath: absoluteReceipt,
      ...(options.receiptGitPath ? { receiptGitPath: options.receiptGitPath, receiptRaw } : {}),
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
    const report = JSON.parse(readBoundedRegularFile(resolve(receiptPath), 16 * 1024 * 1024, "Agent Vigil receipt").toString("utf8")) as unknown;
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
      if (values.has(arg)) throw new Error(`duplicate option: ${arg}`);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      continue;
    }
    if (booleanOptions.has(arg)) {
      if (flags.has(arg)) throw new Error(`duplicate option: ${arg}`);
      flags.add(arg);
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return { positional, values, flags };
}

function assertGuardOutputIsDistinct(output: string | undefined, inputs: string[]): void {
  if (!output) return;
  const selected = resolve(output);
  const selectedExists = existsSync(selected);
  const selectedReal = selectedExists ? realpathSync(selected) : selected;
  const selectedStatus = selectedExists ? statSync(selected) : undefined;
  for (const input of inputs) {
    if (!input) continue;
    const requestedInput = resolve(input);
    if (selected === requestedInput) throw new Error("--output must not replace or alias a guard input");
    if (!existsSync(requestedInput)) continue;
    const realInput = realpathSync(requestedInput);
    if (selectedReal === realInput) throw new Error("--output must not replace or alias a guard input");
    if (selectedStatus) {
      const inputStatus = statSync(realInput);
      if (selectedStatus.dev === inputStatus.dev && selectedStatus.ino === inputStatus.ino) {
        throw new Error("--output must not replace or alias a guard input");
      }
    }
  }
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runAttestControl(args: string[]): number {
  try {
    const parsed = parseCommandArgs(args, new Set(["--predicate-output"]));
    const predicateOutput = parsed.values.get("--predicate-output");
    if (parsed.positional.length !== 1 || !predicateOutput) throw new Error("attest-control requires <control-proof.json> and --predicate-output <path>");
    const proofPath = parsed.positional[0];
    const predicate = writeControlProofPredicate(resolve(proofPath), resolve(predicateOutput));
    console.log("Agent Vigil control-proof attestation predicate prepared.");
    console.log(`  proof:    ${predicate.proof.receiptHash}`);
    console.log(`  decision: ${predicate.proof.status}`);
    console.log(`  source:   ${predicate.proof.sourceCommit}`);
    console.log(`  output:   ${predicateOutput}`);
    console.log(`  type:     ${CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE}`);
    console.log("The predicate contains hashes, the exact source commit, counts, and the decision. It does not contain repository paths, claims, or evidence text.");
    return 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runVerifyControlAttestation(args: string[]): number {
  try {
    const parsed = parseCommandArgs(args, new Set(["--repository", "--signer-workflow", "--signer-digest"]), new Set(["--allow-self-hosted"]));
    const repository = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    if (parsed.positional.length !== 1 || !repository) throw new Error("verify-control-attestation requires <control-proof.json> and --repository <owner/name>");
    const proofPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository}/.github/workflows/agent-vigil-control-proof.yml`;
    const verification = verifyGitHubControlProofAttestation(resolve(proofPath), repository, {
      signerWorkflow,
      ...(parsed.values.get("--signer-digest") ? { signerDigest: parsed.values.get("--signer-digest")! } : {}),
      allowSelfHosted: parsed.flags.has("--allow-self-hosted"),
    });
    const { proof } = loadControlProof(resolve(proofPath));
    console.log(`GitHub control-proof attestation: ${verification.valid ? "VALID" : "INVALID"}`);
    console.log(`Proof file: ${verification.subjectDigestValid ? "VALID" : "INVALID"}`);
    console.log(`Proof contents: ${verification.proofHashValid && verification.predicateValid ? "VALID" : "INVALID"}`);
    console.log(`Decision: ${proof.status}`);
    console.log(`Source commit: ${proof.sourceCommit}`);
    console.log(`Proof: ${proof.receiptHash}`);
    console.log(`Signer workflow: ${signerWorkflow}`);
    if (parsed.values.get("--signer-digest")) console.log(`Signer digest: ${parsed.values.get("--signer-digest")}`);
    return verification.valid ? 0 : 1;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function runCompare(args: string[]): number {
  try {
    const values = args.slice(1).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--format" && all[index - 1] !== "--output");
    if (values.length !== 2) throw new Error("compare requires before and after full receipt JSON paths");
    const format = optionValue(args, "--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("compare --format must be text or json");
    const before = JSON.parse(readBoundedRegularFile(resolve(values[0]), 16 * 1024 * 1024, "before Agent Vigil receipt").toString("utf8")) as unknown;
    const after = JSON.parse(readBoundedRegularFile(resolve(values[1]), 16 * 1024 * 1024, "after Agent Vigil receipt").toString("utf8")) as unknown;
    const delta = compareReceipts(before, after);
    const rendered = format === "json" ? `${JSON.stringify(delta, null, 2)}\n` : `${renderReceiptDelta(delta)}\n`;
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return delta.status === "PASS" ? 0 : delta.status === "FAIL" ? 1 : 2;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
    if (!takesValue.has(arg)) throw new Error(`unknown value argument: ${arg}`);
    if (values.has(arg)) throw new Error(`duplicate value argument: ${arg}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
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
  return readBoundedRegularFile(path, maximumBytes, label);
}

function runValue(args: string[]): number {
  try {
    const options = parseValueArgs(args);
    const receiptPath = resolve(options.receipt);
    const rawReceipt = readBoundedFile(receiptPath, 16 * 1024 * 1024, "value receipt");
    const report = validateTrustReport(JSON.parse(rawReceipt.toString("utf8")));
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--output") { if (output) throw new Error("duplicate --output"); output = value; continue; }
      const kind = flagKinds[flag];
      if (!kind) throw new Error(`unknown github-evidence argument: ${flag}`);
      if ((inputs as any)[kind]) throw new Error(`duplicate ${flag}`);
      (inputs as any)[kind] = value;
    }
    if (!inputs.event) throw new Error("github-evidence requires --event <event.json>");
    const bundle = buildGitHubEvidence(inputs as GitHubEvidenceInputs);
    const rendered = `${JSON.stringify(bundle, null, 2)}\n`;
    if (output) writePrivateFileAtomic(resolve(output), rendered);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        if (arg === "--format") {
          if (!new Set(["text", "json", "html"]).has(value)) throw new Error("compare-value --format must be text, json, or html");
          format = value as ComparisonFormat;
        } else output = value;
      } else if (arg.startsWith("--")) throw new Error(`unknown compare-value argument: ${arg}`);
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
    if (!integrity.results.length && integrity.advisories.length) {
      integrity.results.push({
        claim: { kind: "integrity", quote: "calibrated test-integrity scan", subject: "selected diff scanned" },
        verdict: "verified",
        evidence: `${integrity.advisories.length} lower-confidence finding(s) recorded for review without blocking this calibrated run`,
        ruleId: "integrity-scan",
        contributesToPass: true,
      });
    }
    for (const check of integrity.results) {
      if (check.ruleId === "integrity-scan" && check.verdict === "verified") check.contributesToPass = true;
    }
    const diffArgs = head === "WORKTREE" ? ["diff", "--no-color", base] : ["diff", "--no-color", base, head];
    const diff = trustedGit(repo, diffArgs);
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
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
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
    const verificationPolicy = options.policy || options.policyRef
      ? loadPolicy(repo, options.policy, options.policyRef)
      : undefined;
    const testCommand = options.testCmd ?? verificationPolicy?.value.testCommand;
    const loaded = loadTranscript(transcriptPath);
    const inputs = [
      transcriptPath,
      ...(contract.path ? [contract.path] : []),
      ...(verificationPolicy?.path ? [verificationPolicy.path] : []),
    ];
    const results: CheckResult[] = [...checkWorkspaceBinding(repo, head, inputs)];
    const advisories: CheckResult[] = [];
    const authority = buildAuthorityChecks(repo, base, head, loaded, contract.value);
    results.push(...authority.results);
    if (verificationPolicy) {
      results.push({
        claim: { kind: "integrity", quote: "base-selected verification policy", subject: "authority verification policy is bound" },
        verdict: "verified",
        evidence: `${verificationPolicy.sha256}${testCommand ? `; test command ${testCommand}` : "; no test command configured"}`,
        ruleId: "authority-verification-policy",
        contributesToPass: false,
      });
      if (testCommand) {
        results.push(...checkTestsPass([{
          kind: "tests_pass",
          quote: "base policy requires the authority candidate test suite to pass",
          subject: "fresh authority candidate tests",
        }], repo, testCommand, undefined, base, head));
      }
      results.push(...checkWorkspaceMutation(repo, inputs, head));
      const integrity = routeIntegrity(checkIntegrity(repo, base, head), verificationPolicy.value.integrityMode ?? "advisory");
      results.push(...integrity.results);
      advisories.push(...integrity.advisories);
    }
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
      ...(verificationPolicy?.gitPath ? ["--policy", shellQuote(verificationPolicy.gitPath)] : []),
      ...(verificationPolicy?.ref ? ["--policy-ref", verificationPolicy.ref] : []),
      ...(options.testCmd ? ["--test-cmd", shellQuote(options.testCmd)] : []),
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
      policy: {
        minVerified: Math.max(options.minVerified ?? 0, verificationPolicy?.value.minVerified ?? 1),
        strict: true,
        source: contract.source,
        sha256: contract.sha256,
      },
      repository: { ...(remote ? { remote } : {}), ...(tree ? { tree } : {}) },
      reproduction,
    });
    if (options.signingKey) report = signReport(report, resolve(options.signingKey));
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) { console.error(`agent-vigil: ${(error as Error).message}`); return 2; }
}

function git(repo: string, args: string[]): string | undefined {
  return trustedGitOptional(repo, args)?.trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function run(argv = process.argv.slice(2)): number {
  if (argv[0] === "demo") return runDemo(run);
  if (argv[0] === "continuity") return runContinuityCommand(argv.slice(1));
  if (argv[0] === "upgrade") return runUpgradeCommand(argv.slice(1));
  if (argv[0] === "protect") return runProtect(argv);
  if (argv[0] === "prove") return runProve(argv);
  if (argv[0] === "guard-compat") return runGuardCompatibilityCommand(argv);
  if (argv[0] === "guard-route") return runGuardRouteCommand(argv);
  if (argv[0] === "certify") return runCertify(argv);
  if (argv[0] === "plan") return runPlan(argv);
  if (argv[0] === "proof-comment") return runProofComment(argv);
  if (argv[0] === "receipt-view") return runReceiptView(argv);
  if (argv[0] === "test-integrity") return runTestIntegrity(argv);
  if (argv[0] === "init") return runInit(argv);
  if (argv[0] === "doctor") return runDoctor(argv);
  if (argv[0] === "keygen") return runKeygen(argv);
  if (argv[0] === "mandate") return runMandateCommand(argv.slice(1));
  if (argv[0] === "receipt") return runOutcomeReceiptCommand(argv.slice(1));
  if (argv[0] === "verify") return runVerify(argv);
  if (argv[0] === "attest") return runAttest(argv);
  if (argv[0] === "verify-attestation") return runVerifyAttestation(argv);
  if (argv[0] === "attest-control") return runAttestControl(argv);
  if (argv[0] === "verify-control-attestation") return runVerifyControlAttestation(argv);
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
  // Command-line input may strengthen a trusted policy, but it must never
  // silently lower the policy's objective-evidence threshold.
  const minVerified = Math.max(options.minVerified ?? 0, policy.value.minVerified ?? 1);
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
    const testClaims = claims.filter((claim) => claim.kind === "tests_pass");
    if (testCmd && testClaims.length === 0) testClaims.push({
      kind: "tests_pass",
      quote: "base policy requires the candidate test suite to pass",
      subject: "fresh candidate tests",
    });
    results.push(...checkTestsPass(testClaims, repo, testCmd, undefined, base, head));
    results.push(...checkWorkspaceMutation(repo, workspaceInputs, head));
    results.push(...checkFilesChanged(claims, repo, base, head));
    const changedClaims = new Set(claims.filter((claim) => claim.kind === "file_changed").map((claim) => claim.subject));
    results.push(...checkPathsExist(claims.filter((claim) => !changedClaims.has(claim.subject)), repo));
    results.push(...checkRunClaims(runClaims, loaded.toolCalls));
    results.push(...checkStepRepetition(loaded.toolCalls));
    const integrity = routeIntegrity([
      ...checkIntegrity(repo, base, head),
      ...checkOutOfDagReads(repo, base, head, loaded.toolCalls),
    ], policy.value.integrityMode ?? "advisory");
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
      writePrivateFileAtomicWithin(repo, options.portableOutput, `${JSON.stringify(portable, null, 2)}\n`);
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

if (isMainModule()) {
  const argv = process.argv.slice(2);
  if (argv[0] === "pr-receipt") {
    void runPublicPrReceiptCommand(argv.slice(1), { toolVersion: VERSION }).then((code) => process.exit(code));
  } else process.exit(run(argv));
}
