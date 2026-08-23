import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import { canonical } from "../report.ts";
import { inspectArtifactTree, type ArtifactInventory } from "./decision.ts";
import {
  ApmMaterializationHold,
  createUpdatePlan,
  selectApmMaterialization,
  type ApmMaterializationEndpoint,
  type ApmMaterializationSelection,
  type UpdatePlan,
} from "./manager-plan.ts";
import {
  recomputeUpgradeReceiptHash,
  renderUpgradeReceipt,
  runUpgradeEvaluation,
  type UpgradePrivateReceipt,
} from "./receipt.ts";

export const APM_PREFLIGHT_SCHEMA = "agent-vigil-apm-preflight/v1" as const;

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = 272 * 1024 * 1024;
const MAX_FILES = 4_096;
const MAX_DIRECTORIES = 4_096;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const SESSION_PREFIX = "agent-vigil-apm-";

type MaterializedProof = {
  routeSha256: string;
  rowSha256: string;
  commit: string;
  expectedTreeSha256: string;
  fetchedSha256: string;
  fetchedBytes: number;
  materializedTreeSha256: string;
  fileCount: number;
  totalBytes: number;
  selectedArtifact: ArtifactInventory;
};

export type ApmAutomaticPreflightReceipt = {
  schemaVersion: typeof APM_PREFLIGHT_SCHEMA;
  generatedAt: string;
  nonce: string;
  plan: UpdatePlan;
  selection?: {
    identity: string;
    selectedChangeSha256: string;
    currentRowSha256: string;
    candidateRowSha256: string;
  };
  materialization?: {
    current?: MaterializedProof;
    candidate?: MaterializedProof;
  };
  upgradeReceipt?: UpgradePrivateReceipt;
  restoration: {
    status: "RESTORED" | "HOLD";
    hostMutation: "NONE";
    sessionRemoved: boolean;
    reasonCode: string;
  };
  summary: {
    verdict: "SAFE" | "CHANGED" | "HOLD";
    reasonCodes: string[];
  };
  limitations: string[];
  receiptHash: string;
};

export type ArchiveFetcher = (url: string, destination: string) => void;

export type ApmAutomaticPreflightInput = {
  repository: string;
  currentLockPath: string;
  candidateLockPath: string;
  configPath: string;
  identity?: string;
  suppliedPlan?: unknown;
  dockerBin?: string;
  fetchBin?: string;
  workDirectory?: string;
  generatedAt?: string;
  nonce?: string;
};

type ApmAutomaticDependencies = {
  fetchArchive?: ArchiveFetcher;
  evaluate?: typeof runUpgradeEvaluation;
  removeSession?: (path: string) => boolean;
};

type TarFile = { path: string; bytes: Buffer; executable: boolean };
type ParsedArchive = {
  files: TarFile[];
  directories: string[];
  paxCommit?: string;
  treeSha256: string;
  fileCount: number;
  totalBytes: number;
};

const LIMITATIONS = [
  "This receipt covers one selected APM package pair; other changes in the bound update plan remain separate decisions.",
  "Automatic acquisition supports only credential-free public github.com git rows pinned by both a lowercase 40-character commit and APM tree_sha256.",
  "Archives containing links, special files, unsupported extension records, unsafe names, or entries beyond the documented bounds return HOLD.",
  "No APM installer, package lifecycle script, repository hook, or host update is executed; only temporary exact artifacts are mounted read-only into the existing contained check.",
];

class PreflightHold extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}

function hash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function finalizeReceipt(receipt: Omit<ApmAutomaticPreflightReceipt, "receiptHash">): ApmAutomaticPreflightReceipt {
  return { ...receipt, receiptHash: hash(canonical(receipt)) };
}

export function recomputeApmPreflightReceiptHash(receipt: ApmAutomaticPreflightReceipt): string {
  const { receiptHash: _ignored, ...payload } = receipt;
  return hash(canonical(payload));
}

function strictUtf8(bytes: Buffer, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new PreflightHold(label); }
}

