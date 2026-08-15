#!/usr/bin/env node
// vigil — did your agent actually do what it said?
//   npx vigil <transcript.jsonl|summary.md> [--repo .] [--test-cmd "npm test"] [--json]
// Exit code 0 = nothing contradicted (safe CI gate). Exit 1 = contradictions found.

import { resolve } from "node:path";
import { loadNarrative, extractClaims } from "./transcript.ts";
import { checkPathsExist, checkFilesChanged, checkTestsPass, checkCompletion } from "./detectors/reality.ts";
import { buildReport, type CheckResult } from "./report.ts";

const args = process.argv.slice(2);
const transcript = args.find((a) => !a.startsWith("--"));
if (!transcript) {
  console.error('usage: vigil <transcript.jsonl|summary.md> [--repo <path>] [--test-cmd "<cmd>"] [--json]');
  process.exit(2);
}
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = resolve(flag("--repo") ?? ".");
const testCmd = flag("--test-cmd");
const asJson = args.includes("--json");

const narrative = loadNarrative(transcript);
const claims = extractClaims(narrative);
const results: CheckResult[] = [
  ...checkTestsPass(claims, repo, testCmd),
  ...checkFilesChanged(claims, repo),
  ...checkPathsExist(claims.filter((c) => c.kind === "path_exists" && !claims.some((f) => f.kind === "file_changed" && f.subject === c.subject)), repo),
  ...checkCompletion(claims, repo),
];
const report = buildReport(transcript, repo, results);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const icon = { verified: "✓", contradicted: "✗", unverifiable: "?" } as const;
  console.log(`vigil — trust report\n  transcript: ${transcript}\n  repo:       ${repo}\n`);
  for (const r of report.results) {
    console.log(`  ${icon[r.verdict]} [${r.claim.kind}] ${r.claim.subject}`);
    console.log(`      claim:    "${r.claim.quote.slice(0, 100)}"`);
    console.log(`      reality:  ${r.evidence}\n`);
  }
  const s = report.summary;
  console.log(`  ${s.verified} verified · ${s.contradicted} contradicted · ${s.unverifiable} unverifiable`);
  console.log(s.pass ? "  PASS — no claim contradicted by reality." : "  FAIL — the narrative does not match the repo.");
}
process.exit(report.summary.pass ? 0 : 1);
