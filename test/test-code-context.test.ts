import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileCodeContext, bindAddedCodeContext, matchTestCode, uncheckedTestCode } from "../src/detectors/test-code-context.ts";
import { checkIntegrity, checkIntegrityDiff } from "../src/detectors/reality.ts";
import { checkAgenticPatches } from "../src/detectors/agentic.ts";
import { buildReport } from "../src/report.ts";
import { buildReportResultView } from "../src/result-view.ts";
import { renderResultText, renderResultMarkdown } from "../src/output.ts";
import { routeIntegrity } from "../src/integrity-policy.ts";

const skipPattern = /\btest\.skip\s*\(/;
function classify(source: string, path = "test/context.mjs", added = source.split("\n"), numbers = added.map((_, index) => index + 1)) {
  const codeContext = bindAddedCodeContext(readFileCodeContext(path, source), added, numbers);
  return { path, added, codeContext };
}
function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], { cwd: repo, encoding: "utf8" }).trim();
}
function fixture(t: any, path: string, before: string, after: string) {
  const repo = mkdtempSync(join(tmpdir(), "vigil-code-context-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), before);
  writeFileSync(join(repo, "evaluate.mjs"), "export const run = (source) => (0,eval)(source);\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base"); const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, path), after);
  git(repo, "add", "."); git(repo, "commit", "-qm", "candidate"); const head = git(repo, "rev-parse", "HEAD");
  return { repo, base, head };
}

type Case = { id: string; path: string; before: string; after: string; rule: string; expected: "contradicted" | "unchecked"; native: boolean };
const cases: Case[] = JSON.parse(readFileSync(new URL("./fixtures/literal-context.json", import.meta.url), "utf8")).cases;
for (const c of cases) test(`exact-commit literal context: ${c.id}`, t => {
  const f = fixture(t, c.path, c.before, c.after);
  const checks = checkIntegrity(f.repo, f.base, f.head);
  const direct = checks.find(check => check.ruleId === c.rule && check.verdict === "contradicted");
  const hold = checks.find(check => check.ruleId === "test-code-context-unchecked" && check.evidence.includes(c.rule));
  if (c.expected === "contradicted") assert.ok(direct, JSON.stringify(checks));
  else {
    assert.equal(direct, undefined, JSON.stringify(checks));
    assert.equal(hold?.verdict, "unverifiable"); assert.equal(hold?.blocksPass, true); assert.equal(hold?.contributesToPass, false);
  }
  // The ESM-in-.txt native attempt is retained as a failed experiment in the
  // research ledger. Native CJS text-extension execution is tested below.
  if (c.native && c.id !== "text-executable" && (!c.path.endsWith(".ts") || Number(process.versions.node.split(".")[0]) >= 22)) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", c.path], { cwd: f.repo, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr); assert.match(run.stdout, /# pass 1\b/); assert.match(run.stdout, /# skipped 1\b/);
  }
});

for (const extension of ["txt", "md", "cjs"]) test(`native CommonJS ${extension} code is not excused as documentation`, t => {
  const before = "const test=require('node:test');const assert=require('node:assert/strict');\ntest('baseline',()=>assert.equal(2+2,4));\n";
  const after = before + "test.skip('real',()=>assert.equal(2+2,4));\n";
  const path = `test/runner.${extension}`;
  const f = fixture(t, path, before, after);
  assert.ok(checkIntegrity(f.repo, f.base, f.head).some(c => c.ruleId === "test-skip-added" && c.verdict === "contradicted"));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path], { cwd: f.repo, env, encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr); assert.match(run.stdout, /# pass 1\b/); assert.match(run.stdout, /# skipped 1\b/);
});

test("binding rejects a mismatched, repeated, reversed or missing changed-line position", () => {
  const source = 'const example="test.skip(example)";\ntest.skip("real",()=>{});';
  const context = readFileCodeContext("test/context.mjs", source);
  for (const numbers of [undefined, [2, 1], [1, 1], [1], [0, 2], [1.5, 2], [1, 999]]) {
    assert.equal(bindAddedCodeContext(context, source.split("\n"), numbers), undefined);
  }
  assert.equal(bindAddedCodeContext(context, ['test.skip("real",()=>{});'], [1]), undefined);
});

test("identical text in different contexts binds to the correct occurrence", () => {
  const source = 'const example=`\ntest.skip("same",()=>{});\n`;\ntest.skip("same",()=>{});';
  const line = 'test.skip("same",()=>{});';
  assert.equal(matchTestCode(classify(source, "test/context.mjs", [line], [2]), [skipPattern])?.quoted, true);
  assert.equal(matchTestCode(classify(source, "test/context.mjs", [line], [4]), [skipPattern])?.quoted, false);
});

