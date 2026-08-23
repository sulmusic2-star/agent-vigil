import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorityContractTemplate,
  buildAuthorityChecks,
  classifyTranscriptActions,
  loadAuthorityContract,
  splitShellCommands,
  validateAuthorityContract,
  type AuthorityContract,
} from "../src/authority.ts";
import { loadTranscript } from "../src/transcript.ts";
import { run } from "../src/cli.ts";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(options: { headPath?: string; headContent?: string; transcript?: unknown[]; contract?: Partial<AuthorityContract> } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "vigil-authority-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "vigil@example.test"]);
  git(repo, ["config", "user.name", "Vigil Test"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "src", "value.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, "test", "value.test.ts"), "// base\n");
  const contract: AuthorityContract = {
    schemaVersion: 1,
    taskId: "AV-42",
    allowedChangePaths: ["src/**", "test/**"],
    deniedChangePaths: [".github/**", ".env*"],
    allowedActions: ["repository_read", "repository_write", "test_execute", "build_execute"],
    requireCompleteToolResults: true,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...options.contract,
  };
  writeFileSync(join(repo, ".agent-vigil-authority.json"), `${JSON.stringify(contract, null, 2)}\n`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const headPath = options.headPath ?? "src/value.ts";
  mkdirSync(join(repo, headPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(repo, headPath), options.headContent ?? "export const value = 2;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "head"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const transcriptPath = join(repo, ".agent-session.jsonl");
  const rows = options.transcript ?? [
    { type: "session_meta", payload: { id: "session-1" } },
    { type: "response_item", payload: { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: JSON.stringify({ exit_code: 0, output: "" }) } },
    { type: "response_item", payload: { type: "function_call", call_id: "write", name: "apply_patch", arguments: "patch" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "write", output: "Done" } },
    { type: "response_item", payload: { type: "function_call", call_id: "test", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "test", output: JSON.stringify({ exit_code: 0, output: "pass" }) } },
  ];
  writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { repo, base, head, transcriptPath, contractPath: ".agent-vigil-authority.json" };
}

test("authority contract rejects unknown fields, traversal, and unsupported actions", () => {
  assert.throws(() => validateAuthorityContract({ schemaVersion: 1, taskId: "x", allowedChangePaths: ["src/**"], allowedActions: [], surprise: true }), /unknown field/);
  assert.throws(() => validateAuthorityContract({ schemaVersion: 1, taskId: "x", allowedChangePaths: ["../**"], allowedActions: [] }), /inside the repository/);
  assert.throws(() => validateAuthorityContract({ schemaVersion: 1, taskId: "x", allowedChangePaths: ["src/**"], allowedActions: ["magic"] }), /unsupported action/);
  assert.throws(() => validateAuthorityContract({ schemaVersion: 1, taskId: "x", allowedChangePaths: ["src/**"], allowedActions: [], maxToolCalls: -1 }), /non-negative safe integer/);
  assert.throws(() => validateAuthorityContract({ schemaVersion: 1, taskId: "x", allowedChangePaths: ["src/**"], allowedActions: [], maxObservedTokens: 1.5 }), /non-negative safe integer/);
  assert.throws(() => validateAuthorityContract({ schemaVersion: 1, taskId: "x", allowedChangePaths: ["src/**"], allowedActions: [], maxIdenticalToolCalls: -1 }), /non-negative safe integer/);
});

test("shell splitting handles compounds while preserving quoted separators", () => {
  assert.deepEqual(splitShellCommands("git status && npm test; echo 'a|b' & git push"), ["git status", "npm test", "echo 'a|b'", "git push"]);
  assert.deepEqual(splitShellCommands("printf \"x;y\" | cat"), ["printf \"x;y\"", "cat"]);
});

test("cross-agent transcript actions classify dangerous side effects", () => {
  const fx = fixture({ transcript: [
    { type: "session_meta", payload: { id: "s" } },
    { type: "response_item", payload: { type: "function_call", call_id: "x", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test && git push && gh release create v1" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "x", output: JSON.stringify({ exit_code: 0 }) } },
  ] });
  const actions = classifyTranscriptActions(loadTranscript(fx.transcriptPath));
  assert.deepEqual(new Set(actions[0].classes), new Set(["test_execute", "git_push", "release_publish"]));
});

test("classifier covers the high-risk commercial action taxonomy", () => {
  const commands = [
    ["install", "npm install left-pad"],
    ["delete", "rm -rf build"],
    ["commit", "git commit -m change"],
    ["pr", "gh pr create --title change"],
    ["release", "gh release create v2"],
    ["deploy", "vercel --prod"],
    ["fetch", "curl https://example.test/data"],
    ["post", "curl -X POST https://example.test/data"],
    ["secret", "cat .env"],
  ];
  const rows: any[] = [{ type: "session_meta", payload: { id: "s" } }];
  for (const [id, cmd] of commands) {
    rows.push({ type: "response_item", payload: { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd }) } });
    rows.push({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: JSON.stringify({ exit_code: 0 }) } });
  }
  for (const [id, name] of [["task", "create_thread"], ["mail", "send_email"], ["web", "web_search"]]) {
    rows.push({ type: "response_item", payload: { type: "function_call", call_id: id, name, arguments: "{}" } });
    rows.push({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: "ok" } });
  }
  const fx = fixture({ transcript: rows });
  const classes = new Set(classifyTranscriptActions(loadTranscript(fx.transcriptPath)).flatMap((action) => action.classes));
  for (const expected of ["dependency_install", "destructive_filesystem", "git_commit", "pull_request_write", "release_publish", "deploy", "network_read", "external_write", "credential_access", "task_create"] as const) {
    assert.equal(classes.has(expected), true, expected);
  }
});

test("allowed paths and observed actions pass", () => {
  const fx = fixture();
  const contract = loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value;
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), contract);
  assert.equal(checked.results.some((item) => item.verdict !== "verified"), false);
  assert.equal(checked.actions.length, 3);
});

test("predeclared trajectory budgets pass, fail, and fail closed when token usage is unavailable", () => {
  const rows = [
    { type: "session_meta", payload: { id: "session-1" } },
    { type: "response_item", payload: { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: JSON.stringify({ exit_code: 1, output: "failed" }) } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } } } },
  ];
  const fx = fixture({ transcript: rows, contract: { maxToolCalls: 1, maxFailedToolCalls: 1, maxObservedTokens: 100 } });
  const loaded = loadTranscript(fx.transcriptPath);
  const contract = loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value;
  const passing = buildAuthorityChecks(fx.repo, fx.base, fx.head, loaded, contract);
  for (const ruleId of ["tool-call-budget", "failed-tool-call-budget", "observed-token-budget"]) {
    assert.equal(passing.results.find((item) => item.ruleId === ruleId)?.verdict, "verified");
  }

  const exceeded = buildAuthorityChecks(fx.repo, fx.base, fx.head, loaded, { ...contract, maxToolCalls: 0, maxFailedToolCalls: 0, maxObservedTokens: 99 });
  for (const ruleId of ["tool-call-budget", "failed-tool-call-budget", "observed-token-budget"]) {
    assert.equal(exceeded.results.find((item) => item.ruleId === ruleId)?.verdict, "contradicted");
  }

  const unavailable = buildAuthorityChecks(fx.repo, fx.base, fx.head, { ...loaded, usage: undefined }, contract);
  const tokenBudget = unavailable.results.find((item) => item.ruleId === "observed-token-budget");
  assert.equal(tokenBudget?.verdict, "unverifiable");
  assert.equal(tokenBudget?.blocksPass, true);
});

