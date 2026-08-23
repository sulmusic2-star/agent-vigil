import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildControlProof,
  decideControlProof,
  renderControlProof,
  type ControlProofChallenge,
} from "../src/control-proof.ts";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "vigil-control-proof-fixture-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "vigil@example.test"]);
  git(repo, ["config", "user.name", "Vigil Test"]);
  writeFileSync(join(repo, "README.md"), "control proof fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

test("control proof observes every planted decision and removes its disposable clone", () => {
  const repo = fixture();
  try {
    const report = buildControlProof(repo, "HEAD", "test-version");
    assert.equal(report.status, "PASS");
    assert.deepEqual(report.summary, { passed: 7, total: 7 });
    assert.deepEqual(
      Object.fromEntries(report.challenges.map((item) => [item.id, item.actual])),
      {
        "clean-control": "PASS",
        "unapproved-mcp-server": "BLOCK",
        "candidate-self-approval": "BLOCK",
        "unreadable-authority-config": "HOLD",
        "sandbox-weakening": "BLOCK",
        "skipped-test": "BLOCK",
        "disposable-cleanup": "PASS",
      },
    );
    assert.ok(report.challenges.every((item) => item.passed));
    assert.match(report.receiptHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(report).includes(repo), false, "receipt must not disclose the source path");
    assert.match(renderControlProof(report), /^Agent Vigil control proof: PASS/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("one unexpected challenge result holds the whole proof", () => {
  const challenges: ControlProofChallenge[] = [{
    id: "planted",
    claim: "A planted failure is blocked.",
    expected: "BLOCK",
    actual: "PASS",
    passed: false,
    base: "base",
    head: "head",
    evidence: "the control unexpectedly allowed the change",
  }];
  assert.equal(decideControlProof(challenges), "HOLD");
  assert.equal(decideControlProof([]), "HOLD");
});

test("control proof rendering escapes terminal control characters", () => {
  const challenge: ControlProofChallenge = {
    id: "terminal",
    claim: "bad\u001b[2J\u202eclaim",
    expected: "BLOCK",
    actual: "PASS",
    passed: false,
    base: "base",
    head: "head",
    evidence: "bad\u001b[2J",
  };
  const rendered = renderControlProof({
    schemaVersion: "agent-vigil-control-proof/v1",
    vigilVersion: "test",
    status: "HOLD",
    sourceCommit: "source",
    generatedAt: "2026-08-23T00:00:00.000Z",
    receiptHash: "sha256:test",
    challenges: [challenge],
    summary: { passed: 0, total: 1 },
    reproduction: "vigil prove",
    limits: [],
  });
  assert.doesNotMatch(rendered, /\u001b|\u202e/u);
  assert.match(rendered, /\\u\{001B\}|\\u\{202E\}/);
});

test("composite Action prove mode returns the control receipt without synthetic Value Card output", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const repo = fixture();
  const aux = mkdtempSync(join(tmpdir(), "vigil-control-proof-action-"));
  try {
    const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
    const block = action.match(/      run: \|\n([\s\S]*?)\n    - id: prepare_attestation/)?.[1];
    assert.ok(block);
    const script = join(aux, "run.sh");
    const output = join(aux, "output");
    const summary = join(aux, "summary");
    const runner = join(aux, "runner");
    mkdirSync(runner);
    writeFileSync(script, block.split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n"));
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_ACTION_PATH: process.cwd(),
      GITHUB_EVENT_PATH: "",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: runner,
      VIGIL_TRANSCRIPT: "",
      VIGIL_RECEIPT: "",
      VIGIL_AUTHORITY_CONTRACT: "",
      VIGIL_AUTHORITY_CONTRACT_REF: "",
      VIGIL_MODE: "prove",
      VIGIL_OUTCOME_RECEIPT: "",
      VIGIL_ACTIONS_RUN_ID: "",
      VIGIL_REPO: repo,
      VIGIL_BASE: "HEAD~1",
      VIGIL_HEAD: "HEAD",
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
    assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
    const outputs = readFileSync(output, "utf8");
    assert.match(outputs, /^status=PASS$/m);
    assert.match(outputs, /^sarif=$/m);
    assert.match(outputs, /^value_card=$/m);
    const reportPath = /^report=(.+)$/m.exec(outputs)?.[1];
    assert.ok(reportPath);
    assert.ok(reportPath.startsWith(`${runner}/`));
    assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).status, "PASS");
    assert.equal(existsInOutput(outputs, "agent-vigil-value-card.json"), false);

    const conflicting = spawnSync("bash", [script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, VIGIL_TRANSCRIPT: "session.md" },
    });
    assert.equal(conflicting.status, 2);
    assert.match(conflicting.stderr, /prove mode cannot be combined with another evidence input/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(aux, { recursive: true, force: true });
  }
});

function existsInOutput(output: string, name: string): boolean {
  return output.split("\n").some((line) => line.includes(name));
}
