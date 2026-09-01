# Advisory triage: suppression and assertion loss

Date: 2026-09-01  
Frozen source: `moonrunnerkc/swarm-orchestrator@b2b681ff529929d39a14c0541d0e2b71b642b5da`

## Decision

Two rules produced most of the review burden in 232 presumed-clean merged pull
requests:

| rule | before | after | change |
|---|---:|---:|---:|
| `suppression-added` | 71 PRs | 40 PRs | -31 |
| `assertion-drop` | 52 PRs | 22 PRs | -30 |
| any advisory | 134 PRs | 104 PRs | -30 |

The totals overlap. “Presumed clean” is not a negative label, so this table
measures review burden rather than a false-positive rate.

### Suppression rule

A TypeScript `as any` cast is weak typing, but it does not turn a compiler or
linter diagnostic off. The old rule called every new cast a suppression. The
new rule reserves `suppression-added` for directives that actually disable a
check, including `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `noqa`,
`nolint`, `SuppressWarnings`, and equivalent language-specific directives.

### Assertion rule

Assertions are commonly moved or consolidated across test files. The old rule
warned when any one changed test file lost assertions, even when the complete
pull request added as many or more elsewhere. The new rule warns on a net loss
across the full diff. It also keeps the strong case where assertion removal
leaves an existing JavaScript test body empty.

## Regression boundary

After the change:

- frozen mapped oracle catches: 220/220;
- targeted honest-control false positives: 0/1;
- real-PR advisories: 104/232 (44.8%), down from 134/232 (57.8%);
- incomplete raw-diff audits: 9/232, still fail closed;
- arbiter-agreed cases with any advisory: 4/4;
- arbiter-agreed cases with the mapped category: 2/4.

The remaining 44.8% burden is still high. It is not hidden or described as an
excellent false-positive rate. First-use output shows the merge decision and
one actionable required finding; review notes remain in the retained receipt.
Further detector changes must preserve the frozen catch gates rather than lower
them to make the number look better.
