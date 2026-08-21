import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DEFAULT_POLICY_FILE, loadPolicy, policyTemplate } from "./config.ts";
import { inferTestCommand } from "./detectors/reality.ts";
import { loadTranscript } from "./transcript.ts";

type InitResult = { created: string[]; kept: string[] };
type DoctorCheck = { status: "PASS" | "WARN" | "FAIL"; label: string; detail: string };

const WORKFLOW = `name: Agent Vigil

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
      - uses: sulmusic2-star/agent-vigil@v0.5.0
        with:
          transcript: .agent-vigil/session.md
          policy: .agent-vigil.json
          policy-ref: \${{ github.event.pull_request.base.sha }}
          repo: .
          base: \${{ github.event.pull_request.base.sha }}
          head: \${{ github.event.pull_request.head.sha }}
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

export function initRepository(repo: string, force = false): InitResult {
  const root = resolve(repo);
  try { execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" }); }
  catch { throw new Error(`not a Git repository: ${root}`); }
  const result: InitResult = { created: [], kept: [] };
  const inferred = inferTestCommand(root) ?? undefined;
  writeScaffold(root, DEFAULT_POLICY_FILE, policyTemplate(inferred), force, result);
  writeScaffold(root, ".agent-vigil/session.md", SESSION_TEMPLATE, force, result);
  writeScaffold(root, ".agent-vigil/README.md", LOCAL_README, force, result);
  writeScaffold(root, ".github/workflows/agent-vigil.yml", WORKFLOW, force, result);
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
  try {
    const policy = loadPolicy(root, requestedPolicy);
    checks.push({
      status: policy.path ? "PASS" : "WARN",
      label: "Policy",
      detail: policy.path ? `${relative(root, policy.path)} · ${policy.sha256}` : `no ${DEFAULT_POLICY_FILE}; CLI defaults will be used`,
    });
    transcript ??= policy.value.transcript;
    const command = policy.value.testCommand ?? inferTestCommand(root);
    checks.push({
      status: command ? "PASS" : "WARN",
      label: "Fresh verification",
      detail: command ? `test command: ${command}` : "no test command inferred; use policy testCommand or --test-cmd",
    });
  } catch (error) {
    checks.push({ status: "FAIL", label: "Policy", detail: (error as Error).message });
  }

  if (!transcript) {
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
