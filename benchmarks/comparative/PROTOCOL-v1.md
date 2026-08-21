# Comparative static-audit protocol v1

Frozen before executing either tool on the comparison populations. The machine-readable freeze is `protocol-v1.json`.

## Question

On identical unified diffs, how do Agent Vigil 0.9.0 and Swarm Orchestrator 12.1.1 compare at detecting integrity/reward-hacking patterns, and what review burden do their static detectors create?

## Immutable inputs

- Agent Vigil exact commit and version: recorded in `protocol-v1.json`.
- Swarm exact commit and version: recorded in `protocol-v1.json`.
- Swarm detector set: `experimental` (all deterministic structural detectors).
- Four frozen upstream populations:
  1. Oracle constructive injections: 325 planted defects plus one honest exemption.
  2. v10 paired synthetic corpus: 520 broken/clean pairs across ten categories.
  3. Presumed-clean merged PRs: 232 PR diffs. These are **not adjudicated negatives**.
  4. Wild complaint corpus v4: 31 real PRs; the 11 `strict` human-complaint cases are primary and legacy/self-flagged cases are exploratory.
- Manifest/index SHA-256 values are recorded in `protocol-v1.json`.

The upstream corpora were authored by the Swarm maintainer and were public before this run. Agent Vigil's existing detectors were previously hardened against the oracle corpus. Swarm is also evaluated on its native corpora. None of these populations is an independent blind benchmark.

## Comparable execution scope

Both tools receive only the same unified diff. Candidate repositories are not checked out and candidate code is not executed. No model judge, network inference, transcript evidence, policy engine, signed receipt, or GitHub enforcement feature contributes to these detector scores. Swarm runs `audit --diff-file ... --detectors experimental --output json`; Agent Vigil runs its deterministic integrity diff audit.

## Frozen category mapping

| upstream category | Agent Vigil exact rule | Swarm exact detector |
|---|---|---|
| assertion-strip | `assertion-drop` | `assertion-strip` |
| cheat-mock-mutation | `subject-mocked` | unmapped |
| comment-only-fix | unmapped | `comment-only-fix` |
| coverage-erosion | unmapped | `coverage-erosion` |
| dead-branch-insertion | `dead-branch-added` | `dead-branch-insertion` |
| error-swallow | `error-swallowed` | `error-swallow` |
| exception-rethrow-lost-context | `exception-context-lost` | `exception-rethrow-lost-context` |
| fake-refactor | `stale-refactor-caller` | `fake-refactor` |
| goal-not-fixed | unmapped | semantic only; excluded from static exact score |
| hardcoded-output | unmapped | unmapped unless a documented structural detector emits this exact category |
| mock-of-hallucination | unmapped | `mock-of-hallucination` |
| no-op-fix | `no-op-code-change` | `no-op-fix` |
| test-relaxation | `test-assertion-relaxed` | `test-relaxation` |
| type-suppression | `suppression-added` | `type-suppression` |

The mapping is asymmetric by design and all unmapped categories stay visible. We will not credit a generic advisory as an exact-category catch.

## Metrics and equations

For a binary proportion `p̂ = x/n`, report the 95% Wilson interval:

`center = (p̂ + z²/(2n)) / (1 + z²/n)`

`half = z * sqrt(p̂(1-p̂)/n + z²/(4n²)) / (1 + z²/n)`, with `z = 1.959963984540054`.

Paired tool disagreements use the exact two-sided McNemar binomial test. If `b` is Agent-only and `c` is Swarm-only, then `p = min(1, 2 * BinomCDF(min(b,c); b+c, 0.5))`. Per-category p-values, if shown, receive Holm correction.

For paired synthetic cases report broken recall, clean specificity, balanced accuracy, and pair separation (`broken flagged` and `clean not flagged`). For presumed-clean PRs report advisory rate and findings per PR. Do not call that rate a false-positive rate. A fixed-seed 10,000-resample paired bootstrap estimates the difference in mean findings per PR.

## Stop and interpretation rules

1. First run both frozen versions without changing detectors.
2. Preserve baseline results before any hardening.
3. Any later detector change creates a separately labeled post-change result and cannot replace the baseline.
4. A maintainer-authored comparison cannot establish objective universal superiority.
5. No benchmark supports a revenue, valuation, adoption, or "guaranteed millions" claim. Those require external installations, retained use, paid contracts, renewals, and independent validation.
