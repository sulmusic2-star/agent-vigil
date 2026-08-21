#!/usr/bin/env node

const scenes = [
  ["00:00", "AGENT CLAIM", "All 99 tests pass. Regression included."],
  ["00:08", "IDENTITY", "Bind the exact base SHA, head SHA, and base-branch policy."],
  ["00:18", "FRESH RUN", "Runner exits 0 — but reports 42 tests, not 99."],
  ["00:30", "NEGATIVE CONTROL", "Changed regression also passes against base source."],
  ["00:42", "VERDICT", "FAIL · test-count · differential-base-fail"],
  ["00:52", "RECEIPT", "Merge stays blocked. Reproduce from the signed evidence receipt."],
];

const wait = process.argv.includes("--realtime");
for (const [time, label, message] of scenes) {
  process.stdout.write(`\n${time}  ${label}\n${message}\n`);
  if (wait) await new Promise((resolve) => setTimeout(resolve, 8_000));
}
process.stdout.write("\nIllustrative demo. See proof/ for exact first-party historical cases.\n");
