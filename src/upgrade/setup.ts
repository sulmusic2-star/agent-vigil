import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { writePrivateFileAtomic } from "../safe-output.ts";
import {
  loadUpgradeConfig,
  trustedDirectoryInside,
  trustedRegularFileInside,
  UPGRADE_CONFIG_SCHEMA,
} from "./contracts.ts";
import { terminalSafe } from "./presentation.ts";
import {
  dockerImagePresent,
  probeContainment,
  resolveDockerClient,
  type ContainmentProbe,
} from "./sandbox.ts";

export const DEFAULT_UPGRADE_DIRECTORY = ".agent-vigil/upgrade";
export const DEFAULT_UPGRADE_CONFIG = `${DEFAULT_UPGRADE_DIRECTORY}/config.json`;
export const DEFAULT_UPGRADE_RECEIPT = `${DEFAULT_UPGRADE_DIRECTORY}/last-receipt.json`;
export const DEFAULT_RUNNER_IMAGE = "node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752";

export type UpgradeSetupResult = { created: string[]; kept: string[] };

export type UpgradeDoctorResult = {
  status: "READY" | "HOLD";
  configPath: string;
  imagePresent: boolean;
  templateCanary: boolean;
  containment: ContainmentProbe;
  checks: Array<{ status: "PASS" | "HOLD"; label: string; detail: string }>;
};

function ensureRepository(path: string): string {
  const requested = resolve(path);
  const status = lstatSync(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("--repo must be a regular directory, not a symbolic link");
  const repository = realpathSync(requested);
  try {
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Git reports an empty prefix only when cwd is the worktree root. This
    // avoids comparing two equivalent Windows paths that Git and Node may
    // spell with different drive-letter case, separators, or short names.
    if (prefix !== "") throw new Error("nested");
  } catch {
    throw new Error("--repo must be the root of a Git repository");
  }
  return repository;
}

function inside(repository: string, path: string): string {
  const target = resolve(repository, path);
  const rel = relative(repository, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("upgrade setup path escaped the repository");
  return target;
}

function ensurePrivateDirectory(repository: string, target: string): void {
  const rel = relative(repository, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("upgrade setup directory escaped the repository");
  let current = repository;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (existsSync(current)) {
      const status = lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`refusing unsafe setup directory: ${current}`);
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
    if (process.platform !== "win32") chmodSync(current, 0o700);
  }
}

function inferredName(repository: string): string {
  const manifest = join(repository, "package.json");
  try {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    if (typeof value.name === "string" && /^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,159}$/.test(value.name)) return value.name;
  } catch {
    // The scaffold remains useful for a non-Node repository; the user replaces
    // this placeholder with the exact installed component identity.
  }
  return "replace-with-agent-component";
}

function configTemplate(repository: string): string {
  return `${JSON.stringify({
    schemaVersion: UPGRADE_CONFIG_SCHEMA,
    component: {
      ecosystem: "agent-plugin",
      name: inferredName(repository),
      manifestPath: "package.json",
      identityField: "name",
      versionField: "version",
      capabilityFields: ["contributes", "mcpServers", "hooks", "skills", "commands", "dependencies"],
    },
    runner: {
      engine: "docker",
      image: DEFAULT_RUNNER_IMAGE,
      trials: 2,
      memoryMiB: 512,
      cpus: 1,
      pids: 128,
    },
    canaryDirectory: `${DEFAULT_UPGRADE_DIRECTORY}/canaries`,
    canaries: [{
      id: "replace-with-repository-canary",
      command: ["node", "/canaries/template-canary.mjs"],
      timeoutSeconds: 30,
    }],
  }, null, 2)}\n`;
}

const CANARY_TEMPLATE = `// This template intentionally reports FAIL. Replace it with a deterministic,
// repository-specific behavioral canary before an update can earn SAFE.
process.stdout.write(JSON.stringify({
  schemaVersion: "agent-vigil-upgrade-canary/v1",
  outcome: "FAIL",
  observations: { templateRequiresReplacement: true }
}));
`;

function writeScaffold(path: string, content: string, force: boolean, result: UpgradeSetupResult): void {
  if (existsSync(path) && !force) {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile()) throw new Error(`refusing unsafe existing scaffold: ${path}`);
    result.kept.push(path);
    return;
  }
  writePrivateFileAtomic(path, content);
  result.created.push(path);
}

export function initUpgrade(repositoryPath: string, force = false): UpgradeSetupResult {
  const repository = ensureRepository(repositoryPath);
  const root = inside(repository, DEFAULT_UPGRADE_DIRECTORY);
  const canaries = join(root, "canaries");
  ensurePrivateDirectory(repository, canaries);
  const result: UpgradeSetupResult = { created: [], kept: [] };
  writeScaffold(join(root, ".gitignore"), "*\n!.gitignore\n", force, result);
  writeScaffold(join(root, "config.json"), configTemplate(repository), force, result);
  writeScaffold(join(canaries, "template-canary.mjs"), CANARY_TEMPLATE, force, result);
  return result;
}

export function doctorUpgrade(repositoryPath: string, configPath?: string, dockerBin = "docker"): UpgradeDoctorResult {
  const repository = ensureRepository(repositoryPath);
  const selectedConfig = configPath ? resolve(configPath) : join(repository, DEFAULT_UPGRADE_CONFIG);
  const rel = relative(repository, selectedConfig);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("upgrade config must remain inside the repository");
  const trustedConfig = trustedRegularFileInside(repository, selectedConfig, "upgrade config");
  const config = loadUpgradeConfig(trustedConfig);
  const canaryDirectory = trustedDirectoryInside(
    repository,
    inside(repository, config.canaryDirectory),
    "canaryDirectory",
  );
  const templateCanary = config.canaries.some((canary) => canary.id === "replace-with-repository-canary");
  let imagePresent = false;
  let containment: ContainmentProbe;
  try {
    const dockerClient = resolveDockerClient(dockerBin);
    imagePresent = dockerImagePresent(config, dockerClient);
    containment = probeContainment(config, repository, canaryDirectory, dockerClient);
  } catch (error) {
    containment = {
      status: "HOLD",
      localEndpoint: false,
      imagePresent: false,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: (error as Error).message,
    };
  }
  const checks: UpgradeDoctorResult["checks"] = [
    { status: "PASS", label: "config", detail: "strict upgrade config loaded" },
    { status: imagePresent ? "PASS" : "HOLD", label: "runner image", detail: imagePresent ? "exact digest is present locally" : "exact digest is absent; Upgrade Guard will not pull it during a check" },
    { status: containment.status, label: "containment", detail: containment.reason },
    { status: templateCanary ? "HOLD" : "PASS", label: "canaries", detail: templateCanary ? "replace the fail-closed template with a repository-specific behavioral canary" : `${config.canaries.length} configured canary or canaries` },
  ];
  return {
    status: checks.every((check) => check.status === "PASS") ? "READY" : "HOLD",
    configPath: trustedConfig,
    imagePresent,
    templateCanary,
    containment,
    checks,
  };
}

export function renderUpgradeDoctor(result: UpgradeDoctorResult): string {
  const lines = [
    `Agent Vigil Upgrade Guard doctor: ${terminalSafe(result.status)}`,
    `  config: ${terminalSafe(result.configPath)}`,
  ];
  for (const check of result.checks) {
    lines.push(`  ${check.status === "PASS" ? "✓" : "?"} ${terminalSafe(check.label)}: ${terminalSafe(check.detail)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function upgradeOutputParent(path: string): string {
  return dirname(resolve(path));
}
