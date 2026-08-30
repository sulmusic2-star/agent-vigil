import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPublicPrReceipt, type PublicPrSnapshot } from "../src/public-pr-receipt.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const PR_URL = "https://github.com/example/project/pull/42";
const GENERATED_AT = "2026-08-28T22:00:00.000Z";
const TOOL_COMMIT = "eed2cd0db000099f86d29186bdb2fd1c7784356a";
const SHA = `sha256:${"a".repeat(64)}`;

async function browserModule(): Promise<any> {
  return import("../docs/check.js");
}

function snapshot(overrides: Partial<PublicPrSnapshot> = {}): PublicPrSnapshot {
  const root = "https://api.github.com/repos/example/project";
  return {
    pull: {
      state: "closed",
      merged: true,
      merged_at: "2026-08-28T21:00:00Z",
      updated_at: "2026-08-28T21:30:00Z",
      title: "Keep the public evidence exact",
      changed_files: 3,
      additions: 20,
      deletions: 4,
      base: { sha: BASE, repo: { private: false } },
      head: { sha: HEAD, repo: { private: false } },
    },
    reviews: [{ state: "APPROVED", submitted_at: "2026-08-28T21:10:00Z", user: { login: "maintainer" } }],
    checkRuns: [{ id: 1, name: "tests", app: { slug: "github-actions" }, status: "completed", conclusion: "success", completed_at: "2026-08-28T21:20:00Z" }],
    statuses: [{ id: 2, context: "preview", state: "success", updated_at: "2026-08-28T21:25:00Z" }],
    sources: [
      { kind: "pull-request", endpoint: `${root}/pulls/42`, status: 200, bytes: 10, sha256: SHA, complete: true },
      { kind: "reviews", endpoint: `${root}/pulls/42/reviews?per_page=100`, status: 200, bytes: 10, sha256: SHA, complete: true },
      { kind: "check-runs", endpoint: `${root}/commits/${HEAD}/check-runs?per_page=100`, status: 200, bytes: 10, sha256: SHA, complete: true },
      { kind: "commit-statuses", endpoint: `${root}/commits/${HEAD}/statuses?per_page=100`, status: 200, bytes: 10, sha256: SHA, complete: true },
    ],
    unavailable: [],
    ...overrides,
  };
}

function browserSnapshot(value: PublicPrSnapshot): Record<string, unknown> {
  return {
    ...value,
    target: { owner: "example", repo: "project", number: 42, url: PR_URL },
  };
}

test("the browser receipt matches the reviewed CLI receipt contract", async () => {
  const browser = await browserModule();
  const value = snapshot();
  const cli = buildPublicPrReceipt(value, PR_URL, {
    generatedAt: GENERATED_AT,
    maxAgeHours: 168,
    toolVersion: "0.23.0-browser.1",
    toolCommit: TOOL_COMMIT,
  });
  const web = await browser.buildBrowserReceipt(browserSnapshot(value), {
    generatedAt: GENERATED_AT,
    maxAgeHours: 168,
  });
  assert.deepEqual(web, cli);
  assert.equal(web.decision.continuity, "CURRENT");
  assert.equal(web.decision.allowsProtectedAction, false);
});

test("an open pull request with passing checks remains HOLD in the public browser receipt", async () => {
  const browser = await browserModule();
  const value = snapshot({
    pull: {
      state: "open",
      merged: false,
      merged_at: null,
      updated_at: "2026-08-28T21:30:00Z",
      base: { sha: BASE, repo: { private: false } },
      head: { sha: HEAD, repo: { private: false } },
    },
  });
  const receipt = await browser.buildBrowserReceipt(browserSnapshot(value), { generatedAt: GENERATED_AT });
  assert.equal(receipt.decision.continuity, "HOLD");
  assert.ok(receipt.decision.reasonCodes.includes("pull-request-not-merged"));
  assert.equal(receipt.decision.allowsProtectedAction, false);
});

test("missing pagination and failed checks cannot become CURRENT", async () => {
  const browser = await browserModule();
  const value = snapshot({
    checkRuns: [{ id: 1, name: "tests", status: "completed", conclusion: "failure", completed_at: "2026-08-28T21:20:00Z" }],
    unavailable: ["reviews:pagination-incomplete"],
  });
  const receipt = await browser.buildBrowserReceipt(browserSnapshot(value), { generatedAt: GENERATED_AT });
  assert.equal(receipt.decision.continuity, "HOLD");
  assert.ok(receipt.decision.reasonCodes.includes("checks-failing"));
  assert.ok(receipt.decision.reasonCodes.includes("source-coverage-incomplete"));
});

test("the browser refuses GitHub's neutral and skipped false-green conclusions", async () => {
  const browser = await browserModule();
  for (const conclusion of ["neutral", "skipped"]) {
    const value = snapshot({
      checkRuns: [{ id: 1, name: "tests", app: { slug: "github-actions" }, status: "completed", conclusion, completed_at: "2026-08-28T21:20:00Z" }],
      statuses: [],
    });
    const receipt = await browser.buildBrowserReceipt(browserSnapshot(value), { generatedAt: GENERATED_AT });
    const rows = browser.latestVisibleChecks(value.checkRuns, value.statuses);
    assert.equal(receipt.decision.continuity, "HOLD");
    assert.deepEqual(receipt.observation.checks, { total: 1, passing: 0, failing: 0, pending: 0, unknown: 1 });
    assert.ok(receipt.decision.reasonCodes.includes("checks-neutral-or-skipped"));
    assert.equal(rows[0].state, "unknown");
    assert.equal(rows[0].conclusion, conclusion);
  }
});

