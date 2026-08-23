import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { canonical } from "../report.ts";
import { inspectArtifactTree } from "./decision.ts";
import { terminalSafe } from "./presentation.ts";

export const UPDATE_PLAN_SCHEMA = "agent-vigil-update-plan/v1" as const;
const UPDATE_PLAN_MAX_CHANGES = 4_097;

export type UpdateManager = "apm" | "skills" | "agent-plugin";
export type UpdateChangeKind = "UPDATED" | "ADDED" | "REMOVED";

export type UpdatePlanEndpoint = {
  version: string;
  integrityKind: "git-commit" | "sha256" | "git-tree" | "artifact-tree" | "unbound";
  integrity: string;
};

export type UpdatePlanChange = {
  componentType: "apm-package" | "apm-workspace" | "skill" | "skills-workspace" | "agent-plugin";
  identity: string;
  displayName: string;
  change: UpdateChangeKind;
  current?: UpdatePlanEndpoint;
  candidate?: UpdatePlanEndpoint;
  behavioralPreflight: "REQUIRED" | "UNAVAILABLE";
  reasons: string[];
};

export type UpdatePlan = {
  schemaVersion: typeof UPDATE_PLAN_SCHEMA;
  generatedAt: string;
  manager: UpdateManager;
  source: {
    currentSha256: string;
    candidateSha256: string;
  };
  changes: UpdatePlanChange[];
  summary: {
    total: number;
    updated: number;
    added: number;
    removed: number;
    eligiblePairs: number;
  };
  limitations: string[];
  planHash: string;
};

type ManagerRecord = {
  identity: string;
  displayName: string;
  componentType: UpdatePlanChange["componentType"];
  endpoint: UpdatePlanEndpoint;
  fingerprint: string;
  capabilityFingerprint?: string;
  reasonFingerprints?: Record<string, string>;
  apmRow?: Record<string, unknown>;
};

type ManagerSnapshot = {
  records: Map<string, ManagerRecord>;
  sourceSha256: string;
};

const LIMITATIONS = [
  "This plan proves only how two bounded manager states differ; it does not execute, install, or declare an update safe.",
  "Only UPDATED records with distinct exact artifact integrity on both sides are eligible for behavioral preflight.",
  "ADDED and REMOVED records require separate policy review because no old/new behavior pair exists.",
];

function hash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Bind the YAML node representation rather than only its JavaScript value.
 * YAML parsers legitimately coerce distinct security-relevant spellings such
 * as `01` and `1` to the same number, while JSON also collapses NaN and both
 * infinities to null. Scalar source, style, and tag therefore remain part of
 * the comparison commitment. Comments and map order are deliberately ignored.
 */
function canonicalYamlNode(value: unknown): unknown {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) throw new Error("APM YAML state exceeds canonicalization bounds");
    if (item && typeof item === "object" && "anchor" in item
      && typeof (item as { anchor?: unknown }).anchor === "string") {
      throw new Error("APM YAML anchors and aliases are not accepted");
    }
    if (isScalar(item)) {
      return ["scalar", item.type ?? null, item.tag ?? null, item.source ?? null];
    }
    if (isSeq(item)) return ["sequence", item.items.map((entry) => visit(entry, depth + 1))];
    if (isMap(item)) {
      const entries = item.items.map((pair) => {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          throw new Error("APM YAML mapping keys must be strings");
        }
        return [pair.key.value, visit(pair.value, depth + 1)];
      }).sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
      return ["mapping", entries];
    }
    if (item === null) return ["empty"];
    throw new Error("APM YAML aliases and unsupported nodes are not accepted");
  };
  return visit(value, 0);
}

/**
 * Commit to the complete semantic tree accepted by the strict JSON parser.
 * Object order, whitespace, and equivalent string escapes are intentionally
 * ignored, while every key and value (including future additive fields) is
 * retained. JSON numbers keep their exact lexical source because JavaScript
 * otherwise rounds unsafe integers, overflows exponents to infinity, and
 * collapses signed underflow to zero. Traversing the parser nodes also gives
 * us bounded subtrees for per-skill and workspace commitments without copying
 * attacker-selected keys.
 */
function canonicalJsonNode(value: unknown): unknown {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) throw new Error("manager JSON state exceeds canonicalization bounds");
    if (isScalar(item)) {
      const scalar = item.value;
      if (typeof scalar === "number") {
        const source = item.source;
        if (typeof source !== "string" || source.length > 1_024
          || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(source)) {
          throw new Error("manager JSON contains an unsupported number representation");
        }
        return ["scalar", "number", source];
      }
      return scalar === null ? ["scalar", "null"] : ["scalar", typeof scalar, scalar];
    }
    if (isSeq(item)) return ["sequence", item.items.map((entry) => visit(entry, depth + 1))];
    if (isMap(item)) {
      const entries = item.items.map((pair) => {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          throw new Error("manager JSON mapping keys must be strings");
        }
        return [pair.key.value, visit(pair.value, depth + 1)];
      }).sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
      return ["mapping", entries];
    }
    throw new Error("manager JSON contains an unsupported node");
  };
  return visit(value, 0);
}

function yamlMapEntries(value: unknown, label: string): Array<[string, unknown]> {
  if (!isMap(value)) throw new Error(`${label} must be a YAML mapping`);
  return value.items.map((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error(`${label} keys must be strings`);
    }
    return [pair.key.value, pair.value];
  });
}

