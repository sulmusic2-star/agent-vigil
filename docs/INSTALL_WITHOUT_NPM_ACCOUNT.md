# Install without an npm account

An npm sign-in is not required to use the public GitHub release or GitHub
Action. The npm registry package is a separate distribution path.

## Run the public release

Agent Vigil v0.22.0 is attached to its immutable GitHub release:

```bash
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz \
  --help
```

The release package has this SHA-256 digest:

```text
2beaba44fb5988d04b25605462a81c1bc0d4d229bcd0b2ba0852e2d2f32de7eb
```

Verify a downloaded copy before using it:

```bash
shasum -a 256 sulmusic-agent-vigil-0.22.0.tgz
```

The reported digest must match the value above.

## Use the TypeScript library

The same package provides the continuity library without npm account
credentials:

```bash
npm install --save-exact \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz
```

This uses the local npm client as a downloader. It does not require registry
publication or an npm sign-in.

## Pin the GitHub Action

Pin the released commit instead of a moving tag:

```yaml
- uses: sulmusic2-star/agent-vigil@5925e8bcbaf97f08c8c840252f486e96bf3f9775
```

The Action executes the bundled `dist/cli.js` from that commit. It does not
install Agent Vigil from the npm registry.

## Remove it

Agent Vigil does not require a hosted account. Remove the generated workflows
and the files created by `init` to uninstall it from a repository.

Remove any matching required-check or ruleset entry after reviewing the
workflow deletion. Otherwise, the repository can retain an impossible required
check.

## Verified distribution state

The facts below were checked on August 28, 2026:

- GitHub release v0.22.0 is public and installable.
- The public package SHA-256 is recorded above.
- The npm registry reports version 0.21.1.
- npm publication of v0.21.1 is public and separately verified as
  `@sulmusic/agent-vigil@0.21.1`.
- Outside installation, payment, and revenue require separate evidence.

Machine-readable details are in
[`public-install-state.json`](public-install-state.json).
