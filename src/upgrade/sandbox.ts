import { createHash, randomBytes } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonical } from "../report.ts";
import { parseCanaryDocument, type CanaryDocument, type UpgradeCanaryConfig, type UpgradeConfig } from "./contracts.ts";

const PROXY_NAMES = [
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy",
] as const;

export type ContainmentProbe = {
  status: "PASS" | "HOLD";
  localEndpoint: boolean;
  imagePresent: boolean;
  networkBlocked: boolean;
  targetReadOnly: boolean;
  rootReadOnly: boolean;
  inheritedSecretAbsent: boolean;
  proxiesCleared: boolean;
  reason: string;
};

export type CanaryTrial = {
  state: "PASS" | "FAIL" | "HOLD";
  observationSha256?: string;
  observationCount?: number;
  reason: string;
};

export type DockerDaemonCheck = {
  local: boolean;
  endpoint?: string;
  reason: string;
};

const RESOLVED_DOCKER_CLIENT = Symbol("resolved-docker-client");

export type ResolvedDockerClient = {
  readonly executable: string;
  readonly endpoint: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly [RESOLVED_DOCKER_CLIENT]: true;
};

export type DockerClientSelection = string | ResolvedDockerClient;

type ContainerCleanup = {
  absent: boolean;
  reason: string;
};

const DOCKER_CONTROL_TIMEOUT_MS = 10_000;
const CONTAINMENT_PROBE_TIMEOUT_MS = 15_000;
const DOCKER_ENDPOINT_ENV = new Set([
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
]);

function isDockerEndpointEnvironment(name: string): boolean {
  return DOCKER_ENDPOINT_ENV.has(name.toUpperCase());
}

function trustedDockerLocations(): string[] {
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Program Files\\Docker\\Docker\\resources\\docker.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/opt/homebrew/bin/docker",
      "/usr/local/bin/docker",
      "/usr/bin/docker",
    ];
  }
  return [
    "/usr/bin/docker",
    "/usr/local/bin/docker",
    "/snap/bin/docker",
  ];
}

function canonicalExecutable(path: string): string {
  const canonicalPath = realpathSync(path);
  if (!statSync(canonicalPath).isFile()) throw new Error("Docker client must be a regular file");
  if (process.platform !== "win32") accessSync(canonicalPath, constants.X_OK);
  return canonicalPath;
}

function sanitizedDockerEnvironment(source: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (!isDockerEndpointEnvironment(name) && value !== undefined) environment[name] = value;
  }
  return Object.freeze(environment);
}

/**
 * Resolve the Docker client without allowing a repository-controlled PATH entry
 * to silently become part of the Upgrade Guard trust boundary. An explicitly
 * selected client must be absolute; the default is limited to fixed platform
 * locations and is canonicalized before execution.
 */
export function resolveDockerBinary(requested = "docker"): string {
  if (isAbsolute(requested)) {
    try {
      return canonicalExecutable(requested);
    } catch {
      throw new Error("the explicitly selected Docker client is not an executable regular file");
    }
  }
  if (requested !== "docker" && requested !== "docker.exe") {
    throw new Error("Docker client must be an explicit absolute path");
  }
  for (const path of trustedDockerLocations()) {
    try {
      return canonicalExecutable(path);
    } catch {
      // Try the next fixed platform location. PATH is deliberately not read.
    }
  }
  throw new Error("Docker client was not found at a fixed trusted platform location; pass --docker-bin with an absolute path");
}

