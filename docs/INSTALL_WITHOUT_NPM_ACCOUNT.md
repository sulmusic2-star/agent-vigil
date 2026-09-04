# Install Agent Vigil v0.24.1 without npm

This guide is an immutable snapshot for v0.24.1. It does not claim that v0.24.1
is still the newest release or that npm currently serves it.

v0.24.1 is a source release candidate until GitHub lists both the package and checksum assets.
Do not run the candidate commands until both assets named below exist.

## Verify the GitHub package

Open the [v0.24.1 release page](https://github.com/sulmusic2-star/agent-vigil/releases/tag/v0.24.1). Do not continue unless it contains both
`sulmusic-agent-vigil-0.24.1.tgz` and
`sulmusic-agent-vigil-0.24.1.tgz.sha256`.

```bash
curl -fLO \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.1/sulmusic-agent-vigil-0.24.1.tgz
curl -fLO \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.1/sulmusic-agent-vigil-0.24.1.tgz.sha256
shasum -a 256 -c sulmusic-agent-vigil-0.24.1.tgz.sha256
npx --yes ./sulmusic-agent-vigil-0.24.1.tgz protect --repo .
```

A successful `protect` run prints a `doctor` command that uses this same
immutable v0.24.1 GitHub package. It does not depend on npm publication.

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
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.1/sulmusic-agent-vigil-0.24.1.tgz protect --repo . \
  --runner common \
  --test-cmd "python3 -m pytest -q"
```

The common image contains Node, Python, Rust, Go, Java, Ruby, PHP, .NET, pnpm,
Yarn, and Bun. It does not fetch project dependencies during the networkless
test phase. Use a reviewed organization-owned `--runner-image` when the project
needs dependencies preinstalled.

## npm boundary

Use npm only if this query returns `0.24.1`:

```bash
npm view @sulmusic/agent-vigil version
```

The current cross-channel record lives on the default branch in
[`public-install-state.json`](https://github.com/sulmusic2-star/agent-vigil/blob/main/docs/public-install-state.json). This packaged guide deliberately does not copy that changing state.

At the time this release candidate was assembled, the verified public GitHub
package was
`https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.0/sulmusic-agent-vigil-0.24.0.tgz`
from commit `ef583e6c9cac87941a7f283ef07af46187315912`, with SHA-256
`49fc66f97e4ce1ae530513062430ae9a81dba94c3f722dd91bd3d1009e629151`.
npm served v0.21.1. These are dated provenance facts, not current-channel
claims.

## Enforcement

A repository-owned workflow is suitable for a trial. A job name alone does not
prove who supplied the workflow. Protected enforcement requires the centrally
operated Agent Vigil App and a GitHub ruleset bound to that App-owned check. The
App is not public until a real outside repository demonstrates PASS, FAIL,
stale-head NOT CHECKED, and merge-queue handling.

## Remove it

Delete the generated Agent Vigil files. Remove any matching required-check or
ruleset entry separately so the repository is not left waiting for a check that
can no longer run.

## Evidence boundary

A successful install proves setup, not retained use, a useful catch, payment,
or revenue. Those are measured separately with maintainer consent.
