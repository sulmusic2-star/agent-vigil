import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the public entry point leads with a no-account PR check and keeps trial registration optional", () => {
  const readme = read("README.md");
  const form = read(".github/ISSUE_TEMPLATE/adopter-feedback.yml");
  assert.match(readme, /Agent Vigil is a required GitHub check for pull requests made with coding agents/);
  assert.match(readme, /Paste a public pull-request URL.*No login, token, repository write, or source upload/s);
  assert.match(readme, /Those adapters do not make an\s+unsupported repository eligible for the hosted installer/s);
  assert.match(readme, /optionally.*register a trial/s);
  assert.match(form, /Opening this form does not count as an installation/);
  assert.match(form, /workflow that actually uses Agent Vigil/);
  assert.match(form, /required job name by itself does not count/);
  assert.match(form, /id: evidence[\s\S]*?validations:\s*\n\s*required: true/);
  assert.doesNotMatch(form, /- Evaluating|- Not installed|- Installed locally/);
});

test("the dated census runs daily and the experiment keeps traffic separate from adoption", () => {
  const workflow = read(".github/workflows/adoption-census.yml");
  const experiment = read("docs/ADOPTION_EXPERIMENT_2026-08-28.md");
  assert.match(workflow, /cron: "17 13 \* \* \*"/);
  assert.match(workflow, /2026-08-28 through 2026-09-10/);
  assert.match(workflow, /public_adoption_census\.py --output adoption-census\.json/);
  assert.match(workflow, /public_adoption_census\.py --run-window-start 2026-08-28 --run-window-end 2026-09-10/);
  assert.match(workflow, /experiment-adoption-census\.json/);
  assert.match(workflow, /adoption_evidence\.py --window-start 2026-08-28 --window-end 2026-09-10/);
  assert.match(experiment, /2026-08-28 through 2026-09-10, inclusive/);
  assert.match(experiment, /clones may include bots, CI, mirrors, and repeated automation/);
  assert.match(experiment, /required job name by itself does not count/);
  assert.match(experiment, /zero configured external repositories/);
  assert.match(experiment, /Do not describe traffic.*as adoption, payment, revenue, or market validation/s);
});

test("experiment evidence includes both boundary dates and excludes adjacent dates", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-adoption-window-"));
  const censusFixture = join(dir, "census.json");
  writeFileSync(censusFixture, JSON.stringify({
    references: [{
      repository: "external/windowed",
      path: ".github/workflows/vigil.yml",
      content: "uses: sulmusic2-star/agent-vigil@v0.22.0",
      workflow_run_timestamps: [
        "2026-08-27T23:59:59Z", "2026-08-28T00:00:00Z",
        "2026-09-10T23:59:59Z", "2026-09-11T00:00:00Z",
      ],
    }],
    receipt_artifacts: { "external/windowed": 0 },
  }));
  const census = JSON.parse(execFileSync("python3", [
    "scripts/public_adoption_census.py", "--fixture", censusFixture,
    "--run-window-start", "2026-08-28", "--run-window-end", "2026-09-10",
  ], { encoding: "utf8" }));
  assert.equal(census.configured_repositories["external/windowed"].workflow_runs_observed, 2);
  assert.equal(census.configured_repositories["external/windowed"].first_run_observed_at, "2026-08-28T00:00:00Z");
  assert.equal(census.configured_repositories["external/windowed"].last_run_observed_at, "2026-09-10T23:59:59Z");

  const ledger = join(dir, "ledger.json");
  const entry = (day: string, suffix: string) => ({
    repository: `outside/project-${suffix}`,
    ownerConsentUrl: `https://github.com/outside/project-${suffix}/issues/7`,
    workflowUrl: `https://github.com/outside/project-${suffix}/blob/main/.github/workflows/vigil.yml`,
    latestRunUrl: `https://github.com/outside/project-${suffix}/actions/runs/123`,
    firstObservedAt: `${day}T12:00:00Z`, lastObservedAt: `${day}T13:00:00Z`,
    currentWorkflowConfigured: true, verdictsObserved: 0, receiptHashes: [],
    requiredCheckEvidenceUrl: null, requiredCheckObservedAt: null, retentionEvidenceUrl: null,
    configurationObservedAt: [`${day}T12:00:00Z`],
    maintainerAcceptedContradictions: [], falseVerdictReports: [],
  });
  writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, entries: [
    entry("2026-08-27", "before"), entry("2026-08-28", "start"),
    entry("2026-09-10", "end"), entry("2026-09-11", "after"),
  ] }));
  const consented = JSON.parse(execFileSync("python3", [
    "scripts/adoption_evidence.py", "--ledger", ledger,
    "--window-start", "2026-08-28", "--window-end", "2026-09-10",
  ], { encoding: "utf8" }));
  assert.equal(consented.experimentCounts.externalRepositoriesConfigured, 2);
  assert.deepEqual(consented.experimentWindow, { start: "2026-08-28", end: "2026-09-10", inclusive: true });
});

test("experiment retention and required checks use actual in-window timestamps", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-adoption-observations-"));
  const ledger = join(dir, "ledger.json");
  const makeEntry = (
    suffix: string,
    first: string,
    last: string,
    configuredAt: string[],
    requiredAt: string | null,
    currentWorkflowConfigured = true,
  ) => ({
    repository: `outside/observed-${suffix}`,
    ownerConsentUrl: `https://github.com/outside/observed-${suffix}/issues/7`,
    workflowUrl: `https://github.com/outside/observed-${suffix}/blob/main/.github/workflows/vigil.yml`,
    latestRunUrl: `https://github.com/outside/observed-${suffix}/actions/runs/123`,
    firstObservedAt: first,
    lastObservedAt: last,
    currentWorkflowConfigured,
    verdictsObserved: 0,
    receiptHashes: [],
    requiredCheckEvidenceUrl: requiredAt === null ? null : `https://github.com/outside/observed-${suffix}/issues/8`,
    requiredCheckObservedAt: requiredAt,
    configurationObservedAt: configuredAt,
    retentionEvidenceUrl: null,
    maintainerAcceptedContradictions: [],
    falseVerdictReports: [],
  });
  writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, entries: [
    makeEntry("real-seven-days", "2026-08-28T00:00:00Z", "2026-09-11T00:00:00Z", ["2026-08-28T00:00:00Z", "2026-09-04T00:00:00Z"], "2026-09-04T00:00:00Z", false),
    makeEntry("short-elapsed", "2026-08-28T23:59:59Z", "2026-09-04T00:00:00Z", ["2026-08-28T23:59:59Z", "2026-09-04T00:00:00Z"], null),
    makeEntry("after-window", "2026-09-03T00:00:00Z", "2026-09-11T00:00:00Z", ["2026-09-03T00:00:00Z", "2026-09-11T00:00:00Z"], "2026-09-11T00:00:00Z"),
  ] }));
  const result = JSON.parse(execFileSync("python3", [
    "scripts/adoption_evidence.py", "--ledger", ledger,
    "--window-start", "2026-08-28", "--window-end", "2026-09-10",
  ], { encoding: "utf8" }));
  assert.equal(result.experimentCounts.externalRepositoriesConfigured, 3);
  assert.equal(result.experimentCounts.repositoriesWithSevenDayObservedSpan, 1);
  assert.equal(result.experimentCounts.externalRequiredChecks, 1);
});