function tarText(block: Buffer, start: number, length: number, reasonCode: string): string {
  const field = block.subarray(start, start + length);
  const zero = field.indexOf(0);
  const textBytes = zero === -1 ? field : field.subarray(0, zero);
  if (zero !== -1 && field.subarray(zero).some((byte) => byte !== 0)) throw new PreflightHold(reasonCode);
  return strictUtf8(textBytes, reasonCode);
}

function tarOctal(block: Buffer, start: number, length: number, reasonCode: string): number {
  const field = block.subarray(start, start + length);
  if (field[0] !== undefined && (field[0] & 0x80) !== 0) throw new PreflightHold(reasonCode);
  const source = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!source) return 0;
  if (!/^[0-7]+$/.test(source)) throw new PreflightHold(reasonCode);
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value)) throw new PreflightHold(reasonCode);
  return value;
}

function validTarChecksum(block: Buffer): boolean {
  const expected = tarOctal(block, 148, 8, "ARCHIVE_INVALID");
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return actual === expected;
}

function normalizedArchivePath(value: string): { root: string; relativePath?: string } {
  if (!value || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
  }
  const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = trimmed.split("/");
  if (!parts[0] || parts.some((part) => !part || part === "." || part === "..")) {
    throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
  }
  return { root: parts[0], ...(parts.length > 1 ? { relativePath: parts.slice(1).join("/") } : {}) };
}

function portableIdentity(path: string): string {
  return path.normalize("NFC").toUpperCase();
}

function codeloadPaxCommit(bytes: Buffer): string {
  if (bytes.length < 1 || bytes.length > 128) throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
  const value = strictUtf8(bytes, "ARCHIVE_ENTRY_UNSUPPORTED");
  const match = /^([1-9][0-9]{0,2}) comment=([0-9a-f]{40})\n$/.exec(value);
  if (!match || Number(match[1]) !== bytes.length) throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
  return match[2];
}

function parentPaths(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
}

