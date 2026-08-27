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

To test installation, workflow generation, diagnosis, and the replay together
in one bounded run:

```bash
npm run build
npm run demo:60s
```

See [the 60-second proof contract](../docs/60_SECOND_DEMO.md) for exactly what
that result establishes.

## Cases

1. [A stale Action artifact converted malformed evidence into PASS](cases/01-stale-action-artifact.md)
2. [Development bytecode leaked into the npm tarball](cases/02-package-contamination.md)
3. [A receipt output symlink overwrote its target](cases/03-output-symlink.md)

The product claim is intentionally narrow: these cases show that the project
can publish its own failures with exact revisions and keep them as regression
controls. They do not establish a market-wide false-verdict rate.
