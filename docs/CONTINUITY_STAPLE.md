# Continuity staples

A normal attestation records what was true when it was signed. A continuity
staple answers a narrower operational question: **does the exact reviewed
change still have permission to enter this environment right now?**

The staple is a short-lived, Ed25519-signed status statement derived from a
verified Agent Vigil continuity history. It binds:

- the original receipt and repository hashes;
- the exact base and head Git object IDs;
- `CURRENT`, `HOLD`, `EXPIRED`, or `REVOKED`;
- the verified continuity chain tip and event sequence;
- the exact policy bytes and protected environment;
- the evaluation, issue, and expiry times; and
- a pinned continuity-authority key.

Only a fresh, valid, pinned `CURRENT` staple allows a protected action.

## Issue a staple

Use a signing key that the change author and deployment job cannot access:

```bash
vigil continuity staple \
  --chain .agent-vigil/continuity \
  --policy .agent-vigil-continuity.json \
  --environment production \
  --signing-key continuity-authority-private.pem \
  --output continuity-staple.json \
  --ttl-seconds 300
```

The default lifetime is five minutes. The hard maximum is fifteen minutes.
The command signs non-`CURRENT` results too, so a verifier can distinguish a
deliberate revocation from missing evidence or stale evidence.

For a protected repository, also use `--repo` and `--policy-ref` so the policy
comes from the exact base commit rather than the candidate worktree.

## Verify before a protected action

The verifier requires a pinned public key, original receipt hash, exact head,
environment, and policy hash:

```bash
vigil continuity verify-staple continuity-staple.json \
  --public-key continuity-authority-public.pem \
  --expected-receipt-hash <original-receipt-hash> \
  --expected-head <full-reviewed-head-sha> \
  --environment production \
  --expected-policy-sha256 <sha256-of-exact-policy-bytes> \
  --minimum-sequence <latest-sequence-seen>
```

Exit codes preserve the continuity result:

| Result | Exit code | Protected action |
|---|---:|---|
| `CURRENT` | 0 | Allowed until the staple expires |
| `REVOKED` | 1 | Stopped |
| invalid input or signature | 2 | Stopped |
| `HOLD` | 3 | Stopped |
| `EXPIRED` | 4 | Stopped |

Use `--expected-chain-tip` when the caller already knows the latest accepted
tip. Use `--minimum-sequence` to reject an older signed `CURRENT` staple after
the caller has observed a later event.

## Security boundary

A staple is comparable to a short-lived status response. It is not a second
test run and it does not prove that code is defect-free.

An offline verifier cannot discover a newer revocation while an older
`CURRENT` staple remains fresh unless the verifier also receives a newer chain
tip or minimum sequence. The short expiry bounds that replay window. A
high-consequence deployment path should fetch the newest staple from an
independent authority, pin the authority key, and remember the highest accepted
sequence.

Expiry never turns `REVOKED` into a weaker result. A signed revocation remains
`REVOKED`; an expired signed `CURRENT`, `HOLD`, or `EXPIRED` staple resolves to
`EXPIRED` and stops the protected action.

This implementation is local and offline. It does not deploy a status service,
Kubernetes admission controller, Terraform gate, GitHub App, or hosted product.
