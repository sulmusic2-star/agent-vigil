import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkIntegrityDiff } from "../src/detectors/reality.ts";
import { VERSION } from "../src/report.ts";

type SourcePr = { repo: string; prNumber: number; url: string; diffPath: string };
type DualLabel = { repo: string; prNumber: number; category: string; agreed: boolean; verdict?: string };

const EXPECTED_RULE: Record<string, string> = {
  "fake-refactor": "stale-refactor-caller",
  "error-swallow": "error-swallowed",
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function gitSha(root: string): string | undefined {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
}

function gitTree(root: string, path: string): string | undefined {
  try { return execFileSync("git", ["rev-parse", `HEAD:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

const realRootOption = option("--root");
if (!realRootOption) throw new Error("usage: npm run benchmark:swarm-real -- --root <swarm-orchestrator/benchmarks/real-prs> [--source-sha <sha>]");
const realRoot = resolve(realRootOption);
const sourceRoot = resolve(realRoot, "../..");
const sourceSha = gitSha(sourceRoot);
const sourceTree = gitTree(sourceRoot, "benchmarks/real-prs");
const expectedSourceSha = option("--source-sha");
if (expectedSourceSha && sourceSha !== expectedSourceSha) throw new Error(`source checkout ${sourceSha ?? "has no Git identity"}; expected ${expectedSourceSha}`);

const sourceDoc = JSON.parse(readFileSync(resolve(realRoot, "sources-v2.json"), "utf8")) as { fetchedAt: string; query: string; prs: SourcePr[] };
const dualLabels = JSON.parse(readFileSync(resolve(realRoot, "arbiter-labels-dual.json"), "utf8")) as DualLabel[];
const rows = sourceDoc.prs.map((pr) => {
  const checks = checkIntegrityDiff(readFileSync(resolve(realRoot, pr.diffPath), "utf8"));
  const rules = [...new Set(checks.filter((check) => check.verdict === "contradicted").map((check) => check.ruleId ?? "unlabeled"))].sort();
  const incompleteEvidence = checks
    .filter((check) => check.verdict === "unverifiable" && check.blocksPass === true)
    .map((check) => ({ ruleId: check.ruleId ?? "unlabeled", evidence: check.evidence }));
  return { ...pr, rules, advisory: rules.length > 0, incompleteEvidence };
});

const agreedTrue = dualLabels.filter((label) => label.agreed && label.verdict === "true-cheat");
const trueRows = agreedTrue.map((label) => {
  const pr = rows.find((row) => row.repo === label.repo && row.prNumber === label.prNumber);
  const expectedRule = EXPECTED_RULE[label.category];
  return {
    repo: label.repo,
    prNumber: label.prNumber,
    category: label.category,
    expectedRule,
    rules: pr?.rules ?? [],
    anyAdvisory: Boolean(pr?.advisory),
    exactCategoryAdvisory: Boolean(expectedRule && pr?.rules.includes(expectedRule)),
  };
});

const findingRows = rows.filter((row) => row.advisory);
const incompleteRows = rows.filter((row) => row.incompleteEvidence.length > 0);
const result = {
  schemaVersion: 2,
  tool: { name: "agent-vigil", version: VERSION },
  source: {
    repository: "https://github.com/moonrunnerkc/swarm-orchestrator",
    commit: sourceSha ?? "unavailable",
    corpusTree: sourceTree ?? "unavailable",
    fetchedAt: sourceDoc.fetchedAt,
    selection: sourceDoc.query,
  },
  methodology: {
    mode: "static unified-diff audit; candidate code is never executed",
    warning: "The 232 merged PRs are presumed clean, not adjudicated negatives. A finding is therefore an advisory-burden observation, not automatically a false positive. Dual-model arbiter labels are also not ground truth. This raw-diff benchmark is narrower than the repository-aware GitHub check.",
    defaultPolicy: "Static integrity contradictions are non-blocking advisories unless integrityMode=blocking or vigil audit --strict is selected. Incomplete raw-diff evidence remains fail-closed and is reported separately.",
  },
  presumedClean: {
    prs: rows.length,
    prsWithAdvisories: findingRows.length,
    advisoryPrRate: ratio(findingRows.length, rows.length),
    heuristicHardBlocks: 0,
    incompleteStaticAudits: incompleteRows.length,
    incompleteStaticAuditRate: ratio(incompleteRows.length, rows.length),
    rules: Object.fromEntries([...new Set(findingRows.flatMap((row) => row.rules))].sort().map((rule) => [rule, findingRows.filter((row) => row.rules.includes(rule)).length])),
  },
  arbiterAgreedTrueCheats: {
    cases: trueRows.length,
    anyAdvisory: trueRows.filter((row) => row.anyAdvisory).length,
    exactCategoryAdvisory: trueRows.filter((row) => row.exactCategoryAdvisory).length,
    rows: trueRows,
  },
  incompleteStaticAudits: incompleteRows.map((row) => ({
    repo: row.repo,
    prNumber: row.prNumber,
    url: row.url,
    evidence: row.incompleteEvidence,
  })),
};

const output = resolve(option("--output") ?? "benchmarks/swarm-real-results.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
const markdown = [
  "# Agent Vigil real-PR advisory calibration",
  "",
  `- Agent Vigil: ${VERSION}`,
  `- upstream commit: \`${result.source.commit}\``,
  `- presumed-clean merged PRs: ${result.presumedClean.prs}`,
  `- PRs with one or more static advisories: ${result.presumedClean.prsWithAdvisories}/${result.presumedClean.prs} (${(result.presumedClean.advisoryPrRate * 100).toFixed(1)}%)`,
  `- default hard blocks from heuristic findings: ${result.presumedClean.heuristicHardBlocks}`,
  `- raw diffs that could not be fully audited and therefore fail closed: ${result.presumedClean.incompleteStaticAudits}/${result.presumedClean.prs} (${(result.presumedClean.incompleteStaticAuditRate * 100).toFixed(1)}%)`,
  `- dual-arbiter agreed true-cheat cases with any advisory: ${result.arbiterAgreedTrueCheats.anyAdvisory}/${result.arbiterAgreedTrueCheats.cases}`,
  `- dual-arbiter agreed true-cheat cases with exact-category advisory: ${result.arbiterAgreedTrueCheats.exactCategoryAdvisory}/${result.arbiterAgreedTrueCheats.cases}`,
  "",
  "> These merged PRs are presumed clean, not adjudicated negatives. Findings measure review burden, not a confirmed false-positive rate. The dual-model arbiter labels are also not ground truth. Raw-diff parse failures are reported separately and do not describe the repository-aware GitHub check.",
  "",
  "## Default policy decision",
  "",
  "Static integrity findings are receipt-bound advisories by default. They become blocking only when `integrityMode` is `blocking` or `vigil audit --strict` is used. Missing or malformed evidence remains fail-closed.",
  "",
  "## Advisory frequency by rule",
  "",
  ...Object.entries(result.presumedClean.rules).map(([rule, count]) => `- \`${rule}\`: ${count} PR(s)`),
  "",
  "## Dual-arbiter agreed true-cheat cases",
  "",
  "| repository PR | upstream category | expected Agent Vigil rule | any advisory | exact category |",
  "|---|---|---|:---:|:---:|",
  ...trueRows.map((row) => `| ${row.repo}#${row.prNumber} | ${row.category} | \`${row.expectedRule ?? "unmapped"}\` | ${row.anyAdvisory ? "yes" : "no"} | ${row.exactCategoryAdvisory ? "yes" : "no"} |`),
  "",
].join("\n");
writeFileSync(output.replace(/\.json$/, ".md"), markdown);
process.stdout.write(`${findingRows.length}/${rows.length} presumed-clean PRs had advisories; ${incompleteRows.length} raw diffs failed closed; ${result.arbiterAgreedTrueCheats.exactCategoryAdvisory}/${trueRows.length} exact-category true-cheat advisories\n`);
