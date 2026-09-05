import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = new URL("../scripts/run_tests.mjs", import.meta.url).href;
const modules = fileURLToPath(new URL("../node_modules", import.meta.url));
const shard = "coverage-999999999-1000000000000-0.json";

function exercise(mode: "pass" | "assertion" | "empty" | "truncated" | "low-coverage", coverage = true) {
  const root = mkdtempSync(join(tmpdir(), "vigil-runner-regression-"));
  try {
    for (const dir of ["src", "test", "test-hosted", "scratch"]) mkdirSync(join(root, dir));
    symlinkSync(modules, join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(root, "src/covered.ts"), mode === "low-coverage" ? `
export function value(input = true) {
  if (input) {
    return 1;
  } else {
    let result = 0;
    result += 1;
    result += 2;
    result += 3;
    result += 4;
    result += 5;
    return result;
  }
}
` : "export function value() { return 1; }\n");
    writeFileSync(join(root, "test/probe.test.ts"), `
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { value } from "../src/covered.ts";
test("probe", () => {
  appendFileSync(${JSON.stringify(join(root, "attempts.txt"))}, "attempt\\n");
  assert.equal(value(), ${mode === "assertion" ? 2 : 1});
  ${mode === "empty" || mode === "truncated"
    ? `writeFileSync(join(process.env.NODE_V8_COVERAGE, ${JSON.stringify(shard)}), ${JSON.stringify(mode === "empty" ? "" : '{"result":')});`
    : ""}
});
`);
    const environment = { ...process.env };
    delete environment.NODE_V8_COVERAGE;
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
import { runTests } from ${JSON.stringify(runner)};
const result = runTests(${JSON.stringify(root)}, ${JSON.stringify(coverage ? ["--coverage"] : [])}, ${JSON.stringify(join(root, "scratch"))});
console.log("RUNNER_RESULT=" + JSON.stringify(result));
process.exitCode = result.exitCode;
`], { cwd: root, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    const marker = result.stdout.split("\n").find((line) => line.startsWith("RUNNER_RESULT="));
    assert.ok(marker, result.stdout + result.stderr);
    const details = JSON.parse(marker.slice("RUNNER_RESULT=".length));
    assert.ok(existsSync(join(root, "attempts.txt")), result.stdout + result.stderr);
    assert.equal(readFileSync(join(root, "attempts.txt"), "utf8"), "attempt\n", "a failed run must never silently retry");
    assert.equal(result.status, details.exitCode);
    if (mode === "pass") {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(details.runRoot), false);
    } else {
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(details.runRoot), true);
      assert.match(result.stderr, /temporary evidence retained/);
      assert.match(result.stderr, /No automatic retry/);
      if (mode === "low-coverage") assert.match(result.stdout + result.stderr, /coverage.*threshold/i);
      if (mode === "empty" || mode === "truncated") {
        assert.match(result.stdout + result.stderr, /coverage/i);
        assert.equal(readFileSync(join(details.coverageRoot, shard), "utf8"), mode === "empty" ? "" : '{"result":');
        assert.ok(readdirSync(details.coverageRoot).length > 1, "retain ordinary coverage shards too");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("successful coverage keeps its thresholds and cleans temporary evidence", () => exercise("pass"));
test("an assertion failure stays failed and is not retried", () => exercise("assertion"));
test("a green test suite below the coverage floor still fails", () => exercise("low-coverage"));
test("an empty V8 shard stays failed and is retained unchanged", () => exercise("empty"));
test("a truncated V8 shard stays failed and is retained unchanged", () => exercise("truncated"));
test("ordinary successful tests still clean their temporary files", () => exercise("pass", false));
