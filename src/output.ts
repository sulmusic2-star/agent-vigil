import { appendFileSync, writeFileSync } from "node:fs";
import type { CheckResult, TrustReport } from "./report.ts";

const icon = { verified: "✓", contradicted: "✗", unverifiable: "?" } as const;

export function renderText(report: TrustReport): string {
  const lines = [
    `agent-vigil ${report.vigilVersion} — evidence receipt`,
    `  transcript: ${report.transcript} (${report.transcriptFormat})`,
    `  digest:     ${report.transcriptSha256}`,
    `  repo:       ${report.repo}`,
    `  range:      ${report.base}..${report.head}`,
    "",
  ];
  for (const result of report.results) {
    lines.push(`  ${icon[result.verdict]} [${result.ruleId ?? result.claim.kind}] ${result.claim.subject}`);
    lines.push(`      claim:    "${result.claim.quote.slice(0, 140)}"`);
    lines.push(`      evidence: ${result.evidence}`, "");
  }
  const summary = report.summary;
  lines.push(`  ${summary.verified} verified · ${summary.contradicted} contradicted · ${summary.unverifiable} unresolved`);
  lines.push(`  ${summary.status} · ${report.receiptHash}`);
  if (summary.status === "INCONCLUSIVE") lines.push("  Missing or unresolved evidence prevents a trustworthy pass.");
  return lines.join("\n");
}

export function renderMarkdown(report: TrustReport): string {
  const rows = report.results.map((result) =>
    `| ${icon[result.verdict]} ${result.verdict} | \`${result.ruleId ?? result.claim.kind}\` | ${escapeCell(result.claim.subject)} | ${escapeCell(result.evidence)} |`,
  );
  return [
    `# Agent Vigil: ${report.summary.status}`,
    "",
    `**Receipt:** \`${report.receiptHash}\`  `,
    `**Range:** \`${report.base}..${report.head}\`  `,
    `**Transcript:** \`${report.transcript}\` (${report.transcriptFormat})`,
    "",
    "| Verdict | Rule | Claim | Evidence |",
    "|---|---|---|---|",
    ...rows,
    "",
    `${report.summary.verified} verified · ${report.summary.contradicted} contradicted · ${report.summary.unverifiable} unresolved`,
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
    message: { text: `${result.claim.subject}: ${result.evidence}` },
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
  if (options.output) writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  if (options.sarif) writeFileSync(options.sarif, `${JSON.stringify(toSarif(report), null, 2)}\n`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (options.githubSummary && summaryPath) appendFileSync(summaryPath, renderMarkdown(report));
}
