import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkIntegrityDiff } from "../src/detectors/reality.ts";
import { VERSION } from "../src/report.ts";
import { holmAdjust, mcnemarExact, pairedBootstrapMeanDifference, wilsonInterval } from "./comparative_stats.ts";

type Protocol = {
  randomSeed: number;
  agentVigil: { version: string; commit: string };
  swarm: { version: string; commit: string; detectorSet: "experimental" };
  datasets: Record<string, { root?: string; manifest?: string; indexSha256?: string; manifestSha256?: string }>;
};
type SwarmFinding = { category: string };
type SwarmResult = { findings: SwarmFinding[] };
type DetectorResult = { rules: string[]; count: number; any: boolean; exact: boolean };
type PairRow = {
  id: string; category: string; kind: "broken" | "clean"; sha256: string;
  agent: DetectorResult; swarm: DetectorResult;
};

const AGENT_RULES: Record<string, string[]> = {
  "assertion-strip": ["assertion-drop"],
  "cheat-mock-mutation": ["subject-mocked"],
  "comment-only-fix": ["comment-only-change"],
  "dead-branch-insertion": ["dead-branch-added"],
  "error-swallow": ["error-swallowed"],
  "exception-rethrow-lost-context": ["exception-context-lost"],
  "fake-refactor": ["stale-refactor-caller"],
  "no-op-fix": ["no-op-code-change"],
  "test-relaxation": ["test-assertion-relaxed"],
  "type-suppression": ["suppression-added"],
};
const SWARM_RULES: Record<string, string[]> = {
  "assertion-strip": ["assertion-strip"],
  "comment-only-fix": ["comment-only-fix"],
  "coverage-erosion": ["coverage-erosion"],
  "dead-branch-insertion": ["dead-branch-insertion"],
  "error-swallow": ["error-swallow"],
  "exception-rethrow-lost-context": ["exception-rethrow-lost-context"],
  "fake-refactor": ["fake-refactor"],
  "mock-of-hallucination": ["mock-of-hallucination"],
  "no-op-fix": ["no-op-fix"],
  "test-relaxation": ["test-relaxation"],
  "type-suppression": ["type-suppression"],
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
function sha256(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function fileSha256(path: string): string { return sha256(readFileSync(path)); }
function ratio(a: number, b: number): number { return b === 0 ? 0 : a / b; }
function rounded(value: number): number { return Number(value.toFixed(6)); }
function roundedP(value: number): number { return value > 0 && value < 0.000001 ? Number(value.toPrecision(6)) : rounded(value); }
function displayP(value: number): string { return value > 0 && value < 0.000001 ? "p<0.000001" : `p=${value}`; }
function interval(successes: number, trials: number) {
  const value = wilsonInterval(successes, trials);
  return { estimate: rounded(ratio(successes, trials)), low: rounded(value.low), high: rounded(value.high), successes, trials };
}
function gitSha(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
function gitDirty(root: string): boolean {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim().length > 0;
}
function verifyFile(path: string, expected: string | undefined): void {
  if (!expected) throw new Error(`protocol lacks a digest for ${path}`);
  const actual = fileSha256(path);
  if (actual !== expected) throw new Error(`${path} digest ${actual} does not match frozen ${expected}`);
}
function githubCompareDiffUrl(repo: string, baseSha: string, headSha: string): string {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error("wild benchmark repository must be owner/name");
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error("wild benchmark commits must be full lowercase SHAs");
  const [owner, name] = repo.split("/");
  const url = new URL(`/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${baseSha}...${headSha}.diff`, "https://github.com");
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) {
    throw new Error("wild benchmark download must stay on github.com over HTTPS");
  }
  return url.toString();
}
function walkLabels(root: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkLabels(path));
    else if (entry.name.endsWith(".label.json")) output.push(path);
  }
  return output.sort();
}
function pairedTest(rows: Array<{ agent: { exact: boolean; any: boolean }; swarm: { exact: boolean; any: boolean } }>, field: "exact" | "any") {
  const both = rows.filter((row) => row.agent[field] && row.swarm[field]).length;
  const agentOnly = rows.filter((row) => row.agent[field] && !row.swarm[field]).length;
  const swarmOnly = rows.filter((row) => !row.agent[field] && row.swarm[field]).length;
  const neither = rows.length - both - agentOnly - swarmOnly;
  return { both, agentOnly, swarmOnly, neither, pExact: roundedP(mcnemarExact(agentOnly, swarmOnly)) };
}
function categoryRows<T extends { category: string; agent: DetectorResult; swarm: DetectorResult }>(rows: T[]) {
  const categories = [...new Set(rows.map((row) => row.category))].sort();
  const values = categories.map((category) => {
    const selected = rows.filter((row) => row.category === category);
    const exactPaired = pairedTest(selected, "exact");
    return {
      category,
      cases: selected.length,
      agentExact: interval(selected.filter((row) => row.agent.exact).length, selected.length),
      swarmExact: interval(selected.filter((row) => row.swarm.exact).length, selected.length),
      agentAny: interval(selected.filter((row) => row.agent.any).length, selected.length),
      swarmAny: interval(selected.filter((row) => row.swarm.any).length, selected.length),
      exactPaired,
    };
  });
  const adjusted = holmAdjust(values.map((row) => row.exactPaired.pExact));
  return values.map((row, index) => ({ ...row, exactPaired: { ...row.exactPaired, pHolm: roundedP(adjusted[index]) } }));
}

