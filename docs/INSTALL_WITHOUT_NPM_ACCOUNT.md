# Install Agent Vigil v0.24.2 without npm

This guide is an immutable snapshot for v0.24.2. It does not claim that v0.24.2
is still the newest release or that npm currently serves it.

v0.24.2 is a source release candidate until GitHub lists both the package and checksum assets.
Do not run the candidate commands until both assets exist.

## Verify the GitHub package

Open the [v0.24.2 release page](https://github.com/sulmusic2-star/agent-vigil/releases/tag/v0.24.2). Do not continue unless it contains both
`sulmusic-agent-vigil-0.24.2.tgz` and
`sulmusic-agent-vigil-0.24.2.tgz.sha256`.

```bash
curl -fLO \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.2/sulmusic-agent-vigil-0.24.2.tgz
curl -fLO \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.2/sulmusic-agent-vigil-0.24.2.tgz.sha256
shasum -a 256 -c sulmusic-agent-vigil-0.24.2.tgz.sha256
npx --yes ./sulmusic-agent-vigil-0.24.2.tgz protect --repo .
```

A successful `protect` run prints a `doctor` command that uses this same
immutable v0.24.2 GitHub package. It does not depend on npm publication.

## One setup pull request

`protect` writes the policy and workflows, then runs a disposable rehearsal.
Review the generated files, commit them, and open one setup pull request. After
that setup merges, run the printed `doctor` command. Then open a normal code
pull request. The check says:

- `PASS` — ready to merge under the base-owned policy;
- `FAIL` — do not merge yet;
- `NOT CHECKED` — no decision because required evidence did not run or could
  not be bound to the current commit.

## Non-Node repositories

The automatic path recognizes a narrow root Node/npm layout. Other toolchains
use the immutable common runner and an explicit command:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.2/sulmusic-agent-vigil-0.24.2.tgz protect --repo . \
  --runner common \
  --test-cmd "python3 -m pytest -q"
```

The common image contains Node, Python, Rust, Go, Java, Ruby, PHP, .NET, pnpm,
Yarn, and Bun. It does not fetch project dependencies during the networkless
test phase. Use a reviewed organization-owned `--runner-image` when the project
needs dependencies preinstalled.

## npm boundary

Use npm only if this query returns `0.24.2`:

```bash
npm view @sulmusic/agent-vigil version
```

The current cross-channel record lives on the default branch in
[`public-install-state.json`](https://github.com/sulmusic2-star/agent-vigil/blob/main/docs/public-install-state.json). This packaged guide deliberately does not copy that changing state.

The verified public GitHub package is
`https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.1/sulmusic-agent-vigil-0.24.1.tgz`
from commit `ccf2cae545e910e1ea27eb8b9746302879fd645d`, with SHA-256
`87f6cef0bc6194ec9785bf359c6d4c7c8e5d9c1a2ac3133d694d3e08956f1ced`.
At the verification time recorded in `public-install-state.json`, npm served
v0.24.1 with registry integrity
`sha512-WucBmWgKjYim1GEwNGtvY/LZu5VxxmiKG5BcxT5+ZQ7B8QltTvfhmfMeRz5aRtNzclYnJLgi0Z/FVXmXwvGlBA==`.
Verify that exact published package without substituting the candidate:

```bash
npm view @sulmusic/agent-vigil@0.24.1 dist.integrity
```

## Enforcement

A repository-owned workflow is suitable for a trial. A job name alone does not
prove who supplied the workflow. Protected enforcement requires the centrally
operated Agent Vigil App and a GitHub ruleset bound to that App-owned check. The
First-party staging has demonstrated PASS, FAIL, stale-head NOT CHECKED,
rollback, and merge-queue blocking. That does not make the production App
public or prove outside use.

## Remove it

Delete the generated Agent Vigil files. Remove any matching required-check or
ruleset entry separately so the repository is not left waiting for a check that
can no longer run.

## Evidence boundary

A successful install proves setup, not retained use, a useful catch, payment,
or revenue. Those are measured separately with maintainer consent.
