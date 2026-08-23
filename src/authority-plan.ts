import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { canonical, type CheckResult } from "./report.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export const AUTHORITY_CONFIG_PATHS = [
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/config.toml",
] as const;

export type AuthorityChangeKind =
  | "server"
  | "tool"
  | "network"
  | "filesystem"
  | "secret"
  | "model"
  | "approval"
  | "sandbox"
  | "hook";

export type AuthorityChange = {
  kind: AuthorityChangeKind;
  subject: string;
  before?: string;
  after?: string;
  effect: "expanded" | "reduced" | "changed";
  blocking: boolean;
  reason: string;
  source: string;
  approvalKey: string;
};

export type AuthorityPlanPolicy = {
  schemaVersion: 1;
  approvedAdditions: string[];
  allowUnknownChanges: boolean;
};

export type AuthorityPlanReport = {
  schemaVersion: "1";
  vigilVersion: string;
  status: "PASS" | "FAIL" | "INCONCLUSIVE";
  base: string;
  head: string;
  generatedAt: string;
  receiptHash: string;
  policy: { source: string; sha256: string };
  inspected: string[];
  changes: AuthorityChange[];
  uncertainties: Array<{ source: string; setting: string; reason: string }>;
  summary: { changes: number; blocking: number; reduced: number; uncertain: number };
  reproduction: string;
};

type Entry = { kind: AuthorityChangeKind; subject: string; value: string; fingerprint: string; source: string };
type Snapshot = { entries: Map<string, Entry>; unknown: Map<string, string>; inspected: string[] };

const MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_POLICY: AuthorityPlanPolicy = { schemaVersion: 1, approvedAdditions: [], allowUnknownChanges: false };

function git(repo: string, args: string[], maxBuffer = MAX_CONFIG_BYTES + 1): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer });
}

function gitOptional(repo: string, args: string[], maxBuffer = MAX_CONFIG_BYTES + 1): string | undefined {
  try { return git(repo, args, maxBuffer); } catch { return undefined; }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function safeExecutable(command: unknown): string {
  if (typeof command !== "string" || !command.trim()) return "unresolved-command";
  return basename(command.trim().split(/\s+/)[0]).slice(0, 100);
}

function redactLikelySecret(value: string): string {
  if (/(?:token|secret|password|passwd|api[_-]?key|authorization|bearer)[=:]/i.test(value)) return "<redacted-secret>";
  if (/^[A-Fa-f0-9]{32,}$/.test(value) || /^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(value)) return "<redacted-secret>";
  return value.slice(0, 300);
}

function safeUrlIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { return undefined; }
}

function safeEnvironmentIdentity(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(object(value) ?? {})) {
    const text = scalar(raw) ?? canonical(raw);
    result[key] = /(?:token|secret|password|passwd|api[_-]?key|authorization|credential)/i.test(key)
      ? "<secret-value>"
      : redactLikelySecret(text);
  }
  return result;
}

function serverFingerprint(server: Record<string, unknown>): string {
  return canonical({
    type: scalar(server.type),
    command: redactLikelySecret(scalar(server.command) ?? ""),
    args: strings(server.args).map(redactLikelySecret),
    url: safeUrlIdentity(server.url),
    cwd: scalar(server.cwd),
    enabled: scalar(server.enabled),
    required: scalar(server.required),
    env: safeEnvironmentIdentity(server.env),
    headerKeys: Object.keys(object(server.headers) ?? object(server.http_headers) ?? {}).sort(),
    envHeaderKeys: Object.keys(object(server.env_http_headers) ?? {}).sort(),
    bearerTokenEnv: scalar(server.bearer_token_env_var),
    enabledTools: strings(server.enabled_tools).sort(),
    disabledTools: strings(server.disabled_tools).sort(),
  });
}

function host(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function add(entries: Map<string, Entry>, kind: AuthorityChangeKind, subject: string, value: string, source: string, fingerprint = value): void {
  const cleanSubject = subject.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!cleanSubject) return;
  entries.set(`${kind}\0${cleanSubject}`, { kind, subject: cleanSubject, value: value.slice(0, 500), fingerprint: sha256(fingerprint), source });
}

