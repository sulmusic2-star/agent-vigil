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

Receipt, SARIF, and GitHub-summary output refuses symbolic links, symlinked
untrusted parent components, and non-regular destinations. Output is prepared
in an exclusive temporary file and atomically replaces the final path. POSIX
files use mode `0600`; Windows files inherit the destination directory ACL, so
sensitive output needs a private directory. This protects the output boundary;
it does not sandbox repository code.

## Upgrade Guard containment

The unreleased `vigil upgrade` lane is separate from repository test execution.
It accepts only exact-digest OCI runner identities already present locally and
uses fixed Docker argv with no shell, no network, read-only target, canary, and
root filesystems, dropped capabilities, `no-new-privileges`, non-root
execution, and bounded PID, CPU, memory, time, output, and tmpfs resources.
Current, candidate, and canary roots must be pairwise disjoint. Their regular
files and mode bits are committed before execution and re-inventoried afterward;
concurrent mutation is `HOLD`. Before any canary runs, a planted probe must prove that target and root writes
and a direct network attempt are blocked, a host probe secret is absent, and
Docker proxy injection is cleared. Any missing control returns `HOLD`.

Docker, its daemon or virtualization layer, the host kernel, the digest-pinned
runner image, and the canary harness remain trusted. Do not mount the Docker
socket or credentials. Public compatibility output is opt-in, requires an
Ed25519 key, and still exposes component, version, artifact-digest, and signer
identities; review it before disclosure. Upgrade Guard is not enabled in the
GitHub Action.
