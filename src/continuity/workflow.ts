import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { writePrivateFileAtomic } from "../safe-output.ts";
import type { ContinuityPolicy } from "./contracts.ts";

const ACTION_COMMIT = /^[0-9a-f]{40}$/;
const CHECKOUT_COMMIT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_COMMIT = "820762786026740c76f36085b0efc47a31fe5020";
const HOSTED_NODE_VERSION = "22.23.2";
const DOWNLOAD_COMMIT = "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD_COMMIT = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

export type ContinuityInstallResult = {
  repository: string;
  created: string[];
  replaced: string[];
  actionCommit: string;
  selfServe: boolean;
};

function repositoryRoot(path: string): string {
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolve(path), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("--repo must name a Git repository");
  }
  const canonical = realpathSync(root);
  if (!lstatSync(canonical).isDirectory()) throw new Error("Git repository root is not a directory");
  return canonical;
}

function ensureSafeParent(root: string, target: string): void {
  const relative = target.slice(root.length).split(sep).filter(Boolean).slice(0, -1);
  let current = root;
  for (const part of relative) {
    current = join(current, part);
    if (existsSync(current)) {
      const status = lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("continuity setup refuses symbolic-link or non-directory parents");
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

function policyTemplate(): ContinuityPolicy {
  return {
    schemaVersion: "agent-vigil-continuity-policy/v1",
    requiredSources: ["verification", "github-outcome"],
    maxAgeSeconds: { verification: 86_400, "github-outcome": 86_400 },
    denyOn: ["revert_observed", "incident_linked", "attestation_invalid", "credential_revoked"],
    allowRemediation: true,
    requireSignedRoot: true,
    requireSignedEvents: true,
    trustedRootKeyIds: [],
    trustedIssuerKeyIds: [],
    protectedEnvironments: ["production"],
    maxClockSkewSeconds: 300,
  };
}

function workflow(actionCommit: string, sourceWorkflow: string): string {
  return `name: Agent Vigil continuity gate

on:
  workflow_run:
    workflows: [${JSON.stringify(sourceWorkflow)}]
    types: [completed]
  workflow_dispatch:
    inputs:
      artifact_run_id:
        description: Run ID containing the agent-vigil-continuity artifact
        required: true
        type: string
      expected_head:
        description: Exact reviewed commit in that artifact
        required: true
        type: string
      environment:
        description: Protected environment named by the policy
        required: true
        default: production
        type: string

permissions:
  actions: read
  contents: read

jobs:
  continuity:
    name: Check whether the change is still approved
    runs-on: ubuntu-latest
    outputs:
      state: \${{ steps.vigil.outputs.status }}
      head: \${{ steps.identity.outputs.head }}
      environment: \${{ steps.source.outputs.environment }}
    steps:
      - name: Select trusted Node.js 22 without dependency caching
        uses: actions/setup-node@${SETUP_NODE_COMMIT}
        with:
          node-version: ${HOSTED_NODE_VERSION}
          package-manager-cache: false
      - id: source
        name: Select the exact evidence run
        env:
          EVENT_NAME: \${{ github.event_name }}
          EVENT_RUN_ID: \${{ github.event.workflow_run.id }}
          EVENT_HEAD: \${{ github.event.workflow_run.head_sha }}
          EVENT_CONCLUSION: \${{ github.event.workflow_run.conclusion }}
          INPUT_RUN_ID: \${{ inputs.artifact_run_id }}
          INPUT_HEAD: \${{ inputs.expected_head }}
          INPUT_ENVIRONMENT: \${{ inputs.environment }}
        run: |
          if [[ "$EVENT_NAME" == "workflow_run" ]]; then
            if [[ "$EVENT_CONCLUSION" != "success" ]]; then
              echo "The evidence run did not complete successfully." >&2
              exit 3
            fi
            run_id="$EVENT_RUN_ID"
            expected_head="$EVENT_HEAD"
            environment="production"
          else
            run_id="$INPUT_RUN_ID"
            expected_head="$INPUT_HEAD"
            environment="$INPUT_ENVIRONMENT"
          fi
          if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
            echo "The evidence run ID is invalid." >&2
            exit 2
          fi
          if [[ ! "$expected_head" =~ ^[0-9a-f]{40}$ ]]; then
            echo "The expected commit must be a full lowercase commit ID." >&2
            exit 2
          fi
          if [[ ! "$environment" =~ ^[a-z0-9][a-z0-9._-]{0,79}$ ]]; then
            echo "The protected environment name is invalid." >&2
            exit 2
          fi
          {
            echo "run_id=$run_id"
            echo "expected_head=$expected_head"
            echo "environment=$environment"
          } >> "$GITHUB_OUTPUT"
      - name: Download the recorded continuity history
        uses: actions/download-artifact@${DOWNLOAD_COMMIT}
        with:
          name: agent-vigil-continuity
          path: \${{ runner.temp }}/agent-vigil-continuity-\${{ github.run_id }}-\${{ github.run_attempt }}
          github-token: \${{ github.token }}
          run-id: \${{ steps.source.outputs.run_id }}
      - id: identity
        name: Read the exact base and head commits
        env:
          EXPECTED_HEAD: \${{ steps.source.outputs.expected_head }}
          CHAIN_ROOT: \${{ runner.temp }}/agent-vigil-continuity-\${{ github.run_id }}-\${{ github.run_attempt }}
        run: |
          node <<'NODE'
          const fs = require("node:fs");
          const path = require("node:path");
          const root = JSON.parse(fs.readFileSync(path.join(process.env.CHAIN_ROOT, "root.json"), "utf8"));
          const full = /^[0-9a-f]{40}$/;
          if (!full.test(root?.subject?.baseSha ?? "") || !full.test(root?.subject?.headSha ?? "")) {
            throw new Error("The continuity history does not contain full commit IDs.");
          }
          if (root.subject.headSha !== process.env.EXPECTED_HEAD) {
            throw new Error("The continuity history belongs to a different commit.");
          }
          fs.appendFileSync(process.env.GITHUB_OUTPUT, "base=" + root.subject.baseSha + "\\nhead=" + root.subject.headSha + "\\n");
          NODE
      - name: Check out the exact reviewed commit without stored credentials
        uses: actions/checkout@${CHECKOUT_COMMIT}
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: \${{ steps.identity.outputs.head }}
      - id: vigil
        name: Decide whether deployment is allowed
        uses: sulmusic2-star/agent-vigil@${actionCommit}
        with:
          mode: continuity
          continuity-chain: \${{ runner.temp }}/agent-vigil-continuity-\${{ github.run_id }}-\${{ github.run_attempt }}
          continuity-environment: \${{ steps.source.outputs.environment }}
          policy: .agent-vigil-continuity.json
          policy-ref: \${{ steps.identity.outputs.base }}
          repo: .
          head: \${{ steps.identity.outputs.head }}
      - name: Retain the decision
        if: always() && steps.vigil.outputs.report != ''
        uses: actions/upload-artifact@${UPLOAD_COMMIT}
        with:
          name: agent-vigil-continuity-decision-\${{ steps.source.outputs.run_id }}
          path: \${{ steps.vigil.outputs.report }}
          retention-days: 30

  deployment:
    name: Protected deployment placeholder
    needs: continuity
    if: needs.continuity.outputs.state == 'CURRENT'
    runs-on: ubuntu-latest
    environment: \${{ needs.continuity.outputs.environment }}
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${CHECKOUT_COMMIT}
        with:
          fetch-depth: 1
          persist-credentials: false
          ref: \${{ needs.continuity.outputs.head }}
      - name: Reviewed deployment step goes here
        run: echo "Continuity accepted. Add reviewed deployment steps here."
`;
}

function labWorkflow(actionCommit: string): string {
  return `# agent-vigil-continuity-lab/v1
name: Agent Vigil continuity lab

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  demonstration:
    name: Build the five-step evidence history
    runs-on: ubuntu-latest
    outputs:
      revoked: \${{ steps.result.outputs.revoked }}
      repaired: \${{ steps.result.outputs.repaired }}
    steps:
      - name: Check out the reviewed Agent Vigil source
        uses: actions/checkout@${CHECKOUT_COMMIT}
        with:
          repository: sulmusic2-star/agent-vigil
          ref: ${actionCommit}
          path: agent-vigil-continuity-tool
          persist-credentials: false
      - id: result
        name: Prove revocation and independent repair
        env:
          REPORT_PATH: \${{ runner.temp }}/agent-vigil-continuity-lab.json
        run: |
          node agent-vigil-continuity-tool/dist/cli.js continuity demo --format json --output "$REPORT_PATH" >/dev/null
          node <<'NODE'
          const fs = require("node:fs");
          const report = JSON.parse(fs.readFileSync(process.env.REPORT_PATH, "utf8"));
          const revoked = report.steps?.find((step) => step.step === 3)?.result;
          const regreened = report.steps?.find((step) => step.step === 4)?.result;
          const repaired = report.steps?.find((step) => step.step === 5)?.result;
          if (revoked !== "REVOKED" || regreened !== "REVOKED" || repaired !== "CURRENT") {
            throw new Error("The continuity lab did not reach the required states.");
          }
          fs.appendFileSync(process.env.GITHUB_OUTPUT, "revoked=" + revoked + "\\nrepaired=" + repaired + "\\n");
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
            "## Continuity Lab result",
            "",
            "Synthetic demonstration only. No software was deployed.",
            "",
            "| Later evidence | Permission to deploy |",
            "|---|---|",
            "| Verified merge and fresh check | Allowed |",
            "| Authenticated revert | Stopped |",
            "| Another ordinary green check | Still stopped |",
            "| Independent signed repair | Allowed again |",
            "",
          ].join("\\n"));
          NODE
      - name: Retain the readable result
        uses: actions/upload-artifact@${UPLOAD_COMMIT}
        with:
          name: agent-vigil-continuity-lab
          path: \${{ runner.temp }}/agent-vigil-continuity-lab.json
          retention-days: 7

  blocked-deployment:
    name: Deployment stays stopped after the revert
    needs: demonstration
    if: needs.demonstration.outputs.revoked == 'CURRENT'
    runs-on: ubuntu-latest
    steps:
      - run: echo "This harmless placeholder should remain skipped."

  repaired-action:
    name: Independent repair restores permission
    needs: demonstration
    if: needs.demonstration.outputs.repaired == 'CURRENT'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Independent signed repair restored permission. No deployment was performed."
`;
}

export function installContinuityAction(options: {
  repo: string;
  actionCommit: string;
  sourceWorkflow?: string;
  force?: boolean;
  selfServe?: boolean;
}): ContinuityInstallResult {
  if (!ACTION_COMMIT.test(options.actionCommit)) throw new Error("--action-ref must be a full lowercase 40-character commit ID");
  const sourceWorkflow = options.sourceWorkflow ?? "Agent Vigil";
  if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(sourceWorkflow)) throw new Error("--source-workflow contains unsupported characters");
  const root = repositoryRoot(options.repo);
  const files = [
    { path: ".agent-vigil-continuity.json", content: `${JSON.stringify(policyTemplate(), null, 2)}\n` },
    { path: ".github/workflows/agent-vigil-continuity.yml", content: workflow(options.actionCommit, sourceWorkflow) },
    ...(options.selfServe ? [{
      path: ".github/workflows/agent-vigil-continuity-lab.yml",
      content: labWorkflow(options.actionCommit),
    }] : []),
  ];
  const result: ContinuityInstallResult = {
    repository: root,
    created: [],
    replaced: [],
    actionCommit: options.actionCommit,
    selfServe: Boolean(options.selfServe),
  };
  if (!options.force) {
    const existing = files.find((file) => existsSync(resolve(root, file.path)));
    if (existing) throw new Error(`${existing.path} already exists; use --force only after reviewing the current file`);
  }
  for (const file of files) {
    const destination = resolve(root, file.path);
    ensureSafeParent(root, destination);
    const replaced = existsSync(destination);
    writePrivateFileAtomic(destination, file.content);
    (replaced ? result.replaced : result.created).push(file.path);
  }
  return result;
}
