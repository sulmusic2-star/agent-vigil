# Static audit comparison v0234 exact results

Protocol: `513ef52097e98cccdff45b4c55235503cbf4538bfec5f8b456b041628c6b55d8` · Agent Vigil 0.23.4 evaluated at `78fb9aedc00e9c73adb978aad7c4e208190e498e` · Swarm 12.1.1 at `b2b681ff529929d39a14c0541d0e2b71b642b5da`

> Maintainer-authored, non-blind comparison on competitor-authored corpora. This does not establish objective universal superiority or any financial outcome.

## Paired synthetic corpus

| tool | broken recall | clean specificity | balanced accuracy | pair separation |
|---|---:|---:|---:|---:|
| Agent Vigil | 76.9% | 100.0% | 88.5% | 76.9% |
| Swarm | 100.0% | 28.8% | 64.4% | 28.8% |

Any-finding McNemar: Agent-only 0, Swarm-only 120, exact p=0.

## Constructive-injection oracle

- Agent Vigil exact-category: 244/325 (75.1%; Wilson 95% 70.1%–79.5%)
- Swarm exact-category: 258/325 (79.4%; Wilson 95% 74.7%–83.4%)
- Exact-category McNemar: Agent-only 42, Swarm-only 56, exact p=0.188847.

## Presumed-clean review burden

- Agent Vigil: 104/232 PRs with advisories (44.8%); 147 findings.
- Swarm: 71/232 PRs with advisories (30.6%); 622 findings.
- Paired bootstrap mean-finding difference (Agent minus Swarm): -2.047 [-3.905, -0.672].

These PRs are presumed clean, not adjudicated negatives. The numbers measure review burden, not confirmed false positives.

## Strict real-PR complaints

- fetched: 10 strict cases (29/31 total corpus entries fetched)
- Agent Vigil exact / any: 0/10 / 0/10
- Swarm exact / any: 0/10 / 2/10

See the JSON for every normalized row, category-level Wilson intervals, exact McNemar tests, Holm adjustments, hashes, and fetch failures.
