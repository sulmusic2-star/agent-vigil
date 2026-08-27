import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { remediationFor } from "../src/remediation.ts";
import { buildReport } from "../src/report.ts";
import {
  buildReportResultView,
  readChangedFileManifest,
  renderResultViewHtml,
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
  assert.throws(() => buildReportResultView(input), /refused an inconsistent receipt summary/);
});

test("claimed and observed test counts stay distinct and hostile text is neutralized", () => {
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
  const web = renderResultViewHtml(view);
  assert.doesNotMatch(web, /\u001b|\u202e|\r/);
  assert.doesNotMatch(web, /<script>alert\(1\)<\/script>/);
});

test("PASS, FAIL, and INCONCLUSIVE use the same result structure", () => {
  const views = (["PASS", "FAIL", "INCONCLUSIVE"] as const).map((value) => buildReportResultView(report(value)));
  const topKeys = Object.keys(views[0]);
  const countKeys = Object.keys(views[0].counts);
  for (const view of views) {
    assert.deepEqual(Object.keys(view), topKeys);
    assert.deepEqual(Object.keys(view.counts), countKeys);
  }
});

test("changed-file manifest covers the exact Git range including renames", () => {
  const repo = mkdtempSync(join(tmpdir(), "vigil-result-model-"));
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
  assert.equal(manifest.complete, true);
  assert.deepEqual([...new Set(manifest.files.map((file) => file.path))].sort(), gitNames);
  assert.ok(manifest.files.some((file) => file.status === "renamed"));
});

test("result web view has labeled landmarks and narrow-screen rules", () => {
  const web = renderResultViewHtml(buildReportResultView(report("FAIL")));
  assert.match(web, /<main [^>]*data-result-view-version="1"/);
  assert.match(web, /<section class="card" aria-labelledby="result-title">/);
  assert.match(web, /<nav class="actions" aria-label="Result actions">/);
  assert.match(web, /min-height:44px/);
  assert.match(web, /@media\(max-width:540px\)/);
  assert.doesNotMatch(web, /user-scalable=no|maximum-scale=1/);
});

test("remediation is concrete for known rules and conservative for unknown rules", () => {
  assert.match(remediationFor("test-count"), /vigil doctor/);
  assert.equal(remediationFor("unknown-rule"), "Provide objective evidence or remove the unsupported claim.");
});