function yamlEntriesCommitment(entries: Array<[string, unknown]>): string {
  const normalized = entries
    .map(([key, value]) => [key, canonicalYamlNode(value)])
    .sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
  return canonical(["mapping", normalized]);
}

function selectedYamlCommitment(entries: Map<string, unknown>, fields: readonly string[]): string {
  return canonical(["mapping", fields.map((field) => [
    field,
    entries.has(field) ? canonicalYamlNode(entries.get(field)) : ["absent"],
  ])]);
}

function jsonMapEntries(value: unknown, label: string): Array<[string, unknown]> {
  if (!isMap(value)) throw new Error(`${label} must be a JSON object`);
  return value.items.map((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error(`${label} keys must be strings`);
    }
    return [pair.key.value, pair.value];
  });
}

function jsonEntriesCommitment(entries: Array<[string, unknown]>): string {
  const normalized = entries
    .map(([key, value]) => [key, canonicalJsonNode(value)])
    .sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
  return canonical(["mapping", normalized]);
}

function selectedJsonCommitment(entries: Map<string, unknown>, fields: readonly string[]): string {
  return canonical(["mapping", fields.map((field) => [
    field,
    entries.has(field) ? canonicalJsonNode(entries.get(field)) : ["absent"],
  ])]);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 2_048): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maximum = 2_048): string | undefined {
  return value === undefined || value === null ? undefined : text(value, label, maximum);
}

