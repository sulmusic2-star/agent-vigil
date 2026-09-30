import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(".github/workflows/public-app-gate.yml", "utf8");
const scripts = [...workflow.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)          NODE/g)].map((m) => m[1].replace(/^          /gm, ""));
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = "1".repeat(40), head = "2".repeat(40);
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "vigil-workflow-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const event = JSON.stringify({ pull_request: { body: "public test input" } }) + "\n";
  const receipt = JSON.stringify({ transcriptSha256: `sha256:${digest(event)}`, base: sha, head, vigilVersion: "0.24.4" });
  const files: Record<string,string> = { EVENT_PATH: event, REPORT_PATH: receipt, CARD_PATH: "{}", SARIF_PATH: "{}" };
  const env: Record<string,string> = { PATH: process.env.PATH!, RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, "outputs"),
    TARGET_REPOSITORY: "test/repo", BASE_SHA: sha, HEAD_SHA: head, EVENT_KIND: "pull_request", APP_TOKEN: "fake-token", GITHUB_API_URL: "https://api.github.test" };
  for (const [key, content] of Object.entries(files)) { env[key] = join(root, key); writeFileSync(env[key], content); }
  return { root, event, receipt, env };
}
function run(script: string, env: Record<string,string>, prefix: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", prefix + "\n" + script], { env, encoding: "utf8", timeout: 10000 });
}
const publicFetch = 'globalThis.fetch = async () => Response.json({ full_name: "test/repo", private: false, visibility: "public" });';

test("workflow is one reviewed template, v2 only, with no direct result PATCH or Checks-write token", () => {
  assert.equal(scripts.length, 4);
  const action = workflow.match(/uses: (sulmusic2-star\/agent-vigil@[0-9a-f]{40})/)?.[1];
  assert.ok(action);
  assert.ok(workflow.includes(`Action runtime: ${action}`), "replay guide must identify the runtime actually used");
  assert.equal(workflow, readFileSync("hosted/public-app/control-workflow.yml", "utf8"));
  assert.match(scripts[0], /value.schema !== "agent-vigil-public-app-v2"/);
  const publisher = workflow.slice(workflow.indexOf("  publish:"));
  assert.doesNotMatch(publisher, /permission-checks|method: "PATCH"|check-runs\//);
  assert.match(publisher, /AGENT_VIGIL_PUBLIC_APP_ORIGIN/);
  assert.match(publisher, /no direct-write fallback/);
  assert.match(workflow, /steps.export.outcome == 'success'/);
});
for (const visibility of [{ private: true, visibility: "private" }, { private: false, visibility: "internal" }, {}, { private: false, visibility: "public", full_name: "test/other" }]) {
  test(`materialization refuses unsupported visibility ${JSON.stringify(visibility)}`, (t) => {
    const f = fixture(t);
    const before = readdirSync(f.root);
    const result = run(scripts[1], f.env, `globalThis.fetch = async () => Response.json(${JSON.stringify({ full_name: "test/repo", ...visibility })});`);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /public repositories only/);
    assert.deepEqual(readdirSync(f.root), before, "no event or export may be created for private/unknown visibility");
  });
}
test("export includes exact original bytes and checked hashes without rewriting the receipt", (t) => {
  const f = fixture(t); const result = run(scripts[2], f.env, publicFetch);
  assert.equal(result.status, 0, result.stderr);
  const root = readFileSync(f.env.GITHUB_OUTPUT, "utf8").trim().slice("path=".length);
  assert.equal(readFileSync(join(root, "github-event.json"), "utf8"), f.event);
  assert.equal(readFileSync(join(root, "agent-vigil-report.json"), "utf8"), f.receipt);
  const sums = readFileSync(join(root, "SHA256SUMS.txt"), "utf8").trim().split("\n");
  assert.equal(sums.length, 5);
  for (const line of sums) { const [hash, name] = line.split("  "); assert.equal(digest(readFileSync(join(root, name))), hash); }
  assert.match(readFileSync(join(root, "REPRODUCE.md"), "utf8"), /not an offline hermetic replay/);
});
for (const failure of ["private", "unknown", "http", "hash", "base", "symlink", "large"]) {
  test(`export refuses ${failure} rather than producing a plausible incomplete packet`, (t) => {
    const f = fixture(t); let prefix = publicFetch;
    if (failure === "private") prefix = 'globalThis.fetch = async () => Response.json({ full_name: "test/repo", private: true, visibility: "private" });';
    if (failure === "unknown") prefix = 'globalThis.fetch = async () => Response.json({ full_name: "test/repo" });';
    if (failure === "http") prefix = 'globalThis.fetch = async () => new Response("denied", {status:403});';
    if (failure === "hash") writeFileSync(f.env.EVENT_PATH, "different event");
    if (failure === "base") f.env.BASE_SHA = "3".repeat(40);
    if (failure === "symlink") { const link = join(f.root, "linked"); symlinkSync(f.env.EVENT_PATH, link); f.env.EVENT_PATH = link; }
    if (failure === "large") writeFileSync(f.env.EVENT_PATH, "x".repeat(262145));
    const result = run(scripts[2], f.env, prefix);
    assert.notEqual(result.status, 0);
    assert.ok(!readdirSync(f.root).includes("outputs"), "upload path is emitted only for a complete validated packet");
  });
}

