# Changelog

## 0.11.1 - 2026-08-22

- Make generated maintainer workflows install locked dependencies with scripts
  disabled before running the base policy's fresh verification command.
- Collect paginated GitHub review, comment, and Actions-job evidence with the
  hosted runner's supported `gh` and `jq` interface.

Both defects were found by the first real pull request that installed the
published Action on Agent Vigil itself. The failed receipt remains in that pull
request as first-party dogfood evidence.

## 0.11.0 - 2026-08-22

- Add task-scoped authority contracts that bind allowed repository paths,
  denied paths, action classes, expiry, and tool-result completeness.
- Add `vigil authority`, base-ref contract loading, JSON/SARIF receipts, and an
  `init --profile authority` GitHub workflow.
- Classify observed read/write/test/build/install/network/credential/destructive,
  Git, PR, release, deploy, external-write, and task-creation effects while
  failing closed on unknown or incomplete action evidence.
- Add adversarial fixtures for contract self-widening, path escape, unauthorized
  push, expired authority, compound shell commands, missing results, and
  narrative-only evidence.
- Add `vigil value` and Agent Value Card v1. A card joins a verified receipt to
  observed Codex or Claude Code usage, attributed cost and budget, maintainer
  disposition, review time, and downstream outcome.
- Add text, JSON, Markdown, and private standalone HTML cards with explicit
  `POSITIVE`, `NEGATIVE`, and `INCONCLUSIVE` states.
- Deduplicate streamed Claude assistant usage by message identity, consume the
  greatest Codex cumulative usage snapshot, hash optional billing, review, and
  outcome evidence, and reject transcript/receipt mismatches or tampering.
- Add optional post-run `maxToolCalls`, `maxFailedToolCalls`, and
  `maxObservedTokens` authority limits. A declared token limit requires token
  telemetry.
- Detect exact repeated actions, consecutive failures, and spend without
  observed progress without treating every repeated command as a defect.
- Add `vigil github-evidence` for bounded GitHub PR, review, comment, merge,
  Actions-duration, revert, hotfix, and incident evidence. Generated workflows
  retain the normalized bundle and a Value Card with each receipt.
- Add a separate least-privilege outcome observer. It downloads the prior
  receipt, records completed Actions duration and final merge state, and never
  checks out or executes candidate code.
- Add `vigil compare-value` with receipt deduplication, exact task-class groups,
  minimum evidence gates, hashed-cost completeness, review burden, downstream
  adversity, and 95% Wilson intervals.
- Publish a dated market radar separating official platform behavior, anecdotal
  complaints, competitor categories, product hypotheses, and commercial gates.

Authority reconciliation is post-execution evidence, not runtime containment or
proof that no unlogged action occurred.
Cost amounts and downstream outcomes remain attributed evidence. `POSITIVE`
requires hashed cost evidence plus hashed acceptance or merge evidence. Artifact
hashes prove file identity, not that contents or allocations are correct.
GitHub Actions elapsed time is not billed USD.

## 0.10.1 - 2026-08-21

- Add fail-closed GitHub merge-queue verification for `merge_group` events.
- Bind the composed queue commit to the event `base_sha` and `head_sha`, load
  policy from the event base, rerun its test command, audit the composed diff,
  and retain JSON plus SARIF receipts.
- Make `vigil init` generate a merge-queue-compatible required check and pin
  the generated Action to the actual CLI version instead of stale v0.9.0.
- Expose the SARIF path as a composite Action output and teach `vigil doctor`
  to diagnose missing merge-queue coverage.
- Recheck `HEAD` after the trusted test command so a command cannot move to a
  different clean commit after the pre-test workspace binding.

The merge-group pass verifies composition and trusted policy. PR-body human
attestations and portable signatures remain PR-phase checks and are not
invented from a merge-group payload that does not contain them.

## 0.10.0 - 2026-08-21

- Add `vigil compare` and receipt-delta v1 for policy, Git-range, signer,
  invariant-check, contradiction, and advisory regression analysis.
- Freeze and publish a paired Agent Vigil/Swarm comparison protocol, baseline,
  machine rows, Wilson intervals, exact McNemar tests, Holm corrections, and a
  fixed-seed paired bootstrap.
- Recognize Cypress test paths, more cross-ecosystem test declarations,
  comment-only changes, cross-file stale callers, and test-only oracle
  relaxation while preserving advisory-default behavior.
- Add negative controls and fail-closed tests for receipt tampering, weaker
  policy, unrelated ranges, missing invariant checks, and advisory deltas.

The comparison is maintainer-authored and non-blind. It does not establish
universal superiority, adoption, revenue, valuation, or a guaranteed financial
outcome.
