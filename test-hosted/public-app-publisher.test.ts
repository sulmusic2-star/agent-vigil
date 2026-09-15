import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const WORKFLOW = new URL("../.github/workflows/public-app-gate.yml", import.meta.url);
const TEMPLATE = new URL("../hosted/public-app/control-workflow.yml", import.meta.url);
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const BODY = "Local fixture PR description";
const bodyHash = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

type Scenario = {
  name: string;
  env?: Record<string, string>;
  pull?: Record<string, unknown>;
  ref?: Record<string, unknown>;
  apiError?: boolean;
  title: "PASS" | "FAIL" | "NOT CHECKED" | "NO UPDATE";
};
const scenarios: Scenario[] = [
  { name: "current PR with complete passing evidence", title: "PASS" },
  { name: "current PR with failed check", env: { VIGIL_STATUS: "FAIL", EVIDENCE_RESULT: "failure" }, title: "FAIL" },
  { name: "moved head", pull: { head: { sha: "c".repeat(40) } }, title: "NOT CHECKED" },
  { name: "moved base", pull: { base: { sha: "c".repeat(40) } }, title: "NOT CHECKED" },
  { name: "edited description", pull: { body: "Changed after verification" }, title: "NOT CHECKED" },
  { name: "non-text description", pull: { body: { text: BODY } }, title: "NOT CHECKED" },
  { name: "closed PR", pull: { state: "closed" }, title: "NOT CHECKED" },
  { name: "missing description hash", env: { EXPECTED_PR_BODY_SHA256: "" }, title: "NOT CHECKED" },
  { name: "malformed description hash", env: { EXPECTED_PR_BODY_SHA256: "invalid" }, title: "NOT CHECKED" },
  { name: "empty PR description", pull: { body: null }, env: { EXPECTED_PR_BODY_SHA256: bodyHash("") }, title: "PASS" },
  ...["failure", "cancelled", "skipped", ""].map(value => ({ name: `evidence job ${value || "missing"}`, env: { EVIDENCE_RESULT: value }, title: "NOT CHECKED" as const })),
  ...["INCONCLUSIVE", "NOT CHECKED", "", "pass"].map(value => ({ name: `receipt status ${value || "missing"}`, env: { VIGIL_STATUS: value }, title: "NOT CHECKED" as const })),
  ...["", "sha256:invalid", "SHA256:" + "c".repeat(64)].map((value, index) => ({ name: `missing or malformed receipt digest ${index}`, env: { RECEIPT_HASH: value }, title: "NOT CHECKED" as const })),
  { name: "old failed evidence does not describe the new commit as failed", pull: { head: { sha: "c".repeat(40) } }, env: { VIGIL_STATUS: "FAIL" }, title: "NOT CHECKED" },
  { name: "unavailable PR API stops without posting a result", apiError: true, title: "NO UPDATE" },
  { name: "current merge-group commit", env: { EVENT_KIND: "merge_group" }, title: "PASS" },
  { name: "moved merge-group ref", env: { EVENT_KIND: "merge_group" }, ref: { object: { type: "commit", sha: BASE } }, title: "NOT CHECKED" },
  { name: "non-commit merge-group ref", env: { EVENT_KIND: "merge_group" }, ref: { object: { type: "tag", sha: HEAD } }, title: "NOT CHECKED" },
  { name: "missing merge-group ref", env: { EVENT_KIND: "merge_group" }, apiError: true, title: "NOT CHECKED" },
];

function publisherScript(): string {
  const workflow = readFileSync(WORKFLOW, "utf8").replaceAll("\r\n", "\n");
  const publish = workflow.slice(workflow.indexOf("  publish:"));
  const match = / {10}node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE\s*$/.exec(publish);
  assert.ok(match, "extract the actual publisher rather than a copy of its decision rules");
  return match[1].split("\n").map(line => {
    if (!line) return line;
    assert.match(line, /^ {10}/);
    return line.slice(10);
  }).join("\n");
}

for (const scenario of scenarios) {
  test(`public App publisher: ${scenario.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "vigil-publisher-"));
    try {
      const capture = join(root, "capture.json");
      const runner = join(root, "runner.mjs");
      const pull = { state: "open", body: BODY, base: { sha: BASE }, head: { sha: HEAD }, ...scenario.pull };
      const ref = scenario.ref ?? { object: { type: "commit", sha: HEAD } };
      // Never fall through to a real network request; the child has no account secrets.
      const prelude = `
import { writeFileSync } from "node:fs";
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(String(url)).pathname;
  calls.push({ path, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
  let value;
  if (path === "/repos/fixture/repo/pulls/123") value = ${JSON.stringify(pull)};
  else if (path === "/repos/fixture/repo/git/ref/heads/gh-readonly-queue/main/fixture") value = ${JSON.stringify(ref)};
  else if (path === "/repos/fixture/repo/check-runs/456" && options.method === "PATCH") value = { id: 456 };
  else throw new Error("Unexpected request: " + path);
  const fail = ${!!scenario.apiError} && options.method !== "PATCH";
  return { ok: !fail, status: fail ? 404 : 200, text: async () => fail ? "fixture unavailable" : JSON.stringify(value) };
};
process.on("exit", () => writeFileSync(${JSON.stringify(capture)}, JSON.stringify(calls)));
`;
      writeFileSync(runner, `${prelude}\n${publisherScript()}\n`);
      const result = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", APP_TOKEN: "fixture-not-a-token", GITHUB_API_URL: "https://github.invalid",
          GITHUB_SERVER_URL: "https://github.invalid", GITHUB_REPOSITORY: "fixture/control", GITHUB_RUN_ID: "789",
          TARGET_REPOSITORY: "fixture/repo", EVENT_KIND: "pull_request", PR_NUMBER: "123", BASE_SHA: BASE, HEAD_SHA: HEAD,
          HEAD_REF: "refs/heads/gh-readonly-queue/main/fixture", CHECK_RUN_ID: "456", EVIDENCE_RESULT: "success", VIGIL_STATUS: "PASS",
          RECEIPT_HASH: `sha256:${"c".repeat(64)}`, EXPECTED_PR_BODY_SHA256: bodyHash(BODY), ...scenario.env } });
      assert.ifError(result.error);
      assert.equal(result.status, scenario.title === "PASS" ? 0 : 1, result.stderr);
      const calls = JSON.parse(readFileSync(capture, "utf8")) as { path: string; method: string; body: any }[];
      assert.equal(calls[0].method, "GET", "recheck current identity before posting any result");
      const updates = calls.filter(call => call.method === "PATCH");
      if (scenario.title === "NO UPDATE") {
        assert.equal(updates.length, 0);
      } else {
        assert.equal(calls.length, 2);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].path, "/repos/fixture/repo/check-runs/456");
        assert.equal(updates[0].body.output.title, scenario.title);
        assert.equal(updates[0].body.conclusion, scenario.title === "PASS" ? "success" : "failure");
        assert.equal(updates[0].body.status, "completed");
        assert.equal(updates[0].body.details_url, "https://github.invalid/fixture/control/actions/runs/789");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("the exercised public App publisher matches the retained workflow template byte for byte", () => {
  assert.deepEqual(readFileSync(WORKFLOW), readFileSync(TEMPLATE));
});
