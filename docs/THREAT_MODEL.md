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
- Pull-request declarations attributed to a different author.
- Oversized or protected-path changes that violate base-anchored policy.
- Candidate regression tests that also pass against the selected base source.

## Out of scope

- Semantic correctness of product behavior.
- Whether a test suite adequately represents the specification.
- A malicious repository that controls its test script and output.
- A forged or truncated transcript presented as complete.
- Tool activity performed outside the captured transcript.
- Trusted timestamp authority or host integrity.
- Secrets already present in a transcript.
- Whether a human declaration is sincere or the linked issue is actually
  approved; maintainer mode verifies attribution and syntax only.
- Whether a base failure has the intended semantic cause unless policy pins a
  sufficiently specific `baseFailurePattern`.

The receipt hash is a deterministic content identifier, not a signature. A
party that can rewrite both evidence and receipt can generate a new matching
hash. Schema v2 optionally signs that hash with Ed25519. An embedded public key
is self-asserted; identity is established only when a verifier pins the public
key through a trusted channel. A valid signature still does not prove that the
captured transcript is complete or that the signing host was uncompromised.

Portable receipt v1 signs a smaller payload containing hashes, Git and policy
identity, summary counts, and signer identity. It deliberately omits transcript
text and detailed findings. The base policy must pin both `portableReceipt` and
`trustedSignerKeyIds`. The gate accepts either an exact signed head or a
descendant whose only changed path is the configured receipt. A later source or
policy change invalidates that binding.

## Policy integrity

A candidate change can edit a policy stored in its own worktree. GitHub Actions
should therefore pass the event base SHA as `policy-ref` so Agent Vigil loads
`.agent-vigil.json` from the trusted base commit. The generated `vigil init`
workflow does this automatically for both `pull_request` and `merge_group`,
checks out the exact event head, and rejects base/head or policy-ref inputs that
do not match the GitHub event payload. The first setup pull request
cannot use base anchoring because its base does not contain the policy; merge
the installation under ordinary review, then make the check required.

For merge queues, the event's composed head can differ from every individual
pull-request head. Agent Vigil verifies that exact composition, requires the
event base to be its ancestor, and reruns the base-policy test and integrity
lanes. The merge-group payload lacks a single PR body, so the queue phase does
not claim to re-verify PR-body attestations or portable signatures. Those remain
PR-phase checks. See [the merge-queue contract](MERGE_QUEUES.md).

## Execution boundary

For a commit-based receipt, Git-visible workspace state must match the selected
head SHA. The transcript, loaded policy, and signing key are explicit inputs and
may remain outside that tree; any other dirty path blocks PASS. `WORKTREE` has
no immutable tree identity and is therefore always INCONCLUSIVE. This protects
local runs from attributing test results to a commit that was not actually
executed. A fresh GitHub Actions checkout remains the preferred enforcement
environment.

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

Receipt, SARIF, and GitHub-summary output paths are treated as security
boundaries. Agent Vigil refuses direct symlinks, untrusted symlinked parent
components, and non-regular destinations. It writes complete content to an
exclusive temporary file in the destination directory, flushes it, and
atomically replaces the final path. POSIX files use mode `0600`; Windows files
inherit the parent ACL and therefore require a private output directory for
sensitive receipts. This prevents output redirection and
partial-file exposure for this filesystem class. It does not defend against a
privileged process that can mutate the directory concurrently or against code
executed by the selected test command.

Maintainer differential mode creates detached temporary worktrees for the exact
base and head commits. When `overlayChangedTests` is enabled, non-symlink
changed test artifacts from head are copied into the base worktree before the
trusted command runs. Both the optional setup command and test command come from
base-anchored policy. They execute code from both commits; run without secrets
and on disposable infrastructure. A base-fail/head-pass result demonstrates
that the configured command distinguishes these trees under the overlaid tests.
It does not prove the test represents the product requirement. Dependency or
setup failures are INCONCLUSIVE, and binary diff line counts are not guessed.

## Authority reconciliation boundary

Authority mode loads the task contract from `contract-ref` when supplied,
compares exact changed paths with its allow/deny patterns, and classifies raw
structured tool inputs into explicit effect classes. The generated GitHub
workflow pins `authority-contract-ref` to the event base SHA so a candidate
cannot widen its own authority contract.

This is post-execution reconciliation. It does not intercept system calls,
network requests, credentials, MCP traffic, or side effects. Transcript
adapters can only classify recorded tool calls. A compromised runtime or
incomplete vendor export can omit activity, and shell syntax can be more
expressive than the conservative classifier. Unknown actions, shell wrappers,
missing results, and narrative-only evidence therefore block PASS rather than
being treated as safe. A PASS says the exact Git result and **observed**
trajectory stayed within the contract; it does not prove that no unlogged
action occurred.

## Privacy

The full verifier reads transcripts locally and emits extracted claim snippets,
rule evidence, selected paths, and hashes. Those fields can contain sensitive
text. Portable receipt v1 omits them, but still exposes transcript and result
digests, Git identity, summary counts, and the signing public key. Choose the
artifact whose disclosure is acceptable and review it before publishing.

The portable gate does not make the signer independent. If the authoring agent
can read or invoke the private key, it may be able to sign its own report. Keep
operator keys outside the agent's scope when separation matters. The fresh CI
test and integrity scan are independent of the local transcript verdict, but
they do not reconstruct private claim evidence.

## Reporting

Privately report a security issue through the contact route in
[SECURITY.md](../SECURITY.md). Do not attach a private transcript to a public
issue.
