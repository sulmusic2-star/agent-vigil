# Agent Vigil

[![CI](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml/badge.svg)](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](package.json)

**Agent Vigil is an independent merge check for AI-assisted pull requests.**

It runs the test and evidence policy from the base branch against the exact
proposed commit. A missing run, stale result, changed policy, weaker test, or
contradictory claim cannot appear as a pass.

Review tools look for likely bugs. Agent Vigil answers a different question:
**did this exact change produce the evidence your repository requires before
merge?**

![Agent Vigil illustrative evidence-gate demo](docs/assets/agent-vigil-demo.gif)

## Add it to a repository

The v0.24.1 package and checksum are public on GitHub. Setup and the
follow-up check use that same immutable release, so the first run does not
depend on npm publication.

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.1/sulmusic-agent-vigil-0.24.1.tgz protect --repo .
```

The command finds the repository's test setup, runs a disposable red/green
rehearsal, and writes the setup files. Commit those files and open one setup
pull request. After it merges, the printed `doctor` command uses the same
v0.24.1 GitHub package. Then open a normal code pull request and read
one result:

- **PASS** — ready to merge under the repository's current policy.
- **FAIL** — do not merge yet; a required check found a contradiction.
- **NOT CHECKED** — no merge decision; required evidence did not run or could
  not be bound safely to the current commit.

A failed result is deliberately short:

```text
Agent Vigil: FAIL
Do not merge yet.
Reason: Reported test count does not match the isolated run.
Tests: claimed 184; observed 161
Fix: Run the configured test command again and report the observed count.
Reproduce: vigil verify --base <base-sha> --head <head-sha>
```

The full receipt keeps the exact SHAs, policy hash, changed files, commands,
claimed and observed test counts, findings, and reproduction command.

### Verify the distribution channel

This packaged README describes v0.24.1; it is not a claim that v0.24.1 remains
the newest release. The live, machine-readable channel record is
[`docs/public-install-state.json`](https://github.com/sulmusic2-star/agent-vigil/blob/main/docs/public-install-state.json).

Do not substitute an npm install until this query returns `0.24.1`:

```bash
npm view @sulmusic/agent-vigil version
```

All five public workflows for this release pin the reviewed runtime commit
`0d1f1c9f95f32a55c1a83772feab1944b0fcbd9e`. For the checksum-first download
and an explicit non-Node runner, use the [installation guide](docs/INSTALL_WITHOUT_NPM_ACCOUNT.md).

## What it checks

The default protection path can verify:

- exact base and head commit identity;
- base-owned policy and workflow bytes;
- fresh tests in a candidate-only Docker boundary;
- claimed and observed test counts as separate facts;
- skipped, focused, weakened, empty, patched, or self-fulfilling tests;
- a changed regression test that fails on base and passes on head;
- changed-path and changed-line limits;
- protected policy, workflow, and verifier paths;
- missing evidence that would otherwise look green.

Static integrity findings are review notes by default. Missing or malformed
required evidence fails closed. The frozen benchmark keeps catch quality and
review burden in the release gate; it does not turn presumed-clean pull requests
into labeled false positives.

The generated Node/npm path is automatic. Python, Rust, Go, Java, Ruby, PHP,
.NET, pnpm, Yarn, and Bun use the digest-pinned common runner with an explicit
test command:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.1/sulmusic-agent-vigil-0.24.1.tgz protect --repo . \
  --runner common \
  --test-cmd "python3 -m pytest -q"
```

Project dependencies must already be reproducible from the base-owned setup.
Tests run without network access. See the [compatibility table](docs/COMPATIBILITY.md)
and [hosted security contract](docs/HOSTED_SECURITY_CONTRACT.md).

## GitHub App

The public App path is designed to reduce customer setup to:

1. install the App and select repositories;
2. confirm the base-owned test setup;
3. open a pull request;
4. read `PASS`, `FAIL`, or `NOT CHECKED`.

The centrally operated App owns the check identity, supports `pull_request` and
`merge_group`, and keeps App keys and webhook secrets out of customer
repositories. Its source and threat boundary are in
[`hosted/public-app`](hosted/public-app). **It is not a live public service until
a real outside repository demonstrates PASS, FAIL, stale-head NOT CHECKED, and
a ruleset bound to the App.**

A repository-owned Action is useful for trials, but a job name alone is not a
workflow trust root. GitHub rulesets should require the App-owned check when the
public service is activated. See [merge-queue handling](docs/MERGE_QUEUES.md).

## Try a public pull request

The [browser checker](https://sulmusic2-star.github.io/agent-vigil/check.html)
reads public GitHub metadata without a login or token. It does not run trusted
repository tests, write a check, or authorize a merge. It returns an exact local
command for the full gate.

The CLI equivalent is:

```bash
vigil check https://github.com/OWNER/REPOSITORY/pull/123
```

## Verify this project

```bash
git clone https://github.com/sulmusic2-star/agent-vigil.git
cd agent-vigil
npm ci
npm run typecheck
npm run build
npm test
npm run test:hosted
npm run test:package
```

`vigil help` shows the four first-use commands. `vigil help --all` shows the
advanced receipt, authority, continuity, upgrade, certification, and outcome
commands.

## Evidence and limits

- [Protected local agent runs](docs/PROTECTED_RUN.md)
- [Local run autopsy](docs/RUN_AUTOPSY.md)
- [Frozen and comparative benchmarks](docs/BENCHMARKS.md)
- [Scoped competitor comparison](docs/COMPETITOR_COMPARISON.md)
- [Published failure corpus](proof/README.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Receipt format](docs/AI_CHANGE_RECEIPT.md)
- [Security policy](SECURITY.md)
- [Commercial proof gates](docs/COMMERCIAL_GATES.md)

This repository's runs prove first-party technical behavior. They do not prove
outside adoption, retained use, willingness to pay, revenue, or universal
superiority over competing products.

## Contributing

Use a branch and pull request. Add an adversarial fixture for every corrected
false result and tie capability claims to an exact test, artifact, commit, or
public source. See [CONTRIBUTING.md](CONTRIBUTING.md).