/** Accept only Unix-socket or Windows named-pipe Docker transport shapes. */
export function isLocalDockerEndpoint(endpoint: string, platform: NodeJS.Platform = process.platform): boolean {
  if (endpoint.includes("\0") || /[\r\n]/.test(endpoint)) return false;
  if (endpoint.startsWith("unix:///")) {
    const path = endpoint.slice("unix://".length);
    return path.startsWith("/") && path.length > 1 && !/[?#]/.test(path);
  }
  if (platform === "win32") {
    return /^npipe:\/{4}\.\/pipe\/[A-Za-z0-9._-]+$/.test(endpoint);
  }
  return false;
}

function contextEndpoint(dockerBin: string, context?: string): DockerDaemonCheck {
  const args = ["context", "inspect"];
  if (context) args.push(context);
  args.push("--format", "{{json .Endpoints.docker.Host}}");
  const inspected = spawnSync(dockerBin, args, {
    encoding: "utf8",
    timeout: DOCKER_CONTROL_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    env: process.env,
  });
  if (inspected.status !== 0 || inspected.error) {
    return { local: false, reason: "the selected Docker daemon endpoint could not be inspected" };
  }
  try {
    const endpoint = JSON.parse(inspected.stdout.trim()) as unknown;
    if (typeof endpoint !== "string" || !isLocalDockerEndpoint(endpoint)) {
      return {
        local: false,
        ...(typeof endpoint === "string" ? { endpoint } : {}),
        reason: "the selected Docker daemon endpoint is not a local unix or Windows named-pipe endpoint",
      };
    }
    return { local: true, endpoint, reason: "the selected Docker endpoint uses an accepted local transport shape" };
  } catch {
    return { local: false, reason: "the selected Docker daemon endpoint inspection returned malformed output" };
  }
}

/**
 * Resolve one executable/endpoint/environment tuple. All later Docker calls can
 * carry this opaque value so endpoint-selection environment changes cannot
 * redirect only part of an evaluation.
 */
export function resolveDockerClient(dockerBin = "docker"): ResolvedDockerClient {
  const executable = resolveDockerBinary(dockerBin);
  const selectedContext = process.env.DOCKER_CONTEXT?.trim();
  let daemon: DockerDaemonCheck;
  if (selectedContext) daemon = contextEndpoint(executable, selectedContext);
  else {
    const selectedHost = process.env.DOCKER_HOST?.trim();
    if (selectedHost) {
      daemon = isLocalDockerEndpoint(selectedHost)
        ? { local: true, endpoint: selectedHost, reason: "DOCKER_HOST selects an accepted local Docker transport shape" }
        : { local: false, endpoint: selectedHost, reason: "DOCKER_HOST does not select a local unix or Windows named-pipe endpoint" };
    } else daemon = contextEndpoint(executable);
  }
  if (!daemon.local || !daemon.endpoint) throw new Error(daemon.reason);
  return Object.freeze({
    executable,
    endpoint: daemon.endpoint,
    env: sanitizedDockerEnvironment(process.env),
    [RESOLVED_DOCKER_CLIENT]: true as const,
  });
}

function selectedDockerClient(selection: DockerClientSelection): ResolvedDockerClient {
  if (typeof selection === "string") return resolveDockerClient(selection);
  if (selection[RESOLVED_DOCKER_CLIENT] !== true
    || !isLocalDockerEndpoint(selection.endpoint)
    || resolveDockerBinary(selection.executable) !== selection.executable
    || Object.keys(selection.env).some(isDockerEndpointEnvironment)) {
    throw new Error("resolved Docker client is not a validated local endpoint binding");
  }
  return selection;
}

/** Inspect the endpoint that Docker will use, honoring Docker's override order. */
export function inspectDockerDaemon(dockerBin = "docker"): DockerDaemonCheck {
  try {
    const client = resolveDockerClient(dockerBin);
    return { local: true, endpoint: client.endpoint, reason: "the selected Docker endpoint uses an accepted local transport shape" };
  } catch (error) {
    return { local: false, reason: (error as Error).message };
  }
}

function dockerArgs(client: ResolvedDockerClient, args: string[]): string[] {
  return ["--host", client.endpoint, ...args];
}

function dockerEnvironment(
  client: ResolvedDockerClient,
  additions: Readonly<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const environment = { ...client.env, ...additions };
  for (const name of Object.keys(environment)) {
    if (isDockerEndpointEnvironment(name)) delete environment[name];
  }
  return environment;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function mountedPath(path: string, label: string): string {
  const canonicalPath = realpathSync(path);
  if (canonicalPath.includes(",") || canonicalPath.includes("\n") || canonicalPath.includes("\0")) {
    throw new Error(`${label} path cannot be represented safely as a Docker bind mount`);
  }
  return canonicalPath;
}

function dockerBaseArgs(
  config: UpgradeConfig,
  targetDirectory: string,
  canaryDirectory: string,
  containerName: string,
): string[] {
  const target = mountedPath(targetDirectory, "target");
  const canaries = mountedPath(canaryDirectory, "canary directory");
  const hostUid = typeof process.getuid === "function" ? process.getuid() : 65532;
  const hostGid = typeof process.getgid === "function" ? process.getgid() : 65532;
  const containerUid = hostUid > 0 ? hostUid : 65532;
  const containerGid = hostGid > 0 ? hostGid : 65532;
  const args = [
    "run", "--name", containerName, "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", `--pids-limit=${config.runner.pids}`,
    `--memory=${config.runner.memoryMiB}m`, `--cpus=${config.runner.cpus}`, `--user=${containerUid}:${containerGid}`,
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m", "--workdir=/canaries",
    "--mount", `type=bind,src=${target},dst=/target,readonly`,
    "--mount", `type=bind,src=${canaries},dst=/canaries,readonly`,
  ];
  for (const name of PROXY_NAMES) args.push("--env", `${name}=`);
  return args;
}

function imageDigest(config: UpgradeConfig): string {
  return config.runner.image.slice(config.runner.image.lastIndexOf("@") + 1);
}

function containerName(): string {
  return `agent-vigil-upgrade-${randomBytes(12).toString("hex")}`;
}

function forceRemoveAndVerify(client: ResolvedDockerClient, name: string): ContainerCleanup {
  const removed = spawnSync(client.executable, dockerArgs(
    client,
    ["container", "rm", "--force", "--volumes", name],
  ), {
    encoding: "utf8",
    timeout: DOCKER_CONTROL_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    env: dockerEnvironment(client),
  });
  if (removed.status !== 0 || removed.error) {
    return { absent: false, reason: "the named container could not be force-removed with attached volumes" };
  }
  const listed = spawnSync(
    client.executable,
    dockerArgs(client, ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]),
    {
      encoding: "utf8",
      timeout: DOCKER_CONTROL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      env: dockerEnvironment(client),
    },
  );
  if (listed.status !== 0 || listed.error) {
    return { absent: false, reason: "the named container absence check failed" };
  }
  if (listed.stdout.trim() === "") return { absent: true, reason: "the named container is absent" };
  return { absent: false, reason: "the named container could not be force-removed and verified absent" };
}

export function dockerImagePresent(
  config: UpgradeConfig,
  selection: DockerClientSelection = "docker",
): boolean {
  let client: ResolvedDockerClient;
  try {
    client = selectedDockerClient(selection);
  } catch {
    return false;
  }
  const inspected = spawnSync(
    client.executable,
    dockerArgs(client, ["image", "inspect", "--format", "{{json .RepoDigests}}", config.runner.image]),
    {
      encoding: "utf8",
      timeout: DOCKER_CONTROL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      env: dockerEnvironment(client),
    },
  );
  if (inspected.status !== 0 || inspected.error || !inspected.stdout.trim()) return false;
  try {
    const values = JSON.parse(inspected.stdout) as unknown;
    return Array.isArray(values) && values.some((value) => typeof value === "string" && value.endsWith(`@${imageDigest(config)}`));
  } catch {
    return false;
  }
}

const PROBE_SCRIPT = String.raw`
const fs=require("node:fs"),net=require("node:net");
const out={targetReadOnly:false,rootReadOnly:false,inheritedSecretAbsent:process.env.VIGIL_UPGRADE_PROBE_SECRET===undefined,proxiesCleared:true,networkBlocked:false};
for(const n of ["HTTP_PROXY","HTTPS_PROXY","FTP_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","ftp_proxy","all_proxy","no_proxy"]){if((process.env[n]||"")!=="")out.proxiesCleared=false;}
try{fs.writeFileSync("/target/.agent-vigil-containment-probe","x");}catch{out.targetReadOnly=true;}
try{fs.writeFileSync("/.agent-vigil-containment-probe","x");}catch{out.rootReadOnly=true;}
let done=false; const finish=(blocked)=>{if(done)return;done=true;out.networkBlocked=blocked;process.stdout.write(JSON.stringify(out));};
const socket=net.connect({host:"1.1.1.1",port:53});
socket.setTimeout(600); socket.once("connect",()=>{socket.destroy();finish(false)}); socket.once("error",()=>finish(true)); socket.once("timeout",()=>{socket.destroy();finish(true)});
setTimeout(()=>finish(true),900);
`;

export function probeContainment(
  config: UpgradeConfig,
  targetDirectory: string,
  canaryDirectory: string,
  selection: DockerClientSelection = "docker",
): ContainmentProbe {
  let client: ResolvedDockerClient;
  try {
    client = selectedDockerClient(selection);
  } catch (error) {
    return {
      status: "HOLD", localEndpoint: false, imagePresent: false, networkBlocked: false, targetReadOnly: false,
      rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
      reason: (error as Error).message,
    };
  }
  if (!dockerImagePresent(config, client)) {
    return {
      status: "HOLD", localEndpoint: true, imagePresent: false, networkBlocked: false, targetReadOnly: false,
      rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
      reason: "the exact-digest runner image is not present locally; Upgrade Guard never pulls during a check",
    };
  }
  const name = containerName();
  let args: string[];
  try {
    args = dockerBaseArgs(config, targetDirectory, canaryDirectory, name);
  } catch (error) {
    return {
      status: "HOLD", localEndpoint: true, imagePresent: true, networkBlocked: false, targetReadOnly: false,
      rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
      reason: (error as Error).message,
    };
  }
  args.push("--env", "VIGIL_TARGET=/target", config.runner.image, "node", "-e", PROBE_SCRIPT);
  const secret = randomBytes(24).toString("hex");
  let result: SpawnSyncReturns<string>;
  let cleanup: ContainerCleanup;
  try {
    result = spawnSync(client.executable, dockerArgs(client, args), {
      encoding: "utf8",
      timeout: CONTAINMENT_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      env: dockerEnvironment(client, { VIGIL_UPGRADE_PROBE_SECRET: secret }),
    });
  } finally {
    cleanup = forceRemoveAndVerify(client, name);
  }
  if (!cleanup.absent) {
    return {
      status: "HOLD", localEndpoint: true, imagePresent: true, networkBlocked: false, targetReadOnly: false,
      rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
      reason: cleanup.reason,
    };
  }
  if (result.status !== 0 || result.error) {
    return {
      status: "HOLD", localEndpoint: true, imagePresent: true, networkBlocked: false, targetReadOnly: false,
      rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
      reason: result.error ? "containment probe did not complete" : `containment probe exited ${result.status ?? "without a status"}`,
    };
  }
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    const networkBlocked = value.networkBlocked === true;
    const targetReadOnly = value.targetReadOnly === true;
    const rootReadOnly = value.rootReadOnly === true;
    const inheritedSecretAbsent = value.inheritedSecretAbsent === true;
    const proxiesCleared = value.proxiesCleared === true;
    const status = networkBlocked && targetReadOnly && rootReadOnly && inheritedSecretAbsent && proxiesCleared ? "PASS" : "HOLD";
    return {
      status,
      localEndpoint: true,
      imagePresent: true,
      networkBlocked,
      targetReadOnly,
      rootReadOnly,
      inheritedSecretAbsent,
      proxiesCleared,
      reason: status === "PASS"
        ? "network, target writes, root writes, inherited probe secret, and Docker client proxy injection were blocked"
        : "one or more required containment controls did not hold",
    };
  } catch {
    return {
      status: "HOLD", localEndpoint: true, imagePresent: true, networkBlocked: false, targetReadOnly: false,
      rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
      reason: "containment probe returned malformed output",
    };
  }
}

