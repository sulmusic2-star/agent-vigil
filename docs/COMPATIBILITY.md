# Compatibility laboratory

Checked 2026-08-22. This file records executed proof, not a claim that every
possible project is supported.

## Generated-repository matrix

The durable test laboratory creates a fresh Git repository for each scenario,
runs a project-specific verification script through Agent Vigil, and checks both
an exact claim and an inflated claim. It covers 18 output families:

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

Current durable result: **80/80 compatibility scenarios pass**. Combined with
the core, CLI, adapter, setup, policy-anchor, signing, workspace-binding, and remediation suite,
The exact unreleased v0.13 test count is recorded after integration.

`npm run test:package` additionally installs the generated tarball into a
disposable consumer and exercises both standard and portable `init` plus
`doctor` flows across 11 repository shapes: plain Git, Node, Python, Rust, Go,
Maven, Gradle wrapper, Gradle build, Ruby, PHP, and .NET.

A deterministic fuzz layer adds 9,000 mutated runner, dotted-term, traversal, and structured-tool cases.

The Node coverage gate requires at least 90% lines, 80% branches, and 90%
functions. The exact unreleased v0.13 coverage run is recorded after
integration. Coverage percentages can move slightly with Node's experimental
coverage accounting; the thresholds are the durable claim.

Run it:

```bash
npx tsx --test test/compatibility.test.ts
npm test
npm run test:package
npm run lab:ecosystems -- --output /tmp/agent-vigil-ecosystem-lab.json
```

## Real-toolchain repositories

A second local run created seven independent repositories and invoked the actual
installed toolchains rather than replaying sample output:

| Repository shape | Command | Exact `3 tests` | Inflated `99 tests` | Portable receipt-only tail | Source change after receipt |
|---|---|---:|---:|---:|---:|
| Node / npm | inferred `npm test --silent` | PASS | FAIL | PASS | FAIL |
| Node / pnpm | `pnpm test --silent` | PASS | FAIL | PASS | FAIL |
| Python / pytest | inferred `python3 -m pytest -q` | PASS | FAIL | PASS | FAIL |
| Go | inferred `go test -json ./...` | PASS | FAIL | PASS | FAIL |
| Ruby / Minitest | `ruby test_example.rb` | PASS | FAIL | PASS | FAIL |
| Node monorepo | `npm --prefix packages/api test --silent` | PASS | FAIL | PASS | FAIL |
| .NET / MSTest | inferred `dotnet test` | PASS | FAIL | PASS | FAIL |

Result: **28/28 expected verdicts**. These were disposable repositories under
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
- v0.4 passed hosted Windows and macOS portability jobs on Node 22. The v0.5
  candidate's hosted result remains unverified until this branch is pushed and
  CI completes.
- Test execution runs repository code with the verifier's privileges.
