# Outcome Observer

`vigil protect` installs `.github/workflows/agent-vigil-outcomes.yml` with the merge gate.

The workflow runs after the Agent Vigil check and when the pull request closes. It downloads the retained receipt instead of executing candidate code again, then collects read-only GitHub evidence for:

- pull-request state and merge time
- submitted reviews and changes requested
- review comments
- the Actions run conclusion and its job records
- total Actions run and job duration

It writes a hash-bound GitHub evidence bundle and an Agent Value Card. The card keeps verification, maintainer disposition, cost and downstream outcome as separate fields. Missing cost or outcome evidence remains missing; it is not estimated into a positive result.

The observer uses GitHub's documented [`workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run) and [`pull_request`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) events. The generated workflow limits itself to read-only repository and Actions permissions.

Reverts, hotfixes and incidents require an explicit linked GitHub object:

- a revert commit whose message identifies the original change
- a merged pull request labeled `hotfix` or `emergency-fix`
- an issue labeled `incident`, `outage`, or a severity label

Those objects can be passed through the Action inputs documented in `action.yml`. Agent Vigil validates their shape and hashes the source files. It does not infer an incident merely because a later workflow failed.

## Current boundary

The installed workflow observes completion and pull-request closure automatically. Continuous organization-wide discovery of later reverts, hotfixes and incidents requires the planned GitHub App or an operator-supplied scheduled collector. The present release does not claim that later events are discovered without that additional source.
