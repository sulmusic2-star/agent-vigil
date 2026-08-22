# Expanded market-signal model

**Date:** 2026-08-22

## Why this exists

The first research pass was too binary. It treated evidence that could not
support a factual market claim as unsuitable for product scoring. That is a
sound publication standard and a poor discovery standard. Early product demand
often appears first as complaints, workarounds, launch comments, feature
requests, buying comparisons, and promotional experiments.

The revised method includes those signals with explicit weights. An X post does
not become a survey. A small Reddit thread does not become market size. When the
same problem recurs across X, Reddit, GitHub issues, Hacker News, Product Hunt,
standards groups, product launches, and research, convergence affects priority.

## Inclusion equation

For each source/opportunity pair:

```text
row contribution = source reliability × recency × engagement

converged support =
  demand support × (1 + cross-channel convergence multiplier)

adjusted support =
  converged support / (1 + competition pressure)
```

Promotional and positive-use descriptions contribute at half weight. Competitor
launches create competition pressure instead of disappearing from the model.
The generated index is relative prioritization, not market size, purchase
probability, or a revenue forecast.

Inputs:

- [`expanded-signal-ledger.csv`](expanded-signal-ledger.csv)
- [`score_expanded_signals.py`](score_expanded_signals.py)
- [`expanded-signal-scorecard.json`](expanded-signal-scorecard.json)

## Revised product decision

The larger opening is **Agent Vigil Control: verified unit economics and
assurance for coding agents**.

The earlier outcome ledger remains the evidence substrate. It is not the whole
product. Each coding-agent task should have:

1. a task identity, owner, budget, and authority boundary before execution;
2. observed actions, delegation, cost, and loop/anomaly detection during work;
3. exact Git and independent verification at closure;
4. maintainer disposition, review effort, merge, revert, and incident outcome;
5. a portable value card showing the task outcome, whether it held up, and what
   it cost.

Representative inputs include a
[Claude Code cost-tracking request](https://github.com/anthropics/claude-code/issues/18550),
a [Codex billing-audit discussion](https://github.com/openai/codex/discussions/27766),
the [FinOps for AI framework](https://www.finops.org/framework/technology-categories/ai/),
an [X post comparing agent reliability](https://x.com/danveloper/status/2037538213917594021),
and a current
[coding-subscription buying question](https://www.reddit.com/r/cursor/comments/1vqrf7a/is_cursor_worth_coming_back_to_in_2026/).
The ledger retains the full set and individual caveats.

### Free inbound wedge

Developers repeatedly ask which combination of Codex, Claude Code, Cursor,
Copilot, and OpenCode is worth paying for. The free product should answer that
question from their own repositories:

```text
vigil value
vigil budget --task 5.00
vigil compare codex claude-code --task-class bugfix
```

The output should compare cost per verified change, one-pass success, review
minutes, rework, unauthorized actions, and later reverts. It must show sample
size and `INCONCLUSIVE` whenever attribution is missing.

This creates a stronger organic loop than an audit product alone:

- users get private value before signup;
- shareable redacted Agent Value Cards answer a high-intent buying question;
- aggregate opt-in benchmarks create search pages for real task classes;
- adapters and receipt conformance let other tools contribute data;
- the same evidence becomes the paid team control plane.

### Paid organizational product

- budgets and authority policy before an agent starts;
- cost allocation by task, repository, team, agent, and model;
- verified-cost-per-merge and review-tax analytics;
- loop, scope-expansion, and abnormal-cost circuit breakers;
- maintainer disposition and false-positive analytics across review bots;
- incident reconstruction and signed evidence export;
- retention, SSO, RBAC, SIEM, self-hosting, data residency, and support.

## What remains crowded

- generic transcripts and tracing;
- token dashboards and subscription-limit meters;
- generic AI code review;
- runtime agent gateways;
- multi-agent orchestration dashboards.

CodeBurn already targets local coding-cost comparison. AgentBudget targets hard
dollar limits. LangSmith, Langfuse, and many others target traces and evals.
Agent Vigil must bind cost to independently verified engineering outcomes and
human disposition. Cost tracking without outcome evidence is not a moat.

## New build priority

1. Extend `ai-change-episode-v1` with task budget, metered-cost provenance, and
   finding disposition.
2. Build read-only local importers for Codex and Claude Code cost/session data.
3. Produce `vigil value` as a local static report with no account.
4. Add budget/anomaly warnings; do not intercept or stop execution until cost
   attribution is proven reliable.
5. Dogfood it across Agent Vigil development and publish redacted value cards.
6. Add Cursor, Copilot, OpenCode, and Gemini adapters in measured order.

## Evidence gate

Before presenting this as a commercial winner, require:

- 10 external repositories and three agent vendors;
- 1,000 externally generated episodes;
- five 30-day retained users;
- 80% or better cost attribution completeness on supported adapters;
- 10 maintainer-accepted findings or scope/cost anomalies;
- three users sharing an Agent Value Card voluntarily;
- two organizations asking for budgets, allocation, or verified-outcome
  reporting;
- two paid written pilots and one renewal or expansion.
