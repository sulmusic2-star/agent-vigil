import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const queues = readFileSync(new URL("../docs/MERGE_QUEUES.md", import.meta.url), "utf8");
const acceptance = readFileSync(
  new URL("../docs/MERGE_QUEUE_ACCEPTANCE_2026-08-31.md", import.meta.url),
  "utf8",
);
const notary = readFileSync(new URL("../docs/NOTARY_APP.md", import.meta.url), "utf8");
const dispatcher = readFileSync(new URL("../hosted/merge-queue-dispatcher/README.md", import.meta.url), "utf8");
const queueWorkflow = readFileSync(new URL("../.github/workflows/agent-vigil-merge-group.yml", import.meta.url), "utf8");
const queueConfig = JSON.parse(
  readFileSync(new URL("../hosted/merge-queue-dispatcher/wrangler.jsonc", import.meta.url), "utf8"),
) as { vars: { ALLOWED_REPOSITORY: string; WORKFLOW_FILE: string } };
const queueManifest = JSON.parse(
  readFileSync(new URL("../hosted/merge-queue-dispatcher/github-app-manifest.example.json", import.meta.url), "utf8"),
) as {
  name: string;
  hook_attributes: { url: string; active: boolean };
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

test("live acceptance binds the deployment to the merged source", () => {
  assert.match(acceptance, /`d1020ceab9f1d8fa3dcaafccd62d6d713e744b69`/);
  assert.match(acceptance, /`30954ac8-4ba1-45d3-ba81-a6bebfdb89f8`/);
  assert.match(acceptance, /actions\/runs\/33410193694/);
  assert.match(acceptance, /actions\/runs\/33410193746/);
  assert.match(acceptance, /unsigned webhook request returned HTTP 401/);
  assert.match(acceptance, /first-party deployment test/);
  assert.match(acceptance, /not external adoption/);
});

test("dispatcher instructions name the exact current contract", () => {
  assert.ok(
    dispatcher.indexOf("## Register the queue App") < dispatcher.indexOf("## Required secrets"),
    "the App identity and key must exist before Worker secret setup",
  );
  assert.ok(
    dispatcher.match(/cd hosted\/merge-queue-dispatcher/g)?.length === 2,
    "secret setup and deployment must both select the checked-in Wrangler config directory",
  );
  assert.match(dispatcher, /wrangler@4\.127\.1 secret put SECRET_NAME/);
  assert.match(dispatcher, /openssl rand -hex 32/);
  assert.ok(
    dispatcher.match(/at least 32 characters/g)?.length === 3,
    "secret generation and both runtime secret entries must state the enforced minimum",
  );
  assert.match(dispatcher, /wrangler@4\.127\.1 deploy --dry-run/);
  assert.match(dispatcher, /tsx@4\.23\.12 --test test-hosted\/merge-queue-dispatcher\.test\.ts/);
  assert.doesNotMatch(dispatcher, /git checkout|test imports trusted-workflow source/);
  assert.match(dispatcher, /Actions: write/);
  assert.match(dispatcher, /Merge queues: read/);
  assert.match(dispatcher, /candidate-only Docker boundary/);
  assert.match(dispatcher, /AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET/);
  assert.match(dispatcher, /AGENT_VIGIL_GATE_APP_ID/);
  assert.match(dispatcher, /AGENT_VIGIL_GATE_PRIVATE_KEY/);
  assert.match(dispatcher, /GITHUB_APP_ID/);
  assert.match(dispatcher, /GITHUB_APP_PRIVATE_KEY/);
  assert.match(dispatcher, /replace\s+`REPLACE_WITH_OWNER\/REPLACE_WITH_REPOSITORY`/);
  assert.match(dispatcher, /Copy the packaged `\.github\/workflows\/agent-vigil-merge-group\.yml`/);
  assert.match(dispatcher, /Keep the App webhook inactive after deployment/);
  assert.match(dispatcher, /Only after all three environment credentials are present[\s\S]*enable the App webhook/);
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
  assert.equal(queueManifest.hook_attributes.active, false);
  assert.deepEqual(queueManifest.default_events, ["merge_group"]);
  assert.match(queueWorkflow, /EXPECTED_ACTOR: \$\{\{ vars\.AGENT_VIGIL_GATE_ACTOR \|\| 'agent-vigil-gate\[bot\]' \}\}/);
  assert.match(queueWorkflow, /repositories: \$\{\{ github\.event\.repository\.name \}\}/);
  assert.doesNotMatch(queueWorkflow, /repositories: agent-vigil/);
  assert.match(dispatcher, /AGENT_VIGIL_GATE_ACTOR/);
  assert.equal(queueConfig.vars.ALLOWED_REPOSITORY, "REPLACE_WITH_OWNER/REPLACE_WITH_REPOSITORY");
  assert.equal(queueConfig.vars.WORKFLOW_FILE, "agent-vigil-merge-group.yml");
  assert.match(queueWorkflow, /DISPATCH_SECRET: \$\{\{ secrets\.AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET \}\}/);
  assert.equal(queueManifest.default_permissions.actions, "write");
  assert.equal(queueManifest.default_permissions.checks, "write");
  assert.equal(queueManifest.default_permissions.contents, "read");
  assert.equal(queueManifest.default_permissions.merge_queues, "read");
  assert.equal(queueManifest.default_permissions.metadata, "read");
  assert.ok(!notaryManifest.default_events.includes("merge_group"));
});
