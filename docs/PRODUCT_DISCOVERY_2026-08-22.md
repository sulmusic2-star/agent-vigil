# Agent Vigil product discovery: assurance and verified unit economics

**Research date:** 2026-08-22

**Decision state:** product hypothesis, not adoption or revenue evidence

**Evidence windows:** last 7 days, last 21 days, last 30 days, and trailing year

This report separates official platform behavior, vendor-funded surveys, public
issue reports, community discussion, research papers, and founder inference.
Issue and community reports prove that named people described a problem. They
do not establish population incidence. Vendor surveys show directional demand
but may favor the vendor's category.

The source-by-source ledger is in
[`research/2026-08-22-product-discovery/source-ledger.csv`](research/2026-08-22-product-discovery/source-ledger.csv).
The reproducible option scores are in
[`research/2026-08-22-product-discovery/decision-scorecard.json`](research/2026-08-22-product-discovery/decision-scorecard.json).
The core ledger contains 40 dated sources. A broader second pass retained 35
additional X, Reddit, Hacker News, GitHub, Product Hunt, standards, vendor, and
research signals with explicit confidence weights instead of excluding weak
evidence. See the
[`expanded signal model`](research/2026-08-22-product-discovery/EXPANDED_SIGNAL_MODEL.md)
and its
[`reproducible scorecard`](research/2026-08-22-product-discovery/expanded-signal-scorecard.json).
Limitations and the discarded counting attempt are documented in
[`RESEARCH_LIMITS.md`](research/2026-08-22-product-discovery/RESEARCH_LIMITS.md).
The post-build collision check against newer spend, loop, review-noise, and
cost-tracker signals is in the
[`value wedge update`](research/2026-08-22-product-discovery/VALUE_WEDGE_UPDATE.md).
The post-build comparison against CodeBurn, agentacct, and AgentMeter is in the
[`implemented differentiation audit`](IMPLEMENTED_DIFFERENTIATION_2026-08-22.md).

## Decision

Build **Agent Vigil Control: cross-vendor assurance and verified unit economics
for coding agents**. The append-only Verified Engineering Outcome Ledger is its
evidence substrate, not its entire user-facing product. Connect a human task
and budget, agent identity and actions, exact code outcome, verification,
maintainer disposition, review cost, merge/revert/incident outcome, and spend.

It should answer six questions for any agent-assisted change:

1. Who authorized the work and what did they authorize?
2. Which agent, model, tools, skills, and MCP servers acted?
3. What actions were observed, and which material actions were not authorized?
4. What exact code and verification outcome resulted?
5. How much human review, rework, rollback, or incident cost followed?
6. Did this agent workflow create net value for this task class?

The free inbound question is more immediate: **Which coding agent and paid plan
actually produces the most verified value on my repositories?** The product
should answer it with local evidence rather than a synthetic leaderboard.

Agent Vigil already has part of this chain: base/head identity, task authority,
observed tool actions, fresh tests, merge enforcement, and hashed receipts. The
missing product is the **longitudinal outcome closure**, not another generated
PR comment or another place to store transcripts.

The expanded signal score ranks outcome assurance first at 100.0 relative
support and verified unit economics second at 85.3. Generic observability scores
16.4 and orchestration dashboards 4.1. These are directional prioritization
indices, not purchase probabilities.

## Why this is the strongest gap

GitLab's 2026 Harris Poll survey of 1,528 developers and technology buyers is
the clearest quantitative signal:

- 91% reported two or more active AI coding tools and 54% three or more;
- 85% said the bottleneck moved from writing to review and validation;
- 34% of organizations that had an incident could not determine whether AI
  code contributed;
- fragmented toolchains and missing origin tracking were leading traceability
  barriers;
- 98% had allocated or expected to allocate AI code-governance budget.

