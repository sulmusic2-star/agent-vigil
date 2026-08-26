import { isAbsolute, relative, resolve } from "node:path";
import { writePrivateFileAtomic } from "../safe-output.ts";
import { publicKeyId } from "../signature.ts";
import { terminalSafe } from "../upgrade/presentation.ts";
import { appendContinuityEvent, initializeContinuityChain, verifyContinuityChain } from "./chain.ts";
import { loadContinuityPolicy, loadEventDraft } from "./contracts.ts";
import { renderContinuityDemo, runContinuityDemo } from "./demo.ts";
import { evaluateContinuity } from "./decision.ts";
import { renderGuardContinuityDemo, runGuardContinuityDemo } from "./guard-demo.ts";
import { loadGuardRouteReport } from "./guard.ts";
import { githubRepositoryFromRemote, importGitHubActionsOutcome, importGitHubOutcome } from "./github.ts";
import { publicChainVerification, renderChainVerification, renderContinuityDecision } from "./presentation.ts";
import {
  DEFAULT_STAPLE_TTL_SECONDS,
  issueContinuityStaple,
  loadContinuityStaple,
  verifyContinuityStaple,
} from "./staple.ts";
import { verifyTerraformSavedPlan } from "./terraform.ts";
import { installContinuityAction } from "./workflow.ts";

const VALUE_FLAGS = new Set([
  "--output", "--chain", "--event", "--signing-key", "--public-key", "--format",
  "--policy", "--policy-ref", "--repo", "--now", "--environment", "--delivery-id",
  "--webhook-signature", "--webhook-secret-file", "--observed-at", "--expected-head",
  "--action-ref", "--source-workflow",
  "--expected-github-repository",
  "--claude-route", "--codex-route",
  "--ttl-seconds", "--minimum-sequence", "--expected-policy-sha256", "--expected-chain-tip", "--expected-receipt-hash",
  "--staple", "--terraform-executable", "--timeout-ms",
]);
const BOOLEAN_FLAGS = new Set(["--json", "--unavailable", "--force", "--self-serve"]);

function usage(): string {
  return `Agent Vigil continuity — offline successor evidence for one exact receipt

Usage:
  vigil continuity init <receipt.json> --output <chain-directory>
  vigil continuity append --chain <directory> --event <event.json> [--signing-key <private.pem>]
  vigil continuity import-github --chain <directory> --event <webhook.json> --delivery-id <uuid> --webhook-signature <sha256=...> --webhook-secret-file <file> [--signing-key <private.pem>]
  vigil continuity import-github --chain <directory> --unavailable --delivery-id <uuid> --observed-at <RFC3339> --signing-key <private.pem>
  vigil continuity import-github-actions --chain <directory> --signing-key <private.pem>
  vigil continuity demo [--format text|json] [--output <file>]
  vigil continuity guard-demo --claude-route <receipt.json> --codex-route <receipt.json> [--format text|json] [--output <file>]
  vigil continuity install-action --repo <path> --action-ref <full-commit-sha> [--source-workflow <name>] [--self-serve] [--force] [--format text|json]
  vigil continuity verify --chain <directory> [--expected-head <sha>] [--public-key <public.pem>] [--format text|json] [--output <file>]
  vigil continuity status --chain <directory> --policy <policy.json> [--repo <path> --policy-ref <sha>] [--environment <name>] [--expected-head <sha>] [--expected-github-repository <owner/name>] [--now <RFC3339>] [--format text|json] [--output <file>]
  vigil continuity staple --chain <directory> --policy <policy.json> --environment <name> --signing-key <private.pem> --output <staple.json> [--repo <path> --policy-ref <sha>] [--expected-head <sha>] [--now <RFC3339>] [--ttl-seconds <1-900>]
  vigil continuity verify-staple <staple.json> --public-key <public.pem> --expected-receipt-hash <sha256:...> --expected-head <sha> --environment <name> --expected-policy-sha256 <sha256:...> [--expected-chain-tip <sha256:...>] [--minimum-sequence <n>] [--now <RFC3339>] [--format text|json] [--output <file>]
  vigil continuity terraform-plan-gate <saved-plan> --staple <staple.json> --terraform-executable <path> --public-key <public.pem> --expected-receipt-hash <sha256:...> --expected-head <sha> --environment <name> --expected-policy-sha256 <sha256:...> [--expected-chain-tip <sha256:...>] [--minimum-sequence <n>] [--now <RFC3339>] [--timeout-ms <1000-120000>] [--format text|json] [--output <file>]

Examples:
  vigil continuity init agent-vigil-report.json --output .agent-vigil/continuity
  vigil continuity append --chain .agent-vigil/continuity --event refreshed.json --signing-key operator.pem
  vigil continuity import-github --chain .agent-vigil/continuity --event webhook.json --delivery-id <uuid> --webhook-signature <sha256=...> --webhook-secret-file webhook-secret.txt
  vigil continuity import-github-actions --chain .agent-vigil/continuity --signing-key "$RUNNER_TEMP/outcome-recorder.pem"
  vigil continuity verify --chain .agent-vigil/continuity --json
  vigil continuity status --chain .agent-vigil/continuity --policy .agent-vigil-continuity.json --repo . --policy-ref <base-commit-sha> --environment production
  vigil continuity staple --chain .agent-vigil/continuity --policy .agent-vigil-continuity.json --environment production --signing-key continuity-authority.pem --output continuity-staple.json
  vigil continuity verify-staple continuity-staple.json --public-key continuity-authority.pub --expected-receipt-hash <sha256:...> --expected-head <head-sha> --environment production --expected-policy-sha256 <sha256:...>
  vigil continuity terraform-plan-gate tfplan --staple continuity-staple.json --terraform-executable "$(command -v terraform)" --public-key continuity-authority.pub --expected-receipt-hash <sha256:...> --expected-head <head-sha> --environment production --expected-policy-sha256 <sha256:...>

Exit codes:
  0 valid or CURRENT
  1 invalid or REVOKED
  2 usage or schema error
  3 HOLD
  4 EXPIRED`;
}

