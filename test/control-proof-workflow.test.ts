import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKeylessControlProofAction } from "../src/control-proof-workflow.ts";
import { run } from "../src/cli.ts";

const ACTION_COMMIT = "a".repeat(40);

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "vigil-keyless-control-proof-install-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("keyless control-proof installer writes one conservative exact-commit workflow", () => {
  const root = repository();
  const result = installKeylessControlProofAction(root, ACTION_COMMIT);
  assert.deepEqual(result.created, [".github/workflows/agent-vigil-control-proof.yml"]);
  const workflow = readFileSync(join(root, result.workflow), "utf8");
  assert.match(workflow, /^# agent-vigil-keyless-control-proof\/v1/m);
  assert.match(workflow, new RegExp(`uses: sulmusic2-star/agent-vigil@${ACTION_COMMIT}`));
  assert.match(workflow, /mode: prove/);
  assert.match(workflow, /attest: true/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /retention-days: 90/);
  assert.match(workflow, /attestation-bundle/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|secrets:/);
  assert.doesNotMatch(workflow, /@[vV][0-9]|@main|@master/);
});

test("installer preserves an existing workflow unless force is explicit", () => {
  const root = repository();
  const first = installKeylessControlProofAction(root, ACTION_COMMIT);
  const path = join(root, first.workflow);
  writeFileSync(path, "maintainer-owned\n");
  const kept = installKeylessControlProofAction(root, ACTION_COMMIT);
  assert.deepEqual(kept.kept, [first.workflow]);
  assert.equal(readFileSync(path, "utf8"), "maintainer-owned\n");
  installKeylessControlProofAction(root, ACTION_COMMIT, true);
  assert.match(readFileSync(path, "utf8"), /agent-vigil-keyless-control-proof\/v1/);
});

test("installer rejects mutable refs and non-repositories", () => {
  const root = repository();
  assert.throws(() => installKeylessControlProofAction(root, "v0.17.0"), /full lowercase/);
  assert.throws(() => installKeylessControlProofAction(mkdtempSync(join(tmpdir(), "not-a-repo-")), ACTION_COMMIT), /not a Git repository/);
});

test("certify install-action CLI exposes the keyless path", () => {
  const root = repository();
  assert.equal(run(["certify", "install-action", "--repo", root, "--action-ref", ACTION_COMMIT]), 0);
  assert.match(readFileSync(join(root, ".github/workflows/agent-vigil-control-proof.yml"), "utf8"), /attest: true/);
  assert.equal(run(["certify", "install-action", "--repo", root, "--action-ref", "main"]), 2);
});
