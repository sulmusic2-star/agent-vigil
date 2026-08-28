# Install without an npm account

An npm sign-in is not required to use the public GitHub release or GitHub
Action. The npm registry package is a separate distribution path.

## Run the public release

Agent Vigil v0.21.1 is attached to its immutable GitHub release:

```bash
npx --yes \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.1/sulmusic-agent-vigil-0.21.1.tgz \
  --help
```

The release package has this SHA-256 digest:

```text
19084c6981b19d60b89f902a8583f1f1db955fdcb71be3e3449db44fd5eeed91
```

Verify a downloaded copy before using it:

```bash
shasum -a 256 sulmusic-agent-vigil-0.21.1.tgz
```

The reported digest must match the value above.

## Use the TypeScript library

The same package provides the continuity library without npm account
credentials:

```bash
npm install --save-exact \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.21.1/sulmusic-agent-vigil-0.21.1.tgz
```

This uses the local npm client as a downloader. It does not require registry
publication or an npm sign-in.

## Pin the GitHub Action

Pin the released commit instead of a moving tag:

```yaml
- uses: sulmusic2-star/agent-vigil@963f9070be9ac5e8e5cdf0b58ea703f151dba748
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

- GitHub release v0.21.1 is public and installable.
- The public package SHA-256 is recorded above.
- The npm registry reports version 0.21.1.
- npm publication of v0.21.1 is public and separately verified as
  `@sulmusic/agent-vigil@0.21.1`.
- Outside installation, payment, and revenue require separate evidence.

Machine-readable details are in
[`public-install-state.json`](public-install-state.json).
