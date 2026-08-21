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
   artifacts, not unique receipt hashes or lifetime runs.
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

The 10-repository / 1,000-receipt milestone must be satisfied by external
evidence under this contract. Compatibility labs, fuzz cases, the project's own
CI, and Tim Sullivan's other repositories remain product evidence, not external
adoption.

