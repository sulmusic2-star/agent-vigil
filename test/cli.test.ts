import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.ts";
import { generateSigningKey, publicKeyId } from "../src/signature.ts";
import { buildReport } from "../src/report.ts";

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
test("CLI command parsers reject ambiguous or incomplete requests before side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-cli-parser-"));
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  const malformed = join(root, "malformed.json");
  writeFileSync(first, JSON.stringify({ schemaVersion: "wrong" }));
  writeFileSync(second, JSON.stringify({ schemaVersion: "wrong" }));
  writeFileSync(malformed, "{");

  assert.equal(run(["--version"]), 0);
  assert.equal(run(["guard-compat", "--help"]), 0);
  assert.equal(run(["guard-route", "--help"]), 0);
  const invalid: string[][] = [
    ["--unknown"],
    ["evidence.md", "--format", "yaml"],
    ["evidence.md", "--min-verified", "0"],
    ["evidence.md", "--output"],
    ["evidence.md", "--portable-output", "portable.json"],
    ["guard-compat", "positional"],
    ["guard-compat", "--host"],
    ["guard-compat", "--host", "claude", "--host", "codex"],
    ["guard-compat", "--host", "cursor"],
    ["guard-compat", "--host", "claude", "--format", "yaml"],
    ["guard-compat", "--host", "claude", "--timeout-ms", "1.5"],
    ["guard-route", "positional"],
    ["guard-route", "--host"],
    ["guard-route", "--host", "cursor"],
    ["guard-route", "--host", "codex", "--format", "yaml"],
    ["guard-route", "--host", "codex", "--timeout-ms", "slow"],
    ["protect", "--unknown"],
    ["prove", "--unknown"],
    ["prove", "--repo"],
    ["certify"],
    ["certify", "record"],
    ["certify", "status", "--corpus", first, "--policy", second, "--format", "yaml"],
    ["plan", "--unknown"],
    ["plan", "--repo"],
    ["proof-comment"],
    ["keygen"],
    ["keygen", "--private"],
    ["verify"],
    ["verify", first],
    ["gate"],
    ["gate", malformed],
    ["maintainer"],
    ["merge-group"],
    ["authority"],
    ["compare"],
    ["compare", first, second, "--format", "yaml"],
    ["compare", first, second],
    ["github-evidence"],
    ["github-evidence", "--event"],
    ["github-evidence", "--unknown", first],
    ["compare-value"],
    ["compare-value", "--format", "yaml"],
    ["audit"],
  ];
  for (const args of invalid) assert.equal(run(args), 2, args.join(" "));
});
test("CLI adversarial demo catches all planted failures", () => assert.equal(run(["demo"]), 0));
test("CLI static diff audit is advisory by default, blocking in strict mode, and fail-closed on malformed input", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-audit-"));
  const clean = join(root, "clean.diff");
  const bad = join(root, "bad.diff");
  const malformed = join(root, "malformed.diff");
  const output = join(root, "receipt.json");
  writeFileSync(clean, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-return 1;\n+return 2;\n");
  writeFileSync(bad, "diff --git a/test/a.test.ts b/test/a.test.ts\n--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1 +1 @@\n-test('a',()=>{});\n+test.skip('a',()=>{});\n");
  writeFileSync(malformed, "not a unified diff\n");
  assert.equal(run(["audit", clean, "--output", output]), 0);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).summary.status, "PASS");
  assert.equal(run(["audit", bad, "--output", output]), 0);
  const advisory = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(advisory.summary.status, "PASS");
  assert.ok(advisory.advisories.some((item: any) => item.ruleId === "test-skip-added"));
  assert.equal(run(["audit", bad, "--strict", "--output", output]), 1);
  const blocking = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(blocking.summary.status, "FAIL");
  assert.equal(blocking.advisories.length, 0);
  assert.equal(run(["audit", malformed]), 2);
});
test("CLI compare emits a machine-readable receipt delta and returns its status", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-compare-"));
  const check = { claim: { kind: "integrity" as const, quote: "bound", subject: "workspace" }, verdict: "verified" as const, evidence: "ok", ruleId: "workspace-bound", contributesToPass: false };
  const proof = { claim: { kind: "tests_pass" as const, quote: "tests", subject: "suite" }, verdict: "verified" as const, evidence: "ok", ruleId: "tests-pass" };
  const before = buildReport({ transcript: "a", transcriptFormat: "markdown", repo: "repo", base: "base", head: "one", results: [check, proof], policy: { minVerified: 1, strict: true, sha256: "sha256:policy" } });
  const after = buildReport({ transcript: "b", transcriptFormat: "markdown", repo: "repo", base: "base", head: "two", results: [check, proof], policy: { minVerified: 1, strict: true, sha256: "sha256:policy" } });
  const beforePath = join(root, "before.json"); const afterPath = join(root, "after.json"); const output = join(root, "delta.json");
  writeFileSync(beforePath, JSON.stringify(before)); writeFileSync(afterPath, JSON.stringify(after));
  assert.equal(run(["compare", beforePath, afterPath, "--format", "json", "--output", output]), 0);
  const delta = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(delta.status, "PASS");
  assert.equal(delta.schemaVersion, "agent-vigil-receipt-delta/v1");
  after.policy.strict = false;
  writeFileSync(afterPath, JSON.stringify(after));
  assert.equal(run(["compare", beforePath, afterPath]), 1);
});
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
  assert.equal(run([summary, "--repo", r, "--output", output, "--format", "json", "--test-cmd", "npm test --silent", "--min-verified", "1"]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.summary.status, "PASS");
  assert.match(receipt.reproduction, /--test-cmd 'npm test --silent'/);
  assert.match(receipt.reproduction, /--min-verified 1/);
});

