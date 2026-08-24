import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  fleetDeploymentIntentRequiredError,
  optionOnlyOnceError,
  optionRequiresValueError,
  reportCliError,
  unexpectedPositionalError,
  unknownOptionError,
  unknownUpgradeCommandError,
} from "../cli-errors.ts";
import { writePrivateFileAtomic } from "../safe-output.ts";
import {
  loadUpgradeConfig,
  parseExactJson,
  readBoundedJson,
  trustedDirectoryInside,
  trustedRegularFileInside,
} from "./contracts.ts";
import {
  createPublicCompatibilityEntry,
  renderUpgradeReceipt,
  runUpgradeEvaluation,
  validatePublicCompatibilityEntry,
  verifyPublicCompatibilityEntry,
  type PublicCompatibilityEntry,
} from "./receipt.ts";
import {
  COMPATIBILITY_RESOLUTION_SCHEMA,
  createCompatibilityRegistry,
  createCompatibilityResolution,
  renderBadgeEndpoint,
  renderCompatibilityRegistryPage,
  renderMaintainerEvidence,
  validateCompatibilityResolution,
  verifyCompatibilityResolution,
  type CompatibilityResolution,
} from "./network.ts";
import {
  createUpdatePlan,
  renderUpdatePlan,
  type UpdateManager,
} from "./manager-plan.ts";
import {
  renderApmAutomaticPreflight,
  runApmAutomaticPreflight,
  validateBoundApmAutomaticPreflightReceipt,
} from "./apm-materialize.ts";
import {
  enforceFleetPolicy,
  renderFleetDecision,
  validateFleetDeploymentIntent,
  validateFleetPolicy,
} from "./fleet.ts";
import { terminalSafe } from "./presentation.ts";
import {
  publishCompatibilityRecord,
  registerLifecycleInstallation,
  uploadLifecycleEvent,
  validateLifecycleCredential,
} from "./hosted.ts";
import {
  DEFAULT_UPGRADE_CONFIG,
  DEFAULT_UPGRADE_RECEIPT,
  doctorUpgrade,
  initUpgrade,
  renderUpgradeDoctor,
} from "./setup.ts";

function usage(): string {
  return `Agent Vigil Upgrade Guard

Usage:
  vigil upgrade init [--repo <path>] [--force]
  vigil upgrade doctor [--repo <path>] [--config <path>] [--docker-bin <path>]
  vigil upgrade plan --manager <apm|skills|agent-plugin> --current <state> --candidate <state> [--repo <path>] [--output <plan.json>]
  vigil upgrade preflight --current-lock <apm.lock.yaml> --candidate-lock <apm.lock.yaml> [--plan <plan.json>] [--identity <apm:...>] [--repo <path>] [--config <path>] [--work-directory <path>] [--output <receipt.json>] [--public-output <entry.json> --signing-key <key>] [--docker-bin <path>] [--fetch-bin <path>]
  vigil upgrade verify-preflight <receipt.json> --current-lock <apm.lock.yaml> --candidate-lock <apm.lock.yaml> --repo <path> --config <path>
  vigil upgrade check --current <dir> --candidate <dir> [--repo <path>] [--config <path>] [--output <private.json>] [--public-output <entry.json> --signing-key <key>] [--docker-bin <path>]
  vigil upgrade verify <entry.json> [--public-key <path>]
  vigil upgrade evidence <entry.json> --output <issue.md> --public-key <path>
  vigil upgrade resolve --broken <entry.json> --fixed <entry.json> --output <resolution.json> --public-key <path> --signing-key <path>
  vigil upgrade enforce <entry.json> --policy <fleet-policy.json> --public-key <path> --expected-current-version <version> --expected-candidate-version <version> --expected-current-artifact-sha256 <sha256:...> --expected-candidate-artifact-sha256 <sha256:...> [--output <decision.json>]
  vigil upgrade index <entry-or-resolution.json>... --output <index.html> --public-key <path> [--api-output <registry.json>] [--badge-directory <dir>]
  vigil upgrade publish <entry-or-resolution.json> --endpoint <https-origin> --public-key <path> --consent-public-proof
  vigil upgrade telemetry-register --endpoint <https-origin> --channel <channel> --run-class <EXTERNAL_STANDARD|DEMO|INTERNAL> --credential-output <credential.json> --consent-lifecycle
  vigil upgrade telemetry <event.json> --endpoint <https-origin> --credential <credential.json> --consent-lifecycle

Exit codes: 0 SAFE/verified · 1 CHANGED/invalid signature · 2 HOLD or usage error`;
}

