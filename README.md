# Agent Vigil

[![CI](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml/badge.svg)](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](package.json)
[![No runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-0f766e.svg)](package.json)

![Agent Vigil illustrative evidence-gate demo](docs/assets/agent-vigil-demo.gif)

**The agent said it was done. Agent Vigil checks the receipt.**

Agent Vigil reconciles an AI coding agent's final claims with its transcript,
repository, selected Git range, and a fresh verification run. The verifier is
local and deterministic: no model grades another model, and missing evidence
does not become a green check.

For maintainers who do not want agent transcripts, v0.8 includes a PR evidence
gate. It binds a named human to the GitHub event, enforces small-change policy,
and can run the candidate's changed regression test against both candidate and
base source. A test that passes on both sides is a **FAIL**, not proof.

Raw agent transcripts do not need to be committed to a pull request. The
portable-receipt lane reduces a local result to signed hashes, repository and
policy identity, summary counts, and a signer key ID. CI verifies the signer
against policy from the base branch and independently re-runs the trusted test
command in the clean checkout.

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

From the compiled GitHub package (npm remains a separate publication):

```bash
npx --yes github:sulmusic2-star/agent-vigil init
npx --yes github:sulmusic2-star/agent-vigil doctor
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

Maintainer profile:

```bash
npx --yes github:sulmusic2-star/agent-vigil init --profile maintainer
```

This creates a PR declaration template, base-anchored file/line/test/protected-
path limits, an isolated base-fail/head-pass differential test, and a workflow
that retains the JSON receipt as a 30-day GitHub artifact. Review the generated
commands and limits before merging the setup.

See the [two-minute installation page](https://sulmusic2-star.github.io/agent-vigil/)
and the [three-case public failure corpus](proof/README.md). The corpus records
first-party dogfood failures with exact revisions, corrections, negative
controls, and limits; it is kept separate from external-adoption totals.

## What v0.8 checks

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
- PR author responsibility, review/maintenance declarations, AI-assistance
  disclosure, and linked-issue syntax without pretending declarations prove
  understanding or issue approval.
- Base-anchored changed-file, changed-line, test-path, and protected-path policy.
- Isolated differential verification: overlay the candidate's changed test
  artifacts onto base source, require the command to fail there, and require it
  to pass on the candidate. Optional setup, timeout, and expected base-failure
  pattern are controlled by policy from the base commit.

Every run can emit a compact JSON receipt, Markdown, SARIF 2.1.0, and a GitHub
Step Summary. The receipt has a deterministic SHA-256 content identifier. It is
**not a cryptographic signature**; see the [threat model](docs/THREAT_MODEL.md).

## Keep the raw transcript out of Git and CI

The optional portable-receipt gate separates private local reconciliation from
independent CI verification:

```bash
vigil keygen --private ~/.config/agent-vigil/operator.pem \
  --public ~/.config/agent-vigil/operator.pub

vigil /private/path/session.jsonl \
  --repo . --base "$BASE_SHA" --head "$(git rev-parse HEAD)" \
  --policy .agent-vigil.json --policy-ref "$BASE_SHA" \
  --signing-key ~/.config/agent-vigil/operator.pem \
  --portable-output .agent-vigil/receipt.json --strict

git add .agent-vigil/receipt.json
git commit -m "chore: attach Agent Vigil receipt"
```

The base-branch policy pins the signer and receipt path:

```json
{
  "schemaVersion": 1,
  "testCommand": "npm test --silent",
  "strict": true,
  "minVerified": 1,
  "portableReceipt": ".agent-vigil/receipt.json",
  "trustedSignerKeyIds": ["sha256:<key-id-printed-by-vigil-keygen>"]
}
```

Use `receipt:` instead of `transcript:` in the Action. Agent Vigil permits the
signed code commit to equal the PR head, or to be followed only by changes to
the base-policy-controlled receipt path. Any later source change invalidates
the receipt. See the [complete operator guide](docs/PRIVATE_RECEIPT_GATE.md).

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
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
      ref: ${{ github.event.pull_request.head.sha }}

  - uses: sulmusic2-star/agent-vigil@v0.8.0
    with:
      transcript: agent-session.jsonl
      repo: .
      base: ${{ github.event.pull_request.base.sha }}
      head: ${{ github.event.pull_request.head.sha }}
      strict: true
```

