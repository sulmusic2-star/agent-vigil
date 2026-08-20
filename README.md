# Agent Vigil

[![CI](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml/badge.svg)](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](package.json)
[![No runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-0f766e.svg)](package.json)

**The agent said it was done. Agent Vigil asks for the receipt.**

Agent Vigil reconciles an AI coding agent's final claims with its transcript,
repository, selected Git range, and a fresh verification run. The verifier is
local and deterministic: no model grades another model, and missing evidence
does not become a green check.

```text
  ✗ [test-count] 99 tests
      evidence: claim says 99 tests; runner reported 42

  ✗ [file-changed] src/ghost/phantom.ts
      evidence: claimed as changed but does not exist

  ✓ [integrity-scan] no obvious verification weakening

  FAIL · sha256:c3128a2c6abc5f...
```

## The contract

| Status | Meaning | Exit |
|---|---|---:|
| **PASS** | The minimum objective evidence exists and no check contradicted the narrative. | `0` |
| **FAIL** | Repository or transcript evidence contradicts at least one claim. | `1` |
| **INCONCLUSIVE** | Evidence is absent, unparseable, or below policy. | `2` |

An empty transcript is **INCONCLUSIVE**. A clean diff alone cannot earn PASS.
If an agent claims 99 tests passed and the runner reports 42, the result is
**FAIL** even though the command exited zero.

## What v0.3 checks

- Claimed test success against a fresh test execution.
- Claimed test counts against TAP, Jest, pytest, and Cargo summaries.
- Claimed file changes against an explicit `base..head` range.
- Referenced paths without allowing traversal outside the repository.
- “I ran X” claims against a single matching Claude Code or Codex tool call.
- Three or more identical consecutive tool calls.
- Test-file deletion, shrinking test surfaces, new `.skip` / `.only`, assertion
  loss, compiler suppressions, verification bypasses, and coverage gates set to
  zero.
- Completion claims against objective evidence and unfinished-work markers.

Every run can emit a compact JSON receipt, Markdown, SARIF 2.1.0, and a GitHub
Step Summary. The receipt has a deterministic SHA-256 content identifier. It is
**not a cryptographic signature**; see the [threat model](docs/THREAT_MODEL.md).

## Run locally

Node 20 or newer is required.

```bash
git clone https://github.com/sulmusic2-star/agent-vigil
cd agent-vigil
npm ci
npm run build

node dist/cli.js /path/to/session.jsonl \
  --repo /path/to/repo \
  --base origin/main \
  --head HEAD \
  --strict
```

Try three planted failures without configuring a project:

```bash
node dist/cli.js demo
```

The demo catches a fabricated test count, a nonexistent changed file, and an
identical three-call tool loop. It exits zero only when all three planted
contradictions are caught.

Agent Vigil reads Claude Code JSONL, Codex rollout JSONL, and Markdown/plain-text
summaries. Transcript contents stay local.

## GitHub Action

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  - uses: sulmusic2-star/agent-vigil@main
    with:
      transcript: agent-session.jsonl
      repo: .
      base: ${{ github.event.pull_request.base.sha }}
      head: ${{ github.event.pull_request.head.sha }}
      strict: true
```

The Action runs the compiled verifier checked into this repository; it does not
depend on an npm package being available. It writes `agent-vigil-report.json`,
`agent-vigil.sarif`, and a readable job summary.

> **Trust boundary:** test commands execute repository code. Do not accept a
> `test-cmd` value from untrusted issue or pull-request text. Read
> [SECURITY.md](SECURITY.md) before running on untrusted forks.

## CLI

```text
vigil <transcript.jsonl|summary.md> [options]

--repo <path>          repository to verify
--base <sha>           baseline commit (default HEAD~1)
--head <sha>           head commit (default HEAD)
--test-cmd <command>   explicit verification command
--format <kind>        text | json | markdown | sarif
--output <path>        write full JSON receipt
--sarif <path>         also write SARIF
--github-summary       append Markdown to GITHUB_STEP_SUMMARY
--strict               unresolved claims produce INCONCLUSIVE
--min-verified <n>     objective-evidence floor (default 1)
```

## Why this shape

Developers repeatedly report agents declaring completion without a runnable
receipt, weakening tests to produce green, or looping on tools. Existing tools
cover pieces of this problem. Agent Vigil's narrow position is:

1. **Fail closed on missing evidence.**
2. **Compare the story with the trajectory and the selected repository state.**
3. **Detect common ways an agent can improve the scoreboard instead of the product.**
4. **Keep the hot path local, deterministic, small, and auditable.**

The source-linked complaint and competitor review is in
[docs/RESEARCH.md](docs/RESEARCH.md). Product limits are explicit in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Evidence on this repository

- 45 tests, including adversarial false-pass, empty-evidence, path traversal,
  tool-loop, test-count, skip, suppression, and cross-agent transcript cases.
- Linux CI on Node 20, 22, and 24.
- The GitHub Action dogfoods itself in CI.
- `npm pack --dry-run` is part of the build gate.
- Zero runtime dependencies.

## Contributing

The highest-value contribution is a small sanitized transcript that produces a
false PASS, false FAIL, or unexplained INCONCLUSIVE. Add it as a regression test
with the expected verdict. See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT.
