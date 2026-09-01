# Product decision: verified change economics

**Reviewed:** 2026-09-01  
**Decision:** Keep Agent Vigil in independent AI change control. Add verified
economics to that lane; do not turn it into another review bot, generic agent
observability dashboard, or standalone loop killer.

## The pain is real

Recent public reports show three recurring problems.

### 1. Agents can burn paid usage without useful progress

- Anthropic users reported duplicate turns exhausting a five-hour allowance in
  minutes, restart storms, recursive subagents, and a direct request for a
  runtime token circuit breaker.
- OpenAI Codex users reported repeated waits, compaction loops, runaway
  delegation, and paid usage consumed after useful work had stopped.
- OpenCode and Gemini CLI users reported silent exploration loops, failed
  compaction, and quota exhaustion.

This is a strong need, but not an open category. AgentBudget, LoopGuard,
CostHQ, LiteLLM, Portkey, and OpenRouter already sell or ship cost limits,
loop detection, gateways, or hard budgets. Agent Vigil should accept their
output as evidence later rather than copy them.

### 2. Review tools are expensive and can create noise

CodeRabbit lists $24 and $48 per user monthly plans. Greptile lists $30 per
seat. Qodo sells team and enterprise review plans. Recent CodeRabbit community
threads complain about rate limits, unclear access to paid reviews, and a
whack-a-mole review experience. Research on real CodeRabbit feedback found that
rejected suggestions were often false positives, redundant, out of scope, or
misaligned with developer intent.

Agent Vigil should not answer this by generating more review comments. Its
advantage is a deterministic decision backed by repository evidence.

### 3. Companies cannot cleanly prove whether AI coding spend paid off

GitKraken's 2026 survey says 84% of respondents feel more productive, while
only 20% can measure the impact. An Engineering Managers discussion asks
whether usage can be connected to PR velocity or review time and calls
acceptance rate noisy. Another public discussion frames the finance question
as whether additional AI spend buys accepted, low-rework changes or more review
burden.

This is also a competitive market. GitKraken Insights, Jellyfish, LinearB, and
DX connect adoption to delivery metrics. GitKraken explicitly says its dollar
and productivity numbers are estimates rather than measurements. That leaves a
narrow gap for Agent Vigil: exact, hash-bound change evidence that refuses to
invent attribution when the provider data cannot be tied to a session.

## Candidate score

Scores are 1 (weak) to 5 (strong). They guide a product bet; they are not market
proof.

| candidate | need | want | gap | money | self-serve | total | decision |
|---|---:|---:|---:|---:|---:|---:|---|
| Generic AI review bot | 4 | 4 | 1 | 4 | 4 | 17 | Reject: crowded and noisy |
| Standalone loop and spend guard | 5 | 5 | 1 | 4 | 5 | 20 | Reject as identity: direct competitors exist |
| Engineering ROI dashboard | 5 | 4 | 2 | 5 | 2 | 18 | Reject as identity: crowded and sales-heavy |
| Exact-commit merge evidence | 5 | 4 | 4 | 4 | 5 | 22 | Keep as the core |
| Verified cost per accepted, healthy change | 5 | 4 | 4 | 5 | 4 | 22 | Build as the paid expansion |

## The product in one sentence

**Agent Vigil is the independent GitHub check that proves an AI-assisted change
met the repository's rules before merge, then keeps the evidenced cost and
later outcome attached to that exact change.**

The first screen remains `PASS`, `FAIL`, or `NOT CHECKED`. Cost and history sit
behind it. No developer leaderboard is required.

## What makes this different

1. **Exact change identity.** Base SHA, head SHA, policy, test evidence, and
   changed-file coverage belong to one receipt.
2. **Independent enforcement.** The check is owned by an App rather than the
   proposed change.
3. **Test integrity.** The product checks for weakened, skipped, patched, or
   meaningless tests instead of trusting a green test line.
4. **Honest economics.** Cost is attached only when session-level evidence can
   be bound to the receipt. Daily totals remain `NOT CHECKED`.
5. **Downstream history.** Merge, revert, hotfix, and linked incident evidence
   update the record rather than allowing the original PASS to erase a later
   problem.
6. **No employee scoring.** Compare task classes, agents, models, and outcomes;
   do not turn activity telemetry into individual performance ratings.

## What was built from this decision

The first exact-cost adapter imports Cursor Admin API usage events. It requires
one conversation ID shared by the transcript and export, sums only explicit
chargeable events, rejects duplicates and ambiguity, hashes the source files,
and feeds the amount into the existing Agent Value Card.

This is intentionally smaller than an analytics platform. It proves the
hardest part of the proposed moat: cost, verification, and outcome can share
one exact evidence identity without pretending that an aggregate billing total
belongs to a specific change.

## Money model to test, not publish as fact

Competitors show that teams already pay roughly $24-$48 per developer for AI
review, $30 per seat for Greptile, $79-$799 per month for Helicone tiers, and
custom enterprise pricing for governance and observability.

A simpler Agent Vigil hypothesis is repository-based pricing:

