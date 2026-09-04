import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { checkIntegrityDiff } from "../src/detectors/reality.ts";

const ACTION_SHA = "0123456789abcdef0123456789abcdef01234567";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function repo(prefix = "vigil-receipt-product-") {
  const path = mkdtempSync(join(tmpdir(), prefix));
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "vigil@example.test"]);
  git(path, ["config", "user.name", "Vigil Test"]);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "node --test test.js" } }));
  writeFileSync(join(path, "test.js"), "const assert=require('node:assert/strict');const{test}=require('node:test');test('one',()=>{assert.equal(1,1);});\n");
  writeFileSync(join(path, "src.js"), "module.exports = 1;\n");
  git(path, ["add", "-A"]);
  git(path, ["commit", "-qm", "base"]);
  const base = git(path, ["rev-parse", "HEAD"]);
  writeFileSync(join(path, "src.js"), "module.exports = 2;\n");
  git(path, ["add", "src.js"]);
  git(path, ["commit", "-qm", "head"]);
  const head = git(path, ["rev-parse", "HEAD"]);
  return { path, base, head };
}

function writeCodexTranscript(path: string, command: string, output: string, final: string, isError = !output.includes("# fail 0")): string {
  const transcript = join(path, `session-${Math.random().toString(16).slice(2)}.jsonl`);
  const rows = [
    { type: "session_meta", payload: { id: "receipt-product-test", model: "fixture-model" } },
    { type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: command }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ exit_code: isError ? 1 : 0, output }) } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: final }] } },
  ];
  writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return transcript;
}

function runQuiet(args: string[]): number {
  return runCaptured(args).code;
}

