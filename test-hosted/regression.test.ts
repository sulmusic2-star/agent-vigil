import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRegressionCommand } from "../src/regression-cli.ts";
import { REGRESSION_FILE, REGRESSION_IMAGE, judgeRegressionCase, parseRegressionContract, parseRegressionObservation, regressionDockerArgs, regressionJson, renderRegression, runRegression, validateRegressionPath, type RegressionObservation } from "../src/regression.ts";
import { trustedGit } from "../src/trusted-git.ts";

const item = { id: "adds", module: "math.cjs", export: "add", args: [2, 3], expect: 5 };
const contract = { version: 1, files: ["math.cjs"], cases: [item] };
const value = (value: number): RegressionObservation => ({ state: "value", value, machineMs: 0 });
const unavailable: RegressionObservation = { state: "unavailable", reason: "absent", machineMs: 0 };

test("regression JSON preserves values without raw C1, bidi or invisible terminal controls", () => {
  const value = { text: "\u001b[31m\u009b31m\u202e\u2066\u200b\u{e0001}\n" };
  for (const pretty of [false, true]) {
    const output = regressionJson(value, pretty);
    assert.deepEqual(JSON.parse(output), value);
    assert.doesNotMatch(output, /[\u001b\u009b\u202e\u2066\u200b\u{e0001}]/u);
  }
});

test("regression contract requires explicit meaningful cases and strict fields", () => {
  assert.deepEqual(parseRegressionContract(JSON.stringify(contract)), contract);
  for (const altered of [{ ...contract, version: 2 }, { ...contract, files: [] }, { ...contract, cases: [] }, { ...contract, execute: "curl evil" }, { ...contract, cases: [item, item] }, { ...contract, files: ["math.cjs", "MATH.cjs"] }, { ...contract, cases: [{ ...item, export: "constructor" }] }, { ...contract, cases: [{ ...item, id: "\u001b[31m" }] }, { ...contract, cases: [{ ...item, module: "other.cjs" }] }, { ...contract, cases: [{ ...item, args: null }] }, { ...contract, files: Array(21).fill("math.cjs") }]) {
    assert.throws(() => parseRegressionContract(JSON.stringify(altered)));
  }
  assert.throws(() => parseRegressionContract(JSON.stringify(contract).replace('"expect":5', '"expect":1e999')));
  assert.throws(() => parseRegressionContract(JSON.stringify(contract).replace('"expect":5', '"expect":-0')));
  assert.throws(() => parseRegressionContract(JSON.stringify(contract).replace('"expect":5', '"expect":{"__proto__":{}}')));
  assert.throws(() => parseRegressionContract(" ".repeat(65537)));
});

test("regression export paths reject traversal, option injection, devices and secret locations", () => {
  for (const path of ["../secret.cjs", "/math.cjs", "src/../math.cjs", "-x", "src\\math.cjs", "math.cjs\n", ".env", ".git/config", "node_modules/pkg/main.cjs", "src/con.cjs", "math.js", "src/a,b.cjs"]) {
    if (path.startsWith("node_modules")) continue; // Explicit .cjs files are allowed; nothing is auto-discovered.
    assert.throws(() => validateRegressionPath(path), path);
  }
  validateRegressionPath("src/math.cjs");
});

test("regression observation never mistakes TAP, zero exit, missing output or malformed JSON for evidence", () => {
  assert.equal(parseRegressionObservation(0, false, '{"value":5}\n', 1).state, "value");
  for (const output of ["", "# tests 2\n# pass 2\n", '{"value":5}\n{"value":5}', '{"value":5,"pass":true}', '{"value":1e999}', '{"ok":true}', '{"value":{"constructor":5}}']) assert.equal(parseRegressionObservation(0, false, output, 1).state, "unavailable");
  assert.equal(parseRegressionObservation(0, true, '{"value":5}', 1).state, "unavailable");
  assert.equal(parseRegressionObservation(125, false, '{"value":5}', 1).state, "unavailable");
});

test("regression verdict requires a reproduced baseline and consistent candidate answers", () => {
  assert.equal(judgeRegressionCase(item, [value(5), value(5)], [value(5), value(5)]).verdict, "PASS");
  assert.equal(judgeRegressionCase(item, [value(5), value(5)], [value(-1), value(-1)]).verdict, "FAIL");
  for (const [base, head] of [[[], []], [[value(-1), value(-1)], [value(-1), value(-1)]], [[value(5), unavailable], [value(5), value(5)]], [[value(5), value(5)], [value(5), value(-1)]], [[value(5), value(5)], [value(5)]], [[value(5), value(5)], [unavailable, unavailable]]]) {
    assert.equal(judgeRegressionCase(item, base, head).verdict, "NOT CHECKED");
  }
});

test("regression Docker boundary only receives a read-only snapshot and no expected answers", () => {
  const args = regressionDockerArgs("/safe/snapshot", "vigil-test");
  for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534", "--pull=never", "--pids-limit=32", "--memory=128m"]) assert.ok(args.includes(flag));
  assert.ok(args.includes(REGRESSION_IMAGE));
  assert.equal(args.filter(s => s.startsWith("type=bind")).length, 1);
  assert.ok(args.includes("type=bind,source=/safe/snapshot,target=/work,readonly"));
  assert.ok(!args.some(s => s.includes("docker.sock") || s.includes("GITHUB_TOKEN") || s.includes("request.expect")));
  assert.throws(() => regressionDockerArgs("/safe,path", "vigil-test"));
});

