import type { CheckResult, TrustReport } from "./report.ts";
import { appendPrivateFileAtomic, writePrivateFileAtomic } from "./safe-output.ts";

const icon = { verified: "✓", contradicted: "✗", unverifiable: "?" } as const;

export function remediationFor(ruleId?: string): string {
  const fixes: Record<string, string> = {
    "test-count": "Run the configured test command without truncating its output, then report the observed passing count exactly; use `vigil doctor` to inspect command selection.",
    "tests-pass": "Run `vigil doctor`, configure policy `testCommand` when inference is absent, and preserve the fresh runner's complete output.",
    "file-changed": "Inspect `git diff --name-only <base>..<head>`, pass those exact SHAs, then correct the claimed path.",
    "path-exists": "Create the claimed artifact or remove the unsupported claim.",
    "path-outside-repo": "Reference a repository-relative path that resolves inside the checkout.",
    "file-outside-repo": "Reference only repository-relative changed files.",
    "command-ran": "Export the complete supported tool trajectory, rerun the claimed command, and preserve its terminal result event.",
    "tool-loop": "Stop the repeated call, inspect its result, and record the next distinct action.",
    "test-count-drop": "Restore removed tests or document and review the intentional test-surface change.",
    "test-skip-added": "Remove the new skip/focus marker or obtain an explicit reviewed exception.",
    "verification-bypass": "Remove the verification bypass and let the underlying check fail honestly.",
    "suppression-added": "Remove the new suppression or narrow it with an explicit reviewed justification.",
    "coverage-weakened": "Restore a meaningful coverage threshold.",
    "assertion-drop": "Restore equivalent assertions or review the intentional reduction explicitly.",
    "completion-marker": "Resolve the added unfinished-work marker before claiming completion.",
    "completion-evidence": "Add at least one independently verifiable path, command, change, or test claim.",
    "workspace-dirty": "Run `git status --short`, commit or remove unbound paths, then rerun with `--head $(git rev-parse HEAD)`.",
    "workspace-unbound": "Commit the candidate change, then rerun with `--head $(git rev-parse HEAD)` instead of WORKTREE.",
    "workspace-mutated": "Make the verification command read-only with respect to tracked inputs, restore the changed paths, and rerun.",
    "portable-signature": "Regenerate the portable receipt from an intact full report with the trusted Ed25519 key.",
    "portable-signer": "Pin the signer key ID in base policy `trustedSignerKeyIds`, or regenerate with an already pinned key.",
    "portable-local-verdict": "Resolve the local FAIL or INCONCLUSIVE result, rerun Agent Vigil, and attach a new signed portable receipt.",
    "portable-policy": "Regenerate the receipt using policy loaded from the pull request base commit.",
    "portable-path": "Set base policy `portableReceipt` and pass that exact repository-relative path.",
    "portable-git-binding": "Regenerate after the latest source commit; after signing, commit only the base-policy-controlled receipt path.",
    "responsible-human": "Set `Responsible human` to the pull request author's exact GitHub login and accept responsibility for the change.",
    "human-review-attestation": "Review every changed line, then check the exact declaration in the pull request template.",
    "human-maintenance-attestation": "Confirm you can explain and maintain the change, then check the exact declaration.",
    "ai-assistance-disclosure": "Set `AI assistance` to exactly `none`, `assisted`, or `agent`.",
    "linked-issue": "Link the maintainer-approved issue as `#123` or a full GitHub issue URL.",
    "changed-file-budget": "Split the change or obtain a reviewed base-policy exception before expanding the file budget.",
    "changed-line-budget": "Split the change, remove unrelated edits, or obtain a reviewed base-policy exception.",
    "test-change-required": "Add a focused regression test under a configured testPathPatterns path.",
    "protected-path": "Remove the protected-path edit and change policy or workflow controls in a separately reviewed pull request.",
    "differential-setup": "Make the base-policy setup command succeed in isolated base and head worktrees; do not hide setup errors.",
    "differential-head-pass": "Fix the candidate until the trusted regression command passes in the isolated head worktree.",
    "differential-base-fail": "Add a regression test that fails against base source and passes against the candidate; a test green on both sides is not catching evidence.",
    "differential-failure-pattern": "Tighten the test or update the base-anchored expected failure pattern through separate review.",
    "differential-test": "Inspect isolated-worktree output, test-path patterns, setup, and timeout; rerun without secrets on the same exact SHAs.",
  };
  return fixes[ruleId ?? ""] ?? "Provide objective evidence or remove the unsupported claim.";
}

