# Hosted evidence security contract

**Applies to:** Agent Vigil v0.21.0 generated `init` and `protect` workflows

Agent Vigil's generated hosted lane checks one GitHub pull-request head under a
base-owned policy. It is intentionally narrower than the local CLI.

## Install from a reviewed commit

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.0/sulmusic-agent-vigil-0.21.0.tgz \
  protect --action-sha <reviewed-full-commit>

npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.0/sulmusic-agent-vigil-0.21.0.tgz \
  doctor
```

`--action-sha` must be one reviewed lowercase 40-hex Agent Vigil commit. It is
written into both generated workflows. A tag, branch, shortened commit, or
different outcome-workflow commit is rejected.

The generated files are a prepared installation, not proof that a live ruleset
requires them. Commit and review the files first. Then configure an external
enforcement source as described below.

## Pull-request evidence boundary

The generated evidence workflow:

- is selected from the base branch through `pull_request_target`;
- accepts only an open pull-request event with exact full base and head commits;
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
not claim merge-queue enforcement. An enforceable deployment needs one of:

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
