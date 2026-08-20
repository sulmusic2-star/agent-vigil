# Contributing

The best contribution is a minimized, sanitized case where Agent Vigil returns
the wrong status.

1. Remove secrets, personal paths, private code, and unrelated messages.
2. Add a regression test under `test/`.
3. State the expected PASS, FAIL, or INCONCLUSIVE result.
4. Run `npm ci && npm run check`.
5. Explain whether the case affects Claude Code, Codex, Markdown, or all adapters.

Detector changes should prefer an explicit INCONCLUSIVE result over a guess.
New integrity rules need one catching fixture and one honest-change fixture to
control false positives.
