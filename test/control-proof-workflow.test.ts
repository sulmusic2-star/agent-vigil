import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installKeylessControlProofAction } from "../src/control-proof-workflow.ts";
import { run } from "../src/cli.ts";

const ACTION_COMMIT = "a".repeat(40);
const CHECKOUT_COMMIT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_COMMIT = "820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_COMMIT = "ea165f8d65b6e75b540449e92b4886f43607fa02";
const DOWNLOAD_COMMIT = "634f93cb2916e3fdff6788551b99b062d0335ce0";
const ATTEST_COMMIT = "1e69f48acb82d1966a394da916b4c1698aa569d6";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "vigil-keyless-control-proof-install-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function installedWorkflow(): { root: string; workflow: string } {
  const root = repository();
  const result = installKeylessControlProofAction(root, ACTION_COMMIT);
  return { root, workflow: readFileSync(join(root, result.workflow), "utf8") };
}

test("keyless control-proof installer writes a schedule-only split exact-commit workflow", () => {
  const { workflow } = installedWorkflow();
  assert.match(workflow, /^# agent-vigil-keyless-control-proof\/v1/m);
  assert.match(workflow, /^on:\n  schedule:/m);
  assert.doesNotMatch(workflow, /workflow_dispatch|pull_request|push:/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^  build-proof:/m);
  assert.match(workflow, /^  attest-proof:/m);
  assert.equal((workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length, 2);
  assert.equal((workflow.match(/github\.event\.repository\.default_branch/g) ?? []).length, 2);

  const unprivileged = workflow.slice(workflow.indexOf("  build-proof:"), workflow.indexOf("  attest-proof:"));
  assert.match(unprivileged, /permissions:\n      contents: read/);
  assert.doesNotMatch(unprivileged, /id-token: write|attestations: write|artifact-metadata: write/);
  assert.match(unprivileged, new RegExp(`actions/checkout@${CHECKOUT_COMMIT}`));
  assert.match(unprivileged, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(unprivileged, /fetch-depth: 0/);
  assert.match(unprivileged, /persist-credentials: false/);
  assert.match(unprivileged, new RegExp(`actions/setup-node@${SETUP_NODE_COMMIT}`));
  assert.match(unprivileged, /node-version: 22\.23\.2/);
  assert.doesNotMatch(unprivileged, /^\s*node-version:\s*22\s*$/m);
  assert.match(unprivileged, /package-manager-cache: false/);
  assert.doesNotMatch(unprivileged, /cache: (?:npm|yarn|pnpm)/);
  assert.ok(
    unprivileged.indexOf(`actions/setup-node@${SETUP_NODE_COMMIT}`) < unprivileged.indexOf(`actions/checkout@${CHECKOUT_COMMIT}`),
    "the exact trusted host Node.js runtime must be selected before repository code is checked out",
  );
  assert.match(unprivileged, new RegExp(`sulmusic2-star/agent-vigil@${ACTION_COMMIT}`));
  assert.match(unprivileged, /mode: prove/);
  assert.match(unprivileged, /attest: false/);
  assert.match(unprivileged, /steps\.vigil\.outputs\.report/);
  assert.match(unprivileged, /steps\.vigil\.outputs\.control-proof-predicate/);
  assert.match(unprivileged, /if: always\(\)/);
  assert.match(unprivileged, /if: always\(\) && steps\.vigil\.outputs\.report != '' && steps\.vigil\.outputs\.control-proof-predicate != ''/);
  assert.match(unprivileged, new RegExp(`actions/upload-artifact@${UPLOAD_COMMIT}`));
  assert.match(unprivileged, /name: agent-vigil-control-proof-unsigned-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(unprivileged, /retention-days: 1/);
  const unsignedPaths = unprivileged.match(/retention-days: 1\n          path: \|\n((?:            .+\n)+)/)?.[1];
  assert.ok(unsignedPaths);
  assert.deepEqual(unsignedPaths.trim().split("\n").map((line) => line.trim()), [
    "${{ steps.vigil.outputs.report }}",
    "${{ steps.vigil.outputs.control-proof-predicate }}",
  ]);

  const privileged = workflow.slice(workflow.indexOf("  attest-proof:"));
  assert.match(privileged, /needs: build-proof/);
  assert.match(privileged, /if: always\(\) && needs\.build-proof\.result != 'cancelled'/);
  for (const permission of ["actions: read", "contents: read", "id-token: write", "attestations: write", "artifact-metadata: write"]) {
    assert.match(privileged, new RegExp(permission));
  }
  assert.match(privileged, new RegExp(`actions/download-artifact@${DOWNLOAD_COMMIT}`));
  assert.match(privileged, /name: agent-vigil-control-proof-unsigned-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(privileged, /must contain exactly the proof and predicate/);
  assert.match(privileged, /16 \* 1024 \* 1024/);
  assert.match(privileged, /1024 \* 1024/);
  assert.match(privileged, /isFile\(\).*isSymbolicLink\(\)/s);
  assert.match(privileged, /constants\.O_NOFOLLOW/);
  assert.match(privileged, /EXPECTED_SOURCE_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(privileged, /proof\.sourceCommit !== expectedSourceCommit/);
  assert.match(privileged, /control proof receipt hash is invalid/);
  assert.match(privileged, /predicate\.proof\.fileSha256 !== sha256\(proofBytes\)/);
  assert.match(privileged, /predicate\.proof\.challengeSetSha256 !== sha256\(canonical\(challengeSet\)\)/);
  assert.match(privileged, new RegExp(`actions/attest@${ATTEST_COMMIT}`));
  assert.match(privileged, new RegExp(`actions/upload-artifact@${UPLOAD_COMMIT}`));
  assert.match(privileged, /Retain the proof, predicate, and attestation bundle\n        if: always\(\)/);
  assert.match(privileged, /name: agent-vigil-control-proof-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(privileged, /retention-days: 90/);
  assert.match(privileged, /steps\.attestation\.outputs\.bundle-path/);
  assert.doesNotMatch(privileged, /actions\/(?:checkout|setup-node)@|sulmusic2-star\/agent-vigil@|uses: \.\/|npm |dist\/cli|github\.workspace|secrets:/);

  assert.doesNotMatch(workflow, /@[vV][0-9]|@main|@master/);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
  const uses = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((match) => match[1]);
  assert.ok(uses.every((value) => /@[0-9a-f]{40}$/.test(value)), `all Actions must be immutable: ${uses.join(", ")}`);
});

test("installer preserves an existing regular workflow unless force is explicit", () => {
  const root = repository();
  const first = installKeylessControlProofAction(root, ACTION_COMMIT);
  const path = join(root, first.workflow);
  const unchanged = installKeylessControlProofAction(root, ACTION_COMMIT);
  assert.deepEqual(unchanged.kept, [first.workflow]);
  writeFileSync(path, "maintainer-owned\n");
  const kept = installKeylessControlProofAction(root, ACTION_COMMIT);
  assert.deepEqual(kept.kept, [first.workflow]);
  assert.equal(readFileSync(path, "utf8"), "maintainer-owned\n");
  installKeylessControlProofAction(root, ACTION_COMMIT, true);
  assert.match(readFileSync(path, "utf8"), /agent-vigil-keyless-control-proof\/v1/);
});

test("installer requires explicit force to migrate a legacy managed OIDC workflow", () => {
  const root = repository();
  const path = join(root, ".github/workflows/agent-vigil-control-proof.yml");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  const legacy = `# agent-vigil-keyless-control-proof/v1
name: Legacy Agent Vigil control proof
on:
  workflow_dispatch:
jobs:
  prove:
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@${CHECKOUT_COMMIT}
      - uses: sulmusic2-star/agent-vigil@${"b".repeat(40)}
        with:
          mode: prove
          attest: true
`;
  writeFileSync(path, legacy);
  assert.throws(
    () => installKeylessControlProofAction(root, ACTION_COMMIT),
    /managed Agent Vigil control-proof workflow.*--force.*migrate/i,
  );
  assert.equal(readFileSync(path, "utf8"), legacy, "legacy managed workflow is never silently overwritten");

  installKeylessControlProofAction(root, ACTION_COMMIT, true);
  const migrated = readFileSync(path, "utf8");
  assert.doesNotMatch(migrated, /workflow_dispatch/);
  assert.match(migrated, /^  build-proof:/m);
  assert.match(migrated, /^  attest-proof:/m);
});

test("installer refuses workflow and parent symlinks even when force is explicit", () => {
  const directRoot = repository();
  const directOutside = join(directRoot, "maintainer-owned.yml");
  const directTarget = join(directRoot, ".github/workflows/agent-vigil-control-proof.yml");
  mkdirSync(join(directRoot, ".github/workflows"), { recursive: true });
  writeFileSync(directOutside, "outside\n");
  symlinkSync(directOutside, directTarget);
  assert.throws(() => installKeylessControlProofAction(directRoot, ACTION_COMMIT, true), /unsafe|symbolic-link/i);
  assert.equal(readFileSync(directOutside, "utf8"), "outside\n");

  const parentRoot = repository();
  const parentOutside = mkdtempSync(join(tmpdir(), "vigil-control-proof-outside-"));
  symlinkSync(parentOutside, join(parentRoot, ".github"));
  assert.throws(() => installKeylessControlProofAction(parentRoot, ACTION_COMMIT, true), /unsafe|symbolic-link/i);
  assert.equal(existsSync(join(parentOutside, "workflows/agent-vigil-control-proof.yml")), false);
});

test("installer rejects mutable refs and non-repositories", () => {
  const root = repository();
  assert.throws(() => installKeylessControlProofAction(root, "v0.17.0"), /full lowercase/);
  assert.throws(() => installKeylessControlProofAction(mkdtempSync(join(tmpdir(), "not-a-repo-")), ACTION_COMMIT), /not a Git repository/);
});

test("installer resolves a nested repo argument to the actual Git top level", () => {
  const root = repository();
  const nested = join(root, "packages/example");
  mkdirSync(nested, { recursive: true });
  const result = installKeylessControlProofAction(nested, ACTION_COMMIT);
  assert.equal(existsSync(join(root, result.workflow)), true);
  assert.equal(existsSync(join(nested, result.workflow)), false);
});

test("certify install-action CLI exposes the split keyless path", () => {
  const root = repository();
  assert.equal(run(["certify", "install-action", "--repo", root, "--action-ref", ACTION_COMMIT]), 0);
  const workflow = readFileSync(join(root, ".github/workflows/agent-vigil-control-proof.yml"), "utf8");
  assert.match(workflow, /attest: false/);
  assert.match(workflow, /^  attest-proof:/m);
  assert.equal(run(["certify", "install-action", "--repo", root, "--action-ref", "main"]), 2);
});
