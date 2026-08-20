// Deterministic reality checks. Each takes claims + a repo path and returns
// CheckResults. No model calls; everything here is reproducible byte-for-byte.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim, CheckResult } from "../report.ts";

function git(repo: string, args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

/** Paths the session actually touched: staged, unstaged, and last-commit. */
export function touchedPaths(repo: string): Set<string> {
  const out = new Set<string>();
  for (const line of git(repo, "status --porcelain").split("\n")) {
    const p = line.slice(3).trim();
    if (p) out.add(p.replace(/^"|"$/g, ""));
  }
  for (const p of git(repo, "diff --name-only HEAD~1..HEAD 2>/dev/null").split("\n")) {
    if (p.trim()) out.add(p.trim());
  }
  return out;
}

export function checkPathsExist(claims: Claim[], repo: string): CheckResult[] {
  return claims
    .filter((c) => c.kind === "path_exists")
    .map((c) => {
      const exists = existsSync(join(repo, c.subject));
      return {
        claim: c,
        verdict: exists ? ("verified" as const) : ("contradicted" as const),
        evidence: exists
          ? `${c.subject} exists in the repo`
          : `${c.subject} does not exist — the narrative references a path that is not there`,
      };
    });
}

export function checkFilesChanged(claims: Claim[], repo: string): CheckResult[] {
  const touched = touchedPaths(repo);
  const touchedList = [...touched];
  return claims
    .filter((c) => c.kind === "file_changed")
    .map((c) => {
      // exact or suffix match (narratives often shorten leading dirs)
      const hit =
        touched.has(c.subject) ||
        touchedList.some((t) => t.endsWith(c.subject) || c.subject.endsWith(t));
      if (hit) {
        return { claim: c, verdict: "verified" as const, evidence: `${c.subject} appears in git's changed files` };
      }
      const exists = existsSync(join(repo, c.subject));
      return {
        claim: c,
        verdict: exists ? ("unverifiable" as const) : ("contradicted" as const),
        evidence: exists
          ? `${c.subject} exists but shows no changes in git (claim may predate the last commit window)`
          : `${c.subject} was claimed as changed but does not exist in the repo`,
      };
    });
}

/** Rerun the repo's own test command and compare with the "tests pass" claim. */
export function checkTestsPass(
  claims: Claim[],
  repo: string,
  testCmd?: string,
): CheckResult[] {
  const testClaims = claims.filter((c) => c.kind === "tests_pass");
  if (testClaims.length === 0) return [];
  const cmd = testCmd ?? inferTestCommand(repo);
  if (!cmd) {
    return testClaims.map((c) => ({
      claim: c,
      verdict: "unverifiable" as const,
      evidence: "no test command found (no package.json test script / pytest / cargo) — pass --test-cmd to check this claim",
    }));
  }
  let passed = false;
  let tail = "";
  try {
    tail = execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
    passed = true;
  } catch (e: any) {
    tail = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const lastLines = tail.trim().split("\n").slice(-3).join(" | ").slice(0, 240);
  return testClaims.map((c) => ({
    claim: c,
    verdict: passed ? ("verified" as const) : ("contradicted" as const),
    evidence: passed
      ? `\`${cmd}\` exits 0 (${lastLines})`
      : `\`${cmd}\` FAILS despite the claim (${lastLines})`,
  }));
}

/** "Done/complete" claims are checked for leftover work markers in the diff. */
export function checkCompletion(claims: Claim[], repo: string): CheckResult[] {
  const done = claims.filter((c) => c.kind === "work_complete");
  if (done.length === 0) return [];
  const diff = git(repo, "diff HEAD~1..HEAD 2>/dev/null") + git(repo, "diff");
  const markers = [...diff.matchAll(/^\+.*\b(TODO|FIXME|XXX|HACK|throw new Error\("not implemented|NotImplementedError)\b.*$/gim)]
    .map((m) => m[0].trim().slice(0, 120));
  return done.map((c) => ({
    claim: c,
    verdict: markers.length === 0 ? ("verified" as const) : ("contradicted" as const),
    evidence:
      markers.length === 0
        ? "no TODO/FIXME/not-implemented markers added in this change"
        : `claimed complete, but the diff ADDS ${markers.length} unfinished-work marker(s): ${markers.slice(0, 3).join(" ⏐ ")}`,
  }));
}

function inferTestCommand(repo: string): string | null {
  const pkg = join(repo, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8"));
      const t = j?.scripts?.test;
      if (t && !/no test specified/i.test(t)) return "npm test --silent";
    } catch {}
  }
  if (existsSync(join(repo, "pytest.ini")) || existsSync(join(repo, "pyproject.toml"))) return "python3 -m pytest -q";
  if (existsSync(join(repo, "Cargo.toml"))) return "cargo test --quiet";
  return null;
}

/** Step-repetition: >=3 identical consecutive tool calls (arXiv: 17.14% of
 *  agent failures are step repetitions that slip past output-only checks). */
export function checkStepRepetition(toolCalls: string[]): CheckResult[] {
  if (toolCalls.length === 0) return [];
  let worst = 1, run = 1, worstCall = "";
  for (let i = 1; i < toolCalls.length; i++) {
    run = toolCalls[i] === toolCalls[i - 1] ? run + 1 : 1;
    if (run > worst) { worst = run; worstCall = toolCalls[i]; }
  }
  const claim = { kind: "work_complete" as const, quote: "session behavior (automatic check)", subject: "no step-repetition loops" };
  return [worst >= 3
    ? { claim, verdict: "contradicted" as const, evidence: `agent repeated the identical tool call ${worst}x in a row (${worstCall.slice(0, 90)}…) — classic stuck-loop signature` }
    : { claim, verdict: "verified" as const, evidence: `no identical tool call repeated 3+ times consecutively (${toolCalls.length} calls checked)` }];
}

/** Reasoning-action mismatch (13.98% of documented agent failures): the agent
 *  SAYS it ran something, but no tool call in the transcript matches. */
export function checkRunClaims(
  runClaims: { quote: string; subject: string }[],
  toolCalls: string[],
): CheckResult[] {
  if (runClaims.length === 0 || toolCalls.length === 0) return [];
  const haystack = toolCalls.join("\n").toLowerCase();
  return runClaims.map((c) => {
    // match on the command's distinctive tokens appearing in any tool call
    const tokens = c.subject.toLowerCase().split(/[\s/]+/).filter((t) => t.length > 2);
    const hit = tokens.length > 0 && tokens.every((t) => haystack.includes(t));
    const claim = { kind: "work_complete" as const, quote: c.quote, subject: `ran: ${c.subject}` };
    return hit
      ? { claim, verdict: "verified" as const, evidence: `a tool call matching "${c.subject}" appears in the transcript` }
      : { claim, verdict: "contradicted" as const, evidence: `the narrative says this was run, but no tool call in the transcript matches "${c.subject}" — classic say-do mismatch` };
  });
}
