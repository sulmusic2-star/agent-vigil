import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

function commit(repo: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", message], { cwd: repo });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function actionScript(root: string): string {
  const action = readFileSync(join(root, "action.yml"), "utf8");
  const block = action.match(/      run: \|\n([\s\S]+)$/)?.[1];
  assert.ok(block, "composite Action run script is present");
  return block.split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n");
}

test("upgrade Action binds exact event locks, trusted base inputs, outputs, and cleanup", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const product = process.cwd();
  const auxiliary = mkdtempSync(join(tmpdir(), "vigil-upgrade-action-"));
  const repo = join(auxiliary, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: repo });
  mkdirSync(join(repo, ".agent-vigil", "upgrade", "canaries"), { recursive: true });
  writeFileSync(join(repo, "apm.lock.yaml"), "lockfile_version: 1\ndependencies: []\n# exact-current\n");
  writeFileSync(join(repo, ".agent-vigil", "upgrade", "config.json"), "{\"trusted\":\"base-only\"}\n");
  writeFileSync(join(repo, ".agent-vigil", "upgrade", "canaries", "canary.mjs"), "// trusted base canary\n");
  const base = commit(repo, "trusted base");
  writeFileSync(join(repo, "apm.lock.yaml"), "lockfile_version: 1\ndependencies: []\n# exact-candidate\n");
  writeFileSync(join(repo, ".agent-vigil", "upgrade", "config.json"), "{\"trusted\":\"candidate-must-not-win\"}\n");
  const head = commit(repo, "candidate lock and config");

  const event = join(auxiliary, "event.json");
  const output = join(auxiliary, "output");
  const summary = join(auxiliary, "summary");
  const runner = join(auxiliary, "runner");
  const fakeAction = join(auxiliary, "action");
  const recorded = join(auxiliary, "recorded.json");
  mkdirSync(runner);
  mkdirSync(join(fakeAction, "dist"), { recursive: true });
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  writeFileSync(output, "");
  writeFileSync(summary, "");
  writeFileSync(join(fakeAction, "dist", "cli.js"), `
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] !== "upgrade" || args[1] !== "preflight") process.exit(90);
const value = (name) => args[args.indexOf(name) + 1];
const current = fs.readFileSync(value("--current-lock"), "utf8");
const candidate = fs.readFileSync(value("--candidate-lock"), "utf8");
const trustedRepo = value("--repo");
const config = fs.readFileSync(require("node:path").join(trustedRepo, value("--config")), "utf8");
const trustedHead = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: trustedRepo, encoding: "utf8" }).trim();
fs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({ args, current, candidate, config, trustedHead }));
fs.writeFileSync(value("--output"), JSON.stringify({
  schemaVersion: "agent-vigil-apm-preflight/v1",
  summary: { verdict: "CHANGED" },
  receiptHash: "sha256:${"a".repeat(64)}"
}));
process.exit(1);
`);
  const script = join(auxiliary, "run.sh");
  writeFileSync(script, actionScript(product));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: fakeAction,
    GITHUB_EVENT_PATH: event,
    GITHUB_WORKSPACE: repo,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    RUNNER_TEMP: runner,
    VIGIL_ATTEST: "false",
    VIGIL_MODE: "upgrade",
    VIGIL_TRANSCRIPT: "",
    VIGIL_RECEIPT: "",
    VIGIL_AUTHORITY_CONTRACT: "",
    VIGIL_AUTHORITY_CONTRACT_REF: "",
    VIGIL_OUTCOME_RECEIPT: "",
    VIGIL_ACTIONS_RUN_ID: "",
    VIGIL_REPO: repo,
    VIGIL_BASE: base,
    VIGIL_HEAD: head,
    VIGIL_TEST_CMD: "",
    VIGIL_POLICY: "",
    VIGIL_POLICY_REF: "",
    VIGIL_STRICT: "true",
    VIGIL_MIN_VERIFIED: "1",
    VIGIL_GITHUB_TOKEN: "",
    VIGIL_VALUE_TASK_CLASS: "",
    VIGIL_VALUE_BUDGET_USD: "",
    VIGIL_VALUE_COST_USD: "",
    VIGIL_VALUE_COST_SOURCE: "",
    VIGIL_VALUE_COST_EVIDENCE: "",
    VIGIL_VALUE_REVIEW_MINUTES: "",
    VIGIL_REVERT_EVIDENCE: "",
    VIGIL_HOTFIX_EVIDENCE: "",
    VIGIL_INCIDENT_EVIDENCE: "",
  };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const completed = spawnSync("bash", [script], { cwd: repo, encoding: "utf8", env });
  assert.equal(completed.status, 1, `${completed.stdout}\n${completed.stderr}`);
  assert.match(readFileSync(output, "utf8"), /^status=CHANGED$/m);
  assert.match(readFileSync(output, "utf8"), /^receipt_hash=sha256:a{64}$/m);
  assert.match(readFileSync(output, "utf8"), /^sarif=$/m);
  assert.match(readFileSync(output, "utf8"), /^value_card=$/m);
  const report = JSON.parse(readFileSync(join(repo, "agent-vigil-report.json"), "utf8"));
  assert.equal(report.summary.verdict, "CHANGED");

  const observed = JSON.parse(readFileSync(recorded, "utf8"));
  assert.match(observed.current, /exact-current/);
  assert.doesNotMatch(observed.current, /exact-candidate/);
  assert.match(observed.candidate, /exact-candidate/);
  assert.equal(observed.config, "{\"trusted\":\"base-only\"}\n");
  assert.equal(observed.trustedHead, base);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1);
});

test("upgrade Action rejects unsafe paths, non-event runs, and unsupported attestation", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  assert.match(action, /upgrade mode requires a pull_request or merge_group event/);
  assert.match(action, /upgrade mode does not yet support attestation/);
  assert.match(action, /upgrade mode requires repo to equal the GitHub workspace/);
  assert.match(action, /VIGIL_UPGRADE_LOCK_PATH="apm\.lock\.yaml"/);
  assert.doesNotMatch(action, /inputs\.upgrade-identity/);
  assert.match(action, /exact APM lockfile is missing or exceeds 4 MiB/);
  assert.match(action, /trusted-base worktree restoration failed/);
  assert.match(action, /unlinkSync\(process\.argv\[1\]\)/);
  assert.match(action, /inputs\.mode != 'upgrade'/);
});
