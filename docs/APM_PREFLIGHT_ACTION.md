# APM preflight GitHub Action

The Action's `upgrade` mode turns a pull-request or merge-queue APM lockfile
change into one fail-closed compatibility check:

```text
exact event base/head -> private APM plan -> exact artifact acquisition
-> temporary materialization -> contained comparison -> restoration -> receipt
```

It does not update an active APM installation. Current and candidate artifacts
are placed in an exclusive temporary session, mounted read-only for the same
trusted canaries, and removed before a non-`HOLD` result is returned.

## Release status

This no-checkout workflow is prepared for the v0.17.0 release candidate; it was
not part of the prior public v0.16.0 signed-control release. The checked-in
workflow is local source until an independently reviewed exact release is live
and an organization installs and requires it. There are zero verified external
activations, payments, and revenue. R0 has not started, and neither local test
execution nor a release-preparation commit starts it. Operational opt-in
lifecycle measurement and commercial-name clearance remain separate gates.
The broader candidate also packages the durable public update-pair corpus and
disabled local proof-network and Team sources; this Action neither deploys nor
connects either service.

## Required repository state

The trusted base commit must contain:

- the root `apm.lock.yaml` file;
- `.agent-vigil/upgrade/config.json`;
- deterministic, repository-specific canaries under the configured trusted
  canary directory.

Generate the initial private scaffold with `vigil upgrade init --repo .`, then
replace its deliberately failing template canary. The template can never earn
`SAFE`.

The runner image is an immutable Linux/amd64 child manifest and must already
be in the local Docker cache. A multi-platform index digest is not accepted as
an exact runner identity. Upgrade Guard never pulls it during a comparison. A hosted workflow should
therefore preload the exact configured digest in a separate, visible step. The
default scaffold currently uses:

```text
node:22.22.3-bookworm-slim@sha256:16d364eebf6b62da439dc993d9b80940c78b0ca38438452f011ab9a25c752644
```

Pulling that exact digest changes the runner's Docker cache and trusts the
registry transport, Docker client, daemon, and host. The digest binds the image
bytes used by the subsequent comparison; it is not provenance proof.

## Event and evidence binding

The workflow accepts `pull_request_target` and `merge_group` event identities.
Before classification, the protected workflow uses the read-only
`github.token` in one sanitized fetch step to create a mode-`0700`, bare Git
repository below `RUNNER_TEMP`. Both objects come from the event repository on
`github.com`; a fork pull request is fetched through the base repository's
event-bound `refs/pull/<number>/head`, never through a fork URL. The base is
fetched by its exact event OID, so an ordinary base-branch advance does not
invalidate the older event; an OID that is no longer reachable fails closed.
The token is
passed to the Git child through an ephemeral `GIT_CONFIG_*` header environment,
then unset. No credential helper, remote, checkout, worktree, tag, submodule,
hook, filter, or persisted authentication configuration is used.

An internal sanitized `git diff-tree` classifier compares only the verified
`refs/vigil/base` and `refs/vigil/head` commits and fixed APM lock, harness, and
protected-workflow paths. The observed object IDs must still equal the event
SHAs after each fetch. A pull or queue head ref that advances before the fetch
therefore fails closed without a compatibility verdict; that result is a hold, not
evidence about the newer commit. An unrelated
composition exits successfully without pulling the runner or producing a
compatibility verdict; a relevant composition enters the preflight below.
This is required because GitHub ruleset-required workflows ignore event path
filters. The comparison contract exposes no alternate path, pair-identity,
Docker client, or fetch-client inputs to candidate workflow code. It:

1. requires the caller's `base` and `head` inputs to equal the event payload;
2. requires `repo` to resolve either to the canonical GitHub workspace or to
   the exact private bare event repository shape, verifies that the latter has
   only the two event refs, no remotes, no sensitive local configuration, no
   object alternates, and then reads both lockfiles as exact regular blobs
   through sanitized `git ls-tree` and `git cat-file` plumbing;
3. rejects a missing lockfile or one larger than 4 MiB before materialization;
4. requires the base and head `.agent-vigil/upgrade` tree identities to match,
   rejects links, submodules, extras, collisions, and unsafe paths, and
   materializes the exact base config and canary blobs into a private
   runner-owned directory without running checkout hooks or filters;
5. permits only exact, credential-free GitHub commit archive acquisition through
   the preflight's fixed, sanitized `curl` boundary;
6. passes both temporary artifacts through Upgrade Guard's planted containment
   probe and repeated canaries; and
