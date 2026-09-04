# Install Agent Vigil

## Verified packages today

GitHub Releases serves v0.23.2 from commit
`1c5544d84586249c452adda3f8432a9bdac2ca7a`:

```bash
curl -fLO \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz
printf '%s  %s\n' \
  '85dd030bc638625ae75181030268e5561dc7483c32e74253bfb17bf76ad2b839' \
  'sulmusic-agent-vigil-0.23.2.tgz' | shasum -a 256 -c -
npx --yes ./sulmusic-agent-vigil-0.23.2.tgz protect
```

npm serves v0.21.1, which predates the no-SHA `protect` path shown here. Do not
use that registry version for this setup. The exact public state is recorded in
[`public-install-state.json`](public-install-state.json).

## v0.24.1 release candidate

v0.24.1 is a source release candidate until GitHub lists both the package and checksum assets.
Do not install a v0.24.1 URL or npm specifier before that happens. The release
gate will verify the packed artifact, checksum, commit, README, Action pin,
GitHub release, Marketplace listing, and npm package before promotion.

After every public channel identifies the same v0.24.1 code, this guide and the
machine-readable channel record will be promoted together.

## One setup pull request

`protect` writes the policy and workflows, then runs a disposable rehearsal. A
successful run ends with one next action: commit the generated files and open a
setup pull request.

After that setup merges:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz doctor --repo .
```

Then open a normal code pull request. The check says:

- `PASS` — ready to merge under the base-owned policy;
- `FAIL` — do not merge yet;
- `NOT CHECKED` — no decision because required evidence did not run or could
  not be bound to the current commit.

## Non-Node repositories

The automatic path recognizes a narrow root Node/npm layout. Other toolchains
use the immutable common runner and an explicit command:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.2/sulmusic-agent-vigil-0.23.2.tgz protect --repo . \
  --runner common \
  --test-cmd "python3 -m pytest -q"
```

The common image contains Node, Python, Rust, Go, Java, Ruby, PHP, .NET, pnpm,
Yarn, and Bun. It does not fetch project dependencies during the networkless
test phase. Use a reviewed organization-owned `--runner-image` when the project
needs dependencies preinstalled.

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

A successful install proves setup, not retained use, a useful catch, payment, or
revenue. Those are measured separately with maintainer consent.
