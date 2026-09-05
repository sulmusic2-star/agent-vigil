import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkEmptyTestBodies } from "../src/detectors/test-bodies.ts";
import { checkIntegrity } from "../src/detectors/reality.ts";
import { routeIntegrity } from "../src/integrity-policy.ts";
import { remediationFor } from "../src/remediation.ts";

const before = "test('total', () => { assert.equal(total([2, 3]), 5); });"; // vigil:detector-pattern (literal regression input, not a registered test)
const empty = "test('total', () => { /* test removed */ });"; // vigil:detector-pattern (literal regression input, not a registered test)

for (const [label, callback] of [
  ["comment-only", "() => { /* deliberately empty */ }"],
  ["line comment", "() => { // deliberately empty\n }"],
  ["empty", "() => {}"],
  ["async", "async () => { /* deliberately empty */ }"],
  ["function", "function () { /* deliberately empty */ }"],
  ["named function", "function check() { /* deliberately empty */ }"],
  ["parameter", "t => { /* deliberately empty */ }"],
  ["semicolons", "() => { ;;; }"],
  ["literal", "() => { 'done'; 42; true; }"],
  ["static template", "() => { `done`; }"],
  ["bare return", "() => { return; }"],
]) {
  test(`full-file inspection blocks a newly ${label} callback`, () => {
    const findings = checkEmptyTestBodies("test/index.test.js", before, `test('total', ${callback});`); // vigil:detector-pattern (literal regression input, not a registered test)
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, "test-empty-added");
    assert.equal(routeIntegrity(findings, "calibrated").results[0].verdict, "contradicted");
  });
}

for (const [label, source] of [
  ["helper delegation", "test('total', () => { checkTotal(); });"], // vigil:detector-pattern (literal regression input, not a registered test)
  ["expression callback", "test('total', () => checkTotal());"], // vigil:detector-pattern (literal regression input, not a registered test)
  ["returned helper", "test('total', () => { return checkTotal(); });"], // vigil:detector-pattern (literal regression input, not a registered test)
  ["default parameter behavior", "test('total', (t = checkTotal()) => {});"], // vigil:detector-pattern (literal regression input, not a registered test)
  ["dynamic template behavior", "test('total', () => { `${checkTotal()}`; });"], // vigil:detector-pattern (literal regression input, not a registered test)
  ["strings", 'const example = "test(\'total\', () => {})";'], // vigil:detector-pattern (literal regression input, not a registered test)
  ["templates", 'const example = `test("total", () => {})`;'], // vigil:detector-pattern (literal regression input, not a registered test)
  ["comments", '/* test("total", () => {}) */'], // vigil:detector-pattern (literal regression input, not a registered test)
  ["regular expression", 'const pattern = /test("total", () => {})/;'], // vigil:detector-pattern (literal regression input, not a registered test)
  ["unrelated method", "obj.test('total', () => {});"], // vigil:detector-pattern (literal regression input, not a registered test)
  ["unrelated nested method", "a.b.test('total', () => {});"], // vigil:detector-pattern (literal regression input, not a registered test)
  ["non-function argument", "test('total', checkTotal);"], // vigil:detector-pattern (literal regression input, not a registered test)
]) {
  test(`full-file inspection does not mistake ${label} for an empty test`, () => {
    assert.deepEqual(checkEmptyTestBodies("test/index.test.js", "", source), []);
  });
}

test("same-file additions and duplicate names cannot offset an emptied callback", () => {
  for (const addition of ["test('new feature', () => { assert.ok(difference()); });", before]) { // vigil:detector-pattern (literal regression input, not a registered test)
    const checks = checkEmptyTestBodies("index.test.js", before, `${empty}\n${addition}`);
    assert.equal(checks.filter((check) => check.ruleId === "test-empty-added").length, 1);
  }
  assert.deepEqual(checkEmptyTestBodies("index.test.js", empty, `${empty}\n${before}`), []);
  assert.deepEqual(checkEmptyTestBodies("index.test.js", empty, empty), []);
});

test("literal test names, options, subtests, and common test modifiers are inspected", () => {
  for (const source of [
    "it('total', () => {});", "test(`total`, () => {});", "test('total', {timeout: 100}, () => {});", // vigil:detector-pattern (literal regression input, not a registered test)
    "test.only('total', () => {});", "it['skip']('total', () => {});", "t.test('total', () => {});", // vigil:detector-pattern (literal regression input, not a registered test)
  ]) assert.equal(checkEmptyTestBodies("index.test.mjs", before, source)[0]?.ruleId, "test-empty-added", source);
  assert.equal(checkEmptyTestBodies("index.test.cjs", "", "const test = require('node:test');\ntest('cjs', () => {});")[0]?.ruleId, "test-empty-added");
});