Source: [GitLab AI Accountability release](https://about.gitlab.com/press/releases/2026-06-23-gitlab-research-reveals-organizations-are-generating-ai-code-faster-than-they-can-control-it/).
The sponsor sells a DevSecOps platform, so the budget result is not neutral
proof that Agent Vigil will be purchased. The fragmentation and incident
reconstruction results directly favor a vendor-neutral evidence layer.

Two other surveys identify the economics gap:

- ISACA's poll of 3,400+ digital-trust professionals found only 22% said AI ROI
  met or exceeded expectations; 45% said ROI was unknown or too early to tell.
  [ISACA 2026 AI Pulse Poll](https://www.isaca.org/about-us/newsroom/press-releases/2026/ai-use-accelerates-while-governance-and-roi-lag-says-new-isaca-research)
- KPMG reported that only 26% had full real-time visibility into AI operating
  cost even though 66% had dashboards and 61% had approval processes. It also
  warned that token-volume incentives confuse activity with value.
  [KPMG Q2 2026 AI Pulse](https://kpmg.com/us/en/media/news/q2-ai-pulse-2026.html)

The product implication is specific: connect engineering evidence and outcomes
to cost. A prettier token dashboard would reproduce the failure.

## What developers like

The positive signals are consistent across surveys and discussions:

- Stack Overflow's 2025 survey reported 80% AI-tool use and 69% of agent users
  seeing personal-productivity improvement.
  [Stack Overflow survey analysis](https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/)
- Sonar's 2026 survey reported 75% believed AI reduced toil and 64% had used or
  experimented with agents. Test generation, documentation, code explanation,
  issue triage, repetitive transformations, and contained fixes are repeatedly
  described as useful.
  [Sonar State of Code 2026](https://www.sonarsource.com/state-of-code-developer-survey-report.pdf)
- Experienced-developer discussions praise rapid codebase explanation,
  debugging dialogue, test-scenario generation, and operational triage when a
  human still inspects the code.
  [ExperiencedDevs discussion](https://www.reddit.com/r/ExperiencedDevs/comments/1u4ycwx/removed/)
- CodeRabbit reviews praise easy installation, bug discovery, and reducing the
  first-pass review burden.
  [G2 CodeRabbit reviews](https://www.g2.com/products/coderabbit/reviews)

Design requirement: preserve the fast local loop and automate evidence
collection. Do not add another approval click to every harmless action.

## What developers dislike

### 1. Plausible output creates a review tax

Stack Overflow reported that the leading frustration was output that is nearly
right but subtly wrong (45%), and 66% said they spend more time fixing such
code. Sonar reported that 88% experienced at least one negative technical-debt
effect; 53% saw code that looked correct but was unreliable.

Recent community reports describe QA and maintainers absorbing the increased
burden, unreadable large PRs, bot-to-bot review loops, and cognitive exhaustion:

- [August 11 ExperiencedDevs discussion](https://www.reddit.com/r/ExperiencedDevs/comments/1vlkhje/removed/)
- [Code quality in the AI age](https://www.reddit.com/r/ExperiencedDevs/comments/1sibmbw/code_quality_in_the_ai_age/)
- [2x, not 10x: coding with LLMs](https://news.ycombinator.com/item?id=49047839)

### 2. Review tools create noise and unclear economics

The most recent public CodeRabbit discussion found useful comments buried in
false positives and low-value noise. Other reports objected to opaque dynamic
rate limits and being unable to see the limiting usage metric.

- [CodeRabbit noise report, 2026-08-19](https://www.reddit.com/r/codereview/comments/1vssbl8/coderabbit_noise_is_seriously_getting_out_of_hand/)
- [CodeRabbit limit transparency report](https://www.reddit.com/r/coderabbit/comments/1uqlt5e/limits_reduced_again_without_any_communication/)
- [Empirical CodeRabbit feedback study](https://arxiv.org/abs/2607.03316)

Design requirement: Agent Vigil should report fewer, attributable findings and
measure whether maintainers accept or dismiss them. It should disclose storage,
retention, and rate limits before purchase.

### 3. Permission UIs do not equal authority

Reports in the last three weeks include:

- a mobile approval banner with no actionable approval card;
- stale enterprise permission state requiring approval for every tool;
- files deleted outside a working directory during auto-approve;
- personal folders scanned without a permission prompt;
- a source-verification task expanded into persistent package replacement;
- a non-root subagent reaching root task-creation controls.

Primary reports:
[Codex #39346](https://github.com/openai/codex/issues/39346),
[VS Code #328879](https://github.com/microsoft/vscode/issues/328879),
[Claude Code #84107](https://github.com/anthropics/claude-code/issues/84107),
[Claude Code #84686](https://github.com/anthropics/claude-code/issues/84686),
[Codex #37677](https://github.com/openai/codex/issues/37677), and
[Codex #38687](https://github.com/openai/codex/issues/38687).

Design requirement: record the human task boundary independently from runtime
approval state. Preserve `user approved`, `user rejected`, `agent cancelled`,
`expired`, and `transport lost` as distinct lifecycle outcomes.

### 4. Multi-agent coordination becomes supervision work

Users describe the coordination tax of running several agents as becoming an
"air traffic controller" and spending more time managing terminals than
shipping. Organizations are simultaneously increasing multi-agent use: KPMG
reported orchestration across workflows doubled from 9% to 18% quarter over
quarter.

Design requirement: represent delegation as a parent-child evidence graph,
including inherited authority, effective policy, cost, and final contribution.
Do not build another orchestration UI.

## Platform-owner and competitor boundary

### Capabilities we should not duplicate

- GitHub Copilot already provides lifecycle hooks, runtime allow/deny, signed
  agent commits, session links, and enterprise agent audit events.
  [Copilot hooks](https://docs.github.com/en/copilot/concepts/agents/hooks),
  [agent-session tracking](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents),
  [agent audit events](https://docs.github.com/en/copilot/reference/enterprise-administrators/agentic-audit-log-events)
- GitLab Duo already has composite identity, stored AI audit events, and a
  governance surface for its own agent platform.
  [GitLab AI audit events](https://docs.gitlab.com/user/duo_agent_platform/ai-audit-events/),
  [composite identity](https://docs.gitlab.com/user/duo_agent_platform/composite_identity/)
- Snyk Evo ADS now discovers agent tools, governs runtime behavior, scans agent
  output, and supports hook deployment across leading coding environments.
  [Snyk Evo ADS](https://snyk.io/news/snyk-launches-evo-agentic-development-security/),
  [Snyk hooks](https://updates.snyk.io/snyk-studio-introducing-asynchronous-hooks-based-guardrails-for-ai-agents/)
- LangSmith and other observability platforms already store application-agent
  traces and sell long retention, hybrid hosting, and enterprise access control.
  [LangSmith pricing](https://www.langchain.com/pricing)
- Traces.com already imports sessions from more than ten coding agents, links
  traces to Git activity, supports redacted sharing, and offers team analytics.
  [Traces.com](https://traces.com/)
- AgentTrace offers application-agent event storage, SDKs, webhooks, and a
  free self-hosted tier. Storage and trace viewing are already inexpensive.
  [AgentTrace pricing](https://agentlogs.app/pricing)
- Agen.co sells cross-surface discovery, per-action governance, audit chains,
  SIEM export, and hybrid/on-prem deployment. AgenC Core also produces outcome
  receipts inside its own coding-agent harness.
  [Agen.co pricing](https://agen.co/pricing),
  [AgenC Core](https://agenc.ag/core)
- CodeRabbit and Qodo already dominate the generated-review-comment category
  and sell enterprise governance features.
  [CodeRabbit pricing](https://www.coderabbit.ai/pricing),
  [Qodo pricing](https://www.qodo.ai/pricing/)

### Why raw traces and ledgers are not the moat

Cross-agent transcript import, searchable events, redacted trace sharing,
retention, audit export, and local SQLite are now commodity capabilities. The
reviewed products above either provide them or can add them. Calling Agent
Vigil a generic ledger would place it in a crowded category with weak pricing
power.

The narrower wedge is **engineering outcome accountability**. A trace says what
an agent appeared to do. An outcome episode must also bind that trace to:

- the human's exact authority boundary and the agent's effective authority;
- an immutable code delta and independently observed verification;
- the maintainer's accepted/dismissed disposition, not the tool's own verdict;
- later merge, revert, escaped-defect, and incident outcomes;
- review, rework, model, and platform cost with explicit provenance.

Raw traces are inputs. The defensible asset is a longitudinal, cross-vendor
dataset of what was authorized, what shipped, what humans accepted, what later
failed, and what it cost. Portable signed receipts and a public conformance
standard keep that dataset from becoming a proprietary screenshot dashboard.

### The remaining opening

No reviewed source establishes a widely adopted neutral product that binds all
of the following across Codex, Claude Code, Copilot, Cursor, Gemini CLI, Aider,
and OpenCode:

- human task authority;
- observed action and delegation history;
- exact Git and executable verification result;
- maintainer disposition and review burden;
- later merge, revert, escaped-defect, and incident outcome;
- agent/model/tool cost;
- a portable, signed, privacy-reduced receipt.

This is a gap hypothesis, not a claim that no competitor anywhere has any of
these capabilities. GitHub, GitLab, and Snyk can expand into it. Cross-vendor
portability, open receipts, local-first evidence, and outcome data are the
defensible route.

## Product equation

Do not optimize token volume, generated lines, PR count, or tool-call count.
Those are activity metrics.

For a repeated task class, estimate:

```text
Net Agent Value =
  baseline human delivery cost avoided
  + expected rework or incident cost avoided
  - model and platform spend
  - human review and correction cost
  - rollback and escaped-defect cost
```

Every term must link to an evidence episode and an explicit baseline. When a
baseline or outcome is unavailable, report `INCONCLUSIVE`, not an ROI number.

Core metrics:

- cost per verified merge;
- median human review minutes per accepted change;
- correction and rework ratio;
- unauthorized-action and out-of-scope-change rate;
- evidence completeness rate;
- 7/30/90-day revert or incident association;
- accepted findings per 100 findings, separated by deterministic and
  model-generated sources;
- net value by repository, task class, agent, model, and policy version.

## Option scorecard

The score is a transparent founder-ranking heuristic, not measured market
share. Positive factors are pain, budget, urgency, Agent Vigil adjacency,
organic distribution, moat, data flywheel, and solo feasibility. Risks are
platform capture, crowding, and evidence difficulty.

| Product option | Adjusted score / 100 | Decision |
|---|---:|---|
| Verified engineering outcome ledger | 79.0 | Build, with a narrow outcome wedge |
| Review-noise measurement layer | 71.0 | Include as an outcome module |
| Open-source AI PR slop gate | 69.2 | Use as adoption surface, not company |
| Permission-config linter | 65.8 | Useful free acquisition feature |
| Generic AI reviewer | 60.5 | Reject |
| Runtime agent security gateway | 58.5 | Reject; Snyk/platform owners are ahead |
| Standalone AI ROI dashboard | 57.8 | Reject; lacks trustworthy evidence inputs |

## Product shape

### Free and open

- `vigil record`: configure supported agent hooks/telemetry into a private local
  append-only episode.
- `vigil close`: bind the episode to task authority, exact Git result, tests,
  review state, and a signed receipt.
- `vigil explain`: concise timeline and deterministic remediation.
- `vigil ledger`: local searchable SQLite/JSONL ledger with retention controls.
- GitHub Action evidence plus externally controlled required-workflow or App
  enforcement for pull requests and merge queues.
- Portable public receipt with hashes and counts but no prompt or source text.
- Transparent local comparison of agents and review tools using the user's own
  accepted/rejected outcomes.

### Paid after adoption proof

- organization-wide GitHub App and cross-host collectors;
- centralized policy and exception history;
- append-only receipt retention and incident export;
- SIEM/OTel/webhook integration;
- cost-per-verified-outcome and review-tax analysis;
- agent, model, and tool comparison with confidence and sample-size warnings;
- shadow-agent/MCP/skill inventory from declared collectors;
- SSO, RBAC, data residency, self-hosted/air-gapped deployment;
- SLA, DPA, MSA, support, and evidence retention policies.

## Organic distribution design

No product can guarantee inbound adoption. Reduce dependence on outbound with:

1. one-command setup and hook generation;
2. a useful private local ledger before account creation;
3. a stable public receipt format other tools can emit;
4. shareable, redacted failure replays and GitHub status badges;
5. indexable, source-backed pages for specific problems such as Codex approval
   stalls, Claude Code deletion boundaries, AI code traceability, and review
   noise;
6. a public adapter conformance suite so agent vendors and community projects
   can self-certify integrations;
7. a public failure corpus where maintainers, not Agent Vigil, record whether a
   contradiction was useful.

Google's public 2025 AI search page lists “best AI for coding” as the leading
“AI for ...” query. This supports comparison content, not measurable search
demand for “agent governance.” Product-specific keyword volumes were not
available from a reproducible primary source in this cycle. SEO phrases remain
hypotheses until Search Console or another measured channel supplies evidence.

The expanded search recovered public X text and engagement indicators through
indexed results. Those posts now contribute at lower community-signal weights.
They surfaced demand for agent-native CLI/API/MCP distribution, comparisons of
memory drift and failure recovery, tests as the control system for long-running
agents, and runtime-ledger competition:
[agent-native distribution](https://x.com/kcdenman/status/2026390774301209007),
[cross-agent reliability comparison](https://x.com/danveloper/status/2037538213917594021),
[multimodal implementation failures](https://x.com/wightmanr/status/2040115036400820308),
[long-running agent controls](https://x.com/mihail_eric/status/2032145866614849665),
and [AgenC runtime ledger](https://x.com/tetsuoai/status/2032031965575332172).
They remain anecdotes or marketing, but convergence with other channels makes
them useful discovery evidence.

## Build order

### Cycle 1: episode standard, cost import, and private recorder

1. Extend and implement the
   [`ai-change-episode-v1`](AI_CHANGE_EPISODE_V1.md) contract with task budget,
   metered-cost provenance, and privacy tiers.
2. Add read-only Codex and Claude Code session/cost importers before expanding
   to more agents.
3. Store locally in append-only JSONL plus SQLite indexes.
4. Bind parent/child task delegation and task-authority inheritance.
5. Produce a deterministic timeline, signed receipt, and local Agent Value
   Card.

### Cycle 2: value comparison and review-tax closure

1. Record PR open/merge/close, review duration, requested changes, accepted and
   dismissed automated findings, revert, and incident linkage.
2. Add `vigil value`, task-budget warnings, and repository-local comparison of
   agents and paid plans.
3. Calculate cost per verified merge and review tax only when baseline evidence
   is sufficient.
4. Add a local static HTML report; no hosted account required.

### Cycle 3: external proof

Do not build the hosted enterprise product until the ledger has:

- 10 externally owned repositories;
- 1,000 external episodes or receipts;
- five users retained for 30 days;
- three different agent vendors represented;
- ten maintainer-accepted contradictions or authority violations;
- three required-check installations;
- two organizations requesting retention, fleet policy, or incident export;
- two paid written-only pilots and one renewal or expansion.

## Falsification conditions

Stop or narrow this direction if any of these occur:

- maintainers will not install collectors even when all evidence stays local;
- fewer than 20% of retained users inspect the ledger after initial setup;
- review-time and outcome data cannot be collected without burdensome manual
  entry;
- vendor-native audit exports become portable and cross-vendor enough to make
  independent receipts redundant;
- deterministic findings create more than 1% unexplained hard false verdicts;
- organizations express interest only in generated code review, not evidence,
  outcomes, or incident reconstruction.

## Commercial conclusion

The evidence supports a serious category: organizations are generating code
faster than they can review, trace, govern, or economically evaluate it. It
does not prove that Agent Vigil has demand. The most credible million-dollar
path is to become the open, cross-vendor outcome-accountability layer beneath
AI engineering—not another agent, reviewer, firewall, trace viewer, or vanity
dashboard.

Millions would require retained usage and paid renewals. This research improves
the product bet; it does not guarantee the financial outcome.
