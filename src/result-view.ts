import { validateOutcomeReceipt, type OutcomeVerdict } from "./outcome.ts";
import { remediationFor } from "./remediation.ts";
import { recomputeReceiptHash, validateTrustReport, type CheckResult, type ReportStatus, type TrustReport } from "./report.ts";
import { trustedGit } from "./trusted-git.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export type ResultState = "FAILED" | "PASSED" | "NOT_CHECKED";

export type ResultLocation = {
  file: string;
  line?: number;
};

export type ResultFinding = {
  id: string;
  state: ResultState;
  title: string;
  evidence: string;
  remediation: string;
  location?: ResultLocation;
  claimedTestCount?: number;
  observedTestCount?: number;
};

export type ChangedFile = {
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "unmerged" | "unknown";
  path: string;
  previousPath?: string;
};

export type ChangedFileManifest = {
  complete: boolean;
  files: ChangedFile[];
  evidence: string;
};

export type ResultView = {
  schemaVersion: "agent-vigil/result-view/v1";
  verdict: ReportStatus;
  consequence: string;
  mainCause: string;
  counts: { failed: number; passed: number; notChecked: number };
  findings: ResultFinding[];
  advisories: ResultFinding[];
  base: string;
  head: string;
  generatedAt: string;
  receiptHash: string;
  policyHash?: string;
  reproduce: string;
  changedFiles: ChangedFileManifest;
};

export type ReportResultViewOptions = {
  /** Opt in to a hardened Git query against this caller-trusted repository. */
  trustedRepo?: string;
};

export type OutcomeResultViewOptions = ReportResultViewOptions & {
  trust: { verifierPublicKeyPath?: string; trustedKeyIds?: string[] };
  reproduce?: string;
};

