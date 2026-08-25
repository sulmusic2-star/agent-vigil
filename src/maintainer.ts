import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { runCandidateCommand, type CandidateCommandOutcome } from "./candidate-command.ts";
import type { MaintainerPolicy } from "./config.ts";
import { checkTestHarnessBinding, classifyCandidateTestOutcome } from "./detectors/reality.ts";
import type { CheckResult, ClaimKind, Verdict } from "./report.ts";
import { trustedGit } from "./trusted-git.ts";

export type PullRequestEvidence = {
  author: string;
  body: string;
  baseSha?: string;
  headSha?: string;
};

const DEFAULT_TEST_PATTERNS = ["test/**", "tests/**", "__tests__/**", "**/*.test.*", "**/*.spec.*"];
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
  const humanReview = policy.reviewMode === "human" || (policy.reviewMode === undefined && policy.requireHumanAttestation !== false);
  if (humanReview) {
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
  return trustedGit(repo, args, 8 * 1024 * 1024).trim();
}

function gitRaw(repo: string, args: string[]): string {
  return trustedGit(repo, args, 8 * 1024 * 1024);
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
  const clean = path.replace(/^\.\//, "");
  return patterns.some((pattern) => globRegex(pattern.replaceAll("\\", "/").replace(/^\.\//, "")).test(clean));
}

export type DiffEvidence = {
  paths: string[];
  testPaths: string[];
  changedLines?: number;
  binaryPaths: string[];
};

export function collectDiffEvidence(repo: string, base: string, head: string, testPathPatterns = DEFAULT_TEST_PATTERNS): DiffEvidence {
  const paths = gitRaw(repo, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACMRD", `${base}..${head}`]).split("\0").filter(Boolean);
  const overlayablePaths = gitRaw(repo, ["diff", "--no-renames", "--name-only", "-z", "--diff-filter=ACMR", `${base}..${head}`]).split("\0").filter(Boolean);
  const binaryPaths: string[] = [];
  let changedLines = 0;
  const numstat = gitRaw(repo, ["diff", "--no-renames", "--numstat", "-z", `${base}..${head}`]);
  for (const record of numstat.split("\0").filter(Boolean)) {
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2 || secondTab === record.length - 1) {
      binaryPaths.push("[unparseable Git numstat record]");
      continue;
    }
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    if (added === "-" || removed === "-") binaryPaths.push(path);
    else if (/^\d+$/.test(added) && /^\d+$/.test(removed)) changedLines += Number(added) + Number(removed);
    else binaryPaths.push(`[unparseable Git numstat count for ${path}]`);
  }
  return { paths, testPaths: overlayablePaths.filter((path) => pathMatches(path, testPathPatterns)), ...(binaryPaths.length ? {} : { changedLines }), binaryPaths };
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

type CommandOutcome = CandidateCommandOutcome;

function unsafeOverlayPath(path: string): boolean {
  const clean = normalize(path);
  return clean === ".." || clean.startsWith(`..${sep}`) || resolve("/safe", clean) === "/safe";
}

type OverlayPlan = { path: string; source: string; target: string };

function lstatIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateOverlayRoot(root: string, role: "source" | "target"): string | undefined {
  const stats = lstatIfPresent(root);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return `unsafe ${role} worktree root for differential test overlay`;
  return undefined;
}

function validateOverlayAncestors(root: string, leaf: string, role: "source" | "target", path: string): string | undefined {
  const parts = relative(root, leaf).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stats = lstatIfPresent(current);
    if (!stats) return undefined;
    if (stats.isSymbolicLink()) return `refusing to overlay through symlink ${role} ancestor: ${path}`;
    if (!stats.isDirectory()) return `refusing to overlay through non-directory ${role} ancestor: ${path}`;
  }
  return undefined;
}

function validateOverlayLeaf(leaf: string, role: "source" | "target", path: string): string | undefined {
  const stats = lstatIfPresent(leaf);
  if (!stats) return undefined;
  if (stats.isSymbolicLink()) return role === "source"
    ? `refusing to overlay symlink test path: ${path}`
    : `refusing to replace symlink test path: ${path}`;
  if (!stats.isFile()) return role === "source"
    ? `refusing to overlay non-regular test path: ${path}`
    : `refusing to replace non-regular test path: ${path}`;
  return undefined;
}

function ensureOverlayDirectories(root: string, leaf: string, path: string): string | undefined {
  const parts = relative(root, dirname(leaf)).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let stats = lstatIfPresent(current);
    if (!stats) {
      try { mkdirSync(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stats = lstatIfPresent(current);
    }
    if (!stats || stats.isSymbolicLink()) return `refusing to overlay through symlink target ancestor: ${path}`;
    if (!stats.isDirectory()) return `refusing to overlay through non-directory target ancestor: ${path}`;
  }
  return undefined;
}

function overlayTests(headWorktree: string, baseWorktree: string, paths: string[]): string | undefined {
  const sourceRoot = resolve(headWorktree);
  const targetRoot = resolve(baseWorktree);
  const sourceRootError = validateOverlayRoot(sourceRoot, "source");
  if (sourceRootError) return sourceRootError;
  const targetRootError = validateOverlayRoot(targetRoot, "target");
  if (targetRootError) return targetRootError;
  const plan: OverlayPlan[] = [];

  for (const path of paths) {
    if (unsafeOverlayPath(path)) return `unsafe overlay path: ${path}`;
    const source = resolve(sourceRoot, path);
    const target = resolve(targetRoot, path);
    if (!source.startsWith(`${sourceRoot}${sep}`) || !target.startsWith(`${targetRoot}${sep}`)) return `overlay escaped worktree: ${path}`;
    const sourceAncestorError = validateOverlayAncestors(sourceRoot, source, "source", path);
    if (sourceAncestorError) return sourceAncestorError;
    const sourceError = validateOverlayLeaf(source, "source", path);
    if (sourceError) return sourceError;
    if (!lstatIfPresent(source)) return `overlay source is missing: ${path}`;
    const targetAncestorError = validateOverlayAncestors(targetRoot, target, "target", path);
    if (targetAncestorError) return targetAncestorError;
    const targetError = validateOverlayLeaf(target, "target", path);
    if (targetError) return targetError;
    plan.push({ path, source, target });
  }

  for (const item of plan) {
    const directoryError = ensureOverlayDirectories(targetRoot, item.target, item.path);
    if (directoryError) return directoryError;
    const sourceAncestorError = validateOverlayAncestors(sourceRoot, item.source, "source", item.path);
    if (sourceAncestorError) return sourceAncestorError;
    const sourceError = validateOverlayLeaf(item.source, "source", item.path);
    if (sourceError || !lstatIfPresent(item.source)) return sourceError ?? `overlay source disappeared before copy: ${item.path}`;
    const targetAncestorError = validateOverlayAncestors(targetRoot, item.target, "target", item.path);
    if (targetAncestorError) return targetAncestorError;
    const targetError = validateOverlayLeaf(item.target, "target", item.path);
    if (targetError) return targetError;
    cpSync(item.source, item.target, { force: true });
  }
  return undefined;
}

function summarize(outcome: CommandOutcome): string {
  const last = outcome.output.trim().split("\n").slice(-3).join(" | ");
  return `exit=${outcome.status ?? "none"}${outcome.signal ? ` signal=${outcome.signal}` : ""}${outcome.error ? ` error=${outcome.error}` : ""}${last ? ` output=${last}` : ""}`;
}

function trackedStatus(repo: string): string {
  return git(repo, ["status", "--porcelain=v1", "--untracked-files=no"]);
}

/**
 * Runs the commands selected by the trusted base policy in a detached checkout
 * of the exact candidate commit. This replaces a ceremonial checkbox with
 * reproducible evidence; it does not claim human understanding or ownership.
 */
export function checkAutomatedReview(repo: string, head: string, policy: NonNullable<MaintainerPolicy["automatedReview"]>, testCommand?: string): CheckResult[] {
  const out: CheckResult[] = [result(
    "policy_attestation",
    "automated-review-mode",
    "automated review policy",
    `${policy.commands.length} base-policy command(s)`,
    "verified",
    "the trusted base policy selected isolated automated review; this proves repeatable checks, not human understanding",
    { contributesToPass: false },
  )];
  const expectedHead = git(repo, ["rev-parse", head]);
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-automated-review-"));
  const candidate = join(root, "candidate");
  const timeoutMs = (policy.timeoutSeconds ?? 300) * 1000;
  let worktreeAdded = false;
  try {
    trustedGit(repo, ["worktree", "add", "--detach", candidate, expectedHead]);
    worktreeAdded = true;
    const initialHead = git(candidate, ["rev-parse", "HEAD"]);
    if (initialHead !== expectedHead) {
      out.push(result("integrity", "automated-review-head", "exact candidate checkout", expectedHead, "unverifiable",
        `isolated checkout resolved to ${initialHead} instead of ${expectedHead}`, { blocksPass: true }));
      return out;
    }
    if (policy.setupCommand) {
      const setup = runCandidateCommand(policy.setupCommand, candidate, timeoutMs, { allowNetwork: true, trustedSourceWorktree: true });
      if (setup.status === null || setup.signal || setup.error) {
        out.push(result("command_ran", "automated-review-setup", "automated review setup", policy.setupCommand, "unverifiable",
          `setup did not terminate normally; ${summarize(setup)}`, { blocksPass: true }));
        return out;
      }
      if (setup.status !== 0) {
        out.push(result("command_ran", "automated-review-setup", "automated review setup", policy.setupCommand, "contradicted",
          `base-policy setup command failed; ${summarize(setup)}`));
        return out;
      }
      out.push(result("command_ran", "automated-review-setup", "automated review setup", policy.setupCommand, "verified",
        "base-policy setup command completed in the isolated candidate checkout", { contributesToPass: false }));
    }
    const preparedHead = git(candidate, ["rev-parse", "HEAD"]);
    const preparedStatus = trackedStatus(candidate);
    if (preparedHead !== expectedHead) {
      out.push(result("integrity", "automated-review-head", "candidate commit remained fixed during setup", expectedHead, "unverifiable",
        `setup moved HEAD to ${preparedHead}`, { blocksPass: true }));
      return out;
    }
    if (preparedStatus) {
      out.push(result("integrity", "automated-review-worktree", "setup preserved tracked candidate files", "clean", "contradicted",
        `setup modified tracked path(s): ${preparedStatus.split("\n").join(", ")}`));
      return out;
    }
    for (const [index, command] of policy.commands.entries()) {
      const outcome = runCandidateCommand(command, candidate, timeoutMs, { trustedSourceWorktree: true });
      if (command === testCommand) {
        out.push(...classifyCandidateTestOutcome([{
          kind: "tests_pass",
          quote: "base policy requires the candidate test suite to pass",
          subject: "fresh candidate test suite",
        }], command, outcome));
      }
      const observedHead = git(candidate, ["rev-parse", "HEAD"]);
      const observedStatus = trackedStatus(candidate);
      const label = `automated review command ${index + 1}`;
      if (observedHead !== expectedHead) {
        out.push(result("integrity", "automated-review-head", label, command, "unverifiable",
          `command moved HEAD to ${observedHead}; expected ${expectedHead}`, { blocksPass: true }));
        return out;
      }
      if (observedStatus !== preparedStatus) {
        out.push(result("integrity", "automated-review-worktree", label, command, "contradicted",
          `command modified tracked path(s): ${observedStatus.split("\n").filter(Boolean).join(", ") || "previous tracked changes were removed"}`));
        return out;
      }
      if (outcome.status === null || outcome.signal || outcome.error) {
        out.push(result("command_ran", "automated-review-command", label, command, "unverifiable",
          `command did not terminate normally; ${summarize(outcome)}`, { blocksPass: true }));
        return out;
      }
      if (outcome.status !== 0) {
        out.push(result("command_ran", "automated-review-command", label, command, "contradicted",
          `base-policy command failed; ${summarize(outcome)}`));
        return out;
      }
      out.push(result("command_ran", "automated-review-command", label, command, "verified",
        `base-policy command exited 0 in an isolated checkout of ${expectedHead.slice(0, 12)}`));
    }
    return out;
  } catch (error) {
    out.push(result("integrity", "automated-review-worktree", "isolated automated review checkout", expectedHead, "unverifiable",
      `could not run isolated automated review: ${(error as Error).message}`, { blocksPass: true }));
    return out;
  } finally {
    if (worktreeAdded) { try { trustedGit(repo, ["worktree", "remove", "--force", candidate]); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
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
    trustedGit(repo, ["worktree", "add", "--detach", baseWorktree, base]); baseAdded = true;
    trustedGit(repo, ["worktree", "add", "--detach", headWorktree, head]); headAdded = true;
    if (policy.overlayChangedTests !== false) {
      const error = overlayTests(headWorktree, baseWorktree, testPaths);
      if (error) return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "unverifiable", error, { blocksPass: true });
    }
    if (policy.setupCommand) {
      const headSetup = runCandidateCommand(policy.setupCommand, headWorktree, timeoutMs, { allowNetwork: true, trustedSourceWorktree: true });
      const baseSetup = runCandidateCommand(policy.setupCommand, baseWorktree, timeoutMs, {
        allowNetwork: true, trustedSourceWorktree: true, overlayPaths: testPaths,
      });
      if (headSetup.status !== 0 || baseSetup.status !== 0 || headSetup.signal || baseSetup.signal || headSetup.error || baseSetup.error) {
        return result("differential_test", "differential-setup", "isolated differential setup", policy.setupCommand, "unverifiable",
          `setup did not succeed in both isolated worktrees; head ${summarize(headSetup)}; base ${summarize(baseSetup)}`, { blocksPass: true });
      }
    }
    const headOutcome = runCandidateCommand(policy.command, headWorktree, timeoutMs, { trustedSourceWorktree: true });
    const baseOutcome = runCandidateCommand(policy.command, baseWorktree, timeoutMs, {
      trustedSourceWorktree: true, overlayPaths: testPaths,
    });
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
    if (headAdded) { try { trustedGit(repo, ["worktree", "remove", "--force", headWorktree]); } catch {} }
    if (baseAdded) { try { trustedGit(repo, ["worktree", "remove", "--force", baseWorktree]); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
}

export function buildMaintainerChecks(repo: string, base: string, head: string, evidence: PullRequestEvidence, policy: MaintainerPolicy, testCommand?: string): CheckResult[] {
  const patterns = policy.testPathPatterns ?? DEFAULT_TEST_PATTERNS;
  const diff = collectDiffEvidence(repo, base, head, patterns);
  const checks = [...checkAttestations(evidence, policy), ...checkChangeScope(diff, policy)];
  if (policy.differentialTest || (policy.reviewMode === "automated" && policy.automatedReview)) {
    const harnessCommands = [
      ...(policy.differentialTest ? [policy.differentialTest.command] : []),
      ...(policy.reviewMode === "automated" && policy.automatedReview ? policy.automatedReview.commands : []),
      ...(testCommand ? [testCommand] : []),
    ];
    const setupCommands = [
      ...(policy.differentialTest?.setupCommand ? [policy.differentialTest.setupCommand] : []),
      ...(policy.reviewMode === "automated" && policy.automatedReview?.setupCommand ? [policy.automatedReview.setupCommand] : []),
    ];
    const harness = checkTestHarnessBinding(
      repo,
      base,
      head,
      [...new Set(harnessCommands)],
      process.env.AGENT_VIGIL_INTERNAL_ISOLATE_CANDIDATE === "true",
      [...new Set(setupCommands)],
    );
    checks.push(harness);
    if (harness.verdict !== "verified") return checks;
  }
  if (policy.differentialTest) checks.push(checkDifferentialTest(repo, base, head, diff.testPaths, policy.differentialTest));
  if (policy.reviewMode === "automated" && policy.automatedReview) checks.push(...checkAutomatedReview(repo, head, policy.automatedReview, testCommand));
  return checks;
}
