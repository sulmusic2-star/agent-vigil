import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const CONFIG = JSON.stringify({ canaryDirectory: ".agent-vigil/upgrade/canaries" }) + "\n";
const BARE_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n";
const temporaryPaths: string[] = [];

function temporary(prefix: string): string {
  const selected = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryPaths.push(selected);
  return selected;
}

after(() => {
  for (const selected of temporaryPaths.reverse()) rmSync(selected, { force: true, recursive: true });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commit(repo: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", message], { cwd: repo });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function repository(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: repo });
  mkdirSync(join(repo, ".agent-vigil", "upgrade", "canaries"), { recursive: true });
  writeFileSync(join(repo, "apm.lock.yaml"), "lockfile_version: 1\ndependencies: []\n# exact-current\n");
  writeFileSync(join(repo, ".agent-vigil", "upgrade", "config.json"), CONFIG);
  writeFileSync(join(repo, ".agent-vigil", "upgrade", "canaries", "canary.mjs"), "// trusted base canary\n");
  return repo;
}

function actionScript(root: string): string {
  const action = readFileSync(join(root, "action.yml"), "utf8");
  const block = action.match(/      run: \|\n([\s\S]*?)\n    - id: prepare_attestation/)?.[1];
  assert.ok(block, "composite Action run script is present");
  return block.split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n");
}

function runtimeBootstrapScript(root: string, hostedNodeRoot: string): string {
  const action = actionScript(root), start = action.indexOf("# The fixed host files below");
  const endToken = "readonly observed_node_version", end = action.indexOf("\n", action.indexOf(endToken, start));
  assert.notEqual(start, -1, "runtime bootstrap starts"); assert.notEqual(end, -1, "runtime bootstrap ends");
  let block = action.slice(start, end)
    .replace("readonly VIGIL_HOSTED_NODE_ROOT='/opt/hostedtoolcache/node'", `readonly VIGIL_HOSTED_NODE_ROOT='${hostedNodeRoot}'`);
  const nodeStart = block.indexOf("VIGIL_NODE_SOURCE=''");
  const nodeEnd = block.indexOf("if [[ -z \"$VIGIL_ENV_BIN\"", nodeStart);
  assert.notEqual(nodeStart, -1); assert.notEqual(nodeEnd, -1);
  block = block.slice(0, nodeStart) + `VIGIL_NODE_SOURCE=''\nfor candidate in "$VIGIL_HOSTED_NODE_ROOT"/*/x64/bin/node; do\n  if resolved=$(canonical_host_file "$candidate") && valid_node_source "$resolved"; then\n    VIGIL_NODE_SOURCE="$resolved"\n    break\n  fi\ndone\n` + block.slice(nodeEnd);
  return `set -eo pipefail\nset +x\numask 077\n${block}\nprintf 'source=%s\\ncheckpoint=%s\\nversion=%s\\n' "$VIGIL_NODE_SOURCE" "$VIGIL_NODE_BIN" "$observed_node_version"\n`;
}

function actionEnvironment(values: { repo: string; workspace?: string; base: string; head: string; event: string; output: string; summary: string; runner: string; action: string }): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: values.action, GITHUB_EVENT_PATH: values.event, GITHUB_WORKSPACE: values.workspace ?? values.repo,
    GITHUB_OUTPUT: values.output, GITHUB_STEP_SUMMARY: values.summary, RUNNER_TEMP: values.runner,
    VIGIL_ATTEST: "false", VIGIL_MODE: "upgrade", VIGIL_TRANSCRIPT: "", VIGIL_RECEIPT: "",
    VIGIL_AUTHORITY_CONTRACT: "", VIGIL_AUTHORITY_CONTRACT_REF: "", VIGIL_OUTCOME_RECEIPT: "",
    VIGIL_ACTIONS_RUN_ID: "", VIGIL_REPO: values.repo, VIGIL_BASE: values.base, VIGIL_HEAD: values.head,
    VIGIL_TEST_CMD: "", VIGIL_POLICY: "", VIGIL_POLICY_REF: "", VIGIL_STRICT: "true", VIGIL_MIN_VERIFIED: "1",
    VIGIL_GITHUB_TOKEN: "", VIGIL_VALUE_TASK_CLASS: "", VIGIL_VALUE_BUDGET_USD: "", VIGIL_VALUE_COST_USD: "",
    VIGIL_VALUE_COST_SOURCE: "", VIGIL_VALUE_COST_EVIDENCE: "", VIGIL_VALUE_REVIEW_MINUTES: "",
    VIGIL_REVERT_EVIDENCE: "", VIGIL_HOTFIX_EVIDENCE: "", VIGIL_INCIDENT_EVIDENCE: "", BASH_ENV: "", ENV: "",
    SHELLOPTS: "", BASHOPTS: "", PS4: "", BASH_XTRACEFD: "", CDPATH: "", GLOBIGNORE: "", POSIXLY_CORRECT: "",
    LD_PRELOAD: "", LD_LIBRARY_PATH: "", LD_AUDIT: "", DYLD_INSERT_LIBRARIES: "", DYLD_LIBRARY_PATH: "",
    DYLD_FRAMEWORK_PATH: "", OPENSSL_CONF: "", OPENSSL_MODULES: "",
  };
  delete environment.NODE_V8_COVERAGE;
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function workflowStepScript(workflow: string, id: string): string {
  const start = workflow.indexOf(`      - id: ${id}\n`);
  assert.notEqual(start, -1, `workflow step ${id} exists`);
  const next = workflow.indexOf("\n      - ", start + 1);
  const step = workflow.slice(start, next === -1 ? workflow.length : next);
  const run = step.indexOf("        run: |\n");
  assert.notEqual(run, -1, `workflow step ${id} has a literal run block`);
  return step.slice(run + "        run: |\n".length)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

function localWorkflowFetchScript(product: string, remoteRoot: string): string {
  const workflow = readFileSync(join(product, "examples/upgrade-guard/github-workflow.yml"), "utf8");
  return workflowStepScript(workflow, "event_repo")
    .replace(
      "-c credential.helper= -c protocol.allow=never -c protocol.https.allow=always",
      "-c credential.helper= -c protocol.allow=never -c protocol.file.allow=always",
    )
    .replace(
      'url="https://github.com/$VIGIL_EVENT_REPOSITORY.git"',
      `url="file://${remoteRoot}/$VIGIL_EVENT_REPOSITORY.git"`,
    );
}

function runShellScript(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  const path = join(cwd, `script-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(path, script);
  return spawnSync("/usr/bin/env", [
    "-u", "BASH_ENV", "-u", "ENV", "-u", "SHELLOPTS", "-u", "BASHOPTS", "-u", "POSIXLY_CORRECT",
    "/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", path,
  ], { cwd, encoding: "utf8", env });
}

function workflowEnvironment(values: {
  output: string;
  runner: string;
  kind: "pull_request_target" | "merge_group";
  repository: string;
  baseRepository: string;
  prNumber: string;
  baseRef: string;
  headRef: string;
  base: string;
  head: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_OUTPUT: values.output,
    RUNNER_TEMP: values.runner,
    VIGIL_EVENT_KIND: values.kind,
    VIGIL_EVENT_REPOSITORY: values.repository,
    VIGIL_EVENT_BASE_REPOSITORY: values.baseRepository,
    VIGIL_EVENT_PR_NUMBER: values.prNumber,
    VIGIL_EVENT_BASE_REF: values.baseRef,
    VIGIL_EVENT_HEAD_REF: values.headRef,
    VIGIL_EVENT_BASE: values.base,
    VIGIL_EVENT_HEAD: values.head,
    VIGIL_EVENT_TOKEN: "ghs_local_test_token_1234567890",
  };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function bareRemote(path: string, source: string, refs: Array<[string, string]>): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", path]);
  execFileSync("git", ["push", "-q", path, ...refs.map(([commit, ref]) => `${commit}:${ref}`)], { cwd: source });
}

function eventBareRepository(runner: string, source: string, base: string, head: string, suffix = "Ab12Cd"): string {
  const parent = join(runner, `agent-vigil-event-repo.${suffix}`), selected = join(parent, "event.git");
  mkdirSync(parent, { mode: 0o700 });
  execFileSync("git", ["init", "--bare", "-q", selected]);
  execFileSync("git", ["--git-dir", selected, "fetch", "-q", "--no-tags", "--no-write-fetch-head", source,
    `+${base}:refs/vigil/base`, `+${head}:refs/vigil/head`]);
  writeFileSync(join(selected, "config"), BARE_CONFIG);
  chmodSync(parent, 0o700); chmodSync(selected, 0o700);
  return selected;
}

test("hosted runtime checkpoints owner-writable Node below writable ubuntu-style ancestors and rejects ambient paths", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd(), root = temporary("vigil-host-runtime-");
  const hosted = join(root, "opt", "hostedtoolcache"), hostedNode = join(hosted, "node"), version = process.versions.node;
  const source = join(hostedNode, version, "x64", "bin", "node"), runner = join(root, "runner"), workspace = join(root, "workspace"), action = join(root, "action");
  mkdirSync(join(hostedNode, version, "x64", "bin"), { recursive: true }); mkdirSync(runner); mkdirSync(workspace); mkdirSync(action);
  linkSync(realpathSync(process.execPath), source); chmodSync(source, 0o755); chmodSync(hosted, 0o777);
  assert.equal(statSync(source).mode & 0o777, 0o755); assert.equal(statSync(hosted).mode & 0o777, 0o777);
  assert.doesNotThrow(() => accessSync(source, constants.W_OK));
  const fakeBin = join(root, "path"), marker = join(root, "ambient-node-ran"); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "node"), `#!/bin/sh\nprintf ambient > ${JSON.stringify(marker)}\nexit 99\n`); chmodSync(join(fakeBin, "node"), 0o700);
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: fakeBin, RUNNER_TEMP: runner, GITHUB_WORKSPACE: workspace, GITHUB_ACTION_PATH: action };
  delete environment.NODE_V8_COVERAGE; delete environment.NODE_TEST_CONTEXT;
  const success = runShellScript(runtimeBootstrapScript(product, hostedNode), root, environment);
  assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
  assert.match(success.stdout, new RegExp(`^source=${escapeRegExp(source)}$`, "m"));
  assert.match(success.stdout, new RegExp(`^version=${version.replaceAll(".", "\\.")}$`, "m"));
  assert.equal(existsSync(marker), false);
  assert.equal(readdirSync(runner).some((name) => name.startsWith("agent-vigil-runtime.")), false);

  for (const [label, rejectedRoot, rejectedRunner, rejectedWorkspace] of [
    ["workspace", join(workspace, "node"), runner, workspace],
    ["runner temp", join(runner, "node"), runner, workspace],
    ["PATH", join(root, "missing-node"), runner, workspace],
  ] as const) {
    const candidate = join(rejectedRoot, version, "x64", "bin", "node");
    if (label !== "PATH") { mkdirSync(join(rejectedRoot, version, "x64", "bin"), { recursive: true }); linkSync(source, candidate); chmodSync(candidate, 0o755); }
    const result = runShellScript(runtimeBootstrapScript(product, rejectedRoot), root, {
      ...environment, RUNNER_TEMP: rejectedRunner, GITHUB_WORKSPACE: rejectedWorkspace,
    });
    assert.equal(result.status, 2, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(marker), false, label);
  }
});

test("required workflow fetches fork and merge event objects into a private bare repository without checkout execution", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd(), root = temporary("vigil-workflow-bare-"), source = repository(root);
  const marker = join(root, "candidate-execution-marker");
  writeFileSync(join(source, ".gitattributes"), "*.owned filter=poison\n");
  const base = commit(source, "base");
  writeFileSync(join(source, "apm.lock.yaml"), readFileSync(join(source, "apm.lock.yaml"), "utf8") + "# fork head\n");
  writeFileSync(join(source, "candidate.owned"), "candidate bytes must remain inside Git objects\n");
  const head = commit(source, "fork head");
  execFileSync("git", ["checkout", "-q", "-b", "advanced-base", base], { cwd: source });
  writeFileSync(join(source, "README.md"), "base branch advanced after the event\n");
  const advancedBase = commit(source, "advance base after event");

  const template = join(root, "hostile-template"), hooks = join(template, "hooks"), maliciousGlobal = join(root, "global.gitconfig");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "reference-transaction"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`);
  chmodSync(join(hooks, "reference-transaction"), 0o700);
  writeFileSync(maliciousGlobal, `[init]\n\ttemplateDir = ${template}\n[filter "poison"]\n\tsmudge = sh -c 'printf smudge > ${marker}; cat'\n\trequired = true\n`);

  const remotes = join(root, "remotes");
  bareRemote(join(remotes, "base", "repo.git"), source, [
    [advancedBase, "refs/heads/main"], [head, "refs/pull/41/head"],
  ]);
  bareRemote(join(remotes, "merge", "repo.git"), source, [
    [base, "refs/heads/main"], [head, "refs/heads/gh-readonly-queue/main/pr-1"],
  ]);

  execFileSync("git", ["checkout", "-q", "-b", "irrelevant", base], { cwd: source });
  writeFileSync(join(source, "README.md"), "unrelated\n");
  const irrelevant = commit(source, "irrelevant head");
  bareRemote(join(remotes, "irrelevant", "repo.git"), source, [
    [base, "refs/heads/main"], [irrelevant, "refs/pull/42/head"],
  ]);

  const workflow = readFileSync(join(product, "examples/upgrade-guard/github-workflow.yml"), "utf8");
  const fetchScript = localWorkflowFetchScript(product, remotes);
  const relevanceScript = workflowStepScript(workflow, "relevance");
  const cleanupScript = workflowStepScript(workflow, "event_repo_cleanup");
  const runCase = (values: {
    label: string; kind: "pull_request_target" | "merge_group"; repository: string;
    baseRepository: string; prNumber: string; baseRef: string; headRef: string; head: string; relevant: boolean;
  }) => {
    const directory = join(root, values.label), runner = join(directory, "runner"), workspace = join(directory, "workspace");
    const commands = join(runner, "commands"), output = join(commands, "fetch-output"), relevanceOutput = join(commands, "relevance-output");
    mkdirSync(commands, { recursive: true }); mkdirSync(workspace); writeFileSync(output, ""); writeFileSync(relevanceOutput, "");
    const environment = workflowEnvironment({
      output, runner, kind: values.kind, repository: values.repository,
      baseRepository: values.baseRepository, prNumber: values.prNumber,
      baseRef: values.baseRef, headRef: values.headRef, base, head: values.head,
    });
    environment.GIT_CONFIG_GLOBAL = maliciousGlobal;
    environment.GIT_CONFIG_SYSTEM = maliciousGlobal;
    environment.GIT_DIR = source;
    environment.GIT_WORK_TREE = source;
    const fetched = runShellScript(fetchScript, workspace, environment);
    assert.equal(fetched.status, 0, `${values.label}: ${fetched.stdout}\n${fetched.stderr}`);
    const token = environment.VIGIL_EVENT_TOKEN!;
    const encodedToken = Buffer.from(`x-access-token:${token}`).toString("base64");
    assert.doesNotMatch(`${fetched.stdout}\n${fetched.stderr}`, new RegExp(`${escapeRegExp(token)}|${escapeRegExp(encodedToken)}`), values.label);
    const eventRepo = /^repo=(.+)$/m.exec(readFileSync(output, "utf8"))?.[1];
    const eventParent = /^parent=(.+)$/m.exec(readFileSync(output, "utf8"))?.[1];
    assert.ok(eventRepo, values.label);
    assert.ok(eventParent, values.label);
    assert.equal(execFileSync("git", ["--git-dir", eventRepo, "rev-parse", "--is-bare-repository"], { encoding: "utf8" }).trim(), "true");
    assert.equal(execFileSync("git", ["--git-dir", eventRepo, "rev-parse", "refs/vigil/base^{commit}"], { encoding: "utf8" }).trim(), base);
    assert.equal(execFileSync("git", ["--git-dir", eventRepo, "rev-parse", "refs/vigil/head^{commit}"], { encoding: "utf8" }).trim(), values.head);
    assert.equal(execFileSync("git", ["--git-dir", eventRepo, "remote"], { encoding: "utf8" }), "");
    assert.deepEqual(execFileSync("git", ["--git-dir", eventRepo, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim().split("\n"), ["refs/vigil/base", "refs/vigil/head"]);
    assert.equal(statSync(eventRepo).mode & 0o077, 0);
    assert.equal(readFileSync(join(eventRepo, "config"), "utf8"), BARE_CONFIG);
    assert.equal(existsSync(join(eventRepo, "FETCH_HEAD")), false); assert.equal(existsSync(join(eventRepo, "logs")), false);
    assert.equal(existsSync(join(workspace, "candidate.owned")), false);
    assert.equal(existsSync(join(eventRepo, "candidate.owned")), false);
    assert.equal(existsSync(marker), false);

    const classified = runShellScript(relevanceScript, workspace, {
      ...environment,
      GITHUB_OUTPUT: relevanceOutput,
      VIGIL_EVENT_REPO: eventRepo,
      VIGIL_EVENT_BASE: base,
      VIGIL_EVENT_HEAD: values.head,
    });
    assert.equal(classified.status, 0, `${values.label}: ${classified.stdout}\n${classified.stderr}`);
    assert.match(readFileSync(relevanceOutput, "utf8"), new RegExp(`^relevant=${values.relevant}$`, "m"));

    const cleaned = runShellScript(cleanupScript, workspace, {
      ...environment,
      VIGIL_EVENT_PARENT: eventParent,
    });
    assert.equal(cleaned.status, 0, `${values.label}: ${cleaned.stdout}\n${cleaned.stderr}`);
    assert.equal(existsSync(eventParent), false, values.label);
  };

  runCase({
    label: "fork", kind: "pull_request_target", repository: "base/repo",
    baseRepository: "base/repo", prNumber: "41",
    baseRef: "refs/heads/main", headRef: "refs/pull/41/head", head, relevant: true,
  });
  runCase({
    label: "merge", kind: "merge_group", repository: "merge/repo",
    baseRepository: "merge/repo", prNumber: "",
    baseRef: "refs/heads/main", headRef: "refs/heads/gh-readonly-queue/main/pr-1", head, relevant: true,
  });
  runCase({
    label: "irrelevant", kind: "pull_request_target", repository: "irrelevant/repo",
    baseRepository: "irrelevant/repo", prNumber: "42",
    baseRef: "refs/heads/main", headRef: "refs/pull/42/head", head: irrelevant, relevant: false,
  });
});

test("required workflow rejects unsafe repository, ref, and runner paths before fetching", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd(), root = temporary("vigil-workflow-paths-"), source = repository(root);
  const base = commit(source, "base");
  writeFileSync(join(source, "README.md"), "head\n");
  const head = commit(source, "head"), remotes = join(root, "remotes"), remote = join(remotes, "base", "repo.git");
  bareRemote(remote, source, [[base, "refs/heads/main"], [head, "refs/pull/7/head"]]);
  const script = localWorkflowFetchScript(product, remotes);
  for (const fixture of [
    { label: "repository traversal", repository: "base/../../repo", headRef: "refs/heads/topic" },
    { label: "ref traversal", repository: "base/repo", headRef: "refs/heads/../topic" },
    { label: "ref option", repository: "base/repo", headRef: "-c" },
  ]) {
    const directory = join(root, fixture.label.replaceAll(" ", "-")), runner = join(directory, "runner"), commands = join(runner, "commands"), output = join(commands, "output");
    mkdirSync(commands, { recursive: true });
    writeFileSync(output, "");
    const result = runShellScript(script, directory, workflowEnvironment({
      output, runner, kind: "pull_request_target", repository: fixture.repository,
      baseRepository: fixture.repository, prNumber: "7",
      baseRef: "refs/heads/main", headRef: fixture.headRef, base, head,
    }));
    assert.equal(result.status, 2, fixture.label);
    assert.deepEqual(readdirSync(runner), ["commands"], fixture.label);
    assert.equal(readFileSync(output, "utf8"), "", fixture.label);
  }
  const realRunner = join(root, "real-runner"), linkedRunner = join(root, "linked-runner");
  mkdirSync(realRunner); symlinkSync(realRunner, linkedRunner); writeFileSync(join(realRunner, "output"), "");
  const linked = runShellScript(script, root, workflowEnvironment({
    output: join(linkedRunner, "output"), runner: linkedRunner, kind: "pull_request_target", repository: "base/repo",
    baseRepository: "base/repo", prNumber: "7",
    baseRef: "refs/heads/main", headRef: "refs/pull/7/head", base, head,
  }));
  assert.equal(linked.status, 2);
  assert.deepEqual(readdirSync(realRunner), ["output"]);

  const raceRunner = join(root, "branch-advance", "runner"), raceCommands = join(raceRunner, "commands"), raceOutput = join(raceCommands, "output");
  mkdirSync(raceCommands, { recursive: true }); writeFileSync(raceOutput, "");
  const raceEnvironment = workflowEnvironment({
    output: raceOutput, runner: raceRunner, kind: "pull_request_target", repository: "base/repo",
    baseRepository: "base/repo", prNumber: "7", baseRef: "refs/heads/main", headRef: "refs/pull/7/head",
    base, head: "f".repeat(40),
  });
  const raced = runShellScript(script, root, raceEnvironment);
  assert.equal(raced.status, 2, `${raced.stdout}\n${raced.stderr}`);
  const raceParent = /^parent=(.+)$/m.exec(readFileSync(raceOutput, "utf8"))?.[1]; assert.ok(raceParent);
  assert.doesNotMatch(readFileSync(raceOutput, "utf8"), /^repo=/m);
  const cleaned = runShellScript(workflowStepScript(readFileSync(join(product, "examples/upgrade-guard/github-workflow.yml"), "utf8"), "event_repo_cleanup"), root, {
    ...raceEnvironment, VIGIL_EVENT_PARENT: raceParent,
  });
  assert.equal(cleaned.status, 0, `${cleaned.stdout}\n${cleaned.stderr}`); assert.equal(existsSync(raceParent), false);
});

test("upgrade Action uses exact Git blobs under an empty host environment and never runs hooks, filters, or ambient runtimes", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd();
  const auxiliary = temporary("vigil-upgrade-action-");
  const repo = repository(auxiliary);
  writeFileSync(join(repo, ".gitattributes"), "apm.lock.yaml filter=poison\n");
  const base = commit(repo, "trusted base");
  writeFileSync(join(repo, "apm.lock.yaml"), "lockfile_version: 1\ndependencies: []\n# exact-candidate\n");
  commit(repo, "candidate lock");
  const victim = join(auxiliary, "runner-sensitive-file");
  writeFileSync(victim, "must-not-change\n");
  symlinkSync(victim, join(repo, "agent-vigil-report.json"));
  const maliciousHead = commit(repo, "candidate report symlink");

  const marker = join(auxiliary, "ambient-marker");
  const hookDirectory = join(auxiliary, "hooks");
  mkdirSync(hookDirectory);
  writeFileSync(join(hookDirectory, "post-checkout"), `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`);
  execFileSync("chmod", ["700", join(hookDirectory, "post-checkout")]);
  execFileSync("git", ["config", "core.hooksPath", hookDirectory], { cwd: repo });
  execFileSync("git", ["config", "filter.poison.smudge", `sh -c 'printf filter > ${JSON.stringify(marker)}; cat'`], { cwd: repo });
  execFileSync("git", ["config", "filter.poison.required", "true"], { cwd: repo });

  const event = join(auxiliary, "event.json"), output = join(auxiliary, "output"), summary = join(auxiliary, "summary");
  const runner = join(auxiliary, "runner"), fakeAction = join(auxiliary, "action"), recorded = join(auxiliary, "recorded.json");
  mkdirSync(runner);
  const eventRepo = eventBareRepository(runner, repo, base, maliciousHead);
  mkdirSync(join(fakeAction, "dist"), { recursive: true });
  mkdirSync(join(fakeAction, "scripts"), { recursive: true });
  copyFileSync(join(product, "scripts/materialize-trusted-upgrade-inputs.mjs"), join(fakeAction, "scripts/materialize-trusted-upgrade-inputs.mjs"));
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: maliciousHead } } }));
  writeFileSync(output, ""); writeFileSync(summary, "");
  writeFileSync(join(fakeAction, "dist/cli.js"), `
const fs=require("node:fs"), path=require("node:path"), args=process.argv.slice(2);
if(args[0]!=="upgrade")process.exit(90);
const value=(name)=>args[args.indexOf(name)+1];
if(args[1]==="preflight"){
  const trustedRepo=value("--repo");
  fs.writeFileSync(${JSON.stringify(recorded)},JSON.stringify({args,current:fs.readFileSync(value("--current-lock"),"utf8"),candidate:fs.readFileSync(value("--candidate-lock"),"utf8"),config:fs.readFileSync(path.join(trustedRepo,value("--config")),"utf8"),canary:fs.readFileSync(path.join(trustedRepo,".agent-vigil/upgrade/canaries/canary.mjs"),"utf8"),environment:process.env,trustedRepo}));
  fs.writeFileSync(value("--output"),JSON.stringify({schemaVersion:"agent-vigil-apm-preflight/v1",summary:{verdict:"CHANGED"},receiptHash:"sha256:${"a".repeat(64)}"}));process.exit(1);
}
if(args[1]==="verify-preflight"){
  const observed=JSON.parse(fs.readFileSync(${JSON.stringify(recorded)},"utf8"));
  observed.verifyArgs=args; observed.verifyEnvironment=process.env;
  fs.writeFileSync(${JSON.stringify(recorded)},JSON.stringify(observed));
  process.stdout.write(JSON.stringify({schemaVersion:"agent-vigil-apm-preflight/v1",verdict:"CHANGED",receiptHash:"sha256:${"a".repeat(64)}",valid:true}));process.exit(0);
}
process.exit(90);
`);

  const fakeBin = join(auxiliary, "fake-bin"); mkdirSync(fakeBin);
  for (const name of ["node", "git", "env"]) {
    writeFileSync(join(fakeBin, name), `#!/bin/sh\nprintf ${name} > ${JSON.stringify(marker)}\nexit 99\n`);
    execFileSync("chmod", ["700", join(fakeBin, name)]);
  }
  const nodeRequire = join(auxiliary, "node-require.cjs");
  writeFileSync(nodeRequire, `require("node:fs").writeFileSync(${JSON.stringify(marker)},"node-options")`);
  const maliciousGlobal = join(auxiliary, "gitconfig");
  writeFileSync(maliciousGlobal, `[core]\n\thooksPath = ${hookDirectory}\n[filter "poison"]\n\tsmudge = sh -c 'printf global > ${marker}; cat'\n\trequired = true\n`);
  const script = join(auxiliary, "run.sh"); writeFileSync(script, actionScript(product));
  const env = actionEnvironment({ repo: eventRepo, workspace: repo, base, head: maliciousHead, event, output, summary, runner, action: fakeAction });
  env.PATH = `${fakeBin}:${env.PATH}`; env.NODE_OPTIONS = `--require=${nodeRequire}`; env.NODE_PATH = fakeBin;
  env.GIT_CONFIG_GLOBAL = maliciousGlobal; env.GIT_CONFIG_SYSTEM = maliciousGlobal; env.GIT_DIR = join(auxiliary, "wrong-git-dir");
  env.HTTP_PROXY = "http://127.0.0.1:9";
  env["BASH_FUNC_set%%"] = `() { printf imported-function > ${JSON.stringify(marker)}; builtin set \"$@\"; }`;
  env.GCONV_PATH = ""; env.LOCPATH = ""; env.NLSPATH = "";
  const completed = spawnSync("/usr/bin/env", ["-u", "BASH_ENV", "-u", "ENV", "-u", "SHELLOPTS", "-u", "BASHOPTS", "-u", "POSIXLY_CORRECT", "/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", script], { cwd: repo, encoding: "utf8", env });
  assert.equal(completed.status, 1, `${completed.stdout}\n${completed.stderr}`);
  assert.equal(existsSync(marker), false);
  const outputs = readFileSync(output, "utf8"); assert.match(outputs, /^status=CHANGED$/m, `${completed.stdout}\n${completed.stderr}`); assert.match(outputs, /^receipt_hash=sha256:a{64}$/m);
  const reportPath = /^report=(.+)$/m.exec(outputs)?.[1]; assert.ok(reportPath); assert.ok(reportPath.startsWith(`${runner}/`));
  assert.equal(reportPath.endsWith("/agent-vigil-report.json"), true);
  assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).summary.verdict, "CHANGED");
  assert.equal(readFileSync(victim, "utf8"), "must-not-change\n"); assert.equal(readlinkSync(join(repo, "agent-vigil-report.json")), victim);
  const observed = JSON.parse(readFileSync(recorded, "utf8"));
  assert.match(observed.current, /exact-current/); assert.doesNotMatch(observed.current, /exact-candidate/); assert.match(observed.candidate, /exact-candidate/);
  assert.equal(observed.config, CONFIG); assert.equal(observed.canary, "// trusted base canary\n");
  const allowedEnvironment = process.platform === "darwin"
    ? ["DOCKER_HOST", "HOME", "LANG", "LC_ALL", "TZ", "__CF_USER_TEXT_ENCODING"]
    : ["DOCKER_HOST", "HOME", "LANG", "LC_ALL", "TZ"];
  assert.deepEqual(Object.keys(observed.environment).sort(), allowedEnvironment.sort());
  assert.equal(observed.environment.DOCKER_HOST, "unix:///var/run/docker.sock"); assert.ok(observed.environment.HOME.startsWith(`${runner}/`));
  assert.deepEqual(observed.verifyArgs.slice(0, 3), ["upgrade", "verify-preflight", reportPath]);
  assert.equal(observed.verifyArgs[observed.verifyArgs.indexOf("--repo") + 1], observed.trustedRepo);
  assert.equal(observed.verifyArgs[observed.verifyArgs.indexOf("--config") + 1], ".agent-vigil/upgrade/config.json");
  for (const forbidden of ["HOME", "DOCKER_HOST", "NODE_OPTIONS", "HTTP_PROXY", "GITHUB_TOKEN"]) assert.equal(observed.verifyEnvironment[forbidden], undefined);
  assert.equal(existsSync(observed.trustedRepo), false);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1);
  assert.equal(existsSync(eventRepo), true);
  assert.equal(readdirSync(runner).some((name) => name.startsWith("agent-vigil-runtime.")), false);
});

