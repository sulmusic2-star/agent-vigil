# Static audit comparison baseline v1

Protocol: `513ef52097e98cccdff45b4c55235503cbf4538bfec5f8b456b041628c6b55d8` · Agent Vigil 0.9.0 · Swarm 12.1.1 at `b2b681ff529929d39a14c0541d0e2b71b642b5da`

> Maintainer-authored, non-blind comparison on competitor-authored corpora. This does not establish objective universal superiority or any financial outcome.

## Paired synthetic corpus

| tool | broken recall | clean specificity | balanced accuracy | pair separation |
|---|---:|---:|---:|---:|
| Agent Vigil | 57.7% | 100.0% | 78.8% | 57.7% |
| Swarm | 100.0% | 28.8% | 64.4% | 28.8% |

Any-finding McNemar: Agent-only 0, Swarm-only 220, exact p=0.

## Constructive-injection oracle

- Agent Vigil exact-category: 220/325 (67.7%; Wilson 95% 62.4%–72.5%)
- Swarm exact-category: 258/325 (79.4%; Wilson 95% 74.7%–83.4%)
- Exact-category McNemar: Agent-only 42, Swarm-only 80, exact p=0.000741.

## Presumed-clean review burden

- Agent Vigil: 99/232 PRs with advisories (42.7%); 140 findings.
- Swarm: 71/232 PRs with advisories (30.6%); 622 findings.
- Paired bootstrap mean-finding difference (Agent minus Swarm): -2.078 [-3.931, -0.698].

These PRs are presumed clean, not adjudicated negatives. The numbers measure review burden, not confirmed false positives.

## Strict real-PR complaints

- fetched: 10 strict cases (29/31 total corpus entries fetched)
- Agent Vigil exact / any: 0/10 / 0/10
- Swarm exact / any: 0/10 / 2/10

See the JSON for every normalized row, category-level Wilson intervals, exact McNemar tests, Holm adjustments, hashes, and fetch failures.
