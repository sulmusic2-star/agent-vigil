import assert from "node:assert/strict";
import test from "node:test";
import { buildReport } from "../src/report.ts";
import { renderMarkdown, renderText } from "../src/output.ts";

const unresolved = buildReport({
  transcript: "hosted-result-language",
  transcriptFormat: "markdown",
  repo: ".",
  base: "a".repeat(40),
  head: "b".repeat(40),
  results: [{
    claim: { kind: "tests_pass", quote: "tests passed", subject: "test suite" },
    verdict: "unverifiable",
    evidence: "the required run did not produce bounded output",
    blocksPass: true,
    ruleId: "tests-pass",
  }],
  policy: { minVerified: 1, strict: true, sha256: `sha256:${"1".repeat(64)}` },
});

test("hosted first-use output calls unresolved evidence NOT CHECKED without a false pass", () => {
  assert.equal(unresolved.summary.status, "INCONCLUSIVE");
  for (const output of [renderText(unresolved), renderMarkdown(unresolved)]) {
    assert.match(output, /NOT CHECKED/);
    assert.match(output, /No merge decision/);
    assert.doesNotMatch(output, /Agent Vigil: PASS/);
  }
});