test("CLI guard-compat writes a process-only HOLD receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-guard-compat-cli-"));
  const script = join(root, "control.mjs");
  const argumentsPath = join(root, "args.json");
  const policy = join(root, "policy.json");
  const configuration = join(root, "configuration.json");
  const output = join(root, "receipt.json");
  writeFileSync(script, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(0, "utf8"));
const deny = data.tool_input.command.includes("PROCESS_CONFORMANCE_DENY");
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: deny ? "deny" : "allow" } }));
`);
  chmodSync(script, 0o700);
  writeFileSync(argumentsPath, JSON.stringify([script]));
  writeFileSync(policy, '{"deny":"PROCESS_CONFORMANCE_DENY"}\n');
  writeFileSync(configuration, '{"event":"PreToolUse"}\n');
  assert.equal(run([
    "guard-compat", "--host", "codex", "--host-version", "0.149.1", "--host-executable", process.execPath,
    "--control-name", "fixture", "--control-version", "1", "--control-executable", process.execPath,
    "--control-artifact", script, "--control-args", argumentsPath, "--policy", policy,
    "--configuration", configuration, "--format", "json", "--output", output,
  ]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.schemaVersion, "agent-vigil-guard-compatibility/v1");
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.deployment.state, "HOLD");
  assert.deepEqual(receipt.deployment.reasonCodes, ["LIVE_HOST_ROUTE_NOT_PROVEN"]);
  assert.equal(JSON.stringify(receipt).includes(root), false);
  assert.equal(run(["guard-compat", "--host", "cursor"]), 2);
});

test("CLI init and doctor provide a working exact-SHA scaffold", () => {
  const r = repo();
  assert.equal(run(["init", "--repo", r]), 0);
  assert.equal(run(["doctor", "--repo", r]), 0);
  const workflow = readFileSync(join(r, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.match(workflow, /policy-ref/);
  assert.match(workflow, /pull_request\.base\.sha/);
});

test("CLI maintainer init exposes the profile without creating a transcript placeholder", () => {
  const r = repo();
  assert.equal(run(["init", "--profile", "maintainer", "--repo", r]), 0);
  assert.equal(run(["doctor", "--repo", r]), 0);
  const workflow = readFileSync(join(r, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.match(workflow, /mode: maintainer/);
  assert.equal(readFileSync(join(r, ".agent-vigil.json"), "utf8").includes('"maintainer"'), true);
});

test("CLI authority init creates a base-anchored task-boundary workflow", () => {
  const r = repo();
  assert.equal(run(["init", "--profile", "authority", "--repo", r]), 0);
  const workflow = readFileSync(join(r, ".github/workflows/agent-vigil.yml"), "utf8");
  const contract = JSON.parse(readFileSync(join(r, ".agent-vigil-authority.json"), "utf8"));
  assert.match(workflow, /authority-contract: \.agent-vigil-authority\.json/);
  assert.match(workflow, /transcript: \.agent-vigil\/session\.jsonl/);
  assert.match(workflow, /authority-contract-ref: \$\{\{ github\.event\.pull_request\.base\.sha/);
  assert.equal(contract.allowedActions.includes("git_push"), false);
  assert.equal(contract.allowedActions.includes("deploy"), false);
});

test("CLI portable init pins a public key and scaffolds receipt mode", () => {
  const r = repo(); const keys = mkdtempSync(join(tmpdir(), "vigil-init-portable-"));
  const privateKey = join(keys, "private.pem"); const publicKey = join(keys, "public.pem");
  generateSigningKey(privateKey, publicKey);
  assert.equal(run(["init", "--portable", "--public-key", publicKey, "--repo", r]), 0);
  const policy = JSON.parse(readFileSync(join(r, ".agent-vigil.json"), "utf8"));
  const workflow = readFileSync(join(r, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.deepEqual(policy.trustedSignerKeyIds, [publicKeyId(publicKey)]);
  assert.equal(policy.portableReceipt, ".agent-vigil/receipt.json");
  assert.equal(policy.transcript, undefined);
  assert.match(workflow, /receipt: \.agent-vigil\/receipt\.json/);
  assert.doesNotMatch(workflow, /transcript:/);
});

test("CLI signs and verifies a receipt with a pinned key", () => {
  const r = repo(); const summary = join(r, "pass.md"); const output = join(r, "receipt.json");
  const keys = mkdtempSync(join(tmpdir(), "vigil-keys-"));
  const privateKey = join(keys, "private.pem"); const publicKey = join(keys, "public.pem");
  writeFileSync(summary, "The test suite passes.");
  assert.equal(run(["keygen", "--private", privateKey, "--public", publicKey]), 0);
  assert.equal(run([summary, "--repo", r, "--signing-key", privateKey, "--output", output]), 0);
  assert.equal(run(["verify", output, "--public-key", publicKey]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.signature.algorithm, "Ed25519");
});

test("CLI verify rejects a tampered receipt", () => {
  const r = repo(); const summary = join(r, "pass.md"); const output = join(r, "receipt.json");
  writeFileSync(summary, "The test suite passes.");
  assert.equal(run([summary, "--repo", r, "--output", output]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  receipt.results[0].evidence = "fabricated";
  writeFileSync(output, JSON.stringify(receipt));
  assert.equal(run(["verify", output]), 1);
});

function portableRepo() {
  const path = mkdtempSync(join(tmpdir(), "vigil-portable-"));
  const keys = mkdtempSync(join(tmpdir(), "vigil-portable-keys-"));
  const privateKey = join(keys, "private.pem"); const publicKey = join(keys, "public.pem");
  generateSigningKey(privateKey, publicKey);
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: path });
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "node --test test.js" } }));
  writeFileSync(join(path, "test.js"), "const{test}=require('node:test');test('one',()=>{if(process.env.VIGIL_PLANTED_FAIL)throw Error('planted')});\n");
  writeFileSync(join(path, ".agent-vigil.json"), JSON.stringify({
    schemaVersion: 1,
    testCommand: "npm test --silent",
    strict: true,
    minVerified: 1,
    portableReceipt: ".agent-vigil/receipt.json",
    trustedSignerKeyIds: [publicKeyId(publicKey)],
  }, null, 2));
  execFileSync("git", ["add", "-A"], { cwd: path }); execFileSync("git", ["commit", "-qm", "base policy"], { cwd: path });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  writeFileSync(join(path, "README.md"), "agent change\n");
  execFileSync("git", ["add", "README.md"], { cwd: path }); execFileSync("git", ["commit", "-qm", "agent change"], { cwd: path });
  const codeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  const summary = join(keys, "summary.md"); writeFileSync(summary, "The test suite passes.\n");
  const portable = ".agent-vigil/receipt.json";
  assert.equal(run([summary, "--repo", path, "--base", base, "--head", codeHead, "--policy", ".agent-vigil.json", "--policy-ref", base, "--signing-key", privateKey, "--portable-output", portable]), 0);
  execFileSync("git", ["add", portable], { cwd: path }); execFileSync("git", ["commit", "-qm", "attach private receipt"], { cwd: path });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  return { path, keys, privateKey, publicKey, base, codeHead, head, portable };
}

test("CLI portable gate accepts a signed receipt-only tail and fresh CI check", () => {
  const fixture = portableRepo();
  const output = join(fixture.keys, "gate-report.json");
  assert.equal(run(["gate", fixture.portable, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 0);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.summary.status, "PASS");
  assert.ok(report.results.some((item: { ruleId: string }) => item.ruleId === "portable-git-binding"));
  assert.ok(report.results.some((item: { ruleId: string }) => item.ruleId === "tests-pass"));
});

test("CLI portable gate accepts an exact code head with an untracked compact receipt", () => {
  const fixture = portableRepo();
  const receiptPath = join(fixture.path, fixture.portable);
  const compact = readFileSync(receiptPath, "utf8");
  execFileSync("git", ["checkout", "-q", fixture.codeHead], { cwd: fixture.path });
  mkdirSync(join(fixture.path, ".agent-vigil"), { recursive: true });
  writeFileSync(receiptPath, compact);
  assert.equal(run(["gate", fixture.portable, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.codeHead, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base]), 0);
});

test("CLI portable gate rejects a receipt path not pinned by policy", () => {
  const fixture = portableRepo();
  const alternate = ".agent-vigil/other-receipt.json";
  writeFileSync(join(fixture.path, alternate), readFileSync(join(fixture.path, fixture.portable)));
  assert.equal(run(["gate", alternate, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base]), 1);
});

test("doctor recognizes an existing portable receipt", () => {
  const fixture = portableRepo();
  assert.equal(run(["doctor", "--repo", fixture.path]), 0);
});

test("CLI portable gate rejects receipt tampering", () => {
  const fixture = portableRepo();
  const receiptPath = join(fixture.path, fixture.portable);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.summary.status = "FAIL"; receipt.summary.pass = false;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.equal(run(["gate", fixture.portable, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base]), 1);
});

test("CLI portable gate independently fails when the trusted command turns red", () => {
  const fixture = portableRepo();
  process.env.VIGIL_PLANTED_FAIL = "1";
  try {
    assert.equal(run(["gate", fixture.portable, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base]), 1);
  } finally { delete process.env.VIGIL_PLANTED_FAIL; }
});

test("CLI portable gate rejects a post-receipt source change", () => {
  const fixture = portableRepo();
  writeFileSync(join(fixture.path, "after.js"), "module.exports = 1;\n");
  execFileSync("git", ["add", "after.js"], { cwd: fixture.path }); execFileSync("git", ["commit", "-qm", "post receipt change"], { cwd: fixture.path });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.path, encoding: "utf8" }).trim();
  assert.equal(run(["gate", fixture.portable, "--repo", fixture.path, "--base", fixture.base, "--head", head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base]), 1);
});
