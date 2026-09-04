# Hosted evidence security contract

**Applies to:** Agent Vigil v0.24.1 `init` and `protect` workflows

Agent Vigil's generated hosted lane checks one GitHub pull-request head under a
base-owned policy. It is intentionally narrower than the local CLI.

## Validate from a reviewed source checkout

```bash
node dist/cli.js protect
```

The immutable v0.24.1 package contains the preceding documentation snapshot:
it labels this contract v0.24.0 and retains the v0.24.0 package disclosure. It
does not contain this post-release wording. The v0.24.1 runtime and package were
verified separately. Download that package without npm credentials and verify
its checksum:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.1/sulmusic-agent-vigil-0.24.1.tgz doctor
```

`protect` selects the immutable reviewed public Action commit and writes it into
both generated workflows. An explicit `--action-sha` remains available for a
reviewed full commit; tags, branches, and shortened commits are rejected.

The generated files are a prepared installation, not proof that a live ruleset
requires them. Commit and review the files first. Then configure an external
enforcement source as described below.

## Pull-request evidence boundary

The generated evidence workflow:

- is selected from the base branch through `pull_request_target`;
- accepts only an open pull-request event with exact full base and head commits;
- selects exact Node.js `22.23.2` with the commit-pinned `setup-node` Action
  before candidate files are checked out;
- checks out the event head with `persist-credentials: false`;
- gives the candidate job read-only metadata permissions and passes no GitHub
  token, OIDC authority, attestation authority, or write permission to Agent
  Vigil;
- uses an Agent Vigil Action outside the candidate workspace and pinned to the
  reviewed full commit;
- creates one private exact-commit candidate clone with no extra refs, history,
  or dirty workspace state; and
- runs repository-controlled setup and tests only on a GitHub-hosted Linux
  runner through the fixed candidate-only Docker path.

The composite Action accepts no ambient or system Node fallback. It admits only
the canonical `setup-node` toolcache path for Node.js `22.23.2`, verifies the
reviewed platform-specific SHA-256 before copying it, changes the private copy
to mode `0500`, and verifies its digest and byte identity again before the first
Node invocation. A missing, moved, differently versioned, or digest-mismatched
runtime blocks the Action. Updating Node therefore requires a reviewed workflow
pin and reviewed binary digests, not a floating `22` selector.

The v0.24.1 runtime bindings were derived from the official Node.js v22.23.2
release archives after each archive matched the release
[`SHASUMS256.txt`](https://nodejs.org/download/release/v22.23.2/SHASUMS256.txt):

| Hosted runtime | Official archive SHA-256 | Extracted `bin/node` SHA-256 |
| --- | --- | --- |
| Linux x64 (`node-v22.23.2-linux-x64.tar.xz`) | `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307` | `3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327` |
| macOS x64 (`node-v22.23.2-darwin-x64.tar.gz`) | `58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026` | `0b4f059915f3bf3c6cbb02422f4a529bfb21cbbec2d29851c9a5d833f78a04f6` |
| macOS arm64 (`node-v22.23.2-darwin-arm64.tar.gz`) | `61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6` | `18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572` |

This bootstrap assumes a fresh GitHub-hosted job with no prior untrusted step or
surviving untrusted process. The generated evidence workflow satisfies that
assumption by selecting Node before checkout and by running candidate setup and
tests only later inside the candidate-only Docker contract. Custom workflows
must not execute repository code, package lifecycle scripts, or another
untrusted process before Agent Vigil; doing so is outside this security
contract even when the later Node digest matches.

The digest, fingerprint, copy, and byte-comparison sequence detects changed
source or destination bytes before the first Node execution. It is not a
kernel-enforced exclusion lock. A pre-existing process with the runner's UID or
root authority could race the source or private checkpoint between validation
and use, including an ABA change-and-restore around a fingerprint or digest
observation. The generated fresh-job ordering excludes such a process from the
supported threat model; self-hosted runners, reused jobs, and workflows with a
prior untrusted step need a separately reviewed isolation boundary.

The dependency setup step, when needed, is the base-owned exact command
`npm ci --ignore-scripts`. It receives a writable candidate mount and network
access. Candidate tests receive a read-only source mount and no network. Both
steps run with a minimal environment and no repository, cloud, package-publish,
deployment, or signing credentials.

This is a bounded hosted contract. Docker, the GitHub-hosted runner, the pinned
runner image, the reviewed Action commit, GitHub's event payload, and the base
branch remain trusted. The contract does not prove semantic correctness or
contain a compromised Docker daemon or host.

## Supported hosted repositories

Generated hosted execution supports:

- a plain repository with no inferred non-Node test toolchain; or
- a root Node/npm repository whose test command is one bounded direct
  `node --test` invocation.

The command can come from `package.json` `scripts.test` or from the explicit
`agentVigil.hostedTestCommand` field. The override is still restricted to the
same direct `node --test` grammar. A root `package-lock.json` or
`npm-shrinkwrap.json` permits the exact setup command above.

The generator fails closed for unsupported toolchains, pnpm, Yarn, Bun,
repository `.npmrc` files, nested-package-only layouts, unsafe setup symlinks,
Git submodules, indirect test runners, shell composition, Node preload or
loader flags, and unbounded path or option forms. Use the local CLI or build a
separately reviewed external workflow for those repositories.

The local CLI supports more test ecosystems, but it executes selected commands
with the local process's host privileges. A detached Git worktree protects Git
identity; it is not process, filesystem, credential, or network isolation.

## Attestation boundary

Candidate-executing evidence cannot use `attest: true`. Both `init --attest`
and `protect --attest` fail closed because candidate code and signing authority
must not share a job.

Control Proof is separate. Its schedule-only workflow runs the reviewed Agent
Vigil proof against planted, non-candidate challenges in a job with no OIDC.
A second job with no repository checkout validates the bounded proof and
predicate artifact before using GitHub OIDC to sign the exact proof. That
signature does not sign a candidate receipt and does not establish that the
pull-request check is required. See [Control Proof](CONTROL_PROOF.md) and
[attestation boundaries](ATTESTED_RECEIPTS.md).

## Required-check and merge-queue boundary

A plain GitHub required status check selects a reported context or job name. It
does not bind that name to the expected workflow file, event, or reviewed
Action commit. A candidate-controlled workflow can report the same job name.
Requiring `Agent Vigil evidence` by name alone therefore does not make the
generated workflow an enforceable security boundary.

The generated repository workflow does not subscribe to `merge_group` and does
not claim merge-queue enforcement. The repository now includes an external App
dispatcher and trusted default-branch queue workflow, but that path remains a
deployment candidate until its real signed-event acceptance test passes. An
enforceable deployment needs one of:

- an organization or enterprise ruleset that requires a workflow controlled
  outside the candidate repository; or
- an external GitHub App check that validates the exact head, expected event,
  and expected evidence source before reporting its own protected conclusion.

That external control must cover both pull-request and merge-queue heads when a
repository uses a queue. The low-level `vigil merge-group` verifier remains
available for such an externally controlled integration. See
[merge-queue integration](MERGE_QUEUES.md).

## Outcome boundary

The generated outcome workflow listens only for a completed `workflow_run`
whose source event was `pull_request_target`. It downloads that exact run's
retained receipt and records a read-only snapshot of the completed Actions run
and pull-request state. It does not check out or execute candidate code.

This snapshot does not continuously observe a later close, merge, revert,
hotfix, incident, deployment, payment, or revenue event. Those facts need a
separate authenticated observer. See [Outcome Observer](OUTCOME_OBSERVER.md).

## Evidence and product claims

A passing local test run or hosted receipt establishes only the checked bytes,
inputs, and environment. It is not evidence of an external installation,
adoption, payment, revenue, or market demand. Those states require separate,
direct evidence.
