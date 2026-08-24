# First-100 external update-pair registration

This directory freezes the problem-frequency test before the first external
pair can enter it. The registered frame is chronological and includes every
eligible or excluded external proposal. It is not a curated benchmark.

`first-100-registration.json` defines the frame, component cap, exclusions,
materiality test, and interpretation. `first-100-registration.signature.json`
is a detached Ed25519 signature over the exact registration bytes. The public
key is committed here; the private key is stored outside this repository with
mode `0600`.

`first-100-acquisition-v1.schema.json` is the publisher-facing request frame.
It contains authenticated acquisition facts and an optional independent
adapter attestation, but deliberately has no eligibility decision, exclusion
reason, inspection flag, handle, or sequence for the publisher to choose. The
adapter signs the exact publisher/facts binding while the artifact is
`UNOPENED`; the service creates the handle and derives every decision. A
missing trusted adapter produces a counted, gate-ineligible server exclusion.

`first-100-ledger.jsonl` begins with one registration anchor. Later lines must
be complete `diffwitness-first-100-entry/v1` objects. Every row, including an
exclusion, records `inspectionStarted: false`. The ingestion service allocates
`receivedAt`, `ingestionSequence`, and the acquisition handle before a
separately signed adapter grant permits artifact access. Evaluation data may
only be added to an included entry after that grant. An excluded acquisition
stays in the ledger and counts toward the all-row limits.

`first-100-provenance.jsonl` is mandatory. Its v2 anchor SHA-256 binds the
exact raw-ledger bytes and the exact provenance-record bytes, and it contains
exactly one publisher/status/acquisition-adapter record for every raw pair row.
Suspended or revoked publishers and revoked adapters are quarantined without
changing frozen chronology; the raw ledger alone is never gate-eligible.

A nonzero corpus additionally requires three independently supplied trust
inputs: the pinned operator SPKI, a five-minute signed export manifest, and a
signed current head retrieved outside the publisher-controlled corpus. Every
signed chunk named by the manifest is required. The verifier recomputes the
raw/provenance hashes, canonical publisher and adapter authority-state digests,
moderation checkpoint binding, stop-event digest, ordered chunk hash chain,
and pairwise key-duty separation. Omitted, duplicated, reordered, tampered,
future, expired, wrong-key, or rollback-mismatched inputs fail closed. An old
ACTIVE manifest cannot validate against a newer REVOKED head.

The component cap uses the exact lowercase `componentIdentity` globally,
irrespective of ecosystem. `MATERIAL` is coherent only with `CHANGED` and
`falseCompatible: false`, or with `SAFE` and `falseCompatible: true`. `HOLD`
is inconclusive. A PASS requires 100 active, included rows, 100 complete
conclusive evaluations, at least three material regressions, and zero
false-compatible outcomes.

The committed zero state can be inspected without trust inputs:

```bash
node frequency/validate-first-100.mjs
```

It exits successfully only to report `INSUFFICIENT_DISTRIBUTION_VOLUME`,
`gateAuthorized: false`, and `trustVerdict: TRUSTED_HEAD_REQUIRED`. A nonzero
export is validated with explicit paths (repeat `--chunk` once per manifest
descriptor):

```bash
node frequency/validate-first-100.mjs \
  --ledger /trusted/export/first-100-ledger.jsonl \
  --provenance /trusted/export/first-100-provenance.jsonl \
  --manifest /trusted/export/manifest.json \
  --trusted-head /independent/current/head.json \
  --operator-public-key /independent/pins/frequency-operator.pem \
  --chunk /trusted/export/chunk-000.json
```

The initial state contains zero pair entries and a bound empty provenance
snapshot. It therefore proves only that a frame was frozen before R0. It
proves no external distribution, problem frequency, product demand, payment,
or revenue.
