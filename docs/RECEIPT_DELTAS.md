# Receipt delta contract

`vigil compare before.json after.json` compares two full Agent Vigil receipt-v2
documents. It does not rerun either change and does not infer semantic
correctness. It answers a narrower question: did the recorded evidence control
surface regress between two related revisions?

## PASS, FAIL, and INCONCLUSIVE

PASS requires:

- both canonical receipt hashes are intact;
- embedded signatures, when present, verify;
- the policy hash is unchanged;
- the Git ranges share a PR base or form a `before.head == after.base` chain;
- no prior verified invariant check disappears or weakens;
- no new contradiction or blocking evidence gap appears;
- strictness and the minimum verified-evidence floor do not decrease;
- a previously signed receipt does not become unsigned.

FAIL records each concrete regression. INCONCLUSIVE is used when the receipts
are individually intact but policy, signer, or Git-range continuity is not
established. New static advisories remain visible and content-bound but do not
become blockers merely because the comparison command saw them.

## Identity boundary

An unsigned receipt hash detects content drift but does not identify its
author. Embedded Ed25519 keys are still self-asserted unless a trusted channel
pins them. A signer change therefore produces INCONCLUSIVE rather than a false
identity claim. Removing an existing signature is a regression and produces
FAIL.

## Machine output

```bash
vigil compare before.json after.json --format json --output delta.json
```

The output uses schema `agent-vigil-receipt-delta/v1` and includes the two
receipt identities, policy/range/signer continuity, regressions, improvements,
new and resolved advisories, unchanged-check count, and its own canonical
SHA-256 `deltaHash`.
