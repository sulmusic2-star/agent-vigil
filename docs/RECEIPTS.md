# Receipt format

JSON receipts use schema version `1` and include:

- verifier version;
- transcript path, SHA-256 digest, and detected adapter;
- repository and selected `base..head` range;
- each claim, verdict, rule ID, and evidence string;
- PASS / FAIL / INCONCLUSIVE totals and policy;
- a deterministic SHA-256 identifier.

The hash excludes local absolute paths and generation time. It binds the transcript
digest, rule results, versions, transcript format, Git range, status, and policy. Two machines
with the same normalized findings can therefore compare receipt identifiers.

SARIF output contains non-verified findings as warnings or errors so existing
code-scanning tooling can display them. Markdown output is intended for GitHub
Step Summary and human review.

Schema stability begins with v0.3. Breaking changes will increment
`schemaVersion`.