function flatten(value: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix || "$", sha256(canonical(value)));
  }
  return out;
}

function removeKnown(flat: Map<string, string>, patterns: RegExp[]): void {
  for (const key of flat.keys()) if (patterns.some((pattern) => pattern.test(key))) flat.delete(key);
}

function parseMcp(raw: string, source: string): { entries: Map<string, Entry>; unknown: Map<string, string> } {
  const parsed = JSON.parse(raw) as unknown;
  const root = object(parsed);
  if (!root) throw new Error("top level must be an object");
  const rootKey = object(root.mcpServers) ? "mcpServers" : object(root.servers) ? "servers" : undefined;
  const servers = rootKey ? object(root[rootKey]) : undefined;
  if (!servers || !rootKey) throw new Error("mcpServers or servers must be an object");
  const entries = new Map<string, Entry>();
  for (const [name, rawServer] of Object.entries(servers)) {
    const server = object(rawServer);
    if (!server) continue;
    const command = safeExecutable(server.command);
    const urlHost = host(server.url);
    const transport = scalar(server.type) ?? (urlHost ? "remote" : "stdio");
    add(entries, "server", `mcp:${name}`, `${transport}:${urlHost ?? command}`, source, serverFingerprint(server));
    if (urlHost) add(entries, "network", urlHost, "mcp-server", source);
    for (const key of Object.keys(object(server.env) ?? {})) add(entries, "secret", `env:${key}`, "referenced", source);
    for (const key of Object.keys(object(server.headers) ?? {})) add(entries, "secret", `header:${key}`, "referenced", source);
    const cwd = scalar(server.cwd);
    if (cwd) add(entries, "filesystem", cwd, "mcp-cwd", source);
  }
  const unknown = flatten(parsed);
  removeKnown(unknown, [
    /^(?:mcpServers|servers)\.[^.]+\.(command|args(?:\[\d+\])?|env\.[^.]+|headers\.[^.]+|url|type|cwd|disabled|enabled|timeout|startup_timeout_sec|tool_timeout_sec)$/,
  ]);
  return { entries, unknown };
}

