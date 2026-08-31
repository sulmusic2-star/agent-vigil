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

The latest verified public package remains the immutable v0.23.2 GitHub
artifact:

```bash
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz \
  protect --repo .
```

v0.23.3 is a source release candidate until GitHub lists both the package and checksum assets.
After both v0.23.3 assets appear on the release page, install the exact
candidate package with:

```bash
curl -fL -o agent-vigil.tgz \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.3/sulmusic-agent-vigil-0.23.3.tgz
mkdir agent-vigil-package
tar -xzf agent-vigil.tgz -C agent-vigil-package --strip-components=1
node agent-vigil-package/dist/cli.js protect --repo .
```

To verify the package before installation, download the package and its attached
checksum from the immutable release:

```bash
curl -fLO \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz
curl -fLO \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz.sha256
shasum -a 256 -c sulmusic-agent-vigil-0.23.2.tgz.sha256
mkdir agent-vigil-package
tar -xzf sulmusic-agent-vigil-0.23.2.tgz -C agent-vigil-package --strip-components=1
node agent-vigil-package/dist/cli.js protect --repo . \
  --action-sha fb21ec981cc7e8c5cb64a3529cb4f4900ca1c502
```

Review the four generated files, commit them in a setup pull request, and run:

```bash
node agent-vigil-package/dist/cli.js doctor --repo .
```

The setup PR starts the check. To make it an enforceable trust boundary, require
an externally controlled exact-head check or GitHub App. A required job name
alone does not prove who supplied the workflow.

[Five-minute installation guide](https://github.com/sulmusic2-star/agent-vigil/blob/fdf277cb0f2bde1dab82df4d8894bef1a75145b7/docs/INSTALL_WITHOUT_NPM_ACCOUNT.md)

**Distribution status, verified August 31, 2026:** GitHub release v0.23.2 is
public and immutable, and the Marketplace listing exposes v0.23.2. v0.23.3 is
an unpublished source candidate. npm still serves v0.21.1 publicly; use the
verified v0.23.2 GitHub artifact until each newer channel is checked separately.

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

The v0.23.2 generated workflow can infer a bounded direct `node --test`
command for a root Node/npm repository. Plain Git repositories and other
toolchains use an explicit hermetic runner and an explicit test command:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz protect --repo . \
  --runner common \
  --test-cmd "python3 -m pytest -q"
```

The common image includes Node, Python, Rust, Go, Java, Ruby, PHP, .NET, pnpm,
Yarn, and Bun. It does not install project dependencies at test time. The image
must be selected in the base commit, pinned by digest, contain the
standard Node runtime used by the sandbox wrapper, and include every dependency
needed by the test command. Custom setup and test-time network access stay
disabled. The receipt records the exact image digest and command. Agent Vigil
rejects a pull request that changes `.agent-vigil-runner.json`.

`--runner common` resolves to the public image
`ghcr.io/sulmusic2-star/agent-vigil-runner@sha256:efdaa365db14cb8d64408beac91361ed0875111e4c07254e2b3729801df606a0`.
Its hosted build includes provenance and an SBOM. Use `--runner-image` instead
to select a reviewed image owned by your organization. No floating tag is a
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
  uses: sulmusic2-star/agent-vigil@fdf277cb0f2bde1dab82df4d8894bef1a75145b7
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
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz \
  pr-receipt https://github.com/OWNER/REPOSITORY/pull/123 \
  --tool-ref fb21ec981cc7e8c5cb64a3529cb4f4900ca1c502 \
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

- 805 tests, including adversarial hosted, package, browser, and portability cases.
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
