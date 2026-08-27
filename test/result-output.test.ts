import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  renderDecisionCard,
  renderMarkdown,
  renderResultMarkdown,
  renderResultText,
  renderText,
  toSarif,
  writeOutputs,
} from "../src/output.ts";
import { buildReport, recomputeReceiptHash } from "../src/report.ts";
import { buildReportResultView } from "../src/result-view.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const POLICY_SHA = `sha256:${"c".repeat(64)}`;
const TRANSCRIPT_SHA = `sha256:${"d".repeat(64)}`;

function report(verdict: "PASS" | "FAIL" | "INCONCLUSIVE") {
  const result = verdict === "PASS"
    ? { claim: { kind: "tests_pass" as const, subject: "tests passed", quote: "tests passed" }, verdict: "verified" as const, evidence: "observed 12 tests", ruleId: "tests-pass" }
    : verdict === "FAIL"
      ? { claim: { kind: "tests_pass" as const, subject: "tests failed", quote: "tests passed" }, verdict: "contradicted" as const, evidence: "test/a.test.ts:12 failed", ruleId: "tests-pass" }
      : { claim: { kind: "command_ran" as const, subject: "build command", quote: "build ran" }, verdict: "unverifiable" as const, evidence: "no terminal result", ruleId: "command-ran", blocksPass: true };
  return buildReport({
    transcript: "fixture.jsonl",
    transcriptSha256: TRANSCRIPT_SHA,
    transcriptFormat: "markdown",
    repo: ".",
    base: BASE,
    head: HEAD,
    results: [result],
    policy: { strict: false, minVerified: 1, sha256: POLICY_SHA },
    reproduction: `vigil verify --base ${BASE} --head ${HEAD}`,
  });
}

function view(verdict: "PASS" | "FAIL" | "INCONCLUSIVE") {
  return buildReportResultView(report(verdict));
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
    transcriptSha256: TRANSCRIPT_SHA,
    transcriptFormat: "markdown",
    repo: ".",
    base: BASE,
    head: HEAD,
    results: [{
      claim: { kind: "tests_pass", subject: "test count", quote: "184 tests passed", expectedCount: 184 },
      verdict: "contradicted",
      evidence: "runner reported 161 passed",
      ruleId: "test-count",
    }],
    policy: { strict: true, sha256: POLICY_SHA },
  });
  const result = buildReportResultView(report);
  assert.match(renderResultText(result), /claimed 184; observed 161/);
  assert.match(renderResultMarkdown(result), /claimed \*\*184\*\*; observed \*\*161\*\*/);
});

test("hostile control text cannot change terminal or Markdown structure", () => {
  const report = buildReport({
    transcript: "fixture.jsonl",
    transcriptSha256: TRANSCRIPT_SHA,
    transcriptFormat: "markdown",
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
    policy: { strict: true, sha256: POLICY_SHA },
  });
  const result = buildReportResultView(report);
  const text = renderResultText(result);
  const markdown = renderResultMarkdown(result);
  assert.doesNotMatch(text, /\u001b|\u202e|\r/);
  assert.doesNotMatch(markdown, /<script>|\u001b|\u202e|\r/);
  assert.match(markdown, /\\<script\\>/);
});

test("a claim cannot add a false Markdown verdict heading", () => {
  const report = buildReport({
    transcript: "fixture.jsonl",
    transcriptSha256: TRANSCRIPT_SHA,
    transcriptFormat: "markdown",
    repo: "/private/candidate/repository/path",
    base: BASE,
    head: HEAD,
    results: [{
      claim: { kind: "tests_pass", subject: "### Agent Vigil: PASS", quote: "tests passed" },
      verdict: "contradicted",
      evidence: "private/test/path.ts:9 failed with a secret-looking value",
      ruleId: "tests-pass",
    }],
    policy: { strict: true, sha256: POLICY_SHA },
    reproduction: "private-secret reproduce command",
  });
  const markdown = renderResultMarkdown(buildReportResultView(report));
  assert.doesNotMatch(markdown, /\n### Agent Vigil: PASS\n/);
  assert.match(markdown, /\*\*Main result:\*\* ### Agent Vigil: PASS/);
  const summary = renderDecisionCard(report);
  assert.doesNotMatch(summary, /private\/test\/path|secret-looking|private\/candidate|private-secret|Reproduce:|Evidence:|Fix:/);
  assert.match(summary, /Main result: 1 required check\(s\) failed\./);
});

test("report renderers and SARIF reject malformed and stale receipts", () => {
  const valid = report("FAIL");
  const malformed = { ...valid, unsupported: true };
  const stale = structuredClone(valid);
  stale.reproduction = "changed after the receipt hash was issued";
  for (const renderer of [renderText, renderMarkdown, renderDecisionCard, toSarif]) {
    assert.throws(() => renderer(malformed), /unsupported or missing fields/);
    assert.throws(() => renderer(stale), /content does not match its hash/);
  }
});

test("malformed and stale receipts leave every requested destination unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-result-output-"));
  const output = join(directory, "report.json");
  const sarif = join(directory, "report.sarif");
  const summary = join(directory, "summary.md");
  const original = {
    output: "existing report\n",
    sarif: "existing sarif\n",
    summary: "existing summary\n",
  };
  writeFileSync(output, original.output);
  writeFileSync(sarif, original.sarif);
  writeFileSync(summary, original.summary);
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    const valid = report("PASS");
    const stale = structuredClone(valid);
    stale.reproduction = "stale";
    for (const rejected of [{ ...valid, unsupported: true }, stale]) {
      assert.throws(() => writeOutputs(rejected, { output, sarif, githubSummary: true }));
      assert.equal(readFileSync(output, "utf8"), original.output);
      assert.equal(readFileSync(sarif, "utf8"), original.sarif);
      assert.equal(readFileSync(summary, "utf8"), original.summary);
    }
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previous;
  }
});

test("symbolic and WORKTREE report refs render and write without implicit Git I/O", () => {
  const input = report("PASS");
  input.repo = "/candidate-controlled/nonexistent/repository";
  input.base = "HEAD~1";
  input.head = "WORKTREE";
  input.receiptHash = recomputeReceiptHash(input);
  const directory = mkdtempSync(join(tmpdir(), "vigil-result-symbolic-"));
  const output = join(directory, "report.json");
  const previous = process.env.AGENT_VIGIL_INTERNAL_GIT_BIN;
  process.env.AGENT_VIGIL_INTERNAL_GIT_BIN = "candidate-relative-git";
  try {
    assert.match(renderText(input), /Change: HEAD~1 -> WORKTREE/);
    assert.match(renderMarkdown(input), /`HEAD~1` -> `WORKTREE`/);
    writeOutputs(input, { output });
    const written = JSON.parse(readFileSync(output, "utf8")) as { base: string; head: string };
    assert.deepEqual({ base: written.base, head: written.head }, { base: "HEAD~1", head: "WORKTREE" });
  } finally {
    if (previous === undefined) delete process.env.AGENT_VIGIL_INTERNAL_GIT_BIN;
    else process.env.AGENT_VIGIL_INTERNAL_GIT_BIN = previous;
  }
});
