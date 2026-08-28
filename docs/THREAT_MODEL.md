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
- Pull-request declarations attributed to a different author when human review
  mode is selected.
- Oversized or protected-path changes that violate base-anchored policy.
- Candidate regression tests that also pass against the selected base source.
- Automated-review commands that fail, time out, move `HEAD`, or change tracked
  files in the isolated candidate checkout.

## Out of scope

- Semantic correctness of product behavior.
- Whether a test suite adequately represents the specification.
- A malicious repository that controls its test script and output.
- A forged or truncated transcript presented as complete.
- Tool activity performed outside the captured transcript.
- Trusted timestamp authority or host integrity.
- Secrets already present in a transcript.
- Whether a human declaration is sincere or the linked issue is actually
  approved. Human mode verifies attribution and syntax only. Automated mode
  records repeatable technical checks and does not claim human understanding.
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

A candidate change can edit policy and workflow files stored in its own
worktree. The v0.21.2 generated workflow is therefore selected from the base
branch through `pull_request_target`. It passes the event base SHA as
`policy-ref`, checks out the exact event head without persisted credentials,
and rejects base, head, policy, Action, event, or workspace inputs that do not
match the immutable snapshot. The first setup pull request cannot use base
anchoring because its base does not contain the policy; merge the installation
under ordinary review before relying on its evidence.

That evidence is not enforceable merely because branch protection requires a
job named `Agent Vigil evidence`. GitHub's plain required-status selection does
not bind the name to the intended workflow or event. Use an organization or
enterprise required-workflow ruleset, or an external GitHub App that validates
the exact head and evidence source.

The continuity Action adds two bindings. It compares the downloaded history
with the exact commit named by the selected evidence run, and it reads
`.agent-vigil-continuity.json` from the base commit recorded in the signed
receipt. The generated workflow runs Agent Vigil and its supporting Actions at
full commit IDs. It does not execute repository commands before the continuity
decision. Its second job is skipped unless the decision is `CURRENT`.

The generated continuity policy has empty trusted-key lists. This is deliberate:
installation alone cannot authorize deployment. A repository owner must obtain
the public keys separately, add their IDs under normal review, and commit the
policy before a signed history can become `CURRENT`.

The generated repository workflow does not handle `merge_group`. A
repository-owned merge-group workflow is candidate-selected and cannot be the
trusted source of its own merge decision. The low-level merge-group verifier is
available only for an externally controlled required workflow or App that
binds the exact composed head. The merge-group payload also lacks one pull
request's complete evidence context, so an external integration must not
fabricate PR-body or portable-signature evidence. See
[the merge-queue contract](MERGE_QUEUES.md).

## Execution boundary

For a commit-based receipt, Git-visible workspace state must match the selected
head SHA. The transcript, loaded policy, and signing key are explicit inputs and
may remain outside that tree; any other dirty path blocks PASS. `WORKTREE` has
no immutable tree identity and is therefore always INCONCLUSIVE. This protects
local runs from attributing test results to a commit that was not actually
executed. A fresh GitHub Actions checkout remains the preferred enforcement
environment.

Local test, setup, and automated-review commands execute repository code with
the current process's host privileges. A detached worktree binds Git identity;
it does not isolate processes, files, credentials, descendants, or the network.
Never construct `--test-cmd` from issue text, PR descriptions, commit messages,
or other untrusted strings.

The v0.21.2 generated hosted lane instead requires a GitHub-hosted Linux runner
and runs repository commands in fixed candidate-only Docker invocations. The
candidate receives no GitHub token, OIDC, signing, or write authority. A
base-owned `npm ci --ignore-scripts` setup may use network and a writable mount;
tests use a read-only source mount without network. This boundary supports only
plain repositories and root Node/npm repositories with a bounded direct
`node --test` command. Unsupported shapes fail closed.

Recommended GitHub permissions:

```yaml
permissions:
  contents: read
```

Use the generated hosted lane or a separately reviewed isolation system for
hostile repositories. The local CLI is a verifier, not a sandbox. The Docker
daemon, hosted runner, reviewed Action commit, pinned image, event payload, and
base branch remain in the hosted trusted computing base.

### Upgrade Guard containment

Upgrade Guard is a distinct local execution lane. It does not reuse the normal
test-command or detached-worktree paths as a sandbox. It inventories two
regular, non-symlink artifact trees, requires a locally present OCI image named
by its exact SHA-256 digest, and invokes Docker with fixed argv rather than a
shell. It accepts only an endpoint whose transport is a Unix socket or Windows
named pipe and resolves the client from a fixed platform location or an
explicit absolute path rather than the caller's `PATH`. This is not endpoint or
binary provenance: a local socket can proxy another daemon, and an explicitly
selected binary remains operator-trusted. Target and canary directories plus
the container root are read-only;
networking is disabled; Linux capabilities are dropped; `no-new-privileges`
and a non-root UID/GID are set; and PID, CPU, memory, time, output, and tmpfs
bounds apply. Every probe and trial receives a random addressable container
name; the deadline uses a hard client kill, followed by force-removal and an
absence check for that exact container.