7. requires `restoration.status=RESTORED`, `sessionRemoved=true`, and
   `hostMutation=NONE` before `SAFE` or `CHANGED` can be returned; and
8. removes the runner-owned trusted-input directory before publishing Action
   outputs. Cleanup failure deletes the temporary wrapper and forces exit `2`
   rather than exposing a stale non-`HOLD` status.

An `if: always()` workflow step independently validates and removes the exact
`agent-vigil-event-repo.XXXXXX` parent after classification or preflight and
asserts that it is gone. If the fetch created the parent and later failed, its
early `parent` output still routes that cleanup.

## Hosted runtime trust boundary

The composite does not resolve `env`, Git, or Node from caller `PATH`. It accepts
fixed canonical system tools and Node only from `/usr/bin/node`, an exact
`/opt/hostedtoolcache/node/<semver>/x64/bin/node` shape, or the corresponding
fixed macOS hosted-runner shapes. The selected executable must be a regular
executable with no group- or other-write bits and must be outside the workspace,
Action directory, and `RUNNER_TEMP`. Writable ancestors are allowed because
GitHub intentionally makes hosted tool roots writable; the ephemeral runner
image is an explicit trust dependency, not a same-user tamper-resistance claim.

Before use, Node is copied into a fresh mode-`0700` runtime directory under
`RUNNER_TEMP`, changed to mode `0500`, and checked against the source using its
device/inode/size/time/mode fingerprint, SHA-256, and byte comparison. The
checkpointed version must be Node 20 or newer and must match the semver embedded
in a hosted-toolcache path. The private checkpoint is removed on shell exit.
CI pins the Linux job to `ubuntu-24.04` and smoke-tests the actual hosted
toolcache path, permissions, `env`, Git, and Node contract.

The private `agent-vigil-apm-preflight/v1` wrapper binds the plan, selected
pair, acquired artifact bytes and tree identities, a 64-KiB-bounded exact copy
of each configured manifest, the nested Upgrade Guard receipt, and restoration
result. Verification matches those manifest bytes to their selected-tree file
commitments and independently derives the manifest hashes, identities,
versions, and configured capability snapshots. The plan must contain exactly
that one eligible update;
any added, removed, workspace, configuration, second update, or other
unassessed row returns `HOLD`. The Action exposes the runner-owned wrapper path through its
`report` output using the canonical `agent-vigil-report.json` basename. The
related private outputs use `agent-vigil.sarif`,
`agent-vigil-value-card.json`, and `agent-vigil-github-evidence.json`; none is
copied into the pull-request workspace.
It does not publish that private wrapper or enable telemetry by default.

## Verdicts

| Verdict | Exit | Required-check meaning |
|---|---:|---|
| `SAFE` | 0 | Complete stable evidence found no configured material change. |
| `CHANGED` | 1 | Complete stable evidence found a change; review or hold the update. |
| `HOLD` | 2 | Exact identity, acquisition, containment, comparison, or restoration evidence is incomplete. |

`SAFE` is scoped to the configured canaries and contained runner. It is not a
general security, provenance, or production-compatibility claim.

## Workflow

Use the checked-in [workflow example](../examples/upgrade-guard/github-workflow.yml).
It runs from the base branch through `pull_request_target`, grants read-only
repository access, fetches the exact event objects into a private bare
repository without materializing candidate files, and preloads the exact runner
digest. The fetch boundary supports private repositories through the scoped
read token, but the Action itself rejects any token input. Keep the installed
workflow at `.github/workflows/agent-vigil-upgrade.yml` so its own path change
is classified as relevant by the protected base copy. Do not add cloud, package-publishing,
deployment, model-provider, signing, or other secrets to this job.

The no-checkout fetch is safe only under this narrow contract. Do not add
dependency installation, build commands, repository scripts, local Action
references, shell sourcing, or any other candidate-controlled execution to the
job. If the job needs such a step, move it to an unprivileged `pull_request`
workflow and keep this protected verifier separate.

Configure an organization ruleset that requires this exact workflow from a
separately controlled source repository, branch, and workflow path before
treating it as an unbypassable merge gate. A required status name alone is not
the same control: another workflow can omit the Action or try to emit a
look-alike check. If the repository cannot use a required-workflow ruleset,
describe the result as advisory rather than self-protecting.

The wrapper is private evidence. The default public-repository example does
not upload it. Only add artifact retention in a private repository whose read
access and retention policy are appropriate for exact component identities,
manifest bytes, private canary IDs, commands, and observation commitments.
