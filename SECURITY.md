# Security policy

## Supported version

Security fixes target the latest release and `main`.

## Report privately

Use the contact link on [Tim Sullivan's page](https://lastingground.com/tim) and
include `agent-vigil security` in the subject. Do not post transcripts, tokens,
private repository paths, or proof-of-concept secrets in a public issue.

## Safe use

Agent Vigil executes the selected repository's test command. Run untrusted code
on an isolated runner with read-only GitHub permissions and no deployment,
package, cloud, or signing credentials.