function option(args: string[], name: string): string | undefined {
  const indexes = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (indexes.length > 1) throw optionOnlyOnceError(name);
  if (!indexes.length) return undefined;
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw optionRequiresValueError(name);
  return value;
}

function assertKnown(args: string[], values: string[], flags: string[] = [], allowPositionals = false): void {
  const allowed = new Set([...values, ...flags]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (!allowPositionals) throw unexpectedPositionalError();
      continue;
    }
    if (!allowed.has(arg)) throw unknownOptionError(arg);
    if (values.includes(arg)) index += 1;
  }
}

function repository(args: string[]): string {
  return resolve(option(args, "--repo") ?? ".");
}

function insideRepository(repositoryPath: string, value: string, label: string): string {
  // Keep the caller's lexical spelling here. On macOS, /var is a root-owned
  // alias for /private/var; returning the canonical spelling would make the
  // later no-symlink trust check compare two otherwise equivalent roots.
  // Existing inputs receive a separate realpath containment check, while
  // atomic outputs reject symbolic-link parents before writing.
  const repository = resolve(repositoryPath);
  const path = resolve(repository, value);
  const rel = relative(repository, path);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`${label} must remain inside --repo`);
  return path;
}

function outputIdentity(path: string): string {
  const parent = realpathSync(dirname(resolve(path)));
  const status = statSync(parent, { bigint: true });
  const name = basename(path);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.endsWith(".") || name.endsWith(" ") || name.includes("~")) {
    throw new Error(`output basename is not portable and collision-safe: ${name}`);
  }
  return `${status.dev}:${status.ino}:${name.toUpperCase()}`;
}

function assertDistinctOutputs(paths: string[]): void {
  const identities = paths.map(outputIdentity);
  if (new Set(identities).size !== identities.length) throw new Error("requested output paths resolve to the same filesystem entry");
}

function pathIdentities(path: string): string[] {
  const requested = resolve(path);
  const identities = [outputIdentity(requested)];
  const canonical = realpathSync(requested);
  const canonicalIdentity = outputIdentity(canonical);
  if (!identities.includes(canonicalIdentity)) identities.push(canonicalIdentity);
  return identities;
}

function assertOutputsDoNotAliasInputs(outputs: string[], inputs: string[]): void {
  const outputIds = new Set(outputs.map(outputIdentity));
  for (const input of inputs) {
    if (pathIdentities(input).some((identity) => outputIds.has(identity))) {
      throw new Error("requested output path aliases a required input file");
    }
  }
}

function assertOutputsOutsideRoots(outputs: string[], roots: string[]): void {
  for (const rootPath of roots) {
    const root = realpathSync(rootPath);
    for (const output of outputs) {
      const parent = realpathSync(dirname(resolve(output)));
      const target = resolve(parent, basename(output));
      const rel = relative(root, target);
      if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) {
        throw new Error("requested output path must remain outside current, candidate, and canary input trees");
      }
    }
  }
}

function readPublicEntry(path: string): PublicCompatibilityEntry {
  return validatePublicCompatibilityEntry(readBoundedJson(path, 512 * 1024, "public compatibility entry"));
}

function readResolution(path: string): CompatibilityResolution {
  return validateCompatibilityResolution(readBoundedJson(path, 512 * 1024, "compatibility resolution"));
}

function manager(value: string | undefined): UpdateManager {
  if (value !== "apm" && value !== "skills" && value !== "agent-plugin") {
    throw new Error("--manager must be apm, skills, or agent-plugin");
  }
  return value;
}