function runImportGitHubActions(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--chain", "--signing-key", "--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity import-github-actions accepts only named options");
  const chain = required(parsed, "--chain");
  const signingKey = required(parsed, "--signing-key");
  protectOutput(parsed, chain, [signingKey, process.env.GITHUB_EVENT_PATH ?? ""]);
  const receipt = importGitHubActionsOutcome({
    chain: resolve(chain),
    signingKeyPath: resolve(signingKey),
  });
  outputJson(parsed.values.get("--output"), receipt);
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    const label = receipt.kind.replaceAll("_", " ");
    process.stdout.write([
      receipt.appended ? `Recorded ${label} from GitHub Actions.` : `The ${label} event was already recorded; no duplicate was added.`,
      `  history entries: ${receipt.sequence}`,
      `  result: ${receipt.disposition}`,
      `  record: ${receipt.eventHash}`,
      "",
    ].join("\n"));
  }
  return 0;
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

function selectedInteger(parsed: Parsed, name: string, fallback?: number): number | undefined {
  const raw = parsed.values.get(name);
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is too large`);
  return value;
}

function outputJson(path: string | undefined, value: unknown): void {
  if (path) writePrivateFileAtomic(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function protectNamedOutput(output: string | undefined, inputs: string[]): void {
  if (!output) return;
  const selected = resolve(output);
  if (inputs.some((input) => resolve(input) === selected)) throw new Error("--output must not replace an input receipt");
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
  allowed(parsed, ["--chain", "--expected-head", "--public-key", "--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity verify accepts only named options");
  const chain = required(parsed, "--chain");
  protectOutput(parsed, chain, [parsed.values.get("--public-key") ?? ""]);
  const pinned = parsed.values.get("--public-key") ? [publicKeyId(resolve(parsed.values.get("--public-key")!))] : undefined;
  const verified = verifyContinuityChain(resolve(chain), {
    pinnedEventKeyIds: pinned,
    ...(parsed.values.get("--expected-head") ? { expectedHead: parsed.values.get("--expected-head")! } : {}),
  });
  const publicValue = publicChainVerification(verified);
  outputJson(parsed.values.get("--output"), publicValue);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(publicValue, null, 2)}\n` : `${renderChainVerification(verified)}\n`);
  return verified.valid ? 0 : 1;
}

