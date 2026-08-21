import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOutputs } from "../src/output.ts";
import { buildReport, type CheckResult } from "../src/report.ts";

function report() {
  const result: CheckResult = {
    claim: { kind: "path_exists", quote: "receipt exists", subject: "receipt.json" },
    verdict: "verified",
    evidence: "verified fixture",
  };
  return buildReport({
    transcript: "fixture.md",
    transcriptFormat: "markdown",
    repo: ".",
    base: "base",
    head: "head",
    results: [result],
  });
}

function symlinkOrSkip(
  context: TestContext,
  target: string,
  path: string,
  type: "file" | "dir" | "junction",
): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
      context.skip(`host does not permit ${type} creation (${code})`);
      return false;
    }
    throw error;
  }
}

test("report output rejects a symlink and preserves its target", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-output-symlink-"));
  const target = join(directory, "private-target.txt");
  const output = join(directory, "receipt.json");
  writeFileSync(target, "must remain unchanged\n");
  if (!symlinkOrSkip(context, target, output, "file")) return;

  assert.throws(
    () => writeOutputs(report(), { output }),
    /Refusing to replace symbolic-link output/,
  );
  assert.equal(readFileSync(target, "utf8"), "must remain unchanged\n");
  assert.equal(lstatSync(output).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(directory).sort(), ["private-target.txt", "receipt.json"]);
});

test("report output rejects a symlinked parent and preserves the outside target", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-output-parent-symlink-"));
  const repository = join(directory, "repo");
  const outside = join(directory, "outside");
  mkdirSync(repository);
  mkdirSync(outside);
  const target = join(outside, "authorized_keys");
  writeFileSync(target, "must remain unchanged\n");
  const artifacts = join(repository, "artifacts");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (!symlinkOrSkip(context, outside, artifacts, linkType)) return;

  assert.throws(
    () => writeOutputs(report(), { output: join(artifacts, "authorized_keys") }),
    /Refusing to traverse symbolic-link output parent/,
  );
  assert.equal(readFileSync(target, "utf8"), "must remain unchanged\n");
  assert.equal(lstatSync(artifacts).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(outside), ["authorized_keys"]);
});

test("report output atomically replaces a regular file with mode 0600", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-output-mode-"));
  const output = join(directory, "receipt.json");
  writeFileSync(output, "stale and public\n");
  chmodSync(output, 0o666);

  writeOutputs(report(), { output });

  const written = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(written.summary.status, "PASS");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), ["receipt.json"]);
});

test("report output rejects a non-regular destination", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-output-directory-"));
  const output = join(directory, "receipt.json");
  mkdirSync(output);

  assert.throws(
    () => writeOutputs(report(), { output }),
    /Refusing to replace non-regular output/,
  );
  assert.equal(statSync(output).isDirectory(), true);
  assert.deepEqual(readdirSync(directory), ["receipt.json"]);
});

test("GitHub summary keeps existing content and becomes private", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-output-summary-"));
  const summary = join(directory, "summary.md");
  writeFileSync(summary, "existing step output\n");
  chmodSync(summary, 0o644);
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    writeOutputs(report(), { githubSummary: true });
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previous;
  }

  const written = readFileSync(summary, "utf8");
  assert.match(written, /^existing step output\n# ✅ Agent Vigil: PASS/);
  assert.equal(statSync(summary).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory), ["summary.md"]);
});
