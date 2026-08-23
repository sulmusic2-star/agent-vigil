# First-100 external update-pair registration

These files freeze the problem-frequency sampling frame before R0 and before
the first external pair is accepted. They are copied byte-for-byte from the
local corpus anchor `cd4c2fbd298fedfb6ac88689006e7be0fdae5755`.

The Ed25519 signature authenticates the exact registration bytes. The ledger
contains only the registration anchor and zero pair entries. Therefore this
directory proves a pre-registered method, not external distribution, problem
frequency, product demand, payment, or revenue.

Verify the committed artifacts locally:

```bash
node proof/first-100/verify.mjs
```

The frozen registration SHA-256 is
`9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da`.
The entry-schema SHA-256 is
`b6f090f886d09002163be880adc06c726fafedc81bdb45696ed3e1888f1e7757`.