function parseClaude(raw: string, source: string): { entries: Map<string, Entry>; unknown: Map<string, string> } {
  const parsed = JSON.parse(raw) as unknown;
  const root = object(parsed);
  if (!root) throw new Error("top level must be an object");
  const entries = new Map<string, Entry>();
  const permissions = object(root.permissions);
  for (const tool of strings(permissions?.allow)) add(entries, "tool", `allow:${tool}`, "allowed", source);
  for (const tool of strings(permissions?.deny)) add(entries, "tool", `deny:${tool}`, "denied", source);
  for (const tool of strings(permissions?.ask)) add(entries, "tool", `ask:${tool}`, "approval-required", source);
  const defaultMode = scalar(permissions?.defaultMode);
  if (defaultMode) add(entries, "approval", "claude-default-mode", defaultMode, source);
  const disableBypass = scalar(permissions?.disableBypassPermissionsMode);
  if (disableBypass === "disable") add(entries, "approval", "claude-disable-bypass-permissions", disableBypass, source);
  for (const key of ["allowManagedPermissionRulesOnly", "allowManagedHooksOnly"] as const) {
    const value = scalar(root[key]);
    if (value === "true") add(entries, "approval", `claude-${key}`, value, source);
  }
  const model = scalar(root.model);
  if (model) add(entries, "model", "claude-model", model, source);
  for (const key of Object.keys(object(root.env) ?? {})) add(entries, "secret", `env:${key}`, "referenced", source);
  const sandbox = object(root.sandbox);
  const sandboxEnabled = scalar(sandbox?.enabled);
  if (sandboxEnabled !== undefined) add(entries, "sandbox", "claude-enabled", sandboxEnabled, source);
  for (const key of ["autoAllowBashIfSandboxed", "allowUnsandboxedCommands", "enableWeakerNestedSandbox"] as const) {
    if (scalar(sandbox?.[key]) === "true") add(entries, "sandbox", `claude-${key}`, "true", source);
  }
  for (const item of strings(sandbox?.excludedCommands)) add(entries, "tool", `sandbox-exclusion:${item}`, "excluded", source);
  const network = object(sandbox?.network);
  for (const domain of strings(network?.allowedDomains)) add(entries, "network", domain.toLowerCase(), "allowed", source);
  for (const domain of strings(network?.allowUnixSockets)) add(entries, "filesystem", domain, "unix-socket", source);
  for (const key of ["allowAllUnixSockets", "allowLocalBinding"] as const) {
    const value = scalar(network?.[key]);
    if (value === "true") add(entries, "sandbox", `claude-network-${key}`, value, source);
  }
  for (const key of ["httpProxyPort", "socksProxyPort"] as const) {
    const value = scalar(network?.[key]);
    if (value !== undefined) add(entries, "network", `localhost:${value}`, key, source);
  }
  for (const [event, rows] of Object.entries(object(root.hooks) ?? {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const group = object(row);
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const hook of hooks) {
        const item = object(hook);
        if (item?.type === "command" && typeof item.command === "string") {
          add(entries, "hook", `${event}:${safeExecutable(item.command)}`, "command configured", source, item.command.split(/\s+/).map(redactLikelySecret).join(" "));
        }
      }
    }
  }
  const unknown = flatten(parsed);
  removeKnown(unknown, [
    /^permissions\.(allow|deny|ask)\[\d+\]$/, /^permissions\.(defaultMode|disableBypassPermissionsMode)$/,
    /^(allowManagedPermissionRulesOnly|allowManagedHooksOnly)$/,
    /^model$/, /^env\.[^.]+$/,
    /^sandbox\.(enabled|autoAllowBashIfSandboxed|allowUnsandboxedCommands|enableWeakerNestedSandbox|excludedCommands\[\d+\])$/,
    /^sandbox\.network\.(allowedDomains|allowUnixSockets)\[\d+\]$/,
    /^sandbox\.network\.(allowAllUnixSockets|allowLocalBinding|httpProxyPort|socksProxyPort)$/,
    /^hooks\.[^.]+\[\d+\]\.(matcher|hooks\[\d+\]\.(type|command|timeout|async))$/,
    /^(enabledMcpjsonServers|disabledMcpjsonServers)\[\d+\]$/, /^enableAllProjectMcpServers$/,
    /^(cleanupPeriodDays|companyAnnouncements|statusLine|outputStyle|language|respectGitignore|plansDirectory|alwaysThinkingEnabled|autoUpdatesChannel|spinnerTipsEnabled|showTurnDuration|prefersReducedMotion|spinnerVerbs\[\d+\])$/,
  ]);
  return { entries, unknown };
}

function parseCodex(raw: string, source: string): { entries: Map<string, Entry>; unknown: Map<string, string> } {
  const parsed = parseToml(raw) as unknown;
  const root = object(parsed);
  if (!root) throw new Error("top level must be a table");
  const entries = new Map<string, Entry>();
  const model = scalar(root.model);
  if (model) add(entries, "model", "codex-model", model, source);
  const approval = scalar(root.approval_policy);
  if (approval) add(entries, "approval", "codex-approval-policy", approval, source);
  const sandboxMode = scalar(root.sandbox_mode);
  if (sandboxMode) add(entries, "sandbox", "codex-sandbox-mode", sandboxMode, source);
  const workspaceWrite = object(root.sandbox_workspace_write);
  if (scalar(workspaceWrite?.network_access) === "true") add(entries, "network", "*", "workspace-write-network", source);
  for (const path of strings(workspaceWrite?.writable_roots)) add(entries, "filesystem", path, "writable-root", source);
  const servers = object(root.mcp_servers);
  for (const [name, rawServer] of Object.entries(servers ?? {})) {
    const server = object(rawServer);
    if (!server || server.enabled === false) continue;
    const urlHost = host(server.url);
    add(entries, "server", `mcp:${name}`, `${urlHost ? "remote" : "stdio"}:${urlHost ?? safeExecutable(server.command)}`, source, serverFingerprint(server));
    if (urlHost) add(entries, "network", urlHost, "mcp-server", source);
    for (const key of Object.keys(object(server.env) ?? {})) add(entries, "secret", `env:${key}`, "referenced", source);
    const bearerToken = scalar(server.bearer_token_env_var);
    if (bearerToken) add(entries, "secret", `env:${bearerToken}`, "bearer-token", source);
    for (const key of Object.keys(object(server.http_headers) ?? {})) add(entries, "secret", `header:${key}`, "referenced", source);
    for (const key of Object.keys(object(server.env_http_headers) ?? {})) add(entries, "secret", `env-header:${key}`, "referenced", source);
    for (const tool of strings(server.enabled_tools)) add(entries, "tool", `allow:${name}:${tool}`, "allowed", source);
    for (const tool of strings(server.disabled_tools)) add(entries, "tool", `deny:${name}:${tool}`, "denied", source);
  }
  const unknown = flatten(parsed);
  removeKnown(unknown, [
    /^(model|model_provider|model_reasoning_effort|model_reasoning_summary|model_verbosity|approval_policy|sandbox_mode|web_search|disable_response_storage|show_raw_agent_reasoning|hide_agent_reasoning)$/,
    /^sandbox_workspace_write\.(network_access|writable_roots\[\d+\])$/,
    /^mcp_servers\.[^.]+\.(command|args\[\d+\]|env\.[^.]+|url|enabled|required|startup_timeout_sec|tool_timeout_sec|bearer_token_env_var|http_headers\.[^.]+|env_http_headers\.[^.]+|enabled_tools\[\d+\]|disabled_tools\[\d+\]|cwd)$/,
    /^features\.[^.]+$/,
  ]);
  return { entries, unknown };
}

