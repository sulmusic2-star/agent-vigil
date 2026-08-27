# Acceptance checks for agent work

An **Outcome Mandate** is a signed task record. It lists the starting commit,
the proposed commit, the checks that must pass, the keys allowed to sign the
result, and the deadline.

Agent Vigil checks the proposed change against that record and returns:

- **PASS** — every required condition was verified.
- **FAIL** — the evidence contradicted at least one required condition.
- **INCONCLUSIVE** — required evidence was missing or could not be verified.

A task system can translate those results to `RELEASE`, `REFUND`, or
`ESCALATE`. Agent Vigil only writes a signed message. It does not make a legal
decision, move money, call an API, or hold funds. Every v0.1 adapter is marked
`draft`, `dryRun: true`, and `networkAction: NONE`.

## The problem it checks

An agent can produce a diff, run commands, and say the task is done. Before
accepting it, a reviewer still needs to know:

- Did the required command run on this commit?
- Did the change stay inside the task?
- Would the regression test have failed before the fix?
- What was not checked?

The verifier runs separately from the agent, so it does not rely on the agent's
summary. A task or payment system can read the signed result without controlling
how the check was run.

## Run it locally

Generate separate requester and verifier keys:

```bash
vigil keygen --private requester.pem --public requester.pub.pem
vigil keygen --private verifier.pem --public verifier.pub.pem
```

Create the task record. Replace the sample values with full Git commit IDs:

```bash
vigil mandate create \
  --requester acme/platform \
  --provider coding-agent-7 \
  --task-id fix-1842 \
  --task-class code-change \
  --description "Fix the retry race without weakening the regression tests" \
  --base 1111111111111111111111111111111111111111 \
  --head 2222222222222222222222222222222222222222 \
  --required-rules tests-pass,test-integrity \
  --min-verified 2 \
  --expires 2026-09-01T00:00:00Z \
  --requester-key requester.pem \
  --verifier-public-key verifier.pub.pem \
  --adapter x402 \
  --settlement-ref task-1842 \
  --output mandate.json
```

Check the finished trust report:

```bash
vigil mandate assess mandate.json \
  --receipt trust-report.json \
  --verifier-key verifier.pem \
  --requester-public-key requester.pub.pem \
  --output outcome-receipt.json
```

Verify the result using a pinned verifier key:

```bash
vigil receipt verify outcome-receipt.json \
  --verifier-public-key verifier.pub.pem
```

If needed, render a draft message for another system:

```bash
vigil receipt signal outcome-receipt.json \
  --verifier-public-key verifier.pub.pem \
  --adapter x402 \
  --output settlement-signal.json
```

No command above contacts a payment network.

## Checks you can require

The v0.1 agreement can require:

- an overall `PASS` trust report;
- a minimum count of meaningful verified claims;
- zero contradicted claims;
- specific Agent Vigil rule IDs;
- a signed trust report from one of the named evidence keys;
- an exact base and head commit;
- a trusted independent verifier key;
- an expiry, attempt limit, and optional budget ceiling.

A missing check or unmet evidence minimum is `INCONCLUSIVE`, not a pass. A
contradicted check, commit mismatch, altered receipt, expired task record,
invalid signature, or untrusted signer fails closed.

## What this does not prove

For requester authenticity, pin the requester's public key when verifying or assessing a mandate. Without `--requester-public-key`, Agent Vigil can prove the file is self-consistent, but it cannot prove who owns the embedded key.

For verifier authenticity, pin the verifier public key or an approved verifier key ID when checking an outcome receipt. An embedded key alone proves integrity relative to that key; it does not establish organizational trust.

Agent Vigil can verify only the evidence named in the task record. It cannot
prove omitted requirements, detect every defect, decide a legal dispute, or
guarantee that another system will honor the signed result.

## Integration adapters

The generic, A2A, AP2, x402, ERC-8004, and VCAP adapters are small draft payloads for integration testing. Their names describe the target protocol vocabulary. They are not claims of endorsement, conformance, or production compatibility.

## Schemas

- [`outcome-mandate-v0.1.schema.json`](outcome-mandate-v0.1.schema.json)
- [`outcome-receipt-v0.1.schema.json`](outcome-receipt-v0.1.schema.json)
