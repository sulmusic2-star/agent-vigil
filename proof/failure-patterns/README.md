# Test-integrity failure corpus

This corpus turns four public reports about false verification and untrustworthy tests into 20 small regression cases across JavaScript, TypeScript, Python, Rust, Go, Java, .NET, shell and browser testing.

Run it with:

```bash
npm run proof:failure-corpus
```

The generated [`results.json`](results.json) records the expected and observed route for every case. The ordinary test suite independently checks the same cases.

## Evidence boundary

These fixtures are source-backed adversarial reproductions. They are not 20 customer incidents. The browser runtime-patch case reproduces the mechanism described in its linked report. The other cases are nearby, vendor-neutral ways that skipped, empty, self-fulfilling or bypassed tests can make a weak change look successful.

The default `calibrated` mode blocks direct, deterministic weakening: skipped or focused tests, empty tests, constant or self-equal assertions, verification bypasses and zeroed coverage gates. Broader signals stay advisory until external false-positive evidence supports blocking them.

Source URLs and each case's relationship to its source are stored in [`v1.json`](v1.json). A report establishes that a user described a failure; it does not establish prevalence or prove the reported root cause.

The four source reports are:

- [a Playwright test patched page behavior before checking it](https://www.reddit.com/r/ClaudeCode/comments/1rug14a/claude_wrote_playwright_tests_that_secretly/)
- [a green test suite was described as untrustworthy](https://www.reddit.com/r/ClaudeCode/comments/1txcow8/my_test_suite_is_green_for_the_first_time_in/)
- [tests were described as passing without proving behavior](https://www.reddit.com/r/ClaudeCode/comments/1v39e95/claude_keeps_writing_tests_that_pass_im_not/)
- [a coding agent was reported as saying verified without the canonical build](https://github.com/anthropics/claude-code/issues/63861)
