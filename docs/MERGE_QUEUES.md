# GitHub merge queues

GitHub requires workflows that provide required pull-request checks to also
subscribe to `merge_group`. Without that trigger, the required check is never
reported for the queued composition and the merge fails. Agent Vigil v0.10.1
adds a separate fail-closed verification path for that event.

Official GitHub references:

- [Events that trigger workflows: `merge_group`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)
- [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)

## Generated workflow

`vigil init` now generates both triggers and selects exact event commits:

```yaml
on:
  pull_request:
  merge_group:
    types: [checks_requested]

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
      ref: ${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
  - uses: sulmusic2-star/agent-vigil@v0.11.1
    with:
      mode: maintainer
      policy: .agent-vigil.json
      policy-ref: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
      base: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
      head: ${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
```

The composite Action recognizes the event type itself. A `merge_group` event
always routes to the merge-group verifier, regardless of whether the PR phase
uses transcript, portable-receipt, or maintainer evidence.

## What is re-verified

1. The caller-provided base and head equal the event's `base_sha` and
   `head_sha`.
2. The checked-out commit equals the event head and the Git-visible worktree is
   otherwise clean.
3. The event base is an ancestor of the composed queue head.
4. `.agent-vigil.json` is loaded from the event base, not the queued candidate.
5. The trusted policy test command is rerun against the composed head.
6. Test execution must not mutate tracked inputs.
7. Static integrity checks inspect the full base-to-composed-head diff under
   the base policy's advisory or blocking mode.
8. JSON, SARIF, job summary, receipt hash, and reproduction command bind the
   result.

Any missing event identity, policy anchor, Git object, test evidence, or clean
workspace produces FAIL or INCONCLUSIVE rather than PASS.

## Deliberate boundary

GitHub's merge-group payload does not contain a single pull request's body.
Agent Vigil therefore does not fabricate or reconstruct per-PR maintainer
attestations or task-authority evidence at this phase. Those declarations,
task contracts, and any portable-receipt signature are enforced on the
pull-request check. The queue phase verifies the actual composed commit against
the latest trusted base and reruns executable evidence, which is the evidence
that can change when queued pull requests are combined.

Use the same required status-check name, `Agent Vigil evidence`, for pull
requests and merge groups.
