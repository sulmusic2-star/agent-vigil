# Test Integrity Guard

Test Integrity Guard examines the exact `base..head` diff before a change can use a green test run as evidence.

```bash
vigil test-integrity --base <base-sha> --head <head-sha>
```

The default calibrated mode blocks direct weakening:

- focused or skipped tests added
- verification bypasses such as `--no-verify`, `passWithNoTests`, or `|| true`
- coverage thresholds set to zero
- recognized test definitions removed without replacement
- empty test bodies
- constant or self-equal assertions

It records lower-confidence findings as advisories:

- browser tests that alter page runtime state before judging behavior
- new coverage-exclusion markers
- exact assertions replaced with looser predicates
- assertion-count reductions
- self-fulfilling local mocks
- compiler or linter suppressions
- swallowed error paths

Use `--strict` only after calibrating every enabled rule on the repository. It makes every static finding blocking.

## What PASS means

PASS means the selected diff contained none of the blocking patterns under this policy. It does not prove that the tests cover the intended behavior or that the application is correct. The full Agent Vigil gate combines this scan with exact-commit execution, protected policy, change limits, differential tests, and retained evidence.

## Why the two levels exist

Agent Vigil previously measured static findings on 232 presumed-clean merged pull requests and found enough review burden that all-static blocking would be irresponsible. Calibrated mode blocks the narrow patterns that directly make a test unable to distinguish failure. Other patterns stay visible until a repository has its own precision record.

The dated [primary user-report ledger](research/2026-08-23-user-pain-ledger.md) includes reports of disabled tests, constant-green suites, browser tests that repaired the application at runtime, and completion claims made without the canonical build.
