import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, realpathSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { trustedGit } from "./trusted-git.ts";

export const PINNED_CANDIDATE_IMAGE = "node@sha256:46e94f8cf91baab69a2deb3153e74eeffd73c20c7cc1d8432f5b96469eaa0322";

const MAX_COMMAND_OUTPUT = 12_000;
const MAX_WRAPPER_CAPTURE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MARKER = "[agent-vigil-command-timeout]";
const ABNORMAL_MARKER = "[agent-vigil-command-abnormal]";
const CONTAINER_PREFIX = "agent-vigil-candidate-";
const COMMAND_WRAPPER = String.raw`
const { execFile, spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
const command = process.argv[1];
const timeout = Number(process.argv[2]);
const windows = process.platform === "win32";
const shell = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
// POSIX shells synthesize and export PWD even when their own environment was
// created with env -i. Remove it before candidate code starts so the hosted
// sandbox contract remains the exact explicit allowlist.
// Match Node's own cmd.exe normalization: /s removes the outer quote pair,
// leaving command-owned quotes intact, while verbatim argv prevents libuv's
// C-runtime escaping from rewriting those quotes into syntax cmd cannot parse.
const shellArgs = windows ? ["/d", "/s", "/c", '"' + command + '"'] : ["-c", "unset PWD\n" + command];
// Retain the child-owned pipes until EOF so a descendant that inherits them
// remains tied to this wrapper's timeout. Buffer under the outer verifier's
// maxBuffer, then synchronously forward complete bytes after the child closes;
// JavaScript stream re-piping can drop the final test summary on Windows.
const child = spawn(shell, shellArgs, {
  env: process.env,
  // POSIX needs a detached process group for the negative-PID kill below.
  // On Windows, taskkill /T already terminates the process tree; detaching cmd
  // lets it return before the candidate console program has actually exited.
  detached: !windows,
  stdio: ["ignore", "pipe", "pipe"],
  windowsVerbatimArguments: windows,
});
const captureLimit = ${MAX_WRAPPER_CAPTURE_BYTES};
const stdoutChunks = [];
const stderrChunks = [];
let capturedBytes = 0;
let timedOut = false;
let terminating = false;
let finished = false;
const writeAll = (fd, chunks) => {
  for (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.length) {
      const written = writeSync(fd, chunk, offset, chunk.length - offset);
      if (written <= 0) throw new Error("candidate output descriptor stopped accepting bytes");
      offset += written;
    }
  }
};
const finish = (code, marker = "") => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try {
    writeAll(1, stdoutChunks);
    writeAll(2, stderrChunks);
    if (marker) writeAll(2, [Buffer.from(marker + "\\n")]);
    // Setting exitCode lets the wrapper's own descriptors settle. Calling
    // process.exit() here can discard the final test summary on Windows.
    process.exitCode = code;
  } catch {
    process.exitCode = 125;
  }
};
const terminateTree = (code, marker) => {
  if (terminating || finished) return;
  terminating = true;
  clearTimeout(timer);
  const stopCapture = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  if (windows) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
      stopCapture();
      finish(code, marker);
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    setTimeout(() => {
      stopCapture();
      finish(code, marker);
    }, 50);
  }
};
const capture = (stream, chunks) => {
  stream.on("data", (value) => {
    if (terminating || finished) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = captureLimit - capturedBytes;
    if (remaining > 0) {
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      capturedBytes += kept.length;
    }
    if (chunk.length > remaining) {
      terminateTree(125, "${ABNORMAL_MARKER} output exceeded " + captureLimit + " bytes");
    }
  });
  stream.on("error", (error) => {
    terminateTree(125, "${ABNORMAL_MARKER} output capture failed: " + error.message);
  });
};
capture(child.stdout, stdoutChunks);
capture(child.stderr, stderrChunks);
const timer = setTimeout(() => {
  timedOut = true;
  terminateTree(124, "${TIMEOUT_MARKER}");
}, timeout);
child.on("error", (error) => {
  finish(125, "${ABNORMAL_MARKER} " + error.message);
});
child.on("close", (code, signal) => {
  if (timedOut || terminating || finished) return;
  if (signal || code === null) {
    finish(125, "${ABNORMAL_MARKER} signal=" + (signal || "unknown"));
    return;
  }
  finish(code);
});
`;