test("trajectory controls detect exact repeated failures and high token spend without observed progress", () => {
  const rows: any[] = [{ type: "session_meta", payload: { id: "session-1" } }];
  for (let index = 0; index < 3; index += 1) {
    rows.push({ type: "response_item", payload: { type: "function_call", call_id: `read-${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) } });
    rows.push({ type: "response_item", payload: { type: "function_call_output", call_id: `read-${index}`, output: JSON.stringify({ exit_code: 1, output: "failed" }) } });
  }
  rows.push({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } } });
  const fx = fixture({ transcript: rows, contract: {
    allowedActions: ["repository_read"], maxIdenticalToolCalls: 2,
    maxConsecutiveFailedToolCalls: 2, maxTokensWithoutObservedProgress: 100,
  } });
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value);
  for (const ruleId of ["identical-tool-call-budget", "consecutive-failure-budget", "no-progress-token-budget"]) {
    assert.equal(checked.results.find((item) => item.ruleId === ruleId)?.verdict, "contradicted");
  }
  assert.equal(checked.actions[0].identitySha256, checked.actions[1].identitySha256);
  assert.match(checked.actions[0].identitySha256, /^sha256:[a-f0-9]{64}$/);
});

test("out-of-scope repository path fails", () => {
  const fx = fixture({ headPath: ".github/workflows/release.yml", headContent: "name: surprise\n" });
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value);
  const scope = checked.results.find((item) => item.ruleId === "authorized-change-paths");
  assert.equal(scope?.verdict, "contradicted");
  assert.match(scope?.evidence ?? "", /\.github\/workflows\/release\.yml/);
});

test("observed git push fails when task did not authorize it", () => {
  const fx = fixture({ transcript: [
    { type: "session_meta", payload: { id: "s" } },
    { type: "response_item", payload: { type: "function_call", call_id: "push", name: "exec_command", arguments: JSON.stringify({ cmd: "git push origin HEAD" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "push", output: JSON.stringify({ exit_code: 0 }) } },
  ] });
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value);
  const actions = checked.results.find((item) => item.ruleId === "authorized-action-classes");
  assert.equal(actions?.verdict, "contradicted");
  assert.match(actions?.evidence ?? "", /git_push/);
});

test("missing tool result is INCONCLUSIVE evidence", () => {
  const fx = fixture({ transcript: [
    { type: "session_meta", payload: { id: "s" } },
    { type: "response_item", payload: { type: "function_call", call_id: "test", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) } },
  ] });
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value);
  assert.equal(checked.results.find((item) => item.ruleId === "complete-tool-results")?.verdict, "unverifiable");
});

test("allowing unknown effects still blocks a trustworthy pass", () => {
  const fx = fixture({
    contract: { allowedActions: ["unknown_effect"] },
    transcript: [
      { type: "session_meta", payload: { id: "s" } },
      { type: "response_item", payload: { type: "function_call", call_id: "mystery", name: "custom_magic", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "mystery", output: "ok" } },
    ],
  });
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value);
  assert.equal(checked.results.find((item) => item.ruleId === "unknown-action-risk")?.blocksPass, true);
});

test("expired task authority fails closed", () => {
  const fx = fixture({ contract: { expiresAt: "2020-01-01T00:00:00Z" } });
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value);
  assert.equal(checked.results.find((item) => item.ruleId === "authority-validity")?.verdict, "contradicted");
});

test("base-anchored contract ignores candidate attempt to widen authority", () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, fx.contractPath), JSON.stringify({
    schemaVersion: 1,
    taskId: "tampered",
    allowedChangePaths: ["**"],
    allowedActions: ["git_push", "release_publish", "deploy", "external_write", "unknown_effect"],
  }));
  const loaded = loadAuthorityContract(fx.repo, fx.contractPath, fx.base);
  assert.equal(loaded.value.taskId, "AV-42");
  assert.equal(loaded.value.allowedActions.includes("git_push"), false);
});

test("narrative-only transcript cannot prove action boundaries", () => {
  const fx = fixture();
  const markdown = join(fx.repo, "summary.md");
  writeFileSync(markdown, "Everything stayed within scope.\n");
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(markdown), loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value);
  assert.equal(checked.results.find((item) => item.ruleId === "observed-action-coverage")?.blocksPass, true);
});

test("authority CLI emits PASS JSON and SARIF from a base-anchored contract", () => {
  const fx = fixture();
  const report = join(tmpdir(), `authority-report-${Date.now()}.json`);
  const sarif = join(tmpdir(), `authority-report-${Date.now()}.sarif`);
  const exit = run(["authority", fx.transcriptPath, "--contract", fx.contractPath, "--contract-ref", fx.base, "--repo", fx.repo, "--base", fx.base, "--head", fx.head, "--output", report, "--sarif", sarif, "--format", "json"]);
  assert.equal(exit, 0);
  const parsed = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(parsed.summary.status, "PASS");
  assert.equal(parsed.transcriptFormat, "authority/codex");
  assert.equal(JSON.parse(readFileSync(sarif, "utf8")).version, "2.1.0");
});

test("composite Action routes authority mode with a base-anchored contract", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const fx = fixture();
  const event = join(mkdtempSync(join(tmpdir(), "vigil-authority-event-")), "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: fx.base }, head: { sha: fx.head } } }));
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  const block = action.match(/      run: \|\n([\s\S]*?)\n    - id: prepare_attestation/)?.[1];
  assert.ok(block);
  const aux = mkdtempSync(join(tmpdir(), "vigil-action-authority-"));
  const script = join(aux, "run.sh");
  const output = join(aux, "output");
  const summary = join(aux, "summary");
  const runnerPath = join(aux, "runner");
  writeFileSync(script, block.split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n"));
  writeFileSync(output, "");
  writeFileSync(summary, "");
  mkdirSync(runnerPath);
  const runner = realpathSync(runnerPath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: process.cwd(), GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: runner,
    VIGIL_TRANSCRIPT: fx.transcriptPath, VIGIL_RECEIPT: "", VIGIL_MODE: "",
    VIGIL_AUTHORITY_CONTRACT: fx.contractPath, VIGIL_AUTHORITY_CONTRACT_REF: fx.base,
    VIGIL_REPO: fx.repo, VIGIL_BASE: fx.base, VIGIL_HEAD: fx.head, VIGIL_TEST_CMD: "",
    VIGIL_POLICY: ".agent-vigil.json", VIGIL_POLICY_REF: fx.base, VIGIL_STRICT: "true", VIGIL_MIN_VERIFIED: "1",
  };
  // The base fixture has no ordinary policy file; the authority PR path does
  // not consume it. Keep event trust checks inactive for that unused input.
  env.VIGIL_POLICY = "";
  env.VIGIL_POLICY_REF = "";
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const completed = spawnSync("bash", [script], { cwd: fx.repo, encoding: "utf8", env });
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  const outputs = readFileSync(output, "utf8");
  assert.match(outputs, /^status=PASS$/m);
  assert.match(outputs, /^value_card=.+agent-vigil-value-card\.json$/m);
  assert.match(outputs, /^github_evidence=.+agent-vigil-github-evidence\.json$/m);
  const outputPath = (name: string): string => {
    const path = new RegExp(`^${name}=(.+)$`, "m").exec(outputs)?.[1];
    assert.ok(path);
    assert.ok(path.startsWith(`${runner}/`));
    return path;
  };
  assert.equal(JSON.parse(readFileSync(outputPath("report"), "utf8")).transcriptFormat, "authority/codex");
  assert.equal(JSON.parse(readFileSync(outputPath("value_card"), "utf8")).schemaVersion, "agent-vigil-value-card/v1");
  assert.equal(JSON.parse(readFileSync(outputPath("github_evidence"), "utf8")).schemaVersion, "agent-vigil-github-evidence/v1");
});

test("authority init emits a conservative valid template", () => {
  const template = JSON.parse(authorityContractTemplate());
  assert.equal(validateAuthorityContract(template).schemaVersion, 1);
  assert.equal(template.allowedActions.includes("git_push"), false);
  assert.equal(template.allowedActions.includes("deploy"), false);
});

test("authority CLI supports local self-asserted contracts and init output without overstating trust", () => {
  const fx = fixture();
  const report = join(tmpdir(), `authority-local-${Date.now()}.json`);
  assert.equal(run(["authority", fx.transcriptPath, "--contract", fx.contractPath, "--repo", fx.repo, "--base", fx.base, "--head", fx.head, "--output", report]), 0);
  const parsed = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(parsed.summary.status, "PASS");
  assert.ok(parsed.advisories.some((item: any) => item.ruleId === "authority-contract-anchor"));
  const output = join(tmpdir(), `authority-template-${Date.now()}.json`);
  assert.equal(run(["authority", "init", "--output", output]), 0);
  assert.equal(validateAuthorityContract(JSON.parse(readFileSync(output, "utf8"))).schemaVersion, 1);
});

test("authority contract can omit expiry and result completeness but records the limit", () => {
  const fx = fixture({ contract: { expiresAt: undefined, requireCompleteToolResults: false } });
  const contract = loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value;
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), contract);
  assert.equal(checked.results.find((item) => item.ruleId === "authority-validity")?.verdict, "unverifiable");
  assert.equal(checked.results.some((item) => item.ruleId === "complete-tool-results"), false);
});
