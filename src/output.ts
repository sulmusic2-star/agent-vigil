import type { CheckResult, TrustReport } from "./report.ts";
import { remediationFor } from "./remediation.ts";
import {
  buildReportResultView,
  primaryResultFinding,
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

function displayVerdict(view: ResultView): "PASS" | "FAIL" | "NOT CHECKED" {
  return view.verdict === "INCONCLUSIVE" ? "NOT CHECKED" : view.verdict;
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
  const primary = primaryResultFinding(view.findings);
  const lines = [
    `Agent Vigil: ${displayVerdict(view)}`,
    view.consequence,
    `Reason: ${view.mainCause}`,
  ];
  if (primary) {
    if (primary.location) lines.push(`File: ${primary.location.file}${primary.location.line ? `:${primary.location.line}` : ""}`);
    if (primary.claimedTestCount !== undefined || primary.observedTestCount !== undefined) {
      lines.push(`Tests: claimed ${primary.claimedTestCount ?? "not stated"}; observed ${primary.observedTestCount ?? "not found"}`);
    }
    lines.push(`Fix: ${primary.remediation}`);
  }
  lines.push(
    `Reproduce: ${view.reproduce}`,
    "",
    `Details: ${countLine(view)}${view.advisories.length ? ` · Review notes ${view.advisories.length}` : ""}`,
    `Change: ${view.base} -> ${view.head}`,
    `Receipt: ${view.receiptHash}`,
  );
  return lines.join("\n");
}

export function renderText(value: unknown, options: ReportResultViewOptions = {}): string {
  return renderResultText(buildReportResultView(value, options));
}

export function renderResultMarkdown(view: ResultView, options: { aggregateOnly?: boolean } = {}): string {
  const primary = primaryResultFinding(view.findings);
  const lines = [
    `### Agent Vigil: ${displayVerdict(view)}`,
    "",
    `**${markdownText(view.consequence)}**`,
    "",
    options.aggregateOnly
      ? `Result: ${view.counts.failed ? `${view.counts.failed} required check(s) failed.` : view.counts.notChecked ? `${view.counts.notChecked} required check(s) did not run.` : "All required checks passed."}`
      : `**Reason:** ${markdownText(view.mainCause)}`,
  ];
  if (!options.aggregateOnly && primary) {
    const location = primary.location ? ` at ${markdownCodeSpan(`${primary.location.file}${primary.location.line ? `:${primary.location.line}` : ""}`)}` : "";
    lines.push("", `**Fix:** ${markdownText(primary.remediation)}${location}`);
    if (primary.claimedTestCount !== undefined || primary.observedTestCount !== undefined) {
      lines.push(`**Tests:** claimed **${primary.claimedTestCount ?? "not stated"}**; observed **${primary.observedTestCount ?? "not found"}**`);
    }
    lines.push("", `Reproduce: ${markdownCodeSpan(view.reproduce)}`);
  }
  lines.push(
    "",
    "<details><summary>Receipt details</summary>",
    "",
    `Checks: ${countLine(view)}${view.advisories.length ? ` · Review notes ${view.advisories.length}` : ""}  `,
    `Change: ${markdownCodeSpan(view.base)} -> ${markdownCodeSpan(view.head)}  `,
    `Receipt: ${markdownCodeSpan(view.receiptHash)}`,
    "",
    "</details>",
  );
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