function runInit(args: string[]): number {
  assertKnown(args, ["--repo"], ["--force", "--help"]);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const result = initUpgrade(repository(args), args.includes("--force"));
  console.log("Agent Vigil Upgrade Guard initialized locally.\n");
  for (const path of result.created) console.log(`  created ${terminalSafe(path)}`);
  for (const path of result.kept) console.log(`  kept    ${terminalSafe(path)}`);
  console.log("\nThe scaffold is ignored by Git and intentionally returns HOLD until its template canary is replaced.");
  return 0;
}

function runDoctor(args: string[]): number {
  assertKnown(args, ["--repo", "--config", "--docker-bin"], ["--help"]);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const repo = repository(args);
  const config = option(args, "--config");
  const configPath = config ? insideRepository(repo, config, "--config") : undefined;
  const result = doctorUpgrade(repo, configPath, option(args, "--docker-bin") ?? "docker");
  process.stdout.write(renderUpgradeDoctor(result));
  return result.status === "READY" ? 0 : 2;
}

function runPlan(args: string[]): number {
  assertKnown(args, ["--repo", "--manager", "--current", "--candidate", "--output"], ["--help"]);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const repo = repository(args);
  const current = option(args, "--current");
  const candidate = option(args, "--candidate");
  if (!current || !candidate) throw new Error("upgrade plan requires --current <state> and --candidate <state>");
  const selectedManager = manager(option(args, "--manager"));
  const currentPath = resolve(current);
  const candidatePath = resolve(candidate);
  const output = insideRepository(repo, option(args, "--output") ?? ".agent-vigil/upgrade/update-plan.json", "--output");
  assertOutputsDoNotAliasInputs([output], [currentPath, candidatePath]);
  if (selectedManager === "agent-plugin") assertOutputsOutsideRoots([output], [currentPath, candidatePath]);
  const plan = createUpdatePlan({ manager: selectedManager, currentPath, candidatePath });
  writePrivateFileAtomic(output, `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(renderUpdatePlan(plan));
  return plan.summary.total ? 1 : 0;
}

function runCheck(args: string[]): number {
  assertKnown(args, ["--repo", "--config", "--current", "--candidate", "--output", "--public-output", "--signing-key", "--docker-bin"], ["--help"]);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const repo = repository(args);
  const current = option(args, "--current");
  const candidate = option(args, "--candidate");
  if (!current || !candidate) throw new Error("upgrade check requires --current <dir> and --candidate <dir>");
  const config = insideRepository(repo, option(args, "--config") ?? DEFAULT_UPGRADE_CONFIG, "--config");
  const trustedConfig = trustedRegularFileInside(repo, config, "upgrade config");
  const loadedConfig = loadUpgradeConfig(trustedConfig);
  const currentDirectory = resolve(current);
  const candidateDirectory = resolve(candidate);
  const canaryDirectory = trustedDirectoryInside(
    repo,
    resolve(repo, loadedConfig.canaryDirectory),
    "canary directory",
  );
  const output = insideRepository(repo, option(args, "--output") ?? DEFAULT_UPGRADE_RECEIPT, "--output");
  const publicOption = option(args, "--public-output");
  const signingKey = option(args, "--signing-key");
  if (Boolean(publicOption) !== Boolean(signingKey)) throw new Error("--public-output and --signing-key must be supplied together");
  const publicOutput = publicOption ? resolve(publicOption) : undefined;
  const outputs = [output, ...(publicOutput ? [publicOutput] : [])];
  assertDistinctOutputs(outputs);
  assertOutputsDoNotAliasInputs(outputs, [trustedConfig, ...(signingKey ? [resolve(signingKey)] : [])]);
  assertOutputsOutsideRoots(outputs, [currentDirectory, candidateDirectory, canaryDirectory]);
  const receipt = runUpgradeEvaluation({
    configPath: trustedConfig,
    config: loadedConfig,
    repository: repo,
    currentDirectory,
    candidateDirectory,
    dockerBin: option(args, "--docker-bin") ?? "docker",
  });
  writePrivateFileAtomic(output, `${JSON.stringify(receipt, null, 2)}\n`);
  if (publicOutput && signingKey) {
    const entry = createPublicCompatibilityEntry(receipt, resolve(signingKey));
    writePrivateFileAtomic(publicOutput, `${JSON.stringify(entry, null, 2)}\n`);
  }
  process.stdout.write(renderUpgradeReceipt(receipt));
  return receipt.summary.verdict === "SAFE" ? 0 : receipt.summary.verdict === "CHANGED" ? 1 : 2;
}

function runPreflight(args: string[]): number {
  const valueOptions = [
    "--repo", "--current-lock", "--candidate-lock", "--plan", "--identity",
    "--config", "--work-directory", "--output", "--public-output", "--signing-key", "--docker-bin", "--fetch-bin",
  ];
  assertKnown(args, valueOptions, ["--help"]);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const repo = repository(args);
  const currentOption = option(args, "--current-lock");
  const candidateOption = option(args, "--candidate-lock");
  if (!currentOption || !candidateOption) {
    throw new Error("upgrade preflight requires --current-lock <state> and --candidate-lock <state>");
  }
  const currentLockPath = resolve(currentOption);
  const candidateLockPath = resolve(candidateOption);
  const config = insideRepository(repo, option(args, "--config") ?? DEFAULT_UPGRADE_CONFIG, "--config");
  const trustedConfig = trustedRegularFileInside(repo, config, "upgrade config");
  const planOption = option(args, "--plan");
  const planPath = planOption ? resolve(planOption) : undefined;
  const suppliedPlan = planPath ? readBoundedJson(planPath, 4 * 1024 * 1024, "APM update plan") : undefined;
  const outputOption = option(args, "--output");
  const output = outputOption
    ? resolve(outputOption)
    : insideRepository(repo, ".agent-vigil/upgrade/apm-preflight-receipt.json", "--output");
  const publicOption = option(args, "--public-output");
  const signingKey = option(args, "--signing-key");
  if (Boolean(publicOption) !== Boolean(signingKey)) {
    throw new Error("--public-output and --signing-key must be supplied together");
  }
  const publicOutput = publicOption ? resolve(publicOption) : undefined;
  const outputs = [output, ...(publicOutput ? [publicOutput] : [])];
  assertDistinctOutputs(outputs);
  assertOutputsDoNotAliasInputs(outputs, [
    currentLockPath,
    candidateLockPath,
    trustedConfig,
    ...(planPath ? [planPath] : []),
    ...(signingKey ? [resolve(signingKey)] : []),
  ]);
  const receipt = runApmAutomaticPreflight({
    repository: repo,
    currentLockPath,
    candidateLockPath,
    configPath: trustedConfig,
    ...(option(args, "--identity") ? { identity: option(args, "--identity") } : {}),
    ...(suppliedPlan !== undefined ? { suppliedPlan } : {}),
    ...(option(args, "--docker-bin") ? { dockerBin: option(args, "--docker-bin") } : {}),
    ...(option(args, "--fetch-bin") ? { fetchBin: option(args, "--fetch-bin") } : {}),
    ...(option(args, "--work-directory") ? { workDirectory: resolve(option(args, "--work-directory")!) } : {}),
  });
  writePrivateFileAtomic(output, `${JSON.stringify(receipt, null, 2)}\n`);
  if (publicOutput && signingKey && receipt.summary.verdict !== "HOLD" && receipt.upgradeReceipt) {
    const entry = createPublicCompatibilityEntry(receipt.upgradeReceipt, resolve(signingKey));
    writePrivateFileAtomic(publicOutput, `${JSON.stringify(entry, null, 2)}\n`);
  }
  process.stdout.write(renderApmAutomaticPreflight(receipt));
  return receipt.summary.verdict === "SAFE" ? 0 : receipt.summary.verdict === "CHANGED" ? 1 : 2;
}

function positional(args: string[], optionsWithValues: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionsWithValues.includes(args[index])) { index += 1; continue; }
    if (!args[index].startsWith("--")) output.push(args[index]);
  }
  return output;
}

function readBoundedExactJson(path: string, maximumBytes: number, label: string): unknown {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
  if (status.size > maximumBytes) throw new Error(`${label} exceeds its maximum size`);
  return parseExactJson(readFileSync(path), label);
}

function runVerifyPreflight(args: string[]): number {
  assertKnown(args, ["--current-lock", "--candidate-lock", "--repo", "--config"], ["--help"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const inputs = positional(args, ["--current-lock", "--candidate-lock", "--repo", "--config"]);
  const currentOption = option(args, "--current-lock");
  const candidateOption = option(args, "--candidate-lock");
  const repositoryOption = option(args, "--repo");
  const configOption = option(args, "--config");
  if (inputs.length !== 1 || !currentOption || !candidateOption || !repositoryOption || !configOption) {
    throw new Error("upgrade verify-preflight requires one receipt, exact lockfiles, and a trusted --repo and --config");
  }
  const repository = resolve(repositoryOption);
  const receipt = validateBoundApmAutomaticPreflightReceipt(
    readBoundedExactJson(resolve(inputs[0]), 4 * 1024 * 1024, "automatic APM preflight receipt"),
    resolve(currentOption),
    resolve(candidateOption),
    { repository, configPath: resolve(repository, configOption) },
  );
  console.log(JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    verdict: receipt.summary.verdict,
    receiptHash: receipt.receiptHash,
    valid: true,
  }));
  return 0;
}

function runVerify(args: string[]): number {
  assertKnown(args, ["--public-key"], ["--help"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const entries = positional(args, ["--public-key"]);
  if (entries.length !== 1) throw new Error("upgrade verify requires exactly one public entry path");
  const inputPath = resolve(entries[0]);
  const raw = readBoundedJson(inputPath, 512 * 1024, "compatibility record");
  const schema = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).schemaVersion : undefined;
  const publicKey = option(args, "--public-key") ? resolve(option(args, "--public-key")!) : undefined;
  const result = schema === COMPATIBILITY_RESOLUTION_SCHEMA
    ? verifyCompatibilityResolution(validateCompatibilityResolution(raw), publicKey)
    : verifyPublicCompatibilityEntry(validatePublicCompatibilityEntry(raw), publicKey);
  console.log(JSON.stringify(result));
  return result.hashValid && result.signatureValid === true ? 0 : 1;
}

function runEvidence(args: string[]): number {
  assertKnown(args, ["--output", "--public-key"], ["--help"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const inputs = positional(args, ["--output", "--public-key"]);
  const outputOption = option(args, "--output");
  const publicKey = option(args, "--public-key");
  if (inputs.length !== 1 || !outputOption || !publicKey) {
    throw new Error("upgrade evidence requires one entry, --output <issue.md>, and --public-key <path>");
  }
  const inputPath = resolve(inputs[0]);
  const output = resolve(outputOption);
  const publicKeyPath = resolve(publicKey);
  assertOutputsDoNotAliasInputs([output], [inputPath, publicKeyPath]);
  const entry = readPublicEntry(inputPath);
  const checked = verifyPublicCompatibilityEntry(entry, publicKeyPath);
  if (!checked.hashValid || checked.signatureValid !== true) throw new Error("public entry failed pinned-key verification");
  writePrivateFileAtomic(output, renderMaintainerEvidence(entry));
  console.log(`Wrote privacy-minimized maintainer evidence to ${terminalSafe(output)}`);
  return 0;
}

function runResolve(args: string[]): number {
  assertKnown(args, ["--broken", "--fixed", "--output", "--public-key", "--signing-key"], ["--help"]);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const brokenOption = option(args, "--broken");
  const fixedOption = option(args, "--fixed");
  const outputOption = option(args, "--output");
  const publicKeyOption = option(args, "--public-key");
  const signingKeyOption = option(args, "--signing-key");
  if (!brokenOption || !fixedOption || !outputOption || !publicKeyOption || !signingKeyOption) {
    throw new Error("upgrade resolve requires --broken, --fixed, --output, --public-key, and --signing-key");
  }
  const brokenPath = resolve(brokenOption);
  const fixedPath = resolve(fixedOption);
  const output = resolve(outputOption);
  const publicKeyPath = resolve(publicKeyOption);
  const signingKeyPath = resolve(signingKeyOption);
  assertOutputsDoNotAliasInputs([output], [brokenPath, fixedPath, publicKeyPath, signingKeyPath]);
  const broken = readPublicEntry(brokenPath);
  const fixed = readPublicEntry(fixedPath);
  for (const [label, entry] of [["broken", broken], ["fixed", fixed]] as const) {
    const checked = verifyPublicCompatibilityEntry(entry, publicKeyPath);
    if (!checked.hashValid || checked.signatureValid !== true) throw new Error(`${label} entry failed pinned-key verification`);
  }
  const resolution = createCompatibilityResolution({
    broken,
    fixed,
    privateKeyPath: signingKeyPath,
  });
  writePrivateFileAtomic(output, `${JSON.stringify(resolution, null, 2)}\n`);
  console.log(`Wrote signed compatibility restoration record to ${terminalSafe(output)}`);
  return 0;
}

function runEnforce(args: string[]): number {
  const valueOptions = [
    "--policy", "--public-key", "--output",
    "--expected-current-version", "--expected-candidate-version",
    "--expected-current-artifact-sha256", "--expected-candidate-artifact-sha256",
  ];
  assertKnown(args, valueOptions, ["--help"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const inputs = positional(args, valueOptions);
  const policyOption = option(args, "--policy");
  const publicKeyOption = option(args, "--public-key");
  const expectedCurrentVersion = option(args, "--expected-current-version");
  const expectedCandidateVersion = option(args, "--expected-candidate-version");
  const expectedCurrentArtifactSha256 = option(args, "--expected-current-artifact-sha256");
  const expectedCandidateArtifactSha256 = option(args, "--expected-candidate-artifact-sha256");
  if (inputs.length !== 1 || !policyOption || !publicKeyOption
    || !expectedCurrentVersion || !expectedCandidateVersion
    || !expectedCurrentArtifactSha256 || !expectedCandidateArtifactSha256) {
    throw fleetDeploymentIntentRequiredError();
  }
  // Trust boundary: these values come from the deployment controller, independently
  // of the signed compatibility entry. Never populate them from the entry below.
  const deploymentIntent = validateFleetDeploymentIntent({
    currentVersion: expectedCurrentVersion,
    candidateVersion: expectedCandidateVersion,
    currentArtifactSha256: expectedCurrentArtifactSha256,
    candidateArtifactSha256: expectedCandidateArtifactSha256,
  });
  const entryPath = resolve(inputs[0]);
  const policyPath = resolve(policyOption);
  const publicKeyPath = resolve(publicKeyOption);
  const outputOption = option(args, "--output");
  const output = outputOption ? resolve(outputOption) : undefined;
  if (output) assertOutputsDoNotAliasInputs([output], [entryPath, policyPath, publicKeyPath]);
  const entry = readPublicEntry(entryPath);
  const checked = verifyPublicCompatibilityEntry(entry, publicKeyPath);
  if (!checked.hashValid || checked.signatureValid !== true) throw new Error("public entry failed pinned-key verification");
  const policy = validateFleetPolicy(readBoundedJson(policyPath, 256 * 1024, "fleet policy"));
  const decision = enforceFleetPolicy({ policy, entry, deploymentIntent });
  if (output) writePrivateFileAtomic(output, `${JSON.stringify(decision, null, 2)}\n`);
  process.stdout.write(renderFleetDecision(decision));
  return decision.status === "ALLOW" ? 0 : 1;
}

function runIndex(args: string[]): number {
  assertKnown(args, ["--output", "--api-output", "--public-key", "--badge-directory"], ["--help"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const inputs = positional(args, ["--output", "--api-output", "--public-key", "--badge-directory"]);
  const outputOption = option(args, "--output");
  const apiOutputOption = option(args, "--api-output");
  const publicKey = option(args, "--public-key");
  if (!inputs.length || !outputOption || !publicKey) throw new Error("upgrade index requires entries or resolutions, --output <index.html>, and --public-key <path>");
  if (inputs.length > 2_048) throw new Error("upgrade index accepts at most 2048 inputs");
  const output = resolve(outputOption);
  const apiOutput = apiOutputOption ? resolve(apiOutputOption) : undefined;
  if (apiOutput) assertDistinctOutputs([output, apiOutput]);
  const inputPaths = inputs.map((path) => resolve(path));
  const publicKeyPath = resolve(publicKey);
  const badgeOption = option(args, "--badge-directory");
  let badgeDirectory: string | undefined;
  if (badgeOption) {
    const requested = resolve(badgeOption);
    const status = lstatSync(requested);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("--badge-directory must be an existing regular directory");
    badgeDirectory = realpathSync(requested);
  }
  const entries: PublicCompatibilityEntry[] = [];
  const resolutions: CompatibilityResolution[] = [];
  for (const inputPath of inputPaths) {
    const raw = readBoundedJson(inputPath, 512 * 1024, "registry input");
    const schema = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).schemaVersion : undefined;
    if (schema === COMPATIBILITY_RESOLUTION_SCHEMA) {
      const resolution = validateCompatibilityResolution(raw);
      const checked = verifyCompatibilityResolution(resolution, publicKeyPath);
      if (!checked.hashValid || checked.signatureValid !== true) throw new Error(`resolution failed verification: ${inputPath}`);
      resolutions.push(resolution);
    } else {
      const entry = validatePublicCompatibilityEntry(raw);
      const checked = verifyPublicCompatibilityEntry(entry, publicKeyPath);
      if (!checked.hashValid || checked.signatureValid !== true) throw new Error(`public entry failed verification: ${inputPath}`);
      entries.push(entry);
    }
  }
  const badgeOutputs = badgeDirectory
    ? entries.map((entry) => resolve(badgeDirectory!, `${entry.entryHash.slice(7)}.json`))
    : [];
  const outputs = [output, ...(apiOutput ? [apiOutput] : []), ...badgeOutputs];
  assertDistinctOutputs(outputs);
  assertOutputsDoNotAliasInputs(outputs, [...inputPaths, publicKeyPath]);
  const registry = createCompatibilityRegistry(entries, resolutions);
  writePrivateFileAtomic(output, renderCompatibilityRegistryPage(registry));
  if (apiOutput) writePrivateFileAtomic(apiOutput, `${JSON.stringify(registry, null, 2)}\n`);
  if (badgeDirectory) {
    for (const entry of entries) {
      writePrivateFileAtomic(resolve(badgeDirectory, `${entry.entryHash.slice(7)}.json`), renderBadgeEndpoint(entry));
    }
  }
  console.log(`Wrote ${entries.length} verified compatibility entr${entries.length === 1 ? "y" : "ies"}, ${resolutions.length} resolution record(s)${apiOutput ? ", and a static JSON API" : ""} to ${terminalSafe(output)}`);
  return 0;
}

async function runHostedPublish(args: string[]): Promise<number> {
  assertKnown(args, ["--endpoint", "--public-key"], ["--help", "--consent-public-proof"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const inputs = positional(args, ["--endpoint", "--public-key"]);
  const endpoint = option(args, "--endpoint");
  const publicKey = option(args, "--public-key");
  if (inputs.length !== 1 || !endpoint || !publicKey || !args.includes("--consent-public-proof")) {
    throw new Error("hosted proof publication requires one record, endpoint, pinned public key, and explicit consent");
  }
  const raw = readBoundedJson(resolve(inputs[0]), 512 * 1024, "hosted compatibility record");
  const schema = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).schemaVersion : undefined;
  let record: PublicCompatibilityEntry | CompatibilityResolution;
  if (schema === COMPATIBILITY_RESOLUTION_SCHEMA) {
    record = validateCompatibilityResolution(raw);
    const checked = verifyCompatibilityResolution(record, resolve(publicKey));
    if (!checked.hashValid || checked.signatureValid !== true) throw new Error("hosted resolution failed pinned-key verification");
  } else {
    record = validatePublicCompatibilityEntry(raw);
    const checked = verifyPublicCompatibilityEntry(record, resolve(publicKey));
    if (!checked.hashValid || checked.signatureValid !== true) throw new Error("hosted entry failed pinned-key verification");
  }
  const receipt = await publishCompatibilityRecord({ endpoint, record });
  console.log(`Published verified ${receipt.recordType === "ENTRY" ? "compatibility entry" : "compatibility resolution"} ${receipt.recordHash}.`);
  return 0;
}

async function runTelemetryRegister(args: string[]): Promise<number> {
  assertKnown(
    args,
    ["--endpoint", "--channel", "--run-class", "--credential-output"],
    ["--help", "--consent-lifecycle"],
  );
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const endpoint = option(args, "--endpoint");
  const channel = option(args, "--channel");
  const runClass = option(args, "--run-class");
  const credentialOutput = option(args, "--credential-output");
  const channels = new Set(["apm", "skills", "agent-plugin", "github-action", "github-app"]);
  const runClasses = new Set(["EXTERNAL_STANDARD", "DEMO", "INTERNAL"]);
  if (!endpoint || !channel || !channels.has(channel) || !runClass || !runClasses.has(runClass)
    || !credentialOutput || !args.includes("--consent-lifecycle")) {
    throw new Error("lifecycle registration requires an endpoint, supported channel/run class, private output, and explicit consent");
  }
  const credential = await registerLifecycleInstallation({
    endpoint,
    requestedChannel: channel as "apm" | "skills" | "agent-plugin" | "github-action" | "github-app",
    runClass: runClass as "EXTERNAL_STANDARD" | "DEMO" | "INTERNAL",
  });
  writePrivateFileAtomic(resolve(credentialOutput), `${JSON.stringify(credential, null, 2)}\n`);
  console.log("Saved a server-issued lifecycle credential as an owner-private file. Counts remain unverified and Sybil-susceptible.");
  return 0;
}

async function runTelemetryUpload(args: string[]): Promise<number> {
  assertKnown(args, ["--endpoint", "--credential"], ["--help", "--consent-lifecycle"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const inputs = positional(args, ["--endpoint", "--credential"]);
  const endpoint = option(args, "--endpoint");
  const credentialPath = option(args, "--credential");
  if (inputs.length !== 1 || !endpoint || !credentialPath || !args.includes("--consent-lifecycle")) {
    throw new Error("lifecycle upload requires one event, endpoint, private credential, and explicit consent");
  }
  const credential = validateLifecycleCredential(readBoundedJson(resolve(credentialPath), 16 * 1024, "lifecycle credential"));
  const event = readBoundedJson(resolve(inputs[0]), 32 * 1024, "lifecycle event");
  const receipt = await uploadLifecycleEvent({ endpoint, credential, event });
  console.log(`Uploaded one privacy-minimal UNVERIFIED_TELEMETRY event at ingestion sequence ${receipt.ingestionSequence}.`);
  return 0;
}

export function runUpgradeCommand(
  args: ["publish" | "telemetry-register" | "telemetry", ...string[]],
): Promise<number>;
export function runUpgradeCommand(args: string[]): number;
export function runUpgradeCommand(args: string[]): number | Promise<number> {
  try {
    const command = args[0];
    const rest = args.slice(1);
    if (!command || command === "--help" || command === "help") { console.log(usage()); return 0; }
    if (command === "init") return runInit(rest);
    if (command === "doctor") return runDoctor(rest);
    if (command === "plan") return runPlan(rest);
    if (command === "preflight") return runPreflight(rest);
    if (command === "verify-preflight") return runVerifyPreflight(rest);
    if (command === "check") return runCheck(rest);
    if (command === "verify") return runVerify(rest);
    if (command === "evidence") return runEvidence(rest);
    if (command === "resolve") return runResolve(rest);
    if (command === "enforce") return runEnforce(rest);
    if (command === "index") return runIndex(rest);
    if (command === "publish") return runHostedPublish(rest).catch((error) => reportCliError("agent-vigil upgrade", error));
    if (command === "telemetry-register") return runTelemetryRegister(rest).catch((error) => reportCliError("agent-vigil upgrade", error));
    if (command === "telemetry") return runTelemetryUpload(rest).catch((error) => reportCliError("agent-vigil upgrade", error));
    throw unknownUpgradeCommandError();
  } catch (error) {
    return reportCliError("agent-vigil upgrade", error);
  }
}
