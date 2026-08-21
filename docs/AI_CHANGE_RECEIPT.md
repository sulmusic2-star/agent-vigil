# AI Change Receipt v2

An AI Change Receipt is a portable, deterministic record of which checkable
claims were evaluated against which transcript, Git range, repository tree, and
policy. It keeps three states separate:

- **verified**: the available objective evidence supports the claim;
- **contradicted**: objective evidence conflicts with the claim;
- **unverifiable**: the required evidence is absent, unsupported, or ambiguous.

The receipt-wide status is PASS, FAIL, or INCONCLUSIVE. A content hash detects
accidental or post-hoc alteration. An optional Ed25519 signature proves that a
specific key signed that hash. Neither mechanism proves that the signer is a
particular person or agent unless the public key is pinned through a trusted
channel.

## Required bindings

Schema v2 binds:

1. verifier version and transcript adapter;
2. transcript SHA-256;
3. exact base and head commit SHAs;
4. repository remote and head tree when available;
5. canonical policy SHA-256 and its trusted Git-ref source when used;
6. every verdict-bearing result plus receipt-bound non-blocking advisories,
   with rule IDs and evidence descriptions kept separate;
7. PASS / FAIL / INCONCLUSIVE summary;
8. a reproduction command.

An exact-commit receipt also checks that Git-visible workspace paths match the
selected head. The separately hashed transcript, policy, and signing-key input
may live outside that state. Any other dirty path makes the result
INCONCLUSIVE, even when strict mode is disabled, because a fresh command could
otherwise test code that is not bound to the receipt.

The normative JSON shape is in [`receipt-v2.schema.json`](receipt-v2.schema.json).

## Create and verify a signed receipt

```bash
vigil keygen --private vigil-private.pem --public vigil-public.pem
vigil session.jsonl --repo . --base <base-sha> --head <head-sha> \
  --policy .agent-vigil.json --policy-ref <trusted-base-sha> \
  --signing-key vigil-private.pem --output receipt.json --strict
vigil verify receipt.json --public-key vigil-public.pem
```

Keep the private key outside the repository. Verification without
`--public-key` checks the embedded self-asserted key; it detects tampering but
does not establish identity.

## Trust boundary

The receipt does not prove semantic correctness, transcript completeness,
trusted wall-clock time, or host integrity. Fresh verification executes
repository code. See [`THREAT_MODEL.md`](THREAT_MODEL.md).

## Portable receipt v1

When the raw transcript and detailed claim evidence must remain local, generate
a compact signed receipt with `--portable-output`. The portable receipt binds
the full report hash, results hash, transcript digest, Git identity, policy,
summary, and signer without copying transcript text or detailed findings into
Git. `vigil gate` verifies it against a base-anchored signer policy and performs
a fresh independent test and integrity run.

The portable receipt does not expose a separate advisory hash. Its signed
`reportHash` binds the full report, including advisories; `resultsHash` remains
the digest of verdict-bearing results for schema-v1 compatibility.

See [`PRIVATE_RECEIPT_GATE.md`](PRIVATE_RECEIPT_GATE.md) and
[`portable-receipt-v1.schema.json`](portable-receipt-v1.schema.json).
