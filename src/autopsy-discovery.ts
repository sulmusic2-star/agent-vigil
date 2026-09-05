import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { MAX_TRANSCRIPT_BYTES } from "./transcript.ts";

export type AutopsyDiscoveryRoot = {
  agent: "codex" | "claude-code";
  path: string;
  maxDepth: number;
};

export type AutopsyCandidate = {
  path: string;
  agent: "codex" | "claude-code";
  modifiedAt: string;
  bytes: number;
  selectable: boolean;
  repository?: string;
  branch?: string;
};

export type AutopsyDiscovery = {
  schemaVersion: "agent-vigil-autopsy-discovery/v1";
  candidates: AutopsyCandidate[];
  scannedFiles: number;
  skippedOversized: number;
  truncated: boolean;
};

const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_DISCOVERED_FILES = 5_000;
const MAX_RESULTS = 12;
const METADATA_PREFIX_BYTES = 1024 * 1024;

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : undefined;
}

function readMetadataPrefix(path: string): string {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const linkedBefore = lstatSync(path, { bigint: true });
    if (!before.isFile() || linkedBefore.isSymbolicLink() || !linkedBefore.isFile()
      || before.dev !== linkedBefore.dev || before.ino !== linkedBefore.ino || before.size !== linkedBefore.size
      || before.mtimeNs !== linkedBefore.mtimeNs || before.ctimeNs !== linkedBefore.ctimeNs) {
      throw new Error("candidate changed before metadata was read");
    }
    const length = Math.min(Number(before.size), METADATA_PREFIX_BYTES);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(descriptor, bytes, offset, length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const linkedAfter = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== linkedAfter.dev || after.ino !== linkedAfter.ino || after.size !== linkedAfter.size
      || after.mtimeNs !== linkedAfter.mtimeNs || after.ctimeNs !== linkedAfter.ctimeNs) {
      throw new Error("candidate changed while metadata was read");
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function metadata(path: string, agent: AutopsyCandidate["agent"]): Pick<AutopsyCandidate, "repository" | "branch"> {
  let prefix: string;
  try { prefix = readMetadataPrefix(path); }
  catch { return {}; }
  let repository: string | undefined;
  let branch: string | undefined;
  for (const line of prefix.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); }
    catch { continue; }
    if (agent === "codex") {
      repository ??= boundedString(row?.payload?.cwd);
      branch ??= boundedString(row?.payload?.git?.branch);
    } else {
      repository ??= boundedString(row?.cwd);
      branch ??= boundedString(row?.gitBranch);
    }
    if (repository && branch) break;
  }
  return { ...(repository ? { repository } : {}), ...(branch ? { branch } : {}) };
}

export function discoverAutopsyCandidates(roots: AutopsyDiscoveryRoot[]): AutopsyDiscovery {
  const files: Array<{ path: string; agent: AutopsyCandidate["agent"]; modifiedMs: number; bytes: number }> = [];
  let directoryEntries = 0;
  let scannedFiles = 0;
  let skippedOversized = 0;
  let truncated = false;

  for (const configured of roots) {
    const root = resolve(configured.path);
    if (!existsSync(root)) continue;
    let rootStatus;
    try { rootStatus = lstatSync(root); }
    catch { continue; }
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) continue;
    const queue = [{ path: root, depth: 0 }];
    while (queue.length) {
      const current = queue.shift()!;
      let directoryBefore;
      let entries;
      try {
        directoryBefore = lstatSync(current.path, { bigint: true });
        if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) continue;
        entries = readdirSync(current.path, { withFileTypes: true });
        const directoryAfter = lstatSync(current.path, { bigint: true });
        if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
          || directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
          || directoryBefore.mtimeNs !== directoryAfter.mtimeNs || directoryBefore.ctimeNs !== directoryAfter.ctimeNs) continue;
      }
      catch { continue; }
      for (const entry of entries) {
        directoryEntries += 1;
        if (directoryEntries > MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
        if (entry.isSymbolicLink()) continue;
        const path = join(current.path, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < configured.maxDepth) queue.push({ path, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile() || !/\.jsonl$/i.test(entry.name)) continue;
        scannedFiles += 1;
        if (files.length >= MAX_DISCOVERED_FILES) { truncated = true; break; }
        let status;
        try { status = lstatSync(path); }
        catch { continue; }
        if (!status.isFile() || status.isSymbolicLink()) continue;
        if (status.size > MAX_TRANSCRIPT_BYTES) skippedOversized += 1;
        files.push({ path, agent: configured.agent, modifiedMs: status.mtimeMs, bytes: status.size });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  const candidates = files
    .sort((left, right) => right.modifiedMs - left.modifiedMs || left.path.localeCompare(right.path))
    .slice(0, MAX_RESULTS)
    .map((file) => ({
      path: file.path,
      agent: file.agent,
      modifiedAt: new Date(file.modifiedMs).toISOString(),
      bytes: file.bytes,
      selectable: file.bytes <= MAX_TRANSCRIPT_BYTES,
      ...metadata(file.path, file.agent),
    }));
  return {
    schemaVersion: "agent-vigil-autopsy-discovery/v1",
    candidates,
    scannedFiles,
    skippedOversized,
    truncated,
  };
}
