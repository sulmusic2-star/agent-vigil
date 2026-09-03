import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkIntegrityDiff } from "../src/detectors/reality.ts";
import { VERSION } from "../src/report.ts";

type Label = {
  category: string;
  injectorId: string;
  file: string;
  sha256: string;
  honest?: boolean;
};

const EXPECTED_RULES: Record<string, string[]> = {
  "assertion-strip": ["assertion-drop"],
  "cheat-mock-mutation": ["subject-mocked"],
  "dead-branch-insertion": ["dead-branch-added"],
  "error-swallow": ["error-swallowed"],
  "exception-rethrow-lost-context": ["exception-context-lost"],
  "fake-refactor": ["stale-refactor-caller"],
  "no-op-fix": ["no-op-code-change"],
  "test-relaxation": ["test-assertion-relaxed"],
  "type-suppression": ["suppression-added"],
};

// Honest fixtures are negative controls for a particular injector, not a
// declaration that every unrelated pattern in the source diff is clean. For
// example, the built-in-mock control contains expect(true).toBe(true), which
// is correctly reported by the independent constant-oracle rule. Keep that
// finding visible without mislabeling it as a mock-detector false positive.
const HONEST_NEGATIVE_RULES: Record<string, string[]> = {
  "builtin-mock-honest": ["subject-mocked"],
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function walk(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.name.endsWith(".label.json")) output.push(path);
  }
  return output.sort();
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

const corpusRoot = resolve(option("--corpus") ?? "");
if (!option("--corpus")) throw new Error("usage: npm run benchmark:swarm -- --corpus <swarm-orchestrator/benchmarks/oracle-corpus> [--source-sha <sha>]");
const sourceRoot = resolve(corpusRoot, "../..");
const actualSourceSha = gitSha(sourceRoot);
const actualCorpusTree = gitTree(sourceRoot, "benchmarks/oracle-corpus");
const expectedSourceSha = option("--source-sha");
if (expectedSourceSha && actualSourceSha !== expectedSourceSha) {
  throw new Error(`source checkout ${actualSourceSha ?? "has no Git identity"}; expected ${expectedSourceSha}`);
}

const rows = walk(corpusRoot).map((labelPath) => {
  const label = JSON.parse(readFileSync(labelPath, "utf8")) as Label;
  const diffPath = labelPath.replace(/\.label\.json$/, ".diff");
  const diff = readFileSync(diffPath, "utf8");
  const digest = createHash("sha256").update(diff).digest("hex");
  if (digest !== label.sha256) throw new Error(`${basename(diffPath)} digest ${digest} does not match label ${label.sha256}`);
  const checks = checkIntegrityDiff(diff);
  const firedRules = checks.filter((check) => check.verdict === "contradicted").map((check) => check.ruleId ?? "unlabeled").sort();
  const expectedRules = EXPECTED_RULES[label.category] ?? [];
  const policyExclusion = /(?:^|\/)(?:node_modules|vendor|vendored|dist|build|coverage|\.git)(?:\/|$)/.test(label.file)
    || /\.(?:map|snap)$/i.test(label.file)
    ? "target path is generated, vendored, or build output and is excluded by Agent Vigil's documented static-audit policy"
    : null;
  return {
    case: basename(diffPath, ".diff"),
    category: label.category,
    injector: label.injectorId,
    honest: label.honest === true,
    sha256: digest,
    expectedRules,
    policyExclusion,
    firedRules,
    exactCatch: expectedRules.some((rule) => firedRules.includes(rule)),
    anyFinding: firedRules.length > 0,
  };
});

