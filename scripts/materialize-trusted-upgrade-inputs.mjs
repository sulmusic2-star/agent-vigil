#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const LOCK_PATH = "apm.lock.yaml";
const HARNESS_ROOT = ".agent-vigil/upgrade";
const CONFIG_PATH = `${HARNESS_ROOT}/config.json`;
const CANARY_ROOT = `${HARNESS_ROOT}/canaries`;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CANARY_BYTES = 1024 * 1024;
const MAX_HARNESS_BYTES = 8 * 1024 * 1024;
const MAX_CANARY_FILES = 64;
const MAX_GIT_OUTPUT = 12 * 1024 * 1024;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fail(reason) {
  process.stderr.write(`agent-vigil: ${reason}\n`);
  process.exit(2);
}

function exactOptions(argv, allowed) {
  if (argv.length % 2 !== 0) fail("trusted-input helper received an invalid argument shape");
  const result = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || typeof value !== "string" || value.length === 0 || name in result) {
      fail("trusted-input helper received an invalid argument");
    }
    result[name] = value;
  }
  for (const name of allowed) if (!(name in result)) fail("trusted-input helper is missing a required argument");
  return result;
}

function safeAbsoluteExecutable(path) {
  if (!isAbsolute(path)) fail("trusted Git executable must be an absolute path");
  let status;
  try {
    status = lstatSync(path);
  } catch {
    fail("trusted Git executable is unavailable");
  }
  let canonical;
  try {
    canonical = realpathSync(path);
    accessSync(path, constants.X_OK);
  } catch {
    fail("trusted Git executable is unavailable");
  }
  let writable = true;
  try { accessSync(path, constants.W_OK); }
  catch { writable = false; }
  if (writable) fail("trusted Git executable must not be writable by the runner");
  if (canonical !== path || !status.isFile() || (status.mode & 0o111) === 0 || (status.mode & 0o022) !== 0) {
    fail("trusted Git executable is unavailable");
  }
  return canonical;
}

function gitEnvironment() {
  return {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PATH: SAFE_PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runGit(git, repository, args, maxBuffer = MAX_GIT_OUTPUT) {
  const completed = spawnSync(git, [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null",
    "-c", "filter.lfs.clean=",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.required=false",
    "-C", repository,
    ...args,
  ], {
    encoding: null,
    env: gitEnvironment(),
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (completed.error || completed.status !== 0 || completed.signal) {
    fail("trusted Git plumbing could not read the selected event objects");
  }
  return completed.stdout;
}

function validateRef(ref) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) {
    fail("event commit identity must be a full lowercase object ID");
  }
}

function parseLsTree(output) {
  const entries = [];
  let cursor = 0;
  while (cursor < output.length) {
    const end = output.indexOf(0, cursor);
    if (end < 0) fail("trusted Git tree output was malformed");
    const record = output.subarray(cursor, end);
    const tab = record.indexOf(0x09);
    if (tab < 0) fail("trusted Git tree output was malformed");
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(header);
    if (!match) fail("trusted Git tree output was malformed");
    const rawPath = record.subarray(tab + 1);
    const path = rawPath.toString("utf8");
    if (!Buffer.from(path, "utf8").equals(rawPath)) fail("trusted Git tree contains a non-UTF-8 path");
    entries.push({ mode: match[1], type: match[2], oid: match[3], path });
    cursor = end + 1;
  }
  return entries;
}

function singleEntry(git, repository, ref, path) {
  const entries = parseLsTree(runGit(git, repository, ["ls-tree", "-z", "--full-tree", ref, "--", path]));
  if (entries.length !== 1 || entries[0].path !== path) return undefined;
  return entries[0];
}

function regularBlob(entry, label) {
  if (!entry || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    fail(`${label} must be an exact regular Git blob`);
  }
}

function safeSegment(segment) {
  if (!segment || segment === "." || segment === ".." || segment !== segment.normalize("NFC")) return false;
  if (Buffer.byteLength(segment, "utf8") > 255) return false;
  if (/[\\/:\u0000-\u001f\u007f]/u.test(segment) || /[. ]$/u.test(segment)) return false;
  if (RESERVED_WINDOWS_NAMES.test(segment)) return false;
  return true;
}

function safeRepositoryPath(path) {
  if (path.length > 512 || path.startsWith("/") || path.includes("//")) return false;
  return path.split("/").every(safeSegment);
}

function assertNoPortableCollisions(paths) {
  const seen = new Map();
  for (const path of paths) {
    const segments = path.split("/");
    for (let count = 1; count <= segments.length; count += 1) {
      const prefix = segments.slice(0, count).join("/");
      const folded = prefix.normalize("NFC").toLocaleLowerCase("en-US");
      const prior = seen.get(folded);
      if (prior && prior !== prefix) fail("trusted harness paths collide on a supported filesystem");
      seen.set(folded, prefix);
    }
  }
}

function readBlob(git, repository, oid, limit, label) {
  const sizeOutput = runGit(git, repository, ["cat-file", "-s", oid], 1024).toString("ascii").trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(sizeOutput)) fail(`${label} has an invalid Git object size`);
  const size = Number(sizeOutput);
  if (!Number.isSafeInteger(size) || size > limit) fail(`${label} exceeds its byte limit`);
  const bytes = runGit(git, repository, ["cat-file", "blob", oid], limit + 1);
  if (bytes.length !== size) fail(`${label} bytes do not match the selected Git object`);
  return bytes;
}

function mkdirFresh(path, mode = 0o700) {
  try {
    mkdirSync(path, { mode });
    chmodSync(path, mode);
  } catch {
    fail("runner-owned trusted-input directory could not be created safely");
  }
}

function writeExact(path, bytes, executable = false) {
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: executable ? 0o700 : 0o600 });
    chmodSync(path, executable ? 0o700 : 0o600);
    if (!readFileSync(path).equals(bytes)) throw new Error("mismatch");
  } catch {
    fail("runner-owned trusted-input blob could not be materialized exactly");
  }
}

