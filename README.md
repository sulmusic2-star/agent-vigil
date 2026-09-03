# Agent Vigil

[![CI](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml/badge.svg)](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](package.json)

**Agent Vigil is the required check that is not an LLM: the deterministic,
signed receipt that an agent's green could have been red.**

Agent Vigil is an independent merge check for AI-assisted pull requests.

Wake up to a receipt, not a story.

## It catches that?

Agent Vigil is not another AI reviewer. Detection is the free layer. The product
is the receipt a maintainer, senior reviewer, auditor, customer, or insurer can
consume without trusting the agent that wrote the final summary.

The current receipt gates catch the failures that make overnight and unreviewed
agent runs expensive:

- **Denominator shrink:** a final summary says `4966/4966 ALL PASSED`, but the
  effect ledger shows `4985/4992` with failures. Detector: `denominator-shrink-4966`.
- **Test laundering:** deleted tests, new `skip` / `only` / pytest `xfail`, empty
  tests, constant or self-fulfilling oracles, assertion loss, and coverage gates
  weakened to zero.
- **Verifier laundering:** `|| true`, unsafe verifier/deploy pipelines without
  `pipefail`, changed CI workflows, changed policy, changed lock/config files,
  and stale required evidence.
- **Story-only release claims:** “merged,” “published,” or “deployed” in the
  final summary is not accepted unless the non-narrative effect ledger contains
  corresponding proof.

Why this now: the research behind this direction cites Faros numbers showing PRs
merged with no review up **31%** and review time up **441%**. If AI approvals can
count toward human approval requirements, repositories need a counterweight: a
required status check that is deterministic, base-owned, and not promptable.

## Start here

### 1. Check an overnight or run-end summary

```bash
vigil watch .agent-session.jsonl --repo . --base <base-sha> --head <head-sha> \
  --test-cmd "npm test --silent" \
  --output agent-vigil-receipt.json \
  --format markdown
```

`vigil watch` reads the final agent summary, parses concrete claims, and checks
them against the effect ledger: changed files, tool calls, test summaries, fresh
tests, and static anti-reward-hacking detectors. Add `--signing-key` to emit an
Ed25519-signed receipt.

### 2. Install the non-LLM PR counterweight

```bash
vigil counterweight install --owner-repo OWNER/REPO --action-sha <agent-vigil-commit>
```

This writes a required-check workflow, a GitHub ruleset manifest, and an apply
script. With `--apply`, the CLI calls the GitHub Rulesets API directly; that
requires repository-rules administration authority. The installer creates the
rule instead of assuming the repo already has a required status check.

### 3. Export the receipt for counterparties

```bash
vigil vault export agent-vigil-receipt.json --pack soc2 --format markdown \
  --output SOC2-CC8.1-agent-vigil.md
```

The OSS CLI emits deterministic export packs for SOC 2 CC8.1, SSDF PW.7/PW.8/PS.3,
PCAOB AI-evidence review, FINRA 3110 chain reconstruction, and insurer
represented-process review. This is local export generation, not hosted
long-retention storage.

### 4. Prove blast radius after destructive or infra actions

```bash
vigil blast-radius --repo . --base <base-sha> --head <head-sha> \
  --intent intent.json --format markdown --output blast-radius.md
```

`intent.json` declares pre-action scope. The receipt compares that declaration to
actual changed paths and obvious destructive/infra lines. It is the after-proof
layer for destructive-command guards, not a replacement for pre-action blocking.

### 5. Use the taxonomy and optional corpus hook

```bash
vigil taxonomy --format markdown
vigil corpus signature agent-vigil-receipt.json --model claude-code-x --harness overnight-v1 \
  --output signature.json
```

Corpus signatures are opt-in and anonymized: rule IDs, VIGIL taxonomy IDs,
model/harness labels, first-seen timestamp, and no transcript or repository path
content.

## Add it to a repository

