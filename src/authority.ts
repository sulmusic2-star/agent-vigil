import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isAbsolute, normalize, relative, resolve, win32 } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { collectDiffEvidence, pathMatches } from "./maintainer.ts";
import { canonical, type CheckResult, type ClaimKind, type Verdict } from "./report.ts";
import type { LoadedTranscript, SessionToolCall } from "./transcript.ts";

export const ACTION_CLASSES = [
  "repository_read",
  "repository_write",
  "test_execute",
  "build_execute",
  "dependency_install",
  "network_read",
  "credential_access",
  "destructive_filesystem",
  "git_commit",
  "git_push",
  "pull_request_write",
  "release_publish",
  "deploy",
  "external_write",
  "task_create",
  "unknown_effect",
] as const;

export type ActionClass = typeof ACTION_CLASSES[number];

export type AuthorityContract = {
  schemaVersion: 1;
  taskId: string;
  allowedChangePaths: string[];
  deniedChangePaths?: string[];
  allowedActions: ActionClass[];
  requireCompleteToolResults?: boolean;
  maxToolCalls?: number;
  maxFailedToolCalls?: number;
  maxIdenticalToolCalls?: number;
  maxConsecutiveFailedToolCalls?: number;
  maxObservedTokens?: number;
  maxTokensWithoutObservedProgress?: number;
  expiresAt?: string;
};

export type LoadedAuthorityContract = {
  value: AuthorityContract;
  sha256: string;
  source: string;
  path?: string;
  gitPath?: string;
  ref?: string;
};

export type ClassifiedAction = {
  toolCallId: string;
  toolName: string;
  sequence: number;
  classes: ActionClass[];
  summary: string;
  identitySha256: string;
  completed: boolean;
  failed: boolean;
};

export type TrajectoryMetrics = {
  toolCalls: number;
  failedToolCalls: number;
  maxIdenticalToolCalls: number;
  repeatedActionGroups: number;
  maxConsecutiveFailedToolCalls: number;
  progressBearingActions: number;
};

const MAX_CONTRACT_BYTES = 1024 * 1024;
const ACTION_SET = new Set<string>(ACTION_CLASSES);

function result(kind: ClaimKind, ruleId: string, subject: string, quote: string, verdict: Verdict, evidence: string, options: Pick<CheckResult, "contributesToPass" | "blocksPass"> = {}): CheckResult {
  return { claim: { kind, subject, quote }, ruleId, verdict, evidence, ...options };
}

function stringArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value as string[];
}

function validatePatterns(patterns: string[], label: string): void {
  if (patterns.length > 1000) throw new Error(`${label} must contain at most 1000 patterns`);
  for (const pattern of patterns) {
    if (pattern.length > 500) throw new Error(`${label} patterns must contain at most 500 characters`);
    const clean = normalize(pattern).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isAbsolute(pattern) || win32.isAbsolute(pattern) || clean === ".." || clean.startsWith("../")) {
      throw new Error(`${label} patterns must stay inside the repository`);
    }
  }
}