test("regression init previews without execution, writes exclusively and never overwrites existing expectations", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-contract-"));
  const args = ["init", "--repo", root, "--module", "math.cjs", "--export", "add", "--args", "[2,3]", "--expect", "5"];
  try {
    assert.equal(runRegressionCommand([...args, "--dry-run"]), 0);
    assert.throws(() => readFileSync(join(root, REGRESSION_FILE)));
    assert.equal(runRegressionCommand(args), 0);
    const before = readFileSync(join(root, REGRESSION_FILE), "utf8");
    assert.equal(runRegressionCommand(args), 2);
    assert.equal(readFileSync(join(root, REGRESSION_FILE), "utf8"), before);
    assert.equal(runRegressionCommand(["check", "--base", "main", "--unknown"]), 2);
    assert.equal(runRegressionCommand(["init", "--help", "--garbage"]), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("regression exact-commit preflight rejects changed expectations, missing files and symlink inputs without executing them", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-contract-git-"));
  const template = join(root, "template"); mkdirSync(template);
  trustedGit(root, ["init", "-q", `--template=${template}`]);
  const commit = () => {
    trustedGit(root, ["add", "-A"]);
    trustedGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
    return trustedGit(root, ["rev-parse", "HEAD"]).trim();
  };
  try {
    writeFileSync(join(root, REGRESSION_FILE), JSON.stringify(contract));
    writeFileSync(join(root, "math.cjs"), "throw Error('must not execute');");
    const base = commit();
    writeFileSync(join(root, REGRESSION_FILE), JSON.stringify({ ...contract, cases: [{ ...item, expect: -1 }] }));
    const head = commit();
    const changed = runRegression({ repo: root, base, head });
    assert.equal(changed.verdict, "NOT CHECKED");
    assert.match(changed.reason, /expectations changed/);
    assert.equal(changed.rows.length, 0);
    assert.deepEqual(changed.changedFiles, [{ status: "M", path: REGRESSION_FILE }]);
    writeFileSync(join(root, REGRESSION_FILE), JSON.stringify(contract));
    rmSync(join(root, "math.cjs"));
    const absent = commit();
    assert.match(runRegression({ repo: root, base, head: absent }).reason, /Missing regular Git blob/);
    if (process.platform !== "win32") {
      symlinkSync("/etc/passwd", join(root, "math.cjs"));
      const link = commit();
      assert.match(runRegression({ repo: root, base, head: link }).reason, /Missing regular Git blob/);
    }
    assert.equal(runRegression({ repo: root, base: "main", head }).verdict, "NOT CHECKED");
    const text = renderRegression({ ...changed, base: "\u001b[31m", rows: [{ ...judgeRegressionCase(item, [value(5), value(5)], [value(4), value(4)]), id: "\u001b[31m" }] });
    assert.ok(!text.includes("\u001b"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("regression controller uses exact blobs, excludes unlisted files and reports partial evidence (mocked runner)", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-controller-"));
  const template = join(root, "template"); mkdirSync(template);
  trustedGit(root, ["init", "-q", `--template=${template}`]);
  try {
    const twoCases = { ...contract, cases: [item, { ...item, id: "second" }] };
    writeFileSync(join(root, REGRESSION_FILE), JSON.stringify(twoCases));
    writeFileSync(join(root, "math.cjs"), "exports.add=(a,b)=>a+b;");
    writeFileSync(join(root, "secret.txt"), "DUMMY SENTINEL");
    trustedGit(root, ["add", "-A"]);
    trustedGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
    const base = trustedGit(root, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(root, "math.cjs"), "exports.add=(a,b)=>a-b;");
    trustedGit(root, ["add", "math.cjs"]);
    trustedGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "head"]);
    const head = trustedGit(root, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(root, "math.cjs"), "WORKING TREE MUST NOT BE USED");
    let snapshot = "";
    const seen: string[] = [];
    const fail = runRegression({ repo: root, base, head }, (directory) => {
      snapshot = directory;
      assert.deepEqual(readdirSync(directory), ["math.cjs"]);
      const source = readFileSync(join(directory, "math.cjs"), "utf8");
      seen.push(source);
      return value(source.includes("a+b") ? 5 : -1);
    });
    assert.equal(fail.verdict, "FAIL");
    assert.equal(fail.requiredCases, 2);
    assert.equal(fail.rows.length, 2);
    assert.equal(seen.length, 8);
    assert.equal(existsSync(snapshot), false, "private snapshots must be cleaned");
    assert.notEqual(fail.files[0].baseSha256, fail.files[0].headSha256);
    assert.deepEqual(fail.changedFiles, [{ status: "M", path: "math.cjs" }]);
    assert.equal(runRegression({ repo: root, base, head }, () => value(5)).verdict, "PASS");
    let attempts = 0;
    const missing = runRegression({ repo: root, base, head }, () => { attempts++; return unavailable; });
    assert.equal(attempts, 1, "do not start another container after unavailable evidence");
    assert.equal(missing.verdict, "NOT CHECKED");
    assert.equal(missing.rows.length, 1);
    assert.match(renderRegression(missing), /Cases checked: 0\/2/);
    const mixed = runRegression({ repo: root, base, head }, (directory, selected) => directory.endsWith("base") ? value(5) : selected.id === "second" ? unavailable : value(-1));
    assert.equal(mixed.verdict, "FAIL", "confirmed mismatch remains visible with another case missing");
    assert.equal(mixed.rows[1].verdict, "NOT CHECKED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
