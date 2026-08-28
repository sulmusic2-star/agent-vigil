import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProtectRehearsal = {
  regression: "PASS" | "FAIL";
  plantedWeakTest: "BLOCKED" | "MISSED";
};

function testExit(root: string): number {
  try {
    execFileSync(process.execPath, ["--test", "change.test.cjs"], {
      cwd: root,
      stdio: "ignore",
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? "" },
    });
    return 0;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : 1;
  }
}

export function runProtectRehearsal(): ProtectRehearsal {
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-protect-rehearsal-"));
  try {
    const app = join(root, "app.cjs");
    const test = join(root, "change.test.cjs");
    writeFileSync(test, "const { test } = require('node:test'); const assert = require('node:assert/strict'); const { answer } = require('./app.cjs'); test('regression', () => assert.equal(answer, 42));\n");

    writeFileSync(app, "module.exports = { answer: 41 };\n");
    const regressionOnOld = testExit(root);
    writeFileSync(app, "module.exports = { answer: 42 };\n");
    const regressionOnProposed = testExit(root);

    writeFileSync(test, "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('weak proof', () => assert.equal(true, true));\n");
    writeFileSync(app, "module.exports = { answer: 41 };\n");
    const weakOnOld = testExit(root);
    writeFileSync(app, "module.exports = { answer: 42 };\n");
    const weakOnProposed = testExit(root);

    return {
      regression: regressionOnOld !== 0 && regressionOnProposed === 0 ? "PASS" : "FAIL",
      plantedWeakTest: weakOnOld === 0 && weakOnProposed === 0 ? "BLOCKED" : "MISSED",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function renderProtectRehearsal(result: ProtectRehearsal): string {
  return [
    "Proof rehearsal (disposable files; no repository code executed)",
    `  ${result.regression === "PASS" ? "PASS" : "FAIL"}  real regression test failed on old code and passed on proposed code`,
    `  ${result.plantedWeakTest === "BLOCKED" ? "FAIL" : "MISS"}  planted weak test passed on both versions${result.plantedWeakTest === "BLOCKED" ? "; merge proof blocked" : ""}`,
  ].join("\n");
}

