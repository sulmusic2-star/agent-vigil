import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DEFAULT_POLICY_FILE, loadPolicy, maintainerPolicyTemplate, policyTemplate } from "./config.ts";
import { inferTestCommand } from "./detectors/reality.ts";
import { loadTranscript } from "./transcript.ts";

type InitResult = { created: string[]; kept: string[] };
type DoctorCheck = { status: "PASS" | "WARN" | "FAIL"; label: string; detail: string };

function workflow(mode: "transcript" | "portable" | "maintainer"): string { return `name: Agent Vigil

on:
  pull_request:

permissions:
  contents: read

jobs:
  evidence:
    name: Agent Vigil evidence
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha }}
      - id: vigil
        uses: sulmusic2-star/agent-vigil@v0.8.0
        with:
          ${mode === "portable" ? "receipt: .agent-vigil/receipt.json" : mode === "maintainer" ? "mode: maintainer" : "transcript: .agent-vigil/session.md"}
          policy: .agent-vigil.json
          policy-ref: \${{ github.event.pull_request.base.sha }}
          repo: .
          base: \${{ github.event.pull_request.base.sha }}
          head: \${{ github.event.pull_request.head.sha }}
      - name: Retain auditable Agent Vigil receipt
        if: always() && steps.vigil.outputs.report != ''
        uses: actions/upload-artifact@v4
        with:
          name: agent-vigil-receipt
          path: agent-vigil-report.json
          retention-days: 30
`; }

const MAINTAINER_PR_TEMPLATE = `## Agent Vigil maintainer evidence

- Responsible human: @REPLACE_WITH_YOUR_GITHUB_LOGIN
- [ ] I reviewed every changed line.
- [ ] I can explain and maintain this change.
- AI assistance: assisted
- Linked issue: #REPLACE
- Known limitations: none known

The declarations above establish responsibility and disclosure. They do not
prove understanding. Agent Vigil independently checks the Git range, scope,
fresh tests, integrity rules, and—when configured—whether the changed regression
test fails against base source and passes against the candidate.
`;

const SESSION_TEMPLATE = `# Agent change receipt

Replace this file with the coding agent's final summary or point
\`.agent-vigil.json\` at a supported exported transcript.

Agent Vigil will independently compare checkable claims with the selected Git
range and fresh verification. This placeholder intentionally contains no claims,
so strict verification remains INCONCLUSIVE until real evidence is supplied.
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

export function initRepository(repo: string, force = false, portableSignerKeyId?: string, profile: "default" | "maintainer" = "default"): InitResult {
  const root = resolve(repo);
  try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" }); }
  catch { throw new Error(`not a Git repository: ${root}`); }
  const result: InitResult = { created: [], kept: [] };
  const inferred = inferTestCommand(root) ?? undefined;
  const mode = profile === "maintainer" ? "maintainer" : portableSignerKeyId ? "portable" : "transcript";
  const setupCommand = existsSync(resolve(root, "package-lock.json")) ? "npm ci --ignore-scripts" : undefined;
  writeScaffold(root, DEFAULT_POLICY_FILE, profile === "maintainer" ? maintainerPolicyTemplate(inferred, setupCommand) : policyTemplate(inferred, portableSignerKeyId), force, result);
  if (mode === "transcript") {
    writeScaffold(root, ".agent-vigil/session.md", SESSION_TEMPLATE, force, result);
    writeScaffold(root, ".agent-vigil/README.md", LOCAL_README, force, result);
  }
  if (mode === "maintainer") writeScaffold(root, ".github/pull_request_template.md", MAINTAINER_PR_TEMPLATE, force, result);
  writeScaffold(root, ".github/workflows/agent-vigil.yml", workflow(mode), force, result);
  return result;
}

function git(repo: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return undefined; }
}

export function doctorRepository(repo: string, requestedPolicy?: string, requestedTranscript?: string): DoctorCheck[] {
  const root = resolve(repo);
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    status: nodeMajor >= 20 ? "PASS" : "FAIL",
    label: "Node.js",
    detail: `${process.versions.node}${nodeMajor >= 20 ? " satisfies Node 20+" : " is unsupported; install Node 20+"}`,
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
      label: "Maintainer evidence",
      detail: existsSync(template) ? "PR responsibility and disclosure template is installed" : "maintainer profile requires .github/pull_request_template.md",
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
          status: "PASS",
          label: "Transcript",
          detail: `${transcript} detected as ${loaded.format}; ${loaded.toolCalls.length} tool call(s)`,
        });
      } catch (error) {
        checks.push({ status: "FAIL", label: "Transcript", detail: (error as Error).message });
      }
    }
  }

  const workflow = resolve(root, ".github/workflows/agent-vigil.yml");
  checks.push({
    status: existsSync(workflow) ? "PASS" : "WARN",
    label: "GitHub Action",
    detail: existsSync(workflow)
      ? "workflow installed; configure Agent Vigil evidence as a required status check after its first run"
      : "workflow not installed; run vigil init",
  });
  if (existsSync(workflow)) {
    const text = readFileSync(workflow, "utf8");
    const exactRange = /pull_request\.base\.sha/.test(text) && /pull_request\.head\.sha/.test(text);
    checks.push({
      status: exactRange ? "PASS" : "WARN",
      label: "Git range",
      detail: exactRange ? "workflow pins the pull request base and head SHAs" : "workflow does not visibly pin both pull request SHAs",
    });
    const exactCheckout = /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/.test(text);
    checks.push({
      status: exactCheckout ? "PASS" : "WARN",
      label: "Checkout identity",
      detail: exactCheckout ? "workflow checks out the exact pull request head SHA" : "workflow may verify GitHub's synthetic merge commit instead of the selected head",
    });
    const anchoredPolicy = /policy-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/.test(text);
    checks.push({
      status: anchoredPolicy ? "PASS" : "WARN",
      label: "Policy trust",
      detail: anchoredPolicy ? "workflow loads policy from the pull request base commit" : "workflow policy may be controlled by the candidate change",
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
