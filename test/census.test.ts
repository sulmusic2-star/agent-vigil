import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("public census separates references, configurations, runs, and receipt artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-census-"));
  const fixture = join(dir, "fixture.json");
  writeFileSync(fixture, JSON.stringify({
    references: [
      { repository: "external/installed", path: ".github/workflows/vigil.yml", content: "- uses: sulmusic2-star/agent-vigil@v0.7.0", workflow_runs: 9 },
      { repository: "external/catalog", path: "README.md", content: "uses: sulmusic2-star/agent-vigil@v0.7.0" },
      { repository: "sulmusic2-star/own", path: ".github/workflows/vigil.yml", content: "uses: sulmusic2-star/agent-vigil@v0.7.0", workflow_runs: 4 },
      { repository: "external/mention", path: ".github/workflows/other.yml", content: "# sulmusic2-star/agent-vigil@v0.7.0", workflow_runs: 1 },
    ],
    receipt_artifacts: { "external/installed": 3 },
  }));
  const output = execFileSync("python3", ["scripts/public_adoption_census.py", "--fixture", fixture], { cwd: process.cwd(), encoding: "utf8" });
  const census = JSON.parse(output);
  assert.equal(census.counts.external_repositories_configured, 1);
  assert.equal(census.counts.external_repositories_with_workflow_runs_observed, 1);
  assert.equal(census.counts.currently_listed_external_receipt_artifacts, 3);
  assert.equal(census.references.filter((row: { state: string }) => row.state === "reference-only").length, 3);
});

test("public census preserves unknown artifact state instead of turning it into zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-census-"));
  const fixture = join(dir, "fixture.json");
  writeFileSync(fixture, JSON.stringify({ references: [
    { repository: "external/private-artifacts", path: ".github/workflows/vigil.yaml", content: "uses: sulmusic2-star/agent-vigil@main", workflow_runs: null },
  ], receipt_artifacts: { "external/private-artifacts": null } }));
  const census = JSON.parse(execFileSync("python3", ["scripts/public_adoption_census.py", "--fixture", fixture], { cwd: process.cwd(), encoding: "utf8" }));
  assert.equal(census.counts.external_repositories_configured, 1);
  assert.equal(census.counts.repositories_with_unknown_artifact_count, 1);
  assert.equal(census.counts.currently_listed_external_receipt_artifacts, 0);
});

