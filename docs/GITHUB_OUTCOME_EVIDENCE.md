# GitHub outcome evidence v1

**State:** Agent Vigil v0.21.0 contract

`vigil github-evidence` converts bounded GitHub event and REST API exports into
a privacy-reduced, hash-bound bundle. `vigil value --github-evidence` can then
close the human-review and downstream-outcome fields of an Agent Value Card
without copying review bodies, issue bodies, or commit messages into the card.

## Inputs

```bash
vigil github-evidence \
  --event event.json \
  --pull-request pull.json \
  --reviews reviews.json \
  --review-comments review-comments.json \
  --actions-run run.json \
  --actions-jobs jobs.json \
  --revert-commit explicit-revert.json \
  --hotfix-pull-request explicit-hotfix.json \
  --incident-issue explicit-incident.json \
  --output agent-vigil-github-evidence.json

vigil value agent-vigil-report.json \
  --github-evidence agent-vigil-github-evidence.json \
  --format json --output agent-vigil-value-card.json
```

The standalone command normalizes operator-supplied exports. In the generated
v0.21.0 hosted path, the credential-free candidate evidence job does not
receive a GitHub token. The separate read-only outcome workflow collects the
official API records after the evidence run completes and retains the bundle
and Value Card in its 30-day artifact.

`vigil init --action-sha <reviewed-full-commit>` and
`vigil protect --action-sha <reviewed-full-commit>` also prepare a separate
`Agent Vigil outcomes` workflow. It:

- handles a completed `workflow_run` whose source event was
  `pull_request_target`;
- downloads that exact run's receipt artifact by run ID;
- never checks out or executes candidate repository code;
- imports the finished run and job records with `actions: read`;
- snapshots PR, reviews, comments, and any merge state visible at that time;
  and
- retains the completed-run Value Card and normalized evidence for 30 days.

The generated workflow does not subscribe to a later pull-request close event.
It therefore does not claim eventual merge, close, revert, hotfix, or incident
observation. Those transitions require a separate authenticated observer. The
snapshot keeps outcome collection separate from verification and avoids
rerunning candidate tests merely to record the completed Actions run.

## Conservative inference

- The latest submitted review state per reviewer is counted. Repeated review
  rows do not inflate approvals.
- A merge or approval can support `accepted`; a current changes-requested state
  takes priority.
- Explicit incident evidence takes priority over revert, then hotfix, then
  merge, then closed.
- Revert, hotfix, and incident states require explicitly supplied GitHub API
  objects. A revert must be a full-SHA commit whose message identifies a
  revert; a hotfix must be a merged PR carrying a `hotfix` or `emergency-fix`
  label; an incident must be an issue carrying an `incident`, `outage`, or
  severity label. Arbitrary JSON, branch names, and issue prose are rejected.
- An open pull request remains `unreviewed` / `unknown` unless stronger official
  evidence exists.

The bundle records each source basename, size, and SHA-256, but not its body.
Its stable evidence hash excludes render time. Inputs are capped at 32 MiB per
source; malformed, oversized, or tampered bundles fail closed.
In the generated outcome workflow, an API collection failure fails the snapshot
instead of silently emitting a partial success.

## Actions usage boundary

GitHub run and job exports can establish status, conclusion, attempt, elapsed
run time, aggregate job time, and failed-job count. The schema deliberately
sets Actions billing to `UNAVAILABLE`.

The evidence job cannot know its own final duration while it is still running.
The generated post-run snapshot closes that duration after completion. GitHub
does not provide one universal, durable per-run USD amount through the
workflow-run object, so minutes and attributed dollars remain separate facts.
Agent Vigil does not multiply runner minutes by a guessed price and call that
billed cost.

## Trust boundary

A source hash proves which bytes were used; it does not prove that a locally
supplied JSON file came from GitHub. The generated outcome workflow has stronger
provenance because it fetches PR records through GitHub's authenticated REST API
with read-only permissions. Standalone users should preserve the API response
or attestation that establishes origin. A bundle is not evidence of adoption,
payment, or revenue.

Official API references:

- [Pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [Pull-request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)
- [Actions metrics](https://docs.github.com/en/actions/concepts/metrics)