function canonicalTreeSha256(files: TarFile[]): string {
  const byDirectory = new Map<string, TarFile[]>();
  const directories = new Set<string>([""]);
  for (const file of files) {
    const parts = file.path.split("/");
    const directory = parts.slice(0, -1).join("/");
    directories.add(directory);
    for (const parent of parentPaths(file.path)) directories.add(parent);
    const rows = byDirectory.get(directory) ?? [];
    rows.push(file);
    byDirectory.set(directory, rows);
  }
  const memo = new Map<string, string>();
  const digestDirectory = (directory: string): string => {
    const cached = memo.get(directory);
    if (cached) return cached;
    const prefix = directory ? `${directory}/` : "";
    const directDirectories = [...directories].filter((candidate) => {
      if (!candidate.startsWith(prefix) || candidate === directory) return false;
      return !candidate.slice(prefix.length).includes("/");
    });
    const entries: Array<{ name: string; line: string }> = [];
    for (const file of byDirectory.get(directory) ?? []) {
      const name = basename(file.path);
      const blob = createHash("sha256").update(file.bytes).digest("hex");
      entries.push({ name, line: `${file.executable ? "100755" : "100644"} ${name} ${blob}\n` });
    }
    for (const child of directDirectories) {
      const name = child.slice(prefix.length);
      entries.push({ name, line: `040000 ${name} ${digestDirectory(child)}\n` });
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    const digest = createHash("sha256").update(entries.map((entry) => entry.line).join(""), "utf8").digest("hex");
    memo.set(directory, digest);
    return digest;
  };
  return `sha256:${digestDirectory("")}`;
}

export function parseApmGitHubArchive(compressed: Buffer): ParsedArchive {
  if (!compressed.length || compressed.length > MAX_ARCHIVE_BYTES) throw new PreflightHold("ARCHIVE_SIZE_EXCEEDED");
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: MAX_TAR_BYTES }); }
  catch { throw new PreflightHold("ARCHIVE_INVALID"); }
  if (!tar.length || tar.length % 512 !== 0 || tar.length > MAX_TAR_BYTES) throw new PreflightHold("ARCHIVE_INVALID");
  const files: TarFile[] = [];
  const directories = new Set<string>();
  const identities = new Set<string>();
  const fileIdentities = new Set<string>();
  const portablePaths = new Map<string, string>();
  const registerPortablePath = (path: string): void => {
    const identity = portableIdentity(path);
    const existing = portablePaths.get(identity);
    if (existing !== undefined && existing !== path) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
    portablePaths.set(identity, path);
  };
  let archiveRoot: string | undefined;
  let paxCommit: string | undefined;
  let offset = 0;
  let ended = false;
  let totalBytes = 0;
  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      if (offset + 1_024 > tar.length || !tar.subarray(offset, offset + 1_024).every((byte) => byte === 0)) {
        throw new PreflightHold("ARCHIVE_INVALID");
      }
      ended = true;
      if (!tar.subarray(offset).every((byte) => byte === 0)) throw new PreflightHold("ARCHIVE_INVALID");
      break;
    }
    if (!validTarChecksum(block)) throw new PreflightHold("ARCHIVE_INVALID");
    const magic = block.subarray(257, 263).toString("binary");
    if (magic !== "ustar\0" && magic !== "ustar ") throw new PreflightHold("ARCHIVE_INVALID");
    const name = tarText(block, 0, 100, "ARCHIVE_INVALID");
    const prefix = tarText(block, 345, 155, "ARCHIVE_INVALID");
    const path = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(block, 124, 12, "ARCHIVE_INVALID");
    const mode = tarOctal(block, 100, 8, "ARCHIVE_INVALID");
    const type = block[156];
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > tar.length || paddedEnd > tar.length) throw new PreflightHold("ARCHIVE_INVALID");
    if (type === 0x67) {
      if (archiveRoot !== undefined || paxCommit !== undefined || prefix || name !== "pax_global_header") {
        throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
      }
      paxCommit = codeloadPaxCommit(Buffer.from(tar.subarray(dataStart, dataEnd)));
      offset = paddedEnd;
      continue;
    }
    const normalized = normalizedArchivePath(path);
    archiveRoot ??= normalized.root;
    if (normalized.root !== archiveRoot) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
    const relativePath = normalized.relativePath;
    if (type !== 0 && type !== 0x30 && type !== 0x35) throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
    if (type === 0x35) {
      if (size !== 0) throw new PreflightHold("ARCHIVE_INVALID");
      if (relativePath) {
        if (!directories.has(relativePath) && directories.size >= MAX_DIRECTORIES) {
          throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
        }
        const identity = portableIdentity(relativePath);
        if (identities.has(identity)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
        registerPortablePath(relativePath);
        identities.add(identity);
        directories.add(relativePath);
      }
    } else {
      if (!relativePath) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
      if (files.length >= MAX_FILES) throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
      if (size > MAX_FILE_BYTES || totalBytes + size > MAX_TOTAL_BYTES) throw new PreflightHold("ARCHIVE_SIZE_EXCEEDED");
      const identity = portableIdentity(relativePath);
      if (identities.has(identity) || directories.has(relativePath)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
      registerPortablePath(relativePath);
      identities.add(identity);
      fileIdentities.add(identity);
      for (const parent of parentPaths(relativePath)) {
        registerPortablePath(parent);
        const parentIdentity = portableIdentity(parent);
        if (fileIdentities.has(parentIdentity)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
        if (!directories.has(parent) && directories.size >= MAX_DIRECTORIES) {
          throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
        }
        directories.add(parent);
      }
      files.push({
        path: relativePath,
        bytes: Buffer.from(tar.subarray(dataStart, dataEnd)),
        executable: (mode & 0o111) !== 0,
      });
      totalBytes += size;
    }
    offset = paddedEnd;
  }
  if (!ended || !archiveRoot || !files.length) throw new PreflightHold("ARCHIVE_INVALID");
  const materializedDirectories = new Set(files.flatMap((file) => parentPaths(file.path)));
  // Git cannot bind empty directories. Reject rather than materialize any
  // archive-only directory that is absent from the canonical tree commitment.
  if ([...directories].some((directory) => !materializedDirectories.has(directory))) {
    throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
  }
  return {
    files,
    directories: [...materializedDirectories].sort(),
    ...(paxCommit ? { paxCommit } : {}),
    treeSha256: canonicalTreeSha256(files),
    fileCount: files.length,
    totalBytes,
  };
}

function safeSessionParent(path: string): string {
  const requested = resolve(path);
  const status = lstatSync(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
  const canonicalParent = realpathSync(requested);
  if (!statSync(canonicalParent).isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
  return canonicalParent;
}

function createSession(parentPath: string): string {
  let root: string | undefined;
  try {
    root = mkdtempSync(join(safeSessionParent(parentPath), SESSION_PREFIX));
    // Materialized public package bytes must remain readable by the fixed
    // unprivileged container user. The containing .agent-vigil directory and
    // short lifetime keep this separate from active APM state.
    chmodSync(root, 0o755);
    const status = lstatSync(root);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
    return realpathSync(root);
  } catch (error) {
    if (root !== undefined && !safeRemoveSession(root)) {
      throw new PreflightHold("RESTORATION_FAILED");
    }
    throw error;
  }
}

function safeRemoveSession(path: string): boolean {
  try {
    const requested = resolve(path);
    if (!basename(requested).startsWith(SESSION_PREFIX)) return false;
    const status = lstatSync(requested);
    if (status.isSymbolicLink() || !status.isDirectory()) return false;
    if (realpathSync(requested) !== requested) return false;
    rmSync(requested, { recursive: true, force: false, maxRetries: 2 });
    return !existsSync(requested);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function trustedCurlLocations(): string[] {
  if (process.platform === "win32") return ["C:\\Windows\\System32\\curl.exe"];
  return ["/usr/bin/curl", "/usr/local/bin/curl", "/opt/homebrew/bin/curl"];
}

function resolveFetchBinary(requested = "curl"): string {
  const candidates = isAbsolute(requested) ? [requested]
    : requested === "curl" || requested === "curl.exe" ? trustedCurlLocations() : [];
  for (const candidate of candidates) {
    try {
      const canonicalPath = realpathSync(candidate);
      if (!statSync(canonicalPath).isFile()) continue;
      if (process.platform !== "win32") accessSync(canonicalPath, constants.X_OK);
      return canonicalPath;
    } catch {
      // Continue through fixed platform locations.
    }
  }
  throw new PreflightHold("FETCH_CLIENT_UNAVAILABLE");
}

export function curlArchiveFetcher(fetchBin = "curl"): ArchiveFetcher {
  const executable = resolveFetchBinary(fetchBin);
  return (url, destination) => {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED"); }
    if (parsed.protocol !== "https:" || parsed.hostname !== "codeload.github.com"
      || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
      || !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/tar\.gz\/[0-9a-f]{40}$/.test(parsed.pathname)) {
      throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED");
    }
    const result = spawnSync(executable, [
      "-q", "--fail", "--silent", "--show-error",
      "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "0",
      "--connect-timeout", "10", "--max-time", "90",
      "--max-filesize", String(MAX_ARCHIVE_BYTES), "--noproxy", "*",
      "--output", "-", parsed.toString(),
    ], {
      timeout: 100_000,
      killSignal: "SIGKILL",
      maxBuffer: MAX_ARCHIVE_BYTES + 64 * 1024,
      env: process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
        : { LANG: "C", LC_ALL: "C" },
    });
    if (result.status !== 0 || result.error || !Buffer.isBuffer(result.stdout)
      || result.stdout.length < 1 || result.stdout.length > MAX_ARCHIVE_BYTES) {
      throw new PreflightHold("FETCH_FAILED");
    }
    // Curl never receives a filesystem destination. This prevents its normal
    // open/truncate behavior from following a same-user replacement symlink;
    // the bounded bytes are committed through an exclusive no-follow handle.
    writeExclusiveFile(destination, result.stdout, false, 0o600);
  };
}

function writeExclusiveFile(path: string, bytes: Buffer, executable: boolean, mode?: number): void {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    mode ?? (executable ? 0o755 : 0o644),
  );
  try {
    writeFileSync(descriptor, bytes);
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size !== bytes.length) throw new PreflightHold("MATERIALIZATION_FAILED");
  } finally { closeSync(descriptor); }
}

function extractArchive(archive: ParsedArchive, root: string): void {
  mkdirSync(root, { mode: 0o755 });
  for (const directory of archive.directories.sort((left, right) => left.split("/").length - right.split("/").length)) {
    const output = join(root, ...directory.split("/"));
    const rel = relative(root, output);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
    if (!existsSync(output)) mkdirSync(output, { mode: 0o755 });
    const status = lstatSync(output);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new PreflightHold("MATERIALIZATION_FAILED");
  }
  for (const file of archive.files) {
    const output = join(root, ...file.path.split("/"));
    const parent = dirname(output);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o755 });
    writeExclusiveFile(output, file.bytes, file.executable);
  }
}

function materializeEndpoint(
  endpoint: ApmMaterializationEndpoint,
  label: "current" | "candidate",
  session: string,
  fetchArchive: ArchiveFetcher,
): { proof: MaterializedProof; selectedRoot: string } {
  const archivePath = join(session, `${label}.tar.gz`);
  const url = `https://codeload.github.com/${endpoint.repository.owner}/${endpoint.repository.name}/tar.gz/${endpoint.commit}`;
  fetchArchive(url, archivePath);
  const beforePath = lstatSync(archivePath, { bigint: true });
  if (beforePath.isSymbolicLink() || !beforePath.isFile()
    || beforePath.size < 1n || beforePath.size > BigInt(MAX_ARCHIVE_BYTES)) {
    throw new PreflightHold("FETCH_INVALID");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(archivePath, constants.O_RDONLY | noFollow);
  let compressed: Buffer;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== beforePath.dev || opened.ino !== beforePath.ino) {
      throw new PreflightHold("FETCH_INVALID");
    }
    fchmodSync(descriptor, 0o600);
    const before = fstatSync(descriptor, { bigint: true });
    compressed = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(archivePath, { bigint: true });
    if (compressed.length > MAX_ARCHIVE_BYTES || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== afterPath.dev || after.ino !== afterPath.ino || afterPath.isSymbolicLink()) {
      throw new PreflightHold("FETCH_INVALID");
    }
  } finally { closeSync(descriptor); }
  const fetchedSha256 = hash(compressed);
  const parsed = parseApmGitHubArchive(compressed);
  if (parsed.paxCommit !== undefined && parsed.paxCommit !== endpoint.commit) {
    throw new PreflightHold("ARCHIVE_COMMIT_MISMATCH");
  }
  if (parsed.treeSha256 !== endpoint.expectedTreeSha256) throw new PreflightHold("MATERIALIZED_TREE_MISMATCH");
  unlinkSync(archivePath);
  const materializedRoot = join(session, label);
  extractArchive(parsed, materializedRoot);
  const selectedRoot = endpoint.virtualPath
    ? join(materializedRoot, ...endpoint.virtualPath.split("/")) : materializedRoot;
  const rel = relative(materializedRoot, selectedRoot);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED");
  const selectedStatus = lstatSync(selectedRoot);
  if (selectedStatus.isSymbolicLink() || !selectedStatus.isDirectory()) throw new PreflightHold("VIRTUAL_PATH_UNAVAILABLE");
  const selectedArtifact = inspectArtifactTree(selectedRoot);
  return {
    selectedRoot,
    proof: {
      routeSha256: endpoint.routeSha256,
      rowSha256: endpoint.rowSha256,
      commit: endpoint.commit,
      expectedTreeSha256: endpoint.expectedTreeSha256,
      fetchedSha256,
      fetchedBytes: compressed.length,
      materializedTreeSha256: parsed.treeSha256,
      fileCount: parsed.fileCount,
      totalBytes: parsed.totalBytes,
      selectedArtifact,
    },
  };
}

