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
be complete `diffwitness-first-100-entry/v1` objects. Every row, including an
exclusion, records `inspectionStarted: false`. The ingestion service
must allocate `receivedAt` and `ingestionSequence` before it fetches an
artifact, runs a canary, or observes a verdict. An excluded proposal stays in
the ledger. Evaluation data may only be added to an included entry.

`first-100-provenance.jsonl` is mandatory. Its v2 anchor SHA-256 binds the
exact raw-ledger bytes and the exact provenance-record bytes, and it contains
exactly one publisher/status record for every raw pair row. Suspended or
revoked publishers are quarantined without changing frozen chronology; the raw
ledger alone is never gate-eligible.

The component cap uses the exact lowercase `componentIdentity` globally,
irrespective of ecosystem. `MATERIAL` is coherent only with `CHANGED` and
`falseCompatible: false`, or with `SAFE` and `falseCompatible: true`. `HOLD`
is inconclusive. A PASS requires 100 active, included rows, 100 complete
conclusive evaluations, at least three material regressions, and zero
false-compatible outcomes.

Run:

```bash
node frequency/validate-first-100.mjs
```

The initial state contains zero pair entries and a bound empty provenance
snapshot. It therefore proves only that a frame was frozen before R0. It
proves no external distribution, problem frequency, product demand, payment,
or revenue.