Add a base-anchored policy:

```yaml
      policy: .agent-vigil.json
      policy-ref: ${{ github.event.pull_request.base.sha }}
```

Portable mode uses the same exact GitHub event identity and base-anchored
policy:

```yaml
      receipt: .agent-vigil/receipt.json
      policy: .agent-vigil.json
      policy-ref: ${{ github.event.pull_request.base.sha }}
```

Maintainer mode needs no transcript:

```yaml
  - id: vigil
    uses: sulmusic2-star/agent-vigil@v0.8.0
    with:
      mode: maintainer
      policy: .agent-vigil.json
      policy-ref: ${{ github.event.pull_request.base.sha }}
      repo: .
      base: ${{ github.event.pull_request.base.sha }}
      head: ${{ github.event.pull_request.head.sha }}
```

Use the generated PR template. Agent Vigil reads the event payload, never
executes PR body text, and rejects event/base/head mismatches.

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
vigil init --profile maintainer [--repo <path>] [--force]
vigil doctor [--repo <path>]
vigil keygen --private <path> --public <path>
vigil verify <receipt.json> [--public-key <path>]
vigil gate <portable-receipt.json> [--repo . --base <sha> --head <sha>]
vigil maintainer --event <event.json> [--repo . --base <sha> --head <sha>]
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
6. **Make regression tests prove they catch the old behavior.**

Agent Vigil is not another model reviewing a model. Its narrow advantage is the
combination of cross-agent transcript reconciliation, fresh test evidence,
explicit Git identity, and anti-reward-hacking checks in one deterministic gate.

The source-linked complaint and competitor review is in
[docs/RESEARCH.md](docs/RESEARCH.md). The executed compatibility matrix is in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). Product limits are explicit in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

Public adoption is measured under a separate
[evidence contract](docs/ADOPTION_EVIDENCE.md). A catalog entry, clone, or code
search hit is not counted as an adopter or receipt. The public
[adopter ledger](ADOPTERS.md) starts empty rather than manufacturing traction.

## Evidence on this repository

- 205 tests, including 80 generated-repository compatibility scenarios across
  18 runner-output families, plus adversarial false-pass, path, transcript,
  tool-loop, test-count, skip, suppression, adapter-drift, maintainer-attestation,
  scope-budget, symlink, forged-event, and differential-regression cases.
- Seven real-toolchain repositories exercised Node/npm, pnpm, pytest, Go,
  Minitest, a Node monorepo, and .NET; all 28 exact, inflated, portable-gate,
  and post-receipt-invalidation verdicts matched.
- The packed tarball was installed as a consumer dependency, then standard and
  portable `init` / `doctor` flows passed across 11 Git repository shapes from
  plain Git through Node, Python, Rust, Go, Maven, Gradle, Ruby, PHP, and .NET.
- Linux CI on Node 20, 22, and 24, plus Node 22 portability jobs on macOS
  and Windows.
- The GitHub Action dogfoods itself in CI.
- `npm pack --dry-run` is part of the build gate.
- JSON, SARIF, and job-summary outputs reject symlinks and non-regular targets,
  then use private `0600` same-directory temporary files and atomic replacement.
- Zero runtime dependencies.

The adapter, setup, policy-anchor, receipt-signing, workspace-binding,
maintainer-evidence, remediation, and safe-output tests raise the suite above
the v0.4 baseline.

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

Portable receipt v1 is intentionally smaller than the full change receipt. It
does not include transcript text, claim quotes, paths, or detailed rule
evidence. Its signature proves only that the key signed the compact payload.
CI adds independent policy-command and integrity evidence; neither layer proves
semantic correctness. See [the schema](docs/portable-receipt-v1.schema.json).

## Contributing

The highest-value contribution is a small sanitized transcript that produces a
false PASS, false FAIL, or unexplained INCONCLUSIVE. Add it as a regression test
with the expected verdict. See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT.
