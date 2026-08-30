# Compatibility laboratory

This file separates the generated hosted contract from the broader local CLI.
It records completed local runs, not hosted CI, release, adoption,
payment, or revenue evidence.

## Source-suite snapshot

On 2026-08-29, the exact v0.22.0 release-candidate source ran the ordinary local
suite once. `npm test` executes **805 tests** in that snapshot: 792 passed and
13 opt-in or platform-specific tests skipped. Historical coverage percentages
belong to older, smaller suites and are not reused as current evidence. These
counts describe that exact local candidate run, not hosted CI, a published
release, adoption, payment, or revenue.

The durable generated-repository laboratory covers 18 output families:

- Node TAP and Node spec reporter;
- Jest, Vitest, Mocha, AVA, Playwright, Cypress, Bun;
- pytest;
- Cargo and Go `-json`;
- Maven Surefire and Gradle;
- RSpec and Minitest;
- PHPUnit;
- `dotnet test`.

It also covers nonzero commands, skipped-test accounting, malformed and unknown
JSONL, UTF-8 BOM input, Codex object-valued tool arguments, seven failure-output
forms, semantic tool-loop fingerprints, and documentation false positives.

A deterministic fuzz layer adds 9,000 mutated runner, dotted-term, traversal, and structured-tool cases.

The Node coverage gate requires at least 90% lines, 80% branches, and 90%
functions. Coverage percentages can move with Node's experimental accounting;
the thresholds, complete command output, and exact tested commit are the
release evidence.

## Generated hosted repository contract

The automatic path used by `init` and `protect` supports:

- a plain Git repository with no inferred non-Node hosted test toolchain; or
- a root Node/npm repository with one bounded direct `node --test` command in
  `scripts.test` or `agentVigil.hostedTestCommand`.

The hosted override does not allow an arbitrary shell command. A root npm lock
permits base-owned `npm ci --ignore-scripts` during the isolated setup phase.
Tests then run without network over a read-only source mount. Unsupported
toolchains, package managers, layouts, indirection, repository `.npmrc` files,
submodules, and unsafe setup inputs fail closed.

The source release candidate adds a second, explicit path for Python, Rust, Go,
Java, Ruby, PHP, .NET, pnpm, Yarn, and Bun. The operator supplies both a
digest-pinned container image and one command from the bounded direct-runner
grammar:

```bash
vigil protect --repo . \
  --runner common \
  --test-cmd "go test -json ./..."
```

The committed `.agent-vigil-runner.json` file is protected and compared against
the trusted base. A candidate cannot select a different image or command. The
image must contain the standard Node runtime used by the sandbox wrapper and
all test dependencies; custom setup and test-time network access are forbidden.
The exact image digest and test command appear in the retained harness evidence.

`--runner common` resolves to
`ghcr.io/sulmusic2-star/agent-vigil-runner@sha256:efdaa365db14cb8d64408beac91361ed0875111e4c07254e2b3729801df606a0`.
The image was built by the repository's hosted publication workflow with
provenance and an SBOM. `runners/common/Dockerfile` is its reviewed recipe.
Runtime policy accepts the immutable digest, never the recipe's moving tag.

`npm run test:package` installs the generated tarball into disposable consumers
and checks supported plain and root Node paths plus expected fail-closed
unsupported shapes. Treat each run's artifact and exit status as the evidence;
this page does not claim a pending integrated run has passed.

Run it:

```bash
npx tsx --test test/compatibility.test.ts
npm test
npm run test:package
npm run lab:ecosystems -- --output /tmp/agent-vigil-ecosystem-lab.json
```

## Real-toolchain repositories

The following 2026-08-24 historical local run created seven independent
repositories and invoked installed toolchains rather than replaying sample
output. It demonstrates the broader local CLI, not v0.21.2 hosted support:

| Repository shape | Command | Exact `3 tests` | Inflated `99 tests` | Portable receipt-only tail | Source change after receipt |
|---|---|---:|---:|---:|---:|
| Node / npm | inferred `npm test --silent` | PASS | FAIL | PASS | FAIL |
| Node / pnpm | `pnpm test --silent` | PASS | FAIL | PASS | FAIL |
| Python / pytest | inferred `python3 -m pytest -q` | PASS | FAIL | PASS | FAIL |
| Go | inferred `go test -json ./...` | PASS | FAIL | PASS | FAIL |
| Ruby / Minitest | `ruby test_example.rb` | PASS | FAIL | PASS | FAIL |
| Node monorepo | `npm --prefix packages/api test --silent` | PASS | FAIL | PASS | FAIL |
| .NET / MSTest | inferred `dotnet test` | PASS | FAIL | PASS | FAIL |

Historical result: **28/28 expected verdicts**. These were disposable repositories under
macOS using Node 22.22.3, Python 3.14.3 / pytest 9.0.3, Go 1.26.0, Ruby 2.6.10,
pnpm 10.29.3, and .NET SDK 7.0.101.

## Agent transcript adapters

The v0.6 candidate detects eight input shapes:

| Producer | Input contract | Local fixture |
|---|---|---:|
| Claude Code | JSONL messages, tool use, and tool results | pass |
| OpenAI Codex | rollout JSONL response items and tool outputs | pass |
| Cursor Agent CLI | documented stream-JSON events | pass |
| Gemini CLI | documented stream-JSON events | pass |
| GitHub Copilot CLI/SDK | documented persisted session events | pass |
| OpenCode | documented JSON session export | pass |
| Aider | documented `.aider.chat.history.md` | pass |
| Generic summary | Markdown or plain text | pass |

Malformed, mixed, and unknown JSON/JSONL continue to fail loudly. An accepted
adapter means the supplied export is structurally understood; it does not prove
that the producer exported a complete session.

## Defects found by the lab

The first v0.3 probe passed 19 of 38 cases and exposed 19 compatibility gaps:

- nine runner formats could not substantiate numeric claims;
- the same nine formats could not reject inflated counts;
- Codex object-valued tool input became `[object Object]` and produced a false
  contradiction.

The expanded lab then exposed a false hard failure when documentation mentioned
`npm test || true`. Self-dogfooding exposed another gap: untracked worktree
files appeared in the changed-path count but their contents were absent from the
integrity diff. Repairs now:

- parse the additional runner families and infer common Java, Ruby, PHP, .NET,
  and Go commands;
- serialize structured Codex inputs, recognize more command-failure forms, and
  strip sentence punctuation from run claims;
- normalize JSON tool arguments before loop fingerprints;
- reject malformed or unknown JSONL instead of silently choosing an adapter;
- exclude documentation from anti-bypass rules and restrict assertion-loss
  comparisons to test files.
- synthesize bounded text patches for untracked worktree files so local scans do
  not miss newly added bypasses or tests.

## Remaining boundaries

- Runner output formats can change. A sanitized failing output should become a
  regression fixture before support is claimed.
- Plain `go test` does not expose a reliable count. Automatic Go verification
  therefore uses `go test -json ./...`.
- Monorepos require an explicit command such as
  `npm --prefix packages/api test --silent`.
- Historical hosted portability does not establish current candidate isolation.
  The hosted lane requires a GitHub-hosted Linux runner and Docker.
- Local test execution runs repository code with the verifier process's host
  privileges. A detached worktree protects Git identity; it is not a sandbox.
- Generated hosted support is intentionally smaller than local parser and test
  ecosystem support. See the
  [hosted evidence security contract](HOSTED_SECURITY_CONTRACT.md).
