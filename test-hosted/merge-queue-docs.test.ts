import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const queues = readFileSync(new URL("../docs/MERGE_QUEUES.md", import.meta.url), "utf8");
const notary = readFileSync(new URL("../docs/NOTARY_APP.md", import.meta.url), "utf8");
const dispatcher = readFileSync(new URL("../hosted/merge-queue-dispatcher/README.md", import.meta.url), "utf8");

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
  assert.match(dispatcher, /wrangler@4\.127\.1 deploy --dry-run/);
  assert.match(dispatcher, /test-hosted\/merge-queue-dispatcher\.test\.ts/);
  assert.match(dispatcher, /Actions: write/);
  assert.match(dispatcher, /Merge queues: read/);
  assert.match(dispatcher, /candidate-only Docker boundary/);
});
