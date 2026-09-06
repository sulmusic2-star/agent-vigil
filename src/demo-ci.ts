import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIntegrity } from "./detectors/reality.ts";
import { routeIntegrity } from "./integrity-policy.ts";
import { trustedGit } from "./trusted-git.ts";

const production = "exports.add = (a, b) => a + b;\n";
const imports = "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { add } = require('./math.cjs');\n";
const baseline = imports + `
test('adds positive numbers', () => {
  assert.equal(add(2, 3), 5);
});
test('adds opposite numbers', () => {
  assert.equal(add(-2, 2), 0);
});
`;

// Constructed examples, fixed before scoring. They are not historical catches.
export const CI_DEMO_CASES = [
  { id: "healthy", label: "Meaningful tests", production, tests: baseline, expected: "PASS", referenceExpected: "PASS" },
  {
    id: "emptied-test", label: "Empty test; assertion moved elsewhere", production,
    tests: imports + `
test('adds positive numbers', () => {
});
test('adds opposite numbers', () => {
  assert.equal(add(-2, 2), 0);
  assert.equal(add(2, 3), 5);
});
`, expected: "FAIL", referenceExpected: "PASS",
  },
  { id: "wrong-result", label: "Wrong implementation", production: "exports.add = (a, b) => a - b;\n", tests: baseline, expected: "FAIL", referenceExpected: "FAIL" },
  {
    id: "helper-refactor", label: "Assertions moved into a helper", production,
    tests: imports + `
function expectSum(a, b, expected) { assert.equal(add(a, b), expected); }
test('adds positive numbers', () => {
  expectSum(2, 3, 5);
});
test('adds opposite numbers', () => {
  expectSum(-2, 2, 0);
});
`, expected: "PASS", referenceExpected: "PASS",
  },
  {
    id: "hidden-regression", label: "Broken function; assertions compare a value to itself",
    production: "exports.add = (a, b) => a - b;\n",
    tests: imports + `
test('adds positive numbers', () => {
  const actual = add(2, 3);
  assert.equal(actual, actual);
});
test('adds opposite numbers', () => {
  const actual = add(-2, 2);
  assert.equal(actual, actual);
});
`, expected: "FAIL", referenceExpected: "FAIL",
  },
  {
    id: "rewritten-expectations", label: "Known miss: expected answers changed to match the bug",
    production: "exports.add = (a, b) => a - b;\n",
    tests: imports + `
test('adds positive numbers', () => {
  assert.equal(add(2, 3), -1);
});
test('adds opposite numbers', () => {
  assert.equal(add(-2, 2), -4);
});
`, expected: "PASS", referenceExpected: "FAIL",
  },
] as const;

type Verdict = "PASS" | "FAIL" | "NOT CHECKED";
export function parseDemoTestCounts(output: string) {
  const keys = ["tests", "pass", "fail", "cancelled", "skipped", "todo"] as const;
  const counts = {} as Record<typeof keys[number], number>;
  for (const key of keys) {
    const matches = [...output.matchAll(new RegExp(`^# ${key} ([0-9]+)\\r?$`, "gm"))];
    if (matches.length !== 1) return undefined;
    const count = Number(matches[0][1]);
    if (!Number.isSafeInteger(count)) return undefined;
    counts[key] = count;
  }
  if (counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) return undefined;
  return counts;
}

export function demoCiVerdict(status: number | null, error: boolean, counts: ReturnType<typeof parseDemoTestCounts>): Verdict {
  if (error || status === null || !counts) return "NOT CHECKED";
  return status === 0 && counts.tests >= 2 && counts.pass === counts.tests ? "PASS" : "FAIL";
}

