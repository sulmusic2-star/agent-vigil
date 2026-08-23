# Proof comment

`vigil proof-comment` renders one deterministic pull-request comment from an
intact full Agent Vigil receipt:

```bash
vigil proof-comment agent-vigil-report.json > proof-comment.md
```

The output contains one stable hidden marker:

```text
<!-- agent-vigil-proof-comment:v1 -->
```

A GitHub Action or App can find the comment by that marker and edit it after a
new push instead of adding another comment. The command validates the receipt's
content hash, exact base and head commits, Git tree, policy digest, and summary
before rendering. An invalid embedded signature is also rejected; an unsigned
receipt is labeled as content-hash-only, while a valid embedded signature is
labeled self-asserted until its key is pinned through a trusted channel. The
command exits `2` for an invalid or tampered receipt. A valid
receipt renders successfully even when its decision is `FAIL` or
`INCONCLUSIVE`; the evidence gate, not this presentation command, controls the
merge result.

An optional hosted verification link must be HTTPS:

```bash
vigil proof-comment agent-vigil-report.json \
  --verify-url https://verify.example.test/receipts/<digest> \
  --output proof-comment.md
```

The first format is intentionally aggregate-only. It reports exact revision,
policy, receipt identity, evidence counts, candidate-only differential checks,
tests that also pass on base, integrity contradictions, and authority
contradictions. It does not copy raw evidence, commands, paths, transcripts, or
test output into the comment. Precise file-and-line comments require a future
receipt schema that binds structured source locations into the receipt hash;
the renderer will not infer locations by parsing prose.

## Deployment boundary

The safe first distribution path leaves repository code execution in the
customer's existing GitHub Actions job. A comment-only GitHub App can later
verify and upsert the resulting receipt without checking out or executing pull
request code. Running arbitrary candidate repositories in a hosted service is
a separate isolation product and is not part of this command.

The comment states measured evidence. It does not accuse an author or agent of
lying, cheating, or faking work, and a `PASS` does not claim that the code is
bug-free.
