# GitHub merge queues

Agent Vigil v0.20.0 does not generate a repository-owned `merge_group`
workflow. Queue verification is available only as a low-level verifier for an
externally controlled integration.

## Why the generated workflow is pull-request only

GitHub requires a check used by a merge queue to report on the
`merge_group` event. A workflow file stored in the candidate repository is
selected from candidate-controlled bytes for that event. It cannot be the
trusted source of the policy that decides whether the same candidate may merge.

There is a second boundary. A plain required status check selects a context or
job name. It does not bind that name to the intended workflow file, event, or
reviewed Agent Vigil commit. A candidate workflow can report the same name.
Requiring `Agent Vigil evidence` by name alone therefore does not establish an
enforceable Agent Vigil control.

The v0.20.0 `init` and `protect` generators use base-selected
`pull_request_target` for pull-request evidence and intentionally omit
`merge_group`. `vigil doctor` reports a repository-owned merge-group path as a
failure.

## Enforceable queue integration

Use one of these external trust sources:

- an organization or enterprise ruleset that requires a workflow controlled
  outside the candidate repository; or
- a GitHub App that validates the exact queue head, expected event, policy
  source, and evidence source before reporting its own check.

The external workflow or App must bind:

1. the caller-provided base and head to the event's full `base_sha` and
   `head_sha`;
2. the checkout and Git-visible workspace to the exact composed head;
3. the event base as an ancestor of that head;
4. policy to the event base, never the queued candidate;
5. the reviewed Agent Vigil Action commit and expected workflow identity;
6. credential-free repository execution; and
7. the reported conclusion to the exact head GitHub is considering.

The low-level `vigil merge-group --event <event.json>` command can evaluate the
composition when that external controller supplies the trusted inputs. Its
presence does not make a repository-owned workflow safe or required.

## Evidence available at queue time

The merge-group payload does not contain one pull request's complete evidence
context. An external queue integration must not fabricate PR-body declarations,
portable signatures, or task-authority facts that are absent from the event.
It can rerun base-owned executable evidence and integrity checks against the
actual composition, then join that result with separately retained PR evidence
under its own policy.

Missing event identity, policy anchor, Git object, test evidence, workflow
identity, or exact-head status must remain a blocking or inconclusive result.

Official GitHub references:

- [Events that trigger workflows: `merge_group`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)
- [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)

See the [hosted evidence security contract](HOSTED_SECURITY_CONTRACT.md) for
the generated pull-request lane.