test("upgrade Action rejects unsafe runner repository paths, state, and tokens before the verifier", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd(), root = temporary("vigil-event-repo-reject-"), repo = repository(root);
  const base = commit(repo, "base");
  writeFileSync(join(repo, "apm.lock.yaml"), readFileSync(join(repo, "apm.lock.yaml"), "utf8") + "# head\n");
  const head = commit(repo, "head"), event = join(root, "event.json"), action = join(root, "action"), marker = join(root, "verifier-ran");
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  mkdirSync(join(action, "dist"), { recursive: true }); mkdirSync(join(action, "scripts"), { recursive: true });
  writeFileSync(join(action, "dist/cli.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)},"ran");process.exit(99)`);
  copyFileSync(join(product, "scripts/materialize-trusted-upgrade-inputs.mjs"), join(action, "scripts/materialize-trusted-upgrade-inputs.mjs"));
  const script = join(root, "action.sh"); writeFileSync(script, actionScript(product));

  const fixtures: Array<[string, (runner: string) => { selected: string; token?: boolean }]> = [
    ["wrong path shape", (runner) => ({ selected: eventBareRepository(runner, repo, base, head, "TooLong") })],
    ["non-private parent", (runner) => {
      const selected = eventBareRepository(runner, repo, base, head); chmodSync(join(selected, ".."), 0o755); return { selected };
    }],
    ["symlinked repository", (runner) => {
      const outside = join(root, "outside-symlink-target"); mkdirSync(outside);
      const target = eventBareRepository(outside, repo, base, head), parent = join(runner, "agent-vigil-event-repo.Sy12Nk");
      mkdirSync(parent, { mode: 0o700 }); const selected = join(parent, "event.git"); symlinkSync(target, selected); return { selected };
    }],
    ["extra ref", (runner) => {
      const selected = eventBareRepository(runner, repo, base, head); execFileSync("git", ["--git-dir", selected, "update-ref", "refs/evil", base]); return { selected };
    }],
    ["persisted remote", (runner) => {
      const selected = eventBareRepository(runner, repo, base, head); execFileSync("git", ["--git-dir", selected, "remote", "add", "origin", repo]); return { selected };
    }],
    ["token passed to Action", (runner) => ({ selected: eventBareRepository(runner, repo, base, head), token: true })],
  ];
  for (const [label, prepare] of fixtures) {
    const runner = join(root, `runner-${label.replaceAll(" ", "-")}`), output = join(root, `output-${label.replaceAll(" ", "-")}`);
    mkdirSync(runner); writeFileSync(output, "");
    const { selected, token } = prepare(runner);
    const env = actionEnvironment({ repo: selected, workspace: repo, base, head, event, output, summary: join(root, "summary"), runner, action });
    if (token) env.VIGIL_UPGRADE_HAS_GITHUB_TOKEN = "true";
    const result = spawnSync("/usr/bin/env", ["-u", "BASH_ENV", "-u", "ENV", "-u", "SHELLOPTS", "-u", "BASHOPTS", "-u", "POSIXLY_CORRECT", "/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", script], { cwd: repo, encoding: "utf8", env });
    assert.equal(result.status, 2, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(marker), false, label);
    assert.equal(readdirSync(runner).some((name) => name.startsWith("agent-vigil-runtime.")), false, label);
  }
});

test("upgrade Action maps only 0 SAFE, 1 CHANGED, and 2 HOLD after bound verification", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd(), root = temporary("vigil-exit-map-"), repo = repository(root);
  const base = commit(repo, "base");
  writeFileSync(join(repo, "apm.lock.yaml"), readFileSync(join(repo, "apm.lock.yaml"), "utf8") + "# candidate\n");
  const head = commit(repo, "head"), event = join(root, "event.json"), action = join(root, "action");
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  mkdirSync(join(action, "dist"), { recursive: true }); mkdirSync(join(action, "scripts"), { recursive: true });
  copyFileSync(join(product, "scripts/materialize-trusted-upgrade-inputs.mjs"), join(action, "scripts/materialize-trusted-upgrade-inputs.mjs"));
  const fixtures = [
    { label: "zero changed", preflightCode: 0, verdict: "CHANGED", verifierCode: 0 },
    { label: "one safe", preflightCode: 1, verdict: "SAFE", verifierCode: 0 },
    { label: "two changed", preflightCode: 2, verdict: "CHANGED", verifierCode: 0 },
    { label: "invalid verifier", preflightCode: 0, verdict: "SAFE", verifierCode: 2 },
  ];
  for (const fixture of fixtures) {
    const selected = fixture.verdict;
    writeFileSync(join(action, "dist/cli.js"), `
const fs=require("node:fs"),args=process.argv.slice(2),value=(name)=>args[args.indexOf(name)+1];
if(args[1]==="preflight"){
 fs.writeFileSync(value("--output"),JSON.stringify({schemaVersion:"agent-vigil-apm-preflight/v1",summary:{verdict:${JSON.stringify(selected)}},receiptHash:"sha256:${"b".repeat(64)}"}));process.exit(${fixture.preflightCode});
}
if(args[1]==="verify-preflight"){
 if(${fixture.verifierCode}!==0)process.exit(${fixture.verifierCode});
 process.stdout.write(JSON.stringify({schemaVersion:"agent-vigil-apm-preflight/v1",verdict:${JSON.stringify(selected)},receiptHash:"sha256:${"b".repeat(64)}",valid:true}));process.exit(0);
}
process.exit(90);
`);
    const runner = join(root, `runner-${fixture.label.replaceAll(" ", "-")}`), output = join(root, `output-${fixture.label.replaceAll(" ", "-")}`);
    mkdirSync(runner); writeFileSync(output, "");
    const env = actionEnvironment({ repo, base, head, event, output, summary: join(root, "summary"), runner, action });
    const script = join(root, `run-${fixture.label.replaceAll(" ", "-")}.sh`); writeFileSync(script, actionScript(product));
    const result = spawnSync("/usr/bin/env", ["-u", "BASH_ENV", "-u", "ENV", "-u", "SHELLOPTS", "-u", "BASHOPTS", "-u", "POSIXLY_CORRECT", "/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", script], { cwd: repo, encoding: "utf8", env });
    assert.equal(result.status, 2, `${fixture.label}: ${result.stdout}\n${result.stderr}`);
    const outputs = readFileSync(output, "utf8");
    assert.match(outputs, /^status=HOLD$/m, fixture.label); assert.match(outputs, /^report=$/m, fixture.label);
    assert.match(result.stderr, /exit-to-verdict binding is invalid/, fixture.label);
  }
});

