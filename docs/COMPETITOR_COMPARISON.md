# Where Agent Vigil fits

**Reviewed:** 2026-09-01  
**Scope:** public capabilities and identical-diff measurements. This is not a
claim that Agent Vigil is the best product overall.

## The job Agent Vigil should own

Agent Vigil should be the independent merge check for AI-assisted pull
requests. It should answer one question:

> Did this exact change produce the evidence the repository requires before it
> merges?

That is narrower than AI code review and different from testing an AI agent as
a product. The narrow lane is useful because it gives the product a clear
enforcement point: one App-owned check tied to the exact commit.

## Product comparison

| product | strongest public job | what it does better than Agent Vigil today | where Agent Vigil is different |
|---|---|---|---|
| [AgentAssay](https://github.com/qualixar/agentassay) | statistical regression tests for nondeterministic agent workflows | framework adapters, repeated trials, confidence thresholds, mutation testing, and a normal Python install | Agent Vigil checks a coding change at the GitHub merge boundary; it is not a stochastic agent-test framework |
| [Harness AI Code Review](https://developer.harness.io/docs/ai-code-review/overview/) | AI review criteria with organization inheritance and delivery context | a live enterprise service, RBAC, inherited review policy, model-provider choice, and Harness deployment and incident context | Agent Vigil uses deterministic evidence, base-owned policy, test-integrity checks, and one exact-commit decision rather than an AI review opinion |
| GitHub Actions and [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) | native CI and merge enforcement | universal GitHub integration and the established required-check mechanism | Agent Vigil adds claim reconciliation, test-integrity evidence, retained receipts, and a check owned by a specific App |
| Swarm Orchestrator 12.1.1 static audit | deterministic integrity and reward-hacking detectors | higher recall in parts of the frozen detector corpus and a lower presumed-clean PR advisory rate | Agent Vigil produced fewer total findings and higher paired synthetic balanced accuracy in the same limited static-diff protocol |

AgentAssay is complementary, not a product Agent Vigil should copy. Harness is
the clearest warning against becoming a generic reviewer: it already combines
AI review with enterprise policy and delivery context. GitHub supplies the
merge primitive. Agent Vigil's opportunity is to make that primitive trustworthy
for AI-assisted changes.

## Identical-diff result

The frozen comparison runs Agent Vigil and Swarm against the same unified diffs.
Neither tool receives repository execution, a model judge, or its wider product
features.

| measure | Agent Vigil current pre-release source | Swarm 12.1.1 |
|---|---:|---:|
| paired synthetic broken recall | 76.9% | 100.0% |
| paired synthetic clean specificity | 100.0% | 28.8% |
| paired synthetic balanced accuracy | 88.5% | 64.4% |
| constructive-injection exact-category recall | 244/325 | 258/325 |
| presumed-clean PRs with an advisory | 104/232 | 71/232 |
| total findings on those 232 PRs | 147 | 622 |
| strict complaint cases with any finding | 0/10 | 2/10 |

The constructive-injection exact-recall difference was not statistically
reliable under the frozen paired test (`p=0.188847`). The 232 merged pull
requests are presumed clean, not adjudicated negatives, so the advisory rates
are review burden rather than false-positive rates. The strict complaint set is
too small and weakly labeled for a leadership claim.

Full rows, hashes, Wilson intervals, paired tests, and bootstrap results are in
[`../benchmarks/comparative/v0234-exact-results.json.gz`](../benchmarks/comparative/v0234-exact-results.json.gz).
The run used Agent Vigil 0.23.3 source at clean commit
`7707906cb126de69b0774f2d396297e81a848ccc` while v0.23.4 was still being
assembled.
The release artifact still needs its separate exact-tag package and checksum gate.

## Product decisions from the comparison

1. Keep static findings advisory unless the repository deliberately promotes a
   reviewed rule. A broad advisory flood is not the product.
2. Make `PASS`, `FAIL`, and `NOT CHECKED` the entire first screen.
3. Use a public GitHub App so the required check has an independent identity.
4. Support `merge_group`; GitHub requires a distinct merge-queue event and the
   App needs merge-queues read permission to receive it.
5. Do not add a generic AI reviewer or stochastic-agent framework. Integrate
   their outputs as evidence later if outside users ask for it.
6. Do not build the paid dashboard yet. First prove that outside repositories
   keep the App enabled and act on its failures.

## What could become paid

If retained outside use appears, the paid product is organization-wide control:
App-owned required checks, central policies and exceptions, searchable receipts,
vendor and model comparisons, cost per accepted change, downstream revert and
incident outcomes, RBAC, SSO, SIEM, data controls, self-hosting, and support.

Harness demonstrates that organizations buy governance and delivery context.
It does not prove that they will buy Agent Vigil. That requires paid pilots and
renewals.
