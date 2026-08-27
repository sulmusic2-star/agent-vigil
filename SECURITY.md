# Security policy

## Supported version

Security fixes target the latest release and `main`.

## Report privately

Use the contact link on [Tim Sullivan's page](https://lastingground.com/tim) and
include `agent-vigil security` in the subject. Do not post transcripts, tokens,
private repository paths, or proof-of-concept secrets in a public issue.

## Safe use

Agent Vigil executes the selected repository's test command and any setup or
automated-review commands named by the trusted base policy. The detached Git
worktree protects commit identity; it is not a security sandbox. Run untrusted
code on an isolated runner with read-only GitHub permissions and no deployment,
package, cloud, or signing credentials.

The v0.21.0 generated hosted lane is narrower. It is selected from the base
branch through `pull_request_target`, checks out the exact pull-request head
without persisted credentials, and passes no token, OIDC, signing, or write
authority to candidate verification. Repository-controlled setup and tests run
only on a GitHub-hosted Linux runner in the fixed candidate-only Docker path.
Setup receives network only for base-owned `npm ci --ignore-scripts`; tests use
a read-only source mount and no network. Docker, the runner, the pinned image,
the reviewed Action commit, GitHub's event payload, and the base branch remain
trusted.

Generated `init` and `protect` workflows require
`--action-sha <reviewed-full-commit>` and support only plain repositories or
root Node/npm repositories with a bounded direct `node --test` command.
Unsupported hosted shapes fail closed. See the
[hosted security contract](docs/HOSTED_SECURITY_CONTRACT.md).

Receipt, SARIF, and GitHub-summary output refuses symbolic links, symlinked
untrusted parent components, and non-regular destinations. Output is prepared
in an exclusive temporary file and atomically replaces the final path. POSIX
files use mode `0600`; Windows files inherit the destination directory ACL, so
sensitive output needs a private directory. This protects the output boundary;
it does not sandbox repository code.

## GitHub enforcement and signing boundary

Candidate-executing workflows cannot use receipt attestation in v0.21.0.
`init --attest` and `protect --attest` fail closed. Keyless signing is confined
to the separate Control Proof workflow, which runs planted non-candidate
challenges and does not execute pull-request code.

A plain required status check binds a context or job name, not the expected
workflow and event identity. A candidate can imitate that name. Requiring
`Agent Vigil evidence` by name alone is therefore not an enforceable security
boundary. Use an organization or enterprise required-workflow ruleset, or an
external GitHub App exact-head check. The generated repository workflow does
not claim `merge_group` enforcement.

The generated outcome workflow is read-only and executes no candidate code. It
records only a completed `workflow_run` snapshot. It does not guarantee later
merge, close, revert, incident, payment, or revenue observation.

## Upgrade Guard containment

The `vigil upgrade` lane is separate from repository test execution.
It accepts only exact-digest OCI runner identities already present locally and
uses fixed Docker argv with no shell, no network, read-only target, canary, and
root filesystems, dropped capabilities, `no-new-privileges`, non-root
execution, and bounded PID, CPU, memory, time, output, and tmpfs resources.
The Docker endpoint must use a syntactically local Unix-socket or Windows
named-pipe transport. The client is resolved from fixed platform locations or
an explicit absolute path instead of `PATH`. This is not provenance proof: an
operator-selected client remains trusted, and a local socket or pipe can proxy
a daemon running elsewhere.

Current, candidate, and canary roots must be pairwise disjoint. Their regular
files and mode bits are committed before execution and re-inventoried afterward;
concurrent mutation is `HOLD`. At evaluation entry, the config path is
re-resolved and read with stable device/inode identity, and its canonical value
must equal the CLI-supplied validated snapshot. After trials, its canonical
path, device/inode identity, and canonical validated content must still match;
otherwise the verdict is `HOLD`. These are bounded checkpoints, not continuous
immutability: same-host ABA or privileged filesystem races that restore the
observed state between checkpoints remain outside the proof. Before any canary
runs, a planted probe must prove that target and root writes and a direct
network attempt are blocked, a host probe secret is absent, and Docker proxy
injection is cleared. Any missing control returns `HOLD`.

One Docker executable, accepted local-transport endpoint, and sanitized
environment tuple is resolved for the complete evaluation. Every image,
preflight, trial, cleanup, and absence-check call uses an explicit `--host`
argument from that tuple; ambient Docker endpoint/context/TLS selectors are
removed from its child environment. Private receipt containment and public
runner evidence record `localEndpoint`; `SAFE` requires it to be `true` in both
runtime validation and the v1 schemas. The endpoint string is omitted. This
boolean proves only that the accepted local transport was bound, not physical
daemon locality. Docker, its client, daemon or virtualization layer, local
socket/pipe routing, host kernel, digest-pinned runner image, and canary harness
remain trusted. Do not mount the Docker socket or credentials. Public
compatibility output is opt-in, requires an Ed25519 key, and still exposes
component, version, artifact-digest, and signer identities; review it before
disclosure. Upgrade Guard is not enabled in the GitHub Action.
