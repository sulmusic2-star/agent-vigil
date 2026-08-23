import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { canonical, type CheckResult } from "./report.ts";

export type AuthorityPlatform = "mcp" | "claude-code" | "codex";
export type AuthorityDecision = "ALLOW" | "ASK" | "DENY" | "UNKNOWN";
export type AuthorityEffect =
  | "read"
  | "write"
  | "execute"
  | "network"
  | "external"
  | "credential"
  | "financial"
  | "control"
  | "unknown";
export type PlanStatus = "PASS" | "BLOCK" | "HOLD";
export type ChangeDirection = "EXPANSION" | "CONTRACTION" | "INCOMPARABLE" | "NEUTRAL";

export type AuthorityAtom = {
  id: string;
  platform: AuthorityPlatform;
  sourcePath: string;
  kind: "capability" | "permission" | "control" | "credential" | "model";
  subject: string;
  action: string;
  resource: string;
  effect: AuthorityEffect;
  decision: AuthorityDecision;
  constraints: string[];
  locator: string;
};

export type AuthoritySource = {
  platform: AuthorityPlatform;
  path: string;
  format: "json" | "toml";
  sha256: string;
};

export type AuthorityGap = {
  platform: AuthorityPlatform;
  sourcePath: string;
  locator: string;
  reason: string;
};

export type AuthorityProfile = {
  schemaVersion: "agent-vigil-authority-profile/v1";
  scope: "repository-declared";
  ref: string;
  sources: AuthoritySource[];
  atoms: AuthorityAtom[];
  gaps: AuthorityGap[];
  sha256: string;
};

export type AuthorityDelta = {
  id: string;
  ruleId: string;
  change: "ADDED" | "REMOVED" | "CHANGED";
  direction: ChangeDirection;
  disposition: "BLOCK" | "HOLD" | "ALLOW";
  severity: "critical" | "high" | "medium" | "low";
  summary: string;
  reason: string;
  approvalKey: string;
  approvedByPolicy?: boolean;
  before?: AuthorityAtom;
  after?: AuthorityAtom;
};

export type AuthorityPlanPolicy = {
  schemaVersion: 1;
  approvedAdditions: string[];
  allowUnknownChanges: boolean;
};

export type AuthorityPlan = {
  schemaVersion: "agent-vigil-authority-plan/v1";
  scope: "repository-declared";
  base: string;
  head: string;
  status: PlanStatus;
  policy: {
    source: string;
    sha256: string;
    allowUnknownChanges: boolean;
  };
  summary: {
    sources: number;
    atomsBefore: number;
    atomsAfter: number;
    changes: number;
    expansions: number;
    contractions: number;
    incomparable: number;
    blocking: number;
    holds: number;
    uncertainties: number;
    approved: number;
  };
  deltas: AuthorityDelta[];
  gaps: AuthorityGap[];
  baseProfileSha256: string;
  headProfileSha256: string;
  planSha256: string;
  limitations: string[];
};

type Relation = "equal" | "expansion" | "contraction" | "incomparable";
type InternalAtom = AuthorityAtom & {
  semanticKey: string;
  comparisonToken: string;
  added: RuleDisposition;
  removed: RuleDisposition;
  conditionalOn?: string;
  compare?: (before: InternalAtom, after: InternalAtom) => Relation;
};

type InternalProfile = Omit<AuthorityProfile, "atoms" | "sha256"> & {
  atoms: InternalAtom[];
};

type RuleDisposition = {
  disposition: "BLOCK" | "HOLD" | "ALLOW";
  direction: ChangeDirection;
  severity: AuthorityDelta["severity"];
  ruleId: string;
  reason: string;
};

type RecordValue = Record<string, unknown>;

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CONFIG_DEPTH = 32;
const MAX_CONFIG_NODES = 25_000;
const SENSITIVE_TEXT = /(?:token|secret|password|passphrase|api[_-]?key|authorization|bearer|private[_-]?key|gh[pousr]_|sk_(?:live|test)_|AKIA[0-9A-Z]{16}|-----BEGIN)/i;
export const AUTHORITY_CONFIG_PATHS = [
  ".mcp.json",
  "mcp.json",
  ".vscode/mcp.json",
  ".cursor/mcp.json",
  ".github/mcp.json",
  ".github/copilot/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/config.toml",
] as const;
const RELEVANT_PATHS = new Set<string>(AUTHORITY_CONFIG_PATHS);
const DEFAULT_POLICY: AuthorityPlanPolicy = { schemaVersion: 1, approvedAdditions: [], allowUnknownChanges: false };

const ALLOW_RESTRICTION: RuleDisposition = {
  disposition: "ALLOW",
  direction: "CONTRACTION",
  severity: "low",
  ruleId: "AVP000",
  reason: "the declared authority surface became narrower",
};

const HOLD_UNKNOWN: RuleDisposition = {
  disposition: "HOLD",
  direction: "INCOMPARABLE",
  severity: "medium",
  ruleId: "AVP001",
  reason: "the authority relationship cannot be proven from the declared configuration",
};

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))].sort()
    : [];
}

function invalidStringList(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()));
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function safeOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "non-url-endpoint";
  }
}

function safeExecutable(raw: string): string {
  if (SENSITIVE_TEXT.test(raw)) return "redacted-executable";
  const clean = raw.trim().split(/\s+/)[0] || "unknown";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(clean)) return "environment-assignment";
  return clean.split(/[\\/]/).at(-1) || "unknown";
}

function safeUnixSocket(raw: string): string {
  return SENSITIVE_TEXT.test(raw) ? "redacted-unix-socket" : raw.slice(0, 240);
}

function stableId(semanticKey: string): string {
  return `avp:${createHash("sha256").update(semanticKey).digest("hex").slice(0, 20)}`;
}

function safeField(value: string, maximum = 240): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?")
    .slice(0, maximum);
}

function atom(input: Omit<InternalAtom, "id" | "comparisonToken"> & { comparisonValue: unknown }): InternalAtom {
  const publicAtom: AuthorityAtom = {
    id: stableId(input.semanticKey),
    platform: input.platform,
    sourcePath: safeField(input.sourcePath),
    kind: input.kind,
    subject: safeField(input.subject),
    action: safeField(input.action),
    resource: safeField(input.resource),
    effect: input.effect,
    decision: input.decision,
    constraints: input.constraints.map((value) => safeField(value)).sort(),
    locator: safeField(input.locator),
  };
  return {
    ...publicAtom,
    semanticKey: input.semanticKey,
    comparisonToken: sha256(canonical(input.comparisonValue)),
    added: input.added,
    removed: input.removed,
    ...(input.conditionalOn ? { conditionalOn: input.conditionalOn } : {}),
    ...(input.compare ? { compare: input.compare } : {}),
  };
}

function publicAtom(value: InternalAtom): AuthorityAtom {
  const {
    semanticKey: _key,
    comparisonToken: _token,
    added: _added,
    removed: _removed,
    conditionalOn: _conditionalOn,
    compare: _compare,
    ...safe
  } = value;
  return safe;
}

function decisionRelation(before: AuthorityDecision, after: AuthorityDecision): Relation {
  if (before === after) return "equal";
  if (before === "UNKNOWN" || after === "UNKNOWN") return "incomparable";
  const rank: Record<Exclude<AuthorityDecision, "UNKNOWN">, number> = { DENY: 0, ASK: 1, ALLOW: 2 };
  return rank[after] > rank[before] ? "expansion" : "contraction";
}

function orderedRelation(order: readonly string[]): (before: InternalAtom, after: InternalAtom) => Relation {
  return (before, after) => {
    const a = order.indexOf(before.constraints.find((item) => item.startsWith("mode="))?.slice(5) ?? "");
    const b = order.indexOf(after.constraints.find((item) => item.startsWith("mode="))?.slice(5) ?? "");
    if (a < 0 || b < 0) return "incomparable";
    return b === a ? "equal" : b > a ? "expansion" : "contraction";
  };
}

function partialRelation(edges: ReadonlyArray<readonly [string, string]>): (before: InternalAtom, after: InternalAtom) => Relation {
  const reachable = new Map<string, Set<string>>();
  for (const [less, more] of edges) {
    if (!reachable.has(less)) reachable.set(less, new Set());
    reachable.get(less)!.add(more);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, targets] of reachable) {
      for (const target of [...targets]) {
        for (const next of reachable.get(target) ?? []) {
          if (!targets.has(next)) { targets.add(next); changed = true; }
        }
      }
      reachable.set(from, targets);
    }
  }
  return (before, after) => {
    const a = before.constraints.find((item) => item.startsWith("mode="))?.slice(5) ?? "";
    const b = after.constraints.find((item) => item.startsWith("mode="))?.slice(5) ?? "";
    if (!a || !b) return "incomparable";
    if (a === b) return "equal";
    if (reachable.get(a)?.has(b)) return "expansion";
    if (reachable.get(b)?.has(a)) return "contraction";
    return "incomparable";
  };
}

const MCP_APPROVAL_RELATION = partialRelation([
  ["prompt", "auto"],
  ["prompt", "writes"],
  ["auto", "approve"],
  ["writes", "approve"],
]);

const CLAUDE_MODE_RELATION = partialRelation([
  ["plan", "default"],
  ["dontAsk", "default"],
  ["default", "acceptEdits"],
  ["default", "auto"],
  ["acceptEdits", "bypassPermissions"],
  ["auto", "bypassPermissions"],
]);

function expansion(ruleId: string, reason: string, severity: AuthorityDelta["severity"] = "high"): RuleDisposition {
  return { disposition: "BLOCK", direction: "EXPANSION", severity, ruleId, reason };
}

