import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { demoResultView } from "../scripts/render_result_view_demo.ts";
import { run } from "../src/cli.ts";
import { renderResultMarkdown, renderResultText } from "../src/output.ts";
import { buildReport } from "../src/report.ts";
import {
  buildReportResultView,
  readChangedFileManifest,
  renderResultViewHtml,
  type ResultView,
} from "../src/result-view.ts";

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function report(verdict: "PASS" | "FAIL" | "INCONCLUSIVE") {
  const result = verdict === "PASS"
    ? { claim: { kind: "tests_pass" as const, subject: "tests passed", quote: "tests passed" }, verdict: "verified" as const, evidence: "observed 12 tests", ruleId: "tests-pass" }
    : verdict === "FAIL"
      ? { claim: { kind: "tests_pass" as const, subject: "tests failed", quote: "tests passed" }, verdict: "contradicted" as const, evidence: "test/a.test.ts:12 failed", ruleId: "tests-pass" }
      : { claim: { kind: "command_ran" as const, subject: "build command", quote: "build ran" }, verdict: "unverifiable" as const, evidence: "no terminal result", ruleId: "command-ran", blocksPass: true };
  return buildReport({
    transcript: "fixture.jsonl",
    transcriptFormat: "fixture",
    repo: ".",
    base: OID_A,
    head: OID_B,
    results: [result],
    policy: { strict: false, minVerified: 1, sha256: "sha256:policy" },
    reproduction: `vigil verify --base ${OID_A} --head ${OID_B}`,
  });
}

test("missing required evidence cannot display PASS", () => {
  const input = report("INCONCLUSIVE");
  input.summary.status = "PASS";
  input.summary.pass = true;
  assert.throws(() => buildReportResultView(input), /content does not match its hash/);
});

test("claimed and observed test counts stay distinct and hostile display text is neutralized", () => {
  const longPath = `${"nested/".repeat(40)}test\u001b[31m\u202e.ts:321`;
  const input = buildReport({
    transcript: "fixture.jsonl",
    transcriptFormat: "fixture",
    repo: ".",
    base: OID_A,
    head: OID_B,
    results: [{
      claim: { kind: "tests_pass", subject: `<script>alert(1)</script> count at ${longPath}`, quote: "184 tests passed", expectedCount: 184 },
      verdict: "contradicted",
      evidence: `isolated runner observed 161 tests at ${longPath}\rspoofed`,
      ruleId: "test-count",
    }],
    policy: { strict: true, sha256: "sha256:policy" },
  });
  const view = buildReportResultView(input);
  assert.equal(view.findings[0].claimedTestCount, 184);
  assert.equal(view.findings[0].observedTestCount, 161);
  assert.equal(view.findings[0].location?.line, 321);
  const text = renderResultText(view);
  const markdown = renderResultMarkdown(view);
  const web = renderResultViewHtml(view);
  assert.match(text, /claimed 184; observed 161/);
  assert.doesNotMatch(text, /\u001b|\u202e|\r/);
  assert.doesNotMatch(web, /\u001b|\u202e|\r/);
  assert.match(text, /\\u\{001B\}/);
  assert.match(text, /\\u\{202E\}/);
  assert.doesNotMatch(markdown, /<script>/);
  assert.match(markdown, /\\<script\\>/);
  assert.doesNotMatch(web, /<script>alert\(1\)<\/script>/);
});

test("PASS, FAIL, and INCONCLUSIVE use the same result structure", () => {
  const views = (["PASS", "FAIL", "INCONCLUSIVE"] as const).map((value) => buildReportResultView(report(value)));
  const topKeys = Object.keys(views[0]);
  const countKeys = Object.keys(views[0].counts);
  for (const view of views) {
    assert.deepEqual(Object.keys(view), topKeys);
    assert.deepEqual(Object.keys(view.counts), countKeys);
    assert.match(renderResultText(view), /^Agent Vigil: (PASS|FAIL|INCONCLUSIVE)\n/);
    assert.match(renderResultMarkdown(view), /^### Agent Vigil: (PASS|FAIL|INCONCLUSIVE)\n/);
  }
});

test("changed-file manifest covers the exact Git range including renames", () => {
  const repo = mkdtempSync(join(tmpdir(), "vigil-result-view-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repo });
  writeFileSync(join(repo, "old.ts"), "export const old = 1;\n");
  writeFileSync(join(repo, "delete.ts"), "delete me\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  renameSync(join(repo, "old.ts"), join(repo, "new.ts"));
  writeFileSync(join(repo, "added.ts"), "added\n");
  execFileSync("git", ["rm", "-q", "delete.ts"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "head"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const manifest = readChangedFileManifest(repo, base, head);
  const gitNames = execFileSync("git", ["diff", "--name-only", "-z", `${base}..${head}`], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const covered = manifest.files.map((file) => file.path);
  assert.equal(manifest.complete, true);
  assert.deepEqual([...new Set(covered)].sort(), gitNames);
  assert.ok(manifest.files.some((file) => file.status === "renamed"));
});

test("result text and web snapshot keep the decision, counts, SHAs, and changed files together", () => {
  const text = renderResultText(demoResultView);
  assert.equal(text.split("\n").slice(0, 7).join("\n"), [
    "Agent Vigil: FAIL",
    "Do not merge yet.",
    "The isolated run found fewer passing tests than the agent reported.",
    "Failed 1 · Passed 5 · Not checked 1",
    "",
    "Checks that need attention",
    "  FAILED [test-count] Reported test count does not match the isolated run",
  ].join("\n"));
  const generated = renderResultViewHtml(demoResultView);
  assert.equal(readFileSync("docs/assets/outcome-verifier-demo.html", "utf8"), generated);
  assert.match(generated, /data-result-view-version="1"/);
  assert.match(generated, /4d407f7e171a1c3d67a80a55650f0966db304fb5/);
  assert.match(generated, /bf3b7458ebf672fbc4ba5358c02242368af602dc/);
});

test("web result has a labeled landmark, keyboard-sized controls, and narrow-screen rules", () => {
  const web = renderResultViewHtml(demoResultView);
  assert.match(web, /<main [^>]*data-result-view-version="1"/);
  assert.match(web, /<section class="card" aria-labelledby="result-title">/);
  assert.match(web, /<h1 id="result-title">/);
  assert.match(web, /<nav class="actions" aria-label="Result actions">/);
  assert.match(web, /min-height:44px/);
  assert.match(web, /overflow-x:clip/);
  assert.match(web, /@media\(max-width:540px\)/);
  assert.match(web, /width:min\(100% - 20px,880px\)/);
  assert.doesNotMatch(web, /user-scalable=no|maximum-scale=1/);
});

test("receipt-view CLI renders a real receipt as retained HTML", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-receipt-view-"));
  const receipt = report("PASS");
  const receiptPath = join(root, "receipt.json");
  const outputPath = join(root, "result.html");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  assert.equal(run(["receipt-view", receiptPath, "--format", "html", "--output", outputPath]), 0);
  const output = readFileSync(outputPath, "utf8");
  assert.match(output, /Agent Vigil PASS/);
  assert.match(output, /Ready to merge\./);
  assert.match(output, new RegExp(OID_A));
  assert.match(output, new RegExp(OID_B));
});