function optionalLimit(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

export function validateAuthorityContract(input: unknown): AuthorityContract {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("authority contract must be a JSON object");
  const value = input as Record<string, unknown>;
  const allowedFields = new Set([
    "schemaVersion", "taskId", "allowedChangePaths", "deniedChangePaths", "allowedActions",
    "requireCompleteToolResults", "maxToolCalls", "maxFailedToolCalls", "maxIdenticalToolCalls",
    "maxConsecutiveFailedToolCalls", "maxObservedTokens", "maxTokensWithoutObservedProgress", "expiresAt",
  ]);
  const unknownFields = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) throw new Error(`authority contract contains unknown field(s): ${unknownFields.join(", ")}`);
  if (value.schemaVersion !== 1) throw new Error("authority contract schemaVersion must be 1");
  if (typeof value.taskId !== "string" || !value.taskId.trim() || value.taskId.length > 200) throw new Error("authority contract taskId must be a non-empty string of at most 200 characters");
  const allowedChangePaths = stringArray(value.allowedChangePaths, "authority contract allowedChangePaths");
  validatePatterns(allowedChangePaths, "allowedChangePaths");
  let deniedChangePaths: string[] | undefined;
  if (value.deniedChangePaths !== undefined) {
    deniedChangePaths = stringArray(value.deniedChangePaths, "authority contract deniedChangePaths");
    validatePatterns(deniedChangePaths, "deniedChangePaths");
  }
  const allowedActions = stringArray(value.allowedActions, "authority contract allowedActions", true);
  if (allowedActions.length > ACTION_CLASSES.length) throw new Error("authority contract allowedActions contains too many entries");
  const invalidActions = allowedActions.filter((action) => !ACTION_SET.has(action));
  if (invalidActions.length) throw new Error(`authority contract contains unsupported action class(es): ${invalidActions.join(", ")}`);
  if (value.requireCompleteToolResults !== undefined && typeof value.requireCompleteToolResults !== "boolean") {
    throw new Error("authority contract requireCompleteToolResults must be boolean");
  }
  const maxToolCalls = optionalLimit(value.maxToolCalls, "authority contract maxToolCalls");
  const maxFailedToolCalls = optionalLimit(value.maxFailedToolCalls, "authority contract maxFailedToolCalls");
  const maxIdenticalToolCalls = optionalLimit(value.maxIdenticalToolCalls, "authority contract maxIdenticalToolCalls");
  const maxConsecutiveFailedToolCalls = optionalLimit(value.maxConsecutiveFailedToolCalls, "authority contract maxConsecutiveFailedToolCalls");
  const maxObservedTokens = optionalLimit(value.maxObservedTokens, "authority contract maxObservedTokens");
  const maxTokensWithoutObservedProgress = optionalLimit(value.maxTokensWithoutObservedProgress, "authority contract maxTokensWithoutObservedProgress");
  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== "string" || !value.expiresAt.trim() || !Number.isFinite(new Date(value.expiresAt).getTime())) {
      throw new Error("authority contract expiresAt must be an ISO-compatible timestamp");
    }
  }
  return {
    schemaVersion: 1,
    taskId: value.taskId.trim(),
    allowedChangePaths,
    ...(deniedChangePaths ? { deniedChangePaths } : {}),
    allowedActions: allowedActions as ActionClass[],
    ...(value.requireCompleteToolResults !== undefined ? { requireCompleteToolResults: value.requireCompleteToolResults } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(maxFailedToolCalls !== undefined ? { maxFailedToolCalls } : {}),
    ...(maxIdenticalToolCalls !== undefined ? { maxIdenticalToolCalls } : {}),
    ...(maxConsecutiveFailedToolCalls !== undefined ? { maxConsecutiveFailedToolCalls } : {}),
    ...(maxObservedTokens !== undefined ? { maxObservedTokens } : {}),
    ...(maxTokensWithoutObservedProgress !== undefined ? { maxTokensWithoutObservedProgress } : {}),
    ...(value.expiresAt !== undefined ? { expiresAt: new Date(value.expiresAt).toISOString() } : {}),
  };
}

function parseContract(raw: string, source: string): AuthorityContract {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`authority contract is not valid JSON: ${source}`); }
  return validateAuthorityContract(parsed);
}