function parseConfig(raw: string, source: string): { entries: Map<string, Entry>; unknown: Map<string, string> } {
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error(`file exceeds ${MAX_CONFIG_BYTES} bytes`);
  if (source.endsWith("mcp.json")) return parseMcp(raw, source);
  if (source.startsWith(".claude/")) return parseClaude(raw, source);
  if (source === ".codex/config.toml") return parseCodex(raw, source);
  throw new Error("unsupported authority configuration path");
}

function readAt(repo: string, ref: string, path: string): string | undefined {
  return gitOptional(repo, ["show", `${ref}:${path}`]);
}

function snapshot(repo: string, ref: string): Snapshot {
  const entries = new Map<string, Entry>();
  const unknown = new Map<string, string>();
  const inspected: string[] = [];
  for (const path of AUTHORITY_CONFIG_PATHS) {
    const raw = readAt(repo, ref, path);
    if (raw === undefined) continue;
    inspected.push(path);
    try {
      const parsed = parseConfig(raw, path);
      for (const [key, value] of parsed.entries) entries.set(`${path}\0${key}`, value);
      for (const [key, value] of parsed.unknown) unknown.set(`${path}:${key}`, value);
    } catch (error) {
      unknown.set(`${path}:$parse`, sha256(`${(error as Error).message}\0${raw}`));
    }
  }
  return { entries, unknown, inspected };
}

function isMutableModel(value: string): boolean {
  return /(?:^|[-_.])(latest|current|preview|nightly|dev|beta)(?:$|[-_.])/i.test(value) || !/\d/.test(value);
}

function approvalStrength(value: string): number {
  const normalized = value.toLowerCase();
  if (/^(untrusted|default|ask|plan)$/.test(normalized)) return 4;
  if (/^(on-request|on_request|acceptedits)$/.test(normalized)) return 3;
  if (/^(on-failure|on_failure|dontask)$/.test(normalized)) return 2;
  if (/^(never|bypasspermissions|bypass)$/.test(normalized)) return 0;
  return 1;
}

function sandboxStrength(value: string): number {
  const normalized = value.toLowerCase();
  if (/^(true|read-only|read_only)$/.test(normalized)) return 3;
  if (/^(workspace-write|workspace_write)$/.test(normalized)) return 2;
  if (/^(false|danger-full-access|danger_full_access|disabled)$/.test(normalized)) return 0;
  return 1;
}

function permissiveBooleanStrength(value: string): number {
  const normalized = value.toLowerCase();
  if (normalized === "false") return 3;
  if (normalized === "true") return 0;
  return 1;
}