A planted preflight checks the enforcement boundary before canaries run. The
current, candidate, and canary roots must be pairwise disjoint. Their complete
regular-file trees, including modes, plus the loaded configuration are bound to
the receipt; the three trees are re-inventoried after execution and mutation is
`HOLD`. At evaluation entry, a fresh trusted config read must have stable
device/inode identity and canonically equal the caller's validated snapshot.
After execution, its canonical path, device/inode identity, and canonical
validated content must match the entry checkpoint or the verdict is `HOLD`.
This bounded double-read does not detect a same-host ABA restored between
checkpoints or defeat privileged filesystem races. The planted probe
attempts target and root writes, a direct network connection, inherited-secret
access, and upper/lower-case proxy injection. A missing image, unavailable
daemon, failed probe, timeout, malformed output, unstable repeat, unhealthy
baseline, ambiguous identity, or missing canary evidence is `HOLD`, never
`SAFE`. `CHANGED` means comparable evidence found a configured material
difference; it is not a claim that the candidate is worse.

One canonical executable, accepted local-transport endpoint, and sanitized
environment tuple is resolved for the full evaluation. Image inspection,
preflight, trials, forced cleanup, and absence checks all use its explicit
`--host`; ambient endpoint/context/TLS selectors are removed from the child
environment. The Docker client, daemon, local socket/pipe routing, host kernel
or virtualization layer, exact runner image, and trusted canary code remain in
the trusted computing base. A local socket can proxy another daemon, and a
privileged same-host actor can change what the pinned path reaches. A malicious
candidate may attempt to interfere with a poorly designed canary, and a
container escape can invalidate the boundary. The first version therefore
supports only offline, already-materialized artifacts and remains outside the
GitHub Action. It does not establish live provider, model-alias, authentication,
latency, payment, or production behavior.

The private receipt carries exact local evidence commitments, including the
configuration and canary-harness tree digests, plus a random nonce. The optional
signed public entry omits repository identity, paths,
commands, prompts, raw output, environment data, file names, and canary names
unless the user opts into a public ID. A non-public canary label is represented
by a receipt-specific nonce-bound pseudonym rather than a stable unsalted hash.
It still exposes component identity,
version pairs, artifact hashes, containment facts, signer key, and limitations.
An embedded key proves self-consistency only; `upgrade index` requires a
separately pinned public key before accepting entries.

Receipt containment and public runner evidence carry `localEndpoint`; runtime
validation and both v1 schemas require it to be `true` for `SAFE`. The exact
endpoint is omitted. The boolean establishes that the accepted local transport
was bound for the evaluation, not that the client or daemon is authentic or
that the daemon is physically local.

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

The GitHub continuity importer verifies the webhook body with the configured
HMAC secret before it writes a record. It then checks the repository, exact
commits, event shape, and explicit link label. The stored record omits the body,
repository name, path, secret, signature header, and issue text. A valid HMAC
shows that the body matches the configured secret. It does not establish that
GitHub sent the request if the secret or receiving machine was compromised.
An incident link records association only and does not claim causation.

## Continuity staple boundary

A continuity staple is a signed, short-lived projection of one verified local
continuity decision. The issuer binds the exact subject, policy bytes,
environment, chain tip, sequence, and decision hash. The verifier requires an
independently pinned Ed25519 key plus the expected head, environment, and policy
hash. A mismatched key, signature, subject, policy, environment, chain tip, or
minimum sequence fails closed.

The staple does not contact an online status service. An offline verifier
cannot learn that a newer revocation exists while an older signed `CURRENT`
staple is still inside its lifetime unless the caller also pins a newer chain
tip or minimum sequence. The format limits this replay window to at most 15
minutes; the default is five minutes. A high-consequence caller should obtain
the newest staple from an independent channel and persist the highest accepted
sequence. Expiry turns an earlier `CURRENT` into `EXPIRED`, never into a new
approval. An embedded `REVOKED` result remains `REVOKED` even after expiry.

The signing key is an authority boundary. If the change author or deployment
job can invoke it, they can mint a fresh statement for any locally computed
decision. Keep the private key outside both scopes. The staple proves the
authority signed these status fields; it does not prove the authority host,
source observers, or signing key were uncompromised, and it does not prove the
code is defect-free.

## Reporting

Privately report a security issue through the contact route in
[SECURITY.md](../SECURITY.md). Do not attach a private transcript to a public
issue.
