import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGitHubEvidence, loadGitHubEvidence, recomputeGitHubEvidenceHash } from "../src/github-evidence.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { loadTranscript } from "../src/transcript.ts";
import { run } from "../src/cli.ts";

function json(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

function evidenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "vigil-github-evidence-"));
  const event = json(root, "event.json", {
    repository: { full_name: "owner/repo" }, number: 42,
    pull_request: {
      number: 42, state: "closed", merged: true, created_at: "2026-08-20T10:00:00Z",
      updated_at: "2026-08-21T11:00:00Z", closed_at: "2026-08-21T11:00:00Z",
      merged_at: "2026-08-21T11:00:00Z", merge_commit_sha: "c".repeat(40),
      base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) },
    },
  });
  const reviews = json(root, "reviews.json", [
    { user: { login: "maintainer" }, state: "CHANGES_REQUESTED", submitted_at: "2026-08-20T11:00:00Z" },
    { user: { login: "maintainer" }, state: "APPROVED", submitted_at: "2026-08-21T10:00:00Z" },
    { user: { login: "observer" }, state: "COMMENTED", submitted_at: "2026-08-21T10:30:00Z" },
  ]);
  const reviewComments = json(root, "comments.json", [{ id: 1, body: "private content" }, { id: 2, body: "more" }]);
  const actionsRun = json(root, "run.json", {
    id: 99, run_attempt: 2, status: "completed", conclusion: "success",
    run_started_at: "2026-08-21T10:00:00Z", updated_at: "2026-08-21T10:10:00Z",
  });
  const actionsJobs = json(root, "jobs.json", { jobs: [
    { started_at: "2026-08-21T10:00:00Z", completed_at: "2026-08-21T10:04:00Z", conclusion: "success" },
    { started_at: "2026-08-21T10:04:00Z", completed_at: "2026-08-21T10:10:00Z", conclusion: "failure" },
  ] });
  const incident = json(root, "incident.json", { number: 7, state: "open", labels: [{ name: "incident" }], created_at: "2026-08-22T12:00:00Z", body: "not copied" });
  const revert = json(root, "revert.json", { sha: "f".repeat(40), commit: { message: `Revert bad change\n\nThis reverts commit ${"b".repeat(40)}.`, committer: { date: "2026-08-22T11:00:00Z" } } });
  const hotfix = json(root, "hotfix.json", { number: 43, state: "closed", merged: true, merged_at: "2026-08-22T10:00:00Z", labels: [{ name: "hotfix" }] });
  return { root, event, reviews, reviewComments, actionsRun, actionsJobs, incident, revert, hotfix };
}

