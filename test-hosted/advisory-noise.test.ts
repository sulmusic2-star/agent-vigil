import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkIntegrity, checkIntegrityDiff } from "../src/detectors/reality.ts";
import { trustedGit } from "../src/trusted-git.ts";

function patch(before: string, after: string, path = "src/value.ts") {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}
const noOp = (before: string, after: string, path?: string) => checkIntegrityDiff(patch(before, after, path)).some(row => row.ruleId === "no-op-code-change");

test("URL, string, regex, template and token-boundary changes are not erased as whitespace/comments", () => {
  for (const [before, after] of [
    ['const url = "https://example.com/v1";', 'const url = "https://example.com/v2";'],
    ["const url = 'https://example.com/v1';", "const url = 'https://example.com/v2';"],
    ['return "a b";', 'return "ab";'],
    ['return x;', 'returnx;'],
    ['const text = "/* a */";', 'const text = "/* b */";'],
    ['const text = `https://example.com/v1`;', 'const text = `https://example.com/v2`;'],
    ['const pattern = /https:\\/\\/v1/;', 'const pattern = /https:\\/\\/v2/;'],
    ['const text = "a\\\"//b";', 'const text = "a\\\"//c";'],
    ['const value = `unfinished', 'const value = `different'],
  ]) assert.equal(noOp(before, after), false, `${before} -> ${after}`);
  assert.equal(noOp('  return x', '    return x', 'src/value.py'), false);
});
test("actual JS token-identical edits remain advisory candidates", () => {
  assert.equal(noOp("return value;", "return value; // adjusted"), true);
  assert.equal(noOp("const value = 1;", "const  value=1;"), true);
  assert.equal(noOp("return /* original */ value;", "return /* updated */ value;"), true);
});
test("JS suppression examples stay quiet while real and uncertain comments remain visible", () => {
  const flagged = (line: string) => checkIntegrityDiff(patch("const value = 1;", line)).some(row => row.ruleId === "suppression-added");
  for (const line of [
    'unifiedDiff("runtime.js.map", [], ["// @ts-ignore generated source map text"]),',
    'const message = "eslint-disable";',
    'const expression = /@ts-expect-error/;',
    'const message = `/* @ts-nocheck */`;',
  ]) assert.equal(flagged(line), false, line);
  for (const line of [
    '// @ts-ignore', 'const value = 1; // eslint-disable-line',
    '/* @ts-expect-error */ const value = 1;', '* @ts-ignore',
  ]) assert.equal(flagged(line), true, line);
});
test("language-specific imports skip builtins without hiding real package typos", () => {
  const repo = mkdtempSync(join(tmpdir(), "vigil-import-noise-"));
  try {
    const template = join(repo, "empty-template"); mkdirSync(template);
    trustedGit(repo, ["init", "-q", `--template=${template}`]);
    const commit = () => {
      trustedGit(repo, ["add", "."]);
      trustedGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]);
      return trustedGit(repo, ["rev-parse", "HEAD"]).trim();
    };
    const base = commit();
    writeFileSync(join(repo, "sample.ts"), "import test from 'node:test';\nimport http from 'node:http';\n");
    writeFileSync(join(repo, "sample.py"), "import http.server\nfrom urllib.request import urlopen\n");
    const cleanHead = commit();
    assert.equal(checkIntegrity(repo, base, cleanHead).some(row => row.ruleId === "fresh-dep"), false);
    writeFileSync(join(repo, "typo.ts"), "import client from 'axois';\n");
    writeFileSync(join(repo, "typo.py"), "import reqeusts\n");
    writeFileSync(join(repo, "requirements.txt"), "http\nurllib\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { test: "1.0.0" } }));
    const findings = checkIntegrity(repo, cleanHead, commit()).filter(row => row.ruleId === "fresh-dep");
    for (const name of ["axois", "reqeusts", "http", "urllib", "test"]) assert.ok(findings.some(row => row.evidence.startsWith(`${name} `)), name);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