export function renderText(report: TrustReport): string {
  const lines = [
    `agent-vigil ${report.vigilVersion} — evidence receipt`,
    `  transcript: ${report.transcript} (${report.transcriptFormat})`,
    `  digest:     ${report.transcriptSha256}`,
    `  repo:       ${report.repo}`,
    `  range:      ${report.base}..${report.head}`,
    `  policy:     ${report.policy.sha256}`,
    "",
  ];
  for (const result of report.results) {
    lines.push(`  ${icon[result.verdict]} [${result.ruleId ?? result.claim.kind}] ${result.claim.subject}`);
    lines.push(`      claim:    "${result.claim.quote.slice(0, 140)}"`);
    lines.push(`      evidence: ${result.evidence}`, "");
    if (result.verdict !== "verified") lines.splice(lines.length - 1, 0, `      fix:      ${remediationFor(result.ruleId)}`);
  }
  const summary = report.summary;
  lines.push(`  ${summary.verified} verified · ${summary.contradicted} contradicted · ${summary.unverifiable} unresolved`);
  lines.push(`  ${summary.status} · ${report.receiptHash}`);
  lines.push(`  reproduce: ${report.reproduction}`);
  if (summary.status === "INCONCLUSIVE") lines.push("  Missing or unresolved evidence prevents a trustworthy pass.");
  return lines.join("\n");
}

export function renderMarkdown(report: TrustReport): string {
  const rows = report.results.map((result) =>
    `| ${icon[result.verdict]} ${result.verdict} | \`${result.ruleId ?? result.claim.kind}\` | ${escapeCell(result.claim.subject)} | ${escapeCell(result.evidence)} |`,
  );
  return [
    `# ${report.summary.status === "PASS" ? "✅" : report.summary.status === "FAIL" ? "❌" : "⚠️"} Agent Vigil: ${report.summary.status}`,
    "",
    `**Receipt:** \`${report.receiptHash}\`  `,
    `**Range:** \`${report.base}..${report.head}\`  `,
    `**Transcript:** \`${report.transcript}\` (${report.transcriptFormat})  `,
    `**Policy:** \`${report.policy.sha256}\``,
    "",
    "| Verdict | Rule | Claim | Evidence |",
    "|---|---|---|---|",
    ...rows,
    "",
    `${report.summary.verified} verified · ${report.summary.contradicted} contradicted · ${report.summary.unverifiable} unresolved`,
    "",
    ...(report.results.some((result) => result.verdict !== "verified") ? [
      "## What to do next",
      "",
      ...report.results.filter((result) => result.verdict !== "verified").map((result) =>
        `- **\`${result.ruleId ?? result.claim.kind}\`**: ${remediationFor(result.ruleId)}`,
      ),
      "",
    ] : []),
    `Reproduce: \`${report.reproduction.replace(/`/g, "\\`")}\``,
    "",
  ].join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

function sarifResult(result: CheckResult) {
  const level = result.verdict === "contradicted" ? "error" : result.verdict === "unverifiable" ? "warning" : "note";
  return {
    ruleId: result.ruleId ?? result.claim.kind,
    level,
    message: { text: `${result.claim.subject}: ${result.evidence}. Remediation: ${remediationFor(result.ruleId)}` },
  };
}

export function toSarif(report: TrustReport) {
  const rules = [...new Set(report.results.map((result) => result.ruleId ?? result.claim.kind))].map((id) => ({
    id,
    shortDescription: { text: id.replace(/-/g, " ") },
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "agent-vigil", version: report.vigilVersion, informationUri: "https://github.com/sulmusic2-star/agent-vigil", rules } },
      results: report.results.filter((result) => result.verdict !== "verified").map(sarifResult),
      properties: { receiptHash: report.receiptHash, status: report.summary.status },
    }],
  };
}

export function writeOutputs(report: TrustReport, options: {
  output?: string;
  sarif?: string;
  githubSummary?: boolean;
}): void {
  if (options.output) writePrivateFileAtomic(options.output, `${JSON.stringify(report, null, 2)}\n`);
  if (options.sarif) writePrivateFileAtomic(options.sarif, `${JSON.stringify(toSarif(report), null, 2)}\n`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (options.githubSummary && summaryPath) appendPrivateFileAtomic(summaryPath, renderMarkdown(report));
}