function runMaterializer(repo: string, base: string, head: string, output: string) {
  return spawnSync(process.execPath, [join(process.cwd(), "scripts/materialize-trusted-upgrade-inputs.mjs"), "materialize", "--repository", repo, "--base", base, "--head", head, "--output", output, "--git", "/usr/bin/git"], { encoding: "utf8", env: { LANG: "C", LC_ALL: "C", TZ: "UTC" } });
}

test("trusted-input materialization rejects every config or canary change", { skip: process.platform === "win32" }, () => {
  const mutations: Array<[string, (repo: string) => void]> = [
    ["config edit", (repo) => writeFileSync(join(repo, ".agent-vigil/upgrade/config.json"), CONFIG.replace("canaries", "other"))],
    ["config deletion", (repo) => execFileSync("git", ["rm", "-q", ".agent-vigil/upgrade/config.json"], { cwd: repo })],
    ["canary edit", (repo) => writeFileSync(join(repo, ".agent-vigil/upgrade/canaries/canary.mjs"), "// candidate canary\n")],
  ];
  for (const [label, mutate] of mutations) {
    const root = temporary("vigil-harness-mutation-"), repo = repository(root), base = commit(repo, "base");
    mutate(repo); const head = commit(repo, label), output = join(root, "materialized"), result = runMaterializer(repo, base, head, output);
    assert.equal(result.status, 2, `${label}: ${result.stdout}\n${result.stderr}`); assert.match(result.stderr, /TRUSTED_HARNESS_CHANGED/); assert.equal(existsSync(output), false);
  }
});

