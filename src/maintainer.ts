import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import type { MaintainerPolicy } from "./config.ts";
import type { CheckResult, ClaimKind, Verdict } from "./report.ts";

export type PullRequestEvidence = {
  author: string;
  body: string;
  baseSha?: string;
  headSha?: string;
};

const DEFAULT_TEST_PATTERNS = ["test/**", "tests/**", "__tests__/**", "**/*.test.*", "**/*.spec.*"];
const MAX_COMMAND_OUTPUT = 12_000;

function result(kind: ClaimKind, ruleId: string, subject: string, quote: string, verdict: Verdict, evidence: string, options: Pick<CheckResult, "contributesToPass" | "blocksPass"> = {}): CheckResult {
  return { claim: { kind, subject, quote }, ruleId, verdict, evidence, ...options };
}

export function loadPullRequestEvidence(path: string): PullRequestEvidence {
  const size = statSync(path).size;
  if (size > 2 * 1024 * 1024) throw new Error(`pull request event is ${size} bytes; maximum is ${2 * 1024 * 1024}`);
  let event: any;
  try { event = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`pull request event is not valid JSON: ${path}`); }
  if (!event?.pull_request || typeof event.pull_request !== "object") throw new Error("event does not contain a pull_request object");
  const author = event.pull_request.user?.login;
  const body = event.pull_request.body;
  if (typeof author !== "string" || !author.trim()) throw new Error("pull request event does not identify the author");
  if (body !== null && body !== undefined && typeof body !== "string") throw new Error("pull request body must be text");
  return {
    author,
    body: body ?? "",
    ...(typeof event.pull_request.base?.sha === "string" ? { baseSha: event.pull_request.base.sha } : {}),
    ...(typeof event.pull_request.head?.sha === "string" ? { headSha: event.pull_request.head.sha } : {}),
  };
}

function capture(body: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`^\\s*-\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, "im"))?.[1]?.trim();
}

function checked(body: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*-\\s*\\[[xX]\\]\\s*${escaped}\\s*$`, "im").test(body);
}