test("UTF-16 and CRLF offsets preserve executable and quoted occurrences", () => {
  const source = 'const label="🛰️";\r\nconst example="test.skip(example)";\r\ntest.skip("real",()=>{});\r\n';
  assert.equal(matchTestCode(classify(source, "test/context.mjs", [source.split("\n")[1]], [2]), [skipPattern])?.quoted, true);
  assert.equal(matchTestCode(classify(source, "test/context.mjs", [source.split("\n")[2]], [3]), [skipPattern])?.quoted, false);
});

test("a greedy quoted branch match cannot hide a later executable branch", () => {
  const source = 'const example="if(false)"; if(false){assert.equal(2+2,4);}';
  const rule = /\bif\s*\(false\)[\s\S]{0,1000}\bassert\b/;
  assert.equal(matchTestCode(classify(source), [rule], true)?.quoted, false);
});

test("literal arguments remain part of a real constant assertion", () => {
  const rule = /expect\("x"\)\.toBe\("x"\)/;
  assert.equal(matchTestCode(classify('expect("x").toBe("x");'), [rule])?.quoted, false);
});

for (const path of ["test/context.tsx", "test/context.jsx", "test/context.custom", "test/context.py"]) test(`unsupported context retains raw matching: ${path}`, () => {
  const source = 'const example="test.skip(example)";';
  assert.equal(readFileCodeContext(path, source), undefined);
  assert.equal(matchTestCode(classify(source, path), [skipPattern])?.quoted, false);
});

for (const source of ['', '\0', '\ufffd', 'x'.repeat(1024 * 1024 + 1), 'const x="unfinished']) test(`unreadable context is not used (${source.length} characters)`, () => {
  assert.equal(readFileCodeContext("test/context.mjs", source), undefined);
});

test("a raw diff and a mutable worktree do not gain quoted-context exemptions", t => {
  const c = cases.find(c => c.id === "literal-skip")!;
  const f = fixture(t, c.path, c.before, c.after);
  const diff = git(f.repo, "diff", "--unified=0", f.base, f.head);
  for (const checks of [checkIntegrityDiff(diff), checkIntegrity(f.repo, f.base, "WORKTREE")]) {
    assert.ok(checks.some(c => c.ruleId === "test-skip-added" && c.verdict === "contradicted"));
    assert.equal(checks.some(c => c.ruleId === "test-code-context-unchecked"), false);
  }
});

test("separate Git hunks keep their exact new-file line numbers", t => {
  const before = 'const example=`\noriginal text\n`;\n' + '\n'.repeat(15) + 'export const value=1;\n';
  const after = before.replace('original text', 'test.skip("example")').replace('value=1', 'value=2');
  const f = fixture(t, "test/context.mjs", before, after);
  const checks = checkIntegrity(f.repo, f.base, f.head);
  assert.equal(checks.some(c => c.ruleId === "test-skip-added"), false);
  assert.ok(checks.some(c => c.ruleId === "test-code-context-unchecked" && c.blocksPass));
});

test("quoted-code uncertainty cannot become advisory or contribute to PASS", () => {
  const check = uncheckedTestCode("test/context.mjs", "test-skip-added");
  for (const mode of ["blocking", "calibrated", "advisory"] as const) {
    const routed = routeIntegrity([check], mode);
    assert.ok(routed.results.some(c => c.ruleId === check.ruleId && c.blocksPass && c.verdict === "unverifiable" && !c.contributesToPass));
  }
});

// Retain the old filtered-text semantics and map positions back separately.
// Padding must not exhaust a bounded pattern and make a real catch disappear.
test("detector annotations cannot exhaust the swallowed-assertion match budget", () => {
  const source = "try {\n" + "// vigil:detector-pattern\n".repeat(1202) + "assert.equal(1,2);\n} catch {}\n";
  const patch = { ...classify(source), removed: [], context: [] };
  for (const codeContext of [undefined, patch.codeContext]) {
    assert.ok(checkAgenticPatches([{ ...patch, codeContext }]).some(c => c.ruleId === "oracle-falsify" && c.verdict === "contradicted"));
  }
});

