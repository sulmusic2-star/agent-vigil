import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPublicPrReceipt,
  type PublicPrSnapshot,
} from "../src/public-pr-receipt.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TOOL = "3".repeat(40);
const API = "https://api.github.com/repos/example/project";

function snapshot(conclusion: "neutral" | "skipped"): PublicPrSnapshot {
  return {
    pull: {
      state: "closed",
      merged: true,
      merged_at: "2026-08-25T12:00:00Z",
      updated_at: "2026-08-25T12:00:00Z",
      base: { sha: BASE, repo: { private: false } },
      head: { sha: HEAD, repo: { private: false } },
    },
    reviews: [{
      state: "APPROVED",
      submitted_at: "2026-08-25T11:00:00Z",
      user: { login: "maintainer" },
    }],
    checkRuns: [{
      status: "completed",
      conclusion,
      completed_at: "2026-08-25T11:30:00Z",
    }],
    statuses: [],
    sources: [
      { kind: "pull-request", endpoint: `${API}/pulls/42`, status: 200, bytes: 2, sha256: `sha256:${"4".repeat(64)}`, complete: true },
      { kind: "reviews", endpoint: `${API}/pulls/42/reviews?per_page=100`, status: 200, bytes: 2, sha256: `sha256:${"4".repeat(64)}`, complete: true },
      { kind: "check-runs", endpoint: `${API}/commits/${HEAD}/check-runs?per_page=100`, status: 200, bytes: 2, sha256: `sha256:${"4".repeat(64)}`, complete: true },
      { kind: "commit-statuses", endpoint: `${API}/commits/${HEAD}/statuses?per_page=100`, status: 200, bytes: 2, sha256: `sha256:${"4".repeat(64)}`, complete: true },
    ],
    unavailable: [],
  };
}

test("neutral and skipped GitHub checks are non-proving evidence", () => {
  for (const conclusion of ["neutral", "skipped"] as const) {
    const receipt = buildPublicPrReceipt(
      snapshot(conclusion),
      "https://github.com/example/project/pull/42",
      {
        generatedAt: "2026-08-25T13:00:00.000Z",
        maxAgeHours: 168,
        toolVersion: "0.22.0",
        toolCommit: TOOL,
      },
    );

    assert.equal(receipt.decision.continuity, "HOLD");
    assert.deepEqual(receipt.observation.checks, {
      total: 1,
      passing: 0,
      failing: 0,
      pending: 0,
      unknown: 1,
    });
    assert.ok(receipt.decision.reasonCodes.includes("checks-neutral-or-skipped"));
    assert.equal(receipt.observation.freshnessReferenceAt, null);
  }
});
