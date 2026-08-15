# agent-vigil

**Did your agent actually do what it said?**

Agents end sessions with confident summaries: *"Updated the auth flow, all tests
pass, ready to merge."* Sometimes that's true. Sometimes the tests never ran,
the file doesn't exist, and the agent spent forty minutes in a loop. An
output-only review can't tell the difference — that gap is why most agent
pilots never reach production.

`vigil` is a deterministic trust report for agent sessions. Point it at a
transcript and a repo; it extracts every checkable claim the agent made and
verifies each against reality. **No LLM anywhere in the verification path** —
every verdict is reproducible byte-for-byte.

```console
$ npx agent-vigil session.jsonl --repo .

  ✓ [tests_pass] 12 tests
      claim:    "All 12 tests pass"
      reality:  `npm test --silent` exits 0

  ✗ [file_changed] src/ghost/phantom.ts
      claim:    "I also created src/ghost/phantom.ts with the handler"
      reality:  claimed as changed but does not exist in the repo

  ✗ [work_complete] no step-repetition loops
      reality:  agent repeated the identical tool call 3x in a row — stuck-loop signature

  1 verified · 2 contradicted · 0 unverifiable
  FAIL — the narrative does not match the repo.
```

Exit code `0` only when nothing is contradicted — safe to gate CI on.

## What it checks (v0.2)

| claim | how it's verified |
|---|---|
| "tests pass" | reruns the repo's own test command and compares |
| "I updated/created X" | X must appear in git's changed files |
| any path the summary references | must exist in the repo |
| "done / complete / ready to merge" | diff must not ADD `TODO`/`FIXME`/`not implemented` markers |
| session behavior | flags 3+ identical consecutive tool calls (stuck loops — 17% of documented agent failures) |

Reads Claude Code session JSONL natively (`~/.claude/projects/<proj>/<session>.jsonl`)
plus any plain-text/markdown agent summary. Adapters for other agent formats
are small and welcome — see `src/transcript.ts`.

## True story

We ran vigil on the transcript of the session that *built* vigil. It flagged a
real stuck-loop: the author agent had re-read the same file three times in a
row after a failed parse. The first bug it ever caught was in its own author.

## Run it on every session automatically (Claude Code hook)

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "npx agent-vigil \"$CLAUDE_TRANSCRIPT_PATH\" --repo ."
      }]
    }]
  }
}
```

## CI (GitHub Action)

```yaml
- uses: sulmusic2-star/agent-vigil@main
  with:
    transcript: agent-session.jsonl
```

## Flags

```
vigil <transcript.jsonl|summary.md> [--repo <path>] [--test-cmd "<cmd>"] [--json]
```

## Design principles

1. **Deterministic or nothing.** If a claim can't be checked mechanically, it's
   reported `unverifiable` — never guessed at by another model.
2. **Over-extract, under-conclude.** A false `unverifiable` is cheap; a missed
   contradiction is not.
3. **The gate is the product.** Reports are for humans; the exit code is for
   CI. Dependence lives in the exit code.

MIT.