function hold(ruleId: string, reason: string, severity: AuthorityDelta["severity"] = "medium"): RuleDisposition {
  return { disposition: "HOLD", direction: "INCOMPARABLE", severity, ruleId, reason };
}

function git(repo: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
  });
}

function relevantFiles(repo: string, ref: string): string[] {
  return git(repo, ["ls-tree", "--name-only", "-z", ref, "--", ...RELEVANT_PATHS])
    .split("\0")
    .filter((path) => RELEVANT_PATHS.has(path))
    .sort();
}

function readGitFile(repo: string, ref: string, path: string): string {
  const raw = git(repo, ["show", `${ref}:${path}`], MAX_CONFIG_BYTES + 1);
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error(`${path}@${ref} exceeds ${MAX_CONFIG_BYTES} bytes`);
  return raw;
}

function readGitFileOptional(repo: string, ref: string, path: string): string | undefined {
  try {
    git(repo, ["cat-file", "-e", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
  return readGitFile(repo, ref, path);
}

function validatePolicy(input: unknown): AuthorityPlanPolicy {
  const root = record(input);
  if (!root || root.schemaVersion !== 1) throw new Error("policy schemaVersion must be 1");
  const allowed = new Set(["schemaVersion", "approvedAdditions", "allowUnknownChanges"]);
  const extras = Object.keys(root).filter((key) => !allowed.has(key));
  if (extras.length) throw new Error(`policy contains unknown field(s): ${extras.join(", ")}`);
  if (!Array.isArray(root.approvedAdditions) || root.approvedAdditions.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("policy approvedAdditions must be an array of non-empty strings");
  }
  if (root.approvedAdditions.length > 1000 || root.approvedAdditions.some((item) => (item as string).length > 1000)) {
    throw new Error("policy approvedAdditions must contain at most 1000 entries of at most 1000 characters");
  }
  if (new Set(root.approvedAdditions).size !== root.approvedAdditions.length) {
    throw new Error("policy approvedAdditions must not contain duplicates");
  }
  if (typeof root.allowUnknownChanges !== "boolean") throw new Error("policy allowUnknownChanges must be boolean");
  return {
    schemaVersion: 1,
    approvedAdditions: [...root.approvedAdditions as string[]],
    allowUnknownChanges: root.allowUnknownChanges,
  };
}

function loadAuthorityPlanPolicy(
  repo: string,
  base: string,
  path = ".agent-vigil-authority-plan.json",
): { value: AuthorityPlanPolicy; source: string; sha256: string } {
  const clean = posix.normalize(path.replace(/^\.\//, ""));
  if (!clean || clean === ".." || clean.startsWith("../") || clean.startsWith("/") || path.includes("\\") || path.includes(":")) {
    throw new Error("authority plan policy path must stay inside the repository");
  }
  const raw = readGitFileOptional(repo, base, clean);
  if (raw === undefined) {
    return { value: DEFAULT_POLICY, source: "built-in default", sha256: sha256(canonical(DEFAULT_POLICY)) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`authority plan policy at ${base}:${clean} is not valid JSON`); }
  const value = validatePolicy(parsed);
  return { value, source: `${clean}@${base}`, sha256: sha256(canonical(value)) };
}

function parseConfig(raw: string, format: AuthoritySource["format"]): unknown {
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const parsed = format === "toml" ? parseToml(source) : JSON.parse(source);
  assertBoundedConfig(parsed);
  return parsed;
}

function assertBoundedConfig(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_CONFIG_NODES) throw new Error(`configuration exceeds ${MAX_CONFIG_NODES} structured values`);
    if (depth > MAX_CONFIG_DEPTH) throw new Error(`configuration exceeds maximum depth ${MAX_CONFIG_DEPTH}`);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const object = record(current);
    if (object) for (const item of Object.values(object)) visit(item, depth + 1);
  };
  visit(value, 0);
}

function sourcePlatform(path: string): AuthorityPlatform {
  if (path.startsWith(".claude/")) return "claude-code";
  if (path.startsWith(".codex/")) return "codex";
  return "mcp";
}

function permissionEffect(rule: string): AuthorityEffect {
  const tool = rule.split("(", 1)[0].toLowerCase();
  if (/read|grep|glob|search/.test(tool)) return "read";
  if (/edit|write|notebook/.test(tool)) return "write";
  if (/web|fetch/.test(tool)) return "network";
  if (/bash|shell|exec/.test(tool)) return "execute";
  if (/mcp__|send|post|comment|create|delete|update/.test(tool)) return "external";
  return "unknown";
}

function permissionResource(rule: string): string {
  const open = rule.indexOf("(");
  if (open < 0 || !rule.endsWith(")")) return "*";
  const value = rule.slice(open + 1, -1).trim();
  if (SENSITIVE_TEXT.test(value)) return "redacted-rule-scope";
  return value.slice(0, 200) || "*";
}

function safePermissionRule(rule: string): string {
  if (SENSITIVE_TEXT.test(rule)) {
    return `${permissionAction(rule)}(redacted-rule-scope)`;
  }
  return rule.slice(0, 240);
}

function permissionAction(rule: string): string {
  return rule.split("(", 1)[0].trim() || "unknown-tool";
}

function permissionDisposition(decision: AuthorityDecision): { added: RuleDisposition; removed: RuleDisposition } {
  if (decision === "ALLOW") return {
    added: expansion("AVP009", "a tool or resource became pre-authorized"),
    removed: ALLOW_RESTRICTION,
  };
  if (decision === "DENY") return {
    added: ALLOW_RESTRICTION,
    removed: expansion("AVP010", "an explicit deny rule was removed"),
  };
  if (decision === "ASK") return {
    added: { ...ALLOW_RESTRICTION, direction: "NEUTRAL", reason: "an explicit approval boundary was added" },
    removed: hold("AVP014", "removing an ask rule delegates the result to another rule or the default mode"),
  };
  return { added: HOLD_UNKNOWN, removed: HOLD_UNKNOWN };
}

function addPermissionAtoms(out: InternalAtom[], platform: AuthorityPlatform, path: string, rules: unknown, decision: AuthorityDecision, locator: string): void {
  const disposition = permissionDisposition(decision);
  for (const rule of stringList(rules)) {
    const semanticKey = `${platform}\0${path}\0permission\0${rule}`;
    out.push(atom({
      semanticKey,
      platform,
      sourcePath: path,
      kind: "permission",
      subject: "agent",
      action: permissionAction(rule),
      resource: permissionResource(rule),
      effect: permissionEffect(rule),
      decision,
      constraints: [`rule=${safePermissionRule(rule)}`],
      locator: `${locator}.${decision.toLowerCase()}`,
      comparisonValue: decision,
      added: disposition.added,
      removed: disposition.removed,
      compare: (before, after) => decisionRelation(before.decision, after.decision),
    }));
  }
}

function addEnvironmentAtoms(out: InternalAtom[], platform: AuthorityPlatform, path: string, subject: string, values: unknown, locator: string): void {
  const env = record(values);
  if (!env) return;
  for (const name of Object.keys(env).sort()) {
    const semanticKey = `${platform}\0${path}\0credential\0${subject}\0${name}`;
    out.push(atom({
      semanticKey,
      platform,
      sourcePath: path,
      kind: "credential",
      subject,
      action: "credential.expose",
      resource: `env:${name}`,
      effect: "credential",
      decision: "ALLOW",
      constraints: ["value=redacted"],
      locator: `${locator}.${name}`,
      comparisonValue: env[name],
      added: expansion("AVP008", "a new environment value can be exposed to agent-controlled code", "critical"),
      removed: ALLOW_RESTRICTION,
      compare: () => "incomparable",
    }));
  }
}

function addOpaqueAuthoritySection(
  out: InternalAtom[],
  platform: AuthorityPlatform,
  path: string,
  locator: string,
  value: unknown,
  reason: string,
): void {
  if (value === undefined) return;
  const disposition = hold("AVP014", reason, "high");
  out.push(atom({
    semanticKey: `${platform}\0${path}\0opaque-authority\0${locator}`,
    platform,
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "authority.opaque",
    resource: locator,
    effect: "unknown",
    decision: "UNKNOWN",
    constraints: ["normalization=opaque"],
    locator,
    comparisonValue: value,
    added: disposition,
    removed: disposition,
    compare: (before, after) => before.comparisonToken === after.comparisonToken ? "equal" : "incomparable",
  }));
}

function addBooleanExpansionControl(
  out: InternalAtom[],
  path: string,
  semanticName: string,
  rawValue: unknown,
  defaultValue: boolean,
  action: string,
  resource: string,
  locator: string,
  ruleId: string,
  reason: string,
): void {
  if (rawValue !== undefined && boolValue(rawValue) === undefined) {
    addOpaqueAuthoritySection(out, "claude-code", path, locator, rawValue, `${locator} must be a boolean authority control`);
  }
  const enabled = boolValue(rawValue) ?? defaultValue;
  out.push(atom({
    semanticKey: `claude-code\0${path}\0${semanticName}`,
    platform: "claude-code",
    sourcePath: path,
    kind: "control",
    subject: "bash",
    action,
    resource,
    effect: "control",
    decision: enabled ? "ALLOW" : "DENY",
    constraints: [`enabled=${enabled}`],
    locator,
    comparisonValue: enabled,
    added: enabled ? expansion(ruleId, reason, "critical") : ALLOW_RESTRICTION,
    removed: ALLOW_RESTRICTION,
    conditionalOn: `claude-code\0${path}\0sandbox-enabled`,
    compare: (before, after) => decisionRelation(before.decision, after.decision),
  }));
}

function addMcpEnvironmentReferences(out: InternalAtom[], platform: AuthorityPlatform, path: string, subject: string, values: unknown, locator: string): void {
  if (!Array.isArray(values)) return;
  for (const [index, raw] of values.entries()) {
    const config = record(raw);
    const name = stringValue(raw) ?? stringValue(config?.name);
    if (!name) {
      addOpaqueAuthoritySection(out, platform, path, `${locator}[${index}]`, raw, "an MCP environment reference has an unsupported shape");
      continue;
    }
    const source = stringValue(config?.source) ?? "local";
    out.push(atom({
      semanticKey: `${platform}\0${path}\0${subject}\0env-ref\0${name}`,
      platform,
      sourcePath: path,
      kind: "credential",
      subject,
      action: "environment.inherit",
      resource: `env:${name}`,
      effect: "credential",
      decision: "ALLOW",
      constraints: [`source=${source}`],
      locator,
      comparisonValue: { name, source },
      added: expansion("AVP008", "an MCP process can inherit an additional environment value", "critical"),
      removed: ALLOW_RESTRICTION,
      compare: (before, after) => before.comparisonToken === after.comparisonToken ? "equal" : "incomparable",
    }));
  }
}

function addMcpServerAtoms(out: InternalAtom[], platform: AuthorityPlatform, path: string, values: unknown, locator: string): void {
  const servers = record(values);
  if (!servers) return;
  for (const [name, rawServer] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    const server = record(rawServer);
    if (!server) {
      addOpaqueAuthoritySection(out, platform, path, `${locator}.${name}`, rawServer, "an MCP server entry has an unsupported shape");
      continue;
    }
    const enabled = boolValue(server.enabled) ?? !boolValue(server.disabled);
    const command = stringValue(server.command);
    const url = stringValue(server.url) ?? stringValue(server.serverUrl);
    const transport = url ? "http" : command ? "stdio" : stringValue(server.type) ?? "unknown";
    const identity = url ? safeOrigin(url) : command ? safeExecutable(command) : "unknown-server";
    const baseKey = `${platform}\0${path}\0mcp\0${name}`;
    out.push(atom({
      semanticKey: `${baseKey}\0enabled`,
      platform,
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.connect",
      resource: `${name}:${identity}`,
      effect: transport === "stdio" ? "execute" : transport === "http" ? "network" : "unknown",
      decision: enabled ? "ALLOW" : "DENY",
      constraints: [`enabled=${enabled}`, `transport=${transport}`],
      locator: `${locator}.${name}.enabled`,
      comparisonValue: enabled,
      added: enabled
        ? expansion("AVP002", "a newly declared MCP server adds an unbounded tool surface", "critical")
        : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      removed: enabled ? ALLOW_RESTRICTION : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      compare: (before, after) => decisionRelation(before.decision, after.decision),
    }));
    out.push(atom({
      semanticKey: `${baseKey}\0identity`,
      platform,
      sourcePath: path,
      kind: "control",
      subject: name,
      action: "mcp.launch",
      resource: identity,
      effect: transport === "stdio" ? "execute" : transport === "http" ? "network" : "unknown",
      decision: enabled ? "ALLOW" : "DENY",
      constraints: [`transport=${transport}`, ...(command ? [`executable=${safeExecutable(command)}`] : []), ...(url ? [`origin=${safeOrigin(url)}`] : [])],
      locator: `${locator}.${name}`,
      comparisonValue: { command, args: server.args, cwd: server.cwd, url },
      added: enabled
        ? expansion("AVP002", "a new MCP launch identity can execute code or contact an external service", "critical")
        : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      removed: ALLOW_RESTRICTION,
      compare: () => "expansion",
    }));
    addEnvironmentAtoms(out, platform, path, `mcp:${name}`, server.env, `${locator}.${name}.env`);
    addEnvironmentAtoms(out, platform, path, `mcp:${name}`, server.http_headers, `${locator}.${name}.http_headers`);
    addEnvironmentAtoms(out, platform, path, `mcp:${name}`, server.env_http_headers, `${locator}.${name}.env_http_headers`);
    addEnvironmentAtoms(out, platform, path, `mcp:${name}`, server.headers, `${locator}.${name}.headers`);
    addMcpEnvironmentReferences(out, platform, path, `mcp:${name}`, server.env_vars, `${locator}.${name}.env_vars`);
    const bearer = stringValue(server.bearer_token_env_var);
    if (bearer) addEnvironmentAtoms(out, platform, path, `mcp:${name}`, { [bearer]: "environment-reference" }, `${locator}.${name}.bearer_token_env_var`);

    const auth = stringValue(server.auth);
    if (auth) {
      out.push(atom({
        semanticKey: `${baseKey}\0auth-mode`,
        platform,
        sourcePath: path,
        kind: "credential",
        subject: `mcp:${name}`,
        action: "mcp.authenticate",
        resource: "credential-source",
        effect: "credential",
        decision: auth === "oauth" || auth === "chatgpt" ? "ALLOW" : "UNKNOWN",
        constraints: [`mode=${auth}`],
        locator: `${locator}.${name}.auth`,
        comparisonValue: auth,
        added: auth === "oauth" || auth === "chatgpt"
          ? expansion("AVP008", "an MCP server can use an additional authenticated credential source", "critical")
          : hold("AVP014", `unsupported MCP authentication mode ${auth}`),
        removed: HOLD_UNKNOWN,
        compare: (before, after) => before.comparisonToken === after.comparisonToken ? "equal" : "incomparable",
      }));
    }

    const executionEnvironment = stringValue(server.experimental_environment);
    if (executionEnvironment) {
      out.push(atom({
        semanticKey: `${baseKey}\0execution-environment`,
        platform,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name}`,
        action: "process.execute",
        resource: executionEnvironment,
        effect: "execute",
        decision: executionEnvironment === "remote" ? "ALLOW" : executionEnvironment === "local" ? "ASK" : "UNKNOWN",
        constraints: [`environment=${executionEnvironment}`],
        locator: `${locator}.${name}.experimental_environment`,
        comparisonValue: executionEnvironment,
        added: executionEnvironment === "remote"
          ? expansion("AVP009", "an MCP stdio process can execute in a remote environment", "critical")
          : executionEnvironment === "local" ? { ...ALLOW_RESTRICTION, direction: "NEUTRAL" } : HOLD_UNKNOWN,
        removed: HOLD_UNKNOWN,
        compare: orderedRelation(["local", "remote"]),
      }));
    }

    const oauthResource = stringValue(server.oauth_resource);
    if (oauthResource) {
      out.push(atom({
        semanticKey: `${baseKey}\0oauth-resource`,
        platform,
        sourcePath: path,
        kind: "credential",
        subject: `mcp:${name}`,
        action: "oauth.resource",
        resource: safeOrigin(oauthResource),
        effect: "credential",
        decision: "ALLOW",
        constraints: [],
        locator: `${locator}.${name}.oauth_resource`,
        comparisonValue: oauthResource,
        added: expansion("AVP008", "an MCP connection requests credentials for an additional OAuth resource", "critical"),
        removed: ALLOW_RESTRICTION,
        compare: () => "incomparable",
      }));
    }

    for (const scope of stringList(server.scopes)) {
      out.push(atom({
        semanticKey: `${baseKey}\0oauth-scope\0${scope}`,
        platform,
        sourcePath: path,
        kind: "permission",
        subject: `mcp:${name}`,
        action: "oauth.scope",
        resource: scope,
        effect: "external",
        decision: "ALLOW",
        constraints: [],
        locator: `${locator}.${name}.scopes`,
        comparisonValue: scope,
        added: expansion("AVP008", "an MCP connection requests an additional OAuth scope", "critical"),
        removed: ALLOW_RESTRICTION,
      }));
    }

    const enabledTools = stringList(server.enabled_tools ?? server.enabledTools);
    const disabledTools = stringList(server.disabled_tools ?? server.disabledTools);
    for (const tool of enabledTools) {
      out.push(atom({
        semanticKey: `${baseKey}\0tool\0${tool}`,
        platform,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name}`,
        action: "mcp.tool",
        resource: tool,
        effect: "unknown",
        decision: "ALLOW",
        constraints: ["selection=enabled"],
        locator: `${locator}.${name}.enabled_tools`,
        comparisonValue: true,
        added: expansion("AVP013", "an additional MCP tool is exposed to the agent", "critical"),
        removed: ALLOW_RESTRICTION,
      }));
    }
    for (const tool of disabledTools) {
      out.push(atom({
        semanticKey: `${baseKey}\0tool\0${tool}`,
        platform,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name}`,
        action: "mcp.tool",
        resource: tool,
        effect: "unknown",
        decision: "DENY",
        constraints: ["selection=disabled"],
        locator: `${locator}.${name}.disabled_tools`,
        comparisonValue: false,
        added: ALLOW_RESTRICTION,
        removed: expansion("AVP013", "an MCP tool was removed from the explicit deny list", "critical"),
        compare: (before, after) => decisionRelation(before.decision, after.decision),
      }));
    }

    const approvalMode = stringValue(server.default_tools_approval_mode ?? server.defaultToolsApprovalMode);
    if (approvalMode) addMcpApprovalAtom(out, platform, path, `${baseKey}\0approval`, name, approvalMode, `${locator}.${name}.default_tools_approval_mode`);
    const tools = record(server.tools);
    if (tools) {
      for (const [tool, rawTool] of Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))) {
        const config = record(rawTool);
        if (!config) continue;
        const mode = stringValue(config.approval_mode ?? config.approvalMode);
        if (mode) addMcpApprovalAtom(out, platform, path, `${baseKey}\0tool-approval\0${tool}`, `${name}/${tool}`, mode, `${locator}.${name}.tools.${tool}.approval_mode`);
      }
    }

    const recognized = new Set([
      "args", "auth", "bearer_token_env_var", "command", "cwd", "defaultToolsApprovalMode",
      "default_tools_approval_mode", "disabled", "disabledTools", "disabled_tools", "enabled",
      "enabledTools", "enabled_tools", "env", "env_http_headers", "env_vars", "experimental_environment",
      "headers", "http_headers", "oauth_resource", "required", "scopes", "serverUrl", "startup_timeout_ms",
      "startup_timeout_sec", "tool_timeout_sec", "tools", "type", "url",
    ]);
    const unsupported = Object.fromEntries(Object.entries(server).filter(([key]) => !recognized.has(key)));
    if (Object.keys(unsupported).length) {
      addOpaqueAuthoritySection(out, platform, path, `${locator}.${name}.*`, unsupported, "an MCP server contains authority-bearing fields that are not yet normalized");
    }
  }
}

function addMcpApprovalAtom(out: InternalAtom[], platform: AuthorityPlatform, path: string, semanticKey: string, subject: string, mode: string, locator: string): void {
  const supported = new Set(["auto", "prompt", "writes", "approve"]);
  const known = supported.has(mode);
  out.push(atom({
    semanticKey,
    platform,
    sourcePath: path,
    kind: "control",
    subject: `mcp:${subject}`,
    action: "approval.mode",
    resource: "tool-call",
    effect: "control",
    decision: mode === "prompt" ? "ASK" : known ? "ALLOW" : "UNKNOWN",
    constraints: [`mode=${mode}`],
    locator,
    comparisonValue: mode,
    added: mode === "prompt"
      ? { ...ALLOW_RESTRICTION, direction: "NEUTRAL", reason: "MCP tools require explicit approval" }
      : known
        ? expansion("AVP004", "MCP tools can run without an unconditional human prompt", "critical")
        : hold("AVP014", `unsupported MCP approval mode ${mode}`),
    removed: HOLD_UNKNOWN,
    compare: MCP_APPROVAL_RELATION,
  }));
}

function extractMcp(path: string, parsed: RecordValue): InternalAtom[] {
  const out: InternalAtom[] = [];
  const declaredContainers = (["mcpServers", "servers"] as const).filter((locator) => parsed[locator] !== undefined);
  const containersToNormalize = declaredContainers.length > 1 ? declaredContainers.slice(0, 1) : declaredContainers;
  if (declaredContainers.length > 1) {
    addOpaqueAuthoritySection(out, "mcp", path, declaredContainers[1], parsed[declaredContainers[1]], "the MCP document declares multiple server containers with ambiguous precedence");
  }
  for (const locator of containersToNormalize) {
    const value = parsed[locator];
    if (value === undefined) continue;
    if (!record(value)) {
      addOpaqueAuthoritySection(out, "mcp", path, locator, value, `the MCP ${locator} container has an unsupported shape`);
      continue;
    }
    addMcpServerAtoms(out, "mcp", path, value, locator);
  }
  for (const [locator, value] of Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))) {
    if (locator === "$schema" || locator === "mcpServers" || locator === "servers") continue;
    addOpaqueAuthoritySection(out, "mcp", path, locator, value, "the MCP document contains an authority-bearing root field that is not yet normalized");
  }
  return out;
}

function extractClaude(path: string, parsed: RecordValue): InternalAtom[] {
  const out: InternalAtom[] = [];
  const permissions = record(parsed.permissions) ?? {};
  addPermissionAtoms(out, "claude-code", path, permissions.allow, "ALLOW", "permissions");
  addPermissionAtoms(out, "claude-code", path, permissions.ask, "ASK", "permissions");
  addPermissionAtoms(out, "claude-code", path, permissions.deny, "DENY", "permissions");

  const mode = stringValue(permissions.defaultMode) ?? "default";
  const supportedModes = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
  out.push(atom({
    semanticKey: `claude-code\0${path}\0default-mode`,
    platform: "claude-code",
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "approval.default",
    resource: "unmatched-tool-calls",
    effect: "control",
    decision: mode === "dontAsk" || mode === "plan" ? "DENY" : mode === "default" ? "ASK" : supportedModes.has(mode) ? "ALLOW" : "UNKNOWN",
    constraints: [`mode=${mode}`],
    locator: "permissions.defaultMode",
    comparisonValue: mode,
    added: mode === "bypassPermissions"
      ? expansion("AVP004", "Claude Code bypassPermissions removes ordinary approval prompts", "critical")
      : supportedModes.has(mode) ? HOLD_UNKNOWN : hold("AVP014", `unsupported Claude Code permission mode ${mode}`),
    removed: HOLD_UNKNOWN,
    compare: CLAUDE_MODE_RELATION,
  }));

  const disableBypass = permissions.disableBypassPermissionsMode;
  if (disableBypass !== undefined) {
    const disabled = disableBypass === "disable" || disableBypass === true;
    out.push(atom({
      semanticKey: `claude-code\0${path}\0disable-bypass`,
      platform: "claude-code",
      sourcePath: path,
      kind: "control",
      subject: "agent",
      action: "approval.bypass",
      resource: "all-tools",
      effect: "control",
      decision: disabled ? "DENY" : "ALLOW",
      constraints: [`disabled=${disabled}`],
      locator: "permissions.disableBypassPermissionsMode",
      comparisonValue: disableBypass,
      added: disabled ? ALLOW_RESTRICTION : expansion("AVP004", "permission bypass remains available", "critical"),
      removed: disabled ? expansion("AVP004", "the control that disables permission bypass was removed", "critical") : ALLOW_RESTRICTION,
      compare: (before, after) => decisionRelation(before.decision, after.decision),
    }));
  }

  for (const directory of [...new Set([...stringList(permissions.additionalDirectories), ...stringList(parsed.additionalDirectories)])]) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0additional-directory\0${directory}`,
      platform: "claude-code",
      sourcePath: path,
      kind: "permission",
      subject: "agent",
      action: "filesystem.access",
      resource: directory.slice(0, 240),
      effect: "write",
      decision: "ALLOW",
      constraints: ["scope=additional-directory"],
      locator: "permissions.additionalDirectories",
      comparisonValue: directory,
      added: expansion("AVP007", "Claude Code can access an additional filesystem root", "critical"),
      removed: ALLOW_RESTRICTION,
    }));
  }

  const sandbox = record(parsed.sandbox);
  if (sandbox) {
    const enabled = boolValue(sandbox.enabled) ?? false;
    out.push(atom({
      semanticKey: `claude-code\0${path}\0sandbox-enabled`,
      platform: "claude-code",
      sourcePath: path,
      kind: "control",
      subject: "bash",
      action: "sandbox.enforce",
      resource: "process",
      effect: "control",
      decision: enabled ? "ALLOW" : "DENY",
      constraints: [`enabled=${enabled}`],
      locator: "sandbox.enabled",
      comparisonValue: enabled,
      added: enabled ? ALLOW_RESTRICTION : expansion("AVP005", "the declared Bash sandbox is disabled", "critical"),
      removed: enabled ? expansion("AVP005", "the declared Bash sandbox control was removed", "critical") : ALLOW_RESTRICTION,
      compare: (before, after) => before.decision === after.decision ? "equal" : after.decision === "DENY" ? "expansion" : "contraction",
    }));
    const failClosed = boolValue(sandbox.failIfUnavailable);
    if (failClosed !== undefined) {
      out.push(atom({
        semanticKey: `claude-code\0${path}\0sandbox-fail-closed`,
        platform: "claude-code",
        sourcePath: path,
        kind: "control",
        subject: "bash",
        action: "sandbox.fail-closed",
        resource: "startup",
        effect: "control",
        decision: failClosed ? "ALLOW" : "DENY",
        constraints: [`enabled=${failClosed}`],
        locator: "sandbox.failIfUnavailable",
        comparisonValue: failClosed,
        added: failClosed ? ALLOW_RESTRICTION : expansion("AVP005", "sandbox startup failure can fall back to unsandboxed execution", "critical"),
        removed: failClosed ? expansion("AVP005", "the sandbox fail-closed requirement was removed", "critical") : ALLOW_RESTRICTION,
        compare: (before, after) => before.decision === after.decision ? "equal" : after.decision === "DENY" ? "expansion" : "contraction",
      }));
    }

    addBooleanExpansionControl(
      out,
      path,
      "sandbox-auto-allow-bash",
      sandbox.autoAllowBashIfSandboxed,
      true,
      "approval.sandbox-auto",
      "bash",
      "sandbox.autoAllowBashIfSandboxed",
      "AVP004",
      "sandboxed Bash commands can run without an unconditional human prompt",
    );
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-allow-unsandboxed",
      sandbox.allowUnsandboxedCommands,
      true,
      "sandbox.escape",
      "dangerouslyDisableSandbox",
      "sandbox.allowUnsandboxedCommands",
      "AVP005",
      "commands can retry outside the declared sandbox",
    );
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-weaker-nested",
      sandbox.enableWeakerNestedSandbox,
      false,
      "sandbox.weaker-nested",
      "process-isolation",
      "sandbox.enableWeakerNestedSandbox",
      "AVP005",
      "the nested sandbox uses a weaker process-isolation boundary",
    );
    for (const command of stringList(sandbox.excludedCommands)) {
      out.push(atom({
        semanticKey: `claude-code\0${path}\0sandbox-excluded-command\0${command}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "permission",
        subject: "bash",
        action: "sandbox.exclude",
        resource: safeExecutable(command),
        effect: "execute",
        decision: "ALLOW",
        constraints: ["isolation=disabled"],
        locator: "sandbox.excludedCommands",
        comparisonValue: command,
        added: expansion("AVP005", "an additional command can run outside the declared sandbox", "critical"),
        removed: ALLOW_RESTRICTION,
        conditionalOn: `claude-code\0${path}\0sandbox-enabled`,
      }));
    }
    if (invalidStringList(sandbox.excludedCommands)) {
      addOpaqueAuthoritySection(out, "claude-code", path, "sandbox.excludedCommands", sandbox.excludedCommands, "sandbox.excludedCommands has an unsupported shape");
    }

    const network = record(sandbox.network);
    for (const host of stringList(network?.allowedDomains)) {
      out.push(atom({
        semanticKey: `claude-code\0${path}\0network\0${host}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "permission",
        subject: "bash",
        action: "network.connect",
        resource: host,
        effect: "network",
        decision: "ALLOW",
        constraints: ["scope=allowed-domain"],
        locator: "sandbox.network.allowedDomains",
        comparisonValue: host,
        added: expansion("AVP006", "sandboxed commands can reach an additional network destination", "critical"),
        removed: ALLOW_RESTRICTION,
        conditionalOn: `claude-code\0${path}\0sandbox-enabled`,
      }));
    }
    if (invalidStringList(network?.allowedDomains)) {
      addOpaqueAuthoritySection(out, "claude-code", path, "sandbox.network.allowedDomains", network?.allowedDomains, "sandbox.network.allowedDomains has an unsupported shape");
    }
    for (const socket of stringList(network?.allowUnixSockets)) {
      out.push(atom({
        semanticKey: `claude-code\0${path}\0unix-socket\0${socket}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "permission",
        subject: "bash",
        action: "network.unix-socket",
        resource: safeUnixSocket(socket),
        effect: "control",
        decision: "ALLOW",
        constraints: ["scope=allowed-socket"],
        locator: "sandbox.network.allowUnixSockets",
        comparisonValue: socket,
        added: expansion("AVP005", "sandboxed commands can access an additional host Unix socket", "critical"),
        removed: ALLOW_RESTRICTION,
        conditionalOn: `claude-code\0${path}\0sandbox-enabled`,
      }));
    }
    if (invalidStringList(network?.allowUnixSockets)) {
      addOpaqueAuthoritySection(out, "claude-code", path, "sandbox.network.allowUnixSockets", network?.allowUnixSockets, "sandbox.network.allowUnixSockets has an unsupported shape");
    }
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-allow-all-unix-sockets",
      network?.allowAllUnixSockets,
      false,
      "network.unix-socket-all",
      "host-sockets:*",
      "sandbox.network.allowAllUnixSockets",
      "AVP005",
      "sandboxed commands can access every host Unix socket",
    );
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-allow-local-binding",
      network?.allowLocalBinding,
      false,
      "network.bind-local",
      "localhost:*",
      "sandbox.network.allowLocalBinding",
      "AVP006",
      "sandboxed commands can bind to local network ports",
    );
    if (network) {
      for (const [locator, value] of Object.entries(network).sort(([a], [b]) => a.localeCompare(b))) {
        if (["allowedDomains", "allowUnixSockets", "allowAllUnixSockets", "allowLocalBinding"].includes(locator)) continue;
        addOpaqueAuthoritySection(out, "claude-code", path, `sandbox.network.${locator}`, value, `Claude Code sandbox.network.${locator} is not yet ordered by the authority lattice`);
      }
    } else if (sandbox.network !== undefined) {
      addOpaqueAuthoritySection(out, "claude-code", path, "sandbox.network", sandbox.network, "sandbox.network has an unsupported shape");
    }
    for (const [locator, value] of Object.entries(sandbox).sort(([a], [b]) => a.localeCompare(b))) {
      if ([
        "allowUnsandboxedCommands", "autoAllowBashIfSandboxed", "enabled", "enableWeakerNestedSandbox",
        "excludedCommands", "failIfUnavailable", "network",
      ].includes(locator)) continue;
      addOpaqueAuthoritySection(out, "claude-code", path, `sandbox.${locator}`, value, `Claude Code sandbox.${locator} is not yet ordered by the authority lattice`);
    }
  } else if (parsed.sandbox !== undefined) {
    addOpaqueAuthoritySection(out, "claude-code", path, "sandbox", parsed.sandbox, "the Claude Code sandbox container has an unsupported shape");
  }

  const allMcp = boolValue(parsed.enableAllProjectMcpServers);
  if (allMcp !== undefined) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0all-project-mcp`,
      platform: "claude-code",
      sourcePath: path,
      kind: "control",
      subject: "agent",
      action: "mcp.auto-enable",
      resource: "project-servers:*",
      effect: "execute",
      decision: allMcp ? "ALLOW" : "DENY",
      constraints: [`enabled=${allMcp}`],
      locator: "enableAllProjectMcpServers",
      comparisonValue: allMcp,
      added: allMcp ? expansion("AVP003", "all project MCP servers are automatically approved", "critical") : ALLOW_RESTRICTION,
      removed: allMcp ? ALLOW_RESTRICTION : expansion("AVP003", "the explicit block on automatic project MCP approval was removed", "critical"),
      compare: (before, after) => decisionRelation(before.decision, after.decision),
    }));
  }
  for (const name of stringList(parsed.enabledMcpjsonServers)) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0mcp-server\0${name}`,
      platform: "claude-code",
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.enable",
      resource: name,
      effect: "unknown",
      decision: "ALLOW",
      constraints: [],
      locator: "enabledMcpjsonServers",
      comparisonValue: true,
      added: expansion("AVP003", "an MCP server is newly approved for Claude Code", "critical"),
      removed: ALLOW_RESTRICTION,
    }));
  }
  for (const name of stringList(parsed.disabledMcpjsonServers)) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0mcp-server\0${name}`,
      platform: "claude-code",
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.enable",
      resource: name,
      effect: "unknown",
      decision: "DENY",
      constraints: [],
      locator: "disabledMcpjsonServers",
      comparisonValue: false,
      added: ALLOW_RESTRICTION,
      removed: expansion("AVP003", "an MCP server was removed from Claude Code's deny list", "critical"),
      compare: (before, after) => decisionRelation(before.decision, after.decision),
    }));
  }

  const plugins = record(parsed.enabledPlugins);
  if (plugins) {
    for (const [name, rawEnabled] of Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b))) {
      const enabled = boolValue(rawEnabled);
      if (enabled === undefined) continue;
      out.push(atom({
        semanticKey: `claude-code\0${path}\0plugin\0${name}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "capability",
        subject: "agent",
        action: "plugin.enable",
        resource: name,
        effect: "unknown",
        decision: enabled ? "ALLOW" : "DENY",
        constraints: [`enabled=${enabled}`],
        locator: `enabledPlugins.${name}`,
        comparisonValue: enabled,
        added: enabled
          ? expansion("AVP015", "a plugin can add skills, agents, hooks, MCP servers, or executables", "critical")
          : ALLOW_RESTRICTION,
        removed: enabled
          ? ALLOW_RESTRICTION
          : expansion("AVP015", "an explicit plugin disable was removed", "critical"),
        compare: (before, after) => decisionRelation(before.decision, after.decision),
      }));
    }
  }

  addEnvironmentAtoms(out, "claude-code", path, "session", parsed.env, "env");
  addMcpServerAtoms(out, "claude-code", path, parsed.mcpServers, "mcpServers");
  addClaudeHooks(out, path, parsed.hooks);
  addModelAtom(out, "claude-code", path, parsed.model, "model");
  for (const locator of ["extraKnownMarketplaces", "allowManagedPermissionRulesOnly", "allowManagedHooksOnly", "apiKeyHelper"]) {
    addOpaqueAuthoritySection(out, "claude-code", path, locator, parsed[locator], `Claude Code ${locator} can alter executable or managed authority and is not yet fully normalized`);
  }
  return out;
}

function addClaudeHooks(out: InternalAtom[], path: string, rawHooks: unknown): void {
  const hooks = record(rawHooks);
  if (!hooks) return;
  for (const [event, rawEntries] of Object.entries(hooks).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Array.isArray(rawEntries)) continue;
    rawEntries.forEach((rawEntry, index) => {
      const entry = record(rawEntry);
      if (!entry) return;
      const handlers = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      handlers.forEach((rawHandler, handlerIndex) => {
        const handler = record(rawHandler);
        if (!handler) return;
        const type = stringValue(handler.type) ?? "command";
        const command = stringValue(handler.command);
        const semanticKey = `claude-code\0${path}\0hook\0${event}\0${index}\0${handlerIndex}`;
        const securityControl = event === "PreToolUse" || event === "PermissionRequest";
        out.push(atom({
          semanticKey,
          platform: "claude-code",
          sourcePath: path,
          kind: "control",
          subject: event,
          action: "hook.execute",
          resource: command ? safeExecutable(command) : type,
          effect: command ? "execute" : "control",
          decision: "ALLOW",
          constraints: [`type=${type}`, ...(stringValue(entry.matcher) ? ["matcher=configured"] : [])],
          locator: `hooks.${event}[${index}].hooks[${handlerIndex}]`,
          comparisonValue: { matcher: entry.matcher, handler },
          added: expansion("AVP011", "a repository-controlled hook can execute or alter tool authorization", securityControl ? "critical" : "high"),
          removed: securityControl
            ? expansion("AVP011", "a pre-execution authorization hook was removed", "critical")
            : ALLOW_RESTRICTION,
          compare: () => "incomparable",
        }));
      });
    });
  }
}

function addModelAtom(out: InternalAtom[], platform: AuthorityPlatform, path: string, rawModel: unknown, locator: string): void {
  const model = stringValue(rawModel);
  if (!model) return;
  const mutable = /(?:^|[-_/.:])(latest|default|auto|current)(?:$|[-_/.:])/i.test(model);
  out.push(atom({
    semanticKey: `${platform}\0${path}\0model`,
    platform,
    sourcePath: path,
    kind: "model",
    subject: "agent",
    action: "model.select",
    resource: model.slice(0, 200),
    effect: "control",
    decision: mutable ? "UNKNOWN" : "ALLOW",
    constraints: [`mutable=${mutable}`],
    locator,
    comparisonValue: model,
    added: mutable
      ? hold("AVP012", "the model identifier appears mutable and cannot be bound to one implementation")
      : { ...ALLOW_RESTRICTION, direction: "NEUTRAL", reason: "a model identifier was declared" },
    removed: HOLD_UNKNOWN,
    compare: (before, after) => {
      const oldMutable = before.constraints.includes("mutable=true");
      const newMutable = after.constraints.includes("mutable=true");
      if (!oldMutable && newMutable) return "expansion";
      if (oldMutable && !newMutable) return "contraction";
      return "incomparable";
    },
  }));
}

function extractCodex(path: string, parsed: RecordValue): InternalAtom[] {
  const out: InternalAtom[] = [];
  const sandboxMode = stringValue(parsed.sandbox_mode) ?? "read-only";
  out.push(atom({
    semanticKey: `codex\0${path}\0sandbox-mode`,
    platform: "codex",
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "sandbox.mode",
    resource: "host-filesystem",
    effect: "write",
    decision: sandboxMode === "read-only" ? "DENY" : sandboxMode === "workspace-write" || sandboxMode === "danger-full-access" ? "ALLOW" : "UNKNOWN",
    constraints: [`mode=${sandboxMode}`],
    locator: "sandbox_mode",
    comparisonValue: sandboxMode,
    added: sandboxMode === "read-only"
      ? ALLOW_RESTRICTION
      : sandboxMode === "workspace-write"
        ? expansion("AVP005", "Codex can write inside the repository")
        : sandboxMode === "danger-full-access"
          ? expansion("AVP005", "Codex can write outside the repository without OS sandbox enforcement", "critical")
          : hold("AVP014", `unsupported Codex sandbox mode ${sandboxMode}`),
    removed: HOLD_UNKNOWN,
    compare: orderedRelation(["read-only", "workspace-write", "danger-full-access"]),
  }));

  const workspace = record(parsed.sandbox_workspace_write) ?? {};
  const network = boolValue(workspace.network_access) ?? false;
  out.push(atom({
    semanticKey: `codex\0${path}\0network-access`,
    platform: "codex",
    sourcePath: path,
    kind: "permission",
    subject: "agent",
    action: "network.connect",
    resource: "*",
    effect: "network",
    decision: network ? "ALLOW" : "DENY",
    constraints: [`enabled=${network}`],
    locator: "sandbox_workspace_write.network_access",
    comparisonValue: network,
    added: network ? expansion("AVP006", "Codex can make outbound network connections", "critical") : ALLOW_RESTRICTION,
    removed: network ? ALLOW_RESTRICTION : expansion("AVP006", "the explicit network restriction was removed", "critical"),
    compare: (before, after) => decisionRelation(before.decision, after.decision),
  }));
  for (const root of stringList(workspace.writable_roots)) {
    out.push(atom({
      semanticKey: `codex\0${path}\0writable-root\0${root}`,
      platform: "codex",
      sourcePath: path,
      kind: "permission",
      subject: "agent",
      action: "filesystem.write",
      resource: root.slice(0, 240),
      effect: "write",
      decision: "ALLOW",
      constraints: ["scope=additional-root"],
      locator: "sandbox_workspace_write.writable_roots",
      comparisonValue: root,
      added: expansion("AVP007", "Codex can write to an additional filesystem root", "critical"),
      removed: ALLOW_RESTRICTION,
    }));
  }

  const approval = parsed.approval_policy;
  const approvalMode = typeof approval === "string" ? approval : record(approval)?.granular ? "granular" : "unknown";
  out.push(atom({
    semanticKey: `codex\0${path}\0approval-policy`,
    platform: "codex",
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "approval.policy",
    resource: "tool-escalation",
    effect: "control",
    decision: approvalMode === "untrusted" || approvalMode === "on-request" || approvalMode === "granular" ? "ASK" : approvalMode === "never" ? "DENY" : "UNKNOWN",
    constraints: [`mode=${approvalMode}`],
    locator: "approval_policy",
    comparisonValue: approval,
    added: approvalMode === "never"
      ? expansion("AVP004", "approval_policy=never suppresses interactive escalation", "critical")
      : approvalMode === "unknown" ? HOLD_UNKNOWN : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
    removed: HOLD_UNKNOWN,
    compare: (before, after) => {
      if (before.comparisonToken === after.comparisonToken) return "equal";
      if (before.decision === "UNKNOWN" || after.decision === "UNKNOWN") return "incomparable";
      if (before.decision === "ASK" && after.decision === "DENY") return "expansion";
      if (before.decision === "DENY" && after.decision === "ASK") return "contraction";
      return "incomparable";
    },
  }));

  const reviewer = stringValue(parsed.approvals_reviewer) ?? "user";
  out.push(atom({
    semanticKey: `codex\0${path}\0approval-reviewer`,
    platform: "codex",
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "approval.review",
    resource: "tool-escalation",
    effect: "control",
    decision: reviewer === "user" ? "ASK" : reviewer === "auto_review" || reviewer === "guardian_subagent" ? "ALLOW" : "UNKNOWN",
    constraints: [`mode=${reviewer}`],
    locator: "approvals_reviewer",
    comparisonValue: reviewer,
    added: reviewer === "user"
      ? { ...ALLOW_RESTRICTION, direction: "NEUTRAL" }
      : reviewer === "auto_review" || reviewer === "guardian_subagent"
        ? expansion("AVP004", "eligible approval prompts are delegated to an automated reviewer", "critical")
        : HOLD_UNKNOWN,
    removed: HOLD_UNKNOWN,
    compare: (before, after) => decisionRelation(before.decision, after.decision),
  }));

  const environment = record(parsed.shell_environment_policy);
  if (environment) {
    const inherit = stringValue(environment.inherit) ?? "core";
    out.push(atom({
      semanticKey: `codex\0${path}\0environment-inherit`,
      platform: "codex",
      sourcePath: path,
      kind: "credential",
      subject: "shell",
      action: "environment.inherit",
      resource: "process-environment",
      effect: "credential",
      decision: inherit === "none" ? "DENY" : inherit === "core" || inherit === "all" ? "ALLOW" : "UNKNOWN",
      constraints: [`mode=${inherit}`],
      locator: "shell_environment_policy.inherit",
      comparisonValue: inherit,
      added: inherit === "all"
        ? expansion("AVP008", "Codex inherits the full parent process environment", "critical")
        : inherit === "core" ? hold("AVP008", "Codex inherits a core environment set") : ALLOW_RESTRICTION,
      removed: HOLD_UNKNOWN,
      compare: orderedRelation(["none", "core", "all"]),
    }));
    const keepSecrets = boolValue(environment.ignore_default_excludes);
    if (keepSecrets !== undefined) {
      out.push(atom({
        semanticKey: `codex\0${path}\0environment-secret-excludes`,
        platform: "codex",
        sourcePath: path,
        kind: "credential",
        subject: "shell",
        action: "environment.keep-secret-names",
        resource: "*KEY,*SECRET,*TOKEN",
        effect: "credential",
        decision: keepSecrets ? "ALLOW" : "DENY",
        constraints: [`enabled=${keepSecrets}`],
        locator: "shell_environment_policy.ignore_default_excludes",
        comparisonValue: keepSecrets,
        added: keepSecrets ? expansion("AVP008", "automatic secret-name exclusions are disabled", "critical") : ALLOW_RESTRICTION,
        removed: keepSecrets ? ALLOW_RESTRICTION : expansion("AVP008", "automatic secret-name exclusions are no longer enforced", "critical"),
        compare: (before, after) => decisionRelation(before.decision, after.decision),
      }));
    }
    addEnvironmentAtoms(out, "codex", path, "shell", environment.set, "shell_environment_policy.set");
  }

  addMcpServerAtoms(out, "codex", path, parsed.mcp_servers, "mcp_servers");
  addModelAtom(out, "codex", path, parsed.model, "model");
  for (const locator of ["agents", "apps", "auto_review", "computer_use", "features", "plugins", "skills", "tools", "web_search"]) {
    addOpaqueAuthoritySection(out, "codex", path, locator, parsed[locator], `Codex ${locator} can alter agent or tool authority and is not yet fully normalized`);
  }
  return out;
}

function profileDigest(profile: Omit<AuthorityProfile, "sha256">): string {
  return sha256(canonical(profile));
}

export function discoverAuthorityProfile(repo: string, ref: string): AuthorityProfile {
  const internal: InternalProfile = {
    schemaVersion: "agent-vigil-authority-profile/v1",
    scope: "repository-declared",
    ref,
    sources: [],
    atoms: [],
    gaps: [],
  };
  for (const path of relevantFiles(repo, ref)) {
    const platform = sourcePlatform(path);
    let raw: string;
    try { raw = readGitFile(repo, ref, path); }
    catch (error) {
      internal.gaps.push({ platform, sourcePath: path, locator: path, reason: (error as Error).message });
      continue;
    }
    const format = path.endsWith(".toml") ? "toml" : "json";
    internal.sources.push({ platform, path, format, sha256: sha256(raw) });
    let parsed: unknown;
    try { parsed = parseConfig(raw, format); }
    catch {
      internal.gaps.push({ platform, sourcePath: path, locator: path, reason: `${format.toUpperCase()} parse failed; inspect the committed source locally` });
      continue;
    }
    const value = record(parsed);
    if (!value) {
      internal.gaps.push({ platform, sourcePath: path, locator: path, reason: "configuration root is not an object" });
      continue;
    }
    try {
      internal.atoms.push(...(platform === "claude-code" ? extractClaude(path, value) : platform === "codex" ? extractCodex(path, value) : extractMcp(path, value)));
    } catch {
      internal.gaps.push({ platform, sourcePath: path, locator: path, reason: "authority extraction failed; inspect the committed source locally" });
    }
  }
  internal.sources.sort((a, b) => a.path.localeCompare(b.path));
  internal.atoms.sort((a, b) => a.semanticKey.localeCompare(b.semanticKey));
  internal.gaps.sort((a, b) => `${a.sourcePath}:${a.locator}`.localeCompare(`${b.sourcePath}:${b.locator}`));
  const safe: Omit<AuthorityProfile, "sha256"> = {
    ...internal,
    atoms: internal.atoms.map(publicAtom),
  };
  return { ...safe, sha256: profileDigest(safe) };
}

function discoverInternal(repo: string, ref: string): InternalProfile {
  const safe = discoverAuthorityProfile(repo, ref);
  // Re-extract to retain comparison-only tokens. These tokens never cross the
  // public API or JSON boundary.
  const internal: InternalProfile = {
    schemaVersion: safe.schemaVersion,
    scope: safe.scope,
    ref: safe.ref,
    sources: [...safe.sources],
    atoms: [],
    gaps: [...safe.gaps],
  };
  for (const source of safe.sources) {
    try {
      const raw = readGitFile(repo, ref, source.path);
      const value = record(parseConfig(raw, source.format));
      if (!value) continue;
      internal.atoms.push(...(source.platform === "claude-code" ? extractClaude(source.path, value) : source.platform === "codex" ? extractCodex(source.path, value) : extractMcp(source.path, value)));
    } catch {
      // The public discovery pass already recorded the fail-closed gap.
    }
  }
  internal.atoms.sort((a, b) => a.semanticKey.localeCompare(b.semanticKey));
  return internal;
}

function dispositionForRelation(relation: Relation, before: InternalAtom, after: InternalAtom): RuleDisposition {
  if (relation === "expansion") {
    if (after.kind === "model") return hold("AVP012", "the model binding became less deterministic");
    if (after.action === "mcp.connect" || after.action === "mcp.launch") return expansion("AVP002", "the MCP connection or launch identity became more permissive", "critical");
    if (after.action === "mcp.auto-enable" || after.action === "mcp.enable") return expansion("AVP003", "the MCP enablement boundary became more permissive", "critical");
    if (after.action === "mcp.tool") return expansion("AVP013", "the MCP tool selection became more permissive", "critical");
    if (after.action === "plugin.enable") return expansion("AVP015", "the plugin enablement boundary became more permissive", "critical");
    if (after.action === "hook.execute") return expansion("AVP011", "the repository-controlled hook changed authority or execution scope", "critical");
    if (after.action === "approval.mode" || after.action.startsWith("approval.")) return expansion("AVP004", "the approval boundary became less restrictive", "critical");
    if (after.action.startsWith("sandbox.")) return expansion("AVP005", "the sandbox boundary became less restrictive", "critical");
    if (after.action === "network.unix-socket-all") return expansion("AVP005", "the sandbox can access every host Unix socket", "critical");
    if (after.action === "network.bind-local") return expansion("AVP006", "the network boundary became less restrictive", "critical");
    if (after.effect === "network") return expansion("AVP006", "the network boundary became less restrictive", "critical");
    if (after.effect === "credential") return expansion("AVP008", "the credential boundary became less restrictive", "critical");
    if (after.action === "filesystem.access" || after.action === "filesystem.write") return expansion("AVP007", "the filesystem boundary became less restrictive", "critical");
    return expansion("AVP009", "the declared authority became more permissive");
  }
  if (relation === "contraction") return ALLOW_RESTRICTION;
  if (relation === "incomparable") return hold("AVP014", `the change from ${before.locator} to ${after.locator} is not ordered by the supported authority lattice`);
  return { ...ALLOW_RESTRICTION, direction: "NEUTRAL", reason: "the semantic authority is unchanged" };
}

function deltaSummary(change: AuthorityDelta["change"], atomValue: AuthorityAtom): string {
  const prefix = change === "ADDED" ? "added" : change === "REMOVED" ? "removed" : "changed";
  return `${prefix} ${atomValue.platform} ${atomValue.action} for ${atomValue.resource}`;
}

function makeDelta(change: AuthorityDelta["change"], disposition: RuleDisposition, before?: InternalAtom, after?: InternalAtom): AuthorityDelta {
  const representative = after ?? before!;
  const beforeSafe = before ? publicAtom(before) : undefined;
  const afterSafe = after ? publicAtom(after) : undefined;
  const identity = canonical({ change, key: representative.semanticKey, before: beforeSafe, after: afterSafe, ruleId: disposition.ruleId });
  const identitySha256 = sha256(identity);
  return {
    id: `delta:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
    ruleId: disposition.ruleId,
    change,
    direction: disposition.direction,
    disposition: disposition.disposition,
    severity: disposition.severity,
    summary: deltaSummary(change, representative),
    reason: disposition.reason,
    approvalKey: `authority:${disposition.ruleId}:${representative.platform}:${representative.action}:${representative.resource}@${identitySha256}`,
    ...(beforeSafe ? { before: beforeSafe } : {}),
    ...(afterSafe ? { after: afterSafe } : {}),
  };
}

function applyAuthorityPlanPolicy(delta: AuthorityDelta, policy: AuthorityPlanPolicy): AuthorityDelta {
  const exactApproval = policy.approvedAdditions.includes(delta.approvalKey);
  const values = [delta.before, delta.after];
  const explicitUnknown = values.some((value) =>
    value?.action === "authority.opaque" || (value?.decision === "UNKNOWN" && value.kind !== "model")
  );
  const incidentalUnknown = delta.ruleId === "AVP001"
    && delta.change !== "CHANGED"
    && values.every((value) => !value || value.kind !== "model");
  const unknownSetting = explicitUnknown || incidentalUnknown;
  const unknownApproval = delta.disposition === "HOLD" && policy.allowUnknownChanges && unknownSetting;
  if (delta.disposition === "ALLOW" || (!exactApproval && !unknownApproval)) return delta;
  return {
    ...delta,
    disposition: "ALLOW",
    approvedByPolicy: true,
    reason: `${delta.reason}; approved by the trusted base revision policy`,
  };
}

export function buildAuthorityPlan(
  repo: string,
  base: string,
  head: string,
  _vigilVersion?: string,
  policyPath?: string,
): AuthorityPlan {
  const baseSha = git(repo, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const headSha = git(repo, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
  const policy = loadAuthorityPlanPolicy(repo, baseSha, policyPath);
  const before = discoverInternal(repo, baseSha);
  const after = discoverInternal(repo, headSha);
  const beforeByKey = new Map(before.atoms.map((item) => [item.semanticKey, item]));
  const afterByKey = new Map(after.atoms.map((item) => [item.semanticKey, item]));
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const removedMcpServers = new Set(
    [...beforeByKey.entries()]
      .filter(([key, item]) => key.endsWith("\0enabled") && item.action === "mcp.connect" && item.decision === "ALLOW" && !afterByKey.has(key))
      .map(([key]) => key.slice(0, -"\0enabled".length)),
  );
  const rawDeltas: AuthorityDelta[] = [];
  const conditionActiveAcrossRevision = (before?: InternalAtom, after?: InternalAtom): boolean => {
    const conditionalOn = after?.conditionalOn ?? before?.conditionalOn;
    if (!conditionalOn) return true;
    return beforeByKey.get(conditionalOn)?.decision === "ALLOW"
      && afterByKey.get(conditionalOn)?.decision === "ALLOW";
  };
  for (const key of keys) {
    const oldAtom = beforeByKey.get(key);
    const newAtom = afterByKey.get(key);
    if (!oldAtom && newAtom) {
      rawDeltas.push(makeDelta(
        "ADDED",
        conditionActiveAcrossRevision(undefined, newAtom) ? newAtom.added : ALLOW_RESTRICTION,
        undefined,
        newAtom,
      ));
    }
    else if (oldAtom && !newAtom) {
      const removedWithServer = [...removedMcpServers].some((prefix) => key.startsWith(`${prefix}\0`));
      rawDeltas.push(makeDelta(
        "REMOVED",
        removedWithServer || !conditionActiveAcrossRevision(oldAtom) ? ALLOW_RESTRICTION : oldAtom.removed,
        oldAtom,
      ));
    }
    else if (oldAtom && newAtom && oldAtom.comparisonToken !== newAtom.comparisonToken) {
      const relation = oldAtom.compare ? oldAtom.compare(oldAtom, newAtom) : newAtom.compare ? newAtom.compare(oldAtom, newAtom) : "incomparable";
      rawDeltas.push(makeDelta(
        "CHANGED",
        conditionActiveAcrossRevision(oldAtom, newAtom)
          ? dispositionForRelation(relation, oldAtom, newAtom)
          : ALLOW_RESTRICTION,
        oldAtom,
        newAtom,
      ));
    }
  }
  const deltas = rawDeltas.map((delta) => applyAuthorityPlanPolicy(delta, policy.value));
  const gaps = [...before.gaps, ...after.gaps]
    .filter((gap, index, all) => all.findIndex((item) => canonical(item) === canonical(gap)) === index)
    .sort((a, b) => `${a.sourcePath}:${a.locator}`.localeCompare(`${b.sourcePath}:${b.locator}`));
  const blocking = deltas.filter((item) => item.disposition === "BLOCK").length;
  const uncertainties = rawDeltas.filter((item) => item.disposition === "HOLD").length + gaps.length;
  const holds = deltas.filter((item) => item.disposition === "HOLD").length + (policy.value.allowUnknownChanges ? 0 : gaps.length);
  const status: PlanStatus = blocking ? "BLOCK" : holds ? "HOLD" : "PASS";
  const baseProfile: Omit<AuthorityProfile, "sha256"> = {
    schemaVersion: before.schemaVersion,
    scope: before.scope,
    ref: before.ref,
    sources: before.sources,
    atoms: before.atoms.map(publicAtom),
    gaps: before.gaps,
  };
  const headProfile: Omit<AuthorityProfile, "sha256"> = {
    schemaVersion: after.schemaVersion,
    scope: after.scope,
    ref: after.ref,
    sources: after.sources,
    atoms: after.atoms.map(publicAtom),
    gaps: after.gaps,
  };
  const payload = {
    schemaVersion: "agent-vigil-authority-plan/v1" as const,
    scope: "repository-declared" as const,
    base: baseSha,
    head: headSha,
    status,
    policy: {
      source: policy.source,
      sha256: policy.sha256,
      allowUnknownChanges: policy.value.allowUnknownChanges,
    },
    summary: {
      sources: new Set([...before.sources, ...after.sources].map((source) => source.path)).size,
      atomsBefore: before.atoms.length,
      atomsAfter: after.atoms.length,
      changes: deltas.length,
      expansions: deltas.filter((item) => item.direction === "EXPANSION").length,
      contractions: deltas.filter((item) => item.direction === "CONTRACTION").length,
      incomparable: deltas.filter((item) => item.direction === "INCOMPARABLE").length,
      blocking,
      holds,
      uncertainties,
      approved: deltas.filter((item) => item.approvedByPolicy).length,
    },
    deltas,
    gaps,
    baseProfileSha256: profileDigest(baseProfile),
    headProfileSha256: profileDigest(headProfile),
    limitations: [
      "This plan covers authority declared in supported files committed to the selected Git revisions.",
      "Machine, user, managed, runtime, credential-provider, and live MCP tool state are not claimed unless separately captured.",
      "MCP server additions block because static launch configuration does not prove the server's complete live tool surface or behavior.",
      "Recognized secret-bearing values and sensitive permission scopes are omitted; repository-controlled names and labels can still be sensitive.",
    ],
  };
  return { ...payload, planSha256: sha256(canonical(payload)) };
}

function marker(delta: AuthorityDelta): string {
  if (delta.change === "ADDED") return "+";
  if (delta.change === "REMOVED") return "-";
  return "~";
}

export function renderAuthorityPlanText(plan: AuthorityPlan): string {
  const lines = [
    `Agent authority plan: ${plan.status}`,
    `Scope: ${plan.scope}`,
    `Range: ${plan.base}..${plan.head}`,
    `Policy: ${plan.policy.source} (${plan.policy.sha256})`,
    `Digest: ${plan.planSha256}`,
    "",
  ];
  if (!plan.deltas.length) lines.push("  No semantic authority changes detected in supported repository configuration.", "");
  for (const delta of plan.deltas) {
    lines.push(`  ${marker(delta)} [${delta.disposition}] ${delta.summary}`);
    lines.push(`      ${delta.ruleId}: ${delta.reason}`);
  }
  for (const gap of plan.gaps) {
    const disposition = plan.policy.allowUnknownChanges ? "ALLOW" : "HOLD";
    lines.push(`  ? [${disposition}] ${gap.platform} ${gap.sourcePath}:${gap.locator}`);
    lines.push(`      AVP001: ${gap.reason}${plan.policy.allowUnknownChanges ? "; allowed by the trusted base revision policy" : ""}`);
  }
  lines.push(
    "",
    `  ${plan.summary.changes} change(s) | ${plan.summary.expansions} expansion(s) | ${plan.summary.blocking} blocking | ${plan.summary.holds} hold(s) | ${plan.summary.approved} approved`,
    "  Boundary: repository-declared authority only; recognized secret-bearing values are omitted.",
  );
  return lines.join("\n");
}

export function renderAuthorityPlanMarkdown(plan: AuthorityPlan): string {
  const rows = plan.deltas.map((delta) =>
    `| ${delta.disposition} | \`${delta.ruleId}\` | ${delta.change} | ${delta.direction} | ${delta.summary.replace(/\|/g, "\\|")} | ${delta.reason.replace(/\|/g, "\\|")} |`,
  );
  const gaps = plan.gaps.map((gap) =>
    `| ${plan.policy.allowUnknownChanges ? "ALLOW" : "HOLD"} | \`AVP001\` | GAP | INCOMPARABLE | ${gap.platform} ${gap.sourcePath}:${gap.locator} | ${(gap.reason + (plan.policy.allowUnknownChanges ? "; allowed by the trusted base revision policy" : "")).replace(/\|/g, "\\|")} |`,
  );
  return [
    `# Agent authority plan: ${plan.status}`,
    "",
    `**Scope:** \`${plan.scope}\`  `,
    `**Range:** \`${plan.base}..${plan.head}\`  `,
    `**Policy:** \`${plan.policy.source}\` (\`${plan.policy.sha256}\`)  `,
    `**Digest:** \`${plan.planSha256}\``,
    "",
    "| Decision | Rule | Change | Direction | Authority | Reason |",
    "|---|---|---|---|---|---|",
    ...(rows.length || gaps.length ? [...rows, ...gaps] : ["| PASS | `AVP000` | NONE | NEUTRAL | No supported semantic authority change | Supported repository configuration is unchanged |"]),
    "",
    `${plan.summary.changes} change(s) | ${plan.summary.expansions} expansion(s) | ${plan.summary.blocking} blocking | ${plan.summary.holds} hold(s) | ${plan.summary.approved} approved`,
    "",
    "> This result covers repository-declared authority only. It does not claim machine, managed-policy, credential-provider, or live MCP state. Recognized secret-bearing values are omitted.",
    "",
  ].join("\n");
}

export const renderAuthorityPlan = renderAuthorityPlanText;

function receiptRuleKind(delta: AuthorityDelta): string {
  const atom = delta.after ?? delta.before;
  if (!atom) return "change";
  if (atom.action === "mcp.connect" || atom.action === "mcp.launch") return "server";
  if (atom.action === "mcp.tool" || atom.action.startsWith("permission.")) return "tool";
  if (atom.action.startsWith("approval.")) return "approval";
  if (atom.action.startsWith("sandbox.")) return "sandbox";
  if (atom.action === "hook.execute") return "hook";
  if (atom.kind === "model") return "model";
  if (atom.effect === "network") return "network";
  if (atom.effect === "credential") return "secret";
  if (atom.action.startsWith("filesystem.") || atom.resource.startsWith("unix:")) return "filesystem";
  return atom.kind;
}

function receiptSubject(delta: AuthorityDelta, kind: string): string {
  const atom = delta.after ?? delta.before;
  if (!atom) return delta.summary;
  if (kind === "server") {
    const name = atom.action === "mcp.connect" ? atom.resource.split(":", 1)[0] : atom.subject;
    return `server: mcp:${name}`;
  }
  return `${kind}: ${atom.resource}`;
}

export function authorityPlanChecks(plan: AuthorityPlan): { results: CheckResult[]; advisories: CheckResult[] } {
  const results: CheckResult[] = [{
    claim: {
      kind: "authority_scope",
      subject: "agent authority configuration",
      quote: "the exact change does not expand unapproved agent authority",
    },
    verdict: plan.status === "BLOCK" ? "contradicted" : plan.status === "HOLD" ? "unverifiable" : "verified",
    evidence: `${plan.summary.changes} semantic change(s), ${plan.summary.blocking} blocking, ${plan.summary.holds} held, ${plan.summary.approved} approved; plan ${plan.planSha256}`,
    ruleId: "authority-plan",
    contributesToPass: false,
    ...(plan.status === "HOLD" ? { blocksPass: true } : {}),
  }];
  const advisories: CheckResult[] = [];

  for (const delta of plan.deltas) {
    const kind = receiptRuleKind(delta);
    const check: CheckResult = {
      claim: {
        kind: "authority_scope",
        subject: receiptSubject(delta, kind),
        quote: "semantic agent authority delta",
      },
      verdict: delta.disposition === "BLOCK" ? "contradicted" : delta.disposition === "HOLD" ? "unverifiable" : "verified",
      evidence: `${delta.ruleId}: ${delta.reason}; ${delta.approvalKey}`,
      ruleId: `authority-${kind}`,
      contributesToPass: false,
      ...(delta.disposition === "HOLD" ? { blocksPass: true } : {}),
    };
    if (delta.disposition === "ALLOW") advisories.push(check);
    else results.push(check);

    const atom = delta.after ?? delta.before;
    if (kind !== "network" && atom?.effect === "network") {
      const networkCheck: CheckResult = {
        ...check,
        claim: { ...check.claim, subject: `network: ${atom.resource}` },
        ruleId: "authority-network",
      };
      if (delta.disposition === "ALLOW") advisories.push(networkCheck);
      else results.push(networkCheck);
    }
  }

  for (const gap of plan.gaps) {
    const check: CheckResult = {
      claim: {
        kind: "authority_scope",
        subject: `unrecognized setting: ${gap.sourcePath}:${gap.locator}`,
        quote: "changed authority configuration is fully understood",
      },
      verdict: "unverifiable",
      evidence: gap.reason,
      ruleId: "avp001",
      contributesToPass: false,
      ...(!plan.policy.allowUnknownChanges ? { blocksPass: true } : {}),
    };
    if (plan.policy.allowUnknownChanges) advisories.push(check);
    else results.push(check);
  }
  return { results, advisories };
}
