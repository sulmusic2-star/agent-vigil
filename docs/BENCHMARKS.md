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
```

The oracle runner verifies the SHA-256 digest of each diff against its label
before scoring. Both runners reject the wrong upstream Git commit.

## What the current results mean

- **Oracle training/hardening scope:** 220/220 exact rule catches across nine
  mapped categories after excluding five generated/build-output targets under
  the documented path policy.
- **Honest oracle negative:** 0/1 static findings. One negative is too small to
  estimate precision.
- **Presumed-clean merged PRs:** 99/232 PRs produced at least one static
  finding. These PRs are not adjudicated negatives, so 42.7% is an advisory
  burden, not a confirmed false-positive rate.
- **Dual-arbiter agreed true cheats:** any Agent Vigil advisory on 4/4; matching
  category on 1/4. The two model arbiters are not ground truth.
- **Default merge effect:** zero of the 232 PRs would be blocked by the static
  heuristic lane because it is advisory by default. Deterministic claim, test,
  Git-binding, and policy contradictions remain blocking.

The oracle mappings and detector changes were developed with access to the
corpus. Calling this a blind holdout would be false.

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

