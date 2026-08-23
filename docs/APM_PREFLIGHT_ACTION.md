# APM preflight GitHub Action

The Action's `upgrade` mode turns a pull-request APM lockfile change into one
fail-closed compatibility check:

```text
exact event base/head -> private APM plan -> exact artifact acquisition
-> temporary materialization -> contained comparison -> restoration -> receipt
```

It does not update an active APM installation. Current and candidate artifacts
are placed in an exclusive temporary session, mounted read-only for the same
trusted canaries, and removed before a non-`HOLD` result is returned.

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

The low-level Action accepts `pull_request` and `merge_group` event identities,
but the shipped R0 workflow deliberately invokes the automatic path only from
`pull_request_target`. A merge-queue installation needs an additional exact
relevance gate so a composition with no APM change can pass without describing
it as a checked update; that complete workflow is not shipped in v1. The first
pull-request contract exposes no alternate path, pair-identity, Docker client,
or fetch-client inputs to candidate workflow code. It:

1. requires the caller's `base` and `head` inputs to equal the event payload;
2. requires `repo` to resolve to the GitHub-managed workspace and reads both
   lockfiles as exact regular blobs through sanitized `git ls-tree` and
   `git cat-file` plumbing rather than trusting the checkout;
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

The private `agent-vigil-apm-preflight/v1` wrapper binds the plan, selected
pair, acquired artifact bytes and tree identities, nested Upgrade Guard receipt,
and restoration result. The plan must contain exactly that one eligible update;
any added, removed, workspace, configuration, second update, or other
unassessed row returns `HOLD`. The Action exposes the runner-owned wrapper path through its
   `report` output; it never copies the wrapper into the pull-request workspace.
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
repository access, fetches the exact candidate object without executing
repository content, explicitly enables checkout v7's fork-head materialization
guard for that no-execution design, and preloads the exact runner digest. Keep the installed
workflow at `.github/workflows/agent-vigil-upgrade.yml` so its own path change
triggers the protected base copy. Do not add cloud, package-publishing,
deployment, model-provider, signing, or other secrets to this job.

The checkout opt-out is safe only under this narrow contract. Do not add
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