function runImportGitHub(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, [
    "--chain", "--event", "--delivery-id", "--webhook-signature", "--webhook-secret-file",
    "--observed-at", "--signing-key", "--format", "--output",
  ], ["--json", "--unavailable"]);
  if (parsed.positional.length) throw new Error("continuity import-github accepts only named options");
  const chain = required(parsed, "--chain");
  const inputs = ["--event", "--webhook-secret-file", "--signing-key"].map((name) => parsed.values.get(name) ?? "");
  protectOutput(parsed, chain, inputs);
  const receipt = importGitHubOutcome({
    chain: resolve(chain),
    deliveryId: required(parsed, "--delivery-id"),
    ...(parsed.values.get("--event") ? { eventPath: resolve(parsed.values.get("--event")!) } : {}),
    ...(parsed.values.get("--webhook-signature") ? { webhookSignature: parsed.values.get("--webhook-signature")! } : {}),
    ...(parsed.values.get("--webhook-secret-file") ? { webhookSecretPath: resolve(parsed.values.get("--webhook-secret-file")!) } : {}),
    ...(parsed.values.get("--observed-at") ? { observedAt: parsed.values.get("--observed-at")! } : {}),
    ...(parsed.values.get("--signing-key") ? { signingKeyPath: resolve(parsed.values.get("--signing-key")!) } : {}),
    unavailable: parsed.flags.has("--unavailable"),
  });
  outputJson(parsed.values.get("--output"), receipt);
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    const label = receipt.kind.replaceAll("_", " ");
    process.stdout.write([
      receipt.appended ? `Recorded ${label}.` : `The ${label} delivery was already recorded; no duplicate was added.`,
      `  history entries: ${receipt.sequence}`,
      `  result: ${receipt.disposition}`,
      `  record: ${receipt.eventHash}`,
      "",
    ].join("\n"));
  }
  return 0;
}

function runStatus(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--chain", "--policy", "--policy-ref", "--repo", "--now", "--environment", "--expected-head", "--expected-github-repository", "--public-key", "--format", "--output"], ["--json"]);
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
    ...(repo ? { repo: resolve(repo) } : {}),
    ...(policyRef ? { expectedBase: policyRef } : {}),
    ...(parsed.values.get("--expected-head") ? { expectedHead: parsed.values.get("--expected-head")! } : {}),
  });
  const expectedRepository = parsed.values.get("--expected-github-repository");
  if (expectedRepository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepository)) throw new Error("--expected-github-repository must be owner/name");
    try {
      if (githubRepositoryFromRemote(verified.report.repository.remote) !== expectedRepository.toLowerCase()) {
        verified.errors.push("continuity receipt belongs to a different GitHub repository");
      }
    } catch {
      verified.errors.push("continuity receipt does not contain a supported GitHub repository remote");
    }
    verified.valid = verified.errors.length === 0;
  }
  const decision = evaluateContinuity(verified, policy, { now, environment: parsed.values.get("--environment") });
  outputJson(parsed.values.get("--output"), decision);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(decision, null, 2)}\n` : `${renderContinuityDecision(decision)}\n`);
  if (decision.continuity === "CURRENT") return 0;
  if (decision.continuity === "REVOKED") return 1;
  if (decision.continuity === "HOLD") return 3;
  return 4;
}

function continuityExitCode(continuity: "CURRENT" | "HOLD" | "EXPIRED" | "REVOKED"): number {
  if (continuity === "CURRENT") return 0;
  if (continuity === "REVOKED") return 1;
  if (continuity === "HOLD") return 3;
  return 4;
}

function runStaple(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, [
    "--chain", "--policy", "--policy-ref", "--repo", "--now", "--environment",
    "--expected-head", "--public-key", "--signing-key", "--ttl-seconds", "--format", "--output",
  ], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity staple accepts only named options");
  const chain = required(parsed, "--chain");
  const policyPath = required(parsed, "--policy");
  const signingKey = required(parsed, "--signing-key");
  const output = required(parsed, "--output");
  protectOutput(parsed, chain, [policyPath, signingKey, parsed.values.get("--public-key") ?? ""]);
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
    ...(repo ? { repo: resolve(repo) } : {}),
    ...(policyRef ? { expectedBase: policyRef } : {}),
    ...(parsed.values.get("--expected-head") ? { expectedHead: parsed.values.get("--expected-head")! } : {}),
  });
  const decision = evaluateContinuity(verified, policy, { now, environment: required(parsed, "--environment") });
  const staple = issueContinuityStaple({
    verification: verified,
    decision,
    privateKeyPath: resolve(signingKey),
    ttlSeconds: selectedInteger(parsed, "--ttl-seconds", DEFAULT_STAPLE_TTL_SECONDS),
  });
  outputJson(output, staple);
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(staple, null, 2)}\n`);
  } else {
    process.stdout.write([
      "Agent Vigil continuity staple issued",
      `  result: ${staple.payload.decision.continuity}`,
      `  protected action: ${staple.payload.decision.allowsProtectedAction ? "allowed until expiry" : "stopped"}`,
      `  head: ${staple.payload.subject.headSha}`,
      `  evidence sequence: ${staple.payload.evidence.sequence}`,
      `  expires: ${staple.payload.expiresAt}`,
      `  signer: ${staple.signature.keyId}`,
      `  output: ${resolve(output)}`,
      "",
    ].join("\n"));
  }
  return continuityExitCode(staple.payload.decision.continuity);
}