const swarmRootOption = option("--swarm-root");
if (!swarmRootOption) throw new Error("usage: npm run benchmark:compare -- --swarm-root <swarm-orchestrator> [--output <json>] [--skip-wild] [--post-change] [--generated-at <ISO-8601>]");
const repoRoot = resolve(import.meta.dirname, "..");
const swarmRoot = resolve(swarmRootOption);
const protocolPath = resolve(option("--protocol") ?? join(repoRoot, "benchmarks/comparative/protocol-v1.json"));
const protocol = JSON.parse(readFileSync(protocolPath, "utf8")) as Protocol;
const generatedAt = option("--generated-at") ?? new Date().toISOString();
if (Number.isNaN(Date.parse(generatedAt))) throw new Error("--generated-at must be an ISO-8601 timestamp");
const evaluatedAgentCommit = gitSha(repoRoot);
const evaluatedAgentDirty = gitDirty(repoRoot);
const postChange = process.argv.includes("--post-change");
if (VERSION !== protocol.agentVigil.version && !postChange) {
  throw new Error(`Agent Vigil version ${VERSION} does not match frozen ${protocol.agentVigil.version}; use --post-change only for a separately labeled hardening result`);
}
execFileSync("git", ["merge-base", "--is-ancestor", protocol.agentVigil.commit, "HEAD"], { cwd: repoRoot });
if (gitSha(swarmRoot) !== protocol.swarm.commit) throw new Error("Swarm checkout does not match frozen commit");
const swarmPackage = JSON.parse(readFileSync(join(swarmRoot, "package.json"), "utf8")) as { version: string };
if (swarmPackage.version !== protocol.swarm.version) throw new Error("Swarm package version does not match frozen version");

const oracleRoot = join(swarmRoot, protocol.datasets.oracle.root!);
const syntheticRoot = join(swarmRoot, protocol.datasets.pairedSynthetic.root!);
const presumedManifest = join(swarmRoot, protocol.datasets.presumedClean.manifest!);
const wildManifest = join(swarmRoot, protocol.datasets.wildComplaints.manifest!);
verifyFile(join(oracleRoot, "INDEX.md"), protocol.datasets.oracle.indexSha256);
verifyFile(join(syntheticRoot, "index.json"), protocol.datasets.pairedSynthetic.indexSha256);
verifyFile(presumedManifest, protocol.datasets.presumedClean.manifestSha256);
verifyFile(wildManifest, protocol.datasets.wildComplaints.manifestSha256);

const swarmModulePath = join(swarmRoot, "dist/src/audit/cheat-detector/index.js");
if (!existsSync(swarmModulePath)) throw new Error(`build Swarm first: missing ${swarmModulePath}`);
const swarmModule = await import(pathToFileURL(swarmModulePath).href) as {
  runCheatDetectors(input: { unifiedDiff: string; repoRoot: string; detectorSet: "experimental" }): Promise<SwarmResult>;
};
const emptyRepo = mkdtempSync(join(tmpdir(), "agent-vigil-comparator-"));
const run = async (diff: string, category: string): Promise<{ agent: DetectorResult; swarm: DetectorResult }> => {
  const agentRules = [...new Set(checkIntegrityDiff(diff).filter((check) => check.verdict === "contradicted").map((check) => check.ruleId ?? "unlabeled"))].sort();
  const swarmResult = await swarmModule.runCheatDetectors({ unifiedDiff: diff, repoRoot: emptyRepo, detectorSet: "experimental" });
  const swarmRules = [...new Set(swarmResult.findings.map((finding) => finding.category))].sort();
  const agentExpected = AGENT_RULES[category] ?? [];
  const swarmExpected = SWARM_RULES[category] ?? [];
  return {
    agent: { rules: agentRules, count: agentRules.length, any: agentRules.length > 0, exact: agentExpected.some((rule) => agentRules.includes(rule)) },
    swarm: { rules: swarmRules, count: swarmResult.findings.length, any: swarmRules.length > 0, exact: swarmExpected.some((rule) => swarmRules.includes(rule)) },
  };
};

