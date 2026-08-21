import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.ts";
import { generateSigningKey, publicKeyId } from "../src/signature.ts";

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
  assert.equal(run([summary, "--repo", r, "--output", output, "--format", "json", "--test-cmd", "npm test --silent", "--min-verified", "1"]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.summary.status, "PASS");
  assert.match(receipt.reproduction, /--test-cmd 'npm test --silent'/);
  assert.match(receipt.reproduction, /--min-verified 1/);
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
