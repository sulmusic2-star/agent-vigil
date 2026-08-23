# First-100 external update-pair registration

This directory freezes the problem-frequency test before the first external
pair can enter it. The registered frame is chronological and includes every
eligible or excluded external proposal. It is not a curated benchmark.

`first-100-registration.json` defines the frame, component cap, exclusions,
materiality test, and interpretation. `first-100-registration.signature.json`
is a detached Ed25519 signature over the exact registration bytes. The public
key is committed here; the private key is stored outside this repository with
mode `0600`.

`first-100-ledger.jsonl` begins with one registration anchor. Later lines must
be complete `diffwitness-first-100-entry/v1` objects. The ingestion service
must allocate `receivedAt` and `ingestionSequence` before it fetches an
artifact, runs a canary, or observes a verdict. An excluded proposal stays in
the ledger. Evaluation data may only be added to an included entry.

Run:

```bash
node frequency/validate-first-100.mjs
```

The initial state contains zero pair entries. It therefore proves only that a
frame was frozen before R0. It proves no external distribution, problem
frequency, product demand, payment, or revenue.
