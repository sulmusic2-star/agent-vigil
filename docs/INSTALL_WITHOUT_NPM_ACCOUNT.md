# Install Agent Vigil

## Verified package

GitHub Releases serves v0.24.0 from exact release commit
`ef583e6c9cac87941a7f283ef07af46187315912`:

```bash
curl -fLO \
  https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.0/sulmusic-agent-vigil-0.24.0.tgz
printf '%s  %s\n' \
  '49fc66f97e4ce1ae530513062430ae9a81dba94c3f722dd91bd3d1009e629151' \
  'sulmusic-agent-vigil-0.24.0.tgz' | shasum -a 256 -c -
npx --yes ./sulmusic-agent-vigil-0.24.0.tgz protect --repo .
```

The GitHub Marketplace listing also exposes v0.24.0. npm has staged v0.24.0
with trusted-publishing provenance, but its public `latest` tag still serves
v0.21.1. Use the immutable GitHub package until registry promotion, integrity,
and a clean registry install are separately verified. The exact channel state
is recorded in [`public-install-state.json`](public-install-state.json).

> **v0.24.0 packaging note:** the immutable tarball contains the earlier
> pre-publication README and installation guide, which still name v0.23.2 as
> the last verified release. The executable and package metadata report
> v0.24.0. Use this current web guide and the attached checksum rather than the
> guide embedded in that tarball.

> **Controlled-trial limitation:** after a successful `protect` run, v0.24.0
> prints an npm-based `doctor` command that is not currently available. Do not
> use that printed command. After the setup pull request merges, use the pinned
> GitHub command below. A patch release must correct the embedded handoff before
> broad self-serve onboarding.

## One setup pull request

`protect` writes the policy and workflows, then runs a disposable rehearsal. A
successful run ends with one next action: commit the generated files and open a
setup pull request.

After that setup merges:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.0/sulmusic-agent-vigil-0.24.0.tgz doctor --repo .
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
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.0/sulmusic-agent-vigil-0.24.0.tgz protect --repo . \
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
