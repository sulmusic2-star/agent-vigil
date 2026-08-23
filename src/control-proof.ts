import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildAuthorityPlan } from "./authority-plan.ts";
import { checkIntegrity } from "./detectors/reality.ts";
import { routeIntegrity } from "./integrity-policy.ts";
import { canonical } from "./report.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export type ControlProofExpected = "PASS" | "BLOCK" | "HOLD";
export type ControlProofActual = ControlProofExpected | "ERROR";

export type ControlProofChallenge = {
  id: string;
  claim: string;
  expected: ControlProofExpected;
  actual: ControlProofActual;
  passed: boolean;
  base: string;
  head: string;
  evidence: string;
};

export type ControlProofReport = {
  schemaVersion: "agent-vigil-control-proof/v1";
  vigilVersion: string;
  status: "PASS" | "HOLD";
  sourceCommit: string;
  generatedAt: string;
  receiptHash: string;
  challenges: ControlProofChallenge[];
  summary: { passed: number; total: number };
  reproduction: string;
  limits: string[];
};

type ChallengeResult = Pick<ControlProofChallenge, "actual" | "base" | "head" | "evidence">;

const FIXED_COMMIT_EPOCH = Date.parse("2000-01-01T00:00:00Z") / 1000;

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env } : {}),
  }).trim();
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function safeError(error: unknown, redactions: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of redactions.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(value, value.includes("control-proof-") ? "<temporary-directory>" : "<source-repository>");
  }
  return terminalSafe(message.replace(/\s+/g, " ").slice(0, 400));
}

function assertDisposableClone(root: string, repo: string): void {
  const realRoot = realpathSync(root);
  const realRepo = realpathSync(repo);
  if (!realRepo.startsWith(`${realRoot}${sep}`) || !existsSync(join(realRepo, ".git"))) {
    throw new Error("refused to mutate a directory outside the disposable control-proof clone");
  }
}

function resetClone(root: string, repo: string, sourceCommit: string): void {
  assertDisposableClone(root, repo);
  git(repo, ["reset", "--hard", sourceCommit]);
  git(repo, ["clean", "-fdx"]);
}

