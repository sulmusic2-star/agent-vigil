# Agent Vigil Continuity v1

Agent Vigil Continuity is an offline append-only successor-evidence chain for one exact Agent Vigil receipt. It preserves the historical `PASS`, `FAIL`, or `INCONCLUSIVE` verdict and computes a separate current state:

- `CURRENT`: the chain is valid and every policy-required source is fresh;
- `HOLD`: required evidence is missing, unsupported, ambiguous, or unsigned when signatures are required;
- `EXPIRED`: required evidence is stale;
- `REVOKED`: the chain, signature trust, original receipt, or a policy-denied fact is contradicted.

Only `CURRENT` sets `allowsProtectedAction` to `true`. The other states deny. This is a deterministic policy result, not a trust score and not proof that code is correct or safe.

## Offline workflow

```bash
vigil continuity init agent-vigil-report.json --output .agent-vigil/continuity
vigil continuity append \
  --chain .agent-vigil/continuity \
  --event verification-refreshed.event.json \
  --signing-key operator.pem
vigil continuity verify --chain .agent-vigil/continuity --json
vigil continuity status \
  --chain .agent-vigil/continuity \
  --policy .agent-vigil-continuity.json \
  --repo . \
  --policy-ref <trusted-base-sha> \
  --environment production
```

`status --policy-ref` loads the policy from the named Git object rather than the candidate worktree. The ref must be a full 40- or 64-character lowercase Git object ID. `--policy-ref` and `--repo` must be provided together.

`verify --public-key` pins every stored event to that Ed25519 public key and rejects unsigned events. Policy evaluation separately controls trusted root and event key IDs.

## Chain layout

```text
.agent-vigil/continuity/
  receipt.json          exact original receipt bytes
  root.json             receipt file hash, canonical root hash, exact subject
  tip.json              expected sequence and chain tip (detects suffix loss)
  events/
    00000001.json       first successor event
    00000002.json       second successor event
```

The first event binds to the root hash. Each later event binds its sequence, predecessor, exact receipt subject, privacy-minimal observation, and optional Ed25519 signature. The separately maintained local tip makes an uncoordinated deletion of the last event fail closed. Files are owner-only; events are created without replacement.

## Event privacy

Receipt-tier events contain only fixed event kinds, machine reason codes, hashes, full Git object IDs, timestamps, UUIDs, privacy-safe source IDs, and signature material. They reject free-form prompts, paths, repository names, commands, tokens, emails, webhook bodies, issue prose, and source content.

The chain keeps the original full receipt locally because it must verify the root. `verify` and `status` expose only the historical verdict, hashes, counts, categorical states, and fixed reasons.

## Root trust

Hash chaining and the local tip detect changes relative to the chain directory. They do not stop an attacker who can replace an unsigned receipt, root, tip, and entire event directory together. A protected policy should set `requireSignedRoot` and pin `trustedRootKeyIds`. Signed events should likewise use `requireSignedEvents` and `trustedIssuerKeyIds`; a production integration should externally retain the accepted tip.

## Remediation

A revocation remains historical. It can become inactive only when policy allows remediation and a later `remediation_verified` event:

- references the exact revoking event;
- comes from the `verification` source;
- is signed by a trusted issuer;
- uses a different issuer from the revoking observation;
- binds fresh evidence and a target hash;
- remains fresh at evaluation time.

An ordinary affirmative event never erases a revocation.

## Exit codes

| Command result | Exit |
|---|---:|
| valid chain or `CURRENT` | `0` |
| invalid chain or `REVOKED` | `1` |
| usage or schema error | `2` |
| `HOLD` | `3` |
| `EXPIRED` | `4` |

## Boundaries

Continuity proves only that recorded trusted inputs were folded under the recorded policy. It cannot prove that every incident was observed, that a linked incident was caused by the change, that a trusted issuer told the truth, or that a platform administrator cannot bypass an external protection. GitHub ingestion, webhooks, deployment gates, hosted storage, and cross-vendor adapters are not implemented in v1 Phase 0.