test("trusted-input materialization rejects symlinks, extras, and non-portable paths", { skip: process.platform === "win32" }, () => {
  const fixtures: Array<[string, (repo: string) => void]> = [
    ["symlink", (repo) => symlinkSync("canary.mjs", join(repo, ".agent-vigil/upgrade/canaries/link.mjs"))],
    ["extra", (repo) => writeFileSync(join(repo, ".agent-vigil/upgrade/extra.txt"), "extra\n")],
    ["device", (repo) => writeFileSync(join(repo, ".agent-vigil/upgrade/canaries/CON"), "bad\n")],
    ["stream", (repo) => writeFileSync(join(repo, ".agent-vigil/upgrade/canaries/name:ads"), "bad\n")],
    ["terminal dot", (repo) => writeFileSync(join(repo, ".agent-vigil/upgrade/canaries/trailing."), "bad\n")],
  ];
  for (const [label, add] of fixtures) {
    const root = temporary("vigil-unsafe-harness-"), repo = repository(root); add(repo); const base = commit(repo, label);
    writeFileSync(join(repo, "apm.lock.yaml"), readFileSync(join(repo, "apm.lock.yaml"), "utf8") + "# head\n");
    const head = commit(repo, "head lock"), output = join(root, "materialized"), result = runMaterializer(repo, base, head, output);
    assert.equal(result.status, 2, `${label}: ${result.stdout}\n${result.stderr}`); assert.equal(existsSync(output), false);
  }
});

