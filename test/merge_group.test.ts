import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { buildMergeGroupReport, loadMergeGroupEvent } from "../src/merge-group.ts";
import { compositeActionIsolationUnavailable, compositeActionScript } from "./action-runtime-fixture.ts";

function fixture(options: { failingHead?: boolean; tamperHeadPolicy?: boolean; switchHeadDuringTest?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "vigil-merge-group-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "vigil@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Vigil Test"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "merge.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('merge',()=>assert.equal(2+2,4));\n");
  if (options.switchHeadDuringTest) {
    writeFileSync(join(repo, "switch-head.cjs"), "require('node:child_process').execFileSync('git',['checkout','--detach','HEAD~1'],{stdio:'ignore'});\n");
  }
  writeFileSync(join(repo, ".agent-vigil.json"), JSON.stringify({
    schemaVersion: 1,
    strict: true,
    minVerified: 1,
    testCommand: options.switchHeadDuringTest ? "node switch-head.cjs && node --test" : "node --test",
    integrityMode: "advisory",
  }));
  writeFileSync(join(repo, ".agent-vigil-authority.json"), JSON.stringify({
    schemaVersion: 1,
    taskId: "QUEUE-1",
    allowedChangePaths: ["**"],
    allowedActions: ["repository_read"],
    requireCompleteToolResults: true,
    expiresAt: "2099-01-01T00:00:00.000Z",
  }));
  writeFileSync(join(repo, ".agent-session.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "queue-session" } })}\n`);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "feature.js"), "export const ready = true;\n");
  if (options.failingHead) {
    writeFileSync(join(repo, "merge.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('merge',()=>assert.equal(2+2,5));\n");
  }
  if (options.tamperHeadPolicy) {
    writeFileSync(join(repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, strict: false, minVerified: 1, testCommand: "true", integrityMode: "advisory" }));
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "merge group"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const event = join(mkdtempSync(join(tmpdir(), "vigil-merge-event-")), "event.json");
  writeFileSync(event, JSON.stringify({ action: "checks_requested", merge_group: { base_sha: base, head_sha: head, base_ref: "refs/heads/main", head_ref: "refs/heads/gh-readonly-queue/main/pr-1" }, repository: { full_name: "example/repo" } }));
  return { repo, base, head, event };
}

test("merge-group report binds event, policy, checkout, tests, and composed range", () => {
  const value = fixture();
  const report = buildMergeGroupReport({ repo: value.repo, eventPath: value.event, base: value.base, head: value.head, policy: ".agent-vigil.json", policyRef: value.base });
  assert.equal(report.summary.status, "PASS");
  assert.equal(report.transcriptFormat, "github-merge-group-event");
  assert.equal(report.base, value.base);
  assert.equal(report.head, value.head);
  assert.ok(report.results.some((row) => row.ruleId === "merge-group-binding" && row.verdict === "verified"));
  assert.ok(report.results.some((row) => row.ruleId === "merge-group-range" && row.verdict === "verified"));
  assert.ok(report.results.some((row) => row.ruleId === "tests-pass" && row.verdict === "verified"));
});

test("merge-group CLI writes JSON and SARIF receipts", () => {
  const value = fixture();
  const output = join(value.repo, "report.json");
  const sarif = join(value.repo, "report.sarif");
  assert.equal(run(["merge-group", "--event", value.event, "--repo", value.repo, "--base", value.base, "--head", value.head, "--policy", ".agent-vigil.json", "--policy-ref", value.base, "--output", output, "--sarif", sarif]), 0);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).summary.status, "PASS");
  assert.equal(JSON.parse(readFileSync(sarif, "utf8")).runs[0].properties.status, "PASS");
});

test("composite Action rejects repository-selected merge_group candidate verification", { skip: compositeActionIsolationUnavailable }, () => {
  const value = fixture();
  const aux = mkdtempSync(join(tmpdir(), "vigil-action-merge-"));
  const script = join(aux, "run.sh");
  const output = join(aux, "output");
  const summary = join(aux, "summary");
  const runner = join(aux, "runner");
  writeFileSync(script, compositeActionScript());
  writeFileSync(output, "");
  writeFileSync(summary, "");
  mkdirSync(runner);
  const actionEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: process.cwd(),
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "merge_group",
    GITHUB_EVENT_PATH: value.event,
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "example/repo",
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_WORKSPACE: realpathSync(value.repo),
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: realpathSync(runner),
    VIGIL_ATTEST: "false",
    VIGIL_TRANSCRIPT: "",
    VIGIL_RECEIPT: "",
    VIGIL_AUTHORITY_CONTRACT: "",
    VIGIL_AUTHORITY_CONTRACT_REF: "",
    VIGIL_CONTINUITY_CHAIN: "",
    VIGIL_CONTINUITY_ENVIRONMENT: "production",
    VIGIL_MODE: "maintainer",
    VIGIL_OUTCOME_RECEIPT: "",
    VIGIL_ACTIONS_RUN_ID: "",
    VIGIL_REPO: realpathSync(value.repo),
    VIGIL_BASE: value.base,
    VIGIL_HEAD: value.head,
    VIGIL_TEST_CMD: "",
    VIGIL_ISOLATE_CANDIDATE: "true",
    VIGIL_CANDIDATE_SETUP_COMMAND: "",
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: value.base,
    VIGIL_STRICT: "true",
    VIGIL_MIN_VERIFIED: "1",
    VIGIL_GITHUB_TOKEN: "",
    VIGIL_HAS_GITHUB_TOKEN: "false",
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
  // The Action intentionally executes the compiled package. Do not let a
  // parent `node --experimental-test-coverage` process count that second copy
  // as uncovered source in this TypeScript unit-coverage denominator.
  delete actionEnv.NODE_V8_COVERAGE;
  delete actionEnv.NODE_TEST_CONTEXT;
  const completed = spawnSync("bash", [script], {
    cwd: value.repo,
    encoding: "utf8",
    env: actionEnv,
  });
  assert.equal(completed.status, 2, `${completed.stderr}\n${completed.stdout}`);
  assert.match(completed.stderr, /requires the base-selected pull_request_target event/);
});

test("merge-group rejects a forged or mismatched event range", () => {
  const value = fixture();
  const forged = join(mkdtempSync(join(tmpdir(), "vigil-merge-forged-")), "event.json");
  writeFileSync(forged, JSON.stringify({ merge_group: { base_sha: value.base, head_sha: value.base } }));
  assert.equal(run(["merge-group", "--event", forged, "--repo", value.repo, "--base", value.base, "--head", value.head, "--policy", ".agent-vigil.json", "--policy-ref", value.base]), 2);
  assert.throws(() => loadMergeGroupEvent(forged.replace("event.json", "missing.json")), /ENOENT/);
});

test("merge-group uses the base policy even when the composed head weakens its worktree copy", () => {
  const value = fixture({ tamperHeadPolicy: true });
  const report = buildMergeGroupReport({ repo: value.repo, eventPath: value.event, base: value.base, head: value.head, policy: ".agent-vigil.json", policyRef: value.base });
  assert.equal(report.summary.status, "PASS");
  assert.equal(report.policy.strict, true);
  assert.match(report.results.find((row) => row.ruleId === "tests-pass")?.evidence ?? "", /node --test/);
});

test("merge-group fails when the composed commit breaks the trusted test command", () => {
  const value = fixture({ failingHead: true });
  const report = buildMergeGroupReport({ repo: value.repo, eventPath: value.event, base: value.base, head: value.head, policy: ".agent-vigil.json", policyRef: value.base });
  assert.equal(report.summary.status, "FAIL");
  assert.ok(report.results.some((row) => row.ruleId === "tests-pass" && row.verdict === "contradicted"));
});

test("merge-group keeps authority planning in the required check", () => {
  const value = fixture();
  mkdirSync(join(value.repo, ".codex"), { recursive: true });
  writeFileSync(join(value.repo, ".codex", "config.toml"), 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
  execFileSync("git", ["add", "-A"], { cwd: value.repo });
  execFileSync("git", ["commit", "-qm", "weaken agent controls"], { cwd: value.repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: value.repo, encoding: "utf8" }).trim();
  writeFileSync(value.event, JSON.stringify({ merge_group: { base_sha: value.base, head_sha: head } }));
  const report = buildMergeGroupReport({ repo: value.repo, eventPath: value.event, base: value.base, head, policy: ".agent-vigil.json", policyRef: value.base });
  assert.equal(report.summary.status, "FAIL");
  assert.ok(report.results.some((row) => row.ruleId === "authority-approval" && row.verdict === "contradicted"));
  assert.ok(report.results.some((row) => row.ruleId === "authority-sandbox" && row.verdict === "contradicted"));
});

test("merge-group is inconclusive when the selected head is not checked out", () => {
  const value = fixture();
  execFileSync("git", ["checkout", "-q", "--detach", value.base], { cwd: value.repo });
  const report = buildMergeGroupReport({ repo: value.repo, eventPath: value.event, base: value.base, head: value.head, policy: ".agent-vigil.json", policyRef: value.base });
  assert.equal(report.summary.status, "INCONCLUSIVE");
  assert.ok(report.results.some((row) => row.ruleId === "workspace-unbound" && row.verdict === "unverifiable"));
});

test("merge-group detects a test command that moves HEAD after the pre-test binding", () => {
  const value = fixture({ switchHeadDuringTest: true });
  const report = buildMergeGroupReport({ repo: value.repo, eventPath: value.event, base: value.base, head: value.head, policy: ".agent-vigil.json", policyRef: value.base });
  assert.equal(report.summary.status, "INCONCLUSIVE");
  assert.ok(report.results.some((row) => row.ruleId === "workspace-mutated" && row.verdict === "unverifiable" && /checkout identity/.test(row.evidence)));
});

test("merge-group fails when an event head does not descend from its base", () => {
  const value = fixture();
  const emptyTree = execFileSync("git", ["mktree"], { cwd: value.repo, input: "", encoding: "utf8" }).trim();
  const unrelated = execFileSync("git", ["commit-tree", emptyTree, "-m", "unrelated"], { cwd: value.repo, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-q", "--detach", unrelated], { cwd: value.repo });
  const event = join(mkdtempSync(join(tmpdir(), "vigil-merge-unrelated-")), "event.json");
  writeFileSync(event, JSON.stringify({ merge_group: { base_sha: value.base, head_sha: unrelated } }));
  const report = buildMergeGroupReport({ repo: value.repo, eventPath: event, base: value.base, head: unrelated, policy: ".agent-vigil.json", policyRef: value.base });
  assert.equal(report.summary.status, "FAIL");
  assert.ok(report.results.some((row) => row.ruleId === "merge-group-range" && row.verdict === "contradicted"));
});
