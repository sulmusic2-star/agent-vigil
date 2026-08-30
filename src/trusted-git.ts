import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { readRegularFileSnapshot } from "./safe-fs.ts";

const ACTION_GIT_PATH = "/usr/bin:/bin";
const checkpoints = new Map<string, { identity: string; sha256: string }>();

class TrustedGitIntegrityError extends Error {}

function trustedGitEnvironment(fixed: boolean): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const env: NodeJS.ProcessEnv = {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PATH: fixed ? ACTION_GIT_PATH : (process.env.PATH ?? ""),
    HOME: process.platform === "win32" ? "C:\\agent-vigil-nonexistent" : "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: process.platform === "win32" ? "" : "/bin/false",
    SSH_ASKPASS: process.platform === "win32" ? "" : "/bin/false",
    GIT_SSH_COMMAND: process.platform === "win32" ? "false" : "/bin/false",
    GIT_LITERAL_PATHSPECS: "1",
  };
  if (!fixed && process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"] as const) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  return env;
}

function hardenedArguments(args: string[]): string[] {
  if (!args.length) throw new Error("trusted Git command is missing");
  const [command, ...rest] = args;
  const commandArguments = command === "diff"
    ? [command, "--no-ext-diff", "--no-textconv", ...rest]
    : [command, ...rest];
  return [
    "--no-pager",
    "--no-replace-objects",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null",
    "-c", "credential.helper=",
    "-c", "diff.external=",
    "-c", "protocol.ext.allow=never",
    ...commandArguments,
  ];
}

function fixedBinary(): string {
  const configured = process.env.AGENT_VIGIL_INTERNAL_GIT_BIN;
  if (!configured) return "git";
  if (!isAbsolute(configured) || resolve(configured) !== configured) throw new TrustedGitIntegrityError("trusted Git binary path must be absolute and normalized");
  try {
    const snapshot = readRegularFileSnapshot(configured, 512 * 1024 * 1024, "trusted Git binary");
    const current = {
      identity: snapshot.identity,
      sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
    };
    const checkpoint = checkpoints.get(configured);
    if (!checkpoint) checkpoints.set(configured, current);
    else if (checkpoint.identity !== current.identity || checkpoint.sha256 !== current.sha256) {
      throw new TrustedGitIntegrityError("trusted Git binary changed during verification");
    }
    return configured;
  } catch (error) {
    if (error instanceof TrustedGitIntegrityError) throw error;
    throw new TrustedGitIntegrityError("trusted Git binary could not be validated");
  }
}

/** Execute a trusted-parent Git query with candidate-controlled Git config sinks disabled. */
export function trustedGit(repo: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  const binary = fixedBinary();
  const fixed = Boolean(process.env.AGENT_VIGIL_INTERNAL_GIT_BIN);
  const output = execFileSync(binary, hardenedArguments(args), {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
    env: trustedGitEnvironment(fixed),
  });
  if (process.env.AGENT_VIGIL_INTERNAL_GIT_BIN) fixedBinary();
  return output;
}

export function trustedGitOptional(repo: string, args: string[], maxBuffer = 64 * 1024 * 1024): string | undefined {
  try {
    return trustedGit(repo, args, maxBuffer);
  } catch (error) {
    if (error instanceof TrustedGitIntegrityError) throw error;
    return undefined;
  }
}
