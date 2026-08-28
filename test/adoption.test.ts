import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../src/config.ts";
import { renderMarkdown, remediationFor } from "../src/output.ts";
import { buildReport, canonical, type CheckResult } from "../src/report.ts";
import { generateSigningKey, publicKeyId, signReport, verifyReport } from "../src/signature.ts";
import { createPortableReceipt, verifyPortableReceipt } from "../src/portable.ts";
import { doctorRepository, initRepository } from "../src/setup.ts";
import { loadTranscript } from "../src/transcript.ts";
import { checkTestsPass } from "../src/detectors/reality.ts";

const ACTION_SHA = "a".repeat(40);

test("the Agent Vigil package declares its bounded direct hosted test command", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.agentVigil?.hostedTestCommand, "node --test --test-concurrency=4 test/*.test.ts");
});

function temp(prefix = "vigil-adoption-") { return mkdtempSync(join(tmpdir(), prefix)); }
function jsonl(rows: unknown[], name = "session.jsonl"): string {
  const path = join(temp(), name);
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return path;
}
function repo(): string {
  const path = temp("vigil-init-");
  execFileSync("git", ["init", "-q"], { cwd: path });
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  return path;
}
function plainRepo(): string {
  const path = temp("vigil-plain-");
  execFileSync("git", ["init", "-q"], { cwd: path });
  return path;
}
function commitAll(path: string, message = "fixture"): void {
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: path });
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync("git", ["commit", "-qm", message], { cwd: path });
}

test("the Agent Vigil package's hosted override survives init and committed doctor checks", () => {
  const path = plainRepo();
  writeFileSync(join(path, "package.json"), readFileSync(new URL("../package.json", import.meta.url)));
  writeFileSync(join(path, "package-lock.json"), readFileSync(new URL("../package-lock.json", import.meta.url)));
  mkdirSync(join(path, "test"));
  writeFileSync(join(path, "test/self.test.ts"), 'import { test } from "node:test";\ntest("self", () => {});\n');
  initRepository(path, false, undefined, "default", false, ACTION_SHA);
  assert.equal(JSON.parse(readFileSync(join(path, ".agent-vigil.json"), "utf8")).testCommand, "node --test --test-concurrency=4 test/*.test.ts");
  commitAll(path, "Agent Vigil hosted self-contract");
  const checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Candidate isolation" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Fresh verification" && check.status === "PASS"));
});

test("detects Cursor stream JSON and correlates tools", () => {
  const path = jsonl([
    { type: "system", subtype: "init", session_id: "s" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I ran " }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "npm test." }] } },
    { type: "tool_call", subtype: "started", call_id: "c", tool_call: { shellToolCall: { args: { command: "npm test" } } } },
    { type: "tool_call", subtype: "completed", call_id: "c", tool_call: { shellToolCall: { result: { success: { output: "ok" } } } } },
    { type: "result", subtype: "success", result: "I ran npm test." },
  ]);
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "cursor");
  assert.equal(loaded.narrative, "I ran npm test.");
  assert.equal(loaded.toolCalls[0].name, "shell");
  assert.match(loaded.toolCalls[0].input, /npm test/);
  assert.equal(loaded.toolCalls[0].isError, false);
});

test("correlates Cursor tool rows when call IDs are absent", () => {
  const path = jsonl([
    { type: "system", subtype: "init", session_id: "s" },
    { type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "npm test" } } } },
    { type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { result: "ok" } } },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const loaded = loadTranscript(path);
  assert.equal(loaded.toolCalls[0].output, "ok");
});

test("Claude system init does not collide with Cursor detection", () => {
  const path = jsonl([
    { type: "system", subtype: "init", session_id: "s" },
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
  ]);
  assert.equal(loadTranscript(path).format, "claude-code");
});

test("detects Gemini CLI stream JSON and failed tools", () => {
  const path = jsonl([
    { type: "init", timestamp: "2026-01-01T00:00:00Z", session_id: "s", model: "gemini" },
    { type: "message", timestamp: "2026-01-01T00:00:01Z", role: "assistant", content: "I ran npm test." },
    { type: "tool_use", timestamp: "2026-01-01T00:00:02Z", tool_name: "run_shell_command", tool_id: "g", parameters: { command: "npm test" } },
    { type: "tool_result", timestamp: "2026-01-01T00:00:03Z", tool_id: "g", status: "error", error: { type: "x", message: "failed" } },
    { type: "result", timestamp: "2026-01-01T00:00:04Z", status: "error" },
  ]);
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "gemini-cli");
  assert.equal(loaded.toolCalls[0].name, "run_shell_command");
  assert.equal(loaded.toolCalls[0].isError, true);
});

test("detects GitHub Copilot CLI event logs", () => {
  const path = jsonl([
    { id: "1", type: "assistant.message", timestamp: "2026-01-01T00:00:00Z", data: { content: "I ran npm test." } },
    { id: "2", type: "tool.execution_start", timestamp: "2026-01-01T00:00:01Z", data: { toolCallId: "x", toolName: "bash", arguments: { command: "npm test" } } },
    { id: "3", type: "tool.execution_complete", timestamp: "2026-01-01T00:00:02Z", data: { toolCallId: "x", success: true, result: "ok" } },
    { id: "4", type: "session.idle", timestamp: "2026-01-01T00:00:03Z", data: { aborted: false } },
  ]);
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "github-copilot-cli");
  assert.equal(loaded.toolCalls[0].name, "bash");
  assert.equal(loaded.toolCalls[0].isError, false);
});

test("detects OpenCode JSON exports", () => {
  const path = join(temp(), "opencode.json");
  writeFileSync(path, JSON.stringify({
    info: { id: "s" },
    messages: [{ info: { role: "assistant" }, parts: [
      { type: "text", text: "I ran npm test." },
      { id: "p", callID: "o", type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "ok" } },
    ] }],
  }));
  const loaded = loadTranscript(path);
  assert.equal(loaded.format, "opencode");
  assert.equal(loaded.toolCalls[0].name, "bash");
  assert.equal(loaded.toolCalls[0].isError, false);
});

test("invalid OpenCode tool timestamps do not abort the adapter", () => {
  const path = join(temp(), "opencode.json");
  writeFileSync(path, JSON.stringify({ info: { id: "s" }, messages: [{ info: { role: "assistant" }, parts: [
    { type: "tool", tool: "bash", callID: "x", time: { start: "not-a-date" }, state: { status: "completed", output: "ok" } },
  ] }] }));
  assert.equal(loadTranscript(path).toolCalls[0].timestamp, undefined);
});

test("detects Aider chat history by its documented filename", () => {
  const path = join(temp(), ".aider.chat.history.md");
  writeFileSync(path, "The test suite passes.\n");
  assert.equal(loadTranscript(path).format, "aider");
});

test("rejects unknown JSON object transcripts", () => {
  const path = join(temp(), "unknown.json");
  writeFileSync(path, JSON.stringify({ mystery: true }));
  assert.throws(() => loadTranscript(path), /unrecognized JSON transcript schema/);
});

test("policy hashing is canonical across JSON key order", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"strict":true,"minVerified":2}');
  const first = loadPolicy(path).sha256;
  writeFileSync(join(path, ".agent-vigil.json"), '{"minVerified":2,"strict":true,"schemaVersion":1}');
  assert.equal(loadPolicy(path).sha256, first);
});

