# Value wedge update: outcome proof, spend, and self-distribution

**Research date:** 2026-08-22
**Lifecycle state:** local product decision and implementation evidence; not external adoption, demand, revenue, or a release

This update tests the new Agent Value Card against live complaints and current
products discovered after the 75-signal scan. It keeps issue reports,
community reports, official platform behavior, and competitor claims distinct.
A public issue proves that a named user reported a problem, not how frequently
all users experience it.

## What the newest signals say

### Last two weeks: users are asking for enforced budgets and loop control

- A Claude Code feature request opened 2026-08-10 asks for a runtime-enforced
  token circuit breaker with source attribution across hooks, plugins,
  subagents, and workflows. Its central complaint is that warnings do not stop
  background spend.
  [anthropics/claude-code #85422](https://github.com/anthropics/claude-code/issues/85422)
- A Codex issue opened 2026-08-13 describes more than ten remediation/review
  slices over about four days after an orchestrator repeatedly treated
  out-of-scope reviewer suggestions as blocking.
  [openai/codex #38375](https://github.com/openai/codex/issues/38375)

Product implication: budget visibility alone is already behind the pain. Agent
Vigil should combine a predeclared task limit, trajectory evidence, a fail-closed
post-run gate, and later a host-enforced stop adapter. The local build now checks
optional tool-call, failed-call, and observed-token limits in a base-anchored
authority contract. That is a merge control, not a live circuit breaker.

### Last three weeks: attribution itself can be wrong or absent

- A Claude Code request opened 2026-07-27 asks for live subscription budget and
  per-task accounting visible to the model, including subagent attribution.
  [anthropics/claude-code #81691](https://github.com/anthropics/claude-code/issues/81691)
- A Claude Code report opened 2026-08-01 alleges a 72x mismatch between a
  workflow-visible budget counter and weekly quota consumption.
  [anthropics/claude-code #83048](https://github.com/anthropics/claude-code/issues/83048)
- A Codex report opened 2026-07-24 attributes 10%-15% of paid usage to a
  compaction loop that reread files and lost implementation progress.
  [openai/codex #35226](https://github.com/openai/codex/issues/35226)

Product implication: never turn token counts into authoritative billing. The
new card preserves transcript-observed usage separately from attributed cost,
requires an explicit cost source, and remains `INCONCLUSIVE` without hashed
billing and acceptance evidence. A hash proves artifact identity, not billing
correctness.

### Trailing year: review noise converts agent speed into human cost

- A GitHub community report records five Copilot review rounds on one pull
  request, about 24 comments, and only about three comments the author judged
  useful.
  [GitHub Community #189767](https://github.com/orgs/community/discussions/189767)
- A separate thread reports repeated incorrect suggestions after prior review
  conversations were resolved; later commenters describe the behavior as still
  present months later.
  [GitHub Community #190754](https://github.com/orgs/community/discussions/190754)
- An older Codex issue asks for a complete first review instead of repeatedly
  surfacing one or two items.
  [openai/codex #10870](https://github.com/openai/codex/issues/10870)

Product implication: review minutes and maintainer disposition belong in the
unit-economics record. Comment count is not value. A finding that maintainers
repeatedly dismiss should reduce, not inflate, the product's reported utility.

## The competitive collision is real

Generic local cost tracking is now crowded:

| Product or surface | Current public claim | Consequence for Agent Vigil |
|---|---|---|
| [CodeBurn](https://github.com/getagentseal/codeburn) | Local cost tracking across more than 40 tools and agents | Do not compete on adapter count or token charts alone. |
| [Agent Trail](https://github.com/camtrik/agent-trail) | Local histories, token/cost tracking, tool calls, and subagent replay | Trace viewing is not a moat. |
| [agentacct](https://github.com/mikehasa/agentacct) | Local task, tools, files, tests, time, tokens, and cost across multiple agents | Task-level accounting is no longer unique. |
| [AgentMeter](https://github.com/marketplace/agentmeter) | GitHub Action agent-run costs posted on pull requests | A cost-only PR comment will not differentiate. |
| [Tuneloop discussion](https://www.reddit.com/r/codex/comments/1uxfhd9/codex_vs_claude_code_on_outcomes_built_a_free/) | Local dashboard comparing sessions, spend, and shipped PRs | Even outcome dashboards have an active entrant; verification quality and evidence provenance must be stronger. |
| [GitHub Copilot impact dashboard](https://github.com/resources/insights/copilot-impact-dashboard) | Adoption and engineering leading indicators while avoiding manufactured precise ROI | Enterprise buyers are being taught to reject false precision. |

Anthropic's official Agent SDK already provides message usage, per-model cost,
and cumulative cost for SDK result messages.
[Anthropic cost tracking documentation](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
This validates the Claude message-identity deduplication design, while also
showing that provider-native cost will become easier for vendors to expose.

The differentiator must therefore be:

```text
predeclared authority and budget
+ exact observed trajectory
+ immutable Git and fresh verification
+ hashed cost provenance
+ maintainer acceptance or dismissal
+ later merge, revert, hotfix, or incident outcome
= evidence-backed value record
```

No reviewed competitor source establishes broad adoption of that complete,
neutral, cross-vendor chain. That is a gap hypothesis, not proof that no product
can do it.

## Why an organization could pay

Official platform direction makes the buying surface clear:

- OpenAI says engineering value should be measured as a tested change that
  passes review and paired with cost, time saved, cycle time, risk avoided, or
  capacity created—not token price alone.
  [Managing AI investments in the agentic era](https://openai.com/index/managing-ai-investments-in-agentic-era/)
- OpenAI's enterprise spend controls emphasize usage, adoption, and spend by
  user, product, and model.
  [Enterprise spend controls](https://openai.com/index/chatgpt-enterprise-spend-controls/)
- GitHub's enterprise agent control plane already supplies platform-specific
  session activity, audit logs, identities, and policy administration.
  [GitHub agent control plane](https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/)
- OpenAI's own Codex deployment uses logs covering requests, tool activity,
  approval decisions, results, and network policy decisions.
  [Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/)

Agent Vigil cannot win by being a smaller copy of GitHub administration or a
provider billing dashboard. A credible paid product is the neutral control that
reconciles those vendor records with the repository outcome and human
acceptance across tools.

## Self-distribution design

External adoption is still zero unless separately measured. These are product
loops to test, not guaranteed growth:

1. **Immediate private value:** `vigil value` works locally without signup or
   transcript upload.
2. **Visible proof:** standalone HTML and Markdown cards show evidence gaps and
   carry a restrained Agent Vigil attribution link when a user chooses to share
   them.
3. **High-intent comparison:** `vigil compare-value` now answers
   "Which paid coding agent creates the lowest cost per accepted verified
   change for my bug fixes?" with sample sizes and task-mix warnings.
4. **Repository distribution:** a required GitHub check can create one value
   card per eligible agent change and retain it as an artifact.
5. **Ecosystem distribution:** publish a conformance kit so agent, IDE, and
   FinOps tools can emit compatible evidence without sending data to Agent
   Vigil.
6. **Opt-in search surface:** only after sufficient consented data, publish
   task-class benchmark pages with minimum sample sizes, provenance, and
   uncertainty. Never rank vendors from one user's mixed task set.

The activation equation is intentionally strict:

```text
activation = valid receipt + matched local transcript + one useful card
retention = repeated cards on real changes after 30 days
commercial signal = required checks or explicit requests for team policy
```

Downloads, stars, locally generated demos, and internal dogfood do not satisfy
those states.

## Monetization hypothesis

Keep the verifier, receipt specification, local value cards, and conformance
fixtures open. Charge only after organizations demonstrate the need for:

- centralized base-anchored authority and budget policies;
- verified cost allocation across repositories, teams, agents, and models;
- retained value cards and downstream revert/incident closure;
- exception approvals and policy history;
- SIEM/webhook export, SSO, RBAC, data residency, private deployment, support,
  DPA, and SLA.

No price is justified by present adoption. The earlier $12,000-$30,000 Business
and $50,000+ Enterprise ranges remain comparable-derived hypotheses, not
pipeline, contracts, or revenue.

## Build decision after this update

Completed locally in this cycle:

- `vigil value` with Codex cumulative usage and Claude streamed-message
  deduplication;
- fail-closed `POSITIVE`, `NEGATIVE`, and `INCONCLUSIVE` value states;
- hashed billing, review, and downstream-outcome artifacts;
- stable evidence identity excluding render time;
- private text, JSON, Markdown, and standalone HTML output;
- optional post-run authority limits for tool calls, failed calls, and observed
  tokens;
- exact repeated-action, consecutive-failure, and no-observed-progress controls;
- normalized GitHub PR, review, comment, merge, Actions-runtime, and explicit
  adverse-outcome evidence with source hashes and no copied bodies;
- required-check generation and 30-day retention of GitHub evidence bundles and
  Agent Value Cards;
- a least-privilege post-run and PR-close observer that imports completed
  Actions run/job duration and final merge state without executing candidate
  code;
- local task-class, agent, and model comparisons with receipt deduplication,
  minimum sample gates, hashed-cost completeness, and 95% Wilson intervals;
- adversarial tests for tampering, mismatched transcripts, self-asserted cost,
  malformed receipts, oversized evidence, HTML injection, stable hashes, and
  private file permissions.

Next, in order:

1. Dogfood on real Agent Vigil changes, then publish only redacted cards with
   exact base/head and honest limitations.
2. Add durable, explicit links from later revert, hotfix, and incident records
   back to the originating receipt. Do not infer an incident from prose or
   guess current-run billed USD from elapsed minutes.
3. Test the activation and 30-day retention gates with externally owned
   repositories before building a hosted dashboard.

This is a stronger product than a receipt-only verifier because it connects
assurance to cost and accepted outcomes. It is still not evidence that many
people will use it, that it is best in market, or that it will produce millions
of dollars.
