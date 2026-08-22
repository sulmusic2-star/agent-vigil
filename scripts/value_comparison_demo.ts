import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildReport, type CheckResult } from "../src/report.ts";
import { buildValueCard, type AgentValueCard } from "../src/value.ts";
import { compareValueCards, renderValueComparisonHtml } from "../src/value-compare.ts";

function check(): CheckResult {
  return { claim: { kind: "tests_pass", quote: "tests pass", subject: "synthetic suite" }, verdict: "verified", evidence: "synthetic demonstration", ruleId: "tests-pass" };
}

function card(index: number, adapter: string, model: string, positive: boolean): AgentValueCard {
  const report = buildReport({
    transcript: `synthetic-${index}.jsonl`,
    transcriptSha256: `sha256:${(index % 10).toString().repeat(64)}`,
    transcriptFormat: adapter,
    repo: "/synthetic-demonstration",
    base: "a".repeat(40),
    head: index.toString(16).padStart(40, "0"),
    results: [check()],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"b".repeat(64)}` },
  });
  return buildValueCard({
    report,
    hashValid: true,
    usage: {
      source: "transcript-observed",
      accounting: adapter === "demo-agent-a" ? "cumulative-session-snapshot" : "deduplicated-assistant-messages",
      inputTokens: 800,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 200,
      reasoningOutputTokens: 0,
      totalTokens: 1_000,
      modelIds: [model],
      recordsObserved: 1,
      accountedUnits: 1,
    },
    values: {
      taskClass: "synthetic-bugfix",
      costUsd: adapter === "demo-agent-a" ? 1.1 : 0.85,
      costSource: "user-estimated",
      costEvidenceSha256: `sha256:${"c".repeat(64)}`,
      disposition: "accepted",
      reviewMinutes: adapter === "demo-agent-a" ? 8 : 12,
      reviewEvidenceSha256: `sha256:${"d".repeat(64)}`,
      outcome: positive ? "merged" : "reverted",
      outcomeAsOf: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
      outcomeEvidenceSha256: `sha256:${"e".repeat(64)}`,
    },
  });
}

const cards = [
  ...Array.from({ length: 6 }, (_, index) => card(index + 1, "demo-agent-a", "demo-model-a", index < 5)),
  ...Array.from({ length: 6 }, (_, index) => card(index + 11, "demo-agent-b", "demo-model-b", index < 4)),
];
const comparison = compareValueCards(cards);
comparison.warnings.unshift("SYNTHETIC DEMONSTRATION ONLY: these episodes, costs, models, and outcomes are fabricated fixtures, not vendor performance or external adoption.");
const htmlPath = resolve(process.argv[2] ?? "docs/assets/agent-value-comparison-demo.html");
const jsonPath = resolve(process.argv[3] ?? "docs/assets/agent-value-comparison-demo.json");
writeFileSync(htmlPath, renderValueComparisonHtml(comparison));
writeFileSync(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
console.log(`wrote ${htmlPath}`);
console.log(`wrote ${jsonPath}`);