function safeWrite(repo: string, gitPath: string, content: string): void {
  if (!gitPath || isAbsolute(gitPath) || gitPath.includes("\\")) throw new Error("control-proof path must be repository-relative");
  const target = resolve(repo, gitPath);
  const fromRoot = relative(resolve(repo), target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("control-proof path escaped the clone");

  let current = resolve(repo);
  for (const part of dirname(fromRoot).split(sep).filter((item) => item && item !== ".")) {
    current = join(current, part);
    if (existsSync(current) && (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())) {
      rmSync(current, { recursive: true, force: true });
    }
    mkdirSync(current, { recursive: true });
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
}

function commit(repo: string, message: string, sequence: number): string {
  git(repo, ["add", "-A"]);
  if (!git(repo, ["status", "--porcelain=v1"])) throw new Error(`challenge produced no Git change: ${message}`);
  const epoch = String(FIXED_COMMIT_EPOCH + sequence);
  git(repo, ["commit", "-qm", message], {
    ...process.env,
    GIT_AUTHOR_DATE: epoch,
    GIT_COMMITTER_DATE: epoch,
  });
  return git(repo, ["rev-parse", "HEAD"]);
}

export function decideControlProof(challenges: ControlProofChallenge[]): "PASS" | "HOLD" {
  return challenges.length > 0 && challenges.every((challenge) => challenge.passed) ? "PASS" : "HOLD";
}

export function buildControlProof(repo: string, base: string, vigilVersion: string): ControlProofReport {
  const sourceRepo = realpathSync(resolve(repo));
  const sourceCommit = git(sourceRepo, ["rev-parse", "--verify", `${base}^{commit}`]);
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-control-proof-"));
  const clone = join(root, "repo");
  const challenges: ControlProofChallenge[] = [];
  let commitSequence = 1;

  const runChallenge = (
    id: string,
    claim: string,
    expected: ControlProofExpected,
    execute: () => ChallengeResult,
  ): void => {
    try {
      const result = execute();
      challenges.push({ id, claim, expected, ...result, passed: result.actual === expected });
    } catch (error) {
      challenges.push({
        id,
        claim,
        expected,
        actual: "ERROR",
        passed: false,
        base: sourceCommit,
        head: sourceCommit,
        evidence: safeError(error, [sourceRepo, root, clone]),
      });
    }
  };

  try {
    execFileSync("git", ["clone", "--quiet", "--no-local", "--no-checkout", sourceRepo, clone], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    assertDisposableClone(root, clone);
    git(clone, ["checkout", "--quiet", "--detach", sourceCommit]);
    git(clone, ["config", "user.email", "control-proof@agent-vigil.invalid"]);
    git(clone, ["config", "user.name", "Agent Vigil Control Proof"]);

    runChallenge("clean-control", "An unchanged authority surface is allowed.", "PASS", () => {
      resetClone(root, clone, sourceCommit);
      const plan = buildAuthorityPlan(clone, sourceCommit, sourceCommit, vigilVersion);
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: `${plan.summary.changes} authority changes and ${plan.summary.holds} held decisions`,
      };
    });

    runChallenge("unapproved-mcp-server", "A new repository MCP server is blocked.", "BLOCK", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, ".mcp.json", `${JSON.stringify({ mcpServers: { "agent-vigil-control-probe": { command: "node", args: ["probe.mjs"] } } }, null, 2)}\n`);
      const head = commit(clone, "control proof: add unapproved MCP server", commitSequence++);
      const plan = buildAuthorityPlan(clone, sourceCommit, head, vigilVersion);
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: `${plan.summary.blocking} blocking authority change(s); ${plan.deltas.filter((item) => item.disposition === "BLOCK").map((item) => item.summary).join(", ") || "none"}`,
      };
    });

    runChallenge("candidate-self-approval", "A candidate cannot approve its own authority expansion.", "BLOCK", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, ".mcp.json", `${JSON.stringify({ mcpServers: { "agent-vigil-self-approval-probe": { command: "node", args: ["self-approval-probe.mjs"] } } }, null, 2)}\n`);
      const expansionHead = commit(clone, "control proof: stage self-approved authority", commitSequence++);
      const expansion = buildAuthorityPlan(clone, sourceCommit, expansionHead, vigilVersion);
      const approvalKeys = expansion.deltas.filter((item) => item.disposition === "BLOCK").map((item) => item.approvalKey);
      if (!approvalKeys.length) throw new Error("the planted authority expansion did not produce an approval key");
      safeWrite(clone, ".agent-vigil-authority-plan.json", `${JSON.stringify({ schemaVersion: 1, approvedAdditions: approvalKeys, allowUnknownChanges: true }, null, 2)}\n`);
      const head = commit(clone, "control proof: candidate attempts self approval", commitSequence++);
      const plan = buildAuthorityPlan(clone, sourceCommit, head, vigilVersion);
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: `${plan.summary.blocking} planted expansion(s) remained blocked; policy source: ${plan.policy.source}`,
      };
    });

    runChallenge("unreadable-authority-config", "An unreadable supported authority file stays on hold.", "HOLD", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, ".codex/config.toml", 'sandbox_mode = "unterminated\n');
      const head = commit(clone, "control proof: add unreadable authority config", commitSequence++);
      const plan = buildAuthorityPlan(clone, sourceCommit, head, vigilVersion);
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: `${plan.summary.holds} held decision(s); ${plan.gaps.map((item) => item.reason).join(", ") || "no evidence gap recorded"}`,
      };
    });

    runChallenge("sandbox-weakening", "A weaker Codex sandbox setting is blocked.", "BLOCK", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, ".codex/config.toml", 'sandbox_mode = "workspace-write"\n');
      const baseline = commit(clone, "control proof: create sandbox baseline", commitSequence++);
      safeWrite(clone, ".codex/config.toml", 'sandbox_mode = "danger-full-access"\n');
      const head = commit(clone, "control proof: weaken sandbox", commitSequence++);
      const plan = buildAuthorityPlan(clone, baseline, head, vigilVersion);
      const sandbox = plan.deltas.find((item) => item.after?.action === "sandbox.mode" || item.before?.action === "sandbox.mode");
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: sandbox ? `${sandbox.summary}; ${sandbox.reason}` : "no sandbox change found",
      };
    });

    runChallenge("skipped-test", "A newly skipped test is blocked by the calibrated integrity policy.", "BLOCK", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, "agent-vigil-control-proof.test.ts", 'import test from "node:test";\ntest.skip("planted control proof", () => { throw new Error("must not run"); });\n');
      const head = commit(clone, "control proof: skip a test", commitSequence++);
      const routed = routeIntegrity(checkIntegrity(clone, sourceCommit, head), "calibrated");
      const blocking = routed.results.filter((item) => item.verdict === "contradicted");
      const actual: ControlProofActual = blocking.length ? "BLOCK" : routed.results.some((item) => item.verdict === "unverifiable") ? "HOLD" : "PASS";
      return {
        actual,
        base: sourceCommit,
        head,
        evidence: blocking.map((item) => item.ruleId ?? "unlabeled-integrity-rule").join(", ") || "no calibrated blocking rule fired",
      };
    });
  } catch (error) {
    challenges.push({
      id: "disposable-environment",
      claim: "The disposable control-proof repository can be created safely.",
      expected: "PASS",
      actual: "ERROR",
      passed: false,
      base: sourceCommit,
      head: sourceCommit,
      evidence: safeError(error, [sourceRepo, root, clone]),
    });
  }

  try {
    rmSync(root, { recursive: true, force: true });
    challenges.push({
      id: "disposable-cleanup",
      claim: "The disposable repository is removed after the challenge run.",
      expected: "PASS",
      actual: existsSync(root) ? "ERROR" : "PASS",
      passed: !existsSync(root),
      base: sourceCommit,
      head: sourceCommit,
      evidence: existsSync(root) ? "temporary control-proof directory still exists" : "temporary control-proof directory removed",
    });
  } catch (error) {
    challenges.push({
      id: "disposable-cleanup",
      claim: "The disposable repository is removed after the challenge run.",
      expected: "PASS",
      actual: "ERROR",
      passed: false,
      base: sourceCommit,
      head: sourceCommit,
      evidence: safeError(error, [sourceRepo, root, clone]),
    });
  }

  const reproduction = `vigil prove --repo . --base ${sourceCommit}`;
  const limits = [
    "Challenges the installed Agent Vigil authority and test-integrity controls in a disposable local clone.",
    "Does not prove that a GitHub ruleset requires the check or that branch protection cannot be changed.",
    "Does not exercise every detector, a live coding agent, runtime IAM, deployments, or third-party services.",
    "Uses only local repository paths and does not push a branch or modify the source repository; installed Git and its configuration remain trusted.",
  ];
  const status = decideControlProof(challenges);
  const payload = {
    schemaVersion: "agent-vigil-control-proof/v1" as const,
    vigilVersion,
    status,
    sourceCommit,
    generatedAt: new Date().toISOString(),
    challenges,
    summary: { passed: challenges.filter((item) => item.passed).length, total: challenges.length },
    reproduction,
    limits,
  };
  return {
    ...payload,
    receiptHash: digest(payload),
  };
}

export function renderControlProof(report: ControlProofReport): string {
  const lines = [
    `Agent Vigil control proof: ${report.status}`,
    `Source: ${report.sourceCommit}`,
    "",
  ];
  for (const challenge of report.challenges) {
    const marker = challenge.passed ? "✓" : "✗";
    lines.push(terminalSafe(`${marker} ${challenge.claim}`));
    if (!challenge.passed) lines.push(terminalSafe(`  expected ${challenge.expected}; observed ${challenge.actual}: ${challenge.evidence}`));
  }
  lines.push(
    "",
    `${report.summary.passed}/${report.summary.total} expected outcomes observed`,
    `${report.status} · ${report.receiptHash}`,
    `Reproduce: ${report.reproduction}`,
  );
  return lines.join("\n");
}
