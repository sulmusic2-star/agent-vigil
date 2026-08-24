import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendContinuityEvent, initializeContinuityChain } from "../src/continuity/chain.ts";
import { sha256, type ContinuityEventDraft, type ContinuityPolicy, type ContinuityRoot } from "../src/continuity/contracts.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { generateSigningKey, publicKeyId, signReport } from "../src/signature.ts";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function continuityEvent(root: ContinuityRoot, sequence: number, at: string, kind: ContinuityEventDraft["event"]["kind"], source: string, disposition: ContinuityEventDraft["event"]["disposition"]): ContinuityEventDraft {
  return {
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: `urn:uuid:00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    subject: root.subject,
    source: {
      kind: source,
      issuer: sha256(`issuer-${sequence}`),
      evidenceHash: sha256(`evidence-${sequence}`),
      deliveryIdHash: source === "github-outcome" ? sha256(`delivery-${sequence}`) : null,
    },
    event: {
      kind,
      disposition,
      reasonCode: `${kind}.fixture`,
      targetHash: sha256(`target-${sequence}`),
      freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
      supersedesEventId: null,
    },
    observedAt: at,
    effectiveAt: at,
    privacyTier: "receipt",
  };
}

function fixture(options: { includeMerge?: boolean; maxAgeSeconds?: number } = {}): { repo: string; chain: string; base: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "vigil-continuity-action-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  const privateKey = join(repo, "root-private.pem");
  const publicKey = join(repo, "root-public.pem");
  generateSigningKey(privateKey, publicKey);
  const policy: ContinuityPolicy = {
    schemaVersion: "agent-vigil-continuity-policy/v1",
    requiredSources: ["verification", "github-outcome"],
    maxAgeSeconds: { verification: options.maxAgeSeconds ?? 3600, "github-outcome": options.maxAgeSeconds ?? 3600 },
    denyOn: ["revert_observed", "incident_linked", "attestation_invalid", "credential_revoked"],
    allowRemediation: true,
    requireSignedRoot: true,
    requireSignedEvents: false,
    trustedRootKeyIds: [publicKeyId(publicKey)],
    trustedIssuerKeyIds: [],
    protectedEnvironments: ["production"],
    maxClockSkewSeconds: 300,
  };
  writeFileSync(join(repo, ".agent-vigil-continuity.json"), `${JSON.stringify(policy, null, 2)}\n`);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", ".agent-vigil-continuity.json", "README.md");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "README.md"), "reviewed change\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "reviewed change");
  const head = git(repo, "rev-parse", "HEAD");
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "fixture passed", subject: "fixture" },
    verdict: "verified",
    evidence: "deterministic fixture",
  };
  const report = signReport(buildReport({
    transcript: "private/session.jsonl",
    transcriptSha256: sha256("transcript"),
    transcriptFormat: "codex",
    repo,
    base,
    head,
    results: [result],
    policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: sha256("policy") },
    repository: { remote: "https://github.com/example/protected.git", tree },
    reproduction: "private command",
  }), privateKey);
  const receipt = join(repo, "receipt.json");
  writeFileSync(receipt, `${JSON.stringify(report, null, 2)}\n`);
  const chain = join(repo, "continuity-chain");
  const root = initializeContinuityChain(receipt, chain, new Date(Date.now() - 120_000));
  const first = new Date(Date.now() - 90_000).toISOString();
  const second = new Date(Date.now() - 60_000).toISOString();
  appendContinuityEvent(chain, continuityEvent(root, 1, first, "verification_refreshed", "verification", "affirm"));
  if (options.includeMerge !== false) appendContinuityEvent(chain, continuityEvent(root, 2, second, "merge_observed", "github-outcome", "affirm"));
  return { repo, chain, base, head };
}

function actionScript(root: string): string {
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  const block = action.match(/    - id: vigil[\s\S]+?      run: \|\n([\s\S]+?)    - id: prepare_attestation/)?.[1];
  assert.ok(block, "composite Action continuity script is present");
  const scriptText = block.split("\n").map((line) => line.startsWith("        ") ? line.slice(8) : line).join("\n");
  const script = join(root, "run.sh");
  writeFileSync(script, scriptText);
  return script;
}

function runAction(value: ReturnType<typeof fixture>, script: string, root: string, head = value.head, githubRepository = "example/protected"): ReturnType<typeof spawnSync> {
  const output = join(root, "output");
  const summary = join(root, "summary");
  const runner = join(root, "runner");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  mkdirSync(runner, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION_PATH: process.cwd(),
    GITHUB_REPOSITORY: githubRepository,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    RUNNER_TEMP: runner,
    VIGIL_MODE: "continuity",
    VIGIL_CONTINUITY_CHAIN: value.chain,
    VIGIL_CONTINUITY_ENVIRONMENT: "production",
    VIGIL_REPO: value.repo,
    VIGIL_BASE: value.base,
    VIGIL_HEAD: head,
    VIGIL_POLICY: ".agent-vigil-continuity.json",
    VIGIL_POLICY_REF: value.base,
    VIGIL_ATTEST: "false",
    VIGIL_TRANSCRIPT: "",
    VIGIL_RECEIPT: "",
    VIGIL_AUTHORITY_CONTRACT: "",
    VIGIL_AUTHORITY_CONTRACT_REF: "",
    VIGIL_OUTCOME_RECEIPT: "",
    VIGIL_ACTIONS_RUN_ID: "",
    VIGIL_TEST_CMD: "",
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
  return spawnSync("bash", [script], { cwd: value.repo, encoding: "utf8", env });
}

test("the GitHub Action permits only the exact current change and emits a private short explanation", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const value = fixture();
  const root = mkdtempSync(join(tmpdir(), "vigil-continuity-action-"));
  const script = actionScript(root);
  const accepted = runAction(value, script, root);
  assert.equal(accepted.status, 0, `${accepted.stderr}\n${accepted.stdout}`);
  assert.match(readFileSync(join(root, "output"), "utf8"), /^status=CURRENT$/m);
  assert.match(readFileSync(join(root, "output"), "utf8"), /agent-vigil-continuity-decision\.json/);
  assert.match(readFileSync(join(root, "summary"), "utf8"), /Deployment check: allowed/);
  assert.equal(readFileSync(join(root, "summary"), "utf8").includes(value.repo), false);

  const wrongHead = runAction(value, script, root, "f".repeat(40));
  assert.equal(wrongHead.status, 1, `${wrongHead.stderr}\n${wrongHead.stdout}`);
  assert.match(readFileSync(join(root, "output"), "utf8"), /^status=REVOKED$/m);
  assert.match(readFileSync(join(root, "summary"), "utf8"), /Deployment check: stopped/);

  const wrongRepository = runAction(value, script, root, value.head, "example/other");
  assert.equal(wrongRepository.status, 1, `${wrongRepository.stderr}\n${wrongRepository.stdout}`);
  assert.match(readFileSync(join(root, "output"), "utf8"), /^status=REVOKED$/m);

  const decisionPath = join(value.repo, "agent-vigil-continuity-decision.json");
  rmSync(decisionPath);
  const protectedFile = join(value.repo, "must-not-change.txt");
  writeFileSync(protectedFile, "unchanged\n");
  symlinkSync(protectedFile, decisionPath);
  const redirected = runAction(value, script, root);
  assert.equal(redirected.status, 2, `${redirected.stderr}\n${redirected.stdout}`);
  assert.match(readFileSync(join(root, "output"), "utf8"), /^status=HOLD$/m);
  assert.equal(readFileSync(protectedFile, "utf8"), "unchanged\n");
});

test("the GitHub Action stops both missing and expired evidence", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-continuity-action-denials-"));
  const script = actionScript(root);

  const held = fixture({ includeMerge: false });
  const heldRun = runAction(held, script, root);
  assert.equal(heldRun.status, 3, `${heldRun.stderr}\n${heldRun.stdout}`);
  assert.match(readFileSync(join(root, "output"), "utf8"), /^status=HOLD$/m);
  assert.match(readFileSync(join(root, "summary"), "utf8"), /Required records are missing/);

  const expired = fixture({ maxAgeSeconds: 1 });
  const expiredRun = runAction(expired, script, root);
  assert.equal(expiredRun.status, 4, `${expiredRun.stderr}\n${expiredRun.stdout}`);
  assert.match(readFileSync(join(root, "output"), "utf8"), /^status=EXPIRED$/m);
  assert.match(readFileSync(join(root, "summary"), "utf8"), /Required records are too old/);
});
