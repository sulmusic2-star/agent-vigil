# Implemented differentiation audit — 2026-08-22

**State:** primary-source feature audit plus local implementation evidence; not
independent superiority, adoption, demand, revenue, or valuation evidence

This audit checks whether the v0.11 capabilities reproduce current coding-
agent cost and observability tools. “Not established” means the reviewed public
source did not establish the capability; it does not mean the vendor cannot
have it elsewhere.

## Collision check

| Capability | CodeBurn | agentacct | AgentMeter | Agent Vigil v0.11 |
|---|---|---|---|---|
| Broad local token/cost adapters | Strong; 36 tools claimed | Codex/Claude live-observed paths plus narrower clients | Three GitHub agent workflows claimed | Two usage formats today; not the adapter leader |
| Live budget guard | Claude soft/hard caps claimed | Limited to launched/proxied paths | Monthly alerts claimed | Post-run base-anchored limits; no runtime stop |
| No-edit / retry signal | Checkpoint and file-aware one-shot rate claimed | Work sections and machine checks | Not established | Exact repeated actions, consecutive failures, and no observed write/test/build/commit under a declared token limit |
| Cost truth labels | Pricing-table estimates and subscription coverage | Confidence labels and explicit unknowns | Per-run USD claims | Transcript usage, attributed cost, and GitHub runner time remain separate; hashes do not become invoice truth |
| Required merge gate | Not established | Not established | Cost comment, not established as evidence gate | PASS / FAIL / INCONCLUSIVE required check plus merge-queue verification |
| Base-anchored human task authority | Not established | Task meaning recorded during work | Not established | Short-lived allow/deny paths and action classes loaded from the trusted base |
| Exact Git and fresh verification receipt | “Track what shipped” and local activity | Machine checks with exit codes | PR/run attribution | Exact base/head/tree, fresh tests, anti-weakening checks, stable receipt hash, optional signature |
| Official maintainer review and later outcome | Shipped-change tracking claimed | Not established | PR association and comments | Latest reviewer state, comments, merge/close, explicit labeled adverse markers, and separate post-run closure |
| Task-matched comparison uncertainty | Model/task surfaces and one-shot rates | Local work intelligence | Trends | Receipt-deduplicated groups, minimum evidence gates, hashed-cost completeness, and 95% Wilson intervals |

Primary product sources:

- [CodeBurn repository](https://github.com/getagentseal/codeburn)
- [agentacct repository](https://github.com/mikehasa/agentacct)
- [agentacct usage truth table](https://github.com/mikehasa/agentacct/blob/main/docs/usage-truth-table.md)
- [AgentMeter GitHub App](https://github.com/apps/agentmeter)

## What changed because competitors are stronger than expected

CodeBurn already claims broad adapters, task categories, cost guards, no-edit
checkpoints, one-shot rates, model comparisons, and shipped-work tracking.
agentacct explicitly labels evidence joins and refuses to promote unknown usage
or cost into hard-budget truth. Those are good designs. Agent Vigil should not
market ordinary local cost tracking, deterministic task categories, or a
no-edit warning as unique.

The implemented wedge is narrower:

```text
trusted human authority
+ observed trajectory and exact Git state
+ independent verification and merge enforcement
+ authenticated GitHub review and downstream outcome
+ attributed cost with explicit provenance limits
+ task-matched uncertainty-aware comparison
= retained AI change value evidence
```

That chain is useful specifically when an organization must decide whether an
agent-produced change may merge and later reconstruct what it cost and whether
humans accepted or reversed it. Cost tools can be upstream evidence providers;
Agent Vigil should interoperate rather than rebuild their adapter catalogs.

## Where Agent Vigil is not better

- CodeBurn has far broader cost-adapter coverage and a live Claude guard.
- agentacct has a more developed local work-intelligence and attribution
  surface.
- AgentMeter has a hosted GitHub cost dashboard and low-friction PR comments.
- Agent Vigil has no external retention, paid pilot, renewal, or hosted
  organization proof.

## Falsifiable “better” criteria

Agent Vigil may claim a stronger **merge-bound authority-to-outcome evidence
chain** only after public conformance tests show that competing products do not
produce the same chain under the same fixtures. It may claim better practical
value only after externally owned repositories show lower false-verdict rates,
retention, mandatory checks, and accepted contradictions. It cannot claim
universal product superiority from internal fixtures.