try {
  const syntheticIndex = JSON.parse(readFileSync(join(syntheticRoot, "index.json"), "utf8")) as {
    cases: Array<{ id: string; category: string; brokenPath: string; cleanPath: string }>;
  };
  const syntheticRows: PairRow[] = [];
  for (const [index, item] of syntheticIndex.cases.entries()) {
    for (const kind of ["broken", "clean"] as const) {
      const path = join(syntheticRoot, kind === "broken" ? item.brokenPath : item.cleanPath);
      const diff = readFileSync(path, "utf8");
      syntheticRows.push({ id: item.id, category: item.category, kind, sha256: sha256(diff), ...(await run(diff, item.category)) });
    }
    if ((index + 1) % 100 === 0) process.stderr.write(`synthetic ${index + 1}/${syntheticIndex.cases.length}\n`);
  }

  const oracleRows = [];
  for (const [index, labelPath] of walkLabels(oracleRoot).entries()) {
    const label = JSON.parse(readFileSync(labelPath, "utf8")) as { category: string; sha256: string; honest?: boolean };
    const diffPath = labelPath.replace(/\.label\.json$/, ".diff");
    const diff = readFileSync(diffPath, "utf8");
    if (sha256(diff) !== label.sha256) throw new Error(`oracle digest mismatch: ${diffPath}`);
    oracleRows.push({ id: basename(diffPath, ".diff"), category: label.category, honest: label.honest === true, sha256: label.sha256, ...(await run(diff, label.category)) });
    if ((index + 1) % 100 === 0) process.stderr.write(`oracle ${index + 1}\n`);
  }

  const presumedDoc = JSON.parse(readFileSync(presumedManifest, "utf8")) as { prs: Array<{ repo: string; prNumber: number; diffPath: string }> };
  const presumedRows: Array<{ repo: string; prNumber: number; sha256: string; agent: DetectorResult; swarm: DetectorResult }> = [];
  for (const [index, pr] of presumedDoc.prs.entries()) {
    const diff = readFileSync(join(dirname(presumedManifest), pr.diffPath), "utf8");
    presumedRows.push({ repo: pr.repo, prNumber: pr.prNumber, sha256: sha256(diff), ...(await run(diff, "unlabeled")) });
    if ((index + 1) % 50 === 0) process.stderr.write(`presumed-clean ${index + 1}/${presumedDoc.prs.length}\n`);
  }

  const wildDoc = JSON.parse(readFileSync(wildManifest, "utf8")) as {
    version: string;
    entries: Array<{ id: string; repo: string; prNumber: number; baseSha: string; headSha: string; complaintCategory: string; complaintBar: string; url: string }>;
  };
  const wildRows = [];
  if (!process.argv.includes("--skip-wild")) {
    for (const entry of wildDoc.entries) {
      const diffUrl = githubCompareDiffUrl(entry.repo, entry.baseSha, entry.headSha);
      try {
        const response = await fetch(diffUrl, { headers: { "user-agent": "agent-vigil-comparative-benchmark/1" }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const diff = await response.text();
        if (!diff.includes("diff --git ")) throw new Error("response is not a unified Git diff");
        wildRows.push({ ...entry, diffUrl, fetched: true, error: null, sha256: sha256(diff), ...(await run(diff, entry.complaintCategory)) });
      } catch (error) {
        wildRows.push({ ...entry, diffUrl, fetched: false, error: error instanceof Error ? error.message : String(error) });
      }
      process.stderr.write(`wild ${wildRows.length}/${wildDoc.entries.length}\n`);
    }
  }

  const brokenRows = syntheticRows.filter((row) => row.kind === "broken");
  const cleanRows = syntheticRows.filter((row) => row.kind === "clean");
  const pairSeparated = (tool: "agent" | "swarm") => brokenRows.filter((broken) => {
    const clean = cleanRows.find((row) => row.id === broken.id)!;
    return broken[tool].any && !clean[tool].any;
  }).length;
  const syntheticSummary = (tool: "agent" | "swarm") => {
    const truePositive = brokenRows.filter((row) => row[tool].any).length;
    const trueNegative = cleanRows.filter((row) => !row[tool].any).length;
    return {
      brokenRecall: interval(truePositive, brokenRows.length),
      cleanSpecificity: interval(trueNegative, cleanRows.length),
      balancedAccuracy: rounded((ratio(truePositive, brokenRows.length) + ratio(trueNegative, cleanRows.length)) / 2),
      pairSeparation: interval(pairSeparated(tool), brokenRows.length),
    };
  };
  const plantedOracle = oracleRows.filter((row) => !row.honest);
  const strictWild = wildRows.filter((row) => row.fetched && row.complaintBar === "strict") as Array<typeof wildRows[number] & { agent: DetectorResult; swarm: DetectorResult }>;
  const presumedSummary = (tool: "agent" | "swarm") => {
    const flagged = presumedRows.filter((row) => row[tool].any).length;
    const findings = presumedRows.map((row) => row[tool].count);
    return { advisoryPrRate: interval(flagged, presumedRows.length), totalFindings: findings.reduce((sum, value) => sum + value, 0), meanFindingsPerPr: rounded(findings.reduce((sum, value) => sum + value, 0) / findings.length) };
  };
  const result = {
    schemaVersion: 1,
    generatedAt,
    protocol: { path: "benchmarks/comparative/protocol-v1.json", sha256: fileSha256(protocolPath) },
    tools: {
      agentVigil: { ...protocol.agentVigil, evaluatedVersion: VERSION, evaluatedCommit: evaluatedAgentCommit, evaluatedWithTrackedChanges: evaluatedAgentDirty },
      swarm: protocol.swarm,
    },
    caveats: [
      "Maintainer-authored comparison on competitor-authored, non-blind corpora; not independent validation.",
      "Presumed-clean PRs are not adjudicated negatives; advisory rate is not a false-positive rate.",
      "Static unified-diff detection only; no candidate execution, model judge, transcript reconciliation, signed receipts, or merge enforcement.",
      "Benchmark performance does not establish adoption, revenue, valuation, universal superiority, or guaranteed financial outcomes.",
    ],
    synthetic: {
      pairs: brokenRows.length,
      agent: syntheticSummary("agent"),
      swarm: syntheticSummary("swarm"),
      anyPairedBroken: pairedTest(brokenRows, "any"),
      exactPairedBroken: pairedTest(brokenRows, "exact"),
      perCategory: categoryRows(brokenRows),
      rows: syntheticRows,
    },
    oracle: {
      plantedCases: plantedOracle.length,
      honestCases: oracleRows.length - plantedOracle.length,
      agentExact: interval(plantedOracle.filter((row) => row.agent.exact).length, plantedOracle.length),
      swarmExact: interval(plantedOracle.filter((row) => row.swarm.exact).length, plantedOracle.length),
      agentAny: interval(plantedOracle.filter((row) => row.agent.any).length, plantedOracle.length),
      swarmAny: interval(plantedOracle.filter((row) => row.swarm.any).length, plantedOracle.length),
      exactPaired: pairedTest(plantedOracle, "exact"),
      anyPaired: pairedTest(plantedOracle, "any"),
      perCategory: categoryRows(plantedOracle),
      rows: oracleRows,
    },
    presumedClean: {
      prs: presumedRows.length,
      agent: presumedSummary("agent"),
      swarm: presumedSummary("swarm"),
      advisoryPaired: pairedTest(presumedRows, "any"),
      meanFindingDifferenceAgentMinusSwarm: pairedBootstrapMeanDifference(presumedRows.map((row) => row.agent.count), presumedRows.map((row) => row.swarm.count), { seed: protocol.randomSeed, resamples: 10_000 }),
      rows: presumedRows,
    },
    wildComplaints: {
      version: wildDoc.version,
      listed: wildDoc.entries.length,
      fetched: wildRows.filter((row) => row.fetched).length,
      strictFetched: strictWild.length,
      strictAgentExact: interval(strictWild.filter((row) => row.agent.exact).length, strictWild.length),
      strictSwarmExact: interval(strictWild.filter((row) => row.swarm.exact).length, strictWild.length),
      strictAgentAny: interval(strictWild.filter((row) => row.agent.any).length, strictWild.length),
      strictSwarmAny: interval(strictWild.filter((row) => row.swarm.any).length, strictWild.length),
      strictExactPaired: pairedTest(strictWild, "exact"),
      strictAnyPaired: pairedTest(strictWild, "any"),
      rows: wildRows,
    },
  };

  const output = resolve(option("--output") ?? join(repoRoot, "benchmarks/comparative/baseline-v1.json"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const resultLabel = basename(output, ".json").replaceAll("-", " ");
  const markdown = [
    `# Static audit comparison ${resultLabel}`,
    "",
    `Protocol: \`${result.protocol.sha256}\` · Agent Vigil ${VERSION} evaluated at \`${evaluatedAgentCommit}\`${evaluatedAgentDirty ? " with tracked changes" : ""} · Swarm ${protocol.swarm.version} at \`${protocol.swarm.commit}\``,
    "",
    "> Maintainer-authored, non-blind comparison on competitor-authored corpora. This does not establish objective universal superiority or any financial outcome.",
    "",
    "## Paired synthetic corpus",
    "",
    "| tool | broken recall | clean specificity | balanced accuracy | pair separation |",
    "|---|---:|---:|---:|---:|",
    `| Agent Vigil | ${pct(result.synthetic.agent.brokenRecall.estimate)} | ${pct(result.synthetic.agent.cleanSpecificity.estimate)} | ${pct(result.synthetic.agent.balancedAccuracy)} | ${pct(result.synthetic.agent.pairSeparation.estimate)} |`,
    `| Swarm | ${pct(result.synthetic.swarm.brokenRecall.estimate)} | ${pct(result.synthetic.swarm.cleanSpecificity.estimate)} | ${pct(result.synthetic.swarm.balancedAccuracy)} | ${pct(result.synthetic.swarm.pairSeparation.estimate)} |`,
    "",
    `Any-finding McNemar: Agent-only ${result.synthetic.anyPairedBroken.agentOnly}, Swarm-only ${result.synthetic.anyPairedBroken.swarmOnly}, exact ${displayP(result.synthetic.anyPairedBroken.pExact)}.`,
    "",
    "## Constructive-injection oracle",
    "",
    `- Agent Vigil exact-category: ${result.oracle.agentExact.successes}/${result.oracle.agentExact.trials} (${pct(result.oracle.agentExact.estimate)}; Wilson 95% ${pct(result.oracle.agentExact.low)}–${pct(result.oracle.agentExact.high)})`,
    `- Swarm exact-category: ${result.oracle.swarmExact.successes}/${result.oracle.swarmExact.trials} (${pct(result.oracle.swarmExact.estimate)}; Wilson 95% ${pct(result.oracle.swarmExact.low)}–${pct(result.oracle.swarmExact.high)})`,
    `- Exact-category McNemar: Agent-only ${result.oracle.exactPaired.agentOnly}, Swarm-only ${result.oracle.exactPaired.swarmOnly}, exact ${displayP(result.oracle.exactPaired.pExact)}.`,
    "",
    "## Presumed-clean review burden",
    "",
    `- Agent Vigil: ${result.presumedClean.agent.advisoryPrRate.successes}/${result.presumedClean.prs} PRs with advisories (${pct(result.presumedClean.agent.advisoryPrRate.estimate)}); ${result.presumedClean.agent.totalFindings} findings.`,
    `- Swarm: ${result.presumedClean.swarm.advisoryPrRate.successes}/${result.presumedClean.prs} PRs with advisories (${pct(result.presumedClean.swarm.advisoryPrRate.estimate)}); ${result.presumedClean.swarm.totalFindings} findings.`,
    `- Paired bootstrap mean-finding difference (Agent minus Swarm): ${result.presumedClean.meanFindingDifferenceAgentMinusSwarm.estimate.toFixed(3)} [${result.presumedClean.meanFindingDifferenceAgentMinusSwarm.low.toFixed(3)}, ${result.presumedClean.meanFindingDifferenceAgentMinusSwarm.high.toFixed(3)}].`,
    "",
    "These PRs are presumed clean, not adjudicated negatives. The numbers measure review burden, not confirmed false positives.",
    "",
    "## Strict real-PR complaints",
    "",
    `- fetched: ${result.wildComplaints.strictFetched} strict cases (${result.wildComplaints.fetched}/${result.wildComplaints.listed} total corpus entries fetched)`,
    `- Agent Vigil exact / any: ${result.wildComplaints.strictAgentExact.successes}/${result.wildComplaints.strictFetched} / ${result.wildComplaints.strictAgentAny.successes}/${result.wildComplaints.strictFetched}`,
    `- Swarm exact / any: ${result.wildComplaints.strictSwarmExact.successes}/${result.wildComplaints.strictFetched} / ${result.wildComplaints.strictSwarmAny.successes}/${result.wildComplaints.strictFetched}`,
    "",
    "See the JSON for every normalized row, category-level Wilson intervals, exact McNemar tests, Holm adjustments, hashes, and fetch failures.",
    "",
  ].join("\n");
  writeFileSync(output.replace(/\.json$/, ".md"), markdown);
  process.stdout.write(`${output}\n${markdown}`);
} finally {
  rmSync(emptyRepo, { recursive: true, force: true });
}
