import assert from "node:assert/strict";
import test from "node:test";
import { renderResultMarkdown, renderResultText } from "../src/output.ts";
import { buildReport } from "../src/report.ts";
import { buildReportResultView } from "../src/result-view.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function view(verdict: "PASS" | "FAIL" | "INCONCLUSIVE") {
  const result = verdict === "PASS"
    ? { claim: { kind: "tests_pass" as const, subject: "tests passed", quote: "tests passed" }, verdict: "verified" as const, evidence: "observed 12 tests", ruleId: "tests-pass" }
    : verdict === "FAIL"
      ? { claim: { kind: "tests_pass" as const, subject: "tests failed", quote: "tests passed" }, verdict: "contradicted" as const, evidence: "test/a.test.ts:12 failed", ruleId: "tests-pass" }
      : { claim: { kind: "command_ran" as const, subject: "build command", quote: "build ran" }, verdict: "unverifiable" as const, evidence: "no terminal result", ruleId: "command-ran", blocksPass: true };
  return buildReportResultView(buildReport({
    transcript: "fixture.jsonl",
    transcriptFormat: "fixture",
    repo: ".",
    base: BASE,
    head: HEAD,
    results: [result],
    policy: { strict: false, minVerified: 1, sha256: "sha256:policy" },
    reproduction: `vigil verify --base ${BASE} --head ${HEAD}`,
  }));
}

test("text and Markdown keep one structure for every verdict", () => {
  for (const verdict of ["PASS", "FAIL", "INCONCLUSIVE"] as const) {
    const text = renderResultText(view(verdict));
    const markdown = renderResultMarkdown(view(verdict));
    assert.match(text, new RegExp(`^Agent Vigil: ${verdict}\\n`));
    assert.match(markdown, new RegExp(`^### Agent Vigil: ${verdict}\\n`));
    assert.match(text, /Failed \d+ · Passed \d+ · Not checked \d+/);
    assert.match(markdown, /\*\*Checks:\*\* Failed \d+ · Passed \d+ · Not checked \d+/);
    assert.match(text, new RegExp(`Change: ${BASE} -> ${HEAD}`));
    assert.match(markdown, new RegExp(`\\*\\*Change:\\*\\* \`${BASE}\` -> \`${HEAD}\``));
  }
});

test("claimed and observed counts remain separate in text and Markdown", () => {
  const report = buildReport({
    transcript: "fixture.jsonl",
    transcriptFormat: "fixture",
    repo: ".",
    base: BASE,
    head: HEAD,
    results: [{
      claim: { kind: "tests_pass", subject: "test count", quote: "184 tests passed", expectedCount: 184 },
      verdict: "contradicted",
      evidence: "runner reported 161 passed",
      ruleId: "test-count",
    }],
    policy: { strict: true, sha256: "sha256:policy" },
  });
  const result = buildReportResultView(report);
  assert.match(renderResultText(result), /claimed 184; observed 161/);
  assert.match(renderResultMarkdown(result), /claimed \*\*184\*\*; observed \*\*161\*\*/);
});

test("hostile control text cannot change terminal or Markdown structure", () => {
  const report = buildReport({
    transcript: "fixture.jsonl",
    transcriptFormat: "fixture",
    repo: ".",
    base: BASE,
    head: HEAD,
    results: [{
      claim: { kind: "command_ran", subject: "<script>\u001b[31mspoof\u202e", quote: "ran" },
      verdict: "unverifiable",
      evidence: "missing\rresult",
      ruleId: "command-ran",
      blocksPass: true,
    }],
    policy: { strict: true, sha256: "sha256:policy" },
  });
  const result = buildReportResultView(report);
  const text = renderResultText(result);
  const markdown = renderResultMarkdown(result);
  assert.doesNotMatch(text, /\u001b|\u202e|\r/);
  assert.doesNotMatch(markdown, /<script>|\u001b|\u202e|\r/);
  assert.match(markdown, /\\<script\\>/);
});
