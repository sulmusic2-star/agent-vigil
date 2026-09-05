# Agent Value Card v1

**State:** Agent Vigil v0.11 contract

`vigil value` binds a full Agent Vigil receipt to supported transcript usage,
task cost and budget, human review, maintainer disposition, and a downstream
change outcome. It produces a private local card in text, JSON, Markdown, or
standalone HTML.

[Open the synthetic standalone HTML demonstration](assets/agent-value-card-demo.html).
It is a rendering example, not an external customer result.

v0.11 also imports normalized GitHub review and outcome evidence
and compares retained cards by task class. See
[GitHub outcome evidence](GITHUB_OUTCOME_EVIDENCE.md) and
[task-matched value comparisons](VALUE_COMPARISONS.md).

The next-cycle [exact cost evidence](EXACT_COST_EVIDENCE.md) adapter can bind a
Cursor usage export to the transcript and fill the exported amount without
manual re-entry.

## Example

```bash
vigil value agent-vigil-report.json \
  --transcript /private/path/codex-rollout.jsonl \
  --cost-usd 1.25 \
  --cost-source provider-billed \
  --cost-evidence /private/path/provider-export.csv \
  --budget-usd 2.00 \
  --review-minutes 7 \
  --disposition accepted \
  --review-evidence /private/path/review.json \
  --outcome merged \
  --outcome-as-of 2026-08-22T12:00:00Z \
  --outcome-evidence /private/path/merge.json \
  --task-class bugfix \
  --format html \
  --output agent-value-card.html
```

The transcript is accepted only when its SHA-256 digest matches the receipt.
Evidence files are bounded and hashed; their contents are not copied into the
card. Output files use Agent Vigil's private atomic writer.

## Verdicts

| Value verdict | Meaning | Exit |
|---|---|---:|
| `POSITIVE` | Verification passed, hashed cost evidence exists, and hashed review or merge evidence supports acceptance. | 0 |
| `NEGATIVE` | Verification failed, the maintainer dismissed it, or a revert, hotfix, or linked incident was recorded. | 1 |
| `INCONCLUSIVE` | Cost, acceptance, outcome, or sufficient verification evidence is absent. | 2 |

The card does not turn an Agent Vigil `PASS` into proof that code is bug-free.
A positive card is also not an ROI claim because it lacks a measured baseline
unless a later comparison supplies one.

## Usage accounting

### Codex

Agent Vigil reads provider-reported `total_token_usage` from `token_count`
events and retains the greatest cumulative session snapshot. Models are taken
from session turn context.

### Claude Code

Claude Code may repeat an assistant message while output streams. Agent Vigil
groups usage by assistant message identity, takes the maximum observed counter
for each component, and then sums the deduplicated messages. This prevents
repeated JSONL fragments from multiplying reported usage.

Token counts do not automatically become dollar cost. Subscription allowances,
cache pricing, negotiated rates, routing, and changing model prices make that
conversion ambiguous. Cost therefore requires an explicit source:

- `provider-billed`
- `provider-exported` (the imported export is hash-bound but not authenticated by the provider)
- `subscription-allocated`
- `user-estimated`

Without a cost-evidence file, the card labels the amount `SELF_ASSERTED` and
remains `INCONCLUSIVE`. Disposition and outcome fields follow the same rule:
they stay explicitly self-asserted unless a bounded local review or outcome
artifact is hashed into the card.

## Card integrity and privacy

- The receipt content hash must verify.
- An embedded receipt signature must verify when present; `--public-key`
  upgrades it to pinned-key verification.
- Transcript, billing, review, and outcome artifact contents are not copied.
- Absolute local paths are excluded from the card.
- The value card has its own canonical SHA-256 evidence identifier. Render time
  is excluded so repeated rendering of the same evidence keeps the same ID.
- HTML fields are escaped and the file contains no remote scripts or assets.
- POSIX output uses mode `0600`. Windows output inherits the destination
  directory ACL, so sensitive cards belong in an access-restricted directory.

## Current boundary

This version creates one task card, closes GitHub run/PR outcomes through a
separate observer, and aggregates verified cards locally by task class,
adapter, and model set. The next-cycle Cursor adapter imports a local usage
export but does not authenticate it with Cursor. Direct provider API
attestation, hard budget interruption, hosted analytics, and organizational
policy are not implemented.
