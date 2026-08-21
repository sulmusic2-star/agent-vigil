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

## Commercial proof milestone

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
