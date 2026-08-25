# Agent Vigil

[![CI](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml/badge.svg)](https://github.com/sulmusic2-star/agent-vigil/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](package.json)
[![No runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-0f766e.svg)](package.json)

![Agent Vigil illustrative evidence-gate demo](docs/assets/agent-vigil-demo.gif)

**Require evidence before an AI-made change can merge.**

## No-workflow-change PR receipt

Paste a public GitHub pull-request URL to receive a normalized, optionally
signed lifecycle receipt without opening a pull request, installing a GitHub
Action, or changing the target repository:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.20.0/sulmusic-agent-vigil-0.20.0.tgz pr-receipt \
  https://github.com/OWNER/REPOSITORY/pull/123 \
  --tool-ref <reviewed-full-Agent-Vigil-commit> \
  --signing-key operator-private.pem \
  --output pr-123.receipt.json

npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.20.0/sulmusic-agent-vigil-0.20.0.tgz pr-receipt verify pr-123.receipt.json
```

The command makes read-only requests to `api.github.com` for pull-request,
review, check-run, and commit-status metadata. It does not request source code,
send request bodies, or retain prompts, transcripts, logs, review text, or the
GitHub token. The target repository grants no permission and receives no
workflow commit.

`CURRENT`, `HOLD`, `EXPIRED`, and `REVOKED` describe the selected public
evidence at the observation time. The receipt always says that a protected
action is **not authorized**: observing that checks ran is not proof that those
checks were sufficient. See the precise
[public PR receipt boundary](docs/PUBLIC_PR_RECEIPT.md).
Self-serve trial reports have a dedicated
[public receipt feedback form](https://github.com/sulmusic2-star/agent-vigil/issues/new?template=public-pr-receipt-feedback.yml).

Agent Vigil checks an exact code change against the task, policy, tests, and
recorded tool actions behind it. It returns **PASS**, **FAIL**, or
**INCONCLUSIVE**. Missing evidence never becomes a green check.

The verifier runs locally or through the generated hosted lane. Local commands
run with the operator process's host privileges; a detached worktree is not a
sandbox. The hosted lane uses a base-selected `pull_request_target` workflow and
runs candidate setup and tests in credential-free Linux Docker. It does not use
another model to judge the work. Maintainers can use PR evidence without
sharing an agent transcript or making a human-review declaration. A trusted
base policy runs repeatable checks, enforces change limits, and can prove that a
regression test fails on old code and passes on proposed code. A test that
passes on both sides is not proof of a fix.

Raw agent transcripts do not need to be committed to a pull request. The
portable-receipt lane reduces a local result to signed hashes, repository and
policy identity, summary counts, and a signer key ID. CI verifies the signer
against policy from the base branch and independently re-runs the trusted test
command in the clean checkout.

The `vigil plan` command compares two exact Git revisions and
shows semantic expansions and contractions in repository-declared MCP, Claude
Code, and Codex authority:

```bash
vigil plan --base origin/main --head HEAD
```

It uses control-specific partial orders rather than a security score. New MCP
servers, pre-authorized tools, writable roots, network reach, credential reach,
hooks, removed denies, and weaker sandbox or approval boundaries block.
Unsupported or incomparable changes return `HOLD`. The current scope does not
claim live tools, managed settings, runtime behavior, provider-side grants, or
effective credentials. See the [Agent Authority Plan contract](docs/AUTHORITY_PLAN.md).

`vigil proof-comment` turns an intact full receipt into one deterministic,
aggregate-only pull-request comment with a stable update marker. It reports the
exact change and measured evidence counts without copying raw evidence,
commands, paths, transcripts, or test output. See the
[proof-comment contract](docs/PROOF_COMMENT.md).

`vigil compare` checks two full receipts. It fails on weakened
policy, tampered content, lost signer continuity, new contradictions, and
disappearing invariant checks. It reports new advisories separately instead of
silently turning them into blockers.

A short-lived authority contract can
declare allowed change paths and action classes before work starts. Agent Vigil
then compares that base-anchored contract with the exact Git result and observed
tool trajectory. An unauthorized push, release, deployment, external write,
dependency installation, destructive command, or task creation is a FAIL;
ambiguous or incomplete action evidence is INCONCLUSIVE.

`vigil value` binds a valid receipt to
observed Codex or Claude Code usage, attributed cost and budget, maintainer
disposition, review duration, and downstream outcome. The resulting Agent Value
Card is `POSITIVE`, `NEGATIVE`, or `INCONCLUSIVE` and can be rendered as a
private standalone HTML file. See the
[Agent Value Card contract](docs/AGENT_VALUE_CARD.md) and the clearly labeled
[synthetic HTML demonstration](docs/assets/agent-value-card-demo.html).

Agent Vigil also includes a normalized
[GitHub outcome-evidence bundle](docs/GITHUB_OUTCOME_EVIDENCE.md), completed-run
retention of Value Cards, exact repeated-action and spend-without-observed-
progress controls, and
[task-matched local comparisons](docs/VALUE_COMPARISONS.md) with sample gates
and 95% Wilson intervals.
[Open the clearly labeled synthetic comparison rendering](docs/assets/agent-value-comparison-demo.html).

The CLI can prepare and verify the legacy full-receipt GitHub/Sigstore
predicate. Candidate-executing generated workflows cannot sign receipts in
v0.20.0. Signing authority must live in a separately controlled job that never
executes candidate code. Scheduled Control Proof signing remains separate and
uses only planted non-candidate challenges. See
[attestation boundaries](docs/ATTESTED_RECEIPTS.md).

Version 0.13 adds **Agent Upgrade Guard**, a local behavioral
preflight for already-materialized coding-agent plugin, skill, MCP, hook, or
configuration bundle updates. It compares exact current and candidate artifact
trees with repeated private canaries inside a digest-pinned, network-disabled,
read-only Docker runner after rejecting endpoints that are not Unix sockets or
Windows named pipes. Each trial has an unpredictable container name; after
completion or timeout, the exact name must be verified absent. The result is
`SAFE`, `CHANGED`, or `HOLD`; `SAFE` means only that these exact canaries
detected no material change under the recorded runner. The default template
deliberately cannot earn `SAFE`.

Upgrade Guard can write a private nonce-bound receipt and, only when explicitly
requested with an Ed25519 key, a privacy-minimized public compatibility entry.
Private canary labels become receipt-specific nonce-blinded pseudonyms unless
the operator supplies an explicit public label. The selected Docker client,
daemon, and local transport remain trusted: a local socket can proxy a remote
daemon. One check pins its selected endpoint across Docker calls and compares
the configuration at entry and after trials, but these bounded checks do not
prove physical daemon locality or continuous immutability against same-host ABA
or privileged races. Private and public v1 evidence records the successful
local-transport binding as a boolean without disclosing the endpoint path.
It does not install an update, upload evidence, modify the GitHub Action, or
claim live model/provider behavior. See the precise
[Upgrade Guard contract](docs/UPGRADE_GUARD.md).

It also adds the one-command protection profile:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.20.0/sulmusic-agent-vigil-0.20.0.tgz \
  protect --action-sha <reviewed-full-commit>
```

`protect` inspects the repository, prepares a base-selected exact-SHA
pull-request workflow, anchors policy to the base commit, and prepares a
completed-run outcome snapshot. Existing files are kept unless `--force` is
explicit. Generated hosted execution supports plain repositories and root
Node/npm repositories with a bounded direct `node --test` command; unsupported
hosted shapes fail closed. The generated policy uses the calibrated Test
Integrity Guard: direct test weakening blocks, while broader static suspicions
remain visible advisories.

The guard can also be run by itself:

```bash
vigil test-integrity --base <base-sha> --head <head-sha>
```

It blocks new focused or skipped tests, verification bypasses, lowered coverage
gates, reduced test counts, empty tests, discarded or unreachable assertions,
new pytest collection exclusions, constant/self-equal assertions, and hidden
Unicode controls. Distinctive returns that match unchanged test expectations,
lookalike dependency names, out-of-base-history reads, mixed-script identifiers,
browser-side runtime patching, new coverage exclusions, relaxed assertions, and
self-fulfilling mocks remain reviewable advisories unless a repository deliberately
chooses full blocking mode. The default check stays offline and never executes
candidate source as detector input. See the
[full rule and limit description](docs/TEST_INTEGRITY_GUARD.md).

Version 0.14 adds **Agent Authority Plan**:

```bash
vigil plan --base origin/main --head HEAD
```

It compares repository-owned MCP, Cursor, VS Code, Claude Code, and Codex configuration at the
exact base and head commits. New servers, hosts, tool grants, secret references,
writable paths, hooks, weaker approval or sandbox settings, and mutable model
aliases block by default. Unknown changed settings return `INCONCLUSIVE`.
Exceptions are exact and must already exist in the base revision, so a
candidate cannot approve its own new authority. The `protect` workflow includes
the same check in pull-request evidence. See
[Agent Authority Plan](docs/AUTHORITY_PLAN.md).

You can challenge the installed controls before relying on them:

```bash
vigil prove --repo . --base HEAD
```

`prove` makes a disposable local clone and plants safe examples of an
unapproved MCP server, candidate self-approval, an unreadable authority file,
a weaker sandbox, and a skipped test. It returns `PASS` only when every planted
case produces the expected result and the temporary clone is removed. It does
not change or push the source repository. See [Control Proof](docs/CONTROL_PROOF.md).

Install a scheduled, keyless GitHub proof with one command:

```bash
vigil certify install-action --repo . --action-ref <reviewed-full-Agent-Vigil-commit>
```

The generated workflow pins Agent Vigil and its supporting Actions to full
commits and runs from the default branch every Monday. Its first job creates an
unsigned proof and privacy-reduced predicate without OIDC. A separate job with
no repository checkout accepts only that bounded two-file artifact, validates
the proof-to-predicate binding, and then uses GitHub OIDC to sign the exact
proof. The proof plus attestation bundle is retained for 90 days. There is no
manual, pull-request, or candidate-selected trigger and no repository signing
secret or long-lived signing key. Verification binds the proof file, its
content hash, exact source commit, repository, signer workflow, and optional
signer-workflow commit.

Retain those results in a chained corpus and answer whether every policy-listed
repository has passed its required challenges within seven days:

```bash
vigil certify record control-proof.json --organization acme --repository acme/api --required-check "Agent Vigil evidence" --output certificate.json
vigil certify add certificate.json --corpus control-corpus.jsonl
vigil certify policy --organization acme --repository acme/api --required-check "Agent Vigil evidence" --pack authority --output control-policy.json
vigil certify status --corpus control-corpus.jsonl --policy control-policy.json
```

Controls that can produce the public signed challenge format can join the same
corpus without an Agent Vigil-specific adapter:

```bash
vigil certify sign proof-payload.json --private-key provider-private.pem --output signed-proof.json
vigil certify record-signed signed-proof.json --public-key provider-public.pem --organization acme --repository acme/api --required-check "Required AI control" --output signed-certificate.json
vigil certify add signed-certificate.json --corpus control-corpus.jsonl
```

The V2 control identity includes the exact Ed25519 key ID. Put that full value,
`vendor/product@sha256:...`, in the policy's `allowedControls` list. Replacing a
self-asserted key therefore produces a different identity and a `HOLD`. The
signature proves file integrity and signer possession; it does not establish
that a proprietary detector's underlying evidence is true. A policy entry
declares that a check is required; it does not prove that GitHub branch
protection currently enforces that requirement.

The design is tied to a dated ledger of
[50 primary user reports](docs/research/2026-08-23-user-pain-ledger.md) covering
false completion, test manipulation, loops and cost, environment drift,
permissions, review state, and outcome evidence. A report proves that a user
described the problem; it does not establish the root cause or prevalence. The
[competitive position](docs/research/2026-08-23-competitive-position.md)
records direct overlaps and the narrower evidence-chain product boundary.

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

Until the npm registry package is current, use the verified GitHub release package:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.20.0/sulmusic-agent-vigil-0.20.0.tgz \
  init --action-sha <reviewed-full-commit>

npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.20.0/sulmusic-agent-vigil-0.20.0.tgz \
  doctor
```

`--action-sha` must name one reviewed lowercase 40-hex Agent Vigil commit.
`init` prepares a small JSON policy, a privacy warning, an evidence placeholder,
and two exact-pin workflows. It does not prove that the files were committed,
made required, or adopted. Existing files are kept unless `--force` is
explicit.

The evidence workflow is base-selected through `pull_request_target`. It loads
policy from the pull-request base, checks out the exact head without persisted
credentials, and runs candidate setup and tests only in the credential-free
Linux Docker lane. The generated hosted lane supports plain repositories and
root Node/npm repositories with one bounded direct `node --test` command.
Other ecosystems fail closed; use the broader local CLI with the understanding
that local commands are host execution, not sandboxing.

Candidate receipt attestation is disabled: `init --attest` and
`protect --attest` fail closed. Keyless signing remains available only to the
separate Control Proof workflow, which executes planted non-candidate
challenges. See [attestation boundaries](docs/ATTESTED_RECEIPTS.md).

The generated pull-request evidence is not enforceable by requiring its job
name alone. GitHub's plain status-check selection does not bind workflow and
event identity. Use an external required-workflow ruleset or GitHub App
exact-head check, including for merge queues. See the
[hosted security contract](docs/HOSTED_SECURITY_CONTRACT.md).

Maintainer profile:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.20.0/sulmusic-agent-vigil-0.20.0.tgz \
  init --profile maintainer --action-sha <reviewed-full-commit>
```

This creates base-anchored file, line, test, and protected-path limits; an
isolated base-fail/head-pass differential test; and an automated review policy
that reruns trusted commands against the exact candidate commit. The workflow
retains the JSON receipt as a 30-day GitHub artifact. It does not ask anyone to
check a box claiming they reviewed or understand the code. Review the generated
commands and limits before merging the setup.

Authority profile:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.20.0/sulmusic-agent-vigil-0.20.0.tgz \
  init --profile authority --action-sha <reviewed-full-commit>
```

Review the generated task ID, expiry, paths, and action classes, then merge the
contract before the code change. See [task-scoped authority reconciliation](docs/AUTHORITY_RECONCILIATION.md).

See the [two-minute installation page](https://sulmusic2-star.github.io/agent-vigil/)
and the [three-case public failure corpus](proof/README.md). The corpus records
failures found while using Agent Vigil on its own releases. Each record includes
exact revisions, corrections, negative controls, and limits. These records are
kept separate from external-adoption totals.

## What it checks

- Claimed test success against a fresh test execution.
- Claimed test counts across 18 output families: Node/TAP, Jest, Vitest, pytest, Cargo, Go JSON, Maven, Gradle, RSpec, PHPUnit, .NET, Mocha, Bun, AVA, Playwright, Cypress, and Minitest.
- Claimed file changes against an explicit `base..head` range.
- Referenced paths without allowing traversal outside the repository.
- “I ran X” claims against a single matching Claude Code or Codex tool call.
- Three or more identical consecutive tool calls.
- Test-file deletion, shrinking test surfaces, new `.skip` / `.only`, assertion
  loss or relaxation, compiler suppressions, verification bypasses, zeroed
  coverage gates, swallowed errors, discarded exception context, dead branches,
  stale refactor callers, self-fulfilling mocks, and behaviorally empty edits.
- Completion claims against objective evidence and unfinished-work markers.
- Exact-commit receipts against Git-visible workspace state; unbound files make
  the result INCONCLUSIVE instead of letting tests prove a different tree.
- Malformed or unknown JSON/JSONL fails loudly instead of silently selecting the wrong adapter.
- Semantically identical structured tool calls are normalized before loop detection.
- Either explicit human declarations or isolated automated review commands,
  selected by the trusted base policy; plus AI-assistance disclosure and
  linked-issue syntax without pretending automated evidence proves
  understanding or issue approval.
- Base-anchored changed-file, changed-line, test-path, and protected-path policy.
- Isolated differential verification: overlay the candidate's changed test
  artifacts onto base source, require the command to fail there, and require it
  to pass on the candidate. Optional setup, timeout, and expected base-failure
  pattern are controlled by policy from the base commit.
- Base-anchored task authority: exact changed-path allow/deny rules, short-lived
  validity, observed action classification, and terminal tool-result
  evidence across supported transcript adapters.
- Exact-base/exact-head authority planning for repository-owned MCP, Claude
  Code, and Codex settings, with value-bound base-policy exceptions and
  fail-closed handling for unknown changed fields.

Every run can emit a compact JSON receipt, Markdown, SARIF 2.1.0, and a GitHub
Step Summary. The receipt has a deterministic SHA-256 content identifier. It is
**not a cryptographic signature**; see the [threat model](docs/THREAT_MODEL.md).

Static integrity rules are **advisory by default** because calibration on 232
presumed-clean merged PRs produced findings on 99 PRs. Those findings remain
receipt-bound and appear as SARIF warnings, but they do not silently turn a
useful evidence check into a noisy merge blocker. Teams that have calibrated
the rules for their repositories can opt into blocking mode:

```json
{
  "schemaVersion": 1,
  "integrityMode": "blocking"
}
```

Missing inputs, malformed diffs, mismatched Git identity, failed fresh tests,
and verified narrative contradictions still fail closed.

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
the receipt. See the [operator guide](docs/PRIVATE_RECEIPT_GATE.md).

## Run locally

Node 20 or newer is required. Run the published npm package without installing
it globally:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.20.0/sulmusic-agent-vigil-0.20.0.tgz --help
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

This local command executes any selected setup, test, or review command with
the current process's host privileges. The Git checkout binding is not a
process, filesystem, credential, descendant-process, or network sandbox.

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

Audit a diff without checking out or executing the candidate repository:

```bash
git diff origin/main...HEAD > change.diff
vigil audit change.diff                 # findings are receipt-bound advisories
vigil audit change.diff --strict        # findings block with FAIL
```

Malformed input remains INCONCLUSIVE in either mode.

Compare two receipt revisions without trusting either narrative:

```bash
vigil compare before-receipt.json after-receipt.json
vigil compare before-receipt.json after-receipt.json --format json --output receipt-delta.json
```

The delta is PASS only for related Git ranges under the same policy with no
evidence regression. Policy changes or unrelated ranges are INCONCLUSIVE;
tampering, weaker policy, lost signatures, new contradictions, and lost
invariant controls are FAIL. See [the receipt-delta contract](docs/RECEIPT_DELTAS.md).

Create a local Agent Value Card without uploading the transcript or billing
artifact:

```bash
vigil value agent-vigil-report.json \
  --transcript /private/path/session.jsonl \
  --cost-usd 1.25 --cost-source provider-billed \
  --cost-evidence /private/path/provider-export.csv \
  --budget-usd 2.00 --review-minutes 7 \
  --disposition accepted --review-evidence /private/path/review.json \
  --outcome merged --outcome-evidence /private/path/merge.json \
  --format html --output agent-value-card.html
```

The command exits `0` only for positive value evidence, `1` for negative value
evidence, and `2` when evidence is incomplete or an input is invalid. Token
counts never become a fabricated dollar estimate; cost requires explicit
provenance. `POSITIVE` also requires hashed cost evidence plus hashed evidence
for an accepted disposition or merged outcome. A hash proves artifact identity,
not that the artifact's contents are correct.

Normalize official GitHub evidence, then compare retained cards without a
hosted account:

```bash
vigil github-evidence --event event.json \
  --pull-request pull.json --reviews reviews.json \
  --actions-run run.json --actions-jobs jobs.json \
  --output agent-vigil-github-evidence.json

vigil compare-value cards/*.json \
  --format html --output agent-value-comparison.html
```

GitHub evidence records PR lifecycle, latest reviewer states, review-comment
count, merge state, explicit revert/hotfix/incident markers, and final
Actions elapsed time. It does not infer incidents from prose or convert runner
minutes into fabricated billed USD.

## GitHub Action

Generate the workflow with `init` or `protect` and an independently reviewed
Agent Vigil commit. Do not replace its immutable references with tags. The
trust-critical shape is:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read
  pull-requests: read

steps:
  - uses: actions/checkout@<reviewed-full-checkout-commit>
    with:
      fetch-depth: 0
      ref: ${{ github.event.pull_request.head.sha }}
      persist-credentials: false
      allow-unsafe-pr-checkout: true

  - uses: sulmusic2-star/agent-vigil@<reviewed-full-commit>
    with:
      transcript: .agent-vigil/session.md
      policy: .agent-vigil.json
      policy-ref: ${{ github.event.pull_request.base.sha }}
      repo: .
      base: ${{ github.event.pull_request.base.sha }}
      head: ${{ github.event.pull_request.head.sha }}
      isolate-candidate: true
```

The exact generated file also pins Node setup and artifact upload Actions. It
validates the immutable event snapshot, verifies the Action is outside the
candidate workspace, and creates a private exact-commit clone. A root npm
repository may run base-owned `npm ci --ignore-scripts` with network during
setup. Candidate tests use a read-only source mount with no network. The job
passes no GitHub token, OIDC authority, signing permission, or write permission
to candidate verification.

The generated maintainer profile uses `reviewMode: "automated"`. Its setup and
review commands come from the base commit, run in the candidate-only Docker
boundary against the exact SHA, and fail on command failure, timeout, mutation,
or identity drift. Agent Vigil never executes PR body text. Repositories that
need named human declarations can set `reviewMode: "human"` instead.

```json
{
  "maintainer": {
    "reviewMode": "automated",
    "requireHumanAttestation": false,
    "automatedReview": {
      "setupCommand": "npm ci --ignore-scripts",
      "commands": ["npm test --silent"],
      "timeoutSeconds": 300
    }
  }
}
```

Automated review is reproducible technical evidence. It is not a statement that
a person understands the change, and it cannot replace legal, product, or
security approval when those decisions actually require a person.

Authority mode adds these base-anchored inputs to transcript mode:

```yaml
      transcript: agent-session.jsonl
      authority-contract: .agent-vigil-authority.json
      authority-contract-ref: ${{ github.event.pull_request.base.sha }}
```

The Action runs the compiled verifier checked into this repository; it does not
depend on an npm package being available. It writes `agent-vigil-report.json`,
`agent-vigil.sarif`, `agent-vigil-github-evidence.json`,
`agent-vigil-value-card.json`, and a readable job summary. The composite outputs
expose `status`, `receipt-hash`, `report`, `sarif`, `github-evidence`, and
`value-card`; `value-verdict` exposes `POSITIVE`, `NEGATIVE`, or `INCONCLUSIVE`.
Candidate receipt attestation is disabled. Control Proof attestation is a
separate non-candidate mode.

`init` also prepares a read-only outcome workflow. It handles only the completed
evidence `workflow_run`, downloads that exact run's receipt, and records the
Actions and pull-request state visible then without executing candidate code.
It does not claim later close, merge, revert, incident, payment, or revenue
observation.

A plain required status check does not bind the job name to this workflow and
event. An enforceable control needs an external required-workflow ruleset or
GitHub App exact-head check. Repository-owned `merge_group` generation is
disabled; an external trust source must cover merge queues. Read the
[hosted security contract](docs/HOSTED_SECURITY_CONTRACT.md),
[merge-queue boundary](docs/MERGE_QUEUES.md), and
[SECURITY.md](SECURITY.md).

## Continuity after the first green check

`vigil continuity` keeps the original result and records what happens later.
A verified merge can make the change `CURRENT`. A revert or explicitly linked
incident can make it `REVOKED`. A later ordinary green check cannot erase that
revocation; independent signed repair evidence can close it. Only `CURRENT`
permits a protected action.

To see that behavior without supplying a repository, key, or webhook, fork this
repository and manually run **Agent Vigil continuity lab** in GitHub Actions.
The revert deployment job is skipped; the independently repaired job runs. The
lab uses synthetic evidence and never deploys software. See the
[`Continuity Lab`](docs/CONTINUITY_LAB.md) for the exact expected result.

```bash
vigil continuity demo
vigil continuity init agent-vigil-report.json --output .agent-vigil/continuity
vigil continuity import-github \
  --chain .agent-vigil/continuity \
  --event webhook-body.json \
  --delivery-id <github-delivery-uuid> \
  --webhook-signature <github-sha256-signature> \
  --webhook-secret-file webhook-secret.txt
vigil continuity import-github-actions \
  --chain .agent-vigil/continuity \
  --signing-key "$RUNNER_TEMP/outcome-recorder.pem"
vigil continuity status \
  --chain .agent-vigil/continuity \
  --policy .agent-vigil-continuity.json \
  --repo . \
  --policy-ref <base-commit-sha> \
  --expected-head <reviewed-head-sha> \
  --environment production
```

The importer accepts authenticated GitHub webhook files for merges, exact
reverts, labeled hotfixes, and explicitly linked incidents. It stores hashes
and fixed categories instead of the webhook body or repository name. Repeated
delivery IDs are safe to retry. An invalid signature, malformed event,
repository mismatch, missing observation, or observer outage never becomes
`CURRENT`.

`vigil continuity install-action --repo . --action-ref <full-commit-sha> --self-serve`
creates a separate exact-commit deployment check and a manual, harmless lab.
The production check starts with no trusted keys and contains no real
deployment command. The repository owner must review the files, add approved
key IDs, arrange upload of the continuity artifact, and replace the clearly
marked deployment placeholder. There is no hosted collector, crawler, or
GitHub App in this version. See
[`docs/CONTINUITY.md`](docs/CONTINUITY.md) for the operator guide and
security limits.

## CLI

```text
vigil <transcript.jsonl|summary.md> [options]
vigil authority init [--output <path>]
vigil authority <transcript.jsonl> --contract <authority.json> --contract-ref <sha> [options]

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
vigil init --action-sha <40-hex> [--repo <path>] [--force]
vigil init --profile maintainer --action-sha <40-hex> [--repo <path>] [--force]
vigil init --profile authority --action-sha <40-hex> [--repo <path>] [--force]
vigil init --portable --public-key <path> --action-sha <40-hex> [--repo <path>] [--force]
vigil protect --action-sha <40-hex> [--repo <path>] [--force]
vigil doctor [--repo <path>]
vigil keygen --private <path> --public <path>
vigil verify <receipt.json> [--public-key <path>]
vigil attest <receipt.json> --predicate-output <path>
vigil verify-attestation <receipt.json> --repository <owner/name> [--signer-workflow <path>]
vigil notary <receipt.json> --repository <owner/name> --head <sha> --policy-sha256 <digest> [--signer-workflow <path>]
vigil compare <before-receipt.json> <after-receipt.json> [--format text|json]
vigil github-evidence --event <event.json> [GitHub API exports]
vigil value <receipt.json> [--github-evidence <bundle.json>] [options]
vigil compare-value <card.json>... [--format text|json|html]
vigil audit <change.diff> [--strict]
vigil gate <portable-receipt.json> [--repo . --base <sha> --head <sha>]
vigil maintainer --event <event.json> [--repo . --base <sha> --head <sha>]
vigil merge-group --event <event.json> [--repo . --base <sha> --head <sha>]
vigil continuity demo
vigil continuity import-github --chain <directory> --event <webhook.json> [authenticated webhook options]
vigil continuity import-github-actions --chain <directory> --signing-key <private.pem>
vigil continuity install-action --repo . --action-ref <full-commit-sha> --self-serve
```

## What it prevents

Agent Vigil is designed for common failures that ordinary green checks can
miss:

1. **Fail closed on missing evidence.**
2. **Compare the story with the trajectory and the selected repository state.**
3. **Detect common ways a change can weaken the tests that judge it.**
4. **Keep verification local, deterministic, and inspectable.**
5. **Anchor policy outside the candidate change.**
6. **Make regression tests prove they catch the old behavior.**
7. **Compare receipt revisions and fail on evidence regression, not prose drift.**
8. **Expose missing external workflow identity or merge-queue enforcement.**
9. **Snapshot the completed run without rerunning candidate code.**
10. **Stop deployment when later evidence revokes an earlier green result.**

Agent Vigil does not generate code-review opinions. It checks recorded claims,
actions, Git identity, policy, and executable evidence.

The executed compatibility matrix is in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). Security and product limits are explicit in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

Public adoption is measured under a separate
[evidence contract](docs/ADOPTION_EVIDENCE.md). A catalog entry, clone, or code
search hit is not counted as an adopter or receipt. The public
[adopter ledger](ADOPTERS.md) starts empty rather than manufacturing traction.

## Reproducible benchmark evidence

The v0.10 cycle froze its protocol before executing either tool. On 520 paired
synthetic broken/clean diffs, Agent Vigil's post-hardening static audit reached
76.9% broken recall, 100% clean specificity, and 88.5% balanced accuracy;
Swarm 12.1.1 reached 100%, 28.8%, and 64.4% under the same any-finding rule. On
325 constructive injections, exact-category recall was 244/325 for Agent Vigil
and 258/325 for Swarm; the exact paired McNemar p-value was 0.189, so this run
does not establish a reliable exact-recall difference.

On 232 presumed-clean merged PRs, Agent Vigil produced advisories on 103 PRs
and 146 total findings; Swarm produced advisories on 71 PRs and 622 findings.
These are review-burden measurements, not confirmed false-positive rates. The
post-hardening corpus was visible during development and is not a blind
holdout or independent evaluation.

Read the [frozen protocol and leadership gates](docs/BENCHMARKS.md), the
[baseline](benchmarks/comparative/baseline-v1.md), and the separately labeled
[post-hardening result](benchmarks/comparative/post-hardening-results-v1.md).

## Evidence on this repository

- 637 tests, including adversarial candidate-runtime, exact-event, diff-parser,
  authority-classification, bounded-reader, filesystem, output, adapter,
  continuity, and receipt cases. In the 2026-08-25 post-pin v0.20.0 candidate
  source run, 624 passed and 13 opt-in or platform-specific tests skipped.
  This is local source evidence, not a hosted or released result.
- The separate 2026-08-25 coverage run contained the same 637 tests: 616 passed
  and 21 skipped because coverage mode adds coverage-specific skips. Coverage
  reached 92.67% lines, 81.88% branches, and 96.36% functions. These are local
  candidate results, not hosted or released evidence.
- The broader local compatibility lab retains historical runner-output and
  ecosystem evidence. Generated v0.20.0 hosted execution is deliberately
  narrower: plain Git or root Node/npm with direct `node --test`. Local CLI
  execution is host execution, not sandboxing.
- `npm run review:public` checks the public wording, links, accessible labels,
  reading measure, claim-count consistency, and rendered HTML against the
  [public release policy](docs/PUBLIC_RELEASE_POLICY.md). Agent Vigil does not
  require a named human declaration for this gate.
- `npm pack --dry-run` is part of the build gate.
- JSON, SARIF, and job-summary outputs reject symlinks and non-regular targets,
  then use same-directory temporary files and atomic replacement. POSIX output
  mode is `0600`; Windows output inherits the destination directory ACL.
- Zero runtime dependencies.

These checks prove only their exact source snapshot and environment. They do
not prove a release, external installation, adoption, payment, or revenue.

## AI Change Receipt v2

Receipt schema v2 binds adapter identity, transcript digest, exact Git SHAs,
repository tree, canonical policy hash, rule evidence, final status, and a
reproduction command. Optional Ed25519 signing is supported. An embedded key is
self-asserted; use `--public-key` to pin identity through a trusted channel.

See [the receipt specification](docs/AI_CHANGE_RECEIPT.md),
[JSON Schema](docs/receipt-v2.schema.json),
[GitHub attestation schema](docs/ai-change-receipt-predicate-v1.schema.json),
and [threat model](docs/THREAT_MODEL.md).

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
