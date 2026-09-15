import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderDecisionCard, writeOutputs } from "../src/output.ts";
import { renderProofComment } from "../src/proof-comment.ts";
import { buildReport, type CheckResult } from "../src/report.ts";

// These entrypoints already exist on base. The regression must fail on old
// output, not on an absent helper, fixture, dependency or changed environment.
const PRIVATE = "PRIVATE_RECORD_<script>fixture()</script>_\u001b[2J";
function check(ruleId: string, verdict: CheckResult["verdict"] = "contradicted"): CheckResult {
  return { ruleId, verdict, claim: { kind: "integrity", subject: PRIVATE, quote: PRIVATE }, evidence: PRIVATE };
}
function receipt(results: CheckResult[], strict = true, advisories: CheckResult[] = []) {
  return buildReport({ transcript: PRIVATE, transcriptFormat: "markdown", repo: "/private/fixture", base: "a".repeat(40), head: "b".repeat(40),
    results, advisories, policy: { strict, minVerified: 1, sha256: `sha256:${"c".repeat(64)}` }, reproduction: "PRIVATE_COMMAND --secret PRIVATE_VALUE" });
}

test("Actions summary explains a test-count contradiction without disclosing its evidence", () => {
  const result = check("test-count");
  result.claim.expectedCount = 184;
  result.evidence = `runner reported 161 passed; ${PRIVATE}`;
  const r = receipt([result]);
  const before = JSON.stringify(r);
  for (const render of [renderDecisionCard, renderProofComment]) {
    const text = render(r);
    assert.match(text, /Agent Vigil: FAIL/);
    assert.match(text, /reported passing-test count does not match the observed count/);
    assert.match(text, /claimed: 184; observed: 161/);
    assert.match(text, /\*\*Next:\*\* Run the configured test command/);
    assert.doesNotMatch(text, /PRIVATE_|<script>|\u001b|\/private\/fixture/);
  }
  assert.equal(JSON.stringify(r), before);
});

test("Actions summary states missing verification without claiming a command never ran", () => {
  const text = renderDecisionCard(receipt([]));
  assert.match(text, /Agent Vigil: NOT CHECKED/);
  assert.match(text, /Required verification evidence is missing/);
  assert.doesNotMatch(text, /Agent Vigil: PASS|did not run/);
});

test("Actions summary distinguishes unverifiable command evidence from command failure", () => {
  const unknown = { ...check("automated-review-command", "unverifiable"), blocksPass: true };
  const text = renderDecisionCard(receipt([check("tests-pass", "verified"), unknown], false));
  assert.match(text, /Agent Vigil: NOT CHECKED/);
  assert.match(text, /could not be verified. That does not mean it never ran/);
  assert.doesNotMatch(text, /command did not pass|Agent Vigil: PASS/);
});

test("Actions summary explains a protected path and retains the entire failed count", () => {
  const text = renderDecisionCard(receipt([check("protected-path"), check("tests-pass")]));
  assert.match(text, /file protected by the review policy/);
  assert.match(text, /Failed 2/);
  assert.match(text, /not the complete list/);
  assert.doesNotMatch(text, /PRIVATE_/);
});

test("unknown rule IDs remain generic, including inherited JavaScript property names", () => {
  for (const id of ["__proto__", "constructor", "toString", "tests-pass\u001b[2J"]) {
    const text = renderDecisionCard(receipt([check(id), check("tests-pass")]));
    assert.match(text, /Agent Vigil: FAIL/);
    assert.match(text, /Open the retained receipt/);
    assert.doesNotMatch(text, /Test verification failed|PRIVATE_|\u001b/);
  }
});

test("optional unknown evidence does not turn PASS into a failed requirement", () => {
  const text = renderDecisionCard(receipt([check("tests-pass", "verified"), check("command-ran", "unverifiable")], false));
  assert.match(text, /Agent Vigil: PASS/);
  assert.match(text, /this policy does not require it to pass/);
  assert.doesNotMatch(text, /did not run|\*\*Why:\*\*|\*\*Next:\*\*/);
});

test("advisories do not become a blocking reason in a passing summary", () => {
  const text = renderDecisionCard(receipt([check("tests-pass", "verified")], true, [check("test-skip-added")]));
  assert.match(text, /Agent Vigil: PASS/);
  assert.match(text, /Review notes 1/);
  assert.doesNotMatch(text, /new skipped or focused test/);
});

test("invalid receipt cannot overwrite any existing output", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-hosted-summary-"));
  const output = join(root, "report.json"), sarif = join(root, "report.sarif"), summary = join(root, "summary.md");
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    for (const path of [output, sarif, summary]) writeFileSync(path, "KEEP THIS OUTPUT\n");
    const r = receipt([check("test-count")]);
    r.results[0].evidence = "Changed after hashing";
    assert.throws(() => writeOutputs(r, { output, sarif, githubSummary: true }), /does not match/);
    for (const path of [output, sarif, summary]) assert.equal(readFileSync(path, "utf8"), "KEEP THIS OUTPUT\n");
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
