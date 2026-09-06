# Keep the expected answers outside the change

**Local preview. Not a published package feature or a live managed service.**

A PR can change a function and change its tests to agree with the mistake.
This check keeps selected answers on the approved base commit, runs the
function in a disposable container, and compares the answer outside that
container. Changing the proposed contract cannot approve new answers.

## What works today

- Dependency-free CommonJS (`.cjs`) files with named function exports.
- Explicit JSON arguments and exact JSON results, including async functions.
- Return values must be plain JSON data. `NaN`, `Infinity`, `-0`, missing array
  entries, accessors, classes and custom `toJSON` methods are NOT CHECKED.
  They are never silently converted into a passing answer.
- A manually reviewed source-file allowlist. Nothing else is mounted.
- Exact base/head SHAs and an unchanged `.vigil-regressions.json` contract.

It does **not** import Jest, Vitest or arbitrary `node --test` suites, install
dependencies, run build scripts, start databases or make network requests.
Keep your existing CI for those jobs.

## Try it from this source checkout

After `npm ci --ignore-scripts && npm run build`:

```bash
node dist/cli.js regression doctor
node dist/cli.js regression --help
```

The doctor checks Git, Docker and the pinned image. It never pulls an image
or runs repository code. If the image is missing, it prints a pull command.

From a repository containing `src/math.cjs`, use the built CLI's absolute path:

```bash
node /absolute/path/to/agent-vigil/dist/cli.js regression init \
  --module src/math.cjs --export add --args '[2,3]' --expect '5'
```

This creates one example. It does not run the function, infer the answer or
claim installation is complete. Add meaningful cases and review the file:

```json
{
  "version": 1,
  "files": ["src/math.cjs"],
  "cases": [
    {"id": "positive", "module": "src/math.cjs", "export": "add", "args": [2,3], "expect": 5},
    {"id": "opposites", "module": "src/math.cjs", "export": "add", "args": [-2,2], "expect": 0}
  ]
}
```

Commit the contract to the approved base, then check a proposed commit:

```bash
node /absolute/path/to/agent-vigil/dist/cli.js regression check \
  --repo /absolute/path/to/your-repository \
  --base FULL_BASE_COMMIT_SHA --head FULL_PROPOSED_COMMIT_SHA \
  --output /absolute/path/to/receipt.json
```

Use `--json` for machine-readable output. No prompts, login or upload.
`init --dry-run` previews its file; existing contracts are never overwritten.
Remove the contract to uninstall this opt-in local setup; separately remove any
CI configuration you chose to add. This command installs no required check.

## Read one result

- **PASS (exit 0):** every selected case matched its protected answer in two
  baseline runs and two candidate runs. This does not authorize merging or
  prove untested behavior correct.
- **FAIL (exit 1):** a baseline case reproduced, but both candidate runs returned
  the same different answer. Fix the code or request a separate contract review.
- **NOT CHECKED (exit 2):** missing inputs, changed expectations, unavailable
  tooling, timeout, invalid output or inconsistent runs. Do not treat it as
  success. If another case confirms a mismatch, the overall result stays FAIL
  and the incomplete case remains visible.

Receipts contain the contract hash, selected file hashes, complete Git changed-file
list, exact revisions, expected/observed values and timings. Values can contain
private data. Store receipts accordingly; no upload occurs.

## Intentional behavior changes

There is no `--approve` or `--ignore-contract-change` flag. Review new expectations
through an independent, protected approval path. Only after that approval
establishes a new base should later changes use it. The CLI does not authenticate
approval: whoever controls its arguments can choose a different baseline.

**Do not run an agent-controlled copy of the CLI and call it an independent merge
gate.** A required workflow or App must own the verifier, base/head selection and
contract-update approval. This preview does not activate that integration. Do not
reuse the general Action's PASS as this feature's result.

## What the boundary proves

Each case runs in a fresh digest-pinned container with no network, no host
credentials, no Docker socket, no Git directory and a read-only source allowlist.
It has a non-root user and CPU, memory, process, output and wall-time limits.
The controller, not candidate code, owns the expected answers and comparison.
These controls follow [Docker's documented run options](https://docs.docker.com/engine/containers/run/).

Docker, its daemon, the host, Git and the verifier remain trusted. Containers
are not a guarantee against kernel vulnerabilities. A hostile program may
recognize supplied inputs or forge its returned value; a match proves only
that the observed JSON response matched the selected expectation, not that
a named function executed honestly or all paths are safe. Two repeats can
expose some inconsistent behavior, not establish a flake rate.

## Compare it with ordinary CI

`examples/protected-regressions/plain-ci.mjs` is a separate runnable controller
with no Agent Vigil imports. It preserves the same answers and uses equivalent
container restrictions. Given a trusted copy:

```bash
node /absolute/path/to/plain-ci.mjs /absolute/path/to/repository BASE_SHA HEAD_SHA
```

The lab freezes constructed cases before running either tool:

```bash
python3 scripts/regression_lab.py prepare /absolute/path/to/new-lab-directory
python3 scripts/regression_lab.py run /absolute/path/to/new-lab-directory
```

The CI alternative may be enough. Vigil adds strict input validation, setup
diagnostics and a common receipt; whether these save enough work to justify
a service is unmeasured. Both controllers reject unsupported return values
before JSON serialization. Earlier local versions of both controllers did not;
those results must not be used to claim coverage of that failure class. No unique detector advantage is claimed.

## Availability and privacy

This local preview is free. No hosted installation or subscription is offered on
this page. It does not collect payments, upload receipts or send telemetry.
If you already maintain protected expectations in CI, keep that setup unless
this tool removes work you actually have to do.
