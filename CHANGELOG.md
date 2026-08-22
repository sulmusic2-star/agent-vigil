# Changelog

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
