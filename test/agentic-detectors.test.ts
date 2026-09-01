import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkAgenticRepository, checkOutOfDagReads } from "../src/detectors/agentic.ts";
import { checkIntegrity, checkIntegrityDiff } from "../src/detectors/reality.ts";
import { routeIntegrity } from "../src/integrity-policy.ts";
import { run } from "../src/cli.ts";

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "vigil-agentic-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  return repo;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

function diff(path: string, removed: string[], added: string[]): string {
  const oldRange = removed.length === 0 ? "0,0" : `1,${removed.length}`;
  const newRange = added.length === 0 ? "0,0" : `1,${added.length}`;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

test("repository-aware WORKTREE reads reject a FIFO without opening it", { skip: process.platform === "win32" }, () => {
  const repo = tempRepo();
  write(repo, "package.json", JSON.stringify({ dependencies: { axios: "1.0.0" } }));
  const base = commit(repo, "dependency baseline");
  unlinkSync(join(repo, "package.json"));
  execFileSync("mkfifo", [join(repo, "package.json")]);
  const result = checkAgenticRepository(repo, base, "WORKTREE", ["package.json"], [])[0];
  assert.equal(result.ruleId, "integrity-unreadable");
  assert.equal(result.blocksPass, true);
  assert.match(result.evidence, /regular no-symlink worktree file/);
});

test("Render Gate blocks hidden controls only when they are added", () => {
  const hidden = checkIntegrityDiff(diff("src/auth.ts", ["const user = 1;"], [`const us\u202Eer = 1;`])); // vigil:detector-pattern
  assert.ok(hidden.some((result) => result.ruleId === "render-gate"));

  const ordinary = checkIntegrityDiff([
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,2 +1,2 @@",
    " const us\u202Eer = 1;", // vigil:detector-pattern
    "-return 1;",
    "+return 2;",
    "",
  ].join("\n"));
  assert.equal(ordinary.some((result) => result.ruleId === "render-gate"), false);
});

test("mixed-script identifiers are visible advisories under calibrated policy", () => {
  const checks = checkIntegrityDiff(diff("src/auth.ts", [], ["const pаssword = read();"])); // vigil:detector-pattern
  const mixed = checks.find((result) => result.ruleId === "render-gate-mixed-script");
  assert.ok(mixed);
  const routed = routeIntegrity(checks, "calibrated");
  assert.ok(routed.advisories.includes(mixed));
});

test("zero-width and variation characters remain visible without becoming calibrated blockers", () => {
  const checks = checkIntegrityDiff(diff("src/auth.ts", [], ["const us\u200Ber = read();"])); // vigil:detector-pattern
  const hidden = checks.find((result) => result.ruleId === "render-gate-hidden-character");
  assert.ok(hidden);
  assert.ok(routeIntegrity(checks, "calibrated").advisories.includes(hidden));
});

test("Oracle Falsify catches discarded and unreachable assertions", () => {
  const swallowed = checkIntegrityDiff(diff("test/value.test.ts", [], [
    "try {", // vigil:detector-pattern
    "  expect(value()).toBe(42);",
    "} catch (error) {}", // vigil:detector-pattern
  ]));
  assert.ok(swallowed.some((result) => result.ruleId === "oracle-falsify"));

  const unreachable = checkIntegrityDiff(diff("tests/test_value.py", [], [
    "if False:", // vigil:detector-pattern
    "    assert value() == 42",
  ]));
  assert.ok(unreachable.some((result) => result.ruleId === "oracle-falsify"));
});

test("Ghost Loader catches changed pytest collection exclusions", () => {
  const checks = checkIntegrityDiff(diff("conftest.py", [], [
    "def pytest_collection_modifyitems(config, items):", // vigil:detector-pattern
    "    items[:] = [item for item in items if 'slow' not in item.name]", // vigil:detector-pattern
  ]));
  assert.ok(checks.some((result) => result.ruleId === "ghost-loader"));
});

test("Harness Guard and Suppression Receipt extend existing checks without treating casts as suppressions", () => {
  const checks = checkIntegrityDiff([
    diff(".github/workflows/ci.yml", ["continue-on-error: false"], ["continue-on-error: true"]), // vigil:detector-pattern
    diff("src/value.ts", ["const value = parse(raw);"], ["//nolint:staticcheck", "const value = parse(raw);"]), // vigil:detector-pattern
  ].join("\n"));
  assert.ok(checks.some((result) => result.ruleId === "verification-bypass"));
  assert.ok(checks.some((result) => result.ruleId === "suppression-added"));

  const castOnly = checkIntegrityDiff(diff(
    "src/value.ts",
    ["const value = parse(raw);"],
    ["const value = parse(raw) as any;"], // vigil:detector-pattern
  ));
  assert.equal(castOnly.some((result) => result.ruleId === "suppression-added"), false);
});

test("Oracle Echo records a distinctive direct return matching an unchanged assertion", () => {
  const repo = tempRepo();
  write(repo, "src/amount.ts", "export function amount() {\n  return 1;\n}\n");
  write(repo, "test/amount.test.ts", "test('amount', () => { expect(amount()).toBe(913746); });\n");
  const base = commit(repo, "base");
  write(repo, "src/amount.ts", "export function amount() {\n  return 913746;\n}\n");
  const head = commit(repo, "echo oracle");

  const echo = checkIntegrity(repo, base, head).find((result) => result.ruleId === "oracle-echo");
  assert.ok(echo);
  assert.match(echo.evidence, /sha256:[0-9a-f]{12}/);
  assert.doesNotMatch(echo.evidence, /913746/);
  assert.ok(routeIntegrity([echo], "calibrated").advisories.includes(echo));
});

test("Oracle Echo does not fire when the literal already existed in source", () => {
  const repo = tempRepo();
  write(repo, "src/constants.ts", "export const EXPECTED = 913746;\n");
  write(repo, "src/amount.ts", "export function amount() {\n  return 1;\n}\n");
  write(repo, "test/amount.test.ts", "test('amount', () => { expect(amount()).toBe(913746); });\n");
  const base = commit(repo, "base");
  write(repo, "src/amount.ts", "export function amount() {\n  return 913746;\n}\n");
  const head = commit(repo, "use existing domain value");

  assert.equal(checkIntegrity(repo, base, head).some((result) => result.ruleId === "oracle-echo"), false);
});

test("Fresh Dependency records an offline similarity warning without a malware claim", () => {
  const repo = tempRepo();
  write(repo, "package.json", JSON.stringify({ dependencies: { axios: "1.0.0" } }, null, 2));
  const base = commit(repo, "base");
  write(repo, "package.json", JSON.stringify({ dependencies: { axios: "1.0.0", axois: "1.0.0" } }, null, 2));
  const head = commit(repo, "add dependency");

  const check = checkIntegrity(repo, base, head).find((result) => result.ruleId === "fresh-dep");
  assert.ok(check);
  assert.match(check.evidence, /does not claim the package is malicious/);
  assert.ok(routeIntegrity([check], "calibrated").advisories.includes(check));
  assert.equal(run(["test-integrity", "--repo", repo, "--base", base, "--head", head, "--format", "json"]), 0);
});

test("Fresh Dependency also sees a lookalike import without contacting a registry", () => {
  const repo = tempRepo();
  write(repo, "app.py", "print('base')\n");
  const base = commit(repo, "base");
  write(repo, "app.py", "import requsts\nprint('head')\n");
  const head = commit(repo, "add misspelled import");
  assert.ok(checkIntegrity(repo, base, head).some((result) => result.ruleId === "fresh-dep"));
});

test("lowering a non-zero coverage floor is calibrated blocking evidence", () => {
  const repo = tempRepo();
  write(repo, "package.json", JSON.stringify({ scripts: { test: "pytest --cov-fail-under=90" } }));
  const base = commit(repo, "base");
  write(repo, "package.json", JSON.stringify({ scripts: { test: "pytest --cov-fail-under=70" } }));
  const head = commit(repo, "lower floor");

  const check = checkIntegrity(repo, base, head).find((result) => result.ruleId === "coverage-weakened");
  assert.ok(check);
  assert.ok(routeIntegrity([check], "calibrated").results.includes(check));
});

test("removing a coverage floor or its config is calibrated blocking evidence", () => {
  for (const removeFile of [false, true]) {
    const repo = tempRepo();
    write(repo, "coverage.yml", "minimum_coverage: 90\nreporter: text\n");
    const base = commit(repo, "coverage baseline");
    if (removeFile) {
      execFileSync("git", ["rm", "-q", "coverage.yml"], { cwd: repo });
    } else {
      write(repo, "coverage.yml", "reporter: text\n");
    }
    const head = commit(repo, removeFile ? "delete coverage config" : "remove coverage floor");
    const check = checkIntegrity(repo, base, head).find((result) => result.ruleId === "coverage-weakened");
    assert.equal(check?.verdict, "contradicted");
    assert.match(check?.evidence ?? "", /minimum coverage floor of 90 was removed/);
  }
});

test("repository-aware dependency checks block when a changed manifest exceeds the bounded read limit", () => {
  const repo = tempRepo();
  const padding = "x".repeat(1024 * 1024 + 1);
  write(repo, "package.json", JSON.stringify({ padding, dependencies: { axios: "1.0.0" } }));
  const base = commit(repo, "large dependency baseline");
  write(repo, "package.json", JSON.stringify({ padding, dependencies: { axios: "1.0.0", axois: "1.0.0" } }));
  const head = commit(repo, "large dependency change");
  const check = checkIntegrity(repo, base, head).find((result) => result.ruleId === "integrity-unreadable");
  assert.equal(check?.verdict, "unverifiable");
  assert.equal(check?.blocksPass, true);
  assert.match(check?.evidence ?? "", /package\.json.*exceeds the 1 MiB/);
});

test("repository-aware coverage checks block when a changed config exceeds the bounded read limit", () => {
  const repo = tempRepo();
  const padding = "x".repeat(1024 * 1024 + 1);
  write(repo, "coverage.json", JSON.stringify({ minimum_coverage: 90, padding }));
  const base = commit(repo, "large coverage baseline");
  write(repo, "coverage.json", JSON.stringify({ minimum_coverage: 80, padding }));
  const head = commit(repo, "large coverage change");
  const check = checkIntegrity(repo, base, head).find((result) => result.ruleId === "integrity-unreadable");
  assert.equal(check?.verdict, "unverifiable");
  assert.equal(check?.blocksPass, true);
  assert.match(check?.evidence ?? "", /coverage\.json.*exceeds the 1 MiB/);
});

test("Leak Gate records only out-of-change-history reads and does not infer copying", () => {
  const repo = tempRepo();
  write(repo, "base.txt", "base\n");
  const base = commit(repo, "base");
  const baseBranch = git(repo, "branch", "--show-current");
  write(repo, "candidate.txt", "candidate\n");
  const head = commit(repo, "candidate");
  git(repo, "checkout", "--orphan", "unrelated");
  git(repo, "rm", "-rf", ".");
  write(repo, "other.txt", "other\n");
  const unrelated = commit(repo, "unrelated");
  git(repo, "checkout", "-q", baseBranch);

  const findings = checkOutOfDagReads(repo, base, head, [{
    id: "1",
    name: "Bash",
    input: `git show ${unrelated}`,
    sequence: 0,
  }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "leak-gate");
  assert.match(findings[0].evidence, /origin, copying, and causation are not inferred/);

  const ordinary = checkOutOfDagReads(repo, base, head, [
    { id: "2", name: "Bash", input: `git show ${base}`, sequence: 1 },
    { id: "3", name: "Bash", input: `git diff ${base} ${head}`, sequence: 2 },
  ]);
  assert.deepEqual(ordinary, []);
});