function passResult(): CheckResult {
  return { claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" }, verdict: "verified", evidence: "fresh suite passed", ruleId: "tests-pass" };
}

function receiptFixture(root: string) {
  const transcript = json(root, "codex.jsonl", undefined);
  const rows = [
    { type: "session_meta", payload: { id: "s" } },
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "tests pass" }] } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } } } },
  ];
  writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const loaded = loadTranscript(transcript);
  const report = buildReport({
    transcript: "codex.jsonl", transcriptSha256: loaded.transcriptSha256, transcriptFormat: loaded.format,
    repo: root, base: "a".repeat(40), head: "b".repeat(40), results: [passResult()],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"d".repeat(64)}` },
  });
  const receipt = json(root, "receipt.json", report);
  return { transcript, receipt };
}

test("GitHub evidence normalizes review lifecycle and Actions runtime without copying bodies", () => {
  const fx = evidenceFixture();
  const bundle = buildGitHubEvidence({
    event: fx.event, reviews: fx.reviews, "review-comments": fx.reviewComments,
    "actions-run": fx.actionsRun, "actions-jobs": fx.actionsJobs,
  });
  assert.equal(bundle.pullRequest?.merged, true);
  assert.deepEqual(bundle.reviews, { records: 3, reviewers: 2, approved: 1, changesRequested: 0, dismissed: 0, commented: 1, latestSubmittedAt: "2026-08-21T10:30:00.000Z" });
  assert.deepEqual(bundle.actions, {
    runId: 99, attempt: 2, status: "completed", conclusion: "success",
    startedAt: "2026-08-21T10:00:00.000Z", completedAt: "2026-08-21T10:10:00.000Z",
    runDurationSeconds: 600, jobs: 2, jobDurationSeconds: 600, failedJobs: 1, billing: "UNAVAILABLE",
  });
  assert.equal(bundle.inference.disposition, "accepted");
  assert.equal(bundle.inference.outcome, "merged");
  assert.equal(JSON.stringify(bundle).includes("private content"), false);
  assert.equal(recomputeGitHubEvidenceHash(bundle), bundle.evidenceHash);
});

test("explicit incident, revert, and hotfix markers take conservative outcome priority", () => {
  const fx = evidenceFixture();
  const incident = buildGitHubEvidence({ event: fx.event, "incident-issue": fx.incident });
  assert.equal(incident.inference.outcome, "incident-linked");
  const revert = buildGitHubEvidence({ event: fx.event, "revert-commit": fx.revert });
  assert.equal(revert.inference.outcome, "reverted");
  const hotfix = buildGitHubEvidence({ event: fx.event, "hotfix-pull-request": fx.hotfix });
  assert.equal(hotfix.inference.outcome, "hotfixed");
});

test("adverse outcome markers reject unlabeled or structurally unrelated JSON", () => {
  const fx = evidenceFixture();
  const unrelated = json(fx.root, "unrelated.json", { number: 99, state: "open", labels: [] });
  assert.throws(() => buildGitHubEvidence({ event: fx.event, "incident-issue": unrelated }), /must carry an incident/);
  assert.throws(() => buildGitHubEvidence({ event: fx.event, "revert-commit": unrelated }), /must be a commit object/);
  assert.throws(() => buildGitHubEvidence({ event: fx.event, "hotfix-pull-request": fx.event }), /labeled hotfix/);
});

test("incomplete Actions jobs are not misreported as failed", () => {
  const fx = evidenceFixture();
  const jobs = json(fx.root, "incomplete-jobs.json", { jobs: [{ started_at: "2026-08-21T10:00:00Z", completed_at: null, conclusion: null }] });
  const bundle = buildGitHubEvidence({ event: fx.event, "actions-jobs": jobs });
  assert.equal(bundle.actions?.failedJobs, 0);
});

test("GitHub evidence CLI writes an access-restricted bundle and value imports its accepted merge evidence", () => {
  const fx = evidenceFixture();
  const bundlePath = join(fx.root, "bundle.json");
  assert.equal(run(["github-evidence", "--event", fx.event, "--reviews", fx.reviews, "--output", bundlePath]), 0);
  if (process.platform !== "win32") assert.equal(statSync(bundlePath).mode & 0o777, 0o600);
  const bundle = loadGitHubEvidence(bundlePath);
  assert.equal(bundle.inference.outcome, "merged");

  const { transcript, receipt } = receiptFixture(fx.root);
  const cost = json(fx.root, "billing.json", { cost: 1.25 });
  const cardPath = join(fx.root, "card.json");
  assert.equal(run([
    "value", receipt, "--transcript", transcript, "--github-evidence", bundlePath,
    "--cost-usd", "1.25", "--cost-source", "provider-billed", "--cost-evidence", cost,
    "--format", "json", "--output", cardPath,
  ]), 0);
  const card = JSON.parse(readFileSync(cardPath, "utf8"));
  assert.equal(card.valueVerdict, "POSITIVE");
  assert.equal(card.human.disposition, "accepted");
  assert.equal(card.outcome.state, "merged");
  assert.equal(card.github.pullRequestNumber, 42);
  assert.equal(card.github.actionsBilling, "UNAVAILABLE");
});

test("composite Action outcome mode closes a prior receipt without executing repository verification", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-outcome-action-"));
  const { receipt } = receiptFixture(root);
  const event = json(root, "workflow-run-event.json", { repository: { full_name: "owner/repo" }, workflow_run: { id: 99, event: "pull_request", pull_requests: [] } });
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  const block = action.match(/      run: \|\n([\s\S]*?)\n    - id: prepare_attestation/)?.[1];
  assert.ok(block);
  const script = join(root, "run.sh");
  const output = join(root, "output");
  const summary = join(root, "summary");
  const runnerPath = join(root, "runner");
  mkdirSync(runnerPath);
  const runner = realpathSync(runnerPath);
  writeFileSync(script, block.split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n"));
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: process.cwd(), GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: runner,
    VIGIL_TRANSCRIPT: "", VIGIL_RECEIPT: "", VIGIL_AUTHORITY_CONTRACT: "", VIGIL_AUTHORITY_CONTRACT_REF: "",
    VIGIL_MODE: "outcome", VIGIL_OUTCOME_RECEIPT: "receipt.json", VIGIL_ACTIONS_RUN_ID: "99",
    VIGIL_REPO: ".", VIGIL_BASE: "HEAD~1", VIGIL_HEAD: "HEAD", VIGIL_TEST_CMD: "", VIGIL_POLICY: "", VIGIL_POLICY_REF: "",
    VIGIL_STRICT: "true", VIGIL_MIN_VERIFIED: "1", VIGIL_GITHUB_TOKEN: "",
    VIGIL_VALUE_TASK_CLASS: "bugfix", VIGIL_VALUE_BUDGET_USD: "", VIGIL_VALUE_COST_USD: "", VIGIL_VALUE_COST_SOURCE: "",
    VIGIL_VALUE_COST_EVIDENCE: "", VIGIL_VALUE_REVIEW_MINUTES: "", VIGIL_REVERT_EVIDENCE: "", VIGIL_HOTFIX_EVIDENCE: "", VIGIL_INCIDENT_EVIDENCE: "",
  };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  const completed = spawnSync("bash", [script], { cwd: root, encoding: "utf8", env });
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.equal(outputs.status, "PASS");
  assert.match(outputs.value_card, /\/agent-vigil-value-card\.json$/);
  assert.match(outputs.github_evidence, /\/agent-vigil-github-evidence\.json$/);
  assert.ok(outputs.value_card.startsWith(`${runner}/`));
  assert.ok(outputs.github_evidence.startsWith(`${runner}/`));
  assert.equal(JSON.parse(readFileSync(outputs.value_card, "utf8")).task.taskClass, "bugfix");
  assert.equal(JSON.parse(readFileSync(outputs.github_evidence, "utf8")).schemaVersion, "agent-vigil-github-evidence/v1");
  assert.equal(existsSync(join(root, "agent-vigil-value-card.json")), false);
  assert.equal(existsSync(join(root, "agent-vigil-github-evidence.json")), false);
});

test("open PR event stays unreviewed and unknown instead of becoming accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-github-open-"));
  const event = json(root, "event.json", { repository: { full_name: "owner/repo" }, number: 1, pull_request: { number: 1, state: "open", merged: false } });
  const bundle = buildGitHubEvidence({ event });
  assert.equal(bundle.inference.disposition, "unreviewed");
  assert.equal(bundle.inference.outcome, "unknown");
  assert.equal(bundle.inference.outcomeEvidence, "UNAVAILABLE");
});

test("GitHub evidence fails closed on tampering, malformed arrays, and oversized inputs", () => {
  const fx = evidenceFixture();
  const path = join(fx.root, "bundle.json");
  const bundle = buildGitHubEvidence({ event: fx.event });
  writeFileSync(path, JSON.stringify(bundle));
  const tampered = JSON.parse(readFileSync(path, "utf8"));
  tampered.inference.outcome = "reverted";
  writeFileSync(path, JSON.stringify(tampered));
  assert.throws(() => loadGitHubEvidence(path), /hash is invalid/);

  const badReviews = json(fx.root, "bad-reviews.json", { reviews: [] });
  assert.throws(() => buildGitHubEvidence({ event: fx.event, reviews: badReviews }), /must be an array/);

  const oversized = join(fx.root, "oversized.json");
  writeFileSync(oversized, "");
  truncateSync(oversized, 32 * 1024 * 1024 + 1);
  assert.throws(() => buildGitHubEvidence({ event: oversized }), /maximum/);
});
