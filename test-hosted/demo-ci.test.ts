import assert from "node:assert/strict";
import { test } from "node:test";
import { demoCiVerdict, parseDemoTestCounts, runCiDemo, runCiDemoCommand } from "../src/demo-ci.ts";

const counts = "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
test("CI demo requires complete, consistent, unique observed counts", () => {
  assert.equal(parseDemoTestCounts(counts)?.tests, 2);
  for (const invalid of ["", counts.replace("# pass 2\n", ""), counts + "# tests 99\n", counts.replace("# pass 2", "# pass 3"), counts.replace("# tests 2", "# tests 9007199254740993")]) {
    assert.equal(parseDemoTestCounts(invalid), undefined);
  }
  assert.equal(parseDemoTestCounts(counts.replaceAll("\n", "\r\n"))?.tests, 2);
});
test("incomplete, cancelled, skipped, and failed runs never become CI PASS", () => {
  const observed = parseDemoTestCounts(counts)!;
  assert.equal(demoCiVerdict(0, false, observed), "PASS");
  assert.equal(demoCiVerdict(0, false, undefined), "NOT CHECKED");
  assert.equal(demoCiVerdict(null, false, observed), "NOT CHECKED");
  assert.equal(demoCiVerdict(0, true, observed), "NOT CHECKED");
  assert.equal(demoCiVerdict(1, false, observed), "FAIL");
  for (const field of ["skipped", "todo", "cancelled", "fail"] as const) {
    assert.equal(demoCiVerdict(0, false, {...observed, pass: 1, [field]: 1}), "FAIL");
  }
  assert.equal(demoCiVerdict(0, false, {...observed, tests: 0, pass: 0}), "FAIL");
});
test("real local commands demonstrate bounded added protection, not merge authority or savings", () => {
  const result = runCiDemo();
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supportsFloors = major > 22 || (major === 22 && minor >= 8);
  if (!supportsFloors) {
    assert.equal(result.reproduced, false);
    assert.ok(result.rows.some(row => row.ci === "NOT CHECKED"));
    return;
  }
  assert.equal(result.reproduced, true);
  assert.equal(result.humanMinutesSaved, null);
  assert.match(result.scope, /Not a hosted check or merge authorization/);
  assert.equal(result.rows.length, 6);
  const empty = result.rows.find(row => row.id === "emptied-test")!;
  assert.equal(empty.ci, "PASS");
  assert.equal(empty.integrity, "FAIL");
  assert.equal(empty.counts?.tests, 2);
  assert.equal(empty.counts?.skipped, 0);
  assert.ok(empty.hard.some(check => check.ruleId === "test-empty-added"));
  assert.equal(empty.runs.length, 3);
  assert.ok(empty.runs.at(-1)!.command.includes("--test-coverage-lines=100"));
  for (const row of result.rows) {
    assert.match(row.base, /^[0-9a-f]{40}$/);
    assert.match(row.head, /^[0-9a-f]{40}$/);
    assert.match(row.diffSha256, /^[0-9a-f]{64}$/);
    assert.match(row.reference.testSourceSha256, /^[0-9a-f]{64}$/);
    assert.equal(row.reference.testSourceCommit, row.base);
    assert.equal(row.reference.candidateCommit, row.head);
  }
  assert.equal(result.rows.find(row => row.id === "wrong-result")!.ci, "FAIL");
  assert.equal(result.rows.find(row => row.id === "helper-refactor")!.combined, "PASS");
  const hidden = result.rows.find(row => row.id === "hidden-regression")!;
  assert.equal(hidden.ci, "PASS");
  assert.equal(hidden.integrity, "FAIL");
  assert.equal(hidden.reference.verdict, "FAIL");
  assert.ok(hidden.hard.some(row => row.ruleId === "test-oracle-constant"));
  const missed = result.rows.find(row => row.id === "rewritten-expectations")!;
  assert.equal(missed.combined, "PASS");
  assert.equal(missed.reference.verdict, "FAIL", "do not hide the stronger baseline's catch");
});
test("CI demo rejects unrelated arguments before running", () => {
  assert.throws(() => runCiDemoCommand(["--repo", "/private"]), /usage/);
});