function runVerifyStaple(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, [
    "--public-key", "--expected-receipt-hash", "--expected-head", "--environment", "--expected-policy-sha256",
    "--expected-chain-tip", "--minimum-sequence", "--now", "--format", "--output",
  ], ["--json"]);
  if (parsed.positional.length !== 1) throw new Error("continuity verify-staple requires exactly one staple path");
  const staplePath = resolve(parsed.positional[0]);
  protectNamedOutput(parsed.values.get("--output"), [staplePath, required(parsed, "--public-key")]);
  const result = verifyContinuityStaple(loadContinuityStaple(staplePath), {
    publicKeyPath: resolve(required(parsed, "--public-key")),
    expectedReceiptHash: required(parsed, "--expected-receipt-hash"),
    expectedHead: required(parsed, "--expected-head"),
    expectedEnvironment: required(parsed, "--environment"),
    expectedPolicySha256: required(parsed, "--expected-policy-sha256"),
    now: selectedNow(parsed),
    ...(parsed.values.get("--expected-chain-tip") ? { expectedChainTip: parsed.values.get("--expected-chain-tip")! } : {}),
    ...(parsed.values.get("--minimum-sequence") !== undefined ? { minimumSequence: selectedInteger(parsed, "--minimum-sequence")! } : {}),
  });
  outputJson(parsed.values.get("--output"), result);
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Continuity staple: ${result.effectiveContinuity}`,
      `  signature: valid and pinned (${result.signerKeyId})`,
      `  fresh: ${result.fresh ? "yes" : "no"}`,
      `  protected action: ${result.allowsProtectedAction ? "allowed" : "stopped"}`,
      `  head: ${result.subject.headSha}`,
      `  environment: ${result.environment}`,
      `  evidence sequence: ${result.sequence}`,
      `  expires: ${result.expiresAt}`,
      "",
    ].join("\n"));
  }
  return continuityExitCode(result.effectiveContinuity);
}

function runTerraformPlanGate(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, [
    "--staple", "--terraform-executable", "--public-key", "--expected-receipt-hash", "--expected-head", "--environment",
    "--expected-policy-sha256", "--expected-chain-tip", "--minimum-sequence", "--now", "--timeout-ms", "--format", "--output",
  ], ["--json"]);
  if (parsed.positional.length !== 1) throw new Error("continuity terraform-plan-gate requires exactly one saved plan path");
  const planPath = resolve(parsed.positional[0]);
  const staplePath = resolve(required(parsed, "--staple"));
  const publicKeyPath = resolve(required(parsed, "--public-key"));
  const terraformExecutable = resolve(required(parsed, "--terraform-executable"));
  protectNamedOutput(parsed.values.get("--output"), [planPath, staplePath, publicKeyPath, terraformExecutable]);
  const result = verifyTerraformSavedPlan({
    planPath,
    terraformExecutable,
    staple: loadContinuityStaple(staplePath),
    stapleOptions: {
      publicKeyPath,
      expectedReceiptHash: required(parsed, "--expected-receipt-hash"),
      expectedHead: required(parsed, "--expected-head"),
      expectedEnvironment: required(parsed, "--environment"),
      expectedPolicySha256: required(parsed, "--expected-policy-sha256"),
      now: selectedNow(parsed),
      ...(parsed.values.get("--expected-chain-tip") ? { expectedChainTip: parsed.values.get("--expected-chain-tip")! } : {}),
      ...(parsed.values.get("--minimum-sequence") !== undefined ? { minimumSequence: selectedInteger(parsed, "--minimum-sequence")! } : {}),
    },
    timeoutMs: selectedInteger(parsed, "--timeout-ms", 30_000),
  });
  outputJson(parsed.values.get("--output"), result);
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Terraform saved-plan gate: ${result.decision.authorization}`,
      `  continuity: ${result.decision.continuity}`,
      `  reason: ${result.decision.reasonCode}`,
      ...(result.plan ? [`  plan: ${result.plan.sha256}`, `  resource changes: ${result.plan.resourceChanges}`] : []),
      "  terraform apply: not run",
      "",
    ].join("\n"));
  }
  return continuityExitCode(result.decision.continuity);
}

