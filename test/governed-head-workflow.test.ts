import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = new URL("../.github/workflows/agent-vigil.yml", import.meta.url);

function governedScript(workflow: string): string {
  const match = / {10}node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE\s*$/.exec(workflow);
  assert.ok(match, "the governed check must expose one extractable Node finalizer");
  return match[1]
    .split("\n")
    .map((line) => {
      if (line.length === 0) return line;
      assert.match(line, /^ {10}/, "governed finalizer lines must retain canonical YAML indentation");
      return line.slice(10);
    })
    .join("\n");
}

function runFinalizer(options: { currentHead: string; evidenceStatus?: string }) {
  const temporary = mkdtempSync(join(tmpdir(), "agent-vigil-governed-head-"));
  const capturePath = join(temporary, "capture.json");
  const runnerPath = join(temporary, "runner.mjs");
  const workflow = readFileSync(WORKFLOW, "utf8").replaceAll("\r\n", "\n");
  const script = governedScript(workflow);
  const expectedHead = "2".repeat(40);
  const expectedBase = "1".repeat(40);
  const prelude = `
import { writeFileSync } from "node:fs";
let captured;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).endsWith("/pulls/123")) {
    return { ok: true, status: 200, text: async () => JSON.stringify({
      state: "open",
      base: { ref: "main", sha: ${JSON.stringify(expectedBase)} },
      head: { sha: ${JSON.stringify(options.currentHead)} },
    }) };
  }
  if (String(url).endsWith("/check-runs") && options.method === "POST") {
    captured = JSON.parse(options.body);
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 456 }) };
  }
  return { ok: false, status: 500, text: async () => "unexpected request" };
};
process.on("exit", () => writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(captured)));
`;
  writeFileSync(runnerPath, `${prelude}\n${script}\n`);
  const result = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_VIGIL_GATE_TOKEN: "installation-token",
      GITHUB_TOKEN: "read-token",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_REPOSITORY: "sulmusic2-star/agent-vigil",
      GITHUB_SERVER_URL: "https://github.test",
      GITHUB_RUN_ID: "789",
      GITHUB_RUN_ATTEMPT: "1",
      EXPECTED_BASE_REF: "main",
      EXPECTED_BASE_SHA: expectedBase,
      EXPECTED_HEAD_SHA: expectedHead,
      EVIDENCE_RESULT: "success",
      EVIDENCE_STATUS: options.evidenceStatus ?? "PASS",
      EVIDENCE_RECEIPT_HASH: `sha256:${"3".repeat(64)}`,
      PR_NUMBER: "123",
    },
  });
  const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
    name: string;
    head_sha: string;
    conclusion: string;
    external_id: string;
  };
  return { captured, expectedHead, result };
}

test("governed evidence is posted by a fresh least-privilege App job", () => {
  const workflow = readFileSync(WORKFLOW, "utf8").replaceAll("\r\n", "\n");
  const governed = workflow.slice(workflow.indexOf("  governed-head-check:"));
  assert.match(governed, /^ {4}needs: evidence$/m);
  assert.match(governed, /^ {4}if: always\(\)$/m);
  assert.match(governed, /^ {4}environment: agent-vigil-gate$/m);
  assert.match(governed, /^ {6}pull-requests: read$/m);
  assert.match(
    governed,
    /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/,
  );
  assert.match(governed, /^ {10}permission-checks: write$/m);
  assert.doesNotMatch(governed, /actions\/checkout@|npm\s|dist\/cli\.js|candidate-setup-cmd/);
});

test("governed evidence succeeds only for the unchanged exact PR head", () => {
  const current = runFinalizer({ currentHead: "2".repeat(40) });
  assert.equal(current.result.status, 0, current.result.stderr);
  assert.equal(current.captured.name, "Agent Vigil governed evidence");
  assert.equal(current.captured.head_sha, current.expectedHead);
  assert.equal(current.captured.conclusion, "success");
  assert.equal(current.captured.external_id, `789:1:${current.expectedHead}`);

  const stale = runFinalizer({ currentHead: "4".repeat(40) });
  assert.notEqual(stale.result.status, 0, "a stale event head must never produce a successful governed check");
  assert.equal(stale.captured.head_sha, stale.expectedHead);
  assert.equal(stale.captured.conclusion, "failure");
});

test("governed evidence fails closed on a non-PASS receipt", () => {
  const blocked = runFinalizer({ currentHead: "2".repeat(40), evidenceStatus: "INCONCLUSIVE" });
  assert.notEqual(blocked.result.status, 0);
  assert.equal(blocked.captured.conclusion, "failure");
});