test("policy rejects unknown fields instead of silently ignoring them", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"magicPass":true}');
  assert.throws(() => loadPolicy(path), /unknown field/);
});

test("policy validates the static integrity enforcement mode", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"integrityMode":"advisory"}');
  assert.equal(loadPolicy(path).value.integrityMode, "advisory");
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"integrityMode":"magic"}');
  assert.throws(() => loadPolicy(path), /integrityMode must be advisory, calibrated, or blocking/);
});

test("policy can be anchored to a trusted Git ref", () => {
  const path = repo();
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: path });
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"strict":true}');
  execFileSync("git", ["add", "-A"], { cwd: path });
  execFileSync("git", ["commit", "-qm", "policy"], { cwd: path });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"strict":false}');
  const loaded = loadPolicy(path, ".agent-vigil.json", base);
  assert.equal(loaded.value.strict, true);
  assert.equal(loaded.ref, base);
});

test("an empty zero-exit command cannot substantiate a test claim", () => {
  const path = repo();
  const claim = { kind: "tests_pass" as const, quote: "tests pass", subject: "test suite" };
  const result = checkTestsPass([claim], path, "true")[0];
  assert.equal(result.verdict, "unverifiable");
  assert.match(result.evidence, /no supported test summary/);
});

test("init creates a policy, evidence placeholder, and isolated base-selected workflow", () => {
  const path = repo();
  const result = initRepository(path, false, undefined, "default", false, ACTION_SHA);
  assert.equal(result.created.length, 5);
  const workflow = readFileSync(join(path, ".github/workflows/agent-vigil.yml"), "utf8");
  const outcomes = readFileSync(join(path, ".github/workflows/agent-vigil-outcomes.yml"), "utf8");
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /pull_request\.base\.sha/);
  assert.match(workflow, /pull_request\.head\.sha/);
  assert.doesNotMatch(workflow, /merge_group:/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /allow-unsafe-pr-checkout: true/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /isolate-candidate: true/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, new RegExp(`uses: sulmusic2-star/agent-vigil@${ACTION_SHA}`));
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /node-version: 22/);
  assert.doesNotMatch(workflow, /github-token:|attest: true|id-token: write|attestations: write|artifact-metadata: write/);
  assert.match(outcomes, /workflow_run:/);
  assert.match(outcomes, /workflow_run\.event == 'pull_request_target'/);
  assert.doesNotMatch(outcomes, /^\s+pull_request_target:/m);
  assert.doesNotMatch(outcomes, /HEAD_SHA|event=pull_request_target|types: \[closed\]/);
  assert.match(outcomes, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(outcomes, new RegExp(`uses: sulmusic2-star/agent-vigil@${ACTION_SHA}`));
  assert.match(outcomes, /mode: outcome/);
  assert.doesNotMatch(outcomes, /actions\/checkout/);
  assert.doesNotMatch(outcomes, /attest: true|id-token: write|attestations: write|artifact-metadata: write/);
  assert.match(readFileSync(join(path, ".agent-vigil.json"), "utf8"), /node --test/);
  assert.match(readFileSync(join(path, ".agent-vigil.json"), "utf8"), /"integrityMode": "advisory"/);
  for (const generated of [workflow, outcomes]) {
    for (const match of generated.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
      assert.match(match[1], /@[0-9a-f]{40}$/, `${match[1]} must be immutable`);
    }
  }
});

test("hosted init requires one exact lowercase Agent Vigil runtime SHA", () => {
  for (const actionSha of [undefined, "v0.20.0", "A".repeat(40), "a".repeat(39)]) {
    const path = repo();
    assert.throws(
      () => initRepository(path, false, undefined, "default", false, actionSha),
      /requires an exact lowercase 40-hex Agent Vigil Action SHA/,
    );
    assert.equal(existsSync(join(path, ".github/workflows/agent-vigil.yml")), false);
  }
});