function restrictiveBooleanStrength(value: string): number {
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "disable") return 3;
  if (normalized === "false" || normalized === "enable") return 0;
  return 1;
}

function classify(before: Entry | undefined, after: Entry | undefined, policy: AuthorityPlanPolicy): AuthorityChange {
  const item = after ?? before!;
  let effect: AuthorityChange["effect"] = before && after ? "changed" : after ? "expanded" : "reduced";
  let blocking = effect === "expanded";
  let reason = effect === "expanded" ? "new authority requires review" : effect === "reduced" ? "authority was removed" : "authority changed";

  if (item.kind === "tool" && item.subject.startsWith("deny:")) {
    effect = after ? (before ? "changed" : "reduced") : "expanded";
    blocking = !after;
    reason = after ? "a tool is now denied" : "a tool denial was removed";
  } else if (item.kind === "approval" && (
    item.subject === "claude-disable-bypass-permissions"
    || item.subject === "claude-allowManagedPermissionRulesOnly"
    || item.subject === "claude-allowManagedHooksOnly"
  )) {
    const delta = (after ? restrictiveBooleanStrength(after.value) : 0) - (before ? restrictiveBooleanStrength(before.value) : 0);
    effect = delta < 0 ? "expanded" : delta > 0 ? "reduced" : "changed";
    blocking = delta <= 0;
    reason = delta < 0 ? "an administrative restriction was weakened" : delta > 0 ? "an administrative restriction was strengthened" : "administrative restriction changed with no proven safer ordering";
  } else if (item.kind === "approval" && before && after) {
    const delta = approvalStrength(after.value) - approvalStrength(before.value);
    effect = delta < 0 ? "expanded" : delta > 0 ? "reduced" : "changed";
    blocking = delta <= 0;
    reason = delta < 0 ? "approval was weakened" : delta > 0 ? "approval was strengthened" : "approval mode changed with no proven safer ordering";
  } else if (item.kind === "sandbox" && item.subject === "claude-enabled") {
    const delta = (after ? sandboxStrength(after.value) : 0) - (before ? sandboxStrength(before.value) : 0);
    effect = delta < 0 ? "expanded" : delta > 0 ? "reduced" : "changed";
    blocking = delta < 0;
    reason = delta < 0 ? "sandbox protection was weakened" : delta > 0 ? "sandbox protection was strengthened" : "sandbox setting did not change effective protection";
  } else if (item.kind === "sandbox" && item.subject !== "codex-sandbox-mode") {
    const delta = (after ? permissiveBooleanStrength(after.value) : 3) - (before ? permissiveBooleanStrength(before.value) : 3);
    effect = delta < 0 ? "expanded" : delta > 0 ? "reduced" : "changed";
    blocking = delta <= 0;
    reason = delta < 0 ? "sandbox protection was weakened" : delta > 0 ? "sandbox protection was strengthened" : "sandbox setting changed with no proven safer ordering";
  } else if (item.kind === "sandbox" && before && after) {
    const delta = sandboxStrength(after.value) - sandboxStrength(before.value);
    effect = delta < 0 ? "expanded" : delta > 0 ? "reduced" : "changed";
    blocking = delta <= 0;
    reason = delta < 0 ? "sandbox protection was weakened" : delta > 0 ? "sandbox protection was strengthened" : "sandbox setting changed with no proven safer ordering";
  } else if (item.kind === "model" && before && after) {
    const becameMutable = !isMutableModel(before.value) && isMutableModel(after.value);
    effect = becameMutable ? "expanded" : "changed";
    blocking = becameMutable;
    reason = becameMutable ? "a pinned model became a mutable alias" : "model identity changed";
  } else if (before && after) {
    blocking = true;
    reason = "effective authority changed";
  }
  const target = after ?? before!;
  const publicKey = `${item.kind}:${item.subject}=${after?.value ?? "removed"}`;
  const approvalKey = target.fingerprint === sha256(target.value) ? publicKey : `${publicKey}@${target.fingerprint}`;
  if (blocking && policy.approvedAdditions.includes(approvalKey)) {
    blocking = false;
    reason = `${reason}; approved by the base revision policy`;
  }
  return {
    kind: item.kind, subject: item.subject,
    ...(before ? { before: before.value } : {}), ...(after ? { after: after.value } : {}),
    effect, blocking, reason, source: item.source, approvalKey,
  };
}

