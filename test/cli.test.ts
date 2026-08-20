import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.ts";

function repo() {
  const path = mkdtempSync(join(tmpdir(), "vigil-cli-"));
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: path });
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "node --test test.js" } }));
  writeFileSync(join(path, "test.js"), "const{test}=require('node:test');test('one',()=>{});\n");
  execFileSync("git", ["add", "-A"], { cwd: path }); execFileSync("git", ["commit", "-qm", "base"], { cwd: path });
  writeFileSync(join(path, "README.md"), "head\n"); execFileSync("git", ["add", "README.md"], { cwd: path }); execFileSync("git", ["commit", "-qm", "head"], { cwd: path });
  return path;
}

test("CLI help exits zero", () => assert.equal(run(["--help"]), 0));
test("CLI adversarial demo catches all planted failures", () => assert.equal(run(["demo"]), 0));
test("CLI missing transcript exits two", () => assert.equal(run([]), 2));
test("CLI empty narrative is inconclusive", () => {
  const r = repo(); const summary = join(r, "empty.md"); writeFileSync(summary, "nothing concrete");
  assert.equal(run([summary, "--repo", r]), 2);
});
test("CLI false test count fails", () => {
  const r = repo(); const summary = join(r, "false.md"); writeFileSync(summary, "All 12 tests pass.");
  assert.equal(run([summary, "--repo", r]), 1);
});
test("CLI passing claim exits zero", () => {
  const r = repo(); const summary = join(r, "pass.md"); writeFileSync(summary, "The test suite passes.");
  assert.equal(run([summary, "--repo", r]), 0);
});
test("CLI writes JSON receipt", () => {
  const r = repo(); const summary = join(r, "pass.md"); const output = join(r, "receipt.json"); writeFileSync(summary, "The test suite passes.");
  assert.equal(run([summary, "--repo", r, "--output", output, "--format", "json"]), 0);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).summary.status, "PASS");
});
