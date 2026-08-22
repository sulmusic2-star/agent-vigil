import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { canonical } from "../report.ts";
import { validateCanaryDocument, type CanaryDocument, type UpgradeCanaryConfig, type UpgradeConfig } from "./contracts.ts";

const PROXY_NAMES = [
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy",
] as const;

export type ContainmentProbe = {
  status: "PASS" | "HOLD";
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

function dockerBaseArgs(config: UpgradeConfig, targetDirectory: string, canaryDirectory: string): string[] {
  const target = mountedPath(targetDirectory, "target");
  const canaries = mountedPath(canaryDirectory, "canary directory");
  const hostUid = typeof process.getuid === "function" ? process.getuid() : 65532;
  const hostGid = typeof process.getgid === "function" ? process.getgid() : 65532;
  const containerUid = hostUid > 0 ? hostUid : 65532;
  const containerGid = hostGid > 0 ? hostGid : 65532;
  const args = [
    "run", "--rm", "--pull=never", "--network=none", "--read-only",
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

export function dockerImagePresent(config: UpgradeConfig, dockerBin = "docker"): boolean {
  const inspected = spawnSync(
    dockerBin,
    ["image", "inspect", "--format", "{{json .RepoDigests}}", config.runner.image],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
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
  dockerBin = "docker",
): ContainmentProbe {
  if (!dockerImagePresent(config, dockerBin)) {
    return {
      status: "HOLD", imagePresent: false, networkBlocked: false, targetReadOnly: false,
      rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
      reason: "the exact-digest runner image is not present locally; Upgrade Guard never pulls during a check",
    };
  }
  let args: string[];
  try {
    args = dockerBaseArgs(config, targetDirectory, canaryDirectory);
  } catch (error) {
    return {
      status: "HOLD", imagePresent: true, networkBlocked: false, targetReadOnly: false,
      rootReadOnly: false, inheritedSecretAbsent: false, proxiesCleared: false,
      reason: (error as Error).message,
    };
  }
  args.push("--env", "VIGIL_TARGET=/target", config.runner.image, "node", "-e", PROBE_SCRIPT);
  const secret = randomBytes(24).toString("hex");
  const result = spawnSync(dockerBin, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, VIGIL_UPGRADE_PROBE_SECRET: secret },
  });
  if (result.status !== 0 || result.error) {
    return {
      status: "HOLD", imagePresent: true, networkBlocked: false, targetReadOnly: false,
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
      status: "HOLD", imagePresent: true, networkBlocked: false, targetReadOnly: false,
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
  dockerBin = "docker",
): CanaryTrial {
  let args: string[];
  try {
    args = dockerBaseArgs(config, targetDirectory, canaryDirectory);
  } catch (error) {
    return { state: "HOLD", reason: (error as Error).message };
  }
  args.push(
    "--env", "VIGIL_TARGET=/target",
    "--env", `VIGIL_PHASE=${phase}`,
    config.runner.image,
    ...canary.command,
  );
  const result = spawnSync(dockerBin, args, {
    encoding: "utf8",
    timeout: canary.timeoutSeconds * 1_000,
    maxBuffer: 128 * 1024,
    env: process.env,
  });
  if (result.error) {
    const timeout = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { state: "HOLD", reason: timeout ? "canary timed out" : "container execution failed" };
  }
  if (result.status !== 0) return { state: "HOLD", reason: `container exited ${result.status ?? "without a status"}` };
  let document: CanaryDocument;
  try {
    document = validateCanaryDocument(JSON.parse(result.stdout.trim()));
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