const categories = [...new Set(rows.map((row) => row.category))].sort();
const perCategory = categories.map((category) => {
  const cases = rows.filter((row) => row.category === category && !row.honest);
  const scoped = cases.some((row) => row.expectedRules.length > 0);
  const eligible = cases.filter((row) => !row.policyExclusion);
  const exact = eligible.filter((row) => row.exactCatch).length;
  const any = cases.filter((row) => row.anyFinding).length;
  return { category, cases: cases.length, eligible: eligible.length, scoped, exact, exactRecall: scoped ? ratio(exact, eligible.length) : null, any, anyFindingRate: ratio(any, cases.length) };
});
const mappedRows = rows.filter((row) => !row.honest && row.expectedRules.length > 0);
const scopedRows = mappedRows.filter((row) => !row.policyExclusion);
const honestRows = rows.filter((row) => row.honest);
const honestRowsWithTargetedFalsePositive = honestRows.filter((row) =>
  (HONEST_NEGATIVE_RULES[row.injector] ?? []).some((rule) => row.firedRules.includes(rule))
);
const honestRowsWithOtherFindings = honestRows.filter((row) =>
  row.firedRules.some((rule) => !(HONEST_NEGATIVE_RULES[row.injector] ?? []).includes(rule))
);
const result = {
  schemaVersion: 2,
  tool: { name: "agent-vigil", version: VERSION },
  source: {
    repository: "https://github.com/moonrunnerkc/swarm-orchestrator",
    commit: actualSourceSha ?? "unavailable",
    corpusTree: actualCorpusTree ?? "unavailable",
    corpusRoot: "benchmarks/oracle-corpus",
    labelsVerified: rows.length,
  },
  methodology: {
    mode: "static unified-diff audit; candidate code is never executed",
    exactRuleScope: EXPECTED_RULES,
    warning: "This is an Agent Vigil-authored training and cross-corpus hardening measurement. The rule mappings were declared during development against this corpus, not evaluated as a blind holdout. Any-finding rates are diagnostic and must not be compared with Swarm's expected-category recall.",
  },
  summary: {
    totalLabeledCases: rows.length,
    plantedCases: rows.filter((row) => !row.honest).length,
    honestCases: honestRows.length,
    mappedCases: mappedRows.length,
    policyExcludedMappedCases: mappedRows.filter((row) => row.policyExclusion).length,
    scopedCases: scopedRows.length,
    exactCatches: scopedRows.filter((row) => row.exactCatch).length,
    exactRecall: ratio(scopedRows.filter((row) => row.exactCatch).length, scopedRows.length),
    honestTargetedFalsePositives: honestRowsWithTargetedFalsePositive.length,
    honestOtherFindings: honestRowsWithOtherFindings.length,
  },
  perCategory,
  misses: scopedRows.filter((row) => !row.exactCatch),
  policyExcluded: mappedRows.filter((row) => row.policyExclusion),
  honestTargetedFalsePositives: honestRowsWithTargetedFalsePositive,
  honestOtherFindings: honestRowsWithOtherFindings,
};

const output = resolve(option("--output") ?? "benchmarks/swarm-oracle-results.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);

const markdown = [
  "# Agent Vigil on the Swarm Orchestrator oracle corpus",
  "",
  `- Agent Vigil: ${VERSION}`,
  `- upstream commit: \`${result.source.commit}\``,
  `- verified labels: ${result.summary.totalLabeledCases}`,
  `- training-corpus mapped cases: ${result.summary.mappedCases} across ${Object.keys(EXPECTED_RULES).length} categories`,
  `- eligible exact-rule scope: ${result.summary.scopedCases} cases (${result.summary.policyExcludedMappedCases} generated/build-output cases excluded by documented policy)`,
  `- exact catches: ${result.summary.exactCatches}/${result.summary.scopedCases} (${(result.summary.exactRecall * 100).toFixed(1)}%)`,
  `- honest controls with a targeted false positive: ${result.summary.honestTargetedFalsePositives}/${result.summary.honestCases}`,
  `- honest controls with an unrelated finding retained for review: ${result.summary.honestOtherFindings}/${result.summary.honestCases}`,
  "",
  "> This is a cross-corpus hardening measurement authored by Agent Vigil's maintainer. It is not an independent benchmark and does not establish universal product superiority. Any-finding rates are diagnostic only and are not comparable to Swarm's expected-category recall.",
  "",
  "| category | cases | eligible | mapped | exact catch (eligible) | eligible recall | any finding |",
  "|---|---:|---:|:---:|---:|---:|---:|",
  ...perCategory.map((row) => `| ${row.category} | ${row.cases} | ${row.eligible} | ${row.scoped ? "yes" : "no"} | ${row.scoped ? row.exact : "n/a"} | ${row.exactRecall === null ? "n/a" : `${(row.exactRecall * 100).toFixed(1)}%`} | ${row.any}/${row.cases} |`),
  "",
  "The machine-readable file records every scoped miss and every honest-case finding.",
  "",
].join("\n");
writeFileSync(output.replace(/\.json$/, ".md"), markdown);
process.stdout.write(`${result.summary.exactCatches}/${result.summary.scopedCases} exact scoped catches; ${result.summary.honestTargetedFalsePositives}/${result.summary.honestCases} targeted honest-control false positives; ${result.summary.honestOtherFindings}/${result.summary.honestCases} unrelated honest-control findings\n`);