function ensureDirectories(root, relativePath) {
  const parts = relativePath.split("/").slice(0, -1);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const status = lstatSync(cursor);
      if (!status.isDirectory() || status.isSymbolicLink()) fail("trusted-input path changed during materialization");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirFresh(cursor);
    }
  }
}

function materialize(argv) {
  const options = exactOptions(argv, new Set(["--repository", "--base", "--head", "--output", "--git"]));
  validateRef(options["--base"]);
  validateRef(options["--head"]);
  const git = safeAbsoluteExecutable(options["--git"]);

  let repository;
  try {
    repository = realpathSync(options["--repository"]);
    if (!lstatSync(repository).isDirectory()) throw new Error("not directory");
  } catch {
    fail("GitHub workspace repository is unavailable");
  }

  const requestedOutput = resolve(options["--output"]);
  if (!isAbsolute(options["--output"])) fail("runner-owned trusted-input path must be absolute");
  let outputParent;
  try {
    outputParent = realpathSync(dirname(requestedOutput));
    if (!lstatSync(outputParent).isDirectory()) throw new Error("not directory");
  } catch {
    fail("runner-owned trusted-input parent is unavailable");
  }
  const output = join(outputParent, basename(requestedOutput));

  for (const ref of [options["--base"], options["--head"]]) {
    runGit(git, repository, ["cat-file", "-e", `${ref}^{commit}`], 1024);
  }

  const baseHarness = singleEntry(git, repository, options["--base"], HARNESS_ROOT);
  const headHarness = singleEntry(git, repository, options["--head"], HARNESS_ROOT);
  if (!baseHarness || baseHarness.type !== "tree" || baseHarness.mode !== "040000") {
    fail("trusted base Upgrade Guard harness is missing");
  }
  if (!headHarness || headHarness.type !== "tree" || headHarness.mode !== "040000"
      || headHarness.oid !== baseHarness.oid) {
    fail("TRUSTED_HARNESS_CHANGED");
  }

  const baseLock = singleEntry(git, repository, options["--base"], LOCK_PATH);
  const headLock = singleEntry(git, repository, options["--head"], LOCK_PATH);
  regularBlob(baseLock, "exact base APM lockfile");
  regularBlob(headLock, "exact candidate APM lockfile");
  const currentLock = readBlob(git, repository, baseLock.oid, MAX_LOCK_BYTES, "exact base APM lockfile");
  const candidateLock = readBlob(git, repository, headLock.oid, MAX_LOCK_BYTES, "exact candidate APM lockfile");

  const leaves = parseLsTree(runGit(git, repository, [
    "ls-tree", "-r", "-z", "--full-tree", options["--base"], "--", HARNESS_ROOT,
  ]));
  const configEntries = leaves.filter((entry) => entry.path === CONFIG_PATH);
  const canaryEntries = leaves.filter((entry) => entry.path.startsWith(`${CANARY_ROOT}/`));
  if (configEntries.length !== 1 || canaryEntries.length < 1 || canaryEntries.length > MAX_CANARY_FILES
      || leaves.length !== 1 + canaryEntries.length) {
    fail("trusted harness contains missing or extra entries");
  }
  for (const entry of leaves) {
    if (!safeRepositoryPath(entry.path)) fail("trusted harness contains an unsafe path");
    regularBlob(entry, "trusted harness entry");
  }
  assertNoPortableCollisions(leaves.map((entry) => entry.path));

  const configBytes = readBlob(git, repository, configEntries[0].oid, MAX_CONFIG_BYTES, "trusted Upgrade Guard config");
  let config;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
  } catch {
    fail("trusted Upgrade Guard config is not valid JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)
      || config.canaryDirectory !== CANARY_ROOT) {
    fail(`trusted Upgrade Guard canaryDirectory must be ${CANARY_ROOT}`);
  }

  const canaryBytes = [];
  let harnessBytes = configBytes.length;
  for (const entry of canaryEntries) {
    const bytes = readBlob(git, repository, entry.oid, MAX_CANARY_BYTES, "trusted canary");
    harnessBytes += bytes.length;
    if (harnessBytes > MAX_HARNESS_BYTES) fail("trusted harness exceeds its total byte limit");
    canaryBytes.push({ entry, bytes });
  }

  mkdirFresh(output);
  const trustedRepository = join(output, "repository");
  mkdirFresh(trustedRepository);
  ensureDirectories(trustedRepository, CONFIG_PATH);
  writeExact(join(trustedRepository, ...CONFIG_PATH.split("/")), configBytes, configEntries[0].mode === "100755");
  for (const { entry, bytes } of canaryBytes) {
    ensureDirectories(trustedRepository, entry.path);
    writeExact(join(trustedRepository, ...entry.path.split("/")), bytes, entry.mode === "100755");
  }
  writeExact(join(output, "current-apm.lock.yaml"), currentLock);
  writeExact(join(output, "candidate-apm.lock.yaml"), candidateLock);

  process.stdout.write(JSON.stringify({
    schemaVersion: "agent-vigil-trusted-upgrade-inputs/v1",
    repository: trustedRepository,
    currentLock: join(output, "current-apm.lock.yaml"),
    candidateLock: join(output, "candidate-apm.lock.yaml"),
    base: options["--base"],
    head: options["--head"],
    harnessTree: baseHarness.oid,
    canaryCount: canaryEntries.length,
  }));
}

function cleanup(argv) {
  const options = exactOptions(argv, new Set(["--output", "--parent"]));
  if (!isAbsolute(options["--output"]) || !isAbsolute(options["--parent"])) {
    fail("trusted-input cleanup paths must be absolute");
  }
  let parent;
  let output;
  try {
    parent = realpathSync(options["--parent"]);
    output = realpathSync(options["--output"]);
    const status = lstatSync(output);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("unsafe output");
  } catch {
    fail("trusted-input cleanup target is unavailable or unsafe");
  }
  if (dirname(output) !== parent || relative(parent, output).startsWith(`..${sep}`)) {
    fail("trusted-input cleanup target escaped its runner-owned parent");
  }
  try {
    rmSync(output, { recursive: true, force: false, maxRetries: 0 });
  } catch {
    fail("trusted-input cleanup failed");
  }
}

const [command, ...argv] = process.argv.slice(2);
if (command === "materialize") materialize(argv);
else if (command === "cleanup") cleanup(argv);
else fail("trusted-input helper requires materialize or cleanup");