test("hosted init fails closed for unsupported package-manager layouts", () => {
  for (const lockfile of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    const path = repo();
    writeFileSync(join(path, lockfile), "unsupported\n");
    assert.throws(() => initRepository(path, false, undefined, "default", false, ACTION_SHA), new RegExp(`does not support root ${lockfile.replace(".", "\\.")}`));
  }

  for (const packageManager of ["pnpm@9.0.0", "yarn@4.0.0", "bun@1.0.0", "deno@2.0.0", 17]) {
    const path = repo();
    writeFileSync(join(path, "package.json"), JSON.stringify({ packageManager, scripts: { test: "node --test" } }));
    assert.throws(() => initRepository(path, false, undefined, "default", false, ACTION_SHA), /requires packageManager to select npm/);
  }

  const nested = temp("vigil-nested-");
  execFileSync("git", ["init", "-q"], { cwd: nested });
  mkdirSync(join(nested, "packages", "api"), { recursive: true });
  writeFileSync(join(nested, "packages", "api", "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.throws(() => initRepository(nested, false, undefined, "default", false, ACTION_SHA), /does not support a nested package\.json-only layout/);

  const lockWithoutPackage = temp("vigil-lock-only-");
  execFileSync("git", ["init", "-q"], { cwd: lockWithoutPackage });
  writeFileSync(join(lockWithoutPackage, "package-lock.json"), '{"lockfileVersion":3}\n');
  assert.throws(() => initRepository(lockWithoutPackage, false, undefined, "default", false, ACTION_SHA), /requires a root package\.json beside an npm lockfile/);

  const python = temp("vigil-python-");
  execFileSync("git", ["init", "-q"], { cwd: python });
  writeFileSync(join(python, "pyproject.toml"), "[project]\nname = 'outside-hosted-contract'\n");
  assert.throws(() => initRepository(python, false, undefined, "default", false, ACTION_SHA), /supports Node\/npm repositories/);

  const unlockedDependencies = repo();
  writeFileSync(join(unlockedDependencies, "package.json"), JSON.stringify({
    scripts: { test: "jest" },
    devDependencies: { jest: "30.0.0" },
  }));
  assert.throws(
    () => initRepository(unlockedDependencies, false, undefined, "default", false, ACTION_SHA),
    /requires package-lock\.json or npm-shrinkwrap\.json when root package\.json declares dependencies or workspaces/,
  );
  assert.equal(existsSync(join(unlockedDependencies, ".github/workflows/agent-vigil.yml")), false);

  for (const malformed of [
    { dependencies: "left-pad" },
    { devDependencies: ["jest"] },
    { optionalDependencies: { package: 17 } },
    { bundledDependencies: "package" },
    { workspaces: "packages/*" },
  ]) {
    const path = repo();
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, ...malformed }));
    assert.throws(
      () => initRepository(path, false, undefined, "default", false, ACTION_SHA),
      /requires package\.json (?:dependencies|devDependencies|optionalDependencies|bundledDependencies|workspaces)/,
    );
    assert.equal(existsSync(join(path, ".github/workflows/agent-vigil.yml")), false);
  }

  const submodule = repo();
  writeFileSync(join(submodule, "gitlink-object"), "gitlink fixture\n");
  const object = execFileSync("git", ["hash-object", "-w", "gitlink-object"], { cwd: submodule, encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${object},vendor/tool`], { cwd: submodule });
  assert.throws(
    () => initRepository(submodule, false, undefined, "default", false, ACTION_SHA),
    /does not support Git submodules or gitlinks \(vendor\/tool\)/,
  );
  assert.equal(existsSync(join(submodule, ".github/workflows/agent-vigil.yml")), false);
});

test("hosted init refuses ignored setup inputs but permits a visible first-commit transition", () => {
  for (const [ignoredPath, content] of [
    ["package.json", JSON.stringify({ scripts: { test: "node --test" } })],
    ["package-lock.json", '{"lockfileVersion":3}\n'],
    ["pyproject.toml", "[project]\nname = 'ignored-toolchain'\n"],
    ["vitest.config.ts", "export default {};\n"],
  ]) {
    const path = plainRepo();
    writeFileSync(join(path, ".gitignore"), `${ignoredPath}\n`);
    writeFileSync(join(path, ignoredPath), content);
    assert.throws(
      () => initRepository(path, false, undefined, "default", false, ACTION_SHA),
      new RegExp(`ignored setup input\\(s\\).*${ignoredPath.replace(".", "\\.")}`),
    );
    assert.equal(existsSync(join(path, ".github/workflows/agent-vigil.yml")), false);
  }

  const transition = repo();
  writeFileSync(join(transition, "package-lock.json"), '{"lockfileVersion":3}\n');
  initRepository(transition, false, undefined, "default", false, ACTION_SHA);
  let hosted = doctorRepository(transition).find((check) => check.label === "Hosted repository contract");
  assert.equal(hosted?.status, "FAIL");
  assert.match(hosted?.detail ?? "", /requires a committed HEAD/);

  commitAll(transition, "commit setup inputs and generated workflow");
  hosted = doctorRepository(transition).find((check) => check.label === "Hosted repository contract");
  assert.equal(hosted?.status, "PASS");
  assert.match(hosted?.detail ?? "", /base-owned npm ci --ignore-scripts/);

  const ignoredDependencies = repo();
  writeFileSync(join(ignoredDependencies, ".gitignore"), "node_modules/\n");
  mkdirSync(join(ignoredDependencies, "node_modules", "dependency"), { recursive: true });
  writeFileSync(join(ignoredDependencies, "node_modules", "dependency", "package.json"), JSON.stringify({ name: "dependency" }));
  writeFileSync(join(ignoredDependencies, "node_modules", "dependency", ".npmrc"), "registry=https://registry.example.invalid/\n");
  assert.doesNotThrow(() => initRepository(ignoredDependencies, false, undefined, "default", false, ACTION_SHA));
  commitAll(ignoredDependencies, "hosted setup with ignored dependency cache");
  hosted = doctorRepository(ignoredDependencies).find((check) => check.label === "Hosted repository contract");
  assert.equal(hosted?.status, "PASS");

  const npmConfig = repo();
  writeFileSync(join(npmConfig, ".npmrc"), "registry=https://registry.example.invalid/\n");
  assert.throws(
    () => initRepository(npmConfig, false, undefined, "default", false, ACTION_SHA),
    /does not support repository \.npmrc/,
  );
  const nestedNpmConfig = repo();
  mkdirSync(join(nestedNpmConfig, "packages", "api"), { recursive: true });
  writeFileSync(join(nestedNpmConfig, "packages", "api", ".npmrc"), "registry=https://registry.example.invalid/\n");
  assert.throws(
    () => initRepository(nestedNpmConfig, false, undefined, "default", false, ACTION_SHA),
    /does not support repository \.npmrc \(packages\/api\/\.npmrc\)/,
  );

  const ignoredNestedNpmConfig = repo();
  writeFileSync(join(ignoredNestedNpmConfig, ".gitignore"), "packages/\n");
  mkdirSync(join(ignoredNestedNpmConfig, "packages", "api"), { recursive: true });
  writeFileSync(join(ignoredNestedNpmConfig, "packages", "api", ".npmrc"), "registry=https://registry.example.invalid/\n");
  assert.throws(
    () => initRepository(ignoredNestedNpmConfig, false, undefined, "default", false, ACTION_SHA),
    /ignored setup input\(s\).*packages\/api\/\.npmrc/,
  );
});

test("hosted init expands only conservative direct test-runner scripts", () => {
  for (const script of [
    "jest",
    "npm test",
    "npx tsx --test test/*.test.ts",
    "tsx --test test/*.test.ts",
    "node ./scripts/test.js",
    "node --import ./hook.mjs --test",
    "node --test --test-reporter=dot",
    "node --test --test-concurrency=257",
    "node --test --test-timeout=3600001",
    "node --test *.test.js",
    "node --test scripts/forged-runner.js",
    "node --test package.json",
    "node --test ../outside.test.js",
    "node --test /tmp/outside.test.js",
    "node --test && echo forged",
    "NODE_OPTIONS=--import=./hook.mjs node --test",
    "node --test > forged.tap",
  ]) {
    const path = repo();
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: script } }));
    assert.throws(
      () => initRepository(path, false, undefined, "default", false, ACTION_SHA),
      /generated hosted workflow (?:supports only|rejects|requires)/,
      script,
    );
    assert.equal(existsSync(join(path, ".github/workflows/agent-vigil.yml")), false);
  }

  const node = repo();
  writeFileSync(join(node, "package.json"), JSON.stringify({ scripts: { test: "node --test --test-reporter=tap --test-concurrency=4 --test-timeout=5000 test/*.test.js" } }));
  initRepository(node, false, undefined, "default", false, ACTION_SHA);
  assert.equal(
    JSON.parse(readFileSync(join(node, ".agent-vigil.json"), "utf8")).testCommand,
    "node --test --test-reporter=tap --test-concurrency=4 --test-timeout=5000 test/*.test.js",
  );

  const tsx = repo();
  writeFileSync(join(tsx, "package.json"), JSON.stringify({
    scripts: { test: "tsx --test test/*.test.ts" },
    devDependencies: { tsx: "4.20.5" },
  }));
  writeFileSync(join(tsx, "package-lock.json"), '{"lockfileVersion":3}\n');
  assert.throws(
    () => initRepository(tsx, false, undefined, "default", false, ACTION_SHA),
    /supports only direct `node --test` commands/,
  );
  assert.equal(existsSync(join(tsx, ".github/workflows/agent-vigil.yml")), false);

  const explicit = repo();
  writeFileSync(join(explicit, "package.json"), JSON.stringify({
    scripts: { test: "tsx --test test/*.test.ts" },
    agentVigil: { hostedTestCommand: "node --test test/*.test.ts" },
    devDependencies: { tsx: "4.20.5" },
  }));
  writeFileSync(join(explicit, "package-lock.json"), '{"lockfileVersion":3}\n');
  initRepository(explicit, false, undefined, "default", false, ACTION_SHA);
  assert.equal(JSON.parse(readFileSync(join(explicit, ".agent-vigil.json"), "utf8")).testCommand, "node --test test/*.test.ts");
  commitAll(explicit, "base-owned hosted test override");
  assert.ok(doctorRepository(explicit).some((check) => check.label === "Candidate isolation" && check.status === "PASS"));

  for (const hostedTestCommand of ["tsx --test test/*.test.ts", "npm test", "node --test *.test.ts", 17]) {
    const unsafeOverride = repo();
    writeFileSync(join(unsafeOverride, "package.json"), JSON.stringify({
      scripts: { test: "node --test" },
      agentVigil: { hostedTestCommand },
    }));
    assert.throws(
      () => initRepository(unsafeOverride, false, undefined, "default", false, ACTION_SHA),
      /agentVigil\.hostedTestCommand.*direct `node --test`/,
    );
  }

  const policyDrift = repo();
  initRepository(policyDrift, false, undefined, "default", false, ACTION_SHA);
  commitAll(policyDrift, "direct runner baseline");
  const policyPath = join(policyDrift, ".agent-vigil.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  policy.testCommand = "npm test --silent";
  writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  commitAll(policyDrift, "unsafe hosted policy command");
  const policyCheck = doctorRepository(policyDrift).find((check) => check.label === "Policy");
  assert.equal(policyCheck?.status, "FAIL");
  assert.match(policyCheck?.detail ?? "", /must equal the exact hosted direct-runner command "node --test"/);
});

test("doctor fails when setup-relevant worktree or ignored inputs differ from committed HEAD", () => {
  const modifiedPackage = repo();
  writeFileSync(join(modifiedPackage, "package-lock.json"), '{"lockfileVersion":3}\n');
  initRepository(modifiedPackage, false, undefined, "default", false, ACTION_SHA);
  commitAll(modifiedPackage, "baseline hosted setup");
  writeFileSync(join(modifiedPackage, "package.json"), JSON.stringify({
    scripts: { test: "node --test" },
    description: "uncommitted setup drift",
  }));
  let hosted = doctorRepository(modifiedPackage).find((check) => check.label === "Hosted repository contract");
  assert.equal(hosted?.status, "FAIL");
  assert.match(hosted?.detail ?? "", /not identical to committed HEAD: package\.json/);

  const ignoredToolchain = plainRepo();
  initRepository(ignoredToolchain, false, undefined, "default", false, ACTION_SHA);
  writeFileSync(join(ignoredToolchain, ".gitignore"), "pyproject.toml\n");
  commitAll(ignoredToolchain, "baseline plain hosted setup");
  writeFileSync(join(ignoredToolchain, "pyproject.toml"), "[project]\nname = 'ignored-drift'\n");
  hosted = doctorRepository(ignoredToolchain).find((check) => check.label === "Hosted repository contract");
  assert.equal(hosted?.status, "FAIL");
  assert.match(hosted?.detail ?? "", /not identical to committed HEAD: pyproject\.toml/);
});

test("init preserves existing policy unless force is explicit", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), "custom\n");
  const result = initRepository(path, false, undefined, "default", false, ACTION_SHA);
  assert.ok(result.kept.includes(".agent-vigil.json"));
  assert.equal(readFileSync(join(path, ".agent-vigil.json"), "utf8"), "custom\n");
  initRepository(path, true, undefined, "default", false, ACTION_SHA);
  assert.match(readFileSync(join(path, ".agent-vigil.json"), "utf8"), /schemaVersion/);
});

test("init refuses scaffold ancestor and leaf symlinks without writing outside the repository", () => {
  if (process.platform === "win32") return;
  for (const parentPath of [".github", ".agent-vigil"]) {
    const path = repo();
    const outside = temp("vigil-scaffold-outside-");
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched\n");
    symlinkSync(outside, join(path, parentPath));
    assert.throws(
      () => initRepository(path, false, undefined, "default", false, ACTION_SHA),
      new RegExp(`scaffold parent ${parentPath.replace(".", "\\.")} must be a non-symlink directory`),
    );
    assert.equal(readFileSync(sentinel, "utf8"), "untouched\n");
    assert.equal(existsSync(join(outside, "session.md")), false);
    assert.equal(existsSync(join(outside, "workflows", "agent-vigil.yml")), false);
  }

  const leaf = repo();
  const outside = temp("vigil-scaffold-leaf-");
  const sentinel = join(outside, "policy.json");
  writeFileSync(sentinel, "untouched\n");
  symlinkSync(sentinel, join(leaf, ".agent-vigil.json"));
  assert.throws(
    () => initRepository(leaf, true, undefined, "default", false, ACTION_SHA),
    /scaffold target \.agent-vigil\.json must be a regular non-symlink single-link file/,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "untouched\n");

  const hardlink = repo();
  const hardlinkOutside = temp("vigil-scaffold-hardlink-");
  const hardlinkSentinel = join(hardlinkOutside, "policy.json");
  writeFileSync(hardlinkSentinel, "untouched\n");
  linkSync(hardlinkSentinel, join(hardlink, ".agent-vigil.json"));
  assert.throws(
    () => initRepository(hardlink, true, undefined, "default", false, ACTION_SHA),
    /scaffold target \.agent-vigil\.json must be a regular non-symlink single-link file/,
  );
  assert.equal(readFileSync(hardlinkSentinel, "utf8"), "untouched\n");
});

test("maintainer init creates a base-anchored evidence gate and retained receipt artifact", () => {
  const path = repo();
  writeFileSync(join(path, "package-lock.json"), '{"lockfileVersion":3}\n');
  const result = initRepository(path, false, undefined, "maintainer", false, ACTION_SHA);
  assert.equal(result.created.length, 4);
  const policy = JSON.parse(readFileSync(join(path, ".agent-vigil.json"), "utf8"));
  const workflow = readFileSync(join(path, ".github/workflows/agent-vigil.yml"), "utf8");
  const template = readFileSync(join(path, ".github/pull_request_template.md"), "utf8");
  assert.equal(policy.maintainer.reviewMode, "automated");
  assert.equal(policy.maintainer.requireHumanAttestation, false);
  assert.deepEqual(policy.maintainer.automatedReview.commands, ["node --test"]);
  assert.equal(policy.maintainer.automatedReview.setupCommand, "npm ci --ignore-scripts");
  assert.equal(policy.maintainer.differentialTest.overlayChangedTests, true);
  assert.match(workflow, /mode: maintainer/);
  assert.doesNotMatch(workflow, /name: Install dependencies for fresh verification|^\s*-\s+run:\s+npm ci/m);
  assert.match(workflow, /isolate-candidate: true/);
  assert.match(workflow, /candidate-setup-cmd: npm ci --ignore-scripts/);
  assert.match(workflow, /name: agent-vigil-receipt/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/);
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /merge_group:/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /pull-requests: read/);
  assert.doesNotMatch(workflow, /github-token:|attest: true|id-token: write|attestations: write|artifact-metadata: write/);
  assert.match(workflow, /steps\.vigil\.outputs\.value-card/);
  assert.match(workflow, /steps\.vigil\.outputs\.github-evidence/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(template, /Responsible human|I reviewed every changed line|I can explain and maintain/);
  assert.match(template, /one-shot candidate-only containers over\s+a private exact-commit clone/);
  commitAll(path, "maintainer hosted setup");
  const doctor = doctorRepository(path);
  assert.ok(doctor.some((check) => check.label === "Review mode" && check.status === "PASS" && /candidate-only containers/.test(check.detail)));
  writeFileSync(join(path, ".github/pull_request_template.md"), `${template}\n`);
  const drifted = doctorRepository(path);
  assert.ok(drifted.some((check) => check.label === "Pull request evidence" && check.status === "FAIL" && /not identical to committed HEAD/.test(check.detail)));
});

test("Action accepts exactly one evidence mode", () => {
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  const strictInput = action.match(/^  strict:\n(?:    .*\n)*/m)?.[0] ?? "";
  const minimumInput = action.match(/^  min-verified:\n(?:    .*\n)*/m)?.[0] ?? "";
  assert.match(strictInput, /^  strict:/);
  assert.match(minimumInput, /^  min-verified:/);
  assert.doesNotMatch(strictInput, /^\s+default:/m);
  assert.doesNotMatch(minimumInput, /^\s+default:/m);
  assert.match(action, /if \[\[ "\$VIGIL_STRICT" == "true" \]\]; then args\+=\(--strict\); fi/);
  assert.match(action, /if \[\[ -n "\$VIGIL_MIN_VERIFIED" \]\]; then args\+=\(--min-verified "\$VIGIL_MIN_VERIFIED"\); fi/);
  assert.match(action, /VIGIL_RECEIPT/);
  assert.match(action, /VIGIL_AUTHORITY_CONTRACT/);
  assert.match(action, /choose exactly one check input or named mode/);
  assert.match(action, /mode must be plan, prove, maintainer, outcome, or continuity/);
  assert.match(action, /continuity mode requires a readable continuity-chain directory/);
  assert.match(action, /args=\(continuity status --chain "\$VIGIL_CONTINUITY_CHAIN"/);
  assert.match(action, /inputs\.mode != 'continuity'/);
  assert.match(action, /args=\(plan --repo "\$VIGIL_REPO" --base "\$VIGIL_BASE" --head "\$VIGIL_HEAD"/);
  assert.match(action, /prove mode cannot be combined with another evidence input/);
  assert.match(action, /args=\(prove --repo "\$VIGIL_REPO" --base "\$VIGIL_HEAD" --format json/);
  assert.match(action, /attest-control "\$VIGIL_REPORT"/);
  assert.match(action, /control-proof-predicate-v1\.schema\.json/);
  assert.match(action, /receipt mode requires a base-anchored policy/);
  assert.match(action, /args=\(authority "\$VIGIL_TRANSCRIPT"/);
  assert.match(action, /authority-contract-ref must equal GitHub event base/);
  assert.match(action, /args=\(gate "\$VIGIL_RECEIPT"/);
  assert.match(action, /if \[\[ "\$event_kind" != "pull_request"/);
  assert.match(action, /GITHUB_EVENT_NAME:-}" != "pull_request_target"/);
  assert.match(action, /candidate verification requires a bounded GitHub pull_request event with full commit IDs/);
  assert.doesNotMatch(action, /args=\(merge-group --event/);
  assert.match(action, /echo "sarif=\$sarif_path"/);
  assert.match(action, /github-evidence --event/);
  assert.match(action, /value "\$report_file"/);
  assert.match(action, /echo "value_card=\$value_card_path"/);
  assert.match(action, /echo "value_verdict=\$value_verdict"/);
  assert.match(action, /echo "github_evidence=\$github_evidence_path"/);
  assert.match(action, /outcome mode requires a full outcome receipt path/);
  assert.match(action, /outcome receipt must be one bounded regular JSON file/);
  assert.match(action, /outcome-receipt and actions-run-id are restricted to outcome mode/);
  assert.match(action, /continuity-chain is restricted to continuity mode/);
  assert.match(action, /actions\/runs\/\$run_id\/jobs/);
  assert.doesNotMatch(action, /gh api[^\n]*--slurp[^\n]*--jq/);
  assert.match(action, /gh api --paginate[^\n]+\| jq -s 'add'/);
});

test("doctor validates the generated installation", () => {
  const path = repo();
  initRepository(path, false, undefined, "default", false, ACTION_SHA);
  commitAll(path, "generated installation");
  const checks = doctorRepository(path);
  assert.equal(checks.some((check) => check.status === "FAIL"), false);
  assert.ok(checks.some((check) => check.label === "Git range" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Policy trust" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Merge queue" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Transcript" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Workflow trigger" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Candidate isolation" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Credential boundary" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Action pins" && check.status === "PASS"));
  assert.ok(checks.some((check) => check.label === "Outcome isolation" && check.status === "PASS"));
});

test("doctor does not validate live security inputs that differ from committed HEAD", () => {
  const path = repo();
  initRepository(path, false, undefined, "default", false, ACTION_SHA);
  commitAll(path, "committed doctor inputs");

  for (const [input, failingLabel] of [
    [".agent-vigil.json", "Policy"],
    [".agent-vigil/session.md", "Transcript"],
    [".github/workflows/agent-vigil.yml", "GitHub Action"],
    [".github/workflows/agent-vigil-outcomes.yml", "Outcome observer"],
  ]) {
    const absolute = join(path, input);
    const original = readFileSync(absolute, "utf8");
    writeFileSync(absolute, `${original}\n`);
    const checks = doctorRepository(path);
    assert.ok(checks.some((check) => check.label === failingLabel && check.status === "FAIL" && /not identical to committed HEAD/.test(check.detail)), input);
    writeFileSync(absolute, original);
  }

  for (const [input, failingLabel] of [
    [".github/workflows/agent-vigil.yml", "GitHub Action"],
    [".github/workflows/agent-vigil-outcomes.yml", "Outcome observer"],
  ]) {
    const absolute = join(path, input);
    const original = readFileSync(absolute);
    unlinkSync(absolute);
    const checks = doctorRepository(path);
    assert.ok(checks.some((check) => check.label === failingLabel && check.status === "FAIL" && /missing or unsafe/.test(check.detail)), input);
    writeFileSync(absolute, original);
  }

  writeFileSync(join(path, "other-policy.json"), readFileSync(join(path, ".agent-vigil.json")));
  writeFileSync(join(path, "other-transcript.md"), "alternate local evidence\n");
  commitAll(path, "alternate local doctor inputs");
  let overridden = doctorRepository(path, "other-policy.json", "other-transcript.md");
  assert.ok(overridden.some((check) => check.label === "Policy" && check.status === "FAIL" && /does not match hosted workflow input/.test(check.detail)));
  assert.ok(overridden.some((check) => check.label === "Transcript" && check.status === "FAIL" && /does not match hosted workflow input/.test(check.detail)));
  const actualTranscript = join(path, ".agent-vigil", "session.md");
  const actualTranscriptBytes = readFileSync(actualTranscript);
  unlinkSync(actualTranscript);
  overridden = doctorRepository(path, "other-policy.json", "other-transcript.md");
  assert.ok(overridden.some((check) => check.label === "Transcript" && check.status === "FAIL" && /missing or unsafe/.test(check.detail)));
  writeFileSync(actualTranscript, actualTranscriptBytes);
  const hostedPolicyPath = join(path, ".agent-vigil.json");
  const hostedPolicy = JSON.parse(readFileSync(hostedPolicyPath, "utf8"));
  hostedPolicy.transcript = "other-transcript.md";
  writeFileSync(hostedPolicyPath, JSON.stringify(hostedPolicy, null, 2));
  commitAll(path, "mismatched hosted transcript policy");
  overridden = doctorRepository(path);
  assert.ok(overridden.some((check) => check.label === "Policy" && check.status === "FAIL" && /policy transcript must equal hosted workflow input/.test(check.detail)));

  for (const [removedInput, failingLabel] of [
    [".github/workflows/agent-vigil.yml", "GitHub Action"],
    [".github/workflows/agent-vigil-outcomes.yml", "Outcome observer"],
  ]) {
    const removed = repo();
    initRepository(removed, false, undefined, "default", false, ACTION_SHA);
    commitAll(removed, "complete generated installation");
    execFileSync("git", ["rm", "-q", "--", removedInput], { cwd: removed });
    commitAll(removed, `remove ${removedInput}`);
    const removedChecks = doctorRepository(removed);
    assert.ok(removedChecks.some((check) => check.label === failingLabel && check.status === "FAIL" && /missing/.test(check.detail)), removedInput);
  }

  const partial = repo();
  initRepository(partial, false, undefined, "default", false, ACTION_SHA);
  commitAll(partial, "complete generated installation");
  execFileSync("git", ["rm", "-q", "--", ".github/workflows/agent-vigil.yml", ".github/workflows/agent-vigil-outcomes.yml", ".agent-vigil/session.md"], { cwd: partial });
  commitAll(partial, "remove generated execution inputs");
  const partialChecks = doctorRepository(partial);
  assert.ok(partialChecks.some((check) => check.label === "GitHub Action" && check.status === "FAIL" && /missing/.test(check.detail)));
  assert.ok(partialChecks.some((check) => check.label === "Outcome observer" && check.status === "FAIL" && /missing/.test(check.detail)));
  assert.ok(partialChecks.some((check) => check.label === "Transcript" && check.status === "FAIL" && /absent from committed HEAD/.test(check.detail)));

  const portable = repo();
  initRepository(portable, false, `sha256:${"a".repeat(64)}`, "default", false, ACTION_SHA);
  commitAll(portable, "portable scaffold without receipt");
  const portablePolicyPath = join(portable, ".agent-vigil.json");
  const portablePolicyText = readFileSync(portablePolicyPath, "utf8");
  const portablePolicy = JSON.parse(portablePolicyText);
  portablePolicy.portableReceipt = ".agent-vigil/other.json";
  writeFileSync(portablePolicyPath, JSON.stringify(portablePolicy, null, 2));
  commitAll(portable, "mismatched hosted portable policy");
  let portableChecks = doctorRepository(portable);
  assert.ok(portableChecks.some((check) => check.label === "Policy" && check.status === "FAIL" && /policy portableReceipt must equal hosted workflow input/.test(check.detail)));
  writeFileSync(portablePolicyPath, portablePolicyText);
  commitAll(portable, "restore hosted portable policy");
  let receipt = doctorRepository(portable).find((check) => check.label === "Portable receipt");
  assert.equal(receipt?.status, "FAIL");
  assert.match(receipt?.detail ?? "", /absent from committed HEAD/);
  mkdirSync(join(portable, ".agent-vigil"), { recursive: true });
  writeFileSync(join(portable, ".agent-vigil", "receipt.json"), "{}\n");
  receipt = doctorRepository(portable).find((check) => check.label === "Portable receipt");
  assert.equal(receipt?.status, "FAIL");
  assert.match(receipt?.detail ?? "", /absent from committed HEAD/);
});

test("doctor reads committed control inputs through bounded regular-file snapshots", () => {
  const path = repo();
  initRepository(path, false, undefined, "default", false, ACTION_SHA);
  commitAll(path, "committed doctor snapshot inputs");
  const transcriptPath = join(path, ".agent-vigil", "session.md");
  const original = readFileSync(transcriptPath);
  const expectUnsafeTranscript = (detail: RegExp) => {
    const checks = doctorRepository(path);
    const transcript = checks.find((check) => check.label === "Transcript");
    assert.equal(transcript?.status, "FAIL");
    assert.match(transcript?.detail ?? "", detail);
    assert.ok(checks.some((check) => check.label === "Candidate isolation" && check.status === "FAIL"));
  };

  if (process.platform !== "win32") {
    unlinkSync(transcriptPath);
    symlinkSync("../../package.json", transcriptPath);
    expectUnsafeTranscript(/missing or unsafe.*(?:symbolic link|too many levels)/i);
    unlinkSync(transcriptPath);
    writeFileSync(transcriptPath, original);
  }

  writeFileSync(transcriptPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  expectUnsafeTranscript(/missing or unsafe.*exceeds 16 MiB/i);
  writeFileSync(transcriptPath, original);

  if (process.platform !== "win32") {
    unlinkSync(transcriptPath);
    execFileSync("mkfifo", [transcriptPath]);
    expectUnsafeTranscript(/missing or unsafe.*not a regular file/i);
    unlinkSync(transcriptPath);
    writeFileSync(transcriptPath, original);
  }
});

test("doctor rejects unsupported hosted repository drift without hiding local inference", () => {
  const expectUnsupported = (path: string, detail: RegExp) => {
    const checks = doctorRepository(path);
    const hosted = checks.find((check) => check.label === "Hosted repository contract");
    const isolation = checks.find((check) => check.label === "Candidate isolation");
    assert.equal(hosted?.status, "FAIL");
    assert.match(hosted?.detail ?? "", detail);
    assert.equal(isolation?.status, "FAIL");
    assert.equal(checks.some((check) => check.label === "Candidate isolation" && check.status === "PASS"), false);
  };

  for (const [marker, content] of [
    ["pyproject.toml", "[project]\nname = 'python-drift'\n"],
    ["Cargo.toml", "[package]\nname = 'rust-drift'\n"],
  ]) {
    const path = plainRepo();
    initRepository(path, false, undefined, "default", false, ACTION_SHA);
    commitAll(path, "plain hosted baseline");
    writeFileSync(join(path, marker), content);
    expectUnsupported(path, new RegExp(`not identical to committed HEAD: ${marker.replace(".", "\\.")}`));
    const fresh = doctorRepository(path).find((check) => check.label === "Fresh verification");
    assert.equal(fresh?.status, "PASS");
    assert.match(fresh?.detail ?? "", marker === "pyproject.toml" ? /python3 -m pytest -q/ : /cargo test --quiet/);
  }

  for (const lockfile of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    const path = repo();
    initRepository(path, false, undefined, "default", false, ACTION_SHA);
    commitAll(path, "npm hosted baseline");
    writeFileSync(join(path, lockfile), "unsupported\n");
    expectUnsupported(path, new RegExp(`not identical to committed HEAD: ${lockfile.replace(".", "\\.")}`));
  }

  for (const packageManager of ["pnpm@9.0.0", "yarn@4.0.0", "bun@1.0.0", "npm@", 17]) {
    const path = repo();
    initRepository(path, false, undefined, "default", false, ACTION_SHA);
    commitAll(path, "npm hosted baseline");
    writeFileSync(join(path, "package.json"), JSON.stringify({ packageManager, scripts: { test: "node --test" } }));
    expectUnsupported(path, /not identical to committed HEAD: package\.json/);
  }

  const nested = plainRepo();
  initRepository(nested, false, undefined, "default", false, ACTION_SHA);
  commitAll(nested, "plain hosted baseline");
  mkdirSync(join(nested, "packages", "api"), { recursive: true });
  writeFileSync(join(nested, "packages", "api", "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  expectUnsupported(nested, /not identical to committed HEAD: packages\/api\/package\.json/);

  const unlockedDependencies = repo();
  initRepository(unlockedDependencies, false, undefined, "default", false, ACTION_SHA);
  commitAll(unlockedDependencies, "npm hosted baseline");
  writeFileSync(join(unlockedDependencies, "package.json"), JSON.stringify({
    scripts: { test: "jest" },
    devDependencies: { jest: "30.0.0" },
  }));
  expectUnsupported(unlockedDependencies, /not identical to committed HEAD: package\.json/);

  const malformedDependencies = repo();
  initRepository(malformedDependencies, false, undefined, "default", false, ACTION_SHA);
  commitAll(malformedDependencies, "npm hosted baseline");
  writeFileSync(join(malformedDependencies, "package.json"), JSON.stringify({ scripts: { test: "node --test" }, dependencies: "left-pad" }));
  expectUnsupported(malformedDependencies, /not identical to committed HEAD: package\.json/);

  const npmConfig = repo();
  initRepository(npmConfig, false, undefined, "default", false, ACTION_SHA);
  commitAll(npmConfig, "npm hosted baseline");
  writeFileSync(join(npmConfig, ".npmrc"), "registry=https://registry.example.invalid/\n");
  commitAll(npmConfig, "unsupported npm config");
  expectUnsupported(npmConfig, /does not support repository \.npmrc/);

  if (process.platform !== "win32") {
    const linkedHarness = repo();
    initRepository(linkedHarness, false, undefined, "default", false, ACTION_SHA);
    commitAll(linkedHarness, "npm hosted baseline");
    symlinkSync("package.json", join(linkedHarness, "test.config.js"));
    commitAll(linkedHarness, "unsupported linked test harness");
    expectUnsupported(linkedHarness, /requires setup input test\.config\.js to be a regular Git file, not a symbolic link/);
  }

  const submodule = repo();
  initRepository(submodule, false, undefined, "default", false, ACTION_SHA);
  commitAll(submodule, "npm hosted baseline");
  writeFileSync(join(submodule, "gitlink-object"), "gitlink fixture\n");
  const object = execFileSync("git", ["hash-object", "-w", "gitlink-object"], { cwd: submodule, encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${object},vendor/tool`], { cwd: submodule });
  expectUnsupported(submodule, /does not support Git submodules or gitlinks \(vendor\/tool\)/);
});

