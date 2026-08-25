import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DEFAULT_POLICY_FILE, loadPolicy, maintainerPolicyTemplate, policyTemplate } from "./config.ts";
import { inferTestCommand } from "./detectors/reality.ts";
import { loadTranscript } from "./transcript.ts";
// Generated hosted workflows resolve to the matching stable Action tag. Change
// this only as part of an exact-version release candidate.
const PUBLISHED_ACTION_VERSION = "0.19.0";
import { authorityContractTemplate, loadAuthorityContract } from "./authority.ts";

type InitResult = { created: string[]; kept: string[] };
type DoctorCheck = { status: "PASS" | "WARN" | "FAIL"; label: string; detail: string };
export type SetupProfile = "default" | "maintainer" | "authority" | "protect";

function workflow(mode: "transcript" | "portable" | "maintainer" | "authority", setupCommand?: string, attest = false): string { return `name: Agent Vigil

on:
  pull_request:
    types: [opened, synchronize, reopened]
  merge_group:
    types: [checks_requested]

permissions:
  contents: read
  pull-requests: read
${attest ? `  id-token: write
  attestations: write
  artifact-metadata: write
` : ""}

jobs:
  evidence:
    name: Agent Vigil evidence
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
${mode === "maintainer" && setupCommand ? `      - name: Install dependencies for fresh verification
        run: ${setupCommand}
` : ""}      - id: vigil
        uses: sulmusic2-star/agent-vigil@v${PUBLISHED_ACTION_VERSION}
        with:
          ${attest ? "attest: true\n          " : ""}${mode === "portable" ? "receipt: .agent-vigil/receipt.json" : mode === "maintainer" ? "mode: maintainer" : mode === "authority" ? "transcript: .agent-vigil/session.jsonl\n          authority-contract: .agent-vigil-authority.json\n          authority-contract-ref: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}" : "transcript: .agent-vigil/session.md"}
          policy: .agent-vigil.json
          policy-ref: \${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
          repo: .
          base: \${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
          head: \${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
          github-token: \${{ github.token }}
      - name: Retain auditable Agent Vigil receipt
        if: always() && steps.vigil.outputs.report != ''
        uses: actions/upload-artifact@v4
        with:
          name: agent-vigil-receipt
          path: |
            agent-vigil-report.json
            agent-vigil.sarif
            agent-vigil-value-card.json
            agent-vigil-github-evidence.json
          retention-days: 30
`; }

function outcomeWorkflow(): string { return `name: Agent Vigil outcomes

on:
  workflow_run:
    workflows: [Agent Vigil]
    types: [completed]
  pull_request:
    types: [closed]

permissions:
  actions: read
  contents: read
  pull-requests: read

jobs:
  outcome:
    if: github.event_name == 'pull_request' || github.event.workflow_run.event == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - id: source
        name: Locate the completed evidence run
        env:
          GH_TOKEN: \${{ github.token }}
          EVENT_NAME: \${{ github.event_name }}
          EVENT_RUN_ID: \${{ github.event.workflow_run.id }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          if [[ "$EVENT_NAME" == "workflow_run" ]]; then
            run_id="$EVENT_RUN_ID"
          else
            run_id=$(gh api --method GET "repos/$GITHUB_REPOSITORY/actions/runs" \\
              -f head_sha="$HEAD_SHA" -f event=pull_request -f status=completed \\
              --jq '.workflow_runs | map(select(.name == "Agent Vigil")) | sort_by(.created_at) | reverse | .[0].id // empty')
          fi
          if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
            echo "No completed Agent Vigil receipt run is available for this outcome." >&2
            exit 2
          fi
          echo "run_id=$run_id" >> "$GITHUB_OUTPUT"
      - name: Download the immutable receipt artifact
        uses: actions/download-artifact@v5
        with:
          name: agent-vigil-receipt
          path: .agent-vigil-prior
          github-token: \${{ github.token }}
          run-id: \${{ steps.source.outputs.run_id }}
      - id: outcome
        uses: sulmusic2-star/agent-vigil@v${PUBLISHED_ACTION_VERSION}
        with:
          mode: outcome
          outcome-receipt: .agent-vigil-prior/agent-vigil-report.json
          actions-run-id: \${{ steps.source.outputs.run_id }}
          github-token: \${{ github.token }}
      - name: Retain the post-run Value Card
        if: always() && steps.outcome.outputs.value-card != ''
        uses: actions/upload-artifact@v4
        with:
          name: agent-vigil-outcome-\${{ steps.source.outputs.run_id }}
          path: |
            \${{ steps.outcome.outputs.value-card }}
            \${{ steps.outcome.outputs.github-evidence }}
          retention-days: 30
`; }

