import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.ts";
import { generateSigningKey, publicKeyId } from "../src/signature.ts";
import { buildReport } from "../src/report.ts";
import { doctorRepository, OFFICIAL_COMMON_RUNNER_IMAGE } from "../src/setup.ts";

const ACTION_SHA = "0123456789abcdef0123456789abcdef01234567";

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

test("CLI first-use help exits zero and keeps advanced commands behind one explicit step", () => {
  assert.equal(run([]), 0);
  assert.equal(run(["--help"]), 0);
});
test("CLI advanced help remains available explicitly", () => {
  assert.equal(run(["help", "--all"]), 0);
});
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
    ["protect", "--repo", root, "--runner", "common"],
    ["protect", "--repo", root, "--runner", "unknown", "--test-cmd", "go test ./..."],
    ["protect", "--repo", root, "--runner", "common", "--runner-image", `ghcr.io/example/runner@sha256:${"a".repeat(64)}`, "--test-cmd", "go test ./..."],
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

test("CLI common runner preset writes the published immutable image", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-cli-common-runner-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'common-runner-fixture'\n");
  writeFileSync(join(root, "test_example.py"), "def test_example():\n    assert 2 + 2 == 4\n");

  assert.equal(run([
    "protect", "--repo", root, "--action-sha", ACTION_SHA,
    "--runner", "common", "--test-cmd", "python3 -m pytest -q",
  ]), 0);
  const contract = JSON.parse(readFileSync(join(root, ".agent-vigil-runner.json"), "utf8"));
  assert.equal(contract.image, OFFICIAL_COMMON_RUNNER_IMAGE);
  assert.equal(contract.testCommand, "python3 -m pytest -q");
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
  const policySha256 = `sha256:${"a".repeat(64)}`;
  const before = buildReport({ transcript: "a", transcriptFormat: "markdown", repo: "repo", base: "base", head: "one", results: [check, proof], policy: { minVerified: 1, strict: true, sha256: policySha256 } });
  const after = buildReport({ transcript: "b", transcriptFormat: "markdown", repo: "repo", base: "base", head: "two", results: [check, proof], policy: { minVerified: 1, strict: true, sha256: policySha256 } });
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
test("CLI executes an explicit base test command even when the transcript makes no test claim", () => {
  const r = repo();
  const summary = join(r, "neutral.md");
  const output = join(r, "neutral-receipt.json");
  writeFileSync(summary, "No fresh-test assertion appears in this narrative.\n");
  assert.equal(run([
    summary, "--repo", r, "--test-cmd", "node --test test.js", "--output", output, "--format", "json",
  ]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.ok(receipt.results.some((check: { ruleId: string; verdict: string }) => check.ruleId === "tests-pass" && check.verdict === "verified"));
});
test("CLI writes JSON receipt", () => {
  const r = repo(); const summary = join(r, "pass.md"); const output = join(r, "receipt.json"); writeFileSync(summary, "The test suite passes.");
  assert.equal(run([summary, "--repo", r, "--output", output, "--format", "json", "--test-cmd", "npm test --silent", "--min-verified", "1"]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.summary.status, "PASS");
  assert.match(receipt.reproduction, /--test-cmd 'npm test --silent'/);
  assert.match(receipt.reproduction, /--min-verified 1/);
});

test("CLI minimum override can strengthen but cannot weaken a trusted policy", () => {
  const r = repo();
  const summary = join(r, "policy-minimum.md");
  const policy = join(r, ".agent-vigil.json");
  const output = join(r, "policy-minimum-receipt.json");
  writeFileSync(summary, "The test suite passes.\n");
  writeFileSync(policy, `${JSON.stringify({ schemaVersion: 1, strict: true, minVerified: 2, testCommand: "node --test test.js" }, null, 2)}\n`);
  execFileSync("git", ["add", ".agent-vigil.json"], { cwd: r });
  execFileSync("git", ["commit", "-qm", "trusted policy minimum"], { cwd: r });

  assert.equal(run([
    summary, "--repo", r, "--policy", ".agent-vigil.json", "--min-verified", "1",
    "--output", output, "--format", "json",
  ]), 2);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.policy.minVerified, 2);
  assert.equal(receipt.summary.status, "INCONCLUSIVE");
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
  const command = [
    "guard-compat", "--host", "codex", "--host-version", "0.149.1", "--host-executable", process.execPath,
    "--control-name", "fixture", "--control-version", "1", "--control-executable", process.execPath,
    "--control-artifact", script, "--control-args", argumentsPath, "--policy", policy,
    "--configuration", configuration, "--format", "json",
  ];
  assert.equal(run([...command, "--output", output]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.schemaVersion, "agent-vigil-guard-compatibility/v1");
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.deployment.state, "HOLD");
  assert.deepEqual(receipt.deployment.reasonCodes, ["LIVE_HOST_ROUTE_NOT_PROVEN"]);
  assert.equal(JSON.stringify(receipt).includes(root), false);
  for (const input of [script, argumentsPath, policy, configuration]) {
    const before = readFileSync(input);
    assert.equal(run([...command, "--output", input]), 2, input);
    assert.deepEqual(readFileSync(input), before, input);
  }
  const hardLinkOutput = join(root, "policy-output-hardlink.json");
  linkSync(policy, hardLinkOutput);
  assert.equal(run([...command, "--output", hardLinkOutput]), 2);
  assert.equal(readFileSync(policy, "utf8"), '{"deny":"PROCESS_CONFORMANCE_DENY"}\n');
  if (process.platform !== "win32") {
    const symbolicOutput = join(root, "configuration-output-symlink.json");
    symlinkSync(configuration, symbolicOutput);
    assert.equal(run([...command, "--output", symbolicOutput]), 2);
    assert.equal(readFileSync(configuration, "utf8"), '{"event":"PreToolUse"}\n');
  }
  assert.equal(run(["guard-compat", "--host", "cursor"]), 2);
});

test("CLI guard-route refuses an output path that aliases its disposable profile marker", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-guard-route-output-alias-"));
  const profile = join(root, "profile");
  const marker = join(profile, ".agent-vigil-disposable-profile");
  mkdirSync(profile, { mode: 0o700 });
  writeFileSync(marker, "agent-vigil disposable host profile v1\n", { mode: 0o600 });
  assert.equal(run([
    "guard-route", "--host", "codex", "--host-version", "fixture", "--host-executable", process.execPath,
    "--profile-home", profile, "--output", marker,
  ]), 2);
  assert.equal(readFileSync(marker, "utf8"), "agent-vigil disposable host profile v1\n");
});

test("CLI init and doctor provide a working exact-SHA scaffold", () => {
  const r = repo();
  assert.equal(run(["init", "--action-sha", ACTION_SHA, "--repo", r]), 0);
  assert.equal(run(["doctor", "--repo", r]), 2, "uncommitted control inputs are not exact-head evidence");
  execFileSync("git", ["add", "-A"], { cwd: r });
  execFileSync("git", ["commit", "-qm", "install Agent Vigil"], { cwd: r });
  assert.equal(run(["doctor", "--repo", r]), 0);
  const workflow = readFileSync(join(r, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.match(workflow, /policy-ref/);
  assert.match(workflow, /pull_request\.base\.sha/);
});

test("CLI hosted init still requires an explicit pin while protect supplies its reviewed pin", () => {
  const missing = repo();
  assert.equal(run(["init", "--repo", missing]), 2);
  assert.equal(run(["init", "--action-sha", ACTION_SHA.toUpperCase(), "--repo", missing]), 2);
  assert.equal(run(["init", "--action-sha", ACTION_SHA, "--attest", "--repo", missing]), 2);
  assert.equal(run(["protect", "--action-sha", ACTION_SHA, "--attest", "--repo", missing]), 2);
  assert.equal(run(["protect", "--repo", repo()]), 0);
});

test("CLI init and protect reject unknown, missing, stray, and duplicate arguments", () => {
  const cases = [
    ["init", "--protfile", "authority", "--action-sha", ACTION_SHA],
    ["init", "stray", "--action-sha", ACTION_SHA],
    ["init", "--repo", "--action-sha", ACTION_SHA],
    ["init", "--profile", "default", "--profile", "authority", "--action-sha", ACTION_SHA],
    ["init", "--force", "--force", "--action-sha", ACTION_SHA],
    ["protect", "--repo"],
    ["protect", "stray", "--action-sha", ACTION_SHA],
    ["protect", "--action-sha", ACTION_SHA, "--action-sha", ACTION_SHA],
    ["protect", "--force", "--force", "--action-sha", ACTION_SHA],
  ];
  for (const args of cases) assert.equal(run(args), 2, args.join(" "));
});

test("CLI maintainer init exposes the profile without creating a transcript placeholder", () => {
  const r = repo();
  assert.equal(run(["init", "--profile", "maintainer", "--action-sha", ACTION_SHA, "--repo", r]), 0);
  assert.equal(run(["doctor", "--repo", r]), 2, "maintainer controls must be committed before doctor can pass");
  execFileSync("git", ["add", "-A"], { cwd: r });
  execFileSync("git", ["commit", "-qm", "install maintainer profile"], { cwd: r });
  assert.equal(run(["doctor", "--repo", r]), 0);
  const workflow = readFileSync(join(r, ".github/workflows/agent-vigil.yml"), "utf8");
  assert.match(workflow, /mode: maintainer/);
  assert.equal(readFileSync(join(r, ".agent-vigil.json"), "utf8").includes('"maintainer"'), true);
});

test("CLI authority init creates a base-anchored task-boundary workflow", () => {
  const r = repo();
  assert.equal(run(["init", "--profile", "authority", "--action-sha", ACTION_SHA, "--repo", r]), 0);
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
  assert.equal(run(["init", "--portable", "--public-key", publicKey, "--action-sha", ACTION_SHA, "--repo", r]), 0);
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

function portableRepo(minVerified = 1) {
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
    minVerified,
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
  assert.equal(run([summary, "--repo", path, "--base", base, "--head", codeHead, "--policy", ".agent-vigil.json", "--policy-ref", base, "--signing-key", privateKey, "--portable-output", portable]), minVerified === 1 ? 0 : 2);
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

test("portable receipt output refuses destination and parent symlinks", { skip: process.platform === "win32" }, () => {
  const direct = portableRepo();
  const directPath = join(direct.path, direct.portable);
  const directTarget = join(direct.keys, "portable-target.json");
  const directSummary = join(direct.keys, "direct-summary.md");
  rmSync(directPath);
  writeFileSync(directTarget, "must remain unchanged\n");
  writeFileSync(directSummary, "The test suite passes.\n");
  symlinkSync(directTarget, directPath);
  assert.equal(run([
    directSummary, "--repo", direct.path, "--base", direct.base, "--head", direct.codeHead,
    "--policy", ".agent-vigil.json", "--policy-ref", direct.base,
    "--signing-key", direct.privateKey, "--portable-output", direct.portable,
  ]), 2);
  assert.equal(readFileSync(directTarget, "utf8"), "must remain unchanged\n");

  const parent = portableRepo();
  const parentDirectory = join(parent.path, ".agent-vigil");
  const outside = join(parent.keys, "outside-parent");
  const parentSummary = join(parent.keys, "parent-summary.md");
  rmSync(parentDirectory, { recursive: true });
  mkdirSync(outside);
  writeFileSync(parentSummary, "The test suite passes.\n");
  symlinkSync(outside, parentDirectory, "dir");
  assert.equal(run([
    parentSummary, "--repo", parent.path, "--base", parent.base, "--head", parent.codeHead,
    "--policy", ".agent-vigil.json", "--policy-ref", parent.base,
    "--signing-key", parent.privateKey, "--portable-output", parent.portable,
  ]), 2);
  assert.equal(existsSync(join(outside, "receipt.json")), false);
});

test("CLI portable gate rejects a receipt tail that hides an old-path deletion as a rename", () => {
  const fixture = portableRepo();
  const oldReceipt = ".agent-vigil/old-receipt.json";
  execFileSync("git", ["mv", fixture.portable, oldReceipt], { cwd: fixture.path });
  execFileSync("git", ["commit", "-qm", "move first receipt aside"], { cwd: fixture.path });
  const receiptHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.path, encoding: "utf8" }).trim();

  const summary = join(fixture.keys, "second-summary.md");
  const savedReceipt = join(fixture.keys, "second-receipt.json");
  writeFileSync(summary, "The test suite passes.\n");
  assert.equal(run([
    summary, "--repo", fixture.path, "--base", fixture.base, "--head", receiptHead,
    "--policy", ".agent-vigil.json", "--policy-ref", fixture.base,
    "--signing-key", fixture.privateKey, "--portable-output", fixture.portable,
  ]), 0);
  const raw = readFileSync(join(fixture.path, fixture.portable), "utf8");
  writeFileSync(savedReceipt, raw);
  rmSync(join(fixture.path, fixture.portable));
  execFileSync("git", ["mv", oldReceipt, fixture.portable], { cwd: fixture.path });
  writeFileSync(join(fixture.path, fixture.portable), raw);
  execFileSync("git", ["add", fixture.portable], { cwd: fixture.path });
  execFileSync("git", ["commit", "-qm", "attach replacement receipt"], { cwd: fixture.path });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.path, encoding: "utf8" }).trim();

  const renameAware = execFileSync("git", ["diff", "--name-only", "-z", receiptHead, head], {
    cwd: fixture.path,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  assert.deepEqual(renameAware, [fixture.portable], "the regression must exercise Git's destination-only rename view");

  const output = join(fixture.keys, "renamed-tail-gate-report.json");
  assert.equal(run([
    "gate", savedReceipt, "--receipt-git-path", fixture.portable,
    "--repo", fixture.path, "--base", fixture.base, "--head", head,
    "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output,
  ]), 1);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.ok(report.results.some((item: { ruleId: string; verdict: string }) =>
    item.ruleId === "portable-git-binding" && item.verdict === "contradicted"));
});

test("CLI portable gate preserves a stronger trusted-policy evidence minimum", () => {
  const fixture = portableRepo(99);
  const output = join(fixture.keys, "strong-policy-gate-report.json");
  assert.equal(run([
    "gate", fixture.portable, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head,
    "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output,
  ]), 2);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.policy.minVerified, 99);
  assert.equal(report.summary.status, "INCONCLUSIVE");
});

test("CLI portable gate binds a private receipt snapshot to its exact logical Git path", () => {
  const fixture = portableRepo();
  const snapshot = join(fixture.keys, "private-receipt.json");
  const raw = readFileSync(join(fixture.path, fixture.portable), "utf8");
  writeFileSync(snapshot, raw);
  const args = [
    "gate", snapshot, "--receipt-git-path", fixture.portable,
    "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head,
    "--policy", ".agent-vigil.json", "--policy-ref", fixture.base,
  ];
  assert.equal(run(args), 0);

  writeFileSync(snapshot, `${raw}\n`);
  assert.equal(run(args), 1, "private bytes that differ from the exact head blob fail closed");
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
  const checks = doctorRepository(fixture.path);
  assert.ok(checks.some((check) => check.label === "Portable receipt" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "GitHub Action" && check.status === "FAIL"));
  assert.equal(run(["doctor", "--repo", fixture.path]), 2, "a committed receipt does not substitute for the missing hosted workflow");
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