export function checkAttestations(evidence: PullRequestEvidence, policy: MaintainerPolicy): CheckResult[] {
  const out: CheckResult[] = [];
  if (policy.requireHumanAttestation !== false) {
    const responsible = capture(evidence.body, "Responsible human");
    const normalized = responsible?.replace(/^@/, "").toLowerCase();
    const matches = normalized === evidence.author.toLowerCase();
    out.push(result("policy_attestation", "responsible-human", "named responsible human", responsible ?? "missing", matches ? "verified" : "contradicted",
      matches
        ? `PR author @${evidence.author} made the required responsibility declaration; this verifies attribution, not understanding`
        : responsible ? `declared ${responsible}, but the GitHub event identifies @${evidence.author} as the PR author` : "required `Responsible human: @login` declaration is missing"));
    for (const label of ["I reviewed every changed line.", "I can explain and maintain this change."]) {
      const present = checked(evidence.body, label);
      out.push(result("policy_attestation", label.startsWith("I reviewed") ? "human-review-attestation" : "human-maintenance-attestation", label, present ? "checked" : "missing", present ? "verified" : "contradicted",
        present ? "required human declaration is checked; Agent Vigil does not independently prove the declarant's understanding" : `required checked declaration is missing: ${label}`));
    }
  }
  if (policy.requireAiDisclosure !== false) {
    const disclosure = capture(evidence.body, "AI assistance")?.toLowerCase();
    const allowed = new Set(["none", "assisted", "agent"]);
    out.push(result("policy_attestation", "ai-assistance-disclosure", "AI assistance disclosure", disclosure ?? "missing", disclosure !== undefined && allowed.has(disclosure) ? "verified" : "contradicted",
      disclosure !== undefined && allowed.has(disclosure) ? `declared ${disclosure}` : "use exactly one of: none, assisted, agent"));
  }
  if (policy.requireLinkedIssue) {
    const issue = capture(evidence.body, "Linked issue");
    const valid = Boolean(issue && /(?:^|\s)(?:#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+)(?:\s|$)/i.test(issue));
    out.push(result("policy_attestation", "linked-issue", "linked approved issue", issue ?? "missing", valid ? "verified" : "contradicted",
      valid ? `declared ${issue}; syntax is verified, but issue approval/state is not fetched` : "provide `#123` or a full GitHub issue URL"));
  }
  return out;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }).trim();
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { source += "(?:.*/)?"; index += 2; }
      else { source += ".*"; index += 1; }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function pathMatches(path: string, patterns: string[]): boolean {
  const clean = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return patterns.some((pattern) => globRegex(pattern.replaceAll("\\", "/").replace(/^\.\//, "")).test(clean));
}

export type DiffEvidence = {
  paths: string[];
  testPaths: string[];
  changedLines?: number;
  binaryPaths: string[];
};

export function collectDiffEvidence(repo: string, base: string, head: string, testPathPatterns = DEFAULT_TEST_PATTERNS): DiffEvidence {
  const paths = git(repo, ["diff", "--name-only", "--diff-filter=ACMR", `${base}..${head}`]).split("\n").filter(Boolean);
  const binaryPaths: string[] = [];
  let changedLines = 0;
  const numstat = git(repo, ["diff", "--numstat", `${base}..${head}`]);
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, removed, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (added === "-" || removed === "-") binaryPaths.push(path);
    else changedLines += Number(added) + Number(removed);
  }
  return { paths, testPaths: paths.filter((path) => pathMatches(path, testPathPatterns)), ...(binaryPaths.length ? {} : { changedLines }), binaryPaths };
}

export function checkChangeScope(diff: DiffEvidence, policy: MaintainerPolicy): CheckResult[] {
  const out: CheckResult[] = [];
  if (policy.maxChangedFiles !== undefined) {
    out.push(result("change_scope", "changed-file-budget", "changed-file budget", `${diff.paths.length} changed files`, diff.paths.length <= policy.maxChangedFiles ? "verified" : "contradicted",
      `${diff.paths.length} changed file(s); policy maximum is ${policy.maxChangedFiles}`));
  }
  if (policy.maxChangedLines !== undefined) {
    if (diff.changedLines === undefined) out.push(result("change_scope", "changed-line-budget", "changed-line budget", "binary diff present", "unverifiable", `Git numstat cannot quantify binary path(s): ${diff.binaryPaths.join(", ")}`, { blocksPass: true }));
    else out.push(result("change_scope", "changed-line-budget", "changed-line budget", `${diff.changedLines} changed lines`, diff.changedLines <= policy.maxChangedLines ? "verified" : "contradicted",
      `${diff.changedLines} added/deleted line(s); policy maximum is ${policy.maxChangedLines}`));
  }
  if (policy.requireTestChange) {
    out.push(result("change_scope", "test-change-required", "changed test evidence", diff.testPaths.join(", ") || "none", diff.testPaths.length ? "verified" : "contradicted",
      diff.testPaths.length ? `${diff.testPaths.length} changed test path(s): ${diff.testPaths.join(", ")}` : "no changed path matched the policy testPathPatterns"));
  }
  if (policy.protectedPaths?.length) {
    const matches = diff.paths.filter((path) => pathMatches(path, policy.protectedPaths!));
    out.push(result("change_scope", "protected-path", "protected path policy", matches.join(", ") || "none", matches.length ? "contradicted" : "verified",
      matches.length ? `candidate changed protected path(s): ${matches.join(", ")}` : "no candidate path matched protectedPaths", { contributesToPass: false }));
  }
  return out;
}

type CommandOutcome = { status: number | null; signal: string | null; output: string; error?: string };

function shell(command: string, cwd: string, timeoutMs: number): CommandOutcome {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "true" };
  delete env.NODE_TEST_CONTEXT;
  const execution = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env });
  const full = `${execution.stdout ?? ""}${execution.stderr ?? ""}`;
  const output = full.length > MAX_COMMAND_OUTPUT ? `${full.slice(0, MAX_COMMAND_OUTPUT)}\n[output truncated]` : full;
  return { status: execution.status, signal: execution.signal, output, ...(execution.error ? { error: execution.error.message } : {}) };
}

function unsafeOverlayPath(path: string): boolean {
  const clean = normalize(path);
  return clean === ".." || clean.startsWith(`..${sep}`) || resolve("/safe", clean) === "/safe";
}

function overlayTests(headWorktree: string, baseWorktree: string, paths: string[]): string | undefined {
  for (const path of paths) {
    if (unsafeOverlayPath(path)) return `unsafe overlay path: ${path}`;
    const source = resolve(headWorktree, path);
    const target = resolve(baseWorktree, path);
    if (!source.startsWith(`${resolve(headWorktree)}${sep}`) || !target.startsWith(`${resolve(baseWorktree)}${sep}`)) return `overlay escaped worktree: ${path}`;
    if (!existsSync(source)) continue;
    if (lstatSync(source).isSymbolicLink()) return `refusing to overlay symlink test path: ${path}`;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, force: true });
  }
  return undefined;
}