const MAINTAINER_PR_TEMPLATE = `## Agent Vigil pull request evidence

- AI assistance: assisted
- Linked issue: #REPLACE
- Known limitations: none known

Agent Vigil uses the policy from the base commit. It checks the exact Git range,
scope, fresh tests, integrity rules, and whether the changed regression test
fails against base source and passes against the candidate. The generated
automated-review policy also runs its own commands in an isolated checkout of the
exact candidate commit. It does not claim that a person reviewed or understands
the change.
`;

const SESSION_TEMPLATE = `# Agent change receipt

Replace this file with the coding agent's final summary or point
\`.agent-vigil.json\` at a supported exported transcript.

Agent Vigil will independently compare checkable claims with the selected Git
range and fresh verification. This placeholder intentionally contains no claims,
so strict verification remains INCONCLUSIVE until real evidence is supplied.
`;

const AUTHORITY_SESSION_TEMPLATE = `{"type":"session_meta","payload":{"id":"replace-with-exported-structured-session"}}
`;

const LOCAL_README = `# Agent Vigil evidence input

The workflow reads \`session.md\` by default. Replace it with the agent's actual
final summary, or change \`transcript\` in \`../.agent-vigil.json\` to an exported
Codex, Claude Code, Cursor, Gemini CLI, GitHub Copilot CLI, OpenCode, or Aider
transcript.

Transcripts can contain source code, prompts, paths, and secrets. Review them
before committing or uploading. Agent Vigil reads evidence locally and does not
upload it.
`;

function writeScaffold(root: string, path: string, content: string, force: boolean, result: InitResult): void {
  const target = resolve(root, path);
  if (existsSync(target) && !force) { result.kept.push(path); return; }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  result.created.push(path);
}

function inferProtectCommands(root: string, testCommand?: string): string[] {
  const commands: string[] = [];
  const packagePath = resolve(root, "package.json");
  if (existsSync(packagePath)) {
    try {
      const scripts = JSON.parse(readFileSync(packagePath, "utf8"))?.scripts ?? {};
      for (const name of ["typecheck", "lint", "build"] as const) {
        if (typeof scripts[name] === "string" && scripts[name].trim()) commands.push(`npm run ${name}`);
      }
    } catch {
      // Policy validation and doctor will report malformed package metadata.
    }
  }
  if (testCommand) commands.push(testCommand);
  return [...new Set(commands)].slice(0, 8);
}