function validatePolicy(input: unknown): AuthorityPlanPolicy {
  const root = object(input);
  if (!root || root.schemaVersion !== 1) throw new Error("policy schemaVersion must be 1");
  const allowed = new Set(["schemaVersion", "approvedAdditions", "allowUnknownChanges"]);
  const extras = Object.keys(root).filter((key) => !allowed.has(key));
  if (extras.length) throw new Error(`policy contains unknown field(s): ${extras.join(", ")}`);
  if (!Array.isArray(root.approvedAdditions) || root.approvedAdditions.some((item) => typeof item !== "string" || !item.trim())) throw new Error("policy approvedAdditions must be an array of non-empty strings");
  if (root.approvedAdditions.length > 1000 || root.approvedAdditions.some((item) => (item as string).length > 1000)) throw new Error("policy approvedAdditions must contain at most 1000 entries of at most 1000 characters");
  if (new Set(root.approvedAdditions).size !== root.approvedAdditions.length) throw new Error("policy approvedAdditions must not contain duplicates");
  if (typeof root.allowUnknownChanges !== "boolean") throw new Error("policy allowUnknownChanges must be boolean");
  return { schemaVersion: 1, approvedAdditions: [...new Set(root.approvedAdditions as string[])], allowUnknownChanges: root.allowUnknownChanges };
}