function strictUtf8(bytes: Buffer, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

function strictJsonDocument(bytes: Buffer, label: string): { value: unknown; node: unknown } {
  const source = strictUtf8(bytes, label);
  try { JSON.parse(source); }
  catch { throw new Error(`${label} is not valid JSON`); }
  const document = parseDocument(source, { schema: "json", uniqueKeys: true });
  // Parser diagnostics can quote attacker-controlled source lines. Keep CLI
  // errors generic so credentials embedded in manager URLs are never echoed.
  if (document.errors.length) throw new Error(`${label} is invalid JSON`);
  return { value: document.toJS({ maxAliasCount: 0 }), node: document.contents };
}

function strictJson(bytes: Buffer, label: string): unknown {
  return strictJsonDocument(bytes, label).value;
}

function regularBytes(path: string, maximum: number, label: string): Buffer {
  const requested = resolve(path);
  const beforePath = lstatSync(requested, { bigint: true });
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
  if (beforePath.size > BigInt(maximum)) throw new Error(`${label} exceeds ${maximum} bytes`);
  const descriptor = openSync(requested, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error(`${label} changed while it was opened`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(requested, { bigint: true });
    if (bytes.length > maximum || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== afterPath.dev || after.ino !== afterPath.ino || afterPath.isSymbolicLink()) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function exactSha256(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  return /^sha256:[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}

function exactGitCommit(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{40}$/.test(value) ? value : undefined;
}

function apmEndpoint(item: Record<string, unknown>, index: number): UpdatePlanEndpoint {
  const commit = exactGitCommit(optionalText(item.resolved_commit, `dependencies[${index}].resolved_commit`, 64));
  const treeHash = exactSha256(optionalText(item.tree_sha256, `dependencies[${index}].tree_sha256`, 80));
  const resolvedHash = exactSha256(optionalText(item.resolved_hash, `dependencies[${index}].resolved_hash`, 80));
  const contentHash = exactSha256(optionalText(item.content_hash, `dependencies[${index}].content_hash`, 80));
  optionalText(item.version, `dependencies[${index}].version`, 128);
  optionalText(item.resolved_tag, `dependencies[${index}].resolved_tag`, 128);
  optionalText(item.resolved_ref, `dependencies[${index}].resolved_ref`, 128);
  // Manager version, tag, and ref values are private inputs and may contain
  // credentials. Plans retain a useful endpoint label without copying them.
  const version = commit ? `commit:${commit.slice(0, 12)}`
    : treeHash ? `digest:${treeHash.slice(7, 19)}`
      : resolvedHash ? `digest:${resolvedHash.slice(7, 19)}`
      : contentHash ? `digest:${contentHash.slice(7, 19)}`
        : "unbound";
  // APM's collision-resistant canonical tree identity is the exact artifact
  // identity when present. The commit remains a required materialization
  // coordinate and is carried privately by the automatic preflight adapter.
  if (treeHash) return { version, integrityKind: "sha256", integrity: treeHash };
  if (commit) return { version, integrityKind: "git-commit", integrity: commit };
  if (resolvedHash) return { version, integrityKind: "sha256", integrity: resolvedHash };
  if (contentHash) return { version, integrityKind: "sha256", integrity: contentHash };
  return { version, integrityKind: "unbound", integrity: "unavailable" };
}

const APM_DIAGNOSTIC_TOP_LEVEL_FIELDS = new Set(["generated_at", "apm_version"]);

const APM_WORKSPACE_REASON_GROUPS = {
  "APM lockfile format changed": ["lockfile_version"],
  "APM MCP command, arguments, server, target, or ownership state changed": [
    "mcp_servers", "mcp_configs", "mcp_target_servers", "mcp_config_provenance",
  ],
  "APM LSP runtime configuration changed": ["lsp_servers", "lsp_configs"],
  "APM local deployment state changed": ["local_deployed_files", "local_deployed_file_hashes"],
  "APM canonical deployment ledger changed": ["deployments"],
} as const;

function apmWorkspaceRecord(root: Record<string, unknown>, yamlEntries: Array<[string, unknown]>): ManagerRecord {
  const yamlByName = new Map(yamlEntries);
  const workspaceEntries = yamlEntries.filter(([field]) => (
    field !== "dependencies" && !APM_DIAGNOSTIC_TOP_LEVEL_FIELDS.has(field)
  ));
  const workspaceIntegrity = hash(yamlEntriesCommitment(workspaceEntries));
  const groupedFields = new Set<string>(Object.values(APM_WORKSPACE_REASON_GROUPS).flat());
  const reasonFingerprints = Object.fromEntries([
    ...Object.entries(APM_WORKSPACE_REASON_GROUPS).map(([reason, fields]) => [
      reason,
      hash(selectedYamlCommitment(yamlByName, fields)),
    ]),
    [
      "other APM additive workspace state changed",
      hash(yamlEntriesCommitment(workspaceEntries.filter(([field]) => !groupedFields.has(field)))),
    ],
  ]);
  const lockfileVersion = text(root.lockfile_version, "APM lockfile_version", 8);
  return {
    identity: "apm:workspace",
    displayName: "APM workspace state",
    componentType: "apm-workspace",
    endpoint: {
      version: `lockfile-v${lockfileVersion}:${workspaceIntegrity.slice(7, 19)}`,
      integrityKind: "sha256",
      integrity: workspaceIntegrity,
    },
    fingerprint: workspaceIntegrity,
    reasonFingerprints,
  };
}

function parseApm(bytes: Buffer): Map<string, ManagerRecord> {
  const document = parseDocument(strictUtf8(bytes, "APM lockfile"), {
    // OpenAPM req-mf-020 requires untagged scalar values to remain strings.
    schema: "failsafe",
    uniqueKeys: true,
  });
  // YAML diagnostics can include raw source excerpts and secret-bearing URLs.
  if (document.errors.length) throw new Error("APM lockfile is invalid YAML");
  if (document.warnings.length) throw new Error("APM lockfile uses unsupported YAML syntax");
  // Traverse before toJS so an alias cannot be resolved before the fail-closed
  // anchor/alias check sees it.
  canonicalYamlNode(document.contents);
  const rootEntries = yamlMapEntries(document.contents, "APM lockfile");
  const root = record(document.toJS({ maxAliasCount: 0 }), "APM lockfile");
  if (root.lockfile_version !== "1" && root.lockfile_version !== "2") {
    throw new Error("APM lockfile_version must be 1 or 2");
  }
  if (!Array.isArray(root.dependencies) || root.dependencies.length > 4_096) {
    throw new Error("APM dependencies must be an array of at most 4096 entries");
  }
  const workspace = apmWorkspaceRecord(root, rootEntries);
  const output = new Map<string, ManagerRecord>([[workspace.identity, workspace]]);
  const dependencyNode = new Map(rootEntries).get("dependencies");
  if (!isSeq(dependencyNode) || dependencyNode.items.length !== root.dependencies.length) {
    throw new Error("APM dependencies YAML state is inconsistent");
  }
  root.dependencies.forEach((raw, index) => {
    const item = record(raw, `dependencies[${index}]`);
    const repoUrl = text(item.repo_url, `dependencies[${index}].repo_url`);
    const host = optionalText(item.host, `dependencies[${index}].host`, 255) ?? "";
    const source = optionalText(item.source, `dependencies[${index}].source`, 80) ?? "git";
    const localPath = optionalText(item.local_path, `dependencies[${index}].local_path`, 1_024) ?? "";
    optionalText(item.name, `dependencies[${index}].name`, 160);
    const identity = `apm:${hash(canonical({ host, source, repoUrl, localPath })).slice(7)}`;
    if (output.has(identity)) throw new Error(`APM lockfile contains duplicate dependency identity: ${identity}`);
    const endpoint = apmEndpoint(item, index);
    // Bind every emitted dependency field, including additive fields introduced by
    // future APM releases. Identity remains separately derived from transport and
    // path coordinates; no unrecognized manager state can silently disappear.
    const fingerprint = hash(canonical(canonicalYamlNode(dependencyNode.items[index])));
    output.set(identity, {
      identity,
      // APM names and repository URLs are manager-controlled private strings.
      // Use the stable pseudonymous identity for display in JSON and terminals.
      displayName: `APM dependency ${identity.slice(4, 16)}`,
      componentType: "apm-package",
      endpoint,
      fingerprint,
      apmRow: item,
    });
  });
  return output;
}

const SKILLS_DIAGNOSTIC_ENTRY_FIELDS = new Set(["installedAt", "updatedAt"]);
const SKILLS_SOURCE_TYPES = new Set(["github", "git", "gitlab", "mintlify", "huggingface", "local", "well-known"]);
const SKILLS_TREE_SOURCE_TYPES = new Set(["github"]);
const SKILLS_CLONE_SOURCE_TYPES = new Set(["github", "git", "gitlab"]);

const SKILLS_ENTRY_REASON_GROUPS = {
  "Skills source, ref, path, or update route changed": [
    "source", "sourceType", "sourceUrl", "ref", "skillPath", "sourceBaseUrl",
  ],
  "Skills exact content identity changed": ["skillFolderHash", "wellKnownDigest"],
  "Skills plugin ownership changed": ["pluginName"],
} as const;

function skillsWorkspaceRecord(rootEntries: Array<[string, unknown]>): ManagerRecord {
  // Bind every top-level manager field except the skill map committed record by
  // record below. This includes current prompt and target-selection preferences
  // as well as future additive fields; none can silently become a zero plan.
  const managerEntries = rootEntries.filter(([field]) => field !== "skills");
  const managerByName = new Map(managerEntries);
  const preferenceFields = ["dismissed", "lastSelectedAgents"] as const;
  const integrity = hash(jsonEntriesCommitment(managerEntries));
  return {
    identity: "skills:workspace",
    displayName: "Skills manager state",
    componentType: "skills-workspace",
    endpoint: {
      version: `lockfile-v3:${integrity.slice(7, 19)}`,
      integrityKind: "sha256",
      integrity,
    },
    fingerprint: integrity,
    reasonFingerprints: {
      "Skills prompt or installation-target preference changed": hash(selectedJsonCommitment(managerByName, preferenceFields)),
      "other Skills additive manager state changed": hash(jsonEntriesCommitment(
        managerEntries.filter(([field]) => !preferenceFields.includes(field as typeof preferenceFields[number])),
      )),
    },
  };
}

function skillsEndpoint(
  name: string,
  item: Record<string, unknown>,
  sourceType: string,
  ref: string | undefined,
): UpdatePlanEndpoint {
  if (typeof item.skillFolderHash !== "string" || item.skillFolderHash.length > 128 || item.skillFolderHash.includes("\0")) {
    throw new Error(`skills.${name}.skillFolderHash must be a bounded string`);
  }
  const folderHash = item.skillFolderHash;
  const digestText = optionalText(item.wellKnownDigest, `skills.${name}.wellKnownDigest`, 80);
  const wellKnownDigest = digestText && /^sha256:[0-9a-f]{64}$/.test(digestText) ? digestText : undefined;
  if (digestText && !wellKnownDigest) throw new Error(`skills.${name}.wellKnownDigest is not an exact sha256 identity`);

  // Current upstream well-known installs deliberately leave skillFolderHash
  // empty and bind both their HTTPS update route and exact content digest.
  if (sourceType === "well-known") {
    if (folderHash !== "") throw new Error(`skills.${name}.skillFolderHash must be empty for a well-known source`);
    if (!wellKnownDigest) throw new Error(`skills.${name}.wellKnownDigest is required for a well-known source`);
    exactHttpsUrl(item.sourceUrl, `skills.${name}.sourceUrl`);
    exactHttpsUrl(item.sourceBaseUrl, `skills.${name}.sourceBaseUrl`);
    return {
      version: ref ?? `digest:${wellKnownDigest.slice(7, 19)}`,
      integrityKind: "sha256",
      integrity: wellKnownDigest,
    };
  }
  if (Object.prototype.hasOwnProperty.call(item, "wellKnownDigest")) {
    throw new Error(`skills.${name}.wellKnownDigest is supported only for a well-known source`);
  }
  if (Object.prototype.hasOwnProperty.call(item, "sourceBaseUrl")) {
    throw new Error(`skills.${name}.sourceBaseUrl is supported only for a well-known source`);
  }
  if (sourceType === "local") {
    return { version: ref ?? "local", integrityKind: "unbound", integrity: "unavailable" };
  }
  if (/^[0-9a-f]{40}$/.test(folderHash)) {
    if (!SKILLS_TREE_SOURCE_TYPES.has(sourceType)) {
      throw new Error(`skills.${name}.skillFolderHash Git tree identity is unsupported for sourceType ${sourceType}`);
    }
    return {
      version: ref ?? `tree:${folderHash.slice(0, 12)}`,
      integrityKind: "git-tree",
      integrity: folderHash,
    };
  }
  if (/^[0-9a-f]{64}$/.test(folderHash)) {
    const digest = `sha256:${folderHash}`;
    return {
      version: ref ?? `digest:${folderHash.slice(0, 12)}`,
      integrityKind: "sha256",
      integrity: digest,
    };
  }
  throw new Error(`skills.${name}.skillFolderHash is not an exact 40-character Git tree or 64-character SHA-256 identity`);
}

function exactUtcTimestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result) {
    throw new Error(`${label} must be an exact UTC ISO timestamp`);
  }
  return result;
}

function exactHttpsUrl(value: unknown, label: string): string {
  const result = text(value, label, 2_048);
  try {
    const parsed = new URL(result);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("unsupported URL");
  } catch {
    throw new Error(`${label} must be a credential-free HTTPS URL without a fragment`);
  }
  return result;
}

function optionalSkillsText(item: Record<string, unknown>, field: string, label: string, maximum: number): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(item, field)) return undefined;
  return text(item[field], label, maximum);
}

function skillsSourceUrl(value: unknown, label: string, sourceType: string): string {
  const result = text(value, label, 2_048);
  if (sourceType === "local") return result;
  if (SKILLS_CLONE_SOURCE_TYPES.has(sourceType)
    && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s\0]+$/.test(result)) return result;
  try {
    const parsed = new URL(result);
    const allowed = sourceType === "mintlify" || sourceType === "huggingface" || sourceType === "well-known"
      ? new Set(["https:"])
      : new Set(["https:", "ssh:", "git:"]);
    if (!allowed.has(parsed.protocol) || parsed.password || parsed.hash
      || (parsed.protocol === "https:" && parsed.username)) throw new Error("unsupported URL");
  } catch {
    throw new Error(`${label} is not a supported credential-free source URL`);
  }
  return result;
}

