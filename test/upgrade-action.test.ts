import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const CONFIG = JSON.stringify({ canaryDirectory: ".agent-vigil/upgrade/canaries" }) + "\n";

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

function actionEnvironment(values: { repo: string; base: string; head: string; event: string; output: string; summary: string; runner: string; action: string }): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: values.action, GITHUB_EVENT_PATH: values.event, GITHUB_WORKSPACE: values.repo,
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

test("upgrade Action uses exact Git blobs under an empty host environment and never runs hooks, filters, or ambient runtimes", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd();
  const auxiliary = mkdtempSync(join(tmpdir(), "vigil-upgrade-action-"));
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
  const env = actionEnvironment({ repo, base, head: maliciousHead, event, output, summary, runner, action: fakeAction });
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
});

test("upgrade Action maps only 0 SAFE, 1 CHANGED, and 2 HOLD after bound verification", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd(), root = mkdtempSync(join(tmpdir(), "vigil-exit-map-")), repo = repository(root);
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
    const root = mkdtempSync(join(tmpdir(), "vigil-harness-mutation-")), repo = repository(root), base = commit(repo, "base");
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
    const root = mkdtempSync(join(tmpdir(), "vigil-unsafe-harness-")), repo = repository(root); add(repo); const base = commit(repo, label);
    writeFileSync(join(repo, "apm.lock.yaml"), readFileSync(join(repo, "apm.lock.yaml"), "utf8") + "# head\n");
    const head = commit(repo, "head lock"), output = join(root, "materialized"), result = runMaterializer(repo, base, head, output);
    assert.equal(result.status, 2, `${label}: ${result.stdout}\n${result.stderr}`); assert.equal(existsSync(output), false);
  }
});

test("trusted-input bytes and modes are invariant under caller umask", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-umask-inputs-")), repo = repository(root), base = commit(repo, "base");
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
  assert.match(action, /upgrade verify-preflight "\$report_file"/);
  assert.match(action, /--repo "\$trusted_repo" --config "\$VIGIL_UPGRADE_CONFIG"/);
  assert.match(action, /SAFE\) expected_preflight_code=0/); assert.match(action, /CHANGED\) expected_preflight_code=1/); assert.match(action, /HOLD\) expected_preflight_code=2/);
  assert.doesNotMatch(action, /git -C "\$VIGIL_REPO" (?:worktree|show|checkout)/); assert.doesNotMatch(action, /worktree add|git checkout/);
  assert.match(action, /inputs\.mode != 'upgrade'/);
});

test("upgrade workflow is base-selected and does not publish the private receipt by default", () => {
  const workflow = readFileSync(join(process.cwd(), "examples/upgrade-guard/github-workflow.yml"), "utf8");
  const contract = readFileSync(join(process.cwd(), "docs/APM_PREFLIGHT_ACTION.md"), "utf8");
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /^\s{2}pull_request:/m);
  assert.doesNotMatch(workflow, /^\s{2}merge_group:/m);
  assert.match(workflow, /\.github\/workflows\/agent-vigil-upgrade\.yml/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /allow-unsafe-pr-checkout: true/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact|retention-days:/);
  assert.match(contract, /required-workflow ruleset/);
  assert.match(contract, /default public-repository example does\s+not upload it/);
});
