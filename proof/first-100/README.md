# First-100 external update-pair registration

These files freeze the problem-frequency sampling frame before R0 and before
the first external pair is accepted. The signed registration, public key, and
empty chronology anchor retain their original bytes. The entry schema and
offline verifier add the fail-closed evaluation and provenance contract.

The Ed25519 signature authenticates the exact registration bytes. The ledger
contains only the registration anchor and zero pair entries. The mandatory
provenance sidecar SHA-256 binds those raw bytes and an empty set of publisher
records. Therefore this directory proves a pre-registered method, not external
distribution, problem frequency, product demand, payment, or revenue.

Verify the committed artifacts locally:

```bash
node proof/first-100/verify.mjs
```

The frozen registration SHA-256 is
`9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da`.
The entry-schema SHA-256 is
`db8311854812f7774b3da7f08b1981fccc2ce4c0fdf1cbc67e0d8e5e29bbd73c`.
