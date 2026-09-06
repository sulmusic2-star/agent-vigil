import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { runRegressionCommand } from "../src/regression-cli.ts";
import { REGRESSION_LAUNCHER, judgeRegressionCase, parseRegressionObservation, renderRegression, type RegressionObservation, type RegressionReceipt } from "../src/regression.ts";

// Synthetic exports only. VM probes exercise the exact launcher; they are not
// a sandbox for repository code and do not replace the real-container lab.
async function invoke(expression: string) {
  let stdout = "", status = 0;
  await runInNewContext(`
    const fixture = { fn: () => (${expression}) };
    function require(name) {
      if (name === 'node:fs') return { readFileSync: () => '{"module":"math.cjs","export":"fn","args":[]}' };
      if (name === 'node:util') return { types: { isProxy: proxyCheck } };
      if (name === '/work/math.cjs') return fixture;
      throw Error('Unexpected fixture import');
    }
    ${REGRESSION_LAUNCHER}
  `, { proxyCheck: types.isProxy, process: { stdout: { write: (text: string) => { stdout += text; } }, exit: (code: number) => { status = code; } } }, { timeout: 1000 });
  return { status, stdout, observation: parseRegressionObservation(status, false, stdout, 0) };
}
const bad = [
  ["NaN", null], ["Infinity", null], ["-Infinity", null], ["-0", 0],
  ["({ missing: undefined })", {}], ["({ nested: { missing: undefined } })", { nested: {} }],
  ["[undefined]", [null]], ["[, 1]", [null, 1]], ["({ toJSON() { return 5; } })", 5],
  ["undefined", null], ["(() => 5)", null], ["Symbol('answer')", null], ["1n", null],
  ["({ x: () => 1 })", {}], ["({ x: Symbol('x') })", {}],
  ["({ get answer() { throw Error('getter must not run'); } })", {}],
  ["Object.defineProperty({}, 'hidden', { value: 1 })", {}],
  ["Object.assign([1], { extra: 2 })", [1]], ["({ [Symbol('hidden')]: 1 })", {}],
  ["new Date(0)", "1970-01-01T00:00:00.000Z"], ["new (class Answer {})()", {}],
  ["new Proxy({}, {})", {}], ["(() => { const x = {}; x.self = x; return x; })()", {}],
  ["({ constructor: 5 })", {}], ["Array.from({length: 16385}, () => 0)", []],
  ["Array.from({length: 22}).reduce(x => [x], 1)", []],
] as const;
for (const [expression, normalized] of bad) {
  test(`return data is NOT CHECKED, never a normalized PASS: ${expression}`, async () => {
    const actual = await invoke(expression);
    assert.equal(actual.status, 71);
    assert.equal(actual.stdout, "");
    assert.equal(actual.observation.state, "unavailable");
    if (actual.observation.state === "unavailable") assert.match(actual.observation.reason, /unsupported JSON/);
    const baseline: RegressionObservation = { state: "value", value: structuredClone(normalized) as any, machineMs: 0 };
    const item = { id: "return", module: "math.cjs", export: "fn", args: [], expect: structuredClone(normalized) as any };
    assert.equal(judgeRegressionCase(item, [baseline, baseline], [actual.observation]).verdict, "NOT CHECKED");
  });
}
for (const expression of ["null", "false", "0", "5.25", "'ordinary string'", "[1, null, true, { nested: ['yes', 3] }]", "({ answer: 5, empty: {} })", "Object.assign(Object.create(null), { answer: 5 })", "Promise.resolve({ answer: 5 })"]) {
  test(`ordinary JSON result survives unchanged: ${expression}`, async () => {
    const actual = await invoke(expression);
    const expected = JSON.parse(JSON.stringify(await runInNewContext(expression)));
    assert.equal(actual.status, 0);
    assert.deepEqual(actual.observation, { state: "value", value: expected, machineMs: 0 });
  });
}

test("ordinary output shows deduplicated recovery warnings with safe terminal text", () => {
  const baseline: RegressionObservation = { state: "value", value: 5, machineMs: 0 };
  const reason = "Runner interrupted; confirm container vigil-regression-fixture was removed.\u001b[31m\u202e";
  const missing: RegressionObservation = { state: "unavailable", reason, machineMs: 0 };
  const row = judgeRegressionCase({ id: "answer", module: "math.cjs", export: "fn", args: [], expect: 5 }, [baseline, baseline], [missing, missing]);
  const receipt: RegressionReceipt = { schema: "agent-vigil-regression/v1", base: "1".repeat(40), head: "2".repeat(40), contractPath: ".vigil-regressions.json", runnerImage: "fixture", verdict: "NOT CHECKED", reason: "Inspect case details.", rows: [row], files: [], changedFiles: [], requiredCases: 1, machineMs: 0, scope: "fixture" };
  for (const verdict of ["NOT CHECKED", "FAIL"] as const) {
    const text = renderRegression({ ...receipt, verdict });
    assert.match(text, /Candidate: Runner interrupted; confirm container vigil-regression-fixture was removed/);
    assert.equal(text.split("confirm container").length, 2);
    assert.doesNotMatch(text, /[\u001b\u202e]/u);
  }
});

test("CLI rejects hostile symlink output without raw terminal controls", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-output-controls-"));
  const oldError = console.error, oldLog = console.log;
  const errors: string[] = [];
  try {
    const target = join(root, "unchanged.json"); writeFileSync(target, "sentinel");
    const output = join(root, "receipt-\u001b[31m\u202e.json"); symlinkSync(target, output);
    console.error = (...args) => errors.push(args.join(" ")); console.log = () => {};
    assert.equal(runRegressionCommand(["check", "--repo", root, "--base", "1".repeat(40), "--head", "2".repeat(40), "--output", output]), 2);
    assert.match(errors.join("\n"), /NOT CHECKED/);
    assert.doesNotMatch(errors.join("\n"), /[\u001b\u202e]/u);
  } finally { console.error = oldError; console.log = oldLog; rmSync(root, { recursive: true, force: true }); }
});
