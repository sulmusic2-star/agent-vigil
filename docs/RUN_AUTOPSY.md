# Run autopsy

`vigil autopsy` creates a local, privacy-preserving record of whether one AI
coding run earned its observed cost. It joins four independent facts:

1. the selected local transcript;
2. a strict Agent Vigil receipt signed by a pinned key;
3. exact provider cost bound to that transcript; and
4. evidence of maintainer acceptance or a merged downstream outcome.

It does not upload prompts, transcript content, or provider exports. The result
contains hashes and bounded summary counts.

## Choose a run

```bash
vigil autopsy
```

Without a path, the command searches the configured Codex and Claude Code
history directories. If multiple runs are plausible, it lists their time,
agent, working directory, branch when present, and path. Choose one explicitly:

```bash
vigil autopsy /absolute/path/to/session.jsonl
```

Discovery is metadata-only, does not follow symbolic links, and has fixed file
and directory bounds. A selected transcript must be a regular file no larger
than 50 MiB in this version.

## Produce a conclusive record

```bash
vigil autopsy ./cursor-session.jsonl \
  --receipt ./agent-vigil-report.json \
  --public-key ./trusted-receipt-public.pem \
  --cursor-usage-export ./cursor-usage.json \
  --budget-usd 5 \
  --disposition accepted \
  --review-evidence ./maintainer-decision.json \
  --format json \
  --output ./run-autopsy.json
```

An existing output from `vigil cost-evidence cursor` can replace
`--cursor-usage-export`:

```bash
vigil autopsy ./cursor-session.jsonl \
  --receipt ./agent-vigil-report.json \
  --public-key ./trusted-receipt-public.pem \
  --cost-evidence ./agent-vigil-cost.json \
  --outcome merged \
  --outcome-evidence ./github-merge-evidence.json
```

## Decisions

- `EARNED` requires a strict PASS receipt signed by the supplied pinned key,
  exact cost joined to the same transcript, and evidence-backed acceptance.
- `NOT_EARNED` requires contradictory evidence, such as a trusted failed
  receipt, a no-op change, an exact budget overrun, maintainer rejection, or an
  adverse downstream outcome.
- `NOT_CHECKED` means evidence is absent, ambiguous, untrusted, non-strict, or
  cannot be joined. It is not treated as success.

Exit codes are `0` for `EARNED`, `1` for `NOT_EARNED`, and `2` for
`NOT_CHECKED` or invalid input.

## Evidence boundary

Hashing a downloaded billing, review, or outcome artifact proves which bytes
were used and whether they changed afterward. It does not prove that the
artifact's original author was truthful. Cursor cost is labeled
`PROVIDER_EXPORTED`, not provider-signed. A future authenticated connector can
strengthen that authority without changing the transcript join or decision
contract.