test("doctor accepts supported plain and root npm hosted repository controls", () => {
  const plain = plainRepo();
  initRepository(plain, false, undefined, "default", false, ACTION_SHA);
  commitAll(plain, "plain hosted setup");

  const npm = repo();
  writeFileSync(join(npm, "package.json"), JSON.stringify({ packageManager: "npm@10.9.0", scripts: { test: "node --test" } }));
  writeFileSync(join(npm, "package-lock.json"), '{"lockfileVersion":3}\n');
  initRepository(npm, false, undefined, "default", false, ACTION_SHA);
  commitAll(npm, "npm hosted setup");

  for (const path of [plain, npm]) {
    const checks = doctorRepository(path);
    assert.ok(checks.some((check) => check.label === "Hosted repository contract" && check.status === "PASS"));
    assert.ok(checks.some((check) => check.label === "Candidate isolation" && check.status === "PASS"));
  }
});

test("doctor fails unsafe candidate privilege, checkout, isolation, and mutable-ref patterns", () => {
  const path = repo();
  initRepository(path, false, undefined, "default", false, ACTION_SHA);
  commitAll(path, "safe hosted setup");
  const evidencePath = join(path, ".github/workflows/agent-vigil.yml");
  const outcomePath = join(path, ".github/workflows/agent-vigil-outcomes.yml");
  const unsafeEvidence = readFileSync(evidencePath, "utf8")
    .replace("pull_request_target:", "pull_request:")
    .replace(/^\s+persist-credentials:\s*false\s*\n/m, "")
    .replace(/^\s+package-manager-cache:\s*false\s*\n/m, "")
    .replace(/^\s+isolate-candidate:\s*true\s*\n/m, "")
    .replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7")
    .replace("  pull-requests: read\n", "  pull-requests: read\n  id-token: write\n")
    .replace("        with:\n          transcript:", "        with:\n          attest: true\n          github-token: ${{ github.token }}\n          transcript:");
  const unsafeOutcome = readFileSync(outcomePath, "utf8")
    .replace(/actions\/download-artifact@[0-9a-f]{40}/, "actions/download-artifact@v5")
    .replace("  pull-requests: read\n", "  pull-requests: read\n  contents: write\n");
  writeFileSync(evidencePath, unsafeEvidence);
  writeFileSync(outcomePath, unsafeOutcome);
  const checks = doctorRepository(path);
  for (const label of ["Workflow trigger", "Candidate isolation", "Credential boundary", "Action pins", "Outcome isolation"]) {
    assert.ok(checks.some((check) => check.label === label && check.status === "FAIL"), label);
  }

  const splitRuntime = repo();
  initRepository(splitRuntime, false, undefined, "default", false, ACTION_SHA);
  commitAll(splitRuntime, "safe split-runtime baseline");
  const splitOutcomePath = join(splitRuntime, ".github/workflows/agent-vigil-outcomes.yml");
  writeFileSync(splitOutcomePath, readFileSync(splitOutcomePath, "utf8").replace(`agent-vigil@${ACTION_SHA}`, `agent-vigil@${"b".repeat(40)}`));
  assert.ok(doctorRepository(splitRuntime).some((check) => check.label === "Action pins" && check.status === "FAIL"));
});

