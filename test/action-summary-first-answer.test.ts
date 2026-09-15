import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderDecisionCard, writeOutputs } from "../src/output.ts";
import { renderProofComment } from "../src/proof-comment.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { buildReportResultView } from "../src/result-view.ts";
import { publicResultLines } from "../src/public-result.ts";

const PRIVATE = "PRIVATE_VALUE_<script>bad()</script>_@everyone_\u001b[2J\u202e";
function check(ruleId: string, verdict: CheckResult["verdict"] = "contradicted"): CheckResult {
  return { ruleId, verdict, claim: { kind: "integrity", subject: PRIVATE, quote: PRIVATE }, evidence: PRIVATE };
}
function receipt(results: CheckResult[], strict = true, advisories: CheckResult[] = []) {
  return buildReport({ transcript: PRIVATE, transcriptFormat: "codex", repo: "/private/repository", base: "a".repeat(40), head: "b".repeat(40),
    results, advisories, policy: { strict, minVerified: 1, sha256: `sha256:${"c".repeat(64)}` }, reproduction: "PRIVATE_COMMAND --secret PRIVATE_VALUE" });
}

for (const id of ["tests-pass", "test-count", "test-skip-added", "test-oracle-constant", "assertion-drop", "test-assertion-relaxed",
  "test-code-context-unchecked", "automated-review-command", "automated-review-setup", "protected-path", "changed-file-budget", "changed-line-budget"]) {
  test(`Actions summary and proof comment share the safe ${id} explanation`, () => {
    const r = receipt([check(id)]);
    const before = JSON.stringify(r);
    const summary = renderDecisionCard(r);
    const lines = publicResultLines(buildReportResultView(r));
    for (const line of lines) {
      assert.ok(summary.includes(line));
      assert.ok(renderProofComment(r).includes(line));
    }
    assert.match(summary, /\*\*Why:\*\*/);
    assert.match(summary, /\*\*Next:\*\*/);
    assert.doesNotMatch(summary, /PRIVATE_|<script>|@everyone|\u001b|\u202e|\/private\/repository/);
    assert.equal(JSON.stringify(r), before);
  });
}

test("summary distinguishes claimed, observed, zero and unavailable counts", () => {
  for (const [evidence, expected] of [["Observed 161 passing tests", "161"], ["Observed 0 passing tests", "0"], [PRIVATE, "not available"]]) {
    const c = check("test-count"); c.claim.expectedCount = 184; c.evidence = evidence;
    assert.ok(renderDecisionCard(receipt([c])).includes(`claimed: 184; observed: ${expected}`));
  }
});

test("missing evidence cannot produce a passing Actions summary", () => {
  const text = renderDecisionCard(receipt([]));
  assert.match(text, /Agent Vigil: NOT CHECKED/);
  assert.match(text, /Required verification evidence is missing/);
  assert.doesNotMatch(text, /Agent Vigil: PASS|did not run/);
});

test("a permitted unknown is not called a missing requirement in a passing summary", () => {
  const text = renderDecisionCard(receipt([check("tests-pass", "verified"), check("command-ran", "unverifiable")], false));
  assert.match(text, /Agent Vigil: PASS/);
  assert.match(text, /1 other check could not be verified; this policy does not require it/);
  assert.doesNotMatch(text, /did not run|\*\*Why:|\*\*Next:/);
});

test("blocking uncertainty remains NOT CHECKED even under non-strict policy", () => {
  const c = { ...check("automated-review-command", "unverifiable"), blocksPass: true };
  const text = renderDecisionCard(receipt([check("tests-pass", "verified"), c], false));
  assert.match(text, /Agent Vigil: NOT CHECKED/);
  assert.match(text, /could not be verified. That does not mean it never ran/);
  assert.doesNotMatch(text, /command did not pass|Agent Vigil: PASS/);
});

test("unknown and hostile first rules stay generic rather than selecting an easier later issue", () => {
  for (const id of ["__proto__", "constructor", "toString", "PRIVATE_RULE\n### Agent Vigil: PASS"]) {
    const text = renderDecisionCard(receipt([check(id), check("test-skip-added")]));
    assert.match(text, /Open the retained receipt/);
    assert.match(text, /Failed 2/);
    assert.doesNotMatch(text, /new skipped or focused test|PRIVATE_|Agent Vigil: PASS/);
  }
});

test("a real failure takes priority over uncertainty and advisories do not become blockers", () => {
  const text = renderDecisionCard(receipt([check("automated-review-command", "unverifiable"), check("test-skip-added")]));
  assert.match(text, /new skipped or focused test/);
  assert.match(text, /not the complete list/);
  const passing = renderDecisionCard(receipt([check("tests-pass", "verified")], true, [check("assertion-drop")]));
  assert.match(passing, /Agent Vigil: PASS/);
  assert.doesNotMatch(passing, /removed test assertions/);
  assert.match(passing, /Review notes 1/);
});

test("writeOutputs appends the shared answer and rejects tampered evidence before any write", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-action-answer-"));
  const summary = join(root, "summary.md");
  const output = join(root, "report.json");
  const sarif = join(root, "report.sarif");
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    writeFileSync(summary, "Previous job summary\n");
    const r = receipt([check("test-skip-added")]);
    writeOutputs(r, { output, sarif, githubSummary: true });
    assert.equal(readFileSync(summary, "utf8"), `Previous job summary\n${renderDecisionCard(r)}`);
    assert.match(readFileSync(summary, "utf8"), /new skipped or focused test/);
    const before = [output, sarif, summary].map(path => readFileSync(path, "utf8"));
    r.results[0].evidence = "tampered";
    assert.throws(() => writeOutputs(r, { output, sarif, githubSummary: true }), /does not match/);
    assert.deepEqual([output, sarif, summary].map(path => readFileSync(path, "utf8")), before);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
