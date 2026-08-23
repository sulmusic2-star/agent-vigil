# APM preflight GitHub Action

The Action's `upgrade` mode turns a pull-request or merge-queue APM lockfile
change into one required, fail-closed compatibility check:

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

The runner image is immutable and must already be in the local Docker cache.
Upgrade Guard never pulls it during a comparison. A hosted workflow should
therefore preload the exact configured digest in a separate, visible step. The
default scaffold currently uses:

```text
node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752
```

Pulling that exact digest changes the runner's Docker cache and trusts the
registry transport, Docker client, daemon, and host. The digest binds the image
bytes used by the subsequent comparison; it is not provenance proof.

## Event and evidence binding

Upgrade mode accepts only `pull_request` and `merge_group` events. The first
Action contract deliberately exposes no alternate path, pair-identity, Docker
client, or fetch-client inputs to candidate workflow code. It:

1. requires the caller's `base` and `head` inputs to equal the event payload;
2. requires `repo` to resolve to the GitHub-managed workspace and reads both
   lockfiles with `git show <exact-sha>:apm.lock.yaml` rather than
   trusting the checked-out candidate file;
3. rejects a missing lockfile or one larger than 4 MiB before materialization;
4. creates a detached worktree at the exact base commit and loads the config
   and canaries only from its fixed `.agent-vigil/upgrade/config.json`;
5. permits only exact, credential-free GitHub commit archive acquisition through
   the preflight's fixed, sanitized `curl` boundary;
6. passes both temporary artifacts through Upgrade Guard's planted containment
   probe and repeated canaries; and
7. requires `restoration.status=RESTORED`, `sessionRemoved=true`, and
   `hostMutation=NONE` before `SAFE` or `CHANGED` can be returned; and
8. removes the detached trusted-base worktree before publishing Action outputs.
   Cleanup failure deletes the temporary wrapper and forces exit `2` rather
   than exposing a stale non-`HOLD` status.

The private `agent-vigil-apm-preflight/v1` wrapper binds the plan, selected
pair, acquired artifact bytes and tree identities, nested Upgrade Guard receipt,
   and restoration result. If more than one pair is eligible, selection remains
   ambiguous and the Action returns `HOLD`; a pull request cannot select an
   unrelated pair. The Action copies the wrapper to `agent-vigil-report.json`.
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
It grants read-only repository access, fetches full Git history, preloads the
exact runner digest, and retains the private receipt as a GitHub Actions
artifact. Do not add cloud, package-publishing, deployment, model-provider, or
signing credentials to this job.
