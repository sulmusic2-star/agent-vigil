# Agent Vigil real-PR advisory calibration

- Agent Vigil: 0.23.4
- upstream commit: `b2b681ff529929d39a14c0541d0e2b71b642b5da`
- presumed-clean merged PRs: 232
- PRs with one or more static advisories: 104/232 (44.8%)
- default hard blocks from heuristic findings: 0
- raw diffs that could not be fully audited and therefore fail closed: 9/232 (3.9%)
- dual-arbiter agreed true-cheat cases with any advisory: 4/4
- dual-arbiter agreed true-cheat cases with exact-category advisory: 2/4

> These merged PRs are presumed clean, not adjudicated negatives. Findings measure review burden, not a confirmed false-positive rate. The dual-model arbiter labels are also not ground truth. Raw-diff parse failures are reported separately and do not describe the repository-aware GitHub check.

## Default policy decision

Static integrity findings are receipt-bound advisories by default. They become blocking only when `integrityMode` is `blocking` or `vigil audit --strict` is used. Missing or malformed evidence remains fail-closed.

## Advisory frequency by rule

- `assertion-drop`: 22 PR(s)
- `error-swallowed`: 8 PR(s)
- `no-op-code-change`: 9 PR(s)
- `render-gate-hidden-character`: 4 PR(s)
- `stale-refactor-caller`: 14 PR(s)
- `subject-mocked`: 7 PR(s)
- `suppression-added`: 40 PR(s)
- `test-assertion-relaxed`: 7 PR(s)
- `test-count-drop`: 15 PR(s)
- `test-empty-added`: 6 PR(s)
- `test-oracle-constant`: 1 PR(s)
- `test-runtime-patch`: 5 PR(s)
- `test-skip-added`: 7 PR(s)
- `verification-bypass`: 2 PR(s)

## Dual-arbiter agreed true-cheat cases

| repository PR | upstream category | expected Agent Vigil rule | any advisory | exact category |
|---|---|---|:---:|:---:|
| cloudflare/workers-sdk#14063 | fake-refactor | `stale-refactor-caller` | yes | yes |
| cloudflare/workers-sdk#14132 | error-swallow | `error-swallowed` | yes | yes |
| getsentry/sentry-javascript#21147 | error-swallow | `error-swallowed` | yes | no |
| getsentry/sentry-javascript#21216 | error-swallow | `error-swallowed` | yes | no |