export function runCanaryTrial(
  config: UpgradeConfig,
  canary: UpgradeCanaryConfig,
  targetDirectory: string,
  canaryDirectory: string,
  phase: "current" | "candidate",
  selection: DockerClientSelection = "docker",
): CanaryTrial {
  let client: ResolvedDockerClient;
  try {
    client = selectedDockerClient(selection);
  } catch (error) {
    return { state: "HOLD", reason: (error as Error).message };
  }
  const name = containerName();
  let args: string[];
  try {
    args = dockerBaseArgs(config, targetDirectory, canaryDirectory, name);
  } catch (error) {
    return { state: "HOLD", reason: (error as Error).message };
  }
  args.push(
    "--env", "VIGIL_TARGET=/target",
    "--env", `VIGIL_PHASE=${phase}`,
    config.runner.image,
    ...canary.command,
  );
  let result: SpawnSyncReturns<Buffer>;
  let cleanup: ContainerCleanup;
  try {
    result = spawnSync(client.executable, dockerArgs(client, args), {
      timeout: canary.timeoutSeconds * 1_000,
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024,
      env: dockerEnvironment(client),
    });
  } finally {
    cleanup = forceRemoveAndVerify(client, name);
  }
  if (!cleanup.absent) return { state: "HOLD", reason: cleanup.reason };
  if (result.error) {
    const timeout = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { state: "HOLD", reason: timeout ? "canary timed out" : "container execution failed" };
  }
  if (result.status !== 0) return { state: "HOLD", reason: `container exited ${result.status ?? "without a status"}` };
  let document: CanaryDocument;
  try {
    document = parseCanaryDocument(result.stdout);
  } catch {
    return { state: "HOLD", reason: "canary returned malformed or unbounded JSON" };
  }
  const observationSha256 = digest(canonical(document.observations));
  return {
    state: document.outcome,
    observationSha256,
    observationCount: Object.keys(document.observations).length,
    reason: document.outcome === "PASS" ? "canary completed with bounded observations" : "trusted canary reported FAIL",
  };
}

export function commandDigest(canary: UpgradeCanaryConfig): string {
  return digest(canonical(canary.command));
}