test("trusted-input bytes and modes are invariant under caller umask", { skip: process.platform === "win32" }, () => {
  const root = temporary("vigil-umask-inputs-"), repo = repository(root), base = commit(repo, "base");
  writeFileSync(join(repo, "apm.lock.yaml"), readFileSync(join(repo, "apm.lock.yaml"), "utf8") + "# head\n");
  const head = commit(repo, "head lock"), helper = join(process.cwd(), "scripts/materialize-trusted-upgrade-inputs.mjs");
  const outputs = ["022", "077"].map((mask) => {
    const output = join(root, `out-${mask}`);
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", 'umask "$1"; shift; exec "$@"', "vigil", mask,
      process.execPath, helper, "materialize", "--repository", repo, "--base", base, "--head", head,
      "--output", output, "--git", "/usr/bin/git"], { encoding: "utf8", env: { LANG: "C", LC_ALL: "C", TZ: "UTC" } });
    assert.equal(result.status, 0, `${mask}: ${result.stdout}\n${result.stderr}`);
    return { output: realpathSync(output), receipt: JSON.parse(result.stdout) };
  });
  const snapshot = (directory: string) => {
    const rows: Array<{ path: string; mode: number; bytes?: string }> = [];
    const walk = (current: string, prefix = "") => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(current, entry.name), relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        rows.push({ path: relativePath, mode: statSync(path).mode & 0o777, ...(entry.isFile() ? { bytes: readFileSync(path).toString("base64") } : {}) });
        if (entry.isDirectory()) walk(path, relativePath);
      }
    };
    walk(directory);
    return rows;
  };
  assert.deepEqual(snapshot(outputs[0].output), snapshot(outputs[1].output));
  assert.equal(outputs[0].receipt.harnessTree, outputs[1].receipt.harnessTree);
  assert.equal(outputs[0].receipt.base, base); assert.equal(outputs[1].receipt.head, head);
});

