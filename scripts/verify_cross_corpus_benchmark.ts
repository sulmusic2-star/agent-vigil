import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FROZEN_CROSS_CORPUS_GATE = {
  schemaVersion: 1,
  source: { commit: "b2b681ff529929d39a14c0541d0e2b71b642b5da" },
  oracle: { scopedCases: 220, minExactRecall: 1, maxTargetedFalsePositives: 0 },
  realPrCalibration: {
    prs: 232,
    maxAdvisoryPrs: 104,
    maxIncompleteStaticAudits: 9,
    arbiterCases: 4,
    minAnyAdvisory: 4,
    minExactCategoryAdvisory: 2,
  },
} as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string, errors: string[]): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return {};
  }
  return value as JsonRecord;
}

function number(value: unknown, label: string, errors: string[]): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number`);
    return Number.NaN;
  }
  return value;
}

function string(value: unknown, label: string, errors: string[]): string {
  if (typeof value !== "string" || !value) {
    errors.push(`${label} must be a non-empty string`);
    return "";
  }
  return value;
}

export function verifyCrossCorpusGate(protocolValue: unknown, oracleValue: unknown, realValue: unknown): string[] {
  const errors: string[] = [];
  const protocol = record(protocolValue, "protocol", errors);
  const oracle = record(oracleValue, "oracle result", errors);
  const real = record(realValue, "real-PR result", errors);
  if (number(protocol.schemaVersion, "protocol.schemaVersion", errors) !== 1) errors.push("protocol.schemaVersion must be 1");
  if (number(oracle.schemaVersion, "oracle.schemaVersion", errors) !== 2) errors.push("oracle.schemaVersion must be 2");
  if (number(real.schemaVersion, "real.schemaVersion", errors) !== 2) errors.push("real.schemaVersion must be 2");

  const source = record(protocol.source, "protocol.source", errors);
  const oracleSource = record(oracle.source, "oracle.source", errors);
  const realSource = record(real.source, "real.source", errors);
  const expectedCommit = string(source.commit, "protocol.source.commit", errors);
  const oracleCommit = string(oracleSource.commit, "oracle.source.commit", errors);
  const realCommit = string(realSource.commit, "real.source.commit", errors);
  if (expectedCommit && oracleCommit !== expectedCommit) errors.push(`oracle source commit ${oracleCommit || "missing"} does not match ${expectedCommit}`);
  if (expectedCommit && realCommit !== expectedCommit) errors.push(`real-PR source commit ${realCommit || "missing"} does not match ${expectedCommit}`);

  const oracleTool = record(oracle.tool, "oracle.tool", errors);
  const realTool = record(real.tool, "real.tool", errors);
  const oracleVersion = string(oracleTool.version, "oracle.tool.version", errors);
  const realVersion = string(realTool.version, "real.tool.version", errors);
  if (oracleVersion && realVersion && oracleVersion !== realVersion) errors.push(`benchmark tool versions differ: ${oracleVersion} and ${realVersion}`);

  const oracleLimits = record(protocol.oracle, "protocol.oracle", errors);
  const oracleSummary = record(oracle.summary, "oracle.summary", errors);
  const scopedCases = number(oracleSummary.scopedCases, "oracle.summary.scopedCases", errors);
  const expectedScopedCases = number(oracleLimits.scopedCases, "protocol.oracle.scopedCases", errors);
  if (Number.isFinite(scopedCases) && Number.isFinite(expectedScopedCases) && scopedCases !== expectedScopedCases) errors.push(`oracle scoped cases changed: ${scopedCases} != ${expectedScopedCases}`);
  const exactRecall = number(oracleSummary.exactRecall, "oracle.summary.exactRecall", errors);
  const minExactRecall = number(oracleLimits.minExactRecall, "protocol.oracle.minExactRecall", errors);
  if (exactRecall < minExactRecall) errors.push(`oracle exact recall regressed: ${exactRecall} < ${minExactRecall}`);
  const targetedFalsePositives = number(oracleSummary.honestTargetedFalsePositives, "oracle.summary.honestTargetedFalsePositives", errors);
  const maxTargetedFalsePositives = number(oracleLimits.maxTargetedFalsePositives, "protocol.oracle.maxTargetedFalsePositives", errors);
  if (targetedFalsePositives > maxTargetedFalsePositives) errors.push(`targeted honest-control false positives increased: ${targetedFalsePositives} > ${maxTargetedFalsePositives}`);

  const realLimits = record(protocol.realPrCalibration, "protocol.realPrCalibration", errors);
  const presumedClean = record(real.presumedClean, "real.presumedClean", errors);
  const expectedPrs = number(realLimits.prs, "protocol.realPrCalibration.prs", errors);
  const prs = number(presumedClean.prs, "real.presumedClean.prs", errors);
  if (Number.isFinite(prs) && Number.isFinite(expectedPrs) && prs !== expectedPrs) errors.push(`real-PR corpus size changed: ${prs} != ${expectedPrs}`);
  const advisoryPrs = number(presumedClean.prsWithAdvisories, "real.presumedClean.prsWithAdvisories", errors);
  const maxAdvisoryPrs = number(realLimits.maxAdvisoryPrs, "protocol.realPrCalibration.maxAdvisoryPrs", errors);
  if (advisoryPrs > maxAdvisoryPrs) errors.push(`advisory burden increased: ${advisoryPrs} > ${maxAdvisoryPrs} PRs`);
  const incomplete = number(presumedClean.incompleteStaticAudits, "real.presumedClean.incompleteStaticAudits", errors);
  const maxIncomplete = number(realLimits.maxIncompleteStaticAudits, "protocol.realPrCalibration.maxIncompleteStaticAudits", errors);
  if (incomplete > maxIncomplete) errors.push(`incomplete static audits increased: ${incomplete} > ${maxIncomplete}`);

  const cheats = record(real.arbiterAgreedTrueCheats, "real.arbiterAgreedTrueCheats", errors);
  const expectedCheatCases = number(realLimits.arbiterCases, "protocol.realPrCalibration.arbiterCases", errors);
  const cheatCases = number(cheats.cases, "real.arbiterAgreedTrueCheats.cases", errors);
  if (Number.isFinite(cheatCases) && Number.isFinite(expectedCheatCases) && cheatCases !== expectedCheatCases) errors.push(`arbiter case count changed: ${cheatCases} != ${expectedCheatCases}`);
  const anyAdvisory = number(cheats.anyAdvisory, "real.arbiterAgreedTrueCheats.anyAdvisory", errors);
  const minAnyAdvisory = number(realLimits.minAnyAdvisory, "protocol.realPrCalibration.minAnyAdvisory", errors);
  if (anyAdvisory < minAnyAdvisory) errors.push(`arbiter any-advisory catches regressed: ${anyAdvisory} < ${minAnyAdvisory}`);
  const exactCategory = number(cheats.exactCategoryAdvisory, "real.arbiterAgreedTrueCheats.exactCategoryAdvisory", errors);
  const minExactCategory = number(realLimits.minExactCategoryAdvisory, "protocol.realPrCalibration.minExactCategoryAdvisory", errors);
  if (exactCategory < minExactCategory) errors.push(`arbiter exact-category catches regressed: ${exactCategory} < ${minExactCategory}`);

  return [...new Set(errors)];
}


function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function main(): void {
  const oraclePath = option("--oracle");
  const realPath = option("--real");
  if (!oraclePath || !realPath) {
    throw new Error("usage: tsx scripts/verify_cross_corpus_benchmark.ts --oracle <oracle.json> --real <real.json>");
  }
  const errors = verifyCrossCorpusGate(FROZEN_CROSS_CORPUS_GATE, json(oraclePath), json(realPath));
  if (errors.length) {
    process.stderr.write(`Frozen cross-corpus gate failed:\n- ${errors.join("\n- ")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Frozen cross-corpus gate passed.\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