export function loadAuthorityContract(repo: string, requested: string, ref?: string): LoadedAuthorityContract {
  if (ref) {
    const clean = normalize(requested).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isAbsolute(requested) || win32.isAbsolute(requested) || clean === ".." || clean.startsWith("../")) {
      throw new Error("contract-ref requires a repository-relative contract path");
    }
    let raw: string;
    try {
      raw = execFileSync("git", ["show", `${ref}:${clean}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_CONTRACT_BYTES });
    } catch { throw new Error(`authority contract not found at ${ref}:${clean}`); }
    if (Buffer.byteLength(raw) > MAX_CONTRACT_BYTES) throw new Error(`authority contract exceeds ${MAX_CONTRACT_BYTES} bytes`);
    const value = parseContract(raw, `${ref}:${clean}`);
    return { value, sha256: `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`, source: `${clean}@${ref}`, gitPath: clean, ref };
  }
  const path = resolve(repo, requested);
  const size = statSync(path).size;
  if (size > MAX_CONTRACT_BYTES) throw new Error(`authority contract is ${size} bytes; maximum is ${MAX_CONTRACT_BYTES}`);
  const value = parseContract(readFileSync(path, "utf8"), path);
  return { value, sha256: `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`, source: relative(repo, path) || requested, path };
}

function inputObject(call: SessionToolCall): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(call.input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function commandText(call: SessionToolCall): string | undefined {
  const input = inputObject(call);
  for (const key of ["cmd", "command", "script"]) {
    if (typeof input?.[key] === "string") return input[key] as string;
  }
  if (/exec|bash|shell|terminal|command/i.test(call.name)) return call.input;
  return undefined;
}

/** Split shell chains without pretending to implement a complete shell grammar. */
export function splitShellCommands(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let substitutionDepth = 0;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { current += char; escaped = true; continue; }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; current += char; continue; }
    if (char === "$" && next === "(") { substitutionDepth += 1; current += "$"; continue; }
    if (char === ")" && substitutionDepth > 0) { substitutionDepth -= 1; current += char; continue; }
    const separator = substitutionDepth === 0 && (char === "\n" || char === ";" || char === "|" || char === "&");
    if (separator) {
      if (current.trim()) out.push(current.trim());
      current = "";
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function classesForCommand(raw: string): ActionClass[] {
  const command = raw.trim().replace(/^(?:sudo\s+|env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+)+/, "");
  const classes = new Set<ActionClass>();
  const add = (...items: ActionClass[]) => items.forEach((item) => classes.add(item));

  if (/^(?:ls|pwd|cat|head|tail|grep|rg|find|stat|wc|diff|jq|sed\s+(?!.*(?:-i|--in-place))|git\s+(?:status|diff|log|show|rev-parse|ls-files|remote\s+-v)\b)/i.test(command)) add("repository_read");
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|typecheck|smoke|verify)|exec\s+.*test)|^(?:pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|make\s+(?:test|check|verify))\b/i.test(command)) add("test_execute");
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+build|build)|^(?:cargo|go|dotnet|mvn|gradle|make)\s+build\b/i.test(command)) add("build_execute");
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|pipx?\s+install\b|python\s+-m\s+pip\s+install\b|uv\s+(?:add|sync|pip\s+install)\b|brew\s+install\b|apt(?:-get)?\s+install\b|dnf\s+install\b|gem\s+install\b)/i.test(command)) add("dependency_install");
  if (/^(?:rm|rmdir|del|erase|trash)\b|\bgit\s+(?:clean|reset\s+--hard)\b/i.test(command)) add("destructive_filesystem");
  if (/^git\s+commit\b/i.test(command)) add("git_commit");
  if (/^git\s+push\b/i.test(command)) add("git_push");
  if (/^gh\s+pr\s+(?:create|merge|close|comment|edit|review)\b/i.test(command)) add("pull_request_write");
  if (/^(?:gh\s+release\s+(?:create|upload|edit|delete)|npm\s+publish|cargo\s+publish|twine\s+upload)\b/i.test(command)) add("release_publish");
  if (/^(?:vercel|netlify|wrangler\s+deploy|flyctl\s+deploy|gcloud\s+(?:run\s+deploy|app\s+deploy)|aws\s+.*deploy|kubectl\s+(?:apply|delete|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+apply)\b/i.test(command)) add("deploy");
  if (/^(?:curl|wget)\b/i.test(command)) add(/(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b|--data(?:-\w+)?\b|-d\s)/i.test(command) ? "external_write" : "network_read");
  if (/^(?:gh\s+(?:issue|api)\s+.*(?:comment|create|edit|delete)|mail|sendmail|osascript\s+.*mail)\b/i.test(command)) add("external_write");
  if (/(?:\.env\b|\.ssh\/|credentials?|api[_-]?key|token|secret|keychain|security\s+find-generic-password)/i.test(command)) add("credential_access");
  if (/^(?:git\s+(?:add|checkout|switch|restore|mv|rm)|mkdir|touch|cp|mv|sed\s+.*(?:-i|--in-place)|tee\b|printf\b.*>|echo\b.*>)\b/i.test(command)) add("repository_write");
  if (/^(?:sh|bash|zsh|cmd|powershell|pwsh)\s+(?:-c|\/c)\b|\beval\b/i.test(command)) add("unknown_effect");
  if (!classes.size) add("unknown_effect");
  return [...classes];
}

function classifyToolCall(call: SessionToolCall): ClassifiedAction {
  const name = call.name.toLowerCase();
  const classes = new Set<ActionClass>();
  const add = (...items: ActionClass[]) => items.forEach((item) => classes.add(item));
  const command = commandText(call);
  if (command !== undefined) {
    for (const segment of splitShellCommands(command)) for (const item of classesForCommand(segment)) classes.add(item);
  } else if (/create_thread|spawn_agent|delegate/.test(name)) add("task_create");
  else if (/apply[_-]?patch|write|edit|create_file|delete_file/.test(name)) add("repository_write");
  else if (/read|glob|grep|search_files|list_files|view_image/.test(name)) add("repository_read");
  else if (/web|fetch|search_query|open_url|browser/.test(name)) add("network_read");
  else if (/send|email|message|comment|post|submit/.test(name)) add("external_write");
  else add("unknown_effect");
  if (/credential|secret|keychain|token/.test(name)) add("credential_access");
  const identityInput = command ?? call.input;
  return {
    toolCallId: call.id,
    toolName: call.name,
    sequence: call.sequence,
    classes: [...classes],
    summary: command ? command.slice(0, 240).replace(/\s+/g, " ") : call.input.slice(0, 240).replace(/\s+/g, " "),
    identitySha256: `sha256:${createHash("sha256").update(`${call.name}\0${identityInput}`).digest("hex")}`,
    completed: call.output !== undefined,
    failed: call.isError === true,
  };
}

export function classifyTranscriptActions(transcript: LoadedTranscript): ClassifiedAction[] {
  return transcript.toolCalls.map(classifyToolCall);
}

export function analyzeTrajectory(actions: ClassifiedAction[]): TrajectoryMetrics {
  const identities = new Map<string, number>();
  let failureStreak = 0;
  let maxFailureStreak = 0;
  for (const action of actions) {
    identities.set(action.identitySha256, (identities.get(action.identitySha256) ?? 0) + 1);
    failureStreak = action.failed ? failureStreak + 1 : 0;
    maxFailureStreak = Math.max(maxFailureStreak, failureStreak);
  }
  const counts = [...identities.values()];
  const progressClasses = new Set<ActionClass>(["repository_write", "test_execute", "build_execute", "git_commit"]);
  return {
    toolCalls: actions.length,
    failedToolCalls: actions.filter((action) => action.failed).length,
    maxIdenticalToolCalls: counts.length ? Math.max(...counts) : 0,
    repeatedActionGroups: counts.filter((count) => count > 1).length,
    maxConsecutiveFailedToolCalls: maxFailureStreak,
    progressBearingActions: actions.filter((action) => action.classes.some((item) => progressClasses.has(item))).length,
  };
}

export function buildAuthorityChecks(repo: string, base: string, head: string, transcript: LoadedTranscript, contract: AuthorityContract, now = new Date()): { results: CheckResult[]; actions: ClassifiedAction[] } {
  const results: CheckResult[] = [];
  if (contract.expiresAt) {
    const valid = now.getTime() <= new Date(contract.expiresAt).getTime();
    results.push(result("authority_scope", "authority-validity", "authority validity window", contract.expiresAt, valid ? "verified" : "contradicted", valid ? `authority remains valid until ${contract.expiresAt}` : `authority expired at ${contract.expiresAt}`));
  } else {
    results.push(result("authority_scope", "authority-validity", "authority validity window", "no expiry", "unverifiable", "contract has no expiresAt; durable authority can outlive the task", { contributesToPass: false }));
  }

  const diff = collectDiffEvidence(repo, base, head);
  const outside = diff.paths.filter((path) => !pathMatches(path, contract.allowedChangePaths));
  const denied = contract.deniedChangePaths ? diff.paths.filter((path) => pathMatches(path, contract.deniedChangePaths!)) : [];
  const pathViolations = [...new Set([...outside, ...denied])];
  results.push(result("authority_scope", "authorized-change-paths", "repository change boundary", diff.paths.join(", ") || "no changed paths", pathViolations.length ? "contradicted" : "verified",
    pathViolations.length
      ? `change exceeded task authority: ${pathViolations.join(", ")}`
      : `${diff.paths.length} changed path(s) stayed within allowedChangePaths${contract.deniedChangePaths ? " and outside deniedChangePaths" : ""}`));

  const actions = classifyTranscriptActions(transcript);
  if (!actions.length) {
    results.push(result("authority_action", "observed-action-coverage", "observed agent actions", "no tool calls", "unverifiable", "the transcript contains no structured tool calls; Agent Vigil cannot reconcile authority from narrative alone", { blocksPass: true }));
    return { results, actions };
  }
  const allowed = new Set(contract.allowedActions);
  const trajectory = analyzeTrajectory(actions);
  const violations = actions.flatMap((action) => action.classes.filter((item) => !allowed.has(item)).map((item) => ({ action, item })));
  results.push(result("authority_action", "authorized-action-classes", "observed action boundary", `${actions.length} observed tool call(s)`, violations.length ? "contradicted" : "verified",
    violations.length
      ? violations.slice(0, 20).map(({ action, item }) => `#${action.sequence} ${action.toolName}: ${item}`).join("; ")
      : `${actions.length} observed tool call(s) classified only into allowedActions`));

  if (contract.maxToolCalls !== undefined) {
    const exceeded = actions.length > contract.maxToolCalls;
    results.push(result("authority_scope", "tool-call-budget", "observed tool-call budget", `${actions.length}/${contract.maxToolCalls} tool call(s)`, exceeded ? "contradicted" : "verified",
      exceeded ? `observed ${actions.length} tool calls; contract permits at most ${contract.maxToolCalls}` : `observed tool calls stayed within the ${contract.maxToolCalls} call limit`));
  }
  if (contract.maxFailedToolCalls !== undefined) {
    const failed = trajectory.failedToolCalls;
    const exceeded = failed > contract.maxFailedToolCalls;
    results.push(result("authority_scope", "failed-tool-call-budget", "observed failed-tool-call budget", `${failed}/${contract.maxFailedToolCalls} failed tool call(s)`, exceeded ? "contradicted" : "verified",
      exceeded ? `observed ${failed} failed tool calls; contract permits at most ${contract.maxFailedToolCalls}` : `observed failed tool calls stayed within the ${contract.maxFailedToolCalls} failure limit`));
  }
  if (contract.maxIdenticalToolCalls !== undefined) {
    const observed = trajectory.maxIdenticalToolCalls;
    const exceeded = observed > contract.maxIdenticalToolCalls;
    results.push(result("authority_scope", "identical-tool-call-budget", "identical observed tool-call budget", `${observed}/${contract.maxIdenticalToolCalls} identical call(s)`, exceeded ? "contradicted" : "verified",
      exceeded ? `one exact observed tool action repeated ${observed} times; contract permits at most ${contract.maxIdenticalToolCalls}` : `identical observed tool calls stayed within the ${contract.maxIdenticalToolCalls} call limit`));
  }
  if (contract.maxConsecutiveFailedToolCalls !== undefined) {
    const observed = trajectory.maxConsecutiveFailedToolCalls;
    const exceeded = observed > contract.maxConsecutiveFailedToolCalls;
    results.push(result("authority_scope", "consecutive-failure-budget", "consecutive failed tool-call budget", `${observed}/${contract.maxConsecutiveFailedToolCalls} consecutive failure(s)`, exceeded ? "contradicted" : "verified",
      exceeded ? `observed a streak of ${observed} failed tool calls; contract permits at most ${contract.maxConsecutiveFailedToolCalls}` : `consecutive failed tool calls stayed within the ${contract.maxConsecutiveFailedToolCalls} failure limit`));
  }
  if (contract.maxObservedTokens !== undefined) {
    const observed = transcript.usage?.totalTokens;
    if (observed === undefined) {
      results.push(result("authority_scope", "observed-token-budget", "observed token budget", `unknown/${contract.maxObservedTokens} tokens`, "unverifiable", "the transcript adapter exposed no token accounting, so the declared token budget cannot be checked", { blocksPass: true }));
    } else {
      const exceeded = observed > contract.maxObservedTokens;
      results.push(result("authority_scope", "observed-token-budget", "observed token budget", `${observed}/${contract.maxObservedTokens} tokens`, exceeded ? "contradicted" : "verified",
        exceeded ? `observed ${observed} tokens; contract permits at most ${contract.maxObservedTokens}` : `observed tokens stayed within the ${contract.maxObservedTokens} token limit`));
    }
  }
  if (contract.maxTokensWithoutObservedProgress !== undefined) {
    const observed = transcript.usage?.totalTokens;
    if (observed === undefined) {
      results.push(result("authority_scope", "no-progress-token-budget", "token spend without an observed write, test, build, or commit", `unknown/${contract.maxTokensWithoutObservedProgress} tokens`, "unverifiable", "the transcript adapter exposed no token accounting, so the no-progress token limit cannot be checked", { blocksPass: true }));
    } else {
      const exceeded = trajectory.progressBearingActions === 0 && observed > contract.maxTokensWithoutObservedProgress;
      results.push(result("authority_scope", "no-progress-token-budget", "token spend without an observed write, test, build, or commit", `${observed} tokens · ${trajectory.progressBearingActions} progress-bearing action(s)`, exceeded ? "contradicted" : "verified",
        exceeded ? `observed ${observed} tokens without a repository write, test, build, or commit; contract permits at most ${contract.maxTokensWithoutObservedProgress}` : trajectory.progressBearingActions ? `${trajectory.progressBearingActions} progress-bearing action(s) were observed; this whole-session guard does not claim every intermediate token created progress` : `no progress-bearing action was observed, but token usage stayed within ${contract.maxTokensWithoutObservedProgress}`));
    }
  }

  const unknown = actions.filter((action) => action.classes.includes("unknown_effect"));
  if (unknown.length && allowed.has("unknown_effect")) {
    results.push(result("authority_action", "unknown-action-risk", "unclassified observed effects", `${unknown.length} unknown action(s)`, "unverifiable", `unknown_effect was explicitly allowed, so ${unknown.length} action(s) cannot be meaningfully bounded`, { blocksPass: true }));
  }
  if (contract.requireCompleteToolResults !== false) {
    const incomplete = actions.filter((action) => !action.completed);
    results.push(result("telemetry", "complete-tool-results", "tool-result completeness", `${actions.length - incomplete.length}/${actions.length} completed`, incomplete.length ? "unverifiable" : "verified",
      incomplete.length ? `missing results for tool call(s): ${incomplete.map((action) => action.toolCallId).join(", ")}` : "every observed tool call has a recorded result", incomplete.length ? { blocksPass: true } : {}));
  }
  return { results, actions };
}

export function authorityContractTemplate(): string {
  const value: AuthorityContract = {
    schemaVersion: 1,
    taskId: "REPLACE_WITH_TASK_OR_TICKET_ID",
    allowedChangePaths: ["src/**", "test/**", "docs/**"],
    deniedChangePaths: [".github/workflows/**", ".env*", "**/*.pem", "**/*.key"],
    allowedActions: ["repository_read", "repository_write", "test_execute", "build_execute"],
    requireCompleteToolResults: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}
