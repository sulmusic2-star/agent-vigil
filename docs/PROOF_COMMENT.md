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
content hash, recorded base and head identifiers, Git tree, policy digest, and summary
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

The first view shows the outcome and, for supported rules, a short reason and
the existing recommended next action. It reuses the shared result model rather
than interpreting evidence with a model. Only fixed rule descriptions and
passing-test counts are shown; raw finding titles, evidence, repository-specific
commands, paths, transcripts and test output stay in the retained receipt.
An unknown rule directs the reader to that receipt instead of guessing.

For example, a count mismatch can show:

```text
Agent Vigil: FAIL
Do not merge yet.
Why: The reported passing-test count does not match the observed count.
Passing tests — claimed: 184; observed: 161.
Next: Run the configured test command without truncating its output, then
report the observed passing count exactly.
```

These numbers illustrate the format, not a measured customer incident.
Receipt details retain the revision, policy, content identity, evidence counts,
differential checks, integrity contradictions and authority contradictions.
The first issue is not the complete list. No finding is cleared, suppressed or
treated as already reviewed. A check that could not be verified is not described
as a command that never ran. Policy-permitted unknowns do not turn a passing
required result into a failure.

The renderer does not know the current GitHub event or authorize a merge. The
caller must compare the receipt with the expected base/head and trusted policy
before using it for that event. A valid content hash is not proof of freshness
or a trusted signer. Precise file-and-line comments still require source
locations bound structurally into the receipt; this public view does not infer
them from prose.

## GitHub Actions summary

The Action's `--github-summary` path uses the same safe reason and next action.
Those details appear in the Actions job summary; the public App check links to
that run. The App's top-level check title and short summary are unchanged.
This does not post a second comment or change any check's result.

## Deployment boundary

The safe first distribution path leaves repository code execution in the
customer's existing GitHub Actions job. A comment-only GitHub App can later
verify and upsert the resulting receipt without checking out or executing pull
request code. Running arbitrary candidate repositories in a hosted service is
a separate isolation product and is not part of this command.

The comment states measured evidence. It does not accuse an author or agent of
lying, cheating, or faking work, and a `PASS` does not claim that the code is
bug-free.
