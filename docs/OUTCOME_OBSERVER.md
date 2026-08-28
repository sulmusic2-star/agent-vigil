# Outcome Observer

`vigil init --action-sha <reviewed-full-commit>` and
`vigil protect --action-sha <reviewed-full-commit>` prepare
`.github/workflows/agent-vigil-outcomes.yml` beside the evidence workflow.

The v0.21.2 observer handles one event: a completed `workflow_run` whose source
event was `pull_request_target`. It downloads the retained receipt from that
exact run ID and records a read-only snapshot of:

- the completed Actions run and its jobs;
- Actions elapsed duration and failed-job count;
- the pull-request record reachable at observation time;
- submitted reviews and review comments reachable at observation time; and
- the state and merge fields present in that snapshot.

It writes a hash-bound GitHub evidence bundle and Agent Value Card. Verification,
maintainer disposition, attributed cost, and downstream outcome remain separate
fields. Missing facts stay missing.

The workflow has only `actions: read`, `contents: read`, and
`pull-requests: read`. It does not check out or execute candidate code. Agent
Vigil and supporting Actions are pinned to full commits, and the outcome
workflow uses the same reviewed Agent Vigil commit as the evidence workflow.

## Current boundary

The generated observer is a completed-run snapshot. It does not subscribe to a
pull-request close event and does not claim that it will later observe a merge,
revert, hotfix, incident, deployment, payment, or revenue event. A merge already
visible when the completed-run snapshot is collected can be recorded; a later
transition is not discovered automatically.

Continuous lifecycle observation requires a separate authenticated GitHub App,
webhook receiver, or operator-controlled collector. That observer must retain
the original evidence identity and fail closed during outages or incomplete
coverage.

The workflow uses GitHub's documented
[`workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
event. See [GitHub outcome evidence](GITHUB_OUTCOME_EVIDENCE.md) for the bundle
contract and [Hosted evidence security contract](HOSTED_SECURITY_CONTRACT.md)
for the candidate-execution boundary.