function skillsPath(item: Record<string, unknown>, name: string, sourceType: string): string | undefined {
  const label = `skills.${name}.skillPath`;
  const result = optionalSkillsText(item, "skillPath", label, 1_024);
  if (sourceType !== "well-known" && result === undefined) {
    throw new Error(`${label} is required for a materializable ${sourceType} source`);
  }
  if (result === undefined) return undefined;
  const parts = result.split("/");
  if (result.startsWith("/") || /^[A-Za-z]:/.test(result) || result.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(result) || parts.some((part) => !part || part === "." || part === "..")
    || parts.at(-1) !== "SKILL.md") {
    throw new Error(`${label} must be a normalized relative path ending in SKILL.md`);
  }
  return result;
}

function parseSkills(bytes: Buffer): Map<string, ManagerRecord> {
  const document = strictJsonDocument(bytes, "skills lockfile");
  canonicalJsonNode(document.node);
  const rootEntries = jsonMapEntries(document.node, "skills lockfile");
  const root = record(document.value, "skills lockfile");
  const versionNode = new Map(rootEntries).get("version");
  if (root.version !== 3 || !isScalar(versionNode) || versionNode.source !== "3") {
    throw new Error("skills lockfile version must be the exact integer 3");
  }
  const skills = record(root.skills, "skills lockfile skills");
  if (Object.keys(skills).length > 4_096) throw new Error("skills lockfile contains more than 4096 skills");
  const skillsNode = new Map(rootEntries).get("skills");
  const skillNodeEntries = jsonMapEntries(skillsNode, "skills lockfile skills");
  if (skillNodeEntries.length !== Object.keys(skills).length) throw new Error("skills lockfile JSON state is inconsistent");
  const skillNodes = new Map(skillNodeEntries);
  const output = new Map<string, ManagerRecord>();
  const workspace = skillsWorkspaceRecord(rootEntries);
  output.set(workspace.identity, workspace);
  for (const [name, raw] of Object.entries(skills)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      throw new Error(`skills lockfile contains unsupported skill name: ${name}`);
    }
    const item = record(raw, `skills.${name}`);
    const source = text(item.source, `skills.${name}.source`);
    const sourceType = text(item.sourceType, `skills.${name}.sourceType`, 80);
    if (!SKILLS_SOURCE_TYPES.has(sourceType)) throw new Error(`skills.${name}.sourceType is unsupported`);
    const sourceUrl = skillsSourceUrl(item.sourceUrl, `skills.${name}.sourceUrl`, sourceType);
    const ref = optionalSkillsText(item, "ref", `skills.${name}.ref`, 128);
    const skillPath = skillsPath(item, name, sourceType);
    const sourceBaseUrl = optionalSkillsText(item, "sourceBaseUrl", `skills.${name}.sourceBaseUrl`, 2_048);
    const pluginName = optionalSkillsText(item, "pluginName", `skills.${name}.pluginName`, 160);
    exactUtcTimestamp(item.installedAt, `skills.${name}.installedAt`);
    exactUtcTimestamp(item.updatedAt, `skills.${name}.updatedAt`);
    const endpoint = skillsEndpoint(name, item, sourceType, ref);
    const node = skillNodes.get(name);
    if (!node) throw new Error(`skills lockfile is missing the exact JSON node for ${name}`);
    const entryRows = jsonMapEntries(node, `skills.${name}`);
    const boundRows = entryRows.filter(([field]) => !SKILLS_DIAGNOSTIC_ENTRY_FIELDS.has(field));
    const boundByName = new Map(boundRows);
    const groupedFields = new Set<string>(Object.values(SKILLS_ENTRY_REASON_GROUPS).flat());
    const reasonFingerprints = Object.fromEntries([
      ...Object.entries(SKILLS_ENTRY_REASON_GROUPS).map(([reason, fields]) => [
        reason,
        hash(selectedJsonCommitment(boundByName, fields)),
      ]),
      [
        "other Skills additive entry state changed",
        hash(jsonEntriesCommitment(boundRows.filter(([field]) => !groupedFields.has(field)))),
      ],
    ]);
    // A same-name source, path, or owner replacement is not an ordinary old/new
    // artifact update. Make it a removed+added lineage transition so it cannot
    // become an automatically eligible behavioral pair.
    const lineage = hash(canonical({ source, sourceType, sourceUrl, skillPath, sourceBaseUrl, pluginName }));
    const identity = `skill:${name}:${lineage.slice(7)}`;
    output.set(identity, {
      identity,
      displayName: name,
      componentType: "skill",
      endpoint,
      fingerprint: hash(jsonEntriesCommitment(boundRows)),
      reasonFingerprints,
    });
  }
  return output;
}