function suppliedPlanTime(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const generatedAt = (value as Record<string, unknown>).generatedAt;
  return typeof generatedAt === "string" ? generatedAt : undefined;
}

function exactTimestamp(value: string | undefined): string | undefined {
  if (!value || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value : undefined;
}

function exactPlanForInput(input: ApmAutomaticPreflightInput): { plan: UpdatePlan; suppliedPlanMatches: boolean } {
  const suppliedGeneratedAt = suppliedPlanTime(input.suppliedPlan);
  const suppliedTimestamp = exactTimestamp(suppliedGeneratedAt);
  const generatedAt = input.suppliedPlan === undefined ? input.generatedAt
    : suppliedTimestamp ?? input.generatedAt;
  const plan = createUpdatePlan({
    manager: "apm",
    currentPath: input.currentLockPath,
    candidatePath: input.candidateLockPath,
    ...(generatedAt ? { generatedAt } : input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
  return {
    plan,
    suppliedPlanMatches: input.suppliedPlan === undefined
      || Boolean(suppliedTimestamp && canonical(input.suppliedPlan) === canonical(plan)),
  };
}

function holdReason(error: unknown, fallback: string): string {
  if (error instanceof PreflightHold || error instanceof ApmMaterializationHold) return error.reasonCode;
  return fallback;
}

export function runApmAutomaticPreflight(
  input: ApmAutomaticPreflightInput,
  dependencies: ApmAutomaticDependencies = {},
): ApmAutomaticPreflightReceipt {
  const nonce = input.nonce ?? randomBytes(32).toString("base64url");
  if (nonce.length < 16 || nonce.length > 128 || nonce.includes("\0")) {
    throw new Error("automatic APM preflight nonce must contain from 16 to 128 characters");
  }
  const { plan, suppliedPlanMatches } = exactPlanForInput(input);
  if (!suppliedPlanMatches) {
    return finalizeReceipt({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      restoration: { status: "RESTORED", hostMutation: "NONE", sessionRemoved: true, reasonCode: "NOTHING_MATERIALIZED" },
      summary: { verdict: "HOLD", reasonCodes: ["PLAN_MISMATCH"] },
      limitations: LIMITATIONS,
    });
  }
  let selection: ApmMaterializationSelection;
  try {
    selection = selectApmMaterialization({
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt,
      ...(input.identity ? { identity: input.identity } : {}),
    });
    if (canonical(selection.plan) !== canonical(plan)) {
      throw new ApmMaterializationHold("SOURCE_STATE_CHANGED");
    }
    if (plan.summary.total !== 1 || plan.summary.eligiblePairs !== 1
      || plan.changes.length !== 1 || canonical(plan.changes[0]) !== canonical(selection.change)) {
      throw new ApmMaterializationHold("UNASSESSED_PLAN_CHANGES");
    }
  } catch (error) {
    const reasonCode = holdReason(error, "SELECTION_FAILED");
    return finalizeReceipt({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      restoration: { status: "RESTORED", hostMutation: "NONE", sessionRemoved: true, reasonCode: "NOTHING_MATERIALIZED" },
      summary: { verdict: "HOLD", reasonCodes: [reasonCode] },
      limitations: LIMITATIONS,
    });
  }

  let session: string;
  try { session = createSession(input.workDirectory ?? dirname(input.configPath)); }
  catch (error) {
    return finalizeReceipt({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      selection: {
        identity: selection.change.identity,
        selectedChangeSha256: selection.selectedChangeSha256,
        currentRowSha256: selection.current.rowSha256,
        candidateRowSha256: selection.candidate.rowSha256,
      },
      restoration: { status: "HOLD", hostMutation: "NONE", sessionRemoved: false, reasonCode: "SESSION_UNAVAILABLE" },
      summary: { verdict: "HOLD", reasonCodes: [holdReason(error, "SESSION_UNAVAILABLE")] },
      limitations: LIMITATIONS,
    });
  }

  const removeSession = dependencies.removeSession ?? safeRemoveSession;
  let cleanupAttempted = false;
  let cleanupSucceeded = false;
  const cleanup = (): boolean => {
    if (cleanupAttempted) return cleanupSucceeded;
    cleanupAttempted = true;
    try { cleanupSucceeded = removeSession(session); }
    catch { cleanupSucceeded = false; }
    return cleanupSucceeded;
  };
  const onInterrupt = (): never => {
    cleanup();
    process.exit(130);
  };
  const onTerminate = (): never => {
    cleanup();
    process.exit(143);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  const materialization: { current?: MaterializedProof; candidate?: MaterializedProof } = {};
  let upgradeReceipt: UpgradePrivateReceipt | undefined;
  const reasons: string[] = [];
  try {
    const fetchArchive = dependencies.fetchArchive ?? curlArchiveFetcher(input.fetchBin ?? "curl");
    const current = materializeEndpoint(selection.current, "current", session, fetchArchive);
    materialization.current = current.proof;
    const candidate = materializeEndpoint(selection.candidate, "candidate", session, fetchArchive);
    materialization.candidate = candidate.proof;
    const beforeCheckPlan = createUpdatePlan({
      manager: "apm",
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt,
    });
    if (canonical(beforeCheckPlan) !== canonical(plan)) throw new PreflightHold("SOURCE_STATE_CHANGED");
    const evaluate = dependencies.evaluate ?? runUpgradeEvaluation;
    upgradeReceipt = evaluate({
      configPath: input.configPath,
      repository: input.repository,
      currentDirectory: current.selectedRoot,
      candidateDirectory: candidate.selectedRoot,
      ...(input.dockerBin ? { dockerBin: input.dockerBin } : {}),
      generatedAt: plan.generatedAt,
      nonce,
    });
    if (recomputeUpgradeReceiptHash(upgradeReceipt) !== upgradeReceipt.receiptHash) {
      reasons.push("CHECK_RECEIPT_INVALID");
    } else if (!upgradeReceipt.current || !upgradeReceipt.candidate
      || upgradeReceipt.current.treeSha256 !== current.proof.selectedArtifact.treeSha256
      || upgradeReceipt.candidate.treeSha256 !== candidate.proof.selectedArtifact.treeSha256) {
      reasons.push("CHECK_BINDING_MISMATCH");
    } else if (upgradeReceipt.summary.verdict === "HOLD") reasons.push("CHECK_HOLD");
    const afterCheckPlan = createUpdatePlan({
      manager: "apm",
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt,
    });
    if (canonical(afterCheckPlan) !== canonical(plan)) reasons.push("SOURCE_STATE_CHANGED");
  } catch (error) {
    reasons.push(holdReason(error, upgradeReceipt ? "CHECK_FAILED" : "MATERIALIZATION_FAILED"));
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (!cleanup()) reasons.push("RESTORATION_FAILED");
  }
  const restoration = cleanupSucceeded
    ? { status: "RESTORED" as const, hostMutation: "NONE" as const, sessionRemoved: true, reasonCode: "TEMPORARY_ARTIFACTS_REMOVED" }
    : { status: "HOLD" as const, hostMutation: "NONE" as const, sessionRemoved: false, reasonCode: "RESTORATION_FAILED" };
  const verdict = reasons.length || !upgradeReceipt ? "HOLD" as const : upgradeReceipt.summary.verdict;
  return finalizeReceipt({
    schemaVersion: APM_PREFLIGHT_SCHEMA,
    generatedAt: plan.generatedAt,
    nonce,
    plan,
    selection: {
      identity: selection.change.identity,
      selectedChangeSha256: selection.selectedChangeSha256,
      currentRowSha256: selection.current.rowSha256,
      candidateRowSha256: selection.candidate.rowSha256,
    },
    ...(materialization.current || materialization.candidate ? { materialization } : {}),
    ...(upgradeReceipt ? { upgradeReceipt } : {}),
    restoration,
    summary: {
      verdict,
      reasonCodes: reasons.length ? [...new Set(reasons)]
        : [verdict === "SAFE" ? "NO_MATERIAL_CHANGE" : "MATERIAL_CHANGE_DETECTED"],
    },
    limitations: LIMITATIONS,
  });
}

export function renderApmAutomaticPreflight(receipt: ApmAutomaticPreflightReceipt): string {
  const lines = [
    `Agent Vigil automatic APM preflight: ${receipt.summary.verdict}`,
    `  plan ${receipt.plan.planHash}`,
  ];
  if (receipt.selection) lines.push(`  selected ${receipt.selection.identity}`);
  if (receipt.upgradeReceipt) lines.push(renderUpgradeReceipt(receipt.upgradeReceipt).trimEnd());
  lines.push(`  restoration ${receipt.restoration.status} · host mutation ${receipt.restoration.hostMutation}`);
  if (receipt.summary.reasonCodes.length) lines.push(`  ${receipt.summary.reasonCodes.join(", ")}`);
  lines.push(`  ${receipt.receiptHash}`);
  return `${lines.join("\n")}\n`;
}
