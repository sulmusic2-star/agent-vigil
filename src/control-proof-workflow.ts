import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CHECKOUT_COMMIT = "11d5960a326750d5838078e36cf38b85af677262";
const UPLOAD_COMMIT = "ea165f8d65b6e75b540449e92b4886f43607fa02";
const FULL_COMMIT = /^[0-9a-f]{40}$/;

export type InstallControlProofActionResult = {
  created: string[];
  kept: string[];
  actionCommit: string;
  workflow: string;
};

function keylessControlProofWorkflow(actionCommit: string): string {
  return `# agent-vigil-keyless-control-proof/v1
name: Agent Vigil control proof

on:
  workflow_dispatch:
  schedule:
    - cron: "17 9 * * 1"

permissions:
  contents: read
  id-token: write
  attestations: write
  artifact-metadata: write

jobs:
  prove:
    name: Challenge the installed control
    runs-on: ubuntu-latest
    steps:
      - name: Check out the exact source commit
        uses: actions/checkout@${CHECKOUT_COMMIT}
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: \${{ github.sha }}
      - id: vigil
        name: Run and sign the control proof
        uses: sulmusic2-star/agent-vigil@${actionCommit}
        with:
          mode: prove
          attest: true
          repo: .
          head: \${{ github.sha }}
      - name: Retain the proof and GitHub attestation bundle
        if: always() && steps.vigil.outputs.report != ''
        uses: actions/upload-artifact@${UPLOAD_COMMIT}
        with:
          name: agent-vigil-control-proof-\${{ github.run_id }}
          if-no-files-found: error
          retention-days: 90
          path: |
            \${{ steps.vigil.outputs.report }}
            \${{ steps.vigil.outputs.attestation-bundle }}
`;
}

function assertRepository(root: string): void {
  try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" }); }
  catch { throw new Error(`not a Git repository: ${root}`); }
}

export function installKeylessControlProofAction(repo: string, actionCommit: string, force = false): InstallControlProofActionResult {
  const root = resolve(repo);
  assertRepository(root);
  if (!FULL_COMMIT.test(actionCommit)) throw new Error("--action-ref must be a full lowercase Agent Vigil commit SHA");
  const workflow = ".github/workflows/agent-vigil-control-proof.yml";
  const target = resolve(root, workflow);
  const result: InstallControlProofActionResult = { created: [], kept: [], actionCommit, workflow };
  if (existsSync(target) && !force) {
    result.kept.push(workflow);
    return result;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, keylessControlProofWorkflow(actionCommit));
  result.created.push(workflow);
  return result;
}
