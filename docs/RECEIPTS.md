# Receipt format

JSON receipts produced by v0.5 use schema version `2` and include:

- verifier version;
- transcript path, SHA-256 digest, and detected adapter;
- repository and selected `base..head` range;
- repository remote and head tree when available;
- canonical policy digest and trusted Git-ref source when configured;
- each claim, verdict, rule ID, and evidence string;
- PASS / FAIL / INCONCLUSIVE totals and policy;
- a deterministic SHA-256 identifier.
- a reproduction command;
- an optional Ed25519 signature over the receipt hash.

The hash excludes local absolute paths and generation time. It binds the transcript
digest, rule results, versions, transcript format, Git range, status, and policy. Two machines
with the same normalized findings can therefore compare receipt identifiers.

SARIF output contains non-verified findings as warnings or errors so existing
code-scanning tooling can display them. Markdown output is intended for GitHub
Step Summary and human review.

The v2 JSON Schema is [`receipt-v2.schema.json`](receipt-v2.schema.json).
Breaking changes will increment `schemaVersion`. Schema v1 receipts remain
historical artifacts; `vigil verify` intentionally accepts v2 only because v1
did not expose enough material to recompute its content hash independently.