test("upgrade Action declares a closed shell and plumbing-only trusted boundary", () => {
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  assert.match(action, /shell: \/usr\/bin\/env .*\/bin\/bash --noprofile --norc -e -o pipefail \{0\}/);
  for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "OPENSSL_CONF"]) assert.match(action, new RegExp(`${name}: ""`));
  for (const name of ["GCONV_PATH", "LOCPATH", "NLSPATH"]) assert.match(action, new RegExp(`${name}: ""`));
  assert.match(action, /run: \|\n        \/usr\/bin\/env -i/);
  assert.match(action, /umask 077/); assert.match(action, /upgrade mode does not accept a GitHub token/);
  assert.match(action, /VIGIL_GITHUB_TOKEN: \$\{\{ inputs\.mode != 'upgrade'/);
  assert.match(action, /VIGIL_UPGRADE_HAS_GITHUB_TOKEN: \$\{\{ inputs\.mode == 'upgrade'/);
  assert.match(action, /materialize-trusted-upgrade-inputs\.mjs" materialize/); assert.match(action, /DOCKER_HOST=unix:\/\/\/var\/run\/docker\.sock/);
  assert.match(action, /VIGIL_HOSTED_NODE_ROOT='\/opt\/hostedtoolcache\/node'/);
  assert.match(action, /node_source_before=.*file_fingerprint/); assert.match(action, /node_checkpoint_sha/); assert.match(action, /checkpoint_mode.*500/);
  assert.match(action, /path_is_inside "\$selected" "\$\{GITHUB_ACTION_PATH:-\}"/);
  assert.match(action, /upgrade verify-preflight "\$report_file"/);
  assert.match(action, /--repo "\$trusted_repo" --config "\$VIGIL_UPGRADE_CONFIG"/);
  assert.match(action, /SAFE\) expected_preflight_code=0/); assert.match(action, /CHANGED\) expected_preflight_code=1/); assert.match(action, /HOLD\) expected_preflight_code=2/);
  assert.doesNotMatch(action, /git -C "\$VIGIL_REPO" (?:worktree|show|checkout)/); assert.doesNotMatch(action, /worktree add|git checkout/);
  for (const basename of ["agent-vigil-report.json", "agent-vigil.sarif", "agent-vigil-value-card.json", "agent-vigil-github-evidence.json"]) assert.match(action, new RegExp(basename.replace(".", "\\.")));
  assert.match(action, /inputs\.mode != 'upgrade'/);
});

