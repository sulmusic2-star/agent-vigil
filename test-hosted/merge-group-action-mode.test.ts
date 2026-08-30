import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");

test("the reviewed Action has a fail-closed external merge-group entrypoint", () => {
  assert.match(action, /merge-group-event:\n\s+description: "Authenticated merge_group event envelope/);
  assert.match(action, /mode must be plan, prove, maintainer, merge-group, outcome, or continuity/);
  assert.match(action, /merge-group-event is restricted to merge-group mode/);
  assert.match(action, /merge-group mode requires an authenticated merge-group-event and a base-anchored policy and policy-ref/);
  assert.match(action, /GITHUB_EVENT_NAME:-}" != "workflow_dispatch"/);
  assert.match(action, /VIGIL_BASE" != "\$event_base" \|\| "\$VIGIL_HEAD" != "\$event_head" \|\| "\$VIGIL_POLICY_REF" != "\$event_base"/);
  assert.match(action, /args=\(merge-group --event "\$GITHUB_EVENT_PATH"/);
});

test("adding queue support does not relax ordinary candidate provenance", () => {
  assert.match(action, /VIGIL_CANDIDATE_MODE" == "true" && "\$VIGIL_MODE" != "merge-group"/);
  assert.match(action, /candidate verification requires the base-selected pull_request_target event/);
  assert.match(action, /candidate verification requires a bounded GitHub pull_request event with full commit IDs/);
});
