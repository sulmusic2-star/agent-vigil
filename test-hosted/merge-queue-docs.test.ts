import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const queues = readFileSync(new URL("../docs/MERGE_QUEUES.md", import.meta.url), "utf8");
const notary = readFileSync(new URL("../docs/NOTARY_APP.md", import.meta.url), "utf8");
const dispatcher = readFileSync(new URL("../hosted/merge-queue-dispatcher/README.md", import.meta.url), "utf8");
const queueWorkflow = readFileSync(new URL("../.github/workflows/agent-vigil-merge-group.yml", import.meta.url), "utf8");
const queueManifest = JSON.parse(
  readFileSync(new URL("../hosted/merge-queue-dispatcher/github-app-manifest.example.json", import.meta.url), "utf8"),
) as {
  name: string;
  hook_attributes: { url: string };
  default_permissions: Record<string, string>;
  default_events: string[];
};
const notaryManifest = JSON.parse(
  readFileSync(new URL("../docs/notary-app-manifest.example.json", import.meta.url), "utf8"),
) as { default_events: string[] };

test("merge-queue docs describe the checked-in path without claiming deployment", () => {
  assert.match(queues, /not an active enforcement path until the Worker is deployed/);
  assert.match(queues, /real `checks_requested` webhook/);
  assert.match(notary, /requires deployment secrets and a\s+real signed queue-event acceptance run/);
  assert.match(dispatcher, /Do not make the queue check required until/);
  assert.doesNotMatch(
    `${queues}\n${notary}\n${dispatcher}`,
    /(?:^|\n)(?:The Worker is deployed\.|Deployment state:\s*(?:active|deployed)|\*\*State:\*\*\s*deployed)/mi,
  );
});

test("dispatcher instructions name the exact current contract", () => {
  assert.ok(
    dispatcher.match(/cd hosted\/merge-queue-dispatcher/g)?.length === 2,
    "secret setup and deployment must both select the checked-in Wrangler config directory",
  );
  assert.match(dispatcher, /wrangler@4\.127\.1 secret put SECRET_NAME/);
  assert.match(dispatcher, /wrangler@4\.127\.1 deploy --dry-run/);
  assert.match(
    dispatcher,
    /github\.com\/sulmusic2-star\/agent-vigil\/blob\/fb87b3bc5e3bddd4902b14d8fb36c5320cd9068a\/test-hosted\/merge-queue-dispatcher\.test\.ts/,
  );
  assert.match(dispatcher, /git checkout --detach fb87b3bc5e3bddd4902b14d8fb36c5320cd9068a/);
  assert.match(dispatcher, /Actions: write/);
  assert.match(dispatcher, /Merge queues: read/);
  assert.match(dispatcher, /candidate-only Docker boundary/);
  assert.match(dispatcher, /AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET/);
  assert.match(dispatcher, /AGENT_VIGIL_GATE_APP_ID/);
  assert.match(dispatcher, /AGENT_VIGIL_GATE_PRIVATE_KEY/);
  assert.match(dispatcher, /GITHUB_APP_ID/);
  assert.match(dispatcher, /GITHUB_APP_PRIVATE_KEY/);
  assert.match(dispatcher, /allow only `main`/);
  assert.match(dispatcher, /candidate branch must not be able to\s+request this environment/);
  assert.match(dispatcher, /disposable negative test from a non-`main`\s+branch/);
  assert.match(queues, /environment must allow deployments from `main` only/);
  assert.match(notary, /Receipt-notary App permissions/);
  assert.match(notary, /queue App separately needs Actions write and Merge queues read/);
  assert.match(notary, /receipt-notary App subscribes to `workflow_run` and `pull_request`/i);
  assert.match(notary, /dedicated queue App subscribes only to `merge_group`/);
});

test("queue App manifest matches the authenticated dispatcher and workflow", () => {
  assert.equal(queueManifest.name, "Agent Vigil Gate");
  assert.match(queueManifest.hook_attributes.url, /\/github\/merge-group$/);
  assert.deepEqual(queueManifest.default_events, ["merge_group"]);
  assert.match(queueWorkflow, /EXPECTED_ACTOR: agent-vigil-gate\[bot\]/);
  assert.match(queueWorkflow, /DISPATCH_SECRET: \$\{\{ secrets\.AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET \}\}/);
  assert.equal(queueManifest.default_permissions.actions, "write");
  assert.equal(queueManifest.default_permissions.checks, "write");
  assert.equal(queueManifest.default_permissions.contents, "read");
  assert.equal(queueManifest.default_permissions.merge_queues, "read");
  assert.equal(queueManifest.default_permissions.metadata, "read");
  assert.ok(!notaryManifest.default_events.includes("merge_group"));
});
