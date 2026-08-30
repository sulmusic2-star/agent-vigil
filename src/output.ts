import type { CheckResult, TrustReport } from "./report.ts";
import { remediationFor } from "./remediation.ts";
import {
  buildReportResultView,
  validateReportForResult,
  type ReportResultViewOptions,
  type ResultFinding,
  type ResultView,
} from "./result-view.ts";
import { appendPrivateFileAtomic, writePrivateFileAtomic } from "./safe-output.ts";
import { markdownCodeSpan } from "./markdown.ts";

export { remediationFor } from "./remediation.ts";

function markdownText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([*_\[\]<>])/g, "\\$1");
}

function openFindings(view: ResultView): ResultFinding[] {
  return view.findings.filter((finding) => finding.state !== "PASSED");
}

function countLine(view: ResultView): string {
  return `Failed ${view.counts.failed} · Passed ${view.counts.passed} · Not checked ${view.counts.notChecked}`;
}

function textFinding(finding: ResultFinding): string[] {
  const location = finding.location ? `      location: ${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""}` : undefined;
  const testCounts = finding.claimedTestCount !== undefined || finding.observedTestCount !== undefined
    ? `      tests:    claimed ${finding.claimedTestCount ?? "not stated"}; observed ${finding.observedTestCount ?? "not found"}`
    : undefined;
  return [
    `  ${finding.state.replace("_", " ")} [${finding.id}] ${finding.title}`,
    ...(location ? [location] : []),
    `      evidence: ${finding.evidence}`,
    ...(testCounts ? [testCounts] : []),
    `      fix:      ${finding.remediation}`,
  ];
}

export function renderResultText(view: ResultView): string {
  const open = openFindings(view);
  const lines = [
    `Agent Vigil: ${view.verdict}`,
    view.consequence,
    view.mainCause,
    countLine(view),
    "",
  ];
  if (open.length) {
    lines.push("Checks that need attention", ...open.flatMap(textFinding), "");
  } else lines.push("All required checks passed.", "");
  if (view.advisories.length) {
    lines.push(
      `Advisories (${view.advisories.length}; non-blocking under this policy)`,
      ...view.advisories.flatMap((finding) => [
        `  ADVISORY [${finding.id}] ${finding.title}`,
        `      evidence: ${finding.evidence}`,
        `      review:   ${finding.remediation}`,
      ]),
      "",
    );
  }
  lines.push(
    `Change: ${view.base} -> ${view.head}`,
    `Changed files: ${view.changedFiles.complete ? view.changedFiles.files.length : "not checked"}`,
    ...view.changedFiles.files.map((file) => `  ${file.status}: ${file.previousPath ? `${file.previousPath} -> ` : ""}${file.path}`),
    `Receipt: ${view.receiptHash}`,
    `Reproduce: ${view.reproduce}`,
  );
  return lines.join("\n");
}

export function renderText(value: unknown, options: ReportResultViewOptions = {}): string {
  return renderResultText(buildReportResultView(value, options));
}

