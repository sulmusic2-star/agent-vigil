# Agent Vigil

[![CI](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml/badge.svg)](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](package.json)
[![No runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-0f766e.svg)](package.json)

**The agent said it was done. Agent Vigil checks the receipt.**

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

## Two-minute setup

From the npm package after v0.5.0 is published:

```bash
npx agent-vigil@0.5.0 init
npx agent-vigil@0.5.0 doctor
```

`init` creates a small JSON policy, a privacy warning and transcript placeholder,
and a GitHub Actions workflow using the pull request's exact base and head SHAs.
It will not overwrite existing files unless `--force` is explicit. `doctor`
checks Node, Git, policy parsing, test-command inference, transcript adapter,
workflow installation, exact-SHA configuration, and base-anchored policy trust.

The generated workflow loads policy from the pull request's **base commit**. A
candidate change therefore cannot weaken its own gate merely by editing
`.agent-vigil.json`.
On pull-request events, the Action also rejects base, head, or policy-ref values
that disagree with GitHub's event payload.

## What v0.5 checks

- Claimed test success against a fresh test execution.
- Claimed test counts across 18 output families: Node/TAP, Jest, Vitest, pytest, Cargo, Go JSON, Maven, Gradle, RSpec, PHPUnit, .NET, Mocha, Bun, AVA, Playwright, Cypress, and Minitest.
- Claimed file changes against an explicit `base..head` range.
- Referenced paths without allowing traversal outside the repository.
- “I ran X” claims against a single matching Claude Code or Codex tool call.
- Three or more identical consecutive tool calls.
- Test-file deletion, shrinking test surfaces, new `.skip` / `.only`, assertion
  loss, compiler suppressions, verification bypasses, and coverage gates set to
  zero.
- Completion claims against objective evidence and unfinished-work markers.
- Exact-commit receipts against Git-visible workspace state; unbound files make
  the result INCONCLUSIVE instead of letting tests prove a different tree.
- Malformed or unknown JSON/JSONL fails loudly instead of silently selecting the wrong adapter.
- Semantically identical structured tool calls are normalized before loop detection.

Every run can emit a compact JSON receipt, Markdown, SARIF 2.1.0, and a GitHub
Step Summary. The receipt has a deterministic SHA-256 content identifier. It is
**not a cryptographic signature**; see the [threat model](docs/THREAT_MODEL.md).

## Run locally

Node 20 or newer is required. Until the npm registry release is live, run the
compiled GitHub package:

```bash
npx --yes github:sulmusic2-star/agent-vigil --help
```

Or work from source:

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

Agent Vigil automatically recognizes exported Claude Code JSONL, Codex rollout
JSONL, Cursor stream JSON, Gemini CLI stream JSON, GitHub Copilot CLI event
logs, OpenCode JSON exports, Aider chat history, and Markdown/plain-text
summaries. Transcript contents stay local.

## GitHub Action

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0
      ref: ${{ github.event.pull_request.head.sha }}

  - uses: sulmusic2-star/agent-vigil@v0.5.0
    with:
      transcript: agent-session.jsonl
      repo: .
      base: ${{ github.event.pull_request.base.sha }}
      head: ${{ github.event.pull_request.head.sha }}
      strict: true
```

For v0.5.0, add a base-anchored policy:

```yaml
      policy: .agent-vigil.json
      policy-ref: ${{ github.event.pull_request.base.sha }}
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
--policy <path>        policy JSON
--policy-ref <sha>     load policy from a trusted Git commit
--signing-key <path>   sign the receipt with an Ed25519 key
--github-summary       append Markdown to GITHUB_STEP_SUMMARY
--strict               unresolved claims produce INCONCLUSIVE
--min-verified <n>     objective-evidence floor (default 1)
```

Additional commands:

```text
vigil init [--repo <path>] [--force]
vigil doctor [--repo <path>]
vigil keygen --private <path> --public <path>
vigil verify <receipt.json> [--public-key <path>]
```

## Why this shape

Developers repeatedly report agents declaring completion without a runnable
receipt, weakening tests to produce green, or looping on tools. Existing tools
cover pieces of this problem. Agent Vigil's narrow position is:

1. **Fail closed on missing evidence.**
2. **Compare the story with the trajectory and the selected repository state.**
3. **Detect common ways an agent can improve the scoreboard instead of the product.**
4. **Keep the hot path local, deterministic, small, and auditable.**
5. **Anchor policy outside the candidate change.**

Agent Vigil is not another model reviewing a model. Its narrow advantage is the
combination of cross-agent transcript reconciliation, fresh test evidence,
explicit Git identity, and anti-reward-hacking checks in one deterministic gate.

The source-linked complaint and competitor review is in
[docs/RESEARCH.md](docs/RESEARCH.md). The executed compatibility matrix is in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). Product limits are explicit in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Evidence on this repository

- 162 tests, including 80 generated-repository compatibility scenarios across
  18 runner-output families, plus adversarial false-pass, path, transcript,
  tool-loop, test-count, skip, suppression, and adapter-drift cases.
- Seven real-toolchain repositories exercised Node/npm, pnpm, pytest, Go,
  Minitest, a Node monorepo, and .NET; all 14 exact/inflated verdicts matched.
- The packed tarball was installed as a consumer dependency, then `init` and
  `doctor` passed across 11 Git repository shapes from plain Git through Node,
  Python, Rust, Go, Maven, Gradle, Ruby, PHP, and .NET.
- Linux CI on Node 20, 22, and 24, plus Node 22 portability jobs on macOS
  and Windows.
- The GitHub Action dogfoods itself in CI.
- `npm pack --dry-run` is part of the build gate.
- Zero runtime dependencies.

The new adapter, setup, policy-anchor, receipt-signing, workspace-binding, and
remediation tests raise the suite above the v0.4 baseline.

## AI Change Receipt v2

Receipt schema v2 binds adapter identity, transcript digest, exact Git SHAs,
repository tree, canonical policy hash, rule evidence, final status, and a
reproduction command. Optional Ed25519 signing is supported. An embedded key is
self-asserted; use `--public-key` to pin identity through a trusted channel.

See [the receipt specification](docs/AI_CHANGE_RECEIPT.md),
[JSON Schema](docs/receipt-v2.schema.json), and [threat model](docs/THREAT_MODEL.md).
The hosted [organization control-plane design](docs/CONTROL_PLANE.md) and
[commercial proof gates](docs/COMMERCIAL_GATES.md) are deliberately marked as
future hypotheses, not deployed features.

## Contributing

The highest-value contribution is a small sanitized transcript that produces a
false PASS, false FAIL, or unexplained INCONCLUSIVE. Add it as a regression test
with the expected verdict. See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT.