function summarize(outcome: CommandOutcome): string {
  const last = outcome.output.trim().split("\n").slice(-3).join(" | ");
  return `exit=${outcome.status ?? "none"}${outcome.signal ? ` signal=${outcome.signal}` : ""}${outcome.error ? ` error=${outcome.error}` : ""}${last ? ` output=${last}` : ""}`;
}

export function checkDifferentialTest(repo: string, base: string, head: string, testPaths: string[], policy: NonNullable<MaintainerPolicy["differentialTest"]>): CheckResult {
  if (policy.overlayChangedTests !== false && testPaths.length === 0) {
    return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "contradicted", "no changed test artifact is available to exercise against the base source");
  }
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-differential-"));
  const baseWorktree = join(root, "base");
  const headWorktree = join(root, "head");
  const timeoutMs = (policy.timeoutSeconds ?? 300) * 1000;
  let baseAdded = false;
  let headAdded = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", baseWorktree, base], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] }); baseAdded = true;
    execFileSync("git", ["worktree", "add", "--detach", headWorktree, head], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] }); headAdded = true;
    if (policy.overlayChangedTests !== false) {
      const error = overlayTests(headWorktree, baseWorktree, testPaths);
      if (error) return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "unverifiable", error, { blocksPass: true });
    }
    if (policy.setupCommand) {
      const headSetup = shell(policy.setupCommand, headWorktree, timeoutMs);
      const baseSetup = shell(policy.setupCommand, baseWorktree, timeoutMs);
      if (headSetup.status !== 0 || baseSetup.status !== 0) {
        return result("differential_test", "differential-setup", "isolated differential setup", policy.setupCommand, "unverifiable",
          `setup did not succeed in both isolated worktrees; head ${summarize(headSetup)}; base ${summarize(baseSetup)}`, { blocksPass: true });
      }
    }
    const headOutcome = shell(policy.command, headWorktree, timeoutMs);
    const baseOutcome = shell(policy.command, baseWorktree, timeoutMs);
    if (headOutcome.status === null || baseOutcome.status === null || headOutcome.signal || baseOutcome.signal || headOutcome.error || baseOutcome.error) {
      return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "unverifiable",
        `command did not terminate normally in both worktrees; head ${summarize(headOutcome)}; base ${summarize(baseOutcome)}`, { blocksPass: true });
    }
    if (headOutcome.status !== 0) {
      return result("differential_test", "differential-head-pass", "candidate passes changed regression test", policy.command, "contradicted", `candidate command failed; ${summarize(headOutcome)}`);
    }
    if (baseOutcome.status === 0) {
      return result("differential_test", "differential-base-fail", "base fails changed regression test", policy.command, "contradicted",
        "the changed test command also passed against the base source; the test does not demonstrate the claimed regression");
    }
    if (policy.baseFailurePattern && !new RegExp(policy.baseFailurePattern).test(baseOutcome.output)) {
      return result("differential_test", "differential-failure-pattern", "base failure matches expected regression", policy.baseFailurePattern, "contradicted",
        `base failed, but output did not match the trusted failure pattern; ${summarize(baseOutcome)}`);
    }
    return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "verified",
      `isolated candidate passed and base source failed with the candidate's changed test artifact(s): ${testPaths.join(", ")}`);
  } catch (error) {
    return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "unverifiable", `could not create isolated Git worktrees: ${(error as Error).message}`, { blocksPass: true });
  } finally {
    if (headAdded) { try { execFileSync("git", ["worktree", "remove", "--force", headWorktree], { cwd: repo, stdio: "ignore" }); } catch {} }
    if (baseAdded) { try { execFileSync("git", ["worktree", "remove", "--force", baseWorktree], { cwd: repo, stdio: "ignore" }); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
}

export function buildMaintainerChecks(repo: string, base: string, head: string, evidence: PullRequestEvidence, policy: MaintainerPolicy): CheckResult[] {
  const patterns = policy.testPathPatterns ?? DEFAULT_TEST_PATTERNS;
  const diff = collectDiffEvidence(repo, base, head, patterns);
  const checks = [...checkAttestations(evidence, policy), ...checkChangeScope(diff, policy)];
  if (policy.differentialTest) checks.push(checkDifferentialTest(repo, base, head, diff.testPaths, policy.differentialTest));
  return checks;
}