function runDemo(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity demo accepts only named options");
  const result = runContinuityDemo();
  outputJson(parsed.values.get("--output"), result);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(result, null, 2)}\n` : `${renderContinuityDemo(result)}\n`);
  return 0;
}

function runGuardDemo(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--claude-route", "--codex-route", "--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity guard-demo accepts only named options");
  const claudePath = required(parsed, "--claude-route");
  const codexPath = required(parsed, "--codex-route");
  protectNamedOutput(parsed.values.get("--output"), [claudePath, codexPath]);
  const result = runGuardContinuityDemo({
    claudeRoute: loadGuardRouteReport(claudePath),
    codexRoute: loadGuardRouteReport(codexPath),
  });
  outputJson(parsed.values.get("--output"), result);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(result, null, 2)}\n` : `${renderGuardContinuityDemo(result)}\n`);
  return 0;
}

function runInstallAction(args: string[]): number {
  const parsed = parse(args);
  allowed(parsed, ["--repo", "--action-ref", "--source-workflow", "--format"], ["--json", "--force", "--self-serve"]);
  if (parsed.positional.length) throw new Error("continuity install-action accepts only named options");
  const result = installContinuityAction({
    repo: resolve(required(parsed, "--repo")),
    actionCommit: required(parsed, "--action-ref"),
    ...(parsed.values.get("--source-workflow") ? { sourceWorkflow: parsed.values.get("--source-workflow")! } : {}),
    force: parsed.flags.has("--force"),
    selfServe: parsed.flags.has("--self-serve"),
  });
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write([
      "Continuity deployment check installed locally.",
      ...result.created.map((path) => `  created: ${path}`),
      ...result.replaced.map((path) => `  replaced: ${path}`),
      ...(result.selfServe ? ["  test lab: installed; it uses synthetic evidence and cannot deploy"] : []),
      "  next: add trusted signing key IDs to the policy, review the created files, and commit them",
      "  no deployment step was added",
      "",
    ].join("\n"));
  }
  return 0;
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
    if (command === "import-github") return runImportGitHub(rest);
    if (command === "import-github-actions") return runImportGitHubActions(rest);
    if (command === "verify") return runVerify(rest);
    if (command === "status") return runStatus(rest);
    if (command === "staple") return runStaple(rest);
    if (command === "verify-staple") return runVerifyStaple(rest);
    if (command === "terraform-plan-gate") return runTerraformPlanGate(rest);
    if (command === "demo") return runDemo(rest);
    if (command === "guard-demo") return runGuardDemo(rest);
    if (command === "install-action") return runInstallAction(rest);
    throw new Error(`unknown continuity command: ${command}`);
  } catch (error) {
    console.error(`agent-vigil: ${terminalSafe(error instanceof Error ? error.message : String(error))}`);
    return 2;
  }
}