test("doctor refuses an unreviewed or expired authority scaffold", () => {
  const path = repo();
  initRepository(path, false, undefined, "authority", false, ACTION_SHA);
  let checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Task authority" && check.status === "FAIL" && /committed HEAD/.test(check.detail)));
  commitAll(path, "authority scaffold");
  checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Task authority" && check.status === "FAIL" && /taskId/.test(check.detail)));
  assert.ok(checks.some((check) => check.label === "Transcript" && check.status === "FAIL" && /structured/.test(check.detail)));
  const contractPath = join(path, ".agent-vigil-authority.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.taskId = "SEC-142";
  contract.expiresAt = "2099-01-01T00:00:00.000Z";
  writeFileSync(contractPath, JSON.stringify(contract, null, 2));
  checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Task authority" && check.status === "FAIL" && /not identical to committed HEAD/.test(check.detail)));
  commitAll(path, "review authority contract");
  checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Task authority" && check.status === "PASS"));
});

function sampleReport() {
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict: "verified",
    evidence: "fresh command passed",
    ruleId: "tests-pass",
  };
  return buildReport({
    transcript: "session.md", transcriptSha256: `sha256:${"1".repeat(64)}`, transcriptFormat: "markdown",
    repo: ".", base: "a", head: "b", results: [result],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"2".repeat(64)}` },
    repository: { remote: "https://example.test/repo", tree: "c".repeat(40) },
    reproduction: "vigil session.md --base a --head b",
  });
}

test("signed receipts verify with embedded and pinned Ed25519 keys", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const report = signReport(sampleReport(), privateKey);
  assert.deepEqual(verifyReport(report), { hashValid: true, signatureValid: true, keyPinned: false, keyId: report.signature!.keyId });
  assert.deepEqual(verifyReport(report, publicKey), { hashValid: true, signatureValid: true, keyPinned: true, keyId: report.signature!.keyId });
});

test("receipt verification catches tampering after signing", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const report = signReport(sampleReport(), privateKey);
  report.results[0].evidence = "fabricated";
  const result = verifyReport(report, publicKey);
  assert.equal(result.hashValid, false);
  assert.equal(result.signatureValid, true);
});

test("receipt hash binds summary counts and status", () => {
  const report = sampleReport();
  report.summary.verified = 999;
  assert.throws(() => verifyReport(report), /summary\.verified does not match results and policy/);
});

test("pinned verification rejects the wrong public key", () => {
  const left = temp(); const right = temp();
  generateSigningKey(join(left, "private.pem"), join(left, "public.pem"));
  generateSigningKey(join(right, "private.pem"), join(right, "public.pem"));
  const report = signReport(sampleReport(), join(left, "private.pem"));
  assert.equal(verifyReport(report, join(right, "public.pem")).signatureValid, false);
});

test("portable receipt omits transcript text and detailed claim evidence", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const report = sampleReport();
  const receipt = createPortableReceipt(report, privateKey);
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /session\.md|fresh command passed|tests pass/);
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.hashValid, true);
  assert.equal(verified.signatureValid, true);
  assert.equal(verified.signerTrusted, true);
});

test("portable receipt signature binds status, Git identity, and policy", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  receipt.summary.status = "FAIL";
  receipt.summary.pass = false;
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.hashValid, false);
  assert.equal(verified.signatureValid, true);
});

test("portable receipt does not trust an unpinned embedded signer", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  const verified = verifyPortableReceipt(receipt, []);
  assert.equal(verified.signatureValid, true);
  assert.equal(verified.signerTrusted, false);
  assert.match(verified.errors.join(" "), /not pinned/);
});

test("portable receipt verification rejects malformed metadata and inconsistent summary", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  receipt.reportHash = "bad";
  receipt.repository.tree = "";
  receipt.summary.pass = false;
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.hashValid, false);
  assert.match(verified.errors.join(" "), /reportHash.*SHA-256/);
  assert.match(verified.errors.join(" "), /base, head, and repository tree/);
  assert.match(verified.errors.join(" "), /pass flag disagrees/);
});

test("portable receipt reports field errors separately from a matching payload hash", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  receipt.reportHash = "bad";
  const { portableHash: _portableHash, signature: _signature, ...payload } = receipt;
  receipt.portableHash = `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.hashValid, false);
  assert.match(verified.errors.join(" "), /reportHash.*SHA-256/);
  assert.doesNotMatch(verified.errors.join(" "), /portable receipt hash is invalid/);
});