for (const kind of ["pass", "missing-receipt", "failed-evidence", "stale-body", "fail", "wrong-origin", "refused", "unconfirmed", "lost-response", "server-outage"]) {
  test(`protected publisher ${kind} uses the authenticated service, never a direct override`, (t) => {
    const f = fixture(t);
    Object.assign(f.env, { RESULT_ORIGIN: "https://app.example", RESULT_SECRET: "test-secret-with-at-least-thirty-two-characters", DELIVERY_ID: "550e8400-e29b-41d4-a716-446655440000",
      INSTALLATION_ID: "23456", CHECK_RUN_ID: "34567", GITHUB_RUN_ID: "98765", GITHUB_RUN_ATTEMPT: "1",
      PR_NUMBER: "17", EVIDENCE_RESULT: kind === "failed-evidence" ? "failure" : "success", VIGIL_STATUS: kind === "fail" ? "FAIL" : "PASS",
      RECEIPT_HASH: kind === "missing-receipt" ? "" : `sha256:${"3".repeat(64)}`, EXPECTED_PR_BODY_SHA256: digest("reviewed body") });
    if (kind === "wrong-origin") f.env.RESULT_ORIGIN = "http://app.example";
    const prefix = `
      import * as _testFs from "node:fs";
      import * as _testCrypto from "node:crypto";
      import * as _testAssert from "node:assert/strict";
      globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
      let _requests = 0;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("/pulls/17")) return Response.json({state:"open",base:{sha:${JSON.stringify(sha)}},head:{sha:${JSON.stringify(head)}},body:${JSON.stringify(kind === "stale-body" ? "changed body" : "reviewed body")}});
        _testAssert.equal(url, "https://app.example/github/check-result");
        _testAssert.equal(init.method, "POST");
        _testAssert.equal(init.redirect, "error");
        _testAssert.equal(init.headers["x-agent-vigil-result-signature"], "sha256=" + _testCrypto.createHmac("sha256",process.env.RESULT_SECRET).update("agent-vigil-check-result/v1\\0").update(init.body).digest("hex"));
        _testFs.writeFileSync(${JSON.stringify(join(f.root, "sent.json"))},init.body);
        const verdict=JSON.parse(init.body).verdict;
        if (${JSON.stringify(kind)} === "lost-response" && _requests++ === 0) throw new Error("lost reply");
        if (${JSON.stringify(kind)} === "server-outage" && _requests++ === 0) return new Response("unavailable",{status:503});
        return ${kind === "refused" ? 'Response.json({error:"deadline"},{status:409})' : kind === "unconfirmed" ? 'Response.json({status:"accepted",verdict},{status:202})' : 'Response.json({status:"published",verdict})'};
      };`;
    const result = run(scripts[3], f.env, prefix);
    assert.equal(result.status, ["pass", "lost-response", "server-outage"].includes(kind) ? 0 : 1, result.stderr);
    if (kind !== "wrong-origin") {
      const sent = JSON.parse(readFileSync(join(f.root, "sent.json"), "utf8"));
      assert.equal(sent.verdict, ["missing-receipt", "failed-evidence", "stale-body"].includes(kind) ? "NOT CHECKED" : kind === "fail" ? "FAIL" : "PASS");
    }
  });
}
