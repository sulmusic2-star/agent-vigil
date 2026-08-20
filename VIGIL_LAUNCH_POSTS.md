# Launch copy — prepared, not posted

## Primary

AI coding agents are good at writing the closing summary. That does not make the
summary true.

Agent Vigil v0.3 turns a Claude Code or Codex session into a deterministic
evidence receipt:

- PASS, FAIL, or INCONCLUSIVE—empty evidence never passes
- compares claimed and observed test counts
- binds file claims to an explicit Git range
- detects deleted/skipped tests, assertion loss, suppressions, bypasses, and
  exact tool-call loops
- emits JSON, Markdown, SARIF, and a GitHub job summary
- local only, zero runtime dependencies, no LLM judge

The interesting part is not another confidence score. It is a falsifiable rule
with the exact evidence beside it.

Repository: https://github.com/sulmusic2-star/agent-vigil

## First comment

The README includes the threat model and the complaint/competitor research that
shaped the build. It also names what Vigil does not prove: semantic correctness,
test quality, transcript authenticity, or safe execution of hostile repo code.

If you have a sanitized false PASS, false FAIL, or unexplained INCONCLUSIVE,
that is the most useful issue you can open.