test("portable receipt verification fails closed on an unreadable embedded key", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const receipt = createPortableReceipt(sampleReport(), privateKey);
  receipt.signature.publicKey = "not-base64";
  const verified = verifyPortableReceipt(receipt, [publicKeyId(publicKey)]);
  assert.equal(verified.signatureValid, false);
  assert.equal(verified.signerTrusted, false);
  assert.match(verified.errors.join(" "), /could not be read/);
});

test("portable sealing refuses a tampered full receipt", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const report = sampleReport();
  report.summary.verified = 999;
  assert.throws(() => createPortableReceipt(report, privateKey), /summary\.verified does not match results and policy/);
});

test("portable sealing refuses a report without a committed head tree", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict: "verified", evidence: "fresh command passed", ruleId: "tests-pass",
  };
  const report = buildReport({
    transcript: "session.md", transcriptSha256: `sha256:${"1".repeat(64)}`, transcriptFormat: "markdown",
    repo: ".", base: "a", head: "WORKTREE", results: [result],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"2".repeat(64)}` },
    repository: {}, reproduction: "vigil session.md --head WORKTREE",
  });
  assert.throws(() => createPortableReceipt(report, privateKey), /requires a committed head tree/);
});

test("portable sealing refuses unavailable transcript or policy digests", () => {
  const dir = temp(); const privateKey = join(dir, "private.pem"); const publicKey = join(dir, "public.pem");
  generateSigningKey(privateKey, publicKey);
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
    verdict: "verified", evidence: "fresh command passed", ruleId: "tests-pass",
  };
  const report = buildReport({
    transcript: "session.md", transcriptFormat: "markdown",
    repo: ".", base: "a", head: "b", results: [result],
    repository: { tree: "c".repeat(40) }, reproduction: "vigil session.md",
  });
  assert.equal(report.transcriptSha256, "sha256:unavailable");
  assert.equal(report.policy.sha256, "sha256:unavailable");
  assert.throws(() => createPortableReceipt(report, privateKey), /requires concrete transcript and policy SHA-256 identifiers/);
});

test("policy validates portable receipt paths and signer IDs", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), JSON.stringify({
    schemaVersion: 1,
    portableReceipt: ".agent-vigil/receipt.json",
    trustedSignerKeyIds: [`sha256:${"a".repeat(64)}`],
  }));
  assert.equal(loadPolicy(path).value.portableReceipt, ".agent-vigil/receipt.json");
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":"../receipt.json"}');
  assert.throws(() => loadPolicy(path), /inside the repository/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":"..\\\\receipt.json"}');
  assert.throws(() => loadPolicy(path), /inside the repository/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":"C:\\\\receipt.json"}');
  assert.throws(() => loadPolicy(path), /inside the repository/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"trustedSignerKeyIds":["bad"]}');
  assert.throws(() => loadPolicy(path), /SHA-256 key IDs/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"trustedSignerKeyIds":[]}');
  assert.throws(() => loadPolicy(path), /non-empty array/);
  writeFileSync(join(path, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, trustedSignerKeyIds: [`sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}`] }));
  assert.throws(() => loadPolicy(path), /duplicates/);
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":"/tmp/receipt.json"}');
  assert.throws(() => loadPolicy(path), /inside the repository/);
});

test("doctor fails portable mode without a pinned signer", () => {
  const path = repo();
  writeFileSync(join(path, ".agent-vigil.json"), '{"schemaVersion":1,"portableReceipt":".agent-vigil/receipt.json"}');
  commitAll(path, "portable policy without signer");
  const checks = doctorRepository(path);
  assert.ok(checks.some((check) => check.label === "Portable signer" && check.status === "FAIL"));
  assert.ok(checks.some((check) => check.label === "Portable receipt" && check.status === "WARN"));
});

test("failure output includes a concrete remediation", () => {
  assert.match(remediationFor("test-count"), /observed passing count/);
  const report = buildReport({
    transcript: "session.md",
    transcriptFormat: "markdown",
    repo: ".",
    base: "a",
    head: "b",
    results: [{
      claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" },
      verdict: "contradicted",
      evidence: "fresh command failed",
      ruleId: "tests-pass",
    }],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"2".repeat(64)}` },
  });
  const rendered = renderMarkdown(report);
  assert.match(rendered, /Checks that need attention/);
  assert.match(rendered, /Run `vigil doctor`/);
});