test("upgrade workflow is base-selected and does not publish the private receipt by default", () => {
  const workflow = readFileSync(join(process.cwd(), "examples/upgrade-guard/github-workflow.yml"), "utf8");
  const contract = readFileSync(join(process.cwd(), "docs/APM_PREFLIGHT_ACTION.md"), "utf8");
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /^\s{2}pull_request:/m);
  assert.match(workflow, /^\s{2}merge_group:/m);
  assert.match(workflow, /\.github\/workflows\/agent-vigil-upgrade\.yml/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /actions\/checkout|persist-credentials|allow-unsafe-pr-checkout/);
  assert.match(workflow, /refs\/pull\/\{0\}\/head/);
  assert.match(workflow, /fetch_exact_ref "\$VIGIL_EVENT_BASE" refs\/vigil\/base/);
  assert.match(workflow, /3<<<"\$\{VIGIL_EVENT_TOKEN-\}"/);
  assert.doesNotMatch(workflow, /"VIGIL_EVENT_TOKEN=\$\{VIGIL_EVENT_TOKEN-/);
  assert.match(workflow, /GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$authorization"/);
  assert.doesNotMatch(workflow, /extraHeader=AUTHORIZATION/);
  assert.match(workflow, /git --no-pager --no-replace-objects/);
  assert.match(workflow, /diff-tree --quiet "\$VIGIL_EVENT_BASE" "\$VIGIL_EVENT_HEAD"/);
  assert.match(workflow, /if: \$\{\{ steps\.relevance\.outputs\.relevant == 'true' \}\}/);
  assert.match(workflow, /always\(\) && steps\.event_repo\.outputs\.parent != ''/);
  assert.match(workflow, /\[\[ ! -e "\$VIGIL_EVENT_PARENT" && ! -L "\$VIGIL_EVENT_PARENT" \]\]/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact|retention-days:/);
  assert.match(contract, /required-workflow ruleset/);
  assert.match(contract, /private repositories/);
  assert.match(contract, /default public-repository example does\s+not upload it/);
  const ci = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /runs-on: ubuntu-24\.04/); assert.match(ci, /Smoke the Ubuntu hosted-runtime trust contract/);
});
