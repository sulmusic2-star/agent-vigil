import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderResultViewHtml, type ResultView } from "../src/result-view.ts";

export const demoResultView: ResultView = {
  schemaVersion: "agent-vigil/result-view/v1",
  verdict: "FAIL",
  consequence: "Do not merge yet.",
  mainCause: "The isolated run found fewer passing tests than the agent reported.",
  counts: { failed: 1, passed: 5, notChecked: 1 },
  findings: [
    {
      id: "test-count",
      state: "FAILED",
      title: "Reported test count does not match the isolated run",
      evidence: "The agent reported 184 passing tests. The isolated run found 161.",
      remediation: "Run the configured test command again and report the observed passing count exactly.",
      location: { file: "test/verification.test.ts", line: 88 },
      claimedTestCount: 184,
      observedTestCount: 161,
    },
    {
      id: "command-ran",
      state: "NOT_CHECKED",
      title: "Build command was not observed",
      evidence: "The retained trajectory has no terminal result for npm run build.",
      remediation: "Run npm run build and retain its terminal result.",
    },
    {
      id: "workspace-bound",
      state: "PASSED",
      title: "Workspace matches receipt head",
      evidence: "The isolated checkout matched the exact head commit.",
      remediation: "No action required.",
    },
  ],
  advisories: [],
  base: "4d407f7e171a1c3d67a80a55650f0966db304fb5",
  head: "bf3b7458ebf672fbc4ba5358c02242368af602dc",
  generatedAt: "2026-08-27T16:00:00.000Z",
  receiptHash: "sha256:97e198ee9c5281a03f5bc3198a88c8b2df9427ce37518f3a4bf84d71a8ddf483",
  policyHash: "sha256:1f43070cb8b0a5e395e0e11de07db3eb3d9b9202d4d606d82eed3a76fb55e458",
  reproduce: "npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.1/sulmusic-agent-vigil-0.21.1.tgz receipt-view ./agent-vigil-receipt.json --format html --output ./agent-vigil-result.html",
  changedFiles: {
    complete: true,
    evidence: "Git reported 3 changed files for the exact range.",
    files: [
      { status: "modified", path: "src/outcome-cli.ts" },
      { status: "modified", path: "src/output.ts" },
      { status: "added", path: "src/result-view.ts" },
    ],
  },
};

if (process.argv[1]?.endsWith("render_result_view_demo.ts")) {
  const output = resolve(process.argv[2] ?? "docs/assets/outcome-verifier-demo.html");
  writeFileSync(output, renderResultViewHtml(demoResultView), "utf8");
  console.log(`Result view demo written to ${output}`);
}