export function renderResultMarkdown(view: ResultView, options: { aggregateOnly?: boolean } = {}): string {
  const open = openFindings(view);
  const lines = [
    `### Agent Vigil: ${view.verdict}`,
    "",
    `**${markdownText(view.consequence)}**`,
    "",
    options.aggregateOnly ? `Main result: ${view.counts.failed ? `${view.counts.failed} required check(s) failed.` : view.counts.notChecked ? `${view.counts.notChecked} required check(s) did not run.` : "All required checks passed."}` : `**Main result:** ${markdownText(view.mainCause)}`,
    "",
    `**Checks:** ${countLine(view)}`,
  ];
  if (!options.aggregateOnly && open.length) {
    lines.push("", "#### Checks that need attention", "");
    for (const finding of open) {
      const location = finding.location ? ` at ${markdownCodeSpan(`${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""}`)}` : "";
      lines.push(`- **${finding.state.replace("_", " ")}** ${markdownCodeSpan(finding.id)}${location}: ${markdownText(finding.title)}`);
      lines.push(`  - Evidence: ${markdownText(finding.evidence)}`);
      if (finding.claimedTestCount !== undefined || finding.observedTestCount !== undefined) {
        lines.push(`  - Tests: claimed **${finding.claimedTestCount ?? "not stated"}**; observed **${finding.observedTestCount ?? "not found"}**`);
      }
      lines.push(`  - Fix: ${markdownText(finding.remediation)}`);
    }
  }
  if (!options.aggregateOnly && view.advisories.length) {
    lines.push("", `#### Advisories (${view.advisories.length}; non-blocking under this policy)`, "");
    for (const finding of view.advisories) {
      lines.push(`- **ADVISORY** ${markdownCodeSpan(finding.id)}: ${markdownText(finding.title)}`);
      lines.push(`  - Evidence: ${markdownText(finding.evidence)}`);
      lines.push(`  - Review: ${markdownText(finding.remediation)}`);
    }
  }
  lines.push(
    "",
    `**Change:** ${markdownCodeSpan(view.base)} -> ${markdownCodeSpan(view.head)}  `,
    `**Changed files:** ${view.changedFiles.complete ? view.changedFiles.files.length : "not checked"}  `,
    `**Receipt:** ${markdownCodeSpan(view.receiptHash)}`,
    "",
  );
  if (!options.aggregateOnly) lines.push(`Reproduce: ${markdownCodeSpan(view.reproduce)}`, "");
  return lines.join("\n");
}

export function renderMarkdown(value: unknown, options: ReportResultViewOptions = {}): string {
  return renderResultMarkdown(buildReportResultView(value, options));
}

export function renderDecisionCard(value: unknown): string {
  return renderResultMarkdown(buildReportResultView(value), { aggregateOnly: true });
}

function sarifResult(result: CheckResult, advisory = false) {
  const level = advisory ? "warning" : result.verdict === "contradicted" ? "error" : result.verdict === "unverifiable" ? "warning" : "note";
  return {
    ruleId: result.ruleId ?? result.claim.kind,
    level,
    message: { text: `${result.claim.subject}: ${result.evidence}. Remediation: ${remediationFor(result.ruleId)}` },
  };
}

function sarifForValidatedReport(report: TrustReport) {
  const allResults = [...report.results, ...(report.advisories ?? [])];
  const rules = [...new Set(allResults.map((result) => result.ruleId ?? result.claim.kind))].map((id) => ({
    id,
    shortDescription: { text: id.replace(/-/g, " ") },
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "agent-vigil", version: report.vigilVersion, informationUri: "https://github.com/sulmusic2-star/agent-vigil", rules } },
      results: [
        ...report.results.filter((result) => result.verdict !== "verified").map((result) => sarifResult(result)),
        ...(report.advisories ?? []).map((result) => sarifResult(result, true)),
      ],
      properties: { receiptHash: report.receiptHash, status: report.summary.status, advisoryCount: report.advisories?.length ?? 0 },
    }],
  };
}

export function toSarif(value: unknown) {
  return sarifForValidatedReport(validateReportForResult(value));
}

export function writeOutputs(value: unknown, options: {
  output?: string;
  sarif?: string;
  githubSummary?: boolean;
}): void {
  const report = validateReportForResult(value);
  const output = options.output ? `${JSON.stringify(report, null, 2)}\n` : undefined;
  const sarif = options.sarif ? `${JSON.stringify(sarifForValidatedReport(report), null, 2)}\n` : undefined;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const summary = options.githubSummary && summaryPath ? renderDecisionCard(report) : undefined;

  // All untrusted content is parsed, normalized, hash-checked, and rendered
  // before the first destination can be mutated.
  if (options.output && output !== undefined) writePrivateFileAtomic(options.output, output);
  if (options.sarif && sarif !== undefined) writePrivateFileAtomic(options.sarif, sarif);
  if (summaryPath && summary !== undefined) appendPrivateFileAtomic(summaryPath, summary);
}