function loadPolicy(repo: string, base: string, path = ".agent-vigil-authority-plan.json"): { value: AuthorityPlanPolicy; source: string; sha256: string } {
  const clean = posix.normalize(path.replace(/^\.\//, ""));
  if (!clean || clean === ".." || clean.startsWith("../") || clean.startsWith("/") || path.includes("\\") || path.includes(":")) {
    throw new Error("authority plan policy path must stay inside the repository");
  }
  const raw = readAt(repo, base, clean);
  if (raw === undefined) return { value: DEFAULT_POLICY, source: "built-in default", sha256: sha256(canonical(DEFAULT_POLICY)) };
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error("authority plan policy is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`authority plan policy at ${base}:${clean} is not valid JSON`); }
  const value = validatePolicy(parsed);
  return { value, source: `${clean}@${base}`, sha256: sha256(canonical(value)) };
}

export function buildAuthorityPlan(repo: string, base: string, head: string, vigilVersion: string, policyPath?: string): AuthorityPlanReport {
  const baseSha = git(repo, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const headSha = git(repo, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
  const policy = loadPolicy(repo, baseSha, policyPath);
  const before = snapshot(repo, baseSha);
  const after = snapshot(repo, headSha);
  const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
  const changes: AuthorityChange[] = [];
  for (const key of keys) {
    const left = before.entries.get(key);
    const right = after.entries.get(key);
    if (left?.fingerprint === right?.fingerprint) continue;
    changes.push(classify(left, right, policy.value));
  }
  changes.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));

  const unknownKeys = new Set([...before.unknown.keys(), ...after.unknown.keys()]);
  const uncertainties = [...unknownKeys]
    .filter((key) => before.unknown.get(key) !== after.unknown.get(key))
    .map((key) => {
      const separator = key.indexOf(":");
      return {
        source: key.slice(0, separator),
        setting: key.slice(separator + 1),
        reason: key.endsWith(":$parse") ? "the changed configuration could not be parsed" : "the changed setting is not normalized by this Agent Vigil version",
      };
    });
  const changedConfigPaths = git(repo, ["diff", "--name-only", "-z", baseSha, headSha]).split("\0").filter(Boolean)
    .filter((path) => (AUTHORITY_CONFIG_PATHS as readonly string[]).includes(posix.normalize(path)));
  const inspected = [...new Set([...before.inspected, ...after.inspected, ...changedConfigPaths])].sort();
  const blocking = changes.filter((change) => change.blocking).length;
  const relevantUncertainty = policy.value.allowUnknownChanges ? 0 : uncertainties.length;
  const status: AuthorityPlanReport["status"] = blocking ? "FAIL" : relevantUncertainty ? "INCONCLUSIVE" : "PASS";
  const reproduction = `vigil plan --repo . --base ${baseSha} --head ${headSha}`;
  const payload = { schemaVersion: "1" as const, vigilVersion, status, base: baseSha, head: headSha, policy: { source: policy.source, sha256: policy.sha256 }, inspected, changes, uncertainties, reproduction };
  return {
    ...payload,
    generatedAt: new Date().toISOString(),
    receiptHash: sha256(canonical(payload)),
    summary: { changes: changes.length, blocking, reduced: changes.filter((change) => change.effect === "reduced").length, uncertain: uncertainties.length },
  };
}

export function renderAuthorityPlan(report: AuthorityPlanReport): string {
  const title = report.status === "PASS" ? "PASS" : report.status === "FAIL" ? "BLOCK" : "INCONCLUSIVE";
  const lines = [`Agent authority plan: ${title}`, `Change: ${report.base.slice(0, 12)} -> ${report.head.slice(0, 12)}`, terminalSafe(`Policy: ${report.policy.source} (${report.policy.sha256})`), ""];
  if (!report.changes.length && !report.uncertainties.length) lines.push("No effective authority changes found.");
  for (const change of report.changes) {
    const marker = change.blocking ? "!" : change.effect === "reduced" ? "-" : "~";
    const values = change.before !== undefined && change.after !== undefined ? `  ${change.before} -> ${change.after}` : change.after !== undefined ? `  + ${change.after}` : `  - ${change.before}`;
    lines.push(terminalSafe(`${marker} ${change.kind.padEnd(10)} ${change.subject}${values}`));
    if (change.blocking) lines.push(terminalSafe(`  review: ${change.reason}`));
  }
  for (const item of report.uncertainties) {
    lines.push(terminalSafe(`? setting    ${item.source}:${item.setting}`));
    lines.push(terminalSafe(`  review: ${item.reason}`));
  }
  lines.push("", `${report.summary.changes} authority change(s), ${report.summary.blocking} blocking, ${report.summary.uncertain} uncertain`);
  lines.push(`${report.status} · ${report.receiptHash}`, `Reproduce: ${report.reproduction}`);
  return lines.join("\n");
}

export function authorityPlanChecks(report: AuthorityPlanReport): { results: CheckResult[]; advisories: CheckResult[] } {
  const results: CheckResult[] = [];
  const advisories: CheckResult[] = [];
  results.push({
    claim: { kind: "authority_scope", subject: "agent authority configuration", quote: "the exact change does not expand unapproved agent authority" },
    verdict: report.summary.blocking ? "contradicted" : report.status === "INCONCLUSIVE" ? "unverifiable" : "verified",
    evidence: `${report.summary.changes} effective change(s), ${report.summary.blocking} blocking, ${report.summary.uncertain} uncertain; plan ${report.receiptHash}`,
    ruleId: "authority-plan",
    contributesToPass: false,
    ...(report.status === "INCONCLUSIVE" ? { blocksPass: true } : {}),
  });
  for (const change of report.changes) {
    const check: CheckResult = {
      claim: { kind: "authority_scope", subject: `${change.kind}: ${change.subject}`, quote: "agent authority delta" },
      verdict: change.blocking ? "contradicted" : "verified",
      evidence: `${change.reason}; ${change.before ?? "absent"} -> ${change.after ?? "absent"} in ${change.source}`,
      ruleId: `authority-${change.kind}`,
      contributesToPass: false,
    };
    if (change.blocking) results.push(check); else advisories.push(check);
  }
  for (const item of report.uncertainties) {
    const check: CheckResult = {
      claim: { kind: "authority_scope", subject: `unrecognized setting: ${item.source}:${item.setting}`, quote: "changed authority configuration is fully understood" },
      verdict: "unverifiable",
      evidence: item.reason,
      ruleId: "authority-setting-unknown",
      contributesToPass: false,
      ...(report.status === "INCONCLUSIVE" ? { blocksPass: true } : {}),
    };
    if (report.status === "INCONCLUSIVE") results.push(check); else advisories.push(check);
  }
  return { results, advisories };
}