function runCaptured(args: string[]): { code: number; stdout: string; stderr: string } {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  let stdout = "";
  let stderr = "";
  console.log = (...items: unknown[]) => { stdout += `${items.join(" ")}\n`; };
  console.error = (...items: unknown[]) => { stderr += `${items.join(" ")}\n`; };
  (process.stdout.write as typeof process.stdout.write) = ((chunk: string | Uint8Array) => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try { return { code: run(args), stdout, stderr }; }
  finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
}

test("watch catches the 4966/4966 denominator-shrink stop-event bug", () => {
  const fixture = repo();
  const transcript = writeCodexTranscript(
    fixture.path,
    "npm test --silent",
    "# tests 4992\n# pass 4985\n# fail 7\n# skipped 0\n",
    "Done. 4966/4966 ALL PASSED.",
  );
  const output = join(fixture.path, "watch-receipt.json");
  assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--output", output, "--format", "json"]), 1);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.summary.status, "FAIL");
  assert.ok(receipt.results.some((item: any) => item.ruleId === "denominator-shrink-4966"));
});

test("watch hard-fails verifier pipelines and produces export/corpus artifacts", () => {
  const fixture = repo();
  const transcript = writeCodexTranscript(
    fixture.path,
    "npm test --silent | tee test.log",
    "# tests 1\n# pass 1\n# fail 0\n",
    "The test suite passes.",
  );
  const receiptPath = join(fixture.path, "pipeline-receipt.json");
  assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--output", receiptPath, "--format", "json"]), 1);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.ok(receipt.results.some((item: any) => item.ruleId === "piped-exit-code"));

  const bypassTranscript = writeCodexTranscript(
    fixture.path,
    ["npm test", "true"].join(" || "),
    "# tests 1\n# pass 1\n# fail 0\n",
    "The test suite passes.",
  );
  const bypassReceiptPath = join(fixture.path, "bypass-receipt.json");
  assert.equal(runQuiet(["watch", bypassTranscript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--output", bypassReceiptPath, "--format", "json"]), 1);
  const bypassReceipt = JSON.parse(readFileSync(bypassReceiptPath, "utf8"));
  assert.ok(bypassReceipt.results.some((item: any) => item.ruleId === "verification-bypass"));

  const exportPath = join(fixture.path, "soc2.md");
  assert.equal(runQuiet(["vault", "export", receiptPath, "--pack", "soc2", "--format", "markdown", "--output", exportPath]), 1);
  assert.match(readFileSync(exportPath, "utf8"), /SOC 2 CC8\.1/);

  const signaturePath = join(fixture.path, "signature.json");
  assert.equal(runQuiet(["corpus", "signature", receiptPath, "--model", "fixture-model", "--harness", "watch-test", "--output", signaturePath]), 0);
  const signature = JSON.parse(readFileSync(signaturePath, "utf8"));
  assert.equal(signature.schemaVersion, "agent-vigil-cheat-signature/v1");
  assert.ok(signature.taxonomyIds.includes("VIGIL-004"));
  assert.equal(signature.privacy.transcriptIncluded, false);
});

test("watch passes an honest final summary with a fresh test command", () => {
  const fixture = repo();
  const transcript = writeCodexTranscript(
    fixture.path,
    "node --test test.js",
    "# tests 1\n# pass 1\n# fail 0\n",
    "The test suite passes.",
  );
  const output = join(fixture.path, "pass-receipt.json");
  assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--test-cmd", "node --test test.js", "--output", output]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.summary.status, "PASS");
  assert.ok(receipt.results.some((item: any) => item.ruleId === "tests-pass" && item.verdict === "verified"));
});

test("watch renders alternate formats and refuses ambiguous inputs", () => {
  const fixture = repo();
  const transcript = writeCodexTranscript(
    fixture.path,
    "node --test test.js",
    "# tests 1\n# pass 1\n# fail 0\n",
    "The test suite passes.",
  );
  const receiptDir = mkdtempSync(join(tmpdir(), "vigil-watch-output-"));
  const receiptPath = join(receiptDir, "markdown-receipt.json");
  const sarifPath = join(receiptDir, "watch.sarif");
  const markdown = runCaptured(["watch", transcript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--test-cmd", "node --test test.js", "--format", "markdown", "--output", receiptPath, "--sarif", sarifPath]);
  assert.equal(markdown.code, 0);
  assert.match(markdown.stdout, /### Agent Vigil: PASS/);
  assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).summary.status, "PASS");
  assert.equal(JSON.parse(readFileSync(sarifPath, "utf8")).runs[0].properties.status, "PASS");

  const json = runCaptured(["watch", transcript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--test-cmd", "node --test test.js", "--json"]);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).summary.status, "PASS");
  assert.match(runCaptured(["watch", "--help"]).stdout, /Overnight Receipt/);
  assert.equal(runQuiet(["watch"]), 2);
  assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--repo", fixture.path]), 2);
  assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--format", "xml"]), 2);
  assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--output", transcript]), 2);
  assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--base", "bad", "--head", fixture.head]), 2);
  assert.equal(runQuiet(["watch", transcript, "--repo", join(fixture.path, "missing"), "--base", fixture.base, "--head", fixture.head]), 2);

  const emptyFinal = join(fixture.path, "empty-final.jsonl");
  writeFileSync(emptyFinal, `${JSON.stringify({ type: "session_meta", payload: { id: "empty", model: "fixture" } })}\n`);
  const emptyReceipt = join(receiptDir, "empty-final-receipt.json");
  assert.equal(runQuiet(["watch", emptyFinal, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--output", emptyReceipt]), 2);
  assert.ok(JSON.parse(readFileSync(emptyReceipt, "utf8")).results.some((item: any) => item.ruleId === "stop-event-present"));
});

test("watch requires successful external-operation proof and ignores negated release statements", () => {
  const receiptDir = mkdtempSync(join(tmpdir(), "vigil-receipt-output-"));
  const failedFixture = repo();
  const failedPublish = writeCodexTranscript(
    failedFixture.path,
    "npm publish",
    "npm ERR! code E401\nnpm ERR! unable to authenticate\n",
    "Published to npm.",
  );
  const failedPublishReceipt = join(receiptDir, "failed-publish-receipt.json");
  assert.notEqual(runQuiet(["watch", failedPublish, "--repo", failedFixture.path, "--base", failedFixture.base, "--head", failedFixture.head, "--output", failedPublishReceipt, "--format", "json"]), 0);
  const failed = JSON.parse(readFileSync(failedPublishReceipt, "utf8"));
  assert.ok(failed.results.some((item: any) => item.ruleId === "stop-event-npm-proof"));

  const negatedFixture = repo();
  const negated = writeCodexTranscript(
    negatedFixture.path,
    "node --test test.js",
    "# tests 1\n# pass 1\n# fail 0\n",
    "The test suite passes. The PR was not merged. npm is not live. Production was not deployed.",
  );
  const negatedReceipt = join(receiptDir, "negated-release-receipt.json");
  assert.equal(runQuiet(["watch", negated, "--repo", negatedFixture.path, "--base", negatedFixture.base, "--head", negatedFixture.head, "--output", negatedReceipt, "--format", "json"]), 0);
  const receipt = JSON.parse(readFileSync(negatedReceipt, "utf8"));
  assert.equal(receipt.summary.status, "PASS");
  assert.equal(receipt.results.some((item: any) => item.ruleId.startsWith("stop-event-") && item.ruleId.endsWith("-proof")), false);
});

test("watch accepts only successful external-operation proofs", () => {
  const receiptDir = mkdtempSync(join(tmpdir(), "vigil-receipt-proofs-"));
  const passingProofs = [
    {
      name: "npm-stage-approve",
      command: "npx --yes npm@12.0.2 stage approve 99252c9b-2c3c-4ea0-aa59-d99b17aa64ad",
      output: "approved @sulmusic/agent-vigil@0.23.5\n",
      final: "The test suite passes. Published to npm as @sulmusic/agent-vigil@0.23.5.",
      rule: "stop-event-npm-proof",
    },
    {
      name: "npm-view-observed-version",
      command: "npm view @sulmusic/agent-vigil version --json",
      output: "\"0.23.5\"\n",
      final: "The test suite passes. npm 0.23.5 is live.",
      rule: "stop-event-npm-proof",
    },
    {
      name: "direct-pr-merge",
      command: "gh pr merge 177 --merge",
      output: "Merged pull request #177\n",
      final: "The test suite passes. The PR merged.",
      rule: "stop-event-merge-proof",
    },
    {
      name: "merged-at-view",
      command: "gh pr view 177 --json mergedAt",
      output: "{\"mergedAt\":\"2026-09-03T23:00:00Z\"}\n",
      final: "The test suite passes. The PR merged.",
      rule: "stop-event-merge-proof",
    },
    {
      name: "deploy-command",
      command: "wrangler deploy",
      output: "Published worker https://agent-vigil.workers.dev\n",
      final: "The test suite passes. Production deployed.",
      rule: "stop-event-deploy-proof",
    },
  ];

  for (const proof of passingProofs) {
    const fixture = repo(`vigil-receipt-${proof.name}-`);
    const transcript = writeCodexTranscript(fixture.path, proof.command, proof.output, proof.final, false);
    const receiptPath = join(receiptDir, `${proof.name}.json`);
    assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--test-cmd", "node --test test.js", "--output", receiptPath, "--format", "json"]), 0);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.summary.status, "PASS");
    assert.equal(receipt.results.some((item: any) => item.ruleId === proof.rule), false);
  }

  const failedProofs = [
    {
      name: "failed-merge",
      command: "gh pr merge 177 --merge",
      output: "GraphQL: Repository rule violations found\n",
      final: "The test suite passes. The PR merged.",
      rule: "stop-event-merge-proof",
      isError: true,
    },
    {
      name: "dry-run-publish",
      command: "npm publish --dry-run",
      output: "+ @sulmusic/agent-vigil@0.23.5\n",
      final: "The test suite passes. Published to npm as @sulmusic/agent-vigil@0.23.5.",
      rule: "stop-event-npm-proof",
      isError: false,
    },
    {
      name: "wrong-npm-view-version",
      command: "npm view @sulmusic/agent-vigil version --json",
      output: "\"0.21.1\"\n",
      final: "The test suite passes. npm 0.23.5 is live.",
      rule: "stop-event-npm-proof",
      isError: false,
    },
  ];

  for (const proof of failedProofs) {
    const fixture = repo(`vigil-receipt-${proof.name}-`);
    const transcript = writeCodexTranscript(fixture.path, proof.command, proof.output, proof.final, proof.isError);
    const receiptPath = join(receiptDir, `${proof.name}.json`);
    assert.notEqual(runQuiet(["watch", transcript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--test-cmd", "node --test test.js", "--output", receiptPath, "--format", "json"]), 0);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.ok(receipt.results.some((item: any) => item.ruleId === proof.rule));
  }
});

test("counterweight install writes the required check workflow and ruleset manifest", () => {
  const fixture = repo();
  assert.equal(runQuiet(["counterweight", "install", "--repo", fixture.path, "--owner-repo", "example/project", "--action-sha", ACTION_SHA]), 0);
  const workflow = readFileSync(join(fixture.path, ".github/workflows/agent-vigil-counterweight.yml"), "utf8");
  const ruleset = JSON.parse(readFileSync(join(fixture.path, ".github/agent-vigil-required-check-ruleset.json"), "utf8"));
  const applyScriptPath = join(fixture.path, ".github/agent-vigil-apply-ruleset.sh");
  const applyScript = readFileSync(applyScriptPath, "utf8");
  const applyScriptMode = statSync(applyScriptPath).mode;
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /policy-ref: \${{ github\.event\.pull_request\.base\.sha }}/);
  assert.match(workflow, /isolate-candidate: true/);
  assert.match(workflow, new RegExp(`sulmusic2-star/agent-vigil@${ACTION_SHA}`));
  assert.doesNotMatch(workflow, /^\s+(?:event|format|github-summary):/m);
  assert.match(applyScript, /^#!\/usr\/bin\/env bash/);
  if (process.platform !== "win32") assert.notEqual(applyScriptMode & 0o111, 0);
  assert.equal(ruleset._agentVigil.requiredCheck, "Agent Vigil Counterweight");
  assert.equal(ruleset.rules.some((rule: any) => rule.type === "required_status_checks"), true);
});

test("counterweight validates authority inputs and preserves reviewed files unless forced", () => {
  const fixture = repo();
  assert.match(runCaptured(["counterweight", "--help"]).stdout, /Counterweight/);
  assert.equal(runQuiet(["counterweight"]), 2);
  assert.equal(runQuiet(["counterweight", "apply"]), 2);
  assert.equal(runQuiet(["counterweight", "install", "--repo", fixture.path, "--owner-repo", "bad", "--action-sha", ACTION_SHA]), 2);
  assert.equal(runQuiet(["counterweight", "install", "--repo", fixture.path, "--owner-repo", "example/project", "--action-sha", "abc"]), 2);
  assert.equal(runQuiet(["counterweight", "install", "--repo", fixture.path, "--owner-repo", "example/project", "--action-sha", ACTION_SHA, "--check-name", "bad\nname"]), 2);
  assert.equal(runQuiet(["counterweight", "install", "--repo", join(fixture.path, "missing"), "--owner-repo", "example/project", "--action-sha", ACTION_SHA]), 2);

  git(fixture.path, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  assert.equal(runQuiet(["counterweight", "install", "--repo", fixture.path, "--action-sha", ACTION_SHA, "--check-name", "Agent Vigil Counterweight"]), 0);
  const workflow = join(fixture.path, ".github/workflows/agent-vigil-counterweight.yml");
  const first = readFileSync(workflow, "utf8");
  assert.equal(runQuiet(["counterweight", "install", "--repo", fixture.path, "--action-sha", "1111111111111111111111111111111111111111", "--check-name", "Renamed Check"]), 0);
  assert.equal(readFileSync(workflow, "utf8"), first);
  assert.equal(runQuiet(["counterweight", "install", "--repo", fixture.path, "--action-sha", "1111111111111111111111111111111111111111", "--check-name", "Renamed Check", "--force"]), 0);
  assert.match(readFileSync(workflow, "utf8"), /name: Renamed Check/);
});

test("blast-radius compares declared scope to actual effects", () => {
  const fixture = repo();
  const intent = join(fixture.path, "intent.json");
  const output = join(fixture.path, "blast.json");
  writeFileSync(intent, JSON.stringify({ operation: "edit source", declaredScope: { paths: ["src.js"] }, attestedAt: "2026-09-03T00:00:00.000Z" }));
  assert.equal(runQuiet(["blast-radius", "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--intent", intent, "--output", output]), 0);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.actualEffect.changedPaths.includes("src.js"), true);
});

test("blast-radius separates missing scope, out-of-scope edits, destructive tokens, and bad intent", () => {
  const fixture = repo();
  const noIntent = join(fixture.path, "blast-no-intent.json");
  assert.equal(runQuiet(["blast-radius", "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--output", noIntent]), 1);
  const noIntentReceipt = JSON.parse(readFileSync(noIntent, "utf8"));
  assert.equal(noIntentReceipt.status, "BLOCK");
  assert.ok(noIntentReceipt.checks.some((check: any) => check.id === "pre-action-scope-attestation" && check.status === "HOLD"));

  const globIntent = join(fixture.path, "glob-intent.json");
  const globOutput = join(fixture.path, "glob-blast.md");
  writeFileSync(globIntent, JSON.stringify({ declaredScope: { paths: ["*.js"], services: ["agent-vigil"], environment: "test" } }));
  assert.equal(runQuiet(["blast-radius", "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--intent", globIntent, "--format", "markdown", "--output", globOutput]), 0);
  assert.match(readFileSync(globOutput, "utf8"), /Status: \*\*PASS\*\*/);

  writeFileSync(join(fixture.path, "ops.sh"), "rm -rf /tmp/agent-vigil-fixture\n");
  git(fixture.path, ["add", "ops.sh"]);
  git(fixture.path, ["commit", "-qm", "destructive"]);
  const destructiveHead = git(fixture.path, ["rev-parse", "HEAD"]);
  const destructiveIntent = join(fixture.path, "destructive-intent.json");
  const destructiveOutput = join(fixture.path, "destructive-blast.json");
  writeFileSync(destructiveIntent, JSON.stringify({ declaredScope: { paths: ["src.js", "ops.sh"] } }));
  assert.equal(runQuiet(["blast-radius", "--repo", fixture.path, "--base", fixture.base, "--head", destructiveHead, "--intent", destructiveIntent, "--json", "--output", destructiveOutput]), 2);
  assert.ok(JSON.parse(readFileSync(destructiveOutput, "utf8")).checks.some((check: any) => check.id === "destructive-effect-scan" && check.status === "HOLD"));

  const badIntent = join(fixture.path, "bad-intent.json");
  writeFileSync(badIntent, "[]");
  assert.equal(runQuiet(["blast-radius", "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--intent", badIntent]), 2);
  writeFileSync(badIntent, JSON.stringify({ declaredScope: { paths: [""] } }));
  assert.equal(runQuiet(["blast-radius", "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--intent", badIntent]), 2);
  assert.equal(runQuiet(["blast-radius", "extra", "--repo", fixture.path]), 2);
  assert.match(runCaptured(["blast-radius", "--help"]).stdout, /Blast-Radius/);
});

test("taxonomy command emits stable VIGIL identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-taxonomy-"));
  const output = join(root, "taxonomy.json");
  assert.equal(runQuiet(["taxonomy", "--format", "json", "--output", output]), 0);
  const taxonomy = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(taxonomy.entries[0].id, "VIGIL-001");
  assert.ok(taxonomy.entries.some((entry: any) => entry.id === "VIGIL-002" && entry.catches.includes("denominator-shrink-4966")));
  const markdown = join(root, "taxonomy.md");
  assert.equal(runQuiet(["taxonomy", "--output", markdown]), 0);
  assert.match(readFileSync(markdown, "utf8"), /## VIGIL-004 verifier-bypass/);
  assert.equal(runQuiet(["taxonomy", "--format", "xml"]), 2);
  assert.equal(runQuiet(["taxonomy", "extra"]), 2);
});

test("vault and corpus exports validate receipts, packs, and privacy labels", () => {
  const fixture = repo();
  const transcript = writeCodexTranscript(
    fixture.path,
    "node --test test.js",
    "# tests 1\n# pass 1\n# fail 0\n",
    "The test suite passes.",
  );
  const receiptPath = join(fixture.path, "pass-receipt.json");
  assert.equal(runQuiet(["watch", transcript, "--repo", fixture.path, "--base", fixture.base, "--head", fixture.head, "--test-cmd", "node --test test.js", "--output", receiptPath, "--format", "json"]), 0);

  const exportJson = join(fixture.path, "all-pack.json");
  assert.equal(runQuiet(["vault", "export", receiptPath, "--pack", "all", "--json", "--output", exportJson]), 0);
  const pack = JSON.parse(readFileSync(exportJson, "utf8"));
  assert.equal(pack.receipt.status, "PASS");
  assert.ok(pack.mappings.some((item: any) => item.control === "FINRA 3110 full chain"));

  const exportMarkdown = join(fixture.path, "insurer-pack.md");
  assert.equal(runQuiet(["vault", "export", receiptPath, "--pack", "insurer", "--format", "markdown", "--output", exportMarkdown]), 0);
  assert.match(readFileSync(exportMarkdown, "utf8"), /represented-process pack/);
  assert.equal(runQuiet(["vault", "export", receiptPath, "--pack", "unknown"]), 2);
  assert.equal(runQuiet(["vault"]), 2);
  assert.equal(runQuiet(["vault", "export"]), 2);
  assert.match(runCaptured(["vault", "--help"]).stdout, /Evidence Vault/);

  const corpus = join(fixture.path, "corpus.json");
  assert.equal(runQuiet(["corpus", "signature", receiptPath, "--model", "fixture", "--harness", "node-test", "--format", "json", "--output", corpus]), 0);
  const signature = JSON.parse(readFileSync(corpus, "utf8"));
  assert.equal(signature.privacy.repositoryIncluded, false);
  assert.equal(signature.ruleIds.length, 0);
  assert.equal(runQuiet(["corpus"]), 2);
  assert.equal(runQuiet(["corpus", "signature", receiptPath, "--model", "fixture"]), 2);
  assert.equal(runQuiet(["corpus", "signature", receiptPath, "--model", "bad\nmodel", "--harness", "node-test"]), 2);
  assert.equal(runQuiet(["corpus", "signature", receiptPath, "--model", "fixture", "--harness", "node-test", "--format", "markdown"]), 2);
  assert.match(runCaptured(["corpus", "--help"]).stdout, /cheat-signature/);
});

test("static integrity catches workflow edits and xfail markers", () => {
  const workflowChecks = checkIntegrityDiff([
    "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
    "--- a/.github/workflows/ci.yml",
    "+++ b/.github/workflows/ci.yml",
    "@@ -1 +1 @@",
    "-run: npm test",
    "+run: npm test",
  ].join("\n"));
  assert.ok(workflowChecks.some((item) => item.ruleId === "ci-workflow-edited"));

  const xfailChecks = checkIntegrityDiff([
    "diff --git a/tests/test_example.py b/tests/test_example.py",
    "--- a/tests/test_example.py",
    "+++ b/tests/test_example.py",
    "@@ -0,0 +1,3 @@",
    "+import pytest",
    "+@pytest.mark.xfail",
    "+def test_regression(): assert run() == 'fixed'",
  ].join("\n"));
  assert.ok(xfailChecks.some((item) => item.ruleId === "test-skip-added"));
});
