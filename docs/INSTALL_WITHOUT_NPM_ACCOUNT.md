# Install Agent Vigil in five minutes

An npm sign-in is not required. Agent Vigil v0.22.0 is available from its
immutable GitHub release. The npm registry separately reports version 0.21.1;
npm publication of v0.22.0 is not claimed.

## Prepare and verify the repository gate

Run these commands from the root of a Git repository:

```bash
AGENT_VIGIL_PACKAGE=https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz

npx --yes "$AGENT_VIGIL_PACKAGE" protect

git status --short
```

Review these four generated controls before committing them:

```text
.agent-vigil.json
.github/pull_request_template.md
.github/workflows/agent-vigil.yml
.github/workflows/agent-vigil-outcomes.yml
```

Commit only after the policy and workflow commands match the repository:

```bash
git add .agent-vigil.json .github/pull_request_template.md \
  .github/workflows/agent-vigil.yml \
  .github/workflows/agent-vigil-outcomes.yml
git commit -m "Install Agent Vigil"

npx --yes "$AGENT_VIGIL_PACKAGE" doctor
```

`doctor` intentionally reports HOLD while the controls are uncommitted. A
passing post-commit `doctor` verifies the installed files. It does not make the
check required in GitHub. Configure an externally trusted required workflow or
App check before treating the result as merge or deployment enforcement.

The package selects and prints the immutable reviewed Action commit embedded in
the release, so this normal path does not require the user to find a SHA. An
explicit `--action-sha` remains available for a separately reviewed override.

A fresh disposable-repository measurement of this exact `protect`, commit, and
`doctor` path was 3.05 seconds on August 28, 2026. Network and package-cache
state will affect another machine's time.

## Run the continuity proof

This harmless local demonstration deploys nothing:

```bash
npx --yes "$AGENT_VIGIL_PACKAGE" continuity demo --json
```

It shows the intended sequence:

```text
PASS -> CURRENT -> REVOKED -> REVOKED -> CURRENT
```

A later ordinary green check cannot erase the revocation. Only independent
signed remediation aimed at that revocation restores permission.

## Verify the release package

Download `sulmusic-agent-vigil-0.22.0.tgz` from the
[v0.22.0 release](https://github.com/sulmusic2-star/agent-vigil/releases/tag/v0.22.0),
then run:

```bash
shasum -a 256 sulmusic-agent-vigil-0.22.0.tgz
```

The expected SHA-256 digest is:

```text
2beaba44fb5988d04b25605462a81c1bc0d4d229bcd0b2ba0852e2d2f32de7eb
```

## npm registry status

The newest registry version observed on August 28, 2026 was v0.21.1:

```bash
npx --yes @sulmusic/agent-vigil@0.21.1 --help
```

Use the GitHub v0.22.0 package above when the current release is required. Do
not request registry v0.22.0 until npm publishes it.

## Pin the GitHub Action

Pin the released commit instead of a moving tag:

```yaml
- uses: sulmusic2-star/agent-vigil@5925e8bcbaf97f08c8c840252f486e96bf3f9775
```

The Action executes the bundled `dist/cli.js` from that commit. It does not
install Agent Vigil from the npm registry.

## Remove it

Agent Vigil does not require a hosted account. Remove the four generated files
to uninstall it. Review and remove any matching required-check or ruleset entry
as a separate step. Otherwise, the repository can retain an impossible
required check.

## Verified distribution state

The facts below were checked on August 28, 2026:

- GitHub release v0.22.0 is public and installable.
- The public package SHA-256 is recorded above.
- The npm registry reports version 0.21.1. npm publication of v0.21.1 is
  public and separately verified; publication of v0.22.0 is not claimed.
- Outside installation, repeat use, protected-action stops, payment, and
  revenue require separate evidence.

Machine-readable details are in
[`public-install-state.json`](public-install-state.json).
