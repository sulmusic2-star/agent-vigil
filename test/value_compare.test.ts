import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, type CheckResult } from "../src/report.ts";
import { buildValueCard, recomputeValueCardHash, type AgentValueCard } from "../src/value.ts";
import { compareValueCards, loadValueCard, renderValueComparisonHtml, wilson95 } from "../src/value-compare.ts";
import { run } from "../src/cli.ts";

function passResult(): CheckResult {
  return { claim: { kind: "tests_pass", quote: "tests pass", subject: "test suite" }, verdict: "verified", evidence: "fresh suite passed", ruleId: "tests-pass" };
}

function card(index: number, adapter: string, model: string, outcome: "merged" | "reverted" = "merged", taskClass = "bugfix"): AgentValueCard {
  const digit = (index % 10).toString();
  const report = buildReport({
    transcript: `session-${index}.jsonl`, transcriptSha256: `sha256:${digit.repeat(64)}`, transcriptFormat: adapter,
    repo: "/synthetic", base: "a".repeat(40), head: index.toString(16).padStart(40, "0"), results: [passResult()],
    policy: { minVerified: 1, strict: true, sha256: `sha256:${"c".repeat(64)}` },
  });
  return buildValueCard({
    report, hashValid: true,
    usage: { source: "transcript-observed", accounting: adapter === "claude-code" ? "deduplicated-assistant-messages" : "cumulative-session-snapshot", inputTokens: 80, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 100, modelIds: [model], recordsObserved: 1, accountedUnits: 1 },
    values: {
      taskClass, costUsd: adapter === "codex" ? 2 : 1, costSource: "provider-billed", costEvidenceSha256: `sha256:${"d".repeat(64)}`,
      disposition: "accepted", reviewEvidenceSha256: `sha256:${"e".repeat(64)}`,
      outcome, outcomeAsOf: new Date(Date.UTC(2026, 7, 1 + index)).toISOString(), outcomeEvidenceSha256: `sha256:${"f".repeat(64)}`,
      reviewMinutes: adapter === "codex" ? 10 : 15,
    },
  });
}

test("Wilson interval uses bounded 95% score uncertainty", () => {
  const interval = wilson95(4, 5)!;
  assert.ok(interval.lower > 0.37 && interval.lower < 0.38);
  assert.ok(interval.upper > 0.96 && interval.upper < 0.97);
  assert.equal(wilson95(0, 0), undefined);
  assert.equal(wilson95(6, 5), undefined);
});

test("task-matched comparison becomes comparable only with adequate evidence per agent", () => {
  const cards = [
    ...Array.from({ length: 5 }, (_, index) => card(index + 1, "codex", "gpt-test", index === 4 ? "reverted" : "merged")),
    ...Array.from({ length: 5 }, (_, index) => card(index + 11, "claude-code", "claude-test", index >= 3 ? "reverted" : "merged")),
  ];
  const comparison = compareValueCards(cards);
  assert.equal(comparison.status, "COMPARABLE");
  assert.deepEqual(comparison.comparableTaskClasses, ["bugfix"]);
  const codex = comparison.groups.find((group) => group.agent === "codex")!;
  assert.equal(codex.episodes, 5);
  assert.equal(codex.positive, 4);
  assert.equal(codex.negative, 1);
  assert.equal(codex.costEvidenceCompleteness, 1);
  assert.equal(codex.costPerPositiveUsd, 2.5);
  assert.equal(codex.medianReviewMinutes, 10);
  assert.ok(codex.positiveRateWilson95);
});

test("comparison deduplicates a receipt and retains the latest downstream observation", () => {
  const first = card(1, "codex", "gpt-test", "merged");
  const later = structuredClone(first);
  later.outcome.state = "reverted";
  later.outcome.asOf = "2026-09-01T00:00:00.000Z";
  later.valueVerdict = "NEGATIVE";
  later.cardHash = recomputeValueCardHash(later);
  const comparison = compareValueCards([first, later]);
  assert.equal(comparison.uniqueEpisodes, 1);
  assert.equal(comparison.supersededCards, 1);
  assert.equal(comparison.groups[0].negative, 1);
});

test("small or incomplete groups remain inconclusive and are not ranked", () => {
  const incomplete = card(1, "codex", "gpt-test");
  incomplete.cost.status = "SELF_ASSERTED";
  delete incomplete.cost.evidenceSha256;
  incomplete.valueVerdict = "INCONCLUSIVE";
  incomplete.cardHash = recomputeValueCardHash(incomplete);
  const comparison = compareValueCards([incomplete, card(2, "claude-code", "claude-test")]);
  assert.equal(comparison.status, "INCONCLUSIVE");
  assert.ok(comparison.warnings.some((warning) => /do not rank/.test(warning)));
  assert.ok(comparison.warnings.some((warning) => /hashed-cost completeness/.test(warning)));
});

test("compare-value CLI verifies card hashes and writes private JSON and escaped HTML", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-value-compare-"));
  const paths = Array.from({ length: 10 }, (_, index) => {
    const value = card(index + 1, index < 5 ? "codex" : "claude-code", index < 5 ? "gpt-test" : "claude-test");
    const path = join(root, `card-${index}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  });
  const output = join(root, "comparison.json");
  assert.equal(run(["compare-value", ...paths, "--format", "json", "--output", output]), 0);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "COMPARABLE");
  assert.equal(statSync(output).mode & 0o777, 0o600);

  const escaped = renderValueComparisonHtml(compareValueCards([card(50, "codex", "gpt-test", "merged", "<script>alert(1)</script>")]));
  assert.doesNotMatch(escaped, /<script>alert/);
  assert.match(escaped, /&lt;script&gt;alert/);

  const tampered = paths[0];
  const value = JSON.parse(readFileSync(tampered, "utf8"));
  value.valueVerdict = "NEGATIVE";
  writeFileSync(tampered, JSON.stringify(value));
  assert.throws(() => loadValueCard(tampered), /hash is invalid/);
  assert.equal(run(["compare-value", tampered]), 2);
});