test("a repeated title cannot exchange an empty and a meaningful body and still look clean", () => {
  const base = `describe('old placeholder', () => { ${empty} });\ndescribe('real behavior', () => { ${before} });`;
  const head = `describe('old placeholder', () => { ${before} });\ndescribe('real behavior', () => { ${empty} });`;
  const checks = checkEmptyTestBodies("index.test.js", base, head);
  assert.equal(checks[0]?.ruleId, "test-body-ambiguous");
  assert.equal(checks[0]?.verdict, "unverifiable");
  assert.equal(checks[0]?.blocksPass, true);
  assert.match(remediationFor("test-body-ambiguous"), /distinct names/);
  for (const reference of ["test('total', () => checkTotal());", "test('total', checkTotal);"]) { // vigil:detector-pattern (literal regression input, not a registered test)
    const result = checkEmptyTestBodies("index.test.js", `${empty}\n${reference}`, `${reference}\n${empty}`);
    assert.equal(result[0]?.ruleId, "test-body-ambiguous");
  }
});

test("moving a pre-existing empty test byte-for-byte does not introduce an empty test", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-empty-test-move-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Vigil Test"); git("config", "user.email", "vigil@example.test");
    writeFileSync(join(root, "old.test.js"), empty);
    git("add", "."); git("commit", "-qm", "existing placeholder");
    const base = git("rev-parse", "HEAD");
    git("mv", "old.test.js", "new.test.js"); git("commit", "-qm", "exact move");
    const checks = checkIntegrity(root, base, git("rev-parse", "HEAD"));
    assert.equal(checks.some((check) => check.ruleId === "test-empty-added"), false, JSON.stringify(checks));
    assert.equal(checks.find((check) => check.ruleId === "test-file-replaced")?.verdict, "verified");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unparseable JavaScript is missing evidence, not an empty clean scan", () => {
  for (const [base, head] of [[before, "test("], ["test(", before], [before, "(".repeat(20_000)]]) { // vigil:detector-pattern (literal regression input, not a registered test)
    const checks = checkEmptyTestBodies("index.test.js", base, head);
    assert.equal(checks[0].verdict, "unverifiable");
    assert.equal(checks[0].blocksPass, true);
    assert.equal(routeIntegrity(checks, "calibrated").results.length, 1);
  }
  assert.match(remediationFor("test-body-unreadable"), /JavaScript syntax/);
  assert.match(remediationFor("test-empty-added"), /Passing tests elsewhere do not replace it/);
});

test("this narrow check does not claim support for TypeScript, JSX, or dynamic test names", () => {
  assert.deepEqual(checkEmptyTestBodies("index.test.ts", before, empty), []);
  assert.deepEqual(checkEmptyTestBodies("index.test.jsx", before, empty), []);
  assert.deepEqual(checkEmptyTestBodies("index.test.js", before, "test(name, () => {});"), []); // vigil:detector-pattern (literal regression input, not a registered test)
});

test("ordinary CI stays green for the mixed change, but exact-SHA and worktree integrity block it", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-mixed-change-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Vigil Test");
    git("config", "user.email", "vigil@example.test");
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const imports = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../index.js';\n";
    writeFileSync(join(root, "index.js"), "export const total = values => values.reduce((a, b) => a + b, 0);\n");
    writeFileSync(join(root, "test/index.test.js"), imports + before);
    git("add", "."); git("commit", "-qm", "baseline");
    const base = git("rev-parse", "HEAD");
    const newCode = "export const difference = (left, right) => left - right;\n";
    writeFileSync(join(root, "index.js"), "export const total = values => values.reduce((a, b) => a + b, 0);\n" + newCode);
    writeFileSync(join(root, "test/difference.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {difference} from '../index.js';\ntest('difference', () => { assert.equal(difference(7, 2), 5); });");
    git("add", "."); git("commit", "-qm", "good addition");
    const good = git("rev-parse", "HEAD");
    assert.equal(routeIntegrity(checkIntegrity(root, base, good), "calibrated").results.some((check) => check.verdict !== "verified"), false);
    writeFileSync(join(root, "index.js"), "export const total = values => 0;\n" + newCode);
    writeFileSync(join(root, "test/index.test.js"), imports + empty);
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const ordinary = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], { cwd: root, env: environment, encoding: "utf8", timeout: 10_000 });
    assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
    assert.match(ordinary.stdout, /# pass 2/);
    git("add", "."); git("commit", "-qm", "broken total with its test emptied");
    for (const head of [git("rev-parse", "HEAD"), "WORKTREE"]) {
      const checks = routeIntegrity(checkIntegrity(root, base, head), "calibrated").results;
      const failure = checks.find((check) => check.ruleId === "test-empty-added");
      assert.equal(failure?.verdict, "contradicted", JSON.stringify(checks));
      assert.match(failure!.evidence, /test\/index.test.js:4/);
    }
    // A direct runtime observation independently confirms the regression.
    const observed = execFileSync(process.execPath, ["--input-type=module", "-e", "import {total} from './index.js'; console.log(total([2,3]));"], { cwd: root, encoding: "utf8" });
    assert.equal(observed.trim(), "0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
