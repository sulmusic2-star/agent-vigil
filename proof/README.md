# Public failure corpus

This directory records failures found while Agent Vigil was being built and
dogfooded. Every case names the public source revision, the evidence that stopped
the release, the maintainer disposition, and the corrected result.

These are **first-party historical cases** from the Agent Vigil repository. They
are not external adoption, customer evidence, or maintainer-accepted
contradictions. Run the bounded replay:

```bash
npm run proof:historical
```

The replay writes `proof/results.json`. Minimal snapshots under `proof/fixtures`
must match the named historical Git blob IDs before they are used. The replay
does not fetch private transcripts or execute code from an external repository.

## Cases

1. [A stale Action artifact converted malformed evidence into PASS](cases/01-stale-action-artifact.md)
2. [Development bytecode leaked into the npm tarball](cases/02-package-contamination.md)
3. [A receipt output symlink overwrote its target](cases/03-output-symlink.md)

The product claim is intentionally narrow: these cases show that the project
can publish its own failures with exact revisions and keep them as regression
controls. They do not establish a market-wide false-verdict rate.

## Pre-registered external frequency test

[`first-100/`](first-100/) contains the signed sampling frame frozen before R0.
It is separate from these first-party historical cases and currently contains
zero external pair entries. Run `node proof/first-100/verify.mjs` to authenticate
the exact registration and confirm the empty-ledger boundary.
