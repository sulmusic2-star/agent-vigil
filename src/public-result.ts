import { primaryResultFinding, type ResultView } from "./result-view.ts";

// Only fixed rule descriptions belong in a public summary. Finding titles,
// locations, evidence and reproduction commands can contain private input.
const PUBLIC_REASONS: ReadonlyMap<string, string> = new Map([
  ["tests-pass", "Test verification failed."],
  ["test-count", "The reported passing-test count does not match the observed count."],
  ["test-skip-added", "The check reported a new skipped or focused test."],
  ["test-oracle-constant", "The check reported an assertion that does not test the changed behavior."],
  ["assertion-drop", "The check reported removed test assertions."],
  ["test-assertion-relaxed", "The check reported a weakened test assertion."],
  ["test-code-context-unchecked", "Vigil could not determine whether quoted code changes how a test runs."],
  ["automated-review-command", "A configured verification command did not pass."],
  ["automated-review-setup", "The verification environment could not be set up."],
  ["protected-path", "This change includes a file protected by the review policy."],
  ["changed-file-budget", "This change exceeds the policy's file limit."],
  ["changed-line-budget", "This change exceeds the policy's changed-line limit."],
  ["completion-evidence", "Required verification evidence is missing."],
]);

export function publicResultLines(view: ResultView): string[] {
  if (view.verdict === "PASS") {
    return [
      "Required verification passed under the recorded policy.",
      ...(view.counts.notChecked ? [`${view.counts.notChecked} other ${view.counts.notChecked === 1 ? "check" : "checks"} could not be verified; this policy does not require ${view.counts.notChecked === 1 ? "it" : "them"} to pass.`] : []),
    ];
  }
  const finding = primaryResultFinding(view.findings);
  const knownReason = finding && PUBLIC_REASONS.get(finding.id);
  if (!finding || !knownReason) {
    return [
      view.verdict === "FAIL" ? "A required check failed." : "Required verification is incomplete.",
      "**Next:** Open the retained receipt for this check's reason and next action.",
    ];
  }
  const reason = finding.state === "NOT_CHECKED"
    && finding.id !== "completion-evidence" && finding.id !== "test-code-context-unchecked"
    ? "This check could not be verified. That does not mean it never ran."
    : knownReason;
  const counts = finding.id === "test-count"
    ? [`Passing tests — claimed: ${finding.claimedTestCount ?? "not available"}; observed: ${finding.observedTestCount ?? "not available"}.`]
    : [];
  return [
    `**Why:** ${reason}`,
    ...counts,
    `**Next:** ${finding.remediation}`,
    ...(view.counts.failed + view.counts.notChecked > 1
      ? ["This is the first issue to address, not the complete list. The retained receipt contains the remaining findings."] : []),
  ];
}
