# Agent Vigil

[![CI](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml/badge.svg)](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](package.json)
[![No runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-0f766e.svg)](package.json)

**Agent Vigil is a required GitHub check for pull requests made with coding agents.**

It verifies the exact proposed commit with rules and test commands selected from
the base branch. Missing, stale, contradictory, skipped, neutral, or weakened
evidence does not pass. Every result names the base and head commits and gives a
reproduction command.

Agent Vigil does not replace code review and does not claim that passing tests
make code correct. Review tools find likely bugs. Agent Vigil answers a narrower
question: **did this exact change produce the evidence the repository requires
before merge?**

![Agent Vigil illustrative evidence-gate demo](docs/assets/agent-vigil-demo.gif)

## Try the public evidence check

[Paste a public pull-request URL into the browser checker](https://sulmusic2-star.github.io/agent-vigil/check.html).
No login, token, repository write, or source upload is required.

The checker reads public GitHub metadata. It does **not** run repository tests,
decide whether a workflow is trustworthy, or authorize a merge. After the check,
it gives the repository owner an exact local command for installing the full
gate. Nothing is installed or posted by the page.

Outside maintainers may optionally [register a trial](https://github.com/sulmusic2-star/agent-vigil/issues/new?template=adopter-feedback.yml)
with public evidence and consent.

## Install the full gate

The currently verified public package is the immutable v0.22.0 GitHub artifact:

```bash
curl -fL -o agent-vigil.tgz \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz
mkdir agent-vigil-package
tar -xzf agent-vigil.tgz -C agent-vigil-package --strip-components=1
node agent-vigil-package/dist/cli.js protect --repo . \
  --action-sha 7531f549eb3f4c6c5bdc4a12245c8690a7a79a09
```

Review the four generated files, commit them in a setup pull request, and run:

```bash
node agent-vigil-package/dist/cli.js doctor --repo .
```

The setup PR starts the check. To make it an enforceable trust boundary, require
an externally controlled exact-head check or GitHub App. A required job name
alone does not prove who supplied the workflow.

[Five-minute installation guide](https://github.com/sulmusic2-star/agent-vigil/blob/7531f549eb3f4c6c5bdc4a12245c8690a7a79a09/docs/INSTALL_WITHOUT_NPM_ACCOUNT.md)

**Distribution status, verified August 30, 2026:** GitHub release v0.22.0 and
the Marketplace Action are public. npm currently serves v0.21.1. Do not use an
npm command as proof of v0.22.0 until the registry reaches release parity.

## What a result means

- **PASS** — the exact head commit met every base-owned requirement that could
  authorize this check.
- **FAIL** — at least one required claim was contradicted.
- **INCONCLUSIVE** — required evidence was missing, stale, incomplete, or could
  not be verified safely.

A short result looks like this:

```text
Agent Vigil: FAIL
Base: 08d6e10...  Head: 4e0b9ca...
The agent reported 184 passing tests. The isolated run observed 161,
including 3 skipped tests added by this change.
Reproduce: vigil verify --base 08d6e10... --head 4e0b9ca...
```

The retained receipt contains the exact SHAs, policy identity, commands,
changed-file manifest, claimed and observed test counts, integrity findings,
unresolved claims, and remediation steps. Raw transcripts do not need to be
committed.

## What it checks

The protection profile can require:

- exact base and head commit identity;
- base-owned policy and workflow bytes;
- fresh tests in a credential-free Docker sandbox;
- claimed versus observed test counts kept as separate facts;
- no new skips, focused tests, weakened assertions, patched runtimes, or
  suppressed failures;
- a regression test that fails on the base and passes on the head;
- changed-path and changed-line limits;
- no edits to protected policy, workflow, or verifier paths;
- no missing evidence disguised as a green result.

Candidate setup may use network access only when the base policy selects a
bounded dependency command. Test execution is networkless, read-only, drops
capabilities, receives no repository token, and runs in a private exact-commit
clone. See the [hosted security contract](docs/HOSTED_SECURITY_CONTRACT.md).

## Current hosted compatibility

The v0.22.0 generated workflow supports a plain Git repository or a root
Node/npm repository whose selected test command is a bounded direct
`node --test` command. A root npm lock can select
`npm ci --ignore-scripts` for setup.

Python, Rust, Go, Java, Ruby, PHP, .NET, pnpm, Yarn, Bun, nested-only npm,
custom registry configuration, and arbitrary package scripts remain local-only
in v0.22.0. The local CLI can parse and verify many of those result formats.
Those adapters do not make an unsupported repository eligible for the hosted installer.

The next source release adds an explicit hermetic-runner path for those
toolchains. It is opt-in because the image becomes part of the trusted base:

```bash
node dist/cli.js protect --repo . \
  --runner-image ghcr.io/your-org/agent-vigil-runner@sha256:<64-hex-digest> \
  --test-cmd "python3 -m pytest -q"
```

The image must be selected in the base commit, pinned by digest, contain the
standard Node runtime used by the sandbox wrapper, and include every dependency
needed by the test command. Custom setup and test-time network access stay
disabled. The receipt records the exact image digest and command. Agent Vigil
rejects a pull request that changes `.agent-vigil-runner.json`.

The repository contains a common multi-toolchain image recipe and a provenance-
enabled GHCR publication workflow. That recipe is source until its first hosted
build succeeds and an immutable public digest is recorded; no floating tag is a
supported trust input.

This boundary is deliberate: running candidate code on the GitHub host would
be broader compatibility at the cost of the security property the gate exists
to provide. The compatibility table records tested support without treating
parser support as hosted isolation support.

[Compatibility table and real-toolchain lab](docs/COMPATIBILITY.md)

## Run it from source

```bash
git clone https://github.com/sulmusic2-star/agent-vigil.git
cd agent-vigil
npm ci
npm run typecheck
npm run build
npm test
npm run test:package
node dist/cli.js protect --repo .
```

The 60-second demo builds a disposable repository, installs the generated gate,
and replays three published first-party failure cases:

```bash
npm run demo:60s
```

That proves the checked-out code can replay those cases. It does not count as
outside adoption.

## GitHub Action

Pin the Action to a reviewed 40-character commit SHA:

```yaml
- uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
  with:
    node-version: 22.23.2
    package-manager-cache: false
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with:
    fetch-depth: 0
    persist-credentials: false
- id: vigil
  uses: sulmusic2-star/agent-vigil@7531f549eb3f4c6c5bdc4a12245c8690a7a79a09
  with:
    mode: maintainer
    policy: .agent-vigil.json
    policy-ref: ${{ github.event.pull_request.base.sha }}
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.event.pull_request.head.sha }}
    isolate-candidate: true
```

`setup-node` is the first executable step in a fresh hosted job; do not run untrusted code before it or carry forward a surviving untrusted
process. The
generated workflow applies the full [hosted security contract](docs/HOSTED_SECURITY_CONTRACT.md).

Do not use a floating tag for a required control. The generated workflow pins
checkout, setup, upload, and Agent Vigil itself.

For merge queues, the required check must also handle GitHub's `merge_group`
event. The repository-owned example is useful for testing Agent Vigil itself, but safe
organization-wide enforcement still requires an externally controlled workflow
or App-owned check. See [merge-queue handling](docs/MERGE_QUEUES.md).

## Public PR receipts

The browser and CLI can record the public lifecycle evidence for a pull request:

```bash
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz \
  pr-receipt https://github.com/OWNER/REPOSITORY/pull/123 \
  --tool-ref 7531f549eb3f4c6c5bdc4a12245c8690a7a79a09 \
  --output pr-123.receipt.json
```

`CURRENT`, `HOLD`, `EXPIRED`, and `REVOKED` describe selected public evidence at
the observation time. These receipts always set protected-action authorization
to false. Public metadata cannot prove that a repository's checks were
sufficient. See [the public receipt boundary](docs/PUBLIC_PR_RECEIPT.md).

## Advanced controls

The CLI also includes:

- [Agent Authority Plan](docs/AUTHORITY_PLAN.md) for comparing declared tool,
  network, filesystem, credential, and hook authority;
- [Upgrade Guard](docs/UPGRADE_GUARD.md) for repeated canary checks against a
  digest-pinned plugin or configuration update;
- [Control Proof](docs/CONTROL_PROOF.md) for testing whether a required control
  still blocks planted failures;
- [Continuity](docs/CONTINUITY.md) for chained evidence after the first green
  check;
- [Agent Value Cards](docs/AGENT_VALUE_CARD.md) for binding verified work to
  cost, review disposition, merge, revert, incident, and deployment outcomes;
- [Outcome mandates](docs/OUTCOME_MANDATES.md) for signed dry-run acceptance
  records. The current code does not hold or move money.

Start with the required check. Add an advanced control only when it answers a
specific operational question.

## Evidence and limits

- 803 tests, including adversarial hosted, package, browser, and portability cases.
- [Published failure corpus](proof/README.md)
- [Benchmarks](docs/BENCHMARKS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Receipt format](docs/AI_CHANGE_RECEIPT.md)
- [Security policy](SECURITY.md)
- [Commercial proof gates](docs/COMMERCIAL_GATES.md)

This repository's own runs prove first-party technical behavior. They do not
prove external adoption, retention, willingness to pay, revenue, or that Agent
Vigil is better than every competing product.

## Contributing

Use a branch and pull request. Run the full checks above, add an adversarial
fixture for every fixed false result, and keep capability claims tied to an
exact test, artifact, commit, or public source.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
