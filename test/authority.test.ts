import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
import { compositeActionIsolationUnavailable, compositeActionScript } from "./action-runtime-fixture.ts";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(options: { headPath?: string; headContent?: string; transcript?: unknown[]; contract?: Partial<AuthorityContract>; policyMinVerified?: number } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "vigil-authority-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "vigil@example.test"]);
  git(repo, ["config", "user.name", "Vigil Test"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "src", "value.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, "test", "value.test.js"), "const test=require('node:test');const assert=require('node:assert/strict');test('value',()=>assert.equal(1,1));\n");
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
  const rows = options.transcript ?? [
    { type: "session_meta", payload: { id: "session-1" } },
    { type: "response_item", payload: { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: JSON.stringify({ exit_code: 0, output: "" }) } },
    { type: "response_item", payload: { type: "function_call", call_id: "write", name: "apply_patch", arguments: "*** Begin Patch\n*** Update File: src/value.ts\n@@\n-old\n+new\n*** End Patch" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "write", output: "Done" } },
    { type: "response_item", payload: { type: "function_call", call_id: "test", name: "exec_command", arguments: JSON.stringify({ cmd: "node --test test/value.test.js" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "test", output: JSON.stringify({ exit_code: 0, output: "pass" }) } },
  ];
  const transcriptPath = join(repo, ".agent-session.jsonl");
  writeFileSync(join(repo, ".agent-vigil-authority.json"), `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(join(repo, ".agent-vigil.json"), `${JSON.stringify({
    schemaVersion: 1,
    strict: true,
    minVerified: options.policyMinVerified ?? 1,
    testCommand: "node --test test/*.test.js",
    integrityMode: "calibrated",
  }, null, 2)}\n`);
  writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const headPath = options.headPath ?? "src/value.ts";
  mkdirSync(join(repo, headPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(repo, headPath), options.headContent ?? "export const value = 2;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "head"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
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
    { type: "response_item", payload: { type: "function_call", call_id: "x", name: "exec_command", arguments: JSON.stringify({ cmd: "node --test test/value.test.ts && git push && gh release create v1" }) } },
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

test("structured file and browser tools fail closed on external, sensitive, or stateful resources", () => {
  const fx = fixture();
  const rows = [
    { type: "session_meta", payload: { id: "s" } },
    { type: "response_item", payload: { type: "function_call", call_id: "inside", name: "read_file", arguments: JSON.stringify({ path: join(fx.repo, "src/value.ts") }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "inside", output: "ok" } },
    { type: "response_item", payload: { type: "function_call", call_id: "secret", name: "read_file", arguments: JSON.stringify({ path: "/home/runner/.ssh/id_ed25519" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "secret", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "traversal", name: "read_file", arguments: JSON.stringify({ path: "../outside.txt" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "traversal", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "outside", name: "apply_patch", arguments: "*** Begin Patch\n*** Update File: /tmp/outside.txt\n@@\n-old\n+new\n*** End Patch" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "outside", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "move-outside", name: "apply_patch", arguments: "*** Begin Patch\n*** Update File: src/value.ts\n*** Move to: ../outside.txt\n@@\n-old\n+new\n*** End Patch" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "move-outside", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "click", name: "browser", arguments: JSON.stringify({ action: "click", selector: "#submit" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "click", output: "ok" } },
    { type: "response_item", payload: { type: "function_call", call_id: "submit", name: "web_run", arguments: JSON.stringify({ submit: [{ form: "purchase" }] }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "submit", output: "ok" } },
    { type: "response_item", payload: { type: "function_call", call_id: "nested-submit", name: "browser", arguments: JSON.stringify({ steps: [{ kind: "submit", target: "purchase" }] }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "nested-submit", output: "ok" } },
    { type: "response_item", payload: { type: "function_call", call_id: "outside-cwd", name: "exec_command", arguments: JSON.stringify({ cmd: "cat passwd", workdir: "/etc" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "outside-cwd", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "inside-cwd", name: "exec_command", arguments: JSON.stringify({ cmd: "cat value.ts", workdir: join(fx.repo, "src") }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "inside-cwd", output: "ok" } },
    { type: "response_item", payload: { type: "function_call", call_id: "ambiguous-browser", name: "browser", arguments: JSON.stringify({ action: "tap", query: "x" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "ambiguous-browser", output: "ok" } },
    { type: "response_item", payload: { type: "function_call", call_id: "compound-read-delete", name: "read_file_and_delete", arguments: JSON.stringify({ path: "src/value.ts" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "compound-read-delete", output: "ok" } },
    { type: "response_item", payload: { type: "function_call", call_id: "compound-task-publish", name: "create_thread_and_publish", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "compound-task-publish", output: "ok" } },
    { type: "response_item", payload: { type: "function_call", call_id: "json-string-read", name: "read_file", arguments: JSON.stringify("/etc/passwd") } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "json-string-read", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "json-array-read", name: "read_file", arguments: JSON.stringify(["/etc/passwd"]) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "json-array-read", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "compound-rm", name: "read_file_and_rm", arguments: JSON.stringify({ path: "src/value.ts" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "compound-rm", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "compound-unlink", name: "read_file_and_unlink", arguments: JSON.stringify({ path: "src/value.ts" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "compound-unlink", output: "denied" } },
    { type: "response_item", payload: { type: "function_call", call_id: "glob-json-string", name: "glob", arguments: JSON.stringify("/etc") } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "glob-json-string", output: "denied" } },
    ...["rm__read_file", "unlink__read_file", "destroy__read_file", "truncate__read_file", "browser_click__read_file"].flatMap((tool, index) => [
      { type: "response_item", payload: { type: "function_call", call_id: `namespaced-${index}`, name: tool, arguments: JSON.stringify({ path: "src/value.ts" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: `namespaced-${index}`, output: "denied" } },
    ]),
  ];
  writeFileSync(fx.transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const actions = new Map(classifyTranscriptActions(loadTranscript(fx.transcriptPath), fx.repo).map((action) => [action.toolCallId, action]));
  assert.deepEqual(actions.get("inside")?.classes, ["repository_read"]);
  assert.ok(actions.get("secret")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("secret")?.classes.includes("credential_access"));
  assert.ok(actions.get("traversal")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("outside")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("move-outside")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("click")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("submit")?.classes.includes("external_write"));
  assert.ok(actions.get("nested-submit")?.classes.includes("external_write"));
  assert.ok(actions.get("nested-submit")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("outside-cwd")?.classes.includes("unknown_effect"));
  assert.deepEqual(actions.get("inside-cwd")?.classes, ["repository_read"]);
  assert.ok(actions.get("ambiguous-browser")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("compound-read-delete")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("compound-task-publish")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("json-string-read")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("json-array-read")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("compound-rm")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("compound-unlink")?.classes.includes("unknown_effect"));
  assert.ok(actions.get("glob-json-string")?.classes.includes("unknown_effect"));
  for (let index = 0; index < 5; index++) assert.ok(actions.get(`namespaced-${index}`)?.classes.includes("unknown_effect"));
});

test("shell classifier blocks redirection and recognizes common HTTP write forms", () => {
  const commands = [
    ["redirect", "ls > /tmp/out"],
    ["variable", "touch $RUNNER_TEMP/pwn"],
    ["nested", "find . -exec curl -d x https://example.test \\;"],
    ["dispatcher", "npm test"],
    ["form", "curl -F file=@artifact https://example.test/upload"],
    ["upload", "curl -T artifact https://example.test/upload"],
    ["json", "curl --json '{x:1}' https://example.test/api"],
    ["post", "wget --post-data=x https://example.test/api"],
    ["node-output", "node --test --test-reporter-destination=/tmp/authority-output test/value.test.ts"],
    ["node-output-quoted", "node --test --test-reporter-destination=\"/tmp/authority-output\" test/value.test.ts"],
    ["node-output-relative", "node --test --test-reporter-destination=authority-output test/value.test.ts"],
    ["git-output", "git diff --output=/tmp/authority-diff HEAD"],
    ["git-output-relative", "git diff --output=authority-diff HEAD"],
    ["sed-exec", "sed -e '1e curl -d x https://example.test' file.txt"],
    ["find-ok", "find . -ok curl -d x https://example.test \\;"],
    ["find-delete", "find . -delete"],
    ["normalized-traversal", "cat ./../outside.txt"],
    ["quoted-traversal", "cat ..\"/\"outside.txt"],
    ["escaped-traversal", "cat ..\\/outside.txt"],
    ["glob-symlink", "cat */passwd"],
    ["bracket-glob", "cat [l]ink/passwd"],
    ["brace-glob", "cat {link,src}/passwd"],
    ["extglob", "cat @(link)/passwd"],
    ["attached-read-path", "grep -f/etc/passwd needle src/value.ts"],
    ["attached-write-path", "cp -t/tmp/out src/value.ts"],
    ["curl-attached", "curl -dDATA https://example.test/api"],
    ["wget-implicit", "wget https://example.test/file"],
    ["rg-pre", "rg --pre 'curl -d x https://example.test' needle src"],
    ["rg-hostname", "rg --hostname-bin=./evil needle src"],
  ];
  const rows: any[] = [{ type: "session_meta", payload: { id: "s" } }];
  for (const [id, cmd] of commands) {
    rows.push({ type: "response_item", payload: { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd }) } });
    rows.push({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: "ok" } });
  }
  const fx = fixture({ transcript: rows });
  const actions = new Map(classifyTranscriptActions(loadTranscript(fx.transcriptPath), fx.repo).map((action) => [action.toolCallId, action]));
  assert.ok(actions.get("redirect")?.classes.includes("unknown_effect"));
  for (const id of ["variable", "nested", "dispatcher", "node-output", "node-output-quoted", "node-output-relative", "git-output", "git-output-relative", "sed-exec", "find-ok", "find-delete", "normalized-traversal", "quoted-traversal", "escaped-traversal", "glob-symlink", "bracket-glob", "brace-glob", "extglob", "attached-read-path", "attached-write-path", "curl-attached", "wget-implicit", "rg-pre", "rg-hostname"]) {
    assert.ok(actions.get(id)?.classes.includes("unknown_effect"), id);
  }
  for (const id of ["form", "upload", "json", "post"]) {
    assert.ok(actions.get(id)?.classes.includes("network_read"), id);
    assert.ok(actions.get(id)?.classes.includes("external_write"), id);
  }
  const contract = {
    ...loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value,
    allowedActions: ["repository_read", "network_read", "external_write"] as AuthorityContract["allowedActions"],
  };
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loadTranscript(fx.transcriptPath), contract);
  const boundary = checked.results.find((item) => item.ruleId === "authorized-action-classes");
  assert.equal(boundary?.verdict, "contradicted");
  assert.match(boundary?.evidence ?? "", /unknown_effect/);
});

test("authority receipts cannot launder a bracket glob through an external symlink", { skip: process.platform === "win32" }, () => {
  const rows = [
    { type: "session_meta", payload: { id: "session-1" } },
    { type: "response_item", payload: { type: "function_call", call_id: "escape", name: "exec_command", arguments: JSON.stringify({ cmd: "cat [l]ink/passwd" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "escape", output: "external bytes" } },
  ];
  const fx = fixture({ transcript: rows });
  symlinkSync("/etc", join(fx.repo, "link"), "dir");
  const loaded = loadTranscript(fx.transcriptPath);
  const action = classifyTranscriptActions(loaded, fx.repo)[0];
  assert.ok(action.classes.includes("unknown_effect"));
  const checked = buildAuthorityChecks(fx.repo, fx.base, fx.head, loaded, loadAuthorityContract(fx.repo, fx.contractPath, fx.base).value);
  assert.equal(checked.results.find((item) => item.ruleId === "authorized-action-classes")?.verdict, "contradicted");
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

test("authority CLI executes a base-policy fresh test even when the transcript makes no test claim", () => {
  const fx = fixture({ transcript: [
    { type: "session_meta", payload: { id: "s" } },
    { type: "response_item", payload: { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: JSON.stringify({ exit_code: 0 }) } },
    { type: "response_item", payload: { type: "function_call", call_id: "write", name: "apply_patch", arguments: "patch" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "write", output: "Done" } },
  ] });
  const report = join(tmpdir(), `authority-policy-test-${Date.now()}.json`);
  const exit = run([
    "authority", fx.transcriptPath, "--contract", fx.contractPath, "--contract-ref", fx.base,
    "--policy", ".agent-vigil.json", "--policy-ref", fx.base,
    "--repo", fx.repo, "--base", fx.base, "--head", fx.head, "--output", report, "--format", "json",
  ]);
  assert.equal(exit, 0);
  const parsed = JSON.parse(readFileSync(report, "utf8"));
  assert.ok(parsed.results.some((check: { ruleId: string; verdict: string }) => check.ruleId === "tests-pass" && check.verdict === "verified"));
  assert.ok(parsed.results.some((check: { ruleId: string }) => check.ruleId === "authority-verification-policy"));
});

test("authority CLI preserves a stronger base-policy evidence minimum", () => {
  const fx = fixture({ policyMinVerified: 99 });
  const report = join(tmpdir(), `authority-policy-minimum-${Date.now()}.json`);
  const exit = run([
    "authority", fx.transcriptPath, "--contract", fx.contractPath, "--contract-ref", fx.base,
    "--policy", ".agent-vigil.json", "--policy-ref", fx.base,
    "--repo", fx.repo, "--base", fx.base, "--head", fx.head, "--output", report, "--format", "json",
  ]);
  assert.equal(exit, 2);
  const parsed = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(parsed.policy.minVerified, 99);
  assert.equal(parsed.summary.status, "INCONCLUSIVE");
});

test("composite Action routes authority mode with a base-anchored contract", { skip: compositeActionIsolationUnavailable }, () => {
  const fx = fixture();
  const event = join(mkdtempSync(join(tmpdir(), "vigil-authority-event-")), "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: fx.base }, head: { sha: fx.head } } }));
  const aux = mkdtempSync(join(tmpdir(), "vigil-action-authority-"));
  const script = join(aux, "run.sh");
  const output = join(aux, "output");
  const summary = join(aux, "summary");
  const runner = join(aux, "runner");
  writeFileSync(script, compositeActionScript());
  writeFileSync(output, "");
  writeFileSync(summary, "");
  mkdirSync(runner);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: process.cwd(), GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: event,
    GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "owner/repository", GITHUB_STEP_SUMMARY: summary,
    GITHUB_WORKSPACE: realpathSync(fx.repo), RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", RUNNER_TEMP: realpathSync(runner),
    VIGIL_ATTEST: "false", VIGIL_TRANSCRIPT: ".agent-session.jsonl", VIGIL_RECEIPT: "", VIGIL_MODE: "",
    VIGIL_AUTHORITY_CONTRACT: ".agent-vigil-authority.json", VIGIL_AUTHORITY_CONTRACT_REF: fx.base,
    VIGIL_CONTINUITY_CHAIN: "", VIGIL_CONTINUITY_ENVIRONMENT: "production", VIGIL_OUTCOME_RECEIPT: "", VIGIL_ACTIONS_RUN_ID: "",
    VIGIL_REPO: realpathSync(fx.repo), VIGIL_BASE: fx.base, VIGIL_HEAD: fx.head, VIGIL_TEST_CMD: "",
    VIGIL_ISOLATE_CANDIDATE: "true", VIGIL_CANDIDATE_SETUP_COMMAND: "",
    VIGIL_POLICY: ".agent-vigil.json", VIGIL_POLICY_REF: fx.base, VIGIL_STRICT: "true", VIGIL_MIN_VERIFIED: "1",
    VIGIL_GITHUB_TOKEN: "", VIGIL_HAS_GITHUB_TOKEN: "false", VIGIL_VALUE_TASK_CLASS: "", VIGIL_VALUE_BUDGET_USD: "",
    VIGIL_VALUE_COST_USD: "", VIGIL_VALUE_COST_SOURCE: "", VIGIL_VALUE_COST_EVIDENCE: "", VIGIL_VALUE_REVIEW_MINUTES: "",
    VIGIL_REVERT_EVIDENCE: "", VIGIL_HOTFIX_EVIDENCE: "", VIGIL_INCIDENT_EVIDENCE: "",
  };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const completed = spawnSync("bash", [script], { cwd: fx.repo, encoding: "utf8", env });
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  assert.match(readFileSync(output, "utf8"), /^status=PASS$/m);
  assert.match(readFileSync(output, "utf8"), /^value_card=.+agent-vigil-value-card\.json$/m);
  assert.match(readFileSync(output, "utf8"), /^github_evidence=.+agent-vigil-github-evidence\.json$/m);
  const outputs = readFileSync(output, "utf8");
  const reportPath = outputs.match(/^report=(.+)$/m)?.[1];
  const valueCardPath = outputs.match(/^value_card=(.+)$/m)?.[1];
  const githubEvidencePath = outputs.match(/^github_evidence=(.+)$/m)?.[1];
  assert.ok(reportPath && valueCardPath && githubEvidencePath);
  assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).transcriptFormat, "authority/codex");
  assert.equal(JSON.parse(readFileSync(valueCardPath, "utf8")).schemaVersion, "agent-vigil-value-card/v1");
  assert.equal(JSON.parse(readFileSync(githubEvidencePath, "utf8")).schemaVersion, "agent-vigil-github-evidence/v1");
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