for (const [name, quoted, direct, rule] of [
  ["skip", 'const example="test.skip(example)";', 'test.skip("real",()=>{});', "test-skip-added"],
  ["constant oracle", 'const example="assert.ok(true)";', 'assert.ok(true);', "test-oracle-constant"],
  ["unreachable oracle", 'const example="if(false) assert.equal(2+2,4)";', 'if(false){assert.equal(2+2,4);}', "oracle-falsify"],
] as const) test(`a real ${name} cannot erase a quoted-code hold in advisory mode`, t => {
  const source = `${quoted}\n${direct}\n`;
  const f = fixture(t, "test/context.mjs", "export const version=1;\n", source);
  const checks = checkIntegrity(f.repo, f.base, f.head);
  assert.ok(checks.some(c => c.ruleId === rule && c.verdict === "contradicted"));
  assert.ok(checks.some(c => c.ruleId === "test-code-context-unchecked" && c.blocksPass));
  assert.ok(routeIntegrity(checks, "advisory").results.some(c => c.blocksPass && c.verdict === "unverifiable"));
});

test("a direct skip in another file cannot erase a quoted-code hold", t => {
  const f = fixture(t, "test/quoted.mjs", "export const value=1;\n", 'const example="test.skip(example)";\n');
  writeFileSync(join(f.repo, "test/direct.mjs"), 'test.skip("real",()=>{});\n');
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "second file");
  const checks = checkIntegrity(f.repo, f.base, git(f.repo, "rev-parse", "HEAD"));
  assert.ok(routeIntegrity(checks, "advisory").results.some(c => c.ruleId === "test-code-context-unchecked" && c.blocksPass));
});

for (const fence of ["````", "~~~~"]) test(`short or wrong Markdown fence cannot open a prose exemption: ${fence}`, () => {
  const source = `# Examples\n${fence}js\n\`\`\`\n\`test.skip(example)\`\n${fence}\n`;
  assert.equal(matchTestCode(classify(source, "docs/TEST_GUIDE.md"), [skipPattern])?.quoted, false);
});

test("raw HTML is not treated as Markdown prose", () => {
  const source = '# Examples\n<script>\n`test.skip(example)`\n</script>\n';
  assert.equal(readFileCodeContext("docs/TEST_GUIDE.md", source), undefined);
});


test("a quoted-code hold remains NOT CHECKED after real report construction", () => {
  // A synthetic verified unit-test input deliberately meets minVerified, so
  // this exercises blocksPass rather than relying on missing positive proof.
  const verified = { claim: { kind: "tests_pass" as const, quote: "unit control", subject: "unit control" }, verdict: "verified" as const, evidence: "synthetic report-routing control" };
  for (const mode of ["blocking", "calibrated", "advisory"] as const) {
    const routed = routeIntegrity([uncheckedTestCode("test/context.mjs", "test-skip-added")], mode);
    const report = buildReport({ transcript: "unit-control", transcriptFormat: "markdown", repo: ".", base: "a".repeat(40), head: "b".repeat(40), results: [verified, ...routed.results], advisories: routed.advisories, policy: { minVerified: 1, strict: false } });
    assert.equal(report.summary.status, "INCONCLUSIVE");
    const view = buildReportResultView(report);
    assert.match(renderResultText(view), /^Agent Vigil: NOT CHECKED/);
    assert.match(renderResultMarkdown(view), /^### Agent Vigil: NOT CHECKED/);
  }
});


test("first-use output explains the quoted-code hold without hiding missing evidence", () => {
  const report = buildReport({ transcript: "unit-control", transcriptFormat: "test-integrity-diff", repo: ".", base: "a".repeat(40), head: "b".repeat(40), results: [uncheckedTestCode("test/context.mjs", "test-skip-added")], policy: { minVerified: 1, strict: false } });
  const view = buildReportResultView(report);
  assert.equal(view.verdict, "INCONCLUSIVE");
  assert.ok(view.findings.some(f => f.id === "completion-evidence" && f.state === "NOT_CHECKED"));
  for (const text of [renderResultText(view), renderResultMarkdown(view)]) {
    assert.match(text, /quoted test code needs an execution check/);
    assert.match(text, /adding a claim will not clear it/);
    assert.doesNotMatch(text, /Add at least one independently verifiable/);
  }
  // A concrete failure still takes precedence over either kind of uncertainty.
  const failed = buildReport({ transcript: "unit-control", transcriptFormat: "markdown", repo: ".", base: "a".repeat(40), head: "b".repeat(40), results: [...report.results, {claim: {kind: "tests_pass", quote: "unit control", subject: "tests failed"}, verdict: "contradicted", evidence: "synthetic failed unit control", ruleId: "tests-pass"}] });
  assert.match(renderResultText(buildReportResultView(failed)), /Reason: tests failed/);
});
