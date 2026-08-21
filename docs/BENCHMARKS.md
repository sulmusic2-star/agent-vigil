# Benchmark contract

Agent Vigil publishes frozen inputs, machine-readable outputs, and limitations.
The current evidence supports narrow detector claims. It does not support a
universal "best product" claim, a valuation, revenue, or guaranteed adoption.

## Reproduce the current measurements

Pin the upstream source first:

```bash
git clone https://github.com/moonrunnerkc/swarm-orchestrator.git
cd swarm-orchestrator
git checkout b2b681ff529929d39a14c0541d0e2b71b642b5da
```

From Agent Vigil:

```bash
npm ci
npm run benchmark:swarm -- \
  --corpus /path/to/swarm-orchestrator/benchmarks/oracle-corpus \
  --source-sha b2b681ff529929d39a14c0541d0e2b71b642b5da

npm run benchmark:swarm-real -- \
  --root /path/to/swarm-orchestrator/benchmarks/real-prs \
  --source-sha b2b681ff529929d39a14c0541d0e2b71b642b5da

# Reproduce the separately labeled v0.10 hardening comparison.
cd /path/to/swarm-orchestrator && npm ci && npm run build
cd /path/to/agent-vigil
npm run benchmark:compare -- \
  --swarm-root /path/to/swarm-orchestrator \
  --post-change \
  --generated-at 2026-08-21T23:00:00.000Z \
  --output benchmarks/comparative/post-hardening-results-v1.json
```

The paired comparator verifies both source identities and all four frozen
manifest/index hashes. It uses Wilson 95% intervals, exact paired McNemar tests,
Holm adjustment for category families, and a fixed-seed 10,000-resample paired
bootstrap for mean finding burden. The frozen equations, mappings, stop rules,
and limitations are in
[`comparative/PROTOCOL-v1.md`](../benchmarks/comparative/PROTOCOL-v1.md).

## What the current results mean

- **Paired synthetic broken/clean cases:** Agent Vigil 76.9% broken recall,
  100% clean specificity, and 88.5% balanced accuracy. Swarm 12.1.1 produced
  100%, 28.8%, and 64.4% under the same any-finding rule.
- **Constructive-injection exact category:** Agent Vigil 244/325; Swarm
  258/325. Exact paired McNemar p=0.188847. This comparison does not establish a
  reliable exact-recall difference.
- **Presumed-clean merged PRs:** Agent Vigil flagged 103/232 PRs with 146 total
  findings; Swarm flagged 71/232 with 622 total findings. These PRs are not
  adjudicated negatives, so neither proportion is a false-positive rate.
- **Strict complaint-mined final diffs:** 10 were fetchable; Agent Vigil exact
  category 1/10 and any finding 1/10; Swarm exact 0/10 and any 2/10. Complaint
  history does not prove the frozen final diff still contains the complained-of
  defect, and the sample is too small for a leadership claim.
- **Default merge effect:** zero of the 232 PRs would be blocked by the static
  heuristic lane because it is advisory by default. Deterministic claim, test,
  Git-binding, and policy contradictions remain blocking.

The baseline was committed before post-baseline detector changes. The
post-hardening amendment and output are explicitly trained/non-blind and never
replace the baseline. Calling either result independent would be false.

## Conditions for a defensible category-leadership claim

Do not claim that Agent Vigil is objectively better than every competitor until
all of these exist:

1. A frozen public evaluator with a concealed or newly collected holdout.
2. At least two comparable tools run under the same inputs, path scope, and
   blocking/advisory policy.
3. Precision and recall with confidence intervals, plus per-category results.
4. An independent maintainer or researcher reproducing the result.
5. A public false-verdict ledger and fewer than 1% unexplained **hard** false
   verdicts on external receipts.
6. Retained external use: 10 externally owned repositories, five retained for
   30 days, 1,000 external receipts, 10 maintainer-accepted contradictions, and
   three repositories making the check required.

Commercial value needs additional evidence: written paid pilots, renewal or
expansion, and actual collected revenue. No benchmark can guarantee millions.
