# A good new test hid an emptied old test

**Status: reproduced in staging; corrected locally; fixed release not published.**

This was a deliberately planted fault in our own disposable repository. It is
not an outside installation or an independently reported agent failure.

## What happened

The change added a working subtraction function with a useful test. It also
broke an existing sum function, making it always return zero, and replaced that
function's only test assertion with a comment. Ordinary tests reported two
passing tests. Agent Vigil's staging App incorrectly reported PASS too.

The comparison test failed against the old code because the subtraction
function did not exist there. That proved something about the new function,
but nothing about the broken sum function. Meanwhile, counting assertions
across the whole change allowed the new assertions to offset the removed one.

## Exact public evidence

- [Draft lab PR #7](https://github.com/sulmusic2-star/agent-vigil-live-lab-20260904/pull/7)
- Base: `f60051e754eb1b57d4b90fa7bfb15b7e7f86616f`
- Good addition: `66adb6c59f241a01c8199f27d2946a388226b61b`
- Broken mixed change: `c6d676bde678fe1f8ccfc112b5ae660bf2db5467`
- Incorrect staging PASS: check `101210786599`, App `4830278`
- [Central verification run](https://github.com/sulmusic2-star/agent-vigil/actions/runs/33931478842)
- Central workflow revision: `f17cff244163fde995943833fbe957b65c86510f`
- Released verifier version: `0.24.3`

The original check and receipt have not been rewritten. A comment on the PR
explains the error, and the intentionally broken PR is a draft, not a change to
merge. No human approval is claimed.

## What changed locally

For plain JavaScript tests, inspect the complete before-and-after test bodies
from the exact Git revisions. Report a newly empty callback as a blocking
finding in calibrated mode. Extra assertions in another test cannot cancel it.
An unreadable JavaScript file is missing evidence, not a clean inspection.

The local compiled verifier reports **FAIL** for the broken commit and **PASS**
for the good addition when each runs in its matching checkout. The failure
identifies `test/index.test.js:5`. These are local results, not a repaired hosted
check or an updated public package.

Run the regression from a checkout containing the fix:

```bash
npm ci --ignore-scripts
node --import tsx --test test-hosted/mixed-change-integrity.test.ts
```

The regression constructs its own repository, verifies that ordinary tests are
green while the sum is wrong, and checks both exact-commit and worktree results.
It also tests comment-only bodies, helper delegation, duplicate names, strings,
templates, malformed syntax, and unrelated new assertions.

## What this does not prove

This narrow inspection covers named `test`/`it` callbacks in `.js`, `.mjs`, and
`.cjs` test files. It does not cover TypeScript, JSX, arbitrary aliases, generated
names, or every way to make a nonempty test meaningless. It does not establish
that every changed behavior has an adequate test. The original three-case
historical replay and diff-only calibration do not test this new full-file path.

When repeated titles make it unclear whether an old empty body replaced a
meaningful one, the result is NOT CHECKED. Distinct test names remove that
ambiguity. Moving an existing test byte-for-byte does not introduce a new finding.

Before reopening the trial: review the source and dependency change, build a
new immutable release identity, rerun the good and broken heads through the
staging App, and verify that the public package and Action use that fix.