function environment(home: string): NodeJS.ProcessEnv {
  // No inherited tokens, NODE_OPTIONS, loaders, proxy settings, or npm hooks.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home, TMP: home, TEMP: home, NO_COLOR: "1", LANG: "C", LC_ALL: "C" };
  if (process.platform === "win32") for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function runCiDemo() {
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-ci-demo-"));
  const started = performance.now();
  const rows = [];
  try {
    const env = environment(root);
    const template = join(root, "empty-template");
    mkdirSync(template);
    for (const item of CI_DEMO_CASES) {
      const repo = join(root, item.id);
      mkdirSync(repo);
      trustedGit(repo, ["init", "-q", `--template=${template}`]);
      const commit = (message: string) => {
        trustedGit(repo, ["add", "math.cjs", "math.test.cjs"]);
        trustedGit(repo, ["-c", "user.name=Agent Vigil example", "-c", "user.email=example@agent-vigil.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", message]);
        return trustedGit(repo, ["rev-parse", "HEAD"]).trim();
      };
      writeFileSync(join(repo, "math.cjs"), production);
      writeFileSync(join(repo, "math.test.cjs"), baseline);
      commit("baseline");
      const base = trustedGit(repo, ["rev-parse", "HEAD"]).trim();
      writeFileSync(join(repo, "math.cjs"), item.production);
      writeFileSync(join(repo, "math.test.cjs"), item.tests);
      const head = commit(item.id);
      const commands = [
        ["--check", "math.cjs"], ["--check", "math.test.cjs"],
        ["--test", "--experimental-test-coverage", "--test-reporter=tap", "--test-coverage-include=math.cjs", "--test-coverage-lines=100", "--test-coverage-functions=100", "--test-coverage-branches=100", "math.test.cjs"],
      ];
      const clock = performance.now();
      const runs = commands.map(args => {
        const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
        return { command: ["node", ...args], status: result.status, signal: result.signal, error: result.error?.message, output: result.stdout ?? "", stderr: result.stderr ?? "" };
      });
      const last = runs.at(-1)!;
      const counts = parseDemoTestCounts(last.output);
      let ci = demoCiVerdict(last.status, runs.some(run => !!run.error || run.signal !== null), counts);
      if (ci === "PASS" && runs.some(run => run.status !== 0)) ci = "FAIL";
      const ciMs = performance.now() - clock;
      const checkStarted = performance.now();
      const routed = routeIntegrity(checkIntegrity(repo, base, head), "calibrated");
      const hard = routed.results.filter(check => check.verdict === "contradicted");
      const gaps = routed.results.filter(check => check.verdict === "unverifiable");
      const integrity: Verdict = hard.length ? "FAIL" : gaps.length ? "NOT CHECKED" : "PASS";
      const combined: Verdict = ci === "FAIL" || integrity === "FAIL" ? "FAIL" : ci === "NOT CHECKED" || integrity === "NOT CHECKED" ? "NOT CHECKED" : "PASS";
      const diff = trustedGit(repo, ["diff", "--no-renames", "--unified=0", base, head]);
      const integrityMs = performance.now()-checkStarted;
      // An explicit comparison with a stronger CI arrangement: retain the
      // baseline's expectations rather than trusting the candidate's answers.
      // Only fixed, disposable demo source executes here; this is not a
      // generic command that runs arbitrary historical repository code.
      const referenceSource = trustedGit(repo, ["show", `${base}:math.test.cjs`]);
      writeFileSync(join(repo, "math.reference.cjs"), referenceSource);
      const referenceArgs = [...commands.at(-1)!.slice(0, -1), "math.reference.cjs"];
      const referenceStarted = performance.now();
      const referenceRun = spawnSync(process.execPath, referenceArgs, { cwd: repo, env, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
      const referenceCounts = parseDemoTestCounts(referenceRun.stdout ?? "");
      const referenceVerdict = demoCiVerdict(referenceRun.status, !!referenceRun.error || referenceRun.signal !== null, referenceCounts);
      const reference = {
        verdict: referenceVerdict, expected: item.referenceExpected, counts: referenceCounts,
        testSourceCommit: base, testSourcePath: "math.test.cjs", candidateCommit: head,
        testSourceSha256: createHash("sha256").update(referenceSource).digest("hex"),
        command: ["node", ...referenceArgs], status: referenceRun.status, signal: referenceRun.signal,
        error: referenceRun.error?.message, output: referenceRun.stdout ?? "", stderr: referenceRun.stderr ?? "", machineMs: performance.now()-referenceStarted,
      };
      rows.push({ id: item.id, label: item.label, expected: item.expected, base, head, ci, integrity, combined, counts, hard, gaps, advisories: routed.advisories, ciMs, integrityMs, runs, reference, diff, diffSha256: createHash("sha256").update(diff).digest("hex") });
    }
    return {
      schema: "agent-vigil-ci-demo/v2", node: process.version,
      scope: "Six constructed JavaScript examples, including a known miss. Local syntax, tests, count/skip checks, and 100% production line/function/branch coverage. Integrity uses exact Git blobs and calibrated policy. A separate baseline-test replay compares a stronger CI setup. Not a hosted check or merge authorization.",
      reproduced: rows.every(row => row.combined === row.expected && row.reference.verdict === row.reference.expected),
      machineMs: performance.now()-started, humanMinutesSaved: null, rows,
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function runCiDemoCommand(args: string[]): number {
  if (args.some(arg => arg !== "--json")) throw new Error("usage: vigil demo --ci [--json]");
  const result = runCiDemo();
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log("What Vigil adds to passing tests\n");
    console.log("Constructed examples. No account, upload, install, or changes to your repository.\n");
    for (const row of result.rows) console.log(`${row.label}\n  Candidate tests: ${row.ci} | With Vigil: ${row.combined}\n  Original tests on this code: ${row.reference.verdict}`);
    console.log("\nCI checks syntax, at least two tests, no skips, and 100% production coverage.");
    console.log("Vigil catches the self-comparison hiding a broken function.");
    console.log("It misses the rewritten expected answers. The original tests catch both bugs.");
    console.log("Keep independent tests: they can provide protection without Vigil, too.");
    console.log("The empty-callback example preserves its assertion elsewhere; it is not a missed bug.");
    console.log("This check is not permission to merge or proof of time saved.");
    if (result.rows.some(row => row.ci === "NOT CHECKED")) console.log("Use Node 22.8+ and Git. This example needs Node's coverage thresholds; see --json for command errors.");
    console.log(`\n${result.reproduced ? "All six recorded outcomes reproduced, including Vigil's known miss." : "Some results did not reproduce. Inspect --json; do not treat missing checks as passes."}`);
  }
  return result.reproduced ? 0 : 2;
}