test("the browser URL parser rejects credential, query, fragment, and non-GitHub inputs", async () => {
  const { parsePullRequestUrl } = await browserModule();
  assert.deepEqual(parsePullRequestUrl(PR_URL), { owner: "example", repo: "project", number: 42, url: PR_URL });
  for (const value of [
    "http://github.com/example/project/pull/42",
    "https://token@github.com/example/project/pull/42",
    "https://github.com/example/project/pull/42?token=secret",
    "https://github.com/example/project/pull/42#files",
    "https://evil.example/example/project/pull/42",
    "https://github.com/example/project/issues/42",
  ]) assert.throws(() => parsePullRequestUrl(value));
});

test("the installation handoff is immutable and requires an explicit local run", async () => {
  const browser = await browserModule();
  const { installationCommand } = browser;
  const command = installationCommand();
  assert.equal(command, "npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.0/sulmusic-agent-vigil-0.23.0.tgz protect --repo .");
  assert.doesNotMatch(command, /@(?:main|master|latest)|releases\/latest/);
  const receipt = await browser.buildBrowserReceipt(browserSnapshot(snapshot()), { generatedAt: GENERATED_AT });
  const steps = browser.installationSteps(receipt);
  assert.match(steps, /^# In a local checkout of example\/project:/);
  assert.match(steps, /doctor --repo \./);
  assert.match(steps, /plain required job name is not a workflow trust root/);
  assert.doesNotMatch(steps, /git push|gh pr create|curl|token/);
  assert.match(browser.adoptionRegistrationUrl(receipt), /template=adopter-feedback\.yml&title=%5Badoption%5D%20example%2Fproject$/);
});

test("the copied PR result is bounded, source-free, and never claims authorization", async () => {
  const browser = await browserModule();
  const receipt = await browser.buildBrowserReceipt(browserSnapshot(snapshot()), { generatedAt: GENERATED_AT });
  const card = browser.prCommentMarkdown(receipt);
  assert.match(card, /\*\*Agent Vigil public evidence: CURRENT\*\*/);
  assert.ok(card.includes("Base: `" + BASE + "`"));
  assert.ok(card.includes("Head: `" + HEAD + "`"));
  assert.match(card, /Observed: merged-approved-checks-observed/);
  assert.doesNotMatch(card, /Unresolved:/);
  assert.match(card, /does not authorize merge or deployment/);
  assert.match(card, /https:\/\/sulmusic2-star\.github\.io\/agent-vigil\/check\.html/);
  assert.doesNotMatch(card, /Keep the public evidence exact|tests|preview|prompt|transcript/);
  assert.ok(card.length < 1_500);
});

test("the copied HOLD result labels its reason codes as unresolved", async () => {
  const browser = await browserModule();
  const value = snapshot({
    pull: {
      state: "open",
      merged: false,
      merged_at: null,
      updated_at: "2026-08-28T21:30:00Z",
      base: { sha: BASE, repo: { private: false } },
      head: { sha: HEAD, repo: { private: false } },
    },
  });
  const receipt = await browser.buildBrowserReceipt(browserSnapshot(value), { generatedAt: GENERATED_AT });
  assert.match(browser.prCommentMarkdown(receipt), /Unresolved: pull-request-not-merged/);
});

test("the copied PR result rejects hostile or unbounded receipt fields", async () => {
  const browser = await browserModule();
  const receipt = await browser.buildBrowserReceipt(browserSnapshot(snapshot()), { generatedAt: GENERATED_AT });
  for (const candidate of [
    { ...receipt, receiptHash: "sha256:`send me secrets`" },
    { ...receipt, decision: { ...receipt.decision, reasonCodes: ["gap\n@everyone"] } },
    { ...receipt, decision: { ...receipt.decision, reasonCodes: Array(17).fill("gap") } },
    { ...receipt, observation: { ...receipt.observation, checks: { ...receipt.observation.checks, passing: "many" } } },
  ]) assert.throws(() => browser.prCommentMarkdown(candidate), /complete browser receipt/);
  assert.throws(
    () => browser.installationSteps({ ...receipt, subject: { ...receipt.subject, repository: "example/project\n@everyone" } }),
    /valid public repository/,
  );
  assert.throws(
    () => browser.installationSteps({ ...receipt, subject: { ...receipt.subject, repository: "../project" } }),
    /valid public repository/,
  );
});

test("the static checker has an accessible mobile result surface and no browser storage", () => {
  const html = readFileSync(new URL("../docs/check.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../docs/check.js", import.meta.url), "utf8");
  assert.match(html, /<main>/);
  assert.match(html, /<label for="pr-url">/);
  assert.match(html, /id="check-live" aria-live="polite"/);
  assert.match(html, /id="check-result" aria-labelledby="result-title" tabindex="-1"/);
  assert.match(html, /aria-label="Result actions"/);
  assert.match(html, /id="copy-pr-result"[^>]*>Copy result for PR/);
  assert.match(html, /id="copy-install"[^>]*>Copy setup steps/);
  assert.match(html, /id="register-trial"[^>]*hidden>Register this trial/);
  assert.match(html, /Skipped and neutral conclusions may satisfy GitHub branch protection/);
  assert.match(html, /min-height: 48px/);
  assert.match(html, /@media \(max-width: 760px\)/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /Content-Security-Policy[^>]+connect-src https:\/\/api\.github\.com/);
  assert.doesNotMatch(script, /\.innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie|indexedDB/);
  assert.match(script, /method: "GET"/);
  assert.match(script, /credentials: "omit"/);
  assert.match(script, /sourceCodeFetched: false/);
  assert.match(script, /allowsProtectedAction: false/);
});