function pluginSkills(root: string): string[] {
  const directory = join(root, "skills");
  try {
    const status = lstatSync(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("plugin skills path must be a regular directory");
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .flatMap((entry) => {
        const skill = join(directory, entry.name, "SKILL.md");
        try {
          const skillStatus = lstatSync(skill);
          return !skillStatus.isSymbolicLink() && skillStatus.isFile() ? [entry.name] : [];
        } catch { return []; }
      })
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function pluginMcpServers(root: string): Array<{ name: string; type: string }> {
  const path = join(root, "mcp.json");
  try {
    const value = record(strictJson(regularBytes(path, 512 * 1024, "agent plugin mcp.json"), "agent plugin mcp.json"), "agent plugin mcp.json");
    const servers = record(value.mcpServers, "agent plugin mcpServers");
    if (Object.keys(servers).length > 256) throw new Error("agent plugin has more than 256 MCP servers");
    return Object.entries(servers).map(([name, raw]) => ({
      name: text(name, "MCP server name", 160),
      type: text(record(raw, `mcpServers.${name}`).type, `mcpServers.${name}.type`, 40),
    })).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function parsePlugin(path: string): ManagerSnapshot {
  const requested = resolve(path);
  const status = lstatSync(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("agent-plugin state must be a regular directory");
  const root = realpathSync(requested);
  const inventoryBefore = inspectArtifactTree(root);
  const manifest = record(strictJson(regularBytes(join(root, "plugin.json"), 512 * 1024, "agent plugin manifest"), "agent plugin manifest"), "agent plugin manifest");
  if (manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    throw new Error("agent plugin manifest must target Agent Plugins 1.0.0");
  }
  const name = text(manifest.name, "agent plugin name", 64);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) || name.includes("--") || name.includes("..")) {
    throw new Error("agent plugin name is invalid");
  }
  const version = optionalText(manifest.version, "agent plugin version", 128) ?? `tree:${inventoryBefore.treeSha256.slice(7, 19)}`;
  const skills = pluginSkills(root);
  const mcpServers = pluginMcpServers(root);
  const identity = `agent-plugin:${name}`;
  const endpoint: UpdatePlanEndpoint = {
    version,
    integrityKind: "artifact-tree",
    integrity: inventoryBefore.treeSha256,
  };
  const records = new Map<string, ManagerRecord>([[identity, {
    identity,
    displayName: name,
    componentType: "agent-plugin",
    endpoint,
    fingerprint: inventoryBefore.treeSha256,
    capabilityFingerprint: hash(canonical({ skills, mcpServers, extensions: manifest.extensions ?? null })),
  }]]);
  const inventoryAfter = inspectArtifactTree(root);
  if (inventoryBefore.treeSha256 !== inventoryAfter.treeSha256) {
    throw new Error("agent-plugin state changed while the update plan was created");
  }
  return { records, sourceSha256: inventoryBefore.treeSha256 };
}

function readManager(manager: UpdateManager, path: string): ManagerSnapshot {
  if (manager === "apm") {
    const bytes = regularBytes(path, 4 * 1024 * 1024, "APM lockfile");
    return { records: parseApm(bytes), sourceSha256: hash(bytes) };
  }
  if (manager === "skills") {
    const bytes = regularBytes(path, 4 * 1024 * 1024, "skills lockfile");
    return { records: parseSkills(bytes), sourceSha256: hash(bytes) };
  }
  return parsePlugin(path);
}

function isExactEndpoint(endpoint: UpdatePlanEndpoint): boolean {
  if (endpoint.integrityKind === "git-commit" || endpoint.integrityKind === "git-tree") {
    return /^[0-9a-f]{40}$/.test(endpoint.integrity);
  }
  if (endpoint.integrityKind === "sha256" || endpoint.integrityKind === "artifact-tree") {
    return /^sha256:[0-9a-f]{64}$/.test(endpoint.integrity);
  }
  return false;
}

function isDistinctExactPair(current: UpdatePlanEndpoint, candidate: UpdatePlanEndpoint): boolean {
  return isExactEndpoint(current)
    && isExactEndpoint(candidate)
    && (current.integrityKind !== candidate.integrityKind || current.integrity !== candidate.integrity);
}

function changeReasons(current: ManagerRecord, candidate: ManagerRecord): string[] {
  const reasons: string[] = [];
  if (current.reasonFingerprints || candidate.reasonFingerprints) {
    const before = current.reasonFingerprints ?? {};
    const after = candidate.reasonFingerprints ?? {};
    for (const reason of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
      if (before[reason] !== after[reason]) reasons.push(reason);
    }
    if (reasons.length) return reasons;
  }
  if (current.endpoint.version !== candidate.endpoint.version) reasons.push("resolved version changed");
  if (current.endpoint.integrity !== candidate.endpoint.integrity) reasons.push("exact manager integrity changed");
  if (current.capabilityFingerprint !== candidate.capabilityFingerprint) reasons.push("declared component surface changed");
  if (!reasons.length) reasons.push("manager-controlled package state changed");
  return reasons;
}

function finalizePlan(plan: Omit<UpdatePlan, "planHash">): UpdatePlan {
  return { ...plan, planHash: hash(canonical(plan)) };
}

export function createUpdatePlan(input: {
  manager: UpdateManager;
  currentPath: string;
  candidatePath: string;
  generatedAt?: string;
}): UpdatePlan {
  const generatedAt = exactUtcTimestamp(
    input.generatedAt ?? new Date().toISOString(),
    "update plan generatedAt",
  );
  const currentSnapshot = readManager(input.manager, input.currentPath);
  const candidateSnapshot = readManager(input.manager, input.candidatePath);
  const current = currentSnapshot.records;
  const candidate = candidateSnapshot.records;
  const changes: UpdatePlanChange[] = [];
  for (const identity of [...new Set([...current.keys(), ...candidate.keys()])].sort()) {
    const before = current.get(identity);
    const after = candidate.get(identity);
    if (before && after && before.fingerprint === after.fingerprint) continue;
    if (before && after) {
      const eligible = isDistinctExactPair(before.endpoint, after.endpoint);
      changes.push({
        componentType: before.componentType,
        identity,
        displayName: before.displayName,
        change: "UPDATED",
        current: before.endpoint,
        candidate: after.endpoint,
        behavioralPreflight: eligible ? "REQUIRED" : "UNAVAILABLE",
        reasons: changeReasons(before, after),
      });
    } else if (after) {
      changes.push({
        componentType: after.componentType,
        identity,
        displayName: after.displayName,
        change: "ADDED",
        candidate: after.endpoint,
        behavioralPreflight: "UNAVAILABLE",
        reasons: ["component was added; no old behavior baseline exists"],
      });
    } else if (before) {
      changes.push({
        componentType: before.componentType,
        identity,
        displayName: before.displayName,
        change: "REMOVED",
        current: before.endpoint,
        behavioralPreflight: "UNAVAILABLE",
        reasons: ["component was removed; removal requires policy review"],
      });
    }
  }
  if (changes.length > UPDATE_PLAN_MAX_CHANGES) {
    throw new Error(`manager update produces more than ${UPDATE_PLAN_MAX_CHANGES} bounded changes`);
  }
  const plan = {
    schemaVersion: UPDATE_PLAN_SCHEMA,
    generatedAt,
    manager: input.manager,
    source: {
      currentSha256: currentSnapshot.sourceSha256,
      candidateSha256: candidateSnapshot.sourceSha256,
    },
    changes,
    summary: {
      total: changes.length,
      updated: changes.filter((change) => change.change === "UPDATED").length,
      added: changes.filter((change) => change.change === "ADDED").length,
      removed: changes.filter((change) => change.change === "REMOVED").length,
      eligiblePairs: changes.filter((change) => change.behavioralPreflight === "REQUIRED").length,
    },
    limitations: LIMITATIONS,
  } satisfies Omit<UpdatePlan, "planHash">;
  return finalizePlan(plan);
}

export type ApmMaterializationEndpoint = {
  repository: { owner: string; name: string };
  commit: string;
  expectedTreeSha256: string;
  routeSha256: string;
  rowSha256: string;
  virtualPath?: string;
};

export type ApmMaterializationSelection = {
  plan: UpdatePlan;
  change: UpdatePlanChange;
  selectedChangeSha256: string;
  current: ApmMaterializationEndpoint;
  candidate: ApmMaterializationEndpoint;
};

export class ApmMaterializationHold extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

const APM_KNOWN_DEPENDENCY_FIELDS = new Set([
  "repo_url", "materialization_repo_url", "host", "port", "registry_prefix",
  "host_type",
  "resolved_ref", "resolved_commit", "resolved_tag", "resolved_url", "resolved_hash",
  "resolved_at", "tree_sha256", "version", "virtual_path", "is_virtual", "depth", "resolved_by",
  "package_type", "skill_subset", "target_subset", "deployed_files", "deployed_file_hashes",
  "content_hash", "source", "local_path", "name", "constraint", "is_dev", "is_insecure",
  "allow_insecure", "exec_status", "discovered_via", "marketplace_plugin_name",
  "source_url", "source_digest", "license", "licenses", "homepage", "attestations",
]);

function apmPortablePath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const path = text(value, "APM virtual_path", 1_024);
  const parts = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)
    || parts.some((part) => !part || part === "." || part === "..")) {
    throw new ApmMaterializationHold("SOURCE_ROUTE_UNSUPPORTED");
  }
  return path;
}

function githubRepository(value: unknown): { owner: string; name: string } {
  const route = text(value, "APM repo_url", 512);
  // Current APM lockfiles normally store owner/repo with host: github.com;
  // OpenAPM examples also permit the host-prefixed spelling. Support exactly
  // those two canonical shapes, never a URL, scp route, query, or fragment.
  const match = /^(?:github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/.exec(route);
  const name = match?.[2].endsWith(".git") ? match[2].slice(0, -4) : match?.[2];
  if (!match || !name || name === "." || name === "..") {
    throw new ApmMaterializationHold("SOURCE_ROUTE_UNSUPPORTED");
  }
  return { owner: match[1], name };
}

function sameRepository(left: { owner: string; name: string }, right: { owner: string; name: string }): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.name.toLowerCase() === right.name.toLowerCase();
}

function materializationEndpoint(record: ManagerRecord): ApmMaterializationEndpoint {
  const row = record.apmRow;
  if (!row || Object.keys(row).some((field) => !APM_KNOWN_DEPENDENCY_FIELDS.has(field))) {
    throw new ApmMaterializationHold("SOURCE_SHAPE_UNSUPPORTED");
  }
  const source = row.source === undefined ? "git" : text(row.source, "APM source", 80);
  const host = row.host === undefined ? "github.com" : text(row.host, "APM host", 255);
  if (source !== "git" || host.toLowerCase() !== "github.com"
    || row.host_type !== undefined || row.port !== undefined || row.registry_prefix !== undefined
    || row.resolved_url !== undefined || row.resolved_hash !== undefined
    || row.local_path !== undefined
    || (row.is_insecure !== undefined && row.is_insecure !== "false")
    || (row.allow_insecure !== undefined && row.allow_insecure !== "false")) {
    throw new ApmMaterializationHold("SOURCE_ROUTE_UNSUPPORTED");
  }
  const repository = githubRepository(row.repo_url);
  let materializationRepository = repository;
  if (row.materialization_repo_url !== undefined) {
    materializationRepository = githubRepository(row.materialization_repo_url);
    if (!sameRepository(repository, materializationRepository)) {
      throw new ApmMaterializationHold("SOURCE_ROUTE_UNSUPPORTED");
    }
  }
  const commit = exactGitCommit(optionalText(row.resolved_commit, "APM resolved_commit", 64));
  const expectedTreeSha256 = exactSha256(optionalText(row.tree_sha256, "APM tree_sha256", 80));
  if (!commit || !expectedTreeSha256) throw new ApmMaterializationHold("SOURCE_INTEGRITY_UNAVAILABLE");
  const virtualPath = apmPortablePath(row.virtual_path);
  const routeSha256 = hash(canonical({
    protocol: "https",
    host: "codeload.github.com",
    owner: materializationRepository.owner.toLowerCase(),
    repository: materializationRepository.name.toLowerCase(),
    route: "tar.gz",
    commit,
  }));
  return {
    repository: materializationRepository,
    commit,
    expectedTreeSha256,
    routeSha256,
    rowSha256: record.fingerprint,
    ...(virtualPath ? { virtualPath } : {}),
  };
}

/**
 * Select one exact APM package row without copying source coordinates into the
 * update plan or CLI output. Only credential-free public GitHub git entries
 * with both a locked commit and APM canonical tree SHA-256 are materializable.
 */
export function selectApmMaterialization(input: {
  currentPath: string;
  candidatePath: string;
  generatedAt?: string;
  identity?: string;
}): ApmMaterializationSelection {
  const plan = createUpdatePlan({
    manager: "apm",
    currentPath: input.currentPath,
    candidatePath: input.candidatePath,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
  const eligible = plan.changes.filter((change) => (
    change.componentType === "apm-package"
    && change.change === "UPDATED"
    && change.behavioralPreflight === "REQUIRED"
  ));
  const selected = input.identity
    ? eligible.find((change) => change.identity === input.identity)
    : eligible.length === 1 ? eligible[0] : undefined;
  if (!selected) {
    throw new ApmMaterializationHold(
      eligible.length === 0 ? "NO_ELIGIBLE_PAIR"
        : input.identity ? "SELECTED_PAIR_UNAVAILABLE" : "MULTIPLE_ELIGIBLE_PAIRS",
    );
  }
  const currentSnapshot = readManager("apm", input.currentPath);
  const candidateSnapshot = readManager("apm", input.candidatePath);
  if (currentSnapshot.sourceSha256 !== plan.source.currentSha256
    || candidateSnapshot.sourceSha256 !== plan.source.candidateSha256) {
    throw new ApmMaterializationHold("SOURCE_STATE_CHANGED");
  }
  const current = currentSnapshot.records.get(selected.identity);
  const candidate = candidateSnapshot.records.get(selected.identity);
  if (!current || !candidate) throw new ApmMaterializationHold("SELECTED_PAIR_UNAVAILABLE");
  return {
    plan,
    change: selected,
    selectedChangeSha256: hash(canonical(selected)),
    current: materializationEndpoint(current),
    candidate: materializationEndpoint(candidate),
  };
}

export function renderUpdatePlan(plan: UpdatePlan): string {
  const lines = [
    `Agent Vigil update plan: ${plan.manager}`,
    `  ${plan.summary.total} change(s) · ${plan.summary.eligiblePairs} exact old/new pair(s) require behavioral preflight`,
  ];
  for (const change of plan.changes) {
    const pair = change.current && change.candidate
      ? `${terminalSafe(change.current.version)} -> ${terminalSafe(change.candidate.version)}`
      : change.current ? `${terminalSafe(change.current.version)} -> removed` : `added -> ${terminalSafe(change.candidate?.version ?? "unknown")}`;
    lines.push(`  ${change.change === "UPDATED" ? "!" : "?"} ${terminalSafe(change.displayName)}: ${pair} · ${change.behavioralPreflight}`);
  }
  if (!plan.changes.length) lines.push("  ✓ no manager-state changes detected");
  lines.push(`  ${plan.planHash}`);
  return `${lines.join("\n")}\n`;
}

export function defaultPlanName(manager: UpdateManager): string {
  return `${manager}-${basename(manager === "agent-plugin" ? "plugin" : "lock")}-update-plan.json`;
}