export type CandidateCommandOutcome = {
  status: number | null;
  signal: string | null;
  /** Bounded in-memory output used only for semantic classification; never copied into receipts. */
  classificationOutput?: string;
  output: string;
  error?: string;
};

export type CandidateCommandOptions = {
  /** Network is denied unless the trusted base policy explicitly selects a dependency-setup command. */
  allowNetwork?: boolean;
  /** Maintainer mode creates its source worktrees with the trusted Git helper. */
  trustedSourceWorktree?: boolean;
  /** Exact changed-test files that the trusted differential verifier may overlay onto a base commit. */
  overlayPaths?: readonly string[];
};

type FileCheckpoint = {
  identity: string;
  sha256: string;
};

type RuntimeCheckpoint = FileCheckpoint & {
  executable: string;
  directory: string;
  directoryIdentity: string;
};

const executableCheckpoints = new Map<string, FileCheckpoint>();
let runtimeCheckpoint: RuntimeCheckpoint | undefined;

type ManifestEntry =
  | { kind: "file"; mode: number; size: number; identity: string; value: string }
  | { kind: "symlink"; mode: number; identity: string; value: string };
type CandidateSandbox = {
  source: string;
  sourceHead: string;
  directory: string;
  sourceManifest: Map<string, ManifestEntry>;
  sandboxManifest: Map<string, ManifestEntry>;
  overlayPaths: string[];
};

const candidateSandboxes = new Map<string, CandidateSandbox>();

function statIdentity(value: Stats): string {
  return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode, value.uid, value.gid].join(":");
}

function identity(path: string, kind: "file" | "directory"): string {
  const value = lstatSync(path);
  if (value.isSymbolicLink() || (kind === "file" ? !value.isFile() : !value.isDirectory())) {
    throw new Error(`trusted ${kind} identity is invalid`);
  }
  return statIdentity(value);
}

