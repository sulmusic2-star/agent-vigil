import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIntegrityDiff } from "../src/detectors/reality.ts";

function diff(path: string, before: string, after: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}
const noOp = (path: string, before: string, after: string) => checkIntegrityDiff(diff(path, before, after)).some(row => row.ruleId === "no-op-code-change");

test("simple return comments use the actual Python, Ruby and Go delimiter", () => {
  for (const [path, marker] of [["src/value.py", "#"], ["lib/value.rb", "#"], ["internal/value.go", "//"]]) {
    for (const value of ["x", "0", "None", "result_1"]) assert.equal(noOp(path, `  return ${value}`, `  return ${value} ${marker} explanation`), true);
    assert.equal(noOp(path, "  return 1", `  return 2 ${marker} explanation`), false);
    assert.equal(noOp(path, "  return x", `    return x ${marker} explanation`), false);
    assert.equal(noOp(path, '  return "x"', `  return "x" ${marker} explanation`), false, "strings are outside this narrow cross-language rule");
    assert.equal(noOp(path, '  return "https://host/v1"', '  return "https://host/v2"'), false);
  }
  assert.equal(noOp("src/value.py", "  return x;", "  return x; // not a Python comment"), false);
  assert.equal(noOp("lib/value.rb", "  return x;", "  return x; // not a Ruby comment"), false);
  assert.equal(noOp("internal/value.go", "  return x", "  return x # not a Go comment"), false);
});

function relocation(ending: string, endingPath = "src/value.ts"): string {
  const first = diff("src/value.ts", "export function oldName() { return 1; }", "export function newName() { return 1; }");
  const late = endingPath === "src/value.ts"
    ? `@@ -20,0 +21 @@\n+${ending}\n`
    : diff(endingPath, "", ending);
  return first + late + diff("src/caller.ts", "export const output = oldName();", "export const output = oldName() + 1;");
}
test("a retained same-file wrapper in a later hunk is not a deleted function", () => {
  const checks = checkIntegrityDiff(relocation("export function oldName() { return newName(); }"));
  assert.ok(!checks.some(row => row.ruleId === "diff-unparseable"));
  assert.ok(!checks.some(row => row.ruleId === "stale-refactor-caller"));
});
test("unrepaired callers remain visible despite same-name calls, strings, or other modules", () => {
  for (const [line, path] of [
    ["export const again = oldName();", "src/value.ts"],
    ['const example = "export function oldName() {}";', "src/value.ts"],
    ["export function oldName() { return newName(); }", "src/unrelated.ts"],
    ["// export function oldName() { return newName(); }", "src/value.ts"],
  ]) assert.ok(checkIntegrityDiff(relocation(line, path)).some(row => row.ruleId === "stale-refactor-caller"), line);
  for (const source of [
    "/*\nexport function oldName() {}\n*/",
    "const example = `\nexport function oldName() {}\n`;",
  ]) {
    const late = `@@ -20,0 +21,3 @@\n${source.split("\n").map(line => `+${line}`).join("\n")}\n`;
    const change = diff("src/value.ts", "export function oldName() { return 1; }", "export function newName() { return 1; }") + late
      + diff("src/caller.ts", "export const output = oldName();", "export const output = oldName() + 1;");
    assert.ok(checkIntegrityDiff(change).some(row => row.ruleId === "stale-refactor-caller"), source);
  }
});
