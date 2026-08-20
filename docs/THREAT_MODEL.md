# Threat model

Agent Vigil answers a narrow question: **does the available deterministic
evidence support the agent's checkable narrative for this repository range?**

## In scope

- Fabricated or stale file-change claims.
- Missing paths and repository-boundary traversal.
- Claimed passing-test totals that disagree with runner output.
- Claimed commands absent from supported Claude Code or Codex trajectories.
- Exact repeated-tool-call loops.
- Common test/config weakening visible in the selected diff.
- Empty or insufficient evidence that would previously have passed vacuously.

## Out of scope

- Semantic correctness of product behavior.
- Whether a test suite adequately represents the specification.
- A malicious repository that controls its test script and output.
- A forged or truncated transcript presented as complete.
- Tool activity performed outside the captured transcript.
- Cryptographic identity, timestamp authority, or non-repudiation.
- Secrets already present in a transcript.

The receipt hash is a deterministic content identifier, not a signature. A
party that can rewrite both evidence and receipt can generate a new matching
hash.

## Execution boundary

Re-running tests executes repository code with the current process privileges.
In CI, do not run Agent Vigil with write-capable secrets on untrusted fork code.
Never construct `--test-cmd` from issue text, PR descriptions, commit messages,
or other untrusted strings.

Recommended GitHub permissions:

```yaml
permissions:
  contents: read
```

Use an isolated runner for hostile repositories. Agent Vigil is a verifier, not
a sandbox.

## Privacy

The verifier reads transcripts locally and emits only extracted claim snippets,
rule evidence, selected paths, and hashes. Claim snippets may still contain
sensitive text. Review receipts before publishing them.

## Reporting

Privately report a security issue through the contact route in
[SECURITY.md](../SECURITY.md). Do not attach a private transcript to a public
issue.