function sha256File(path: string): string {
  const digest = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function executableIsIntact(path: string): boolean {
  try {
    const executable = resolve(path);
    if (!isAbsolute(path) || executable !== path) return false;
    const current = { identity: identity(executable, "file"), sha256: sha256File(executable) };
    const checkpoint = executableCheckpoints.get(executable);
    if (!checkpoint) {
      executableCheckpoints.set(executable, current);
      return true;
    }
    return checkpoint.identity === current.identity && checkpoint.sha256 === current.sha256;
  } catch {
    return false;
  }
}

function trustedRuntimeIsIntact(internalTestPath: string): boolean {
  try {
    const directory = resolve(internalTestPath.split(":", 1)[0]);
    const executable = resolve(process.execPath);
    if (executable !== join(directory, "node")) return false;
    if (!runtimeCheckpoint) {
      runtimeCheckpoint = {
        executable,
        directory,
        identity: identity(executable, "file"),
        directoryIdentity: identity(directory, "directory"),
        sha256: sha256File(executable),
      };
    }
    return runtimeCheckpoint.executable === executable
      && runtimeCheckpoint.directory === directory
      && runtimeCheckpoint.identity === identity(executable, "file")
      && runtimeCheckpoint.directoryIdentity === identity(directory, "directory")
      && runtimeCheckpoint.sha256 === sha256File(executable);
  } catch {
    return false;
  }
}

function truncateOutput(value: string): string {
  return value.length > MAX_COMMAND_OUTPUT ? `${value.slice(0, MAX_COMMAND_OUTPUT)}\n[output truncated]` : value;
}

function outcomeFromExecution(execution: ReturnType<typeof spawnSync>, extraError?: string): CandidateCommandOutcome {
  const full = `${execution.stdout ?? ""}${execution.stderr ?? ""}`;
  const wrapperError = full.includes(TIMEOUT_MARKER)
    ? "command timed out"
    : full.includes(ABNORMAL_MARKER)
      ? "command ended abnormally"
      : execution.error?.message;
  const error = extraError ?? wrapperError;
  return {
    status: execution.status,
    signal: execution.signal,
    classificationOutput: full,
    output: truncateOutput(full),
    ...(error ? { error } : {}),
  };
}

function localCommand(command: string, cwd: string, timeoutMs: number): CandidateCommandOutcome {
  const internalTestPath = process.env.AGENT_VIGIL_INTERNAL_TEST_PATH;
  const internalTestHome = process.env.AGENT_VIGIL_INTERNAL_TEST_HOME;
  const env: NodeJS.ProcessEnv = {
    ...(internalTestPath === undefined
      ? process.env
      : {
          LANG: "C", LC_ALL: "C", TZ: "UTC", PATH: internalTestPath,
          ...(internalTestHome === undefined ? {} : { HOME: internalTestHome }),
        }),
    CI: "true",
  };
  delete env.NODE_TEST_CONTEXT;
  const execution = spawnSync(process.execPath, ["-e", COMMAND_WRAPPER, command, String(timeoutMs)], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs + 10_000,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  return outcomeFromExecution(execution);
}

function dockerEnvironment(home: string | undefined): NodeJS.ProcessEnv {
  const trustedHome = home && isAbsolute(home) ? home : "/nonexistent";
  return {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PATH: "/usr/bin:/bin",
    HOME: trustedHome,
    DOCKER_CONFIG: join(trustedHome, ".docker"),
  };
}

function inside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function commonGitDirectory(repository: string): string {
  const selected = trustedGit(repository, ["rev-parse", "--git-common-dir"]).trim();
  return realpathSync(isAbsolute(selected) ? selected : resolve(repository, selected));
}

function validateSourceRepository(cwd: string, trustedSourceWorktree: boolean): string {
  const source = realpathSync(cwd);
  const configuredWorkspace = process.env.GITHUB_WORKSPACE;
  if (!configuredWorkspace) throw new Error("candidate isolation requires GITHUB_WORKSPACE");
  const workspace = realpathSync(configuredWorkspace);
  if (!trustedSourceWorktree && source !== workspace) {
    throw new Error("candidate source repository must equal GITHUB_WORKSPACE");
  }
  if (trustedSourceWorktree && commonGitDirectory(source) !== commonGitDirectory(workspace)) {
    throw new Error("candidate source worktree is not attached to GITHUB_WORKSPACE");
  }
  return source;
}

function validateCandidateRoot(source: string): string {
  const configured = process.env.AGENT_VIGIL_INTERNAL_CANDIDATE_ROOT;
  if (!configured || !isAbsolute(configured)) throw new Error("candidate isolation requires an absolute trusted candidate root");
  const root = realpathSync(configured);
  const value = lstatSync(root);
  if (value.isSymbolicLink() || !value.isDirectory()) throw new Error("trusted candidate root must be a regular directory");
  if ((value.mode & 0o022) !== 0) throw new Error("trusted candidate root must not be group- or world-writable");
  if (typeof process.getuid === "function" && value.uid !== process.getuid()) throw new Error("trusted candidate root must be owned by the verifier user");
  if (inside(source, root) || inside(root, source)) throw new Error("trusted candidate root and source repository must be disjoint");
  return root;
}

function repositoryPaths(source: string): string[] {
  return [...new Set(trustedGit(source, ["ls-files", "-z"]).split("\0").filter(Boolean))].sort();
}

function checkedPath(root: string, path: string): string {
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`) || path.split(/[\\/]/).includes(".git")) {
    throw new Error(`unsafe candidate source path: ${path}`);
  }
  const selected = resolve(root, path);
  if (!inside(root, selected)) throw new Error(`candidate source path escaped its repository: ${path}`);
  return selected;
}

function validateManifestAncestors(root: string, path: string): void {
  const components = path.split("/");
  let selected = root;
  for (const component of components.slice(0, -1)) {
    selected = join(selected, component);
    let value: Stats;
    try { value = lstatSync(selected); }
    catch { throw new Error(`unsafe candidate manifest ancestor for ${path}: missing parent`); }
    if (value.isSymbolicLink() || !value.isDirectory()) {
      throw new Error(`unsafe candidate manifest ancestor for ${path}: parent is not a regular directory`);
    }
  }
}

function sha256Descriptor(descriptor: number, expectedSize: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, expectedSize)));
  let remaining = expectedSize;
  while (remaining > 0) {
    const bytes = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
    if (bytes === 0) throw new Error("candidate manifest file ended before its recorded size");
    digest.update(buffer.subarray(0, bytes));
    remaining -= bytes;
  }
  if (readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, null) !== 0) {
    throw new Error("candidate manifest file grew beyond its recorded size");
  }
  return digest.digest("hex");
}

function manifestEntry(root: string, path: string, expected?: ManifestEntry): ManifestEntry {
  validateManifestAncestors(root, path);
  const selected = checkedPath(root, path);
  const before = lstatSync(selected);
  if (before.isSymbolicLink()) {
    const target = readlinkSync(selected);
    const after = lstatSync(selected);
    if (!after.isSymbolicLink() || statIdentity(before) !== statIdentity(after)) {
      throw new Error(`candidate manifest symlink changed while inspected: ${path}`);
    }
    return { kind: "symlink", mode: after.mode & 0o7777, identity: statIdentity(after), value: target };
  }
  if (!before.isFile()) throw new Error(`candidate manifest path has unsupported file type: ${path}`);

  const descriptor = openSync(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`candidate manifest file identity changed while opened: ${path}`);
    }
    const current = {
      kind: "file" as const,
      mode: opened.mode & 0o7777,
      size: opened.size,
      identity: statIdentity(opened),
    };
    if (expected?.kind === "file"
      && (current.mode !== expected.mode || current.size !== expected.size || current.identity !== expected.identity)) {
      return { ...current, value: "" };
    }
    const value = sha256Descriptor(descriptor, opened.size);
    const after = fstatSync(descriptor);
    if (statIdentity(after) !== current.identity) {
      throw new Error(`candidate manifest file changed while read: ${path}`);
    }
    return { ...current, value };
  } finally {
    closeSync(descriptor);
  }
}

function sourceStatusPaths(source: string): string[] {
  const records = trustedGit(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    .split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("candidate source status could not be parsed safely");
    paths.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
      const original = records[index + 1];
      if (!original) throw new Error("candidate source rename status could not be parsed safely");
      paths.push(original);
      index += 1;
    }
  }
  return paths;
}

function normalizedOverlayPaths(source: string, values: readonly string[] | undefined): string[] {
  const paths = [...new Set(values ?? [])].sort();
  for (const path of paths) checkedPath(source, path);
  return paths;
}

function sourceStateError(source: string, overlayPaths: readonly string[]): string | undefined {
  const allowed = new Set(overlayPaths);
  const changes = sourceStatusPaths(source);
  if (changes.some((path) => !allowed.has(path))) {
    return "candidate source worktree contains bytes outside the exact commit and trusted differential overlay";
  }
  return undefined;
}

function materializeExactHead(source: string, destination: string, sourceHead: string): void {
  trustedGit(destination, ["init", "--quiet"]);
  trustedGit(destination, [
    "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--depth=1",
    source, sourceHead,
  ]);
  trustedGit(destination, ["checkout", "--detach", "--force", sourceHead]);

  const refs = trustedGit(destination, ["for-each-ref", "--format=%(refname)"]).trim();
  const count = trustedGit(destination, ["rev-list", "--count", "HEAD"]).trim();
  const sourceParentCount = Math.max(0, trustedGit(source, ["rev-list", "--parents", "-n", "1", sourceHead]).trim().split(/\s+/).length - 1);
  const shallow = trustedGit(destination, ["rev-parse", "--is-shallow-repository"]).trim();
  const common = commonGitDirectory(destination);
  if (refs || count !== "1" || (sourceParentCount > 0 && shallow !== "true")
    || existsSync(join(common, "objects", "info", "alternates"))) {
    throw new Error("candidate sandbox did not reduce Git visibility to the exact selected commit");
  }

  const reachable = new Set(trustedGit(destination, ["rev-list", "--objects", "HEAD"])
    .split("\n").filter(Boolean).map((line) => line.split(" ", 1)[0]));
  const stored = new Set(trustedGit(destination, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .split("\n").filter(Boolean));
  if (reachable.size !== stored.size || [...stored].some((object) => !reachable.has(object))) {
    throw new Error("candidate sandbox contains Git objects outside the exact selected commit tree");
  }
}

function ensureOverlayDestinationAncestors(root: string, path: string): void {
  const components = path.split("/");
  let selected = root;
  for (const component of components.slice(0, -1)) {
    selected = join(selected, component);
    try {
      const value = lstatSync(selected);
      if (value.isSymbolicLink() || !value.isDirectory()) {
        throw new Error("trusted differential overlay target has an unsafe ancestor");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(selected, { mode: 0o700 });
      const created = lstatSync(selected);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("trusted differential overlay target ancestor was not created safely");
      }
    }
  }
}

function copyOverlayPaths(source: string, destination: string, paths: string[]): void {
  for (const path of paths) {
    validateManifestAncestors(source, path);
    const from = checkedPath(source, path);
    const to = checkedPath(destination, path);
    let before: ReturnType<typeof lstatSync>;
    try { before = lstatSync(from); }
    catch { throw new Error(`candidate source path is missing: ${path}`); }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`trusted differential overlay source is not a regular file: ${path}`);
    }
    const input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: number | undefined;
    try {
      const opened = fstatSync(input);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`trusted differential overlay source changed while opened: ${path}`);
      }
      ensureOverlayDestinationAncestors(destination, path);
      let target: ReturnType<typeof lstatSync> | undefined;
      try { target = lstatSync(to); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (target && (target.isSymbolicLink() || !target.isFile())) {
        throw new Error(`trusted differential overlay target is not a regular file: ${path}`);
      }
      output = openSync(to, constants.O_WRONLY | constants.O_NOFOLLOW
        | (target ? constants.O_TRUNC : constants.O_CREAT | constants.O_EXCL), opened.mode & 0o777);
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
      let copied = 0;
      for (;;) {
        const bytes = readSync(input, buffer, 0, buffer.length, null);
        if (bytes === 0) break;
        let written = 0;
        while (written < bytes) written += writeSync(output, buffer, written, bytes - written);
        copied += bytes;
      }
      fchmodSync(output, opened.mode & 0o777);
      const sourceAfter = fstatSync(input);
      const targetAfter = fstatSync(output);
      if (statIdentity(sourceAfter) !== statIdentity(opened)
        || !targetAfter.isFile() || targetAfter.size !== copied || copied !== opened.size) {
        throw new Error(`trusted differential overlay changed while copied: ${path}`);
      }
    } finally {
      if (output !== undefined) closeSync(output);
      closeSync(input);
    }
  }
}

function manifest(root: string, paths: string[]): Map<string, ManifestEntry> {
  const output = new Map<string, ManifestEntry>();
  for (const path of paths) {
    output.set(path, manifestEntry(root, path));
  }
  return output;
}

function sameManifestEntry(left: ManifestEntry, right: ManifestEntry, compareIdentity: boolean): boolean {
  return left.kind === right.kind
    && left.mode === right.mode
    && left.value === right.value
    && (left.kind !== "file" || right.kind !== "file" || left.size === right.size)
    && (!compareIdentity || left.identity === right.identity);
}

function manifestDifference(actual: Map<string, ManifestEntry>, expected: Map<string, ManifestEntry>): string | undefined {
  for (const [path, baseline] of expected) {
    const current = actual.get(path);
    if (!current || !sameManifestEntry(current, baseline, false)) return path;
  }
  return undefined;
}

function manifestChange(root: string, expected: Map<string, ManifestEntry>): string | undefined {
  try {
    for (const [path, baseline] of expected) {
      const current = manifestEntry(root, path, baseline);
      if (!sameManifestEntry(current, baseline, true)) return path;
    }
    return undefined;
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("unsafe candidate manifest ancestor")) return message;
    return "an unreadable protected path";
  }
}

function candidateSandbox(cwd: string, options: CandidateCommandOptions): CandidateSandbox {
  const source = validateSourceRepository(cwd, options.trustedSourceWorktree === true);
  const root = validateCandidateRoot(source);
  const overlayPaths = normalizedOverlayPaths(source, options.overlayPaths);
  const sourceState = sourceStateError(source, overlayPaths);
  if (sourceState) throw new Error(sourceState);
  const key = `${root}\0${source}\0${overlayPaths.join("\0")}`;
  const existing = candidateSandboxes.get(key);
  if (existing) return existing;

  const sourceHead = trustedGit(source, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const directory = join(root, createHash("sha256").update(key).digest("hex").slice(0, 32));
  if (existsSync(directory)) throw new Error("candidate sandbox path existed before trusted materialization");
  mkdirSync(directory, { mode: 0o700 });
  materializeExactHead(source, directory, sourceHead);
  copyOverlayPaths(source, directory, overlayPaths);
  if (trustedGit(directory, ["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== sourceHead
    || trustedGit(source, ["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== sourceHead) {
    throw new Error("candidate sandbox did not preserve the exact source HEAD");
  }
  const paths = [...new Set([...repositoryPaths(directory), ...overlayPaths])].sort();
  const sourceManifest = manifest(source, overlayPaths);
  const sandboxManifest = manifest(directory, paths);
  const copiedChange = manifestDifference(manifest(directory, overlayPaths), sourceManifest);
  if (copiedChange) throw new Error(`candidate sandbox copy differs at ${copiedChange}`);
  const selected = { source, sourceHead, directory: realpathSync(directory), sourceManifest, sandboxManifest, overlayPaths };
  candidateSandboxes.set(key, selected);
  return selected;
}

function sandboxIntegrityError(sandbox: CandidateSandbox): string | undefined {
  if (trustedGit(sandbox.source, ["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== sandbox.sourceHead) {
    return "candidate source HEAD changed outside the isolated container";
  }
  const sourceState = sourceStateError(sandbox.source, sandbox.overlayPaths);
  if (sourceState) return sourceState;
  const sourceChange = manifestChange(sandbox.source, sandbox.sourceManifest);
  if (sourceChange) return `candidate source changed outside the isolated container: ${sourceChange}`;
  const sandboxChange = manifestChange(sandbox.directory, sandbox.sandboxManifest);
  if (sandboxChange) return `candidate command changed protected source path: ${sandboxChange}`;
  return undefined;
}

function explicitlyAbsent(docker: string, name: string, env: NodeJS.ProcessEnv): boolean {
  const check = spawnSync(docker, ["container", "inspect", name], {
    encoding: "utf8",
    env,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (check.error || check.signal || check.status === null) return false;
  return check.status !== 0 && /no such (?:container|object)/i.test(`${check.stdout ?? ""}\n${check.stderr ?? ""}`);
}

function isolatedCommand(command: string, cwd: string, timeoutMs: number, options: CandidateCommandOptions): CandidateCommandOutcome {
  const docker = process.env.AGENT_VIGIL_INTERNAL_DOCKER_BIN;
  const image = process.env.AGENT_VIGIL_INTERNAL_CANDIDATE_IMAGE ?? "";
  const trustedHome = process.env.AGENT_VIGIL_INTERNAL_TEST_HOME;
  if (!docker || !isAbsolute(docker)) {
    return { status: null, signal: null, output: "", error: "candidate isolation requires an absolute trusted Docker binary path" };
  }
  const customRunner = image !== PINNED_CANDIDATE_IMAGE;
  const immutableImage = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/;
  if ((!customRunner && image !== PINNED_CANDIDATE_IMAGE) || (customRunner && !immutableImage.test(image ?? ""))) {
    return { status: null, signal: null, output: "", error: "candidate isolation image is not the base-selected immutable runner digest" };
  }
  if (!executableIsIntact(docker)) {
    return { status: null, signal: null, output: "", error: "trusted Docker binary changed before candidate command" };
  }

  let sandbox: CandidateSandbox;
  try {
    sandbox = candidateSandbox(cwd, options);
    const integrityError = sandboxIntegrityError(sandbox);
    if (integrityError) return { status: null, signal: null, output: "", error: integrityError };
  } catch (error) {
    return { status: null, signal: null, output: "", error: (error as Error).message };
  }
  if (/[,\r\n\0]/.test(sandbox.directory)) {
    return { status: null, signal: null, output: "", error: "candidate sandbox path cannot be encoded as a Docker bind mount" };
  }
  const name = `${CONTAINER_PREFIX}${process.pid}-${randomBytes(10).toString("hex")}`;
  const env = dockerEnvironment(trustedHome);
  const args = [
    "run",
    "--rm",
    "--name", name,
    "--pull", "never",
    "--network", options.allowNetwork ? "bridge" : "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "1001:1001",
    "--ipc", "private",
    "--pids-limit", "512",
    "--memory", "4g",
    "--memory-swap", "4g",
    "--cpus", "2",
    "--hostname", "agent-vigil-candidate",
    "--workdir", "/workspace",
    "--mount", `type=bind,source=${sandbox.directory},target=/workspace${options.allowNetwork ? "" : ",readonly"}`,
    "--mount", `type=bind,source=${join(sandbox.directory, ".git")},target=/workspace/.git,readonly`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=536870912,mode=1777",
    "--tmpfs", "/home/candidate:rw,noexec,nosuid,nodev,size=67108864,uid=1001,gid=1001,mode=0700",
    "--entrypoint", "/usr/bin/env",
    image,
    "-i",
    "CI=true",
    "HOME=/home/candidate",
    "LANG=C",
    "LC_ALL=C",
    "NPM_CONFIG_CACHE=/tmp/npm-cache",
    "TZ=UTC",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "/usr/local/bin/node",
    "-e", COMMAND_WRAPPER, command, String(timeoutMs),
  ];

  let execution: ReturnType<typeof spawnSync> | undefined;
  let cleanupError: string | undefined;
  try {
    execution = spawnSync(docker, args, {
      encoding: "utf8",
      env,
      timeout: timeoutMs + 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    if (!executableIsIntact(docker)) {
      cleanupError = "trusted Docker binary changed during candidate command; container cleanup could not be trusted";
    } else {
      const removal = spawnSync(docker, ["rm", "--force", "--volumes", name], {
        encoding: "utf8",
        env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const removed = !removal.error && !removal.signal && removal.status === 0;
      if (!removed && !explicitlyAbsent(docker, name, env)) {
        cleanupError = "candidate container absence could not be proven after deterministic cleanup";
      }
    }
  }
  if (!execution) return { status: null, signal: null, output: "", error: cleanupError ?? "candidate container did not start" };
  const integrityError = sandboxIntegrityError(sandbox);
  return outcomeFromExecution(execution, cleanupError ?? integrityError);
}

/**
 * Run candidate-controlled shell code. Installed CLI use preserves the local
 * execution model; the Action-only isolation switch moves the same command
 * into a one-shot container with only a private standalone clone mounted.
 */
export function runCandidateCommand(command: string, cwd: string, timeoutMs: number, options: CandidateCommandOptions = {}): CandidateCommandOutcome {
  const internalTestPath = process.env.AGENT_VIGIL_INTERNAL_TEST_PATH;
  if (internalTestPath !== undefined && !trustedRuntimeIsIntact(internalTestPath)) {
    return { status: null, signal: null, output: "", error: "trusted runtime changed before candidate command" };
  }

  const isolation = process.env.AGENT_VIGIL_INTERNAL_ISOLATE_CANDIDATE;
  let outcome: CandidateCommandOutcome;
  if (isolation === undefined || isolation === "false") {
    outcome = localCommand(command, cwd, timeoutMs);
  } else if (isolation === "true") {
    outcome = isolatedCommand(command, cwd, timeoutMs, options);
  } else {
    outcome = { status: null, signal: null, output: "", error: "candidate isolation switch must be exactly true or false" };
  }

  if (internalTestPath !== undefined && !trustedRuntimeIsIntact(internalTestPath)) {
    return { status: null, signal: null, output: outcome.output, error: "trusted runtime changed during candidate command" };
  }
  return outcome;
}