export function initRepository(repo: string, force = false, portableSignerKeyId?: string, profile: SetupProfile = "default", attest = false): InitResult {
  const root = resolve(repo);
  try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" }); }
  catch { throw new Error(`not a Git repository: ${root}`); }
  const result: InitResult = { created: [], kept: [] };
  const inferred = inferTestCommand(root) ?? undefined;
  const mode = profile === "maintainer" || profile === "protect" ? "maintainer" : profile === "authority" ? "authority" : portableSignerKeyId ? "portable" : "transcript";
  const setupCommand = existsSync(resolve(root, "package-lock.json")) ? "npm ci --ignore-scripts" : undefined;
  const defaultPolicy = policyTemplate(inferred, portableSignerKeyId);
  const authorityPolicy = defaultPolicy.replace('"transcript": ".agent-vigil/session.md"', '"transcript": ".agent-vigil/session.jsonl"');
  const protectCommands = profile === "protect" ? inferProtectCommands(root, inferred) : undefined;
  writeScaffold(root, DEFAULT_POLICY_FILE, mode === "maintainer" ? maintainerPolicyTemplate(inferred, setupCommand, protectCommands) : mode === "authority" ? authorityPolicy : defaultPolicy, force, result);
  if (mode === "transcript" || mode === "authority") {
    writeScaffold(root, mode === "authority" ? ".agent-vigil/session.jsonl" : ".agent-vigil/session.md", mode === "authority" ? AUTHORITY_SESSION_TEMPLATE : SESSION_TEMPLATE, force, result);
    writeScaffold(root, ".agent-vigil/README.md", LOCAL_README, force, result);
  }
  if (mode === "authority") writeScaffold(root, ".agent-vigil-authority.json", authorityContractTemplate(), force, result);
  if (mode === "maintainer") writeScaffold(root, ".github/pull_request_template.md", MAINTAINER_PR_TEMPLATE, force, result);
  writeScaffold(root, ".github/workflows/agent-vigil.yml", workflow(mode, setupCommand, attest), force, result);
  writeScaffold(root, ".github/workflows/agent-vigil-outcomes.yml", outcomeWorkflow(), force, result);
  return result;
}

function git(repo: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return undefined; }
}