The protection path remains one command:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz protect --repo .
```

The command finds the repository's test setup, runs a disposable red/green
rehearsal, and writes setup files. Commit those files, open one setup
pull request, then read one result on each normal code PR:

- **PASS** — ready to merge under the repository's current policy.
- **FAIL** — do not merge yet; required evidence contradicted the claim.
- **NOT CHECKED** — no merge decision; evidence did not run or could not be
  safely bound to the current commit.

A failed result is deliberately short:

```text
Agent Vigil: FAIL
Do not merge yet.
Reason: Reported test count does not match the isolated run.
Tests: claimed 184; observed 161
Fix: Run the configured test command again and report the observed count.
Reproduce: vigil verify --base <base-sha> --head <head-sha>
```

The full receipt keeps exact SHAs, policy hash, changed files, commands, claimed
and observed test counts, findings, and reproduction command.

## Current distribution boundary

v0.24.0 is a source release candidate until GitHub lists both the package and
checksum assets. It is merged to `main`, tagged, and staged through npm trusted
publishing with provenance. It is **not installable from npm** until a maintainer
approves the staged package with npm 2FA. npm still serves v0.21.1 until that
approval is completed.

GitHub release v0.23.2 is public and immutable.

The last verified GitHub release tarball is
[`sulmusic-agent-vigil-0.23.2.tgz`](https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz).
GitHub release v0.23.2 is public and immutable.
npm currently serves v0.21.1. Do not assume that `latest` points to the same
code on every channel. v0.24.0 can replace those versions only after npm,
GitHub Releases, the Marketplace listing, checksums, README, and Action pins
all identify the same commit.

The machine-readable channel record is in
[`docs/public-install-state.json`](docs/public-install-state.json).

For a no-account GitHub package install, checksum verification, or an explicit
non-Node runner, use the [installation guide](docs/INSTALL_WITHOUT_NPM_ACCOUNT.md).

## What it checks

The default protection path can verify:

- exact base and head commit identity;
- base-owned policy and workflow bytes;
- fresh tests in a candidate-only Docker boundary;
- claimed and observed test counts as separate facts;
- skipped, focused, xfailed, weakened, empty, patched, or self-fulfilling tests;
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
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz protect --repo . \
  --runner common \
  --test-cmd "python3 -m pytest -q"
```

Project dependencies must already be reproducible from the base-owned setup.
Tests run without network access. See the [compatibility table](docs/COMPATIBILITY.md)
and [hosted security contract](docs/HOSTED_SECURITY_CONTRACT.md).

## GitHub App and Marketplace boundary

The centrally operated App owns the check identity, supports `pull_request` and
`merge_group`, and keeps App keys and webhook secrets out of customer
repositories. A repository-owned Action is useful for trials, but a job name
alone is not a merge trust root.

Marketplace submission is not a code artifact. It still requires publisher/app
account authority, listing assets, and an actual submission action by an account
allowed to publish the App.

It is not a live public service until a real outside repository demonstrates PASS, FAIL, stale-head NOT CHECKED, required-check retention, and maintainer acceptance without first-party control.

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

`vigil help` shows the first-use commands. `vigil help --all` shows the advanced
receipt, authority, continuity, upgrade, certification, outcome, counterweight,
vault, blast-radius, taxonomy, and corpus commands.

## Evidence and limits

- [Receipt-product commands and authority boundaries](docs/RECEIPT_PRODUCT.md)
- [Frozen and comparative benchmarks](docs/BENCHMARKS.md)
- [Scoped competitor comparison](docs/COMPETITOR_COMPARISON.md)
- [Published failure corpus](proof/README.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Receipt format](docs/AI_CHANGE_RECEIPT.md)
- [Security policy](SECURITY.md)
- [Commercial proof gates](docs/COMMERCIAL_GATES.md)

This repository's runs prove first-party technical behavior. They do not prove
outside adoption, retained use, willingness to pay, revenue, auditor acceptance,
insurer acceptance, legal sufficiency, or universal superiority over competing
products.

## Contributing

Use a branch and pull request. Add an adversarial fixture for every corrected
false result and tie capability claims to an exact test, artifact, commit, or
public source. See [CONTRIBUTING.md](CONTRIBUTING.md).
