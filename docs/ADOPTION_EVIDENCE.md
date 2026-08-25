# Adoption evidence contract

Agent Vigil does not infer adoption from attention. Stars, clones, catalog
mentions, README links, and code-search hits remain discovery signals.

## Counted states

1. **Reference only** — public text names Agent Vigil. Not adoption.
2. **Configured** — an external public repository has a workflow with an exact
   `uses: sulmusic2-star/agent-vigil@...` step.
3. **Run observed** — GitHub publicly lists a run for that configured workflow.
   This proves execution activity, not a PASS or retained use.
4. **Receipt observed** — GitHub currently lists an artifact named
   `agent-vigil-receipt` in a configured external repository. The census counts
   artifacts, not unique receipt hashes or lifetime runs. This discovery count
   cannot by itself satisfy the 1,000-receipt milestone.
5. **Required check** — a repository owner provides public ruleset/branch
   protection evidence. Public code search cannot establish this state.
6. **Maintainer-accepted contradiction** — a maintainer links the failing
   receipt, the change it stopped, and the accepted fix or closure. Agent Vigil
   does not count its own demonstration fixtures.

Private users may report feedback without publishing a repository. They are not
added to public milestone totals without auditable, consented evidence.

## Census

Run:

```bash
python3 scripts/public_adoption_census.py --output adoption-census.json
```

The script uses GitHub code search through the authenticated `gh` CLI, excludes
repositories owned by `sulmusic2-star`, verifies workflow contents, checks for
observable workflow runs, and counts currently listed receipt artifacts. API
errors become unknown counts. They do not become zeros or successes.

## External proof threshold

All six conditions must be independently evidenced:

- 10 externally owned configured repositories;
- 1,000 external receipts, deduplicated by receipt hash and linked to a public
  workflow run or consented maintainer ledger;
- 5 maintainers still using the check after 30 calendar days;
- 10 maintainer-accepted contradictions with the failing receipt and resulting
  fix, closure, or policy decision;
- fewer than 1% unexplained false verdicts, with every report classified as
  resolved false verdict, expected behavior, product defect, or still open;
- 3 external repositories with public owner-supplied evidence that the check is
  required for merge.

The public census is a discovery aid for configured workflows and currently
listed artifacts. It cannot observe retention intent, unique lifetime receipt
hashes, maintainer acceptance, or private rulesets. Those claims require
separate public or consented owner evidence. Compatibility labs, fuzz cases,
the project's own CI, and Tim Sullivan's other repositories remain product
evidence, not external adoption.

## Continuity product-learning signals

Continuity uses an additional self-serve ladder. No email, sales call, written
offer, or private repository access is required to cross these gates:

1. **Lab present** — an external public repository contains the versioned
   Continuity Lab marker. This shows product exploration, not production use.
2. **Lab run observed** — GitHub lists a run for that lab workflow. This shows
   the demonstration ran, not that a real change was protected.
3. **Exact Action use** — an external workflow pins Agent Vigil to a full
   40-character commit ID.
4. **Continuity gate configured** — that exact Action use selects
   `mode: continuity`.
5. **Repeat workflow activity** — the current public run inventory contains at
   least two runs for a configured workflow. It does not prove use on two
   distinct days.
6. **Revocation stopped an action** — a public or consented record binds a real
   or safely planted revert, invalid attestation, or linked incident to a
   skipped protected-action job that ordinary CI would have allowed.
7. **Self-serve payment** — a completed payment record exists for a clearly
   described Continuity product. A checkout page or abandoned checkout does
   not count.

The first demand gate is five externally owned repositories using the exact
Action, three with repeat workflow activity, one evidenced revocation stop, and
one self-serve payment. Until those facts exist, the lab and passing tests are
product evidence only.

The census also reports the versioned
`agent-vigil-keyless-control-proof/v1` workflow separately. A configured
external workflow and an observed run show that GitHub produced activity for
the keyless proof path. They do not show that the proof passed, that its check
was required, that the repository retained it, or that anyone paid.