const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHANGED_FILES_MAX_BUFFER = 16 * 1024 * 1024;
const COLON_LOCATION = /(?:^|[\s'"`(])([^\s'"`()]+\.[A-Za-z0-9]{1,12}):(\d+)(?=$|[\s'"`),.;])/;
const CHANGED_LINE_LOCATION = /(?:^|[\s'"`(])([^\s'"`(),]+\.[A-Za-z0-9]{1,12}),\s*(?:changed\s+)?line\s+(\d+)\b/i;
const OBSERVED_TEST_COUNTS = [
  /\b(?:observed|found|with)\s+(\d+)\s+(?:passing\s+)?tests?\b/i,
  /\brunner\s+reported\s+(\d+)\s+passed\b/i,
];

function stateFor(verdict: CheckResult["verdict"]): ResultState {
  return verdict === "verified" ? "PASSED" : verdict === "contradicted" ? "FAILED" : "NOT_CHECKED";
}

function outcomeState(verdict: OutcomeVerdict): ResultState {
  return verdict === "PASS" ? "PASSED" : verdict === "FAIL" ? "FAILED" : "NOT_CHECKED";
}

function consequence(verdict: ReportStatus): string {
  if (verdict === "PASS") return "Ready to merge.";
  if (verdict === "FAIL") return "Do not merge yet.";
  return "No merge decision: a required check did not run.";
}

function safe(value: string): string {
  return terminalSafe(value);
}

function locationFor(result: CheckResult): ResultLocation | undefined {
  const value = `${result.claim.subject} ${result.evidence}`;
  const match = value.match(COLON_LOCATION) ?? value.match(CHANGED_LINE_LOCATION);
  if (!match) return undefined;
  return { file: safe(match[1]), line: Number(match[2]) };
}

function observedTestCount(result: CheckResult): number | undefined {
  if (result.ruleId !== "test-count") return undefined;
  for (const pattern of OBSERVED_TEST_COUNTS) {
    const match = result.evidence.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function findingFor(result: CheckResult, advisory = false): ResultFinding {
  const claimed = result.ruleId === "test-count" ? result.claim.expectedCount : undefined;
  const observed = observedTestCount(result);
  const location = locationFor(result);
  return {
    id: safe(result.ruleId ?? result.claim.kind),
    state: advisory ? (result.verdict === "contradicted" ? "FAILED" : "NOT_CHECKED") : stateFor(result.verdict),
    title: safe(result.claim.subject),
    evidence: safe(result.evidence),
    remediation: safe(remediationFor(result.ruleId)),
    ...(location ? { location } : {}),
    ...(claimed !== undefined ? { claimedTestCount: claimed } : {}),
    ...(observed !== undefined ? { observedTestCount: observed } : {}),
  };
}

function deriveReportVerdict(report: TrustReport): ReportStatus {
  const failed = report.results.filter((result) => result.verdict === "contradicted").length;
  const notChecked = report.results.filter((result) => result.verdict === "unverifiable").length;
  const meaningful = report.results.filter((result) => result.verdict === "verified" && result.contributesToPass !== false).length;
  if (failed) return "FAIL";
  if (
    meaningful < report.policy.minVerified
    || report.results.some((result) => result.verdict === "unverifiable" && result.blocksPass)
    || (report.policy.strict && notChecked)
  ) return "INCONCLUSIVE";
  return "PASS";
}

function assertReportConsistency(report: TrustReport): void {
  if (recomputeReceiptHash(report) !== report.receiptHash) {
    throw new Error("result view refused a receipt whose content does not match its hash (does not match receiptHash)");
  }
  const verdict = deriveReportVerdict(report);
  const counts = {
    verified: report.results.filter((result) => result.verdict === "verified").length,
    contradicted: report.results.filter((result) => result.verdict === "contradicted").length,
    unverifiable: report.results.filter((result) => result.verdict === "unverifiable").length,
    meaningfulVerified: report.results.filter((result) => result.verdict === "verified" && result.contributesToPass !== false).length,
  };
  if (
    verdict !== report.summary.status
    || report.summary.pass !== (verdict === "PASS")
    || counts.verified !== report.summary.verified
    || counts.contradicted !== report.summary.contradicted
    || counts.unverifiable !== report.summary.unverifiable
    || counts.meaningfulVerified !== report.summary.meaningfulVerified
  ) throw new Error("result view refused an inconsistent receipt summary");
}

/**
 * Close the receipt-v2 result boundary before any rendering, Git query, or
 * destination write. validateTrustReport returns a detached normalized copy.
 */
export function validateReportForResult(value: unknown): TrustReport {
  const report = validateTrustReport(value);
  assertReportConsistency(report);
  return report;
}

function statusName(code: string): ChangedFile["status"] {
  const letter = code[0];
  if (letter === "A") return "added";
  if (letter === "M") return "modified";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  if (letter === "C") return "copied";
  if (letter === "T") return "type-changed";
  if (letter === "U") return "unmerged";
  return "unknown";
}

export function readChangedFileManifest(repo: string, base: string, head: string): ChangedFileManifest {
  if (!GIT_OID.test(base) || !GIT_OID.test(head)) {
    return { complete: false, files: [], evidence: "Exact base and head Git object IDs are required." };
  }
  try {
    const output = trustedGit(repo, ["diff", "--name-status", "-z", `${base}..${head}`], CHANGED_FILES_MAX_BUFFER);
    const fields = output.split("\0");
    if (fields.at(-1) === "") fields.pop();
    const files: ChangedFile[] = [];
    for (let index = 0; index < fields.length;) {
      const statusCode = fields[index++];
      const status = statusName(statusCode);
      if (status === "renamed" || status === "copied") {
        const previousPath = fields[index++];
        const path = fields[index++];
        if (previousPath === undefined || path === undefined) throw new Error("incomplete rename or copy record");
        files.push({ status, path: safe(path), previousPath: safe(previousPath) });
      } else {
        const path = fields[index++];
        if (path === undefined) throw new Error("incomplete changed-file record");
        files.push({ status, path: safe(path) });
      }
    }
    return { complete: true, files, evidence: `Git reported ${files.length} changed file(s) for the exact range.` };
  } catch {
    return { complete: false, files: [], evidence: "Changed files could not be read from the explicitly trusted repository." };
  }
}

function changedFileManifest(
  trustedRepo: string | undefined,
  base: string,
  head: string,
): ChangedFileManifest {
  if (trustedRepo) return readChangedFileManifest(trustedRepo, base, head);
  return {
    complete: false,
    files: [],
    evidence: "Changed files were not requested from an explicitly trusted repository.",
  };
}

function mainCause(findings: ResultFinding[], verdict: ReportStatus, head: string): string {
  const failed = findings.find((finding) => finding.state === "FAILED");
  if (failed) return failed.title;
  const missing = findings.find((finding) => finding.state === "NOT_CHECKED");
  if (missing) return missing.title;
  return `All required checks passed at ${safe(head.slice(0, 12))}.`;
}

export function buildReportResultView(
  value: unknown,
  options: ReportResultViewOptions = {},
): ResultView {
  const report = validateReportForResult(value);
  const verdict = deriveReportVerdict(report);
  const findings = report.results.map((result) => findingFor(result));
  if (verdict === "INCONCLUSIVE" && report.summary.meaningfulVerified < report.policy.minVerified) {
    findings.unshift({
      id: "completion-evidence",
      state: "NOT_CHECKED",
      title: "Required verification evidence is missing",
      evidence: `${report.summary.meaningfulVerified} of ${report.policy.minVerified} required meaningful checks passed.`,
      remediation: remediationFor("completion-evidence"),
    });
  }
  return {
    schemaVersion: "agent-vigil/result-view/v1",
    verdict,
    consequence: consequence(verdict),
    mainCause: mainCause(findings, verdict, report.head),
    counts: {
      failed: findings.filter((finding) => finding.state === "FAILED").length,
      passed: findings.filter((finding) => finding.state === "PASSED").length,
      notChecked: findings.filter((finding) => finding.state === "NOT_CHECKED").length,
    },
    findings,
    advisories: (report.advisories ?? []).map((result) => findingFor(result, true)),
    base: safe(report.base),
    head: safe(report.head),
    generatedAt: safe(report.generatedAt),
    receiptHash: safe(report.receiptHash),
    policyHash: safe(report.policy.sha256),
    reproduce: safe(report.reproduction),
    changedFiles: changedFileManifest(options.trustedRepo, report.base, report.head),
  };
}

export function buildOutcomeResultView(
  value: unknown,
  options: OutcomeResultViewOptions,
): ResultView {
  const receipt = validateOutcomeReceipt(value, options.trust);
  const derived: ReportStatus = receipt.checks.some((check) => check.verdict === "FAIL")
    ? "FAIL"
    : receipt.checks.some((check) => check.verdict === "INCONCLUSIVE") ? "INCONCLUSIVE" : "PASS";
  if (derived !== receipt.verdict) throw new Error("result view refused an inconsistent outcome receipt verdict");
  const findings: ResultFinding[] = receipt.checks.map((check) => ({
    id: safe(check.id),
    state: outcomeState(check.verdict),
    title: safe(check.id.replace(/-/g, " ")),
    evidence: safe(check.evidence),
    remediation: safe(remediationFor(check.id)),
  }));
  const changedFiles = changedFileManifest(
    options.trustedRepo,
    receipt.sourceEvidence.base,
    receipt.sourceEvidence.head,
  );
  return {
    schemaVersion: "agent-vigil/result-view/v1",
    verdict: derived,
    consequence: consequence(derived),
    mainCause: mainCause(findings, derived, receipt.sourceEvidence.head),
    counts: {
      failed: findings.filter((finding) => finding.state === "FAILED").length,
      passed: findings.filter((finding) => finding.state === "PASSED").length,
      notChecked: findings.filter((finding) => finding.state === "NOT_CHECKED").length,
    },
    findings,
    advisories: [],
    base: safe(receipt.sourceEvidence.base),
    head: safe(receipt.sourceEvidence.head),
    generatedAt: safe(receipt.issuedAt),
    receiptHash: safe(receipt.outcomeHash),
    reproduce: safe(options.reproduce ?? `vigil receipt verify ${receipt.outcomeHash}`),
    changedFiles,
  };
}

function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function findingHtml(finding: ResultFinding): string {
  const location = finding.location ? `<p class="location">${html(finding.location.file)}${finding.location.line ? `:${finding.location.line}` : ""}</p>` : "";
  const counts = finding.claimedTestCount !== undefined || finding.observedTestCount !== undefined
    ? `<dl class="test-counts"><div><dt>Claimed</dt><dd>${finding.claimedTestCount ?? "Not stated"}</dd></div><div><dt>Observed</dt><dd>${finding.observedTestCount ?? "Not found"}</dd></div></dl>`
    : "";
  return `<article class="finding finding-${finding.state.toLowerCase().replace("_", "-")}"><p class="eyebrow">${finding.state.replace("_", " ")}</p><h3>${html(finding.title)}</h3>${location}<p>${html(finding.evidence)}</p>${counts}<p class="fix"><strong>Fix</strong> ${html(finding.remediation)}</p></article>`;
}

function displayResultVerdict(verdict: ReportStatus): "PASS" | "FAIL" | "NOT CHECKED" {
  return verdict === "INCONCLUSIVE" ? "NOT CHECKED" : verdict;
}

export function renderResultViewHtml(view: ResultView): string {
  const open = view.findings.filter((finding) => finding.state !== "PASSED");
  const primary = open[0];
  const advisories = view.advisories.map(findingHtml).join("");
  const changed = view.changedFiles.files.map((file) => `<li><span>${html(file.status)}</span><code>${file.previousPath ? `${html(file.previousPath)} → ` : ""}${html(file.path)}</code></li>`).join("");
  const display = displayResultVerdict(view.verdict);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Vigil ${display}</title>
<style>/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4 · macrostructure: decision brief · theme: quiet */:root{color-scheme:light;--ink:#111827;--muted:#5b6472;--line:#d8dee8;--paper:#fff;--wash:#f4f6f8;--fail:#b42318;--pass:#137333;--hold:#8a4b00;--font-body:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-code:ui-monospace,SFMono-Regular,Menlo,monospace}*{box-sizing:border-box}html,body{overflow-x:clip}html{background:var(--wash)}body{margin:0;color:var(--ink);font-family:var(--font-body);line-height:1.5}main{width:min(880px,calc(100% - 32px));margin:40px auto 80px}.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:28px}.eyebrow{margin:0 0 8px;font-size:.76rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.status-fail{color:var(--fail)}.status-pass{color:var(--pass)}.status-inconclusive{color:var(--hold)}h1{min-width:0;margin:0;font-size:clamp(1.8rem,6vw,3.25rem);line-height:1.05;overflow-wrap:anywhere}h2{margin:34px 0 12px;font-size:1.15rem}h3{margin:4px 0 8px;font-size:1rem}p{margin:8px 0}.cause{font-size:1.08rem}.counts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:24px 0}.count{border:1px solid var(--line);border-radius:10px;padding:12px}.count strong{display:block;font-size:1.45rem}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.actions a,.actions button,button[data-copy-reproduce]{min-height:44px;border:1px solid var(--ink);border-radius:8px;background:var(--paper);color:var(--ink);padding:10px 14px;font:inherit;font-weight:700;text-decoration:none;white-space:nowrap}.finding{border-top:1px solid var(--line);padding:18px 0}.finding-failed .eyebrow{color:var(--fail)}.finding-not-checked .eyebrow{color:var(--hold)}.location,code,.meta{overflow-wrap:anywhere}.location{color:var(--muted);font-family:var(--font-code)}.fix{background:var(--wash);border-radius:8px;padding:10px 12px}.test-counts{display:grid;grid-template-columns:repeat(2,minmax(0,180px));gap:8px}.test-counts div{border-left:3px solid var(--line);padding-left:10px}.test-counts dt{color:var(--muted);font-size:.8rem}.test-counts dd{margin:0;font-weight:800}.changed{padding:0;list-style:none}.changed li{display:grid;grid-template-columns:90px minmax(0,1fr);gap:10px;border-top:1px solid var(--line);padding:10px 0}.changed span{color:var(--muted)}details{border-top:1px solid var(--line);padding:14px 0}summary{cursor:pointer;font-weight:800}.meta{color:var(--muted);font-size:.88rem}.reproduce{display:block;padding:12px;background:var(--ink);color:var(--paper);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:540px){main{width:min(100% - 20px,880px);margin:10px auto 40px}.card{padding:18px}.counts{grid-template-columns:1fr}.actions{display:grid}.actions a,.actions button{width:100%}.changed li{grid-template-columns:1fr;gap:2px}}</style></head>
<body><main data-result-view-version="1"><section class="card" aria-labelledby="result-title"><p class="eyebrow status-${view.verdict.toLowerCase()}">Agent Vigil ${display}</p><h1 id="result-title">${html(view.consequence)}</h1><p class="cause">${html(view.mainCause)}</p>
<nav class="actions" aria-label="Result actions"><a href="${primary ? "#open-title" : "#evidence"}">${primary ? "See what needs attention" : "View receipt"}</a></nav>
<section aria-labelledby="open-title"><h2 id="open-title">${primary ? "What needs attention" : "Required checks passed"}</h2>${primary ? findingHtml(primary) : "<p>No failed or missing required checks.</p>"}</section>
<details><summary>Receipt details</summary><div class="counts" aria-label="Check counts"><div class="count"><strong>${view.counts.failed}</strong>Failed</div><div class="count"><strong>${view.counts.passed}</strong>Passed</div><div class="count"><strong>${view.counts.notChecked}</strong>Not checked</div></div>
${advisories ? `<section aria-labelledby="advisory-title"><h2 id="advisory-title">Review notes</h2>${advisories}</section>` : ""}
<section id="changed-files" aria-labelledby="changed-title"><h2 id="changed-title">Changed files</h2><p>${html(view.changedFiles.evidence)}</p><ul class="changed">${changed || "<li><span>none shown</span><code>No changed-file records are available.</code></li>"}</ul></section>
<section id="evidence" aria-labelledby="evidence-title"><h2 id="evidence-title">Exact change</h2><p class="meta">Base ${html(view.base)}<br>Head ${html(view.head)}<br>Receipt ${html(view.receiptHash)}<br>Generated ${html(view.generatedAt)}</p><button type="button" data-copy-reproduce>Copy reproduce command</button><code class="reproduce">${html(view.reproduce)}</code></section></details></section></main>
<script>document.querySelector('[data-copy-reproduce]').addEventListener('click',async function(){await navigator.clipboard.writeText(${JSON.stringify(view.reproduce).replace(/</g, "\\u003c")});this.textContent='Copied';});</script></body></html>\n`;
}
