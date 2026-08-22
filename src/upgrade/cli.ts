import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { writePrivateFileAtomic } from "../safe-output.ts";
import {
  loadUpgradeConfig,
  readBoundedJson,
  trustedDirectoryInside,
  trustedRegularFileInside,
} from "./contracts.ts";
import {
  createPublicCompatibilityEntry,
  renderBreakageIndex,
  renderUpgradeReceipt,
  runUpgradeEvaluation,
  validatePublicCompatibilityEntry,
  verifyPublicCompatibilityEntry,
  type PublicCompatibilityEntry,
} from "./receipt.ts";
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
  vigil upgrade check --current <dir> --candidate <dir> [--repo <path>] [--config <path>] [--output <private.json>] [--public-output <entry.json> --signing-key <key>] [--docker-bin <path>]
  vigil upgrade verify <entry.json> [--public-key <path>]
  vigil upgrade index <entry.json>... --output <index.html> --public-key <path>

Exit codes: 0 SAFE/verified · 1 CHANGED/invalid signature · 2 HOLD or usage error`;
}

function option(args: string[], name: string): string | undefined {
  const indexes = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be supplied only once`);
  if (!indexes.length) return undefined;
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function assertKnown(args: string[], values: string[], flags: string[] = [], allowPositionals = false): void {
  const allowed = new Set([...values, ...flags]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (!allowPositionals) throw new Error(`unexpected positional argument: ${arg}`);
      continue;
    }
    if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (values.includes(arg)) index += 1;
  }
}

function repository(args: string[]): string {
  return resolve(option(args, "--repo") ?? ".");
}

function insideRepository(repositoryPath: string, value: string, label: string): string {
  const repository = realpathSync(repositoryPath);
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

function runInit(args: string[]): number {
  assertKnown(args, ["--repo"], ["--force", "--help"]);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const result = initUpgrade(repository(args), args.includes("--force"));
  console.log("Agent Vigil Upgrade Guard initialized locally.\n");
  for (const path of result.created) console.log(`  created ${path}`);
  for (const path of result.kept) console.log(`  kept    ${path}`);
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

function positional(args: string[], optionsWithValues: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionsWithValues.includes(args[index])) { index += 1; continue; }
    if (!args[index].startsWith("--")) output.push(args[index]);
  }
  return output;
}

function runVerify(args: string[]): number {
  assertKnown(args, ["--public-key"], ["--help"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const entries = positional(args, ["--public-key"]);
  if (entries.length !== 1) throw new Error("upgrade verify requires exactly one public entry path");
  const result = verifyPublicCompatibilityEntry(readPublicEntry(resolve(entries[0])), option(args, "--public-key") ? resolve(option(args, "--public-key")!) : undefined);
  console.log(JSON.stringify(result));
  return result.hashValid && result.signatureValid === true ? 0 : 1;
}

function runIndex(args: string[]): number {
  assertKnown(args, ["--output", "--public-key"], ["--help"], true);
  if (args.includes("--help")) { console.log(usage()); return 0; }
  const inputs = positional(args, ["--output", "--public-key"]);
  const outputOption = option(args, "--output");
  const publicKey = option(args, "--public-key");
  if (!inputs.length || !outputOption || !publicKey) throw new Error("upgrade index requires entries, --output <index.html>, and --public-key <path>");
  if (inputs.length > 512) throw new Error("upgrade index accepts at most 512 entries");
  const output = resolve(outputOption);
  const inputPaths = inputs.map((path) => resolve(path));
  const publicKeyPath = resolve(publicKey);
  assertOutputsDoNotAliasInputs([output], [...inputPaths, publicKeyPath]);
  const entries = inputs.map((path) => {
    const entry = readPublicEntry(resolve(path));
    const checked = verifyPublicCompatibilityEntry(entry, publicKeyPath);
    if (!checked.hashValid || checked.signatureValid !== true) throw new Error(`public entry failed verification: ${path}`);
    return entry;
  });
  writePrivateFileAtomic(output, renderBreakageIndex(entries));
  console.log(`Wrote ${entries.length} verified compatibility entr${entries.length === 1 ? "y" : "ies"} to ${output}`);
  return 0;
}

export function runUpgradeCommand(args: string[]): number {
  try {
    const command = args[0];
    const rest = args.slice(1);
    if (!command || command === "--help" || command === "help") { console.log(usage()); return 0; }
    if (command === "init") return runInit(rest);
    if (command === "doctor") return runDoctor(rest);
    if (command === "check") return runCheck(rest);
    if (command === "verify") return runVerify(rest);
    if (command === "index") return runIndex(rest);
    throw new Error(`unknown upgrade command: ${command}`);
  } catch (error) {
    console.error(`agent-vigil upgrade: ${(error as Error).message}`);
    return 2;
  }
}
