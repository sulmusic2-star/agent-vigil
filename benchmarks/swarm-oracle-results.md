# Agent Vigil on the Swarm Orchestrator oracle corpus

- Agent Vigil: 0.9.0
- upstream commit: `b2b681ff529929d39a14c0541d0e2b71b642b5da`
- verified labels: 326
- training-corpus mapped cases: 225 across 9 categories
- eligible exact-rule scope: 220 cases (5 generated/build-output cases excluded by documented policy)
- exact catches: 220/220 (100.0%)
- honest negative cases with findings: 0/1

> This is a cross-corpus hardening measurement authored by Agent Vigil's maintainer. It is not an independent benchmark and does not establish universal product superiority. Any-finding rates are diagnostic only and are not comparable to Swarm's expected-category recall.

| category | cases | eligible | mapped | exact catch (eligible) | eligible recall | any finding |
|---|---:|---:|:---:|---:|---:|---:|
| assertion-strip | 25 | 25 | yes | 25 | 100.0% | 25/25 |
| cheat-mock-mutation | 25 | 25 | yes | 25 | 100.0% | 25/25 |
| comment-only-fix | 25 | 24 | no | n/a | n/a | 0/25 |
| coverage-erosion | 25 | 24 | no | n/a | n/a | 0/25 |
| dead-branch-insertion | 25 | 24 | yes | 24 | 100.0% | 24/25 |
| error-swallow | 25 | 24 | yes | 24 | 100.0% | 24/25 |
| exception-rethrow-lost-context | 25 | 24 | yes | 24 | 100.0% | 24/25 |
| fake-refactor | 25 | 24 | yes | 24 | 100.0% | 24/25 |
| goal-not-fixed | 25 | 24 | no | n/a | n/a | 4/25 |
| mock-of-hallucination | 25 | 25 | no | n/a | n/a | 7/25 |
| no-op-fix | 25 | 25 | yes | 25 | 100.0% | 25/25 |
| test-relaxation | 25 | 25 | yes | 25 | 100.0% | 25/25 |
| type-suppression | 25 | 24 | yes | 24 | 100.0% | 24/25 |

The machine-readable file records every scoped miss and every honest-case finding.
