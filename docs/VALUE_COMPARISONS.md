# Task-matched local value comparisons

**State:** Agent Vigil v0.11 contract

`vigil compare-value` compares verified Agent Value Cards locally. It does not
send cards, transcripts, or billing evidence to Agent Vigil.

[Open the synthetic comparison demonstration](assets/agent-value-comparison-demo.html).
Its agents, models, costs, and outcomes are fixtures, not vendor results.

```bash
vigil compare-value cards/*.json
vigil compare-value cards/*.json \
  --format html --output agent-value-comparison.html
```

## Comparison contract

Cards are grouped by exact task class, transcript adapter, and model set. A
task class is `COMPARABLE` only when:

- at least two agent/model groups exist;
- every group has at least five unique episodes;
- every group has at least five conclusive outcomes; and
- every group has hashed cost evidence for at least 80% of episodes.

All other results remain `INCONCLUSIVE` and carry explicit warnings. The command
does not rank a one-off demo, mix bug fixes with migrations, or silently drop
missing-cost episodes.

Each group reports:

- unique episodes and conclusive/inconclusive counts;
- positive, negative, accepted, and adverse downstream outcomes;
- positive rate with a 95% Wilson score interval;
- hashed-cost completeness and total observed hashed cost;
- cost per positive result only when every episode has hashed cost; and
- observed review-minute count and median review minutes.

Multiple cards may close the outcome for the same receipt over time. Agent
Vigil deduplicates by receipt hash and keeps the latest downstream observation,
so an early `unknown` card and a later `reverted` card are one episode rather
than two.

## What the statistics do not prove

Wilson intervals express sampling uncertainty. They do not remove
task-selection bias, repository difficulty, user skill, model-version drift,
subscription-allocation error, or causal confounding. Five episodes is a
minimum display gate, not a claim of production-grade statistical power.

This is deliberately a local decision aid rather than a synthetic global
leaderboard. Public vendor rankings should require consented, independently
audited evidence and larger preregistered samples.