- Open source: local CLI and Action, free.
- Team App: $29 per protected private repository per month, unlimited
  contributors, 90-day receipt history.
- Organization: $299 per month for 25 repositories, central policy, exceptions,
  one-year evidence, and vendor/task comparisons.
- Enterprise: starting at $15,000 annually for SSO, SIEM, self-hosting,
  procurement, retention controls, SLA, and support.

Those prices are hypotheses. Do not publish or build billing until outside
repositories keep the check enabled and at least three organizations ask for
retention, policy, or economics.

One illustrative route to $1 million ARR would be 200 organizations at $299 per
month plus 20 enterprise contracts at $15,000 per year. The arithmetic works;
customer acquisition, retention, and renewal are entirely unproven.

## Proof gates before a broad launch

1. Ten externally owned repositories install the App.
2. Five still use it after 30 days.
3. Three make the App-owned check required.
4. Maintainers accept ten real contradictions.
5. Unexplained hard false verdicts stay below 1%.
6. At least two organizations produce exact cost-linked Value Cards.
7. At least three organizations request a paid control feature.
8. One pays and renews.

Until those gates move, the honest claim is: Agent Vigil has a differentiated
technical lane and a plausible revenue model. It is not yet proven superior in
the market and it is not likely to produce millions as-is.

## Source ledger

### Primary product and platform sources

- Anthropic Claude Code circuit-breaker request, 2026-08-10: <https://github.com/anthropics/claude-code/issues/85422>
- Anthropic duplicate-turn quota incident, 2026-07-12: <https://github.com/anthropics/claude-code/issues/76892>
- Anthropic restart and tool-loop report, 2026-07-26: <https://github.com/anthropics/claude-code/issues/81359>
- OpenAI Codex long-exec polling report, 2026-08-14: <https://github.com/openai/codex/issues/38495>
- OpenAI Codex runaway delegation report, 2026-08-17: <https://github.com/openai/codex/issues/38989>
- OpenAI Codex max-step request, 2026-07-15: <https://github.com/openai/codex/issues/33294>
- OpenCode compaction and Copilot credit report, 2026-08: <https://github.com/anomalyco/opencode/issues/45249>
- OpenCode silent exploration-loop report, 2026-03-23: <https://github.com/anomalyco/opencode/issues/18723>
- Gemini CLI infinite-loop report: <https://github.com/google-gemini/gemini-cli/issues/5283>
- Cursor Admin API: <https://docs.cursor.com/en/account/teams/admin-api>
- GitHub AI-credit billing API: <https://docs.github.com/en/rest/billing/usage>
- Anthropic analytics API: <https://platform.claude.com/docs/en/manage-claude/analytics-api>
- GitKraken AI impact methodology: <https://help.gitkraken.com/gk-insights/ai-adoption-impact-cost-metrics/>
- GitKraken Insights pricing: <https://gitkraken.com/insights-pricing>
- CodeRabbit pricing: <https://www.coderabbit.ai/pricing>
- Greptile pricing: <https://www.greptile.com/pricing>
- Qodo pricing: <https://www.qodo.ai/pricing/>
- Helicone pricing: <https://www.helicone.ai/pricing>
- LangSmith pricing: <https://www.langchain.com/pricing>
- Portkey budget limits: <https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits>
- LiteLLM pricing and controls: <https://www.litellm.ai/pricing>
- AgentBudget: <https://agentbudget.dev/>
- LoopGuard: <https://github.com/loop-eng/loopguard>
- CostHQ Marketplace listing: <https://github.com/marketplace/actions/costhq>
- GitKraken 2026 adoption and measurement survey: <https://gitkraken.com/reports/state-of-ai>
- Jellyfish AI Impact: <https://jellyfish.co/newsroom/end-to-end-ai-impact-sdlc/>
- LinearB AI productivity metrics: <https://linearb.io/platform/ai-developer-productivity-insights>
- DX AI measurement framework: <https://getdx.com/uploads/ai-measurement-framework.pdf>

### Community evidence; directional, not market proof

- Engineering Managers ROI-metric discussion: <https://www.reddit.com/r/EngineeringManagers/comments/1ttlf0l/how_do_you_track_whether_your_team_is_actually/>
- AI spend versus accepted low-rework changes: <https://www.reddit.com/r/ClaudeAI/comments/1tslzaq/followup_i_talked_my_manager_out_of_ranking/>
- CodeRabbit paid-rate-limit complaint: <https://www.reddit.com/r/coderabbit/comments/1vuj1jz/day_7_of_paying_for_pro_and_not_being_able_to_use/>
- CodeRabbit review-loop complaint: <https://www.reddit.com/r/coderabbit/comments/1ub34dh/limits_are_ridicolous_pro_getting_maybe_5_reviews/>
- GitKraken price and unwanted-AI complaint: <https://www.reddit.com/r/GitKraken/comments/1w2c3li/what_on_earth_are_these_prices/>
- Study of developer responses to CodeRabbit findings: <https://arxiv.org/abs/2607.03316>