export function doctorRepository(repo: string, requestedPolicy?: string, requestedTranscript?: string): DoctorCheck[] {
  const root = resolve(repo);
  const checks: DoctorCheck[] = [];
  const workflow = resolve(root, ".github/workflows/agent-vigil.yml");
  const outcomeObserver = resolve(root, ".github/workflows/agent-vigil-outcomes.yml");
  const installedWorkflow = existsSync(workflow) ? readFileSync(workflow, "utf8") : "";
  const authorityConfigured = /^\s*authority-contract:\s*\S+\s*$/m.test(installedWorkflow);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    status: nodeMajor >= 20 ? "PASS" : "FAIL",
    label: "Node.js",
    detail: `${process.versions.node}${nodeMajor >= 20 ? " satisfies Node 20+" : " is unsupported; install Node 20+"}`,
  });
  checks.push({
    status: existsSync(outcomeObserver) ? "PASS" : "WARN",
    label: "Outcome observer",
    detail: existsSync(outcomeObserver)
      ? "post-run workflow retains final Actions runtime and later pull-request outcome evidence without re-executing candidate code"
      : "outcome workflow is missing; rerun vigil init to add post-run evidence closure",
  });
  const gitRoot = git(root, ["rev-parse", "--show-toplevel"]);
  checks.push({
    status: gitRoot ? "PASS" : "FAIL",
    label: "Git repository",
    detail: gitRoot ?? `${root} is not inside a readable Git repository`,
  });

  let transcript = requestedTranscript;
  let portableReceipt: string | undefined;
  let maintainer = false;
  let maintainerReviewMode: "human" | "automated" | "legacy" = "legacy";
  try {
    const policy = loadPolicy(root, requestedPolicy);
    checks.push({
      status: policy.path ? "PASS" : "WARN",
      label: "Policy",
      detail: policy.path ? `${relative(root, policy.path)} · ${policy.sha256}` : `no ${DEFAULT_POLICY_FILE}; CLI defaults will be used`,
    });
    transcript ??= policy.value.transcript;
    portableReceipt = policy.value.portableReceipt;
    maintainer = Boolean(policy.value.maintainer);
    if (policy.value.maintainer?.reviewMode) maintainerReviewMode = policy.value.maintainer.reviewMode;
    const command = policy.value.testCommand ?? inferTestCommand(root);
    const placeholder = command === "REPLACE_WITH_TEST_COMMAND";
    checks.push({
      status: placeholder ? "FAIL" : command ? "PASS" : "WARN",
      label: "Fresh verification",
      detail: placeholder ? "replace REPLACE_WITH_TEST_COMMAND in .agent-vigil.json" : command ? `test command: ${command}` : "no test command inferred; use policy testCommand or --test-cmd",
    });
    if (portableReceipt) {
      const signerCount = policy.value.trustedSignerKeyIds?.length ?? 0;
      checks.push({
        status: signerCount ? "PASS" : "FAIL",
        label: "Portable signer",
        detail: signerCount ? `${signerCount} signer key ID(s) pinned by policy` : "portable receipt mode requires trustedSignerKeyIds",
      });
    }
  } catch (error) {
    checks.push({ status: "FAIL", label: "Policy", detail: (error as Error).message });
  }

  if (portableReceipt) {
    const path = resolve(root, portableReceipt);
    checks.push({
      status: existsSync(path) ? "PASS" : "WARN",
      label: "Portable receipt",
      detail: existsSync(path)
        ? `${portableReceipt} is present; run vigil gate to verify it`
        : `${portableReceipt} will be created after the next signed code change; raw transcript remains local`,
    });
  } else if (maintainer) {
    const template = resolve(root, ".github/pull_request_template.md");
    checks.push({
      status: existsSync(template) ? "PASS" : "FAIL",
      label: "Pull request evidence",
      detail: existsSync(template) ? "AI-assistance, linked-issue, and limitations template is installed" : "maintainer profile requires .github/pull_request_template.md",
    });
    checks.push({
      status: maintainerReviewMode === "automated" ? "PASS" : maintainerReviewMode === "human" ? "PASS" : "WARN",
      label: "Review mode",
      detail: maintainerReviewMode === "automated"
        ? "base policy runs explicit automated-review commands in an isolated exact-commit checkout"
        : maintainerReviewMode === "human"
        ? "base policy requires named human review declarations"
        : "legacy policy does not name a reviewMode; set human or automated explicitly",
    });
  } else if (!transcript) {
    checks.push({ status: "WARN", label: "Transcript", detail: "no transcript configured; pass a path or run vigil init" });
  } else {
    const path = resolve(root, transcript);
    if (!existsSync(path)) checks.push({ status: "WARN", label: "Transcript", detail: `${transcript} does not exist yet` });
    else {
      try {
        const loaded = loadTranscript(path);
        checks.push({
          status: authorityConfigured && loaded.toolCalls.length === 0 ? "FAIL" : "PASS",
          label: "Transcript",
          detail: authorityConfigured && loaded.toolCalls.length === 0
            ? `${transcript} is ${loaded.format} with no structured tool calls; authority mode requires a supported structured export`
            : `${transcript} detected as ${loaded.format}; ${loaded.toolCalls.length} tool call(s)`,
        });
      } catch (error) {
        checks.push({ status: "FAIL", label: "Transcript", detail: (error as Error).message });
      }
    }
  }

  checks.push({
    status: existsSync(workflow) ? "PASS" : "WARN",
    label: "GitHub Action",
    detail: existsSync(workflow)
      ? "workflow installed; configure Agent Vigil evidence as a required status check after its first run"
      : "workflow not installed; run vigil init",
  });
  if (existsSync(workflow)) {
    const text = installedWorkflow;
    const attestationEnabled = /^\s*attest:\s*true\s*$/m.test(text);
    if (attestationEnabled) {
      const permissionsPresent = /^\s*id-token:\s*write\s*$/m.test(text)
        && /^\s*attestations:\s*write\s*$/m.test(text)
        && /^\s*artifact-metadata:\s*write\s*$/m.test(text);
      const repositoryWrite = /^\s*contents:\s*write\s*$/m.test(text);
      checks.push({
        status: !permissionsPresent ? "FAIL" : repositoryWrite ? "WARN" : "PASS",
        label: "GitHub attestation",
        detail: !permissionsPresent
          ? "attest: true requires id-token, attestations, and artifact-metadata write permissions"
          : repositoryWrite
          ? "receipt signing is configured, but this workflow can also write repository contents; remove that permission unless another reviewed step requires it"
          : "receipt attestation is enabled with the required GitHub permissions",
      });
    }
    const exactRange = /pull_request\.base\.sha/.test(text) && /pull_request\.head\.sha/.test(text);
    checks.push({
      status: exactRange ? "PASS" : "WARN",
      label: "Git range",
      detail: exactRange ? "workflow pins the pull request base and head SHAs" : "workflow does not visibly pin both pull request SHAs",
    });
    const exactCheckout = /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.event\.merge_group\.head_sha\s*\}\}/.test(text);
    checks.push({
      status: exactCheckout ? "PASS" : "WARN",
      label: "Checkout identity",
      detail: exactCheckout ? "workflow checks out the exact pull request head SHA" : "workflow may verify GitHub's synthetic merge commit instead of the selected head",
    });
    const anchoredPolicy = /policy-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}/.test(text);
    checks.push({
      status: anchoredPolicy ? "PASS" : "WARN",
      label: "Policy trust",
      detail: anchoredPolicy ? "workflow loads policy from the pull request base commit" : "workflow policy may be controlled by the candidate change",
    });
    const mergeQueue = /merge_group:\s*\n\s*types:\s*\[checks_requested\]/.test(text)
      && /merge_group\.base_sha/.test(text)
      && /merge_group\.head_sha/.test(text);
    checks.push({
      status: mergeQueue ? "PASS" : "WARN",
      label: "Merge queue",
      detail: mergeQueue ? "workflow re-verifies the composed merge-group commit" : "required check will not report for GitHub merge queues",
    });
    if (maintainer) {
      const modeInstalled = /mode:\s*maintainer/.test(text);
      const artifactInstalled = /name:\s*agent-vigil-receipt/.test(text);
      checks.push({
        status: modeInstalled && artifactInstalled ? "PASS" : "FAIL",
        label: "Maintainer workflow",
        detail: modeInstalled && artifactInstalled ? "maintainer mode and receipt artifact retention are installed" : "workflow must enable maintainer mode and retain agent-vigil-receipt",
      });
    }
    const authorityMatch = text.match(/^\s*authority-contract:\s*(\S+)\s*$/m);
    if (authorityMatch) {
      try {
        const contract = loadAuthorityContract(root, authorityMatch[1]);
        const placeholder = contract.value.taskId === "REPLACE_WITH_TASK_OR_TICKET_ID";
        const expired = Boolean(contract.value.expiresAt && Date.now() > new Date(contract.value.expiresAt).getTime());
        const anchored = /^\s*authority-contract-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}\s*$/m.test(text);
        checks.push({
          status: placeholder || expired || !anchored ? "FAIL" : "PASS",
          label: "Task authority",
          detail: placeholder ? "replace the generated taskId before use" : expired ? `contract expired at ${contract.value.expiresAt}` : !anchored ? "workflow must load authority from the GitHub event base" : `${contract.value.taskId} · ${contract.sha256} · base-anchored`,
        });
      } catch (error) {
        checks.push({ status: "FAIL", label: "Task authority", detail: (error as Error).message });
      }
    }
  }
  return checks;
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const icon = { PASS: "✓", WARN: "!", FAIL: "✗" } as const;
  const lines = ["Agent Vigil doctor", ""];
  for (const check of checks) lines.push(`${icon[check.status]} ${check.status.padEnd(4)} ${check.label}: ${check.detail}`);
  const failed = checks.filter((check) => check.status === "FAIL").length;
  const warned = checks.filter((check) => check.status === "WARN").length;
  lines.push("", `${failed} failure(s) · ${warned} warning(s)`);
  return lines.join("\n");
}
