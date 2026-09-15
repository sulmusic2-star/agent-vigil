import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { checkIntegrity } from "../src/detectors/reality.ts";

function change(context: TestContext, before: Record<string, string>, after: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "vigil-change-contract-"));
  context.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", [
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args,
  ], { cwd: repo, encoding: "utf8" }).trim();
  const write = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git("add", "-A");
    git("commit", "-qm", "disposable regression fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  git("config", "user.name", "Vigil Contract Test");
  git("config", "user.email", "fixture@example.invalid");
  const base = write(before);
  const head = write(after);
  return { repo, base, head };
}

for (const path of ["src/with spaces.js", "src/résumé_測試.js"]) {
  test(`exact Git filename remains readable without hiding a finding: ${path}`, context => {
    const f = change(context, { [path]: "const value = 1;\n" }, {
      [path]: "if (false) throw new Error('unreachable');\nconst value = 1;\n",
    });
    const findings = checkIntegrity(f.repo, f.base, f.head);
    assert.equal(findings.some(result => result.ruleId === "diff-unparseable"), false);
    assert.ok(findings.some(result => result.ruleId === "dead-branch-added"));
  });
}

test("literal rows preserve strict callbacks, while deleting a row still blocks", context => {
  const imports = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from '../math.mjs';\n";
  const before = imports + "test('positive',()=>assert.equal(add(2,3),5));\ntest('negative',()=>assert.equal(add(-2,-3),-5));\ntest('zero',()=>assert.equal(add(0,0),0));\n";
  const rows = "[[2,3,5],[-2,-3,-5],[0,0,0]]";
  const candidate = (table: string) => imports + `for (const [a,b,answer] of ${table}) test(\`add \${a} \${b}\`,()=>assert.equal(add(a,b),answer));\n`;
  const baseline = { "test/math.test.mjs": before, "math.mjs": "export const add=(a,b)=>a+b;\n" };
  for (const [table, expectedPreserved] of [[rows, true], [rows.replace(",[0,0,0]", ""), false]] as const) {
    const f = change(context, baseline, { "test/math.test.mjs": candidate(table) });
    const findings = checkIntegrity(f.repo, f.base, f.head, { testCommand: "node --test test/math.test.mjs" });
    assert.equal(findings.some(result => result.ruleId === "test-count-drop"), !expectedPreserved);
  }
});

test("an explicitly executed txt test cannot hide a newly skipped case", context => {
  const before = "const {test}=require('node:test');\nconst assert=require('node:assert/strict');\ntest('kept',()=>assert.equal(2+3,5));\ntest('required',()=>assert.equal(4+5,9));\n";
  const after = before.replace("test('required'", "test." + "skip('required'");
  const f = change(context, { "test/executed.txt": before }, { "test/executed.txt": after });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "test/executed.txt"], {
    cwd: f.repo, env, encoding: "utf8", timeout: 10_000,
  });
  assert.match(output, /# pass 1\b/);
  assert.match(output, /# skipped 1\b/);
  const findings = checkIntegrity(f.repo, f.base, f.head, { testCommand: "node --test test/executed.txt" });
  assert.ok(findings.some(result => result.ruleId === "test-skip-added"));
});
