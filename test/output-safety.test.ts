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
import {
  remediationFor,
  renderDecisionCard,
  renderMarkdown,
  renderText,
  toSarif,
  writeOutputs,
} from "../src/output.ts";
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

function result(
  verdict: CheckResult["verdict"],
  ruleId: string | undefined,
  subject = "subject",
): CheckResult {
  return {
    claim: { kind: "integrity", quote: "claim | with spacing", subject },
    verdict,
    evidence: "evidence | with\nspacing",
    ...(ruleId ? { ruleId } : {}),
    ...(verdict === "unverifiable" ? { blocksPass: true } : {}),
  };
}

function mixedReport(results: CheckResult[], advisories?: CheckResult[]) {
  return buildReport({
    transcript: "fixture`name.md",
    transcriptFormat: "markdown",
    repo: ".",
    base: "base`sha",
    head: "head`sha",
    results,
    advisories,
    policy: { minVerified: 1, strict: true, sha256: "sha256:policy" },
    reproduction: "vigil check `fixture`",
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

test("report output atomically replaces a regular file with POSIX mode 0600", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-output-mode-"));
  const output = join(directory, "receipt.json");
  writeFileSync(output, "stale and public\n");
  chmodSync(output, 0o666);

  writeOutputs(report(), { output });

  const written = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(written.summary.status, "PASS");
  if (process.platform !== "win32") {
    assert.equal(statSync(output).mode & 0o777, 0o600);
  }
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
  assert.match(written, /^existing step output\n### Agent Vigil: PASS/);
  if (process.platform !== "win32") {
    assert.equal(statSync(summary).mode & 0o777, 0o600);
  }
  assert.deepEqual(readdirSync(directory), ["summary.md"]);
});

test("human-readable renderers distinguish pass, failure, unresolved evidence, and advisories", () => {
  const pass = mixedReport([result("verified", "tests-pass")]);
  assert.match(renderText(pass), /PASS/);
  assert.doesNotMatch(renderText(pass), /Missing or unresolved evidence/);
  assert.match(renderMarkdown(pass), /^# ✅ Agent Vigil: PASS/);
  assert.match(renderDecisionCard(pass), /required evidence is present/);

  const fail = mixedReport([
    result("verified", "tests-pass"),
    result("contradicted", "coverage-weakened", "coverage contract"),
  ], [
    result("unverifiable", undefined, "optional evidence"),
    result("contradicted", "assertion-drop", "assertion surface"),
  ]);
  const failText = renderText(fail);
  assert.match(failText, /FAIL/);
  assert.match(failText, /Restore a meaningful coverage threshold/);
  assert.match(failText, /unresolved advisory/);
  assert.match(failText, /advisory finding/);
  const failMarkdown = renderMarkdown(fail);
  assert.match(failMarkdown, /^# ❌ Agent Vigil: FAIL/);
  assert.match(failMarkdown, /What to do next/);
  assert.match(failMarkdown, /claim \\| with spacing/);
  assert.match(renderDecisionCard(fail), /required check contradicted/);

  const unresolved = mixedReport([result("unverifiable", "path-exists")]);
  assert.equal(unresolved.summary.status, "INCONCLUSIVE");
  assert.match(renderText(unresolved), /Missing or unresolved evidence/);
  assert.match(renderMarkdown(unresolved), /^# ⚠️ Agent Vigil: INCONCLUSIVE/);
  assert.match(renderDecisionCard(unresolved), /not enough to approve/);
});

test("decision card bounds the inline repair list and escapes reproduction backticks", () => {
  const open = Array.from({ length: 7 }, (_, index) => result(
    "contradicted",
    index === 0 ? undefined : `unknown-${index}`,
    `blocked item ${index}`,
  ));
  const card = renderDecisionCard(mixedReport(open));
  assert.match(card, /blocked item 0/);
  assert.match(card, /2 more item\(s\)/);
  assert.doesNotMatch(card, /blocked item 6/);
  assert.match(card, /\\`fixture\\`/);
  assert.match(remediationFor(), /objective evidence/);
  assert.match(remediationFor("not-a-rule"), /objective evidence/);
  assert.match(remediationFor("portable-signature"), /trusted Ed25519 key/);
});

test("SARIF emits only blocking findings and advisories at the correct levels", () => {
  const value = mixedReport([
    result("verified", "tests-pass"),
    result("contradicted", "coverage-weakened"),
    result("unverifiable", undefined),
  ], [result("contradicted", "assertion-drop")]);
  const sarif = toSarif(value);
  assert.equal(sarif.version, "2.1.0");
  assert.deepEqual(sarif.runs[0].results.map((entry) => entry.level), ["error", "warning", "warning"]);
  assert.ok(sarif.runs[0].tool.driver.rules.some((entry) => entry.id === "integrity"));
  assert.equal(sarif.runs[0].properties.advisoryCount, 1);
});

test("writeOutputs can persist JSON and SARIF together and skips an absent GitHub summary path", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-output-complete-"));
  const output = join(directory, "receipt.json");
  const sarif = join(directory, "receipt.sarif");
  const previous = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_STEP_SUMMARY;
  try {
    writeOutputs(report(), { output, sarif, githubSummary: true });
  } finally {
    if (previous !== undefined) process.env.GITHUB_STEP_SUMMARY = previous;
  }
  assert.equal(JSON.parse(readFileSync(output, "utf8")).summary.status, "PASS");
  assert.equal(JSON.parse(readFileSync(sarif, "utf8")).version, "2.1.0");
  assert.deepEqual(readdirSync(directory).sort(), ["receipt.json", "receipt.sarif"]);
});
