# Test Integrity Guard

Test Integrity Guard examines the exact `base..head` diff before a change can use a green test run as evidence.

```bash
vigil test-integrity --base <base-sha> --head <head-sha>
```

The default calibrated mode blocks direct weakening:

- focused or skipped tests added
- verification bypasses such as `--no-verify`, `passWithNoTests`, `|| true`,
  `continue-on-error: true`, or a disabled workflow step
- coverage thresholds set to zero or lowered from the base revision
- recognized test definitions removed without replacement
- empty test bodies
- constant or self-equal assertions
- assertions placed under a constant-false branch or caught and discarded by
  the test itself
- pytest collection hooks or options that newly remove tests
- bidirectional or tag Unicode controls added to source or
  repository instructions

It records lower-confidence findings as advisories:

- a distinctive literal directly returned by changed source and asserted by an
  unchanged test, when that literal did not exist in base source; the receipt
  stores a hash rather than the value and does not claim copying
- a newly imported or declared package name one edit away from a common package; this is an offline
  spelling warning, not a malware or registry-ownership finding
- a transcript command that reads a commit outside the selected base-to-head history;
  this records retrieval without claiming copying or causation
- zero-width, direction-mark, or variation-selector characters in source or
  repository instructions
- mixed Latin, Cyrillic, or Greek characters in one changed identifier-like token
- browser tests that alter page runtime state before judging behavior
- new coverage-exclusion markers
- exact assertions replaced with looser predicates
- assertion-count reductions
- self-fulfilling local mocks
- compiler or linter suppressions
- swallowed error paths

Use `--strict` only after calibrating every enabled rule on the repository. It makes every static finding blocking.

## What was deliberately left out

The check does not execute candidate source merely to compare behavior. It
does not contact a public package registry during the default gate. Those two
prototype ideas can hang, leak data, run hostile code, or misread private
registry setups. Agent Vigil keeps the default scan offline and limited to the
selected Git change. The existing no-op and suppression checks already cover
the useful part of the proposed Python-only Null Compile check.

## What PASS means

PASS means the selected diff contained none of the blocking patterns under this policy. It does not prove that the tests cover the intended behavior or that the application is correct. The full Agent Vigil gate combines this scan with exact-commit execution, protected policy, change limits, differential tests, and retained evidence.

## Why the two levels exist

Agent Vigil previously measured static findings on 232 presumed-clean merged pull requests and found enough review burden that all-static blocking would be irresponsible. Calibrated mode blocks the narrow patterns that directly make a test unable to distinguish failure. Other patterns stay visible until a repository has its own precision record.

The dated [primary user-report ledger](research/2026-08-23-user-pain-ledger.md) includes reports of disabled tests, constant-green suites, browser tests that repaired the application at runtime, and completion claims made without the canonical build.
