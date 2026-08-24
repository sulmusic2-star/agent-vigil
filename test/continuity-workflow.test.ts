import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installContinuityAction } from "../src/continuity/workflow.ts";

const ACTION_COMMIT = "a".repeat(40);

function repository(): string {
  const repo = mkdtempSync(join(tmpdir(), "vigil-continuity-workflow-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

test("continuity setup creates a conservative exact-commit gate without changing existing checks", () => {
  const repo = repository();
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  const existing = "name: Existing required check\n";
  writeFileSync(join(repo, ".github", "workflows", "agent-vigil.yml"), existing);
  const result = installContinuityAction({ repo, actionCommit: ACTION_COMMIT, sourceWorkflow: "Agent Vigil" });
  assert.deepEqual(result.created.sort(), [".agent-vigil-continuity.json", ".github/workflows/agent-vigil-continuity.yml"].sort());
  assert.equal(readFileSync(join(repo, ".github", "workflows", "agent-vigil.yml"), "utf8"), existing);

  const policy = JSON.parse(readFileSync(join(repo, ".agent-vigil-continuity.json"), "utf8"));
  assert.equal(policy.requireSignedRoot, true);
  assert.equal(policy.requireSignedEvents, true);
  assert.deepEqual(policy.trustedRootKeyIds, []);
  assert.deepEqual(policy.trustedIssuerKeyIds, []);
  assert.ok(policy.denyOn.includes("revert_observed"));
  assert.ok(policy.denyOn.includes("incident_linked"));

  const workflow = readFileSync(join(repo, ".github", "workflows", "agent-vigil-continuity.yml"), "utf8");
  assert.match(workflow, new RegExp(`sulmusic2-star/agent-vigil@${ACTION_COMMIT}`));
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/agent-vigil-continuity-/);
  assert.match(workflow, /CHAIN_ROOT: \$\{\{ runner\.temp \}\}\/agent-vigil-continuity-/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /mode: continuity/);
  assert.match(workflow, /policy-ref: \$\{\{ steps\.identity\.outputs\.base \}\}/);
  assert.match(workflow, /head: \$\{\{ steps\.identity\.outputs\.head \}\}/);
  assert.match(workflow, /if: needs\.continuity\.outputs\.state == 'CURRENT'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /Add reviewed deployment steps here/);
  assert.doesNotMatch(workflow, /npm (?:run|publish)|wrangler|kubectl|terraform apply/);
  assert.equal(result.selfServe, false);
});

test("self-serve setup adds a harmless fork-and-run lab without weakening the deployment gate", () => {
  const repo = repository();
  const result = installContinuityAction({ repo, actionCommit: ACTION_COMMIT, selfServe: true });
  assert.equal(result.selfServe, true);
  assert.ok(result.created.includes(".github/workflows/agent-vigil-continuity-lab.yml"));

  const lab = readFileSync(join(repo, ".github", "workflows", "agent-vigil-continuity-lab.yml"), "utf8");
  assert.match(lab, /# agent-vigil-continuity-lab\/v1/);
  assert.match(lab, /workflow_dispatch:/);
  assert.match(lab, new RegExp(`ref: ${ACTION_COMMIT}`));
  assert.match(lab, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(lab, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(lab, /continuity demo --format json/);
  assert.match(lab, /revoked !== "REVOKED"/);
  assert.match(lab, /needs\.demonstration\.outputs\.revoked == 'CURRENT'/);
  assert.match(lab, /Synthetic demonstration only\. No software was deployed/);
  assert.doesNotMatch(lab, /pull_request:|pull_request_target:|secrets\./);
  assert.doesNotMatch(lab, /npm publish|wrangler|kubectl|terraform apply/);

  const policy = JSON.parse(readFileSync(join(repo, ".agent-vigil-continuity.json"), "utf8"));
  assert.deepEqual(policy.trustedRootKeyIds, []);
  assert.deepEqual(policy.trustedIssuerKeyIds, []);
});

test("continuity setup refuses unpinned action versions, accidental replacement, and symbolic-link parents", () => {
  const invalid = repository();
  assert.throws(() => installContinuityAction({ repo: invalid, actionCommit: "v0.17.0" }), /full lowercase/);

  const existing = repository();
  writeFileSync(join(existing, ".agent-vigil-continuity.json"), "keep\n");
  assert.throws(() => installContinuityAction({ repo: existing, actionCommit: ACTION_COMMIT }), /already exists/);
  assert.equal(readFileSync(join(existing, ".agent-vigil-continuity.json"), "utf8"), "keep\n");
  assert.throws(() => readFileSync(join(existing, ".github", "workflows", "agent-vigil-continuity.yml")), /ENOENT/);

  const linked = repository();
  const outside = mkdtempSync(join(tmpdir(), "vigil-continuity-outside-"));
  symlinkSync(outside, join(linked, ".github"));
  assert.throws(() => installContinuityAction({ repo: linked, actionCommit: ACTION_COMMIT }), /symbolic-link/);
});

test("the public continuity lab is manual, harmless, and fork runnable", () => {
  const lab = readFileSync(join(process.cwd(), ".github", "workflows", "agent-vigil-continuity-lab.yml"), "utf8");
  assert.match(lab, /workflow_dispatch:/);
  assert.match(lab, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(lab, /continuity demo --format json/);
  assert.match(lab, /needs\.demonstration\.outputs\.revoked == 'CURRENT'/);
  assert.match(lab, /Independent signed repair restored permission\. No deployment was performed/);
  assert.doesNotMatch(lab, /pull_request:|pull_request_target:|schedule:|secrets\./);
});
