# Install Agent Vigil in five minutes

An npm sign-in is not required. Agent Vigil v0.23.0 is available from its
immutable GitHub release. The npm registry separately reports version 0.21.1;
npm publication of v0.23.0 is not claimed.

## Prepare and verify the repository gate

Run these commands from the root of a Git repository. Agent Vigil can infer a
bounded direct Node test command such as `node --test test/*.test.js`; other
toolchains require an explicit hermetic runner and test command:

```bash
AGENT_VIGIL_PACKAGE=https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.0/sulmusic-agent-vigil-0.23.0.tgz

npx --yes "$AGENT_VIGIL_PACKAGE" protect

git status --short
```

The inferred v0.23.0 Node/npm path accepts this deliberately narrow test shape. It does
not execute npm wrappers or infer a protected test command in a repository
without a root `package.json`. If no safe direct command can be inferred,
`protect` leaves `REPLACE_WITH_TEST_COMMAND` in the prepared policy and
`doctor` fails closed instead of claiming the gate is ready.

For Python, Rust, Go, Java, Ruby, PHP, .NET, pnpm, Yarn, Bun, or another
non-inferred layout, select the immutable common runner and provide the bounded
test command yourself:

```bash
npx --yes "$AGENT_VIGIL_PACKAGE" protect --repo . \
  --runner common \
  --test-cmd "python3 -m pytest -q"
```

The common image contains the toolchains, not your project dependencies. Test
execution remains networkless. Use `--runner-image` with an organization-owned
digest-pinned image when dependencies must be preinstalled.

Review the generated controls before committing them. An explicit hermetic
runner adds the fifth file shown below:

```text
.agent-vigil.json
.agent-vigil-runner.json (only with --runner or --runner-image)
.github/pull_request_template.md
.github/workflows/agent-vigil.yml
.github/workflows/agent-vigil-outcomes.yml
```

Commit only after the policy and workflow commands match the repository:

```bash
git add .agent-vigil.json .github/pull_request_template.md \
  .github/workflows/agent-vigil.yml \
  .github/workflows/agent-vigil-outcomes.yml
if [ -f .agent-vigil-runner.json ]; then
  git add .agent-vigil-runner.json
fi
git commit -m "Install Agent Vigil"

npx --yes "$AGENT_VIGIL_PACKAGE" doctor
```

`doctor` fails its readiness checks while the controls are uncommitted because
the hosted inputs are bound to committed `HEAD`. A passing post-commit `doctor`
verifies the installed files. It does not make the check required in GitHub.
Configure an externally trusted required workflow or App check before treating
the result as merge or deployment enforcement.

The package selects and prints the immutable reviewed Action commit embedded in
the release, so this normal path does not require the user to find a SHA. An
explicit `--action-sha` remains available for a separately reviewed override.

A fresh disposable Node-repository measurement of this exact `protect`, commit,
and `doctor` path was 3.15 seconds on August 28, 2026. Network and package-cache
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

Download `sulmusic-agent-vigil-0.23.0.tgz` from the
[v0.23.0 release](https://github.com/sulmusic2-star/agent-vigil/releases/tag/v0.23.0),
then run:

```bash
shasum -a 256 sulmusic-agent-vigil-0.23.0.tgz
```

The expected SHA-256 digest is:

```text
bf6303c18e1de85c19fe5df7b5fc2401451a14a4a92999cf7c6385304e8242d0
```

## npm registry status

The newest registry version observed on August 30, 2026 was v0.21.1:

```bash
npx --yes @sulmusic/agent-vigil@0.21.1 --help
```

Use the GitHub v0.23.0 package above when the current release is required. Do
not request registry v0.23.0 until npm publishes it.

## Pin the GitHub Action

Pin the released commit instead of a moving tag:

```yaml
- uses: sulmusic2-star/agent-vigil@eed2cd0db000099f86d29186bdb2fd1c7784356a
```

The Action executes the bundled `dist/cli.js` from that commit. It does not
install Agent Vigil from the npm registry.

## Remove it

Agent Vigil does not require a hosted account. Remove the generated control files
to uninstall it. Review and remove any matching required-check or ruleset entry
as a separate step. Otherwise, the repository can retain an impossible
required check.

## Verified distribution state

The facts below were checked on August 30, 2026:

- GitHub release v0.23.0 is public and installable.
- The public package SHA-256 is recorded above.
- The npm registry reports version 0.21.1. npm publication of v0.21.1 is
  public and separately verified; publication of v0.23.0 is not claimed.
- Outside installation, repeat use, protected-action stops, payment, and
  revenue require separate evidence.

Machine-readable details are in
[`public-install-state.json`](public-install-state.json).
