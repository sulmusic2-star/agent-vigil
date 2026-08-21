# Case 02: development bytecode entered the package

## What was claimed

The v0.6 candidate reported a dry-run package with zero runtime dependencies in
the public [PR #9 description](https://github.com/sulmusic2-star/agent-vigil/pull/9).

## What the gate caught

The pre-release package inspection found locally generated
`scripts/__pycache__/*.pyc` in the tarball. `package.json` allowlisted the entire
`scripts` directory, so the package depended on the publisher's local filesystem
state even though the runtime had no npm dependencies.

- Candidate release tree: `02057bc0ee62284d83356da80c8e61b3347f6a1a`
- Candidate source commit: `8307eba6746d332a653adf58edbd9cafad11a932`
- Corrective source commit: `4c505311340e7fd2bc63c5dccd39d78739dc0f12`
- Corrected release tree: `5b985e68bc27bc17b79e8dc2f22379a6a9ff3d09`
- Public fix record: [PR #10](https://github.com/sulmusic2-star/agent-vigil/pull/10)

## Maintainer disposition

Release blocked. The broad `scripts` allowlist was replaced with the one runtime
script intentionally distributed. Package smoke tests now scan for
`__pycache__`, `.pyc`, and `node_modules` paths.

## Corrected result

The release package contained no generated Python bytecode, dependency trees,
or development-only lab scripts. v0.6.0 was created only from the corrected
tree.

## Limit

This is package-hygiene evidence, not proof that npm itself has published or
verified the package. Registry publication is a separate state.
