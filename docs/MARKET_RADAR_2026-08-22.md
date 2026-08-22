# Agent Vigil market radar — 2026-08-22

This is a dated product-decision ledger, not evidence of demand, adoption, or
revenue. Official documentation establishes platform behavior. Public issues
and discussion threads establish that named users reported a problem; they do
not establish incidence across the market.

## Signals by time window

### Last week

- OpenAI Codex [issue #38687](https://github.com/openai/codex/issues/38687),
  opened 2026-08-15, reports that non-root subagents could create independent
  user-owned tasks with separate permissions. Product implication: delegation
  and `task_create` must be an explicit action class, not an implied privilege.
- Visual Studio Code's current [approval documentation](https://code.visualstudio.com/docs/agents/run/approvals)
  says Autopilot automatically approves tools and can auto-answer questions;
  it separately warns that model risk assessment can be wrong and external
  tool results may contain prompt injection. Product implication: repeated
  click approvals are not a durable evidence boundary.
- A current Claude Code [permission-dialog report](https://github.com/anthropics/claude-code/issues/85211),
  opened 2026-08-09, describes an auto-deny state whose documented remediation
  was unreachable. Product implication: policy must explain a decision and
  provide a deterministic remediation instead of leaving a dead end.

### Last month

- OpenAI Codex [issue #31424](https://github.com/openai/codex/issues/31424),
  opened 2026-07-07, asks for a complete file list and per-file diffs after an
  agent task because the UI no longer provided a reliable review surface.
  Product implication: bind the exact Git result, not just narrative or tool
  history.
- A ClaudeAI discussion about connector prompt injection
  [argues that approval descriptions can themselves be misleading](https://www.reddit.com/r/ClaudeAI/comments/1v724id/concerned_over_prompt_injections_and_claude/).
  This is anecdotal. Its useful testable requirement is to classify raw action
  arguments and destinations, not trust the agent's prose description.

### Last year

- Claude Code [issue #30519](https://github.com/anthropics/claude-code/issues/30519),
  opened 2026-03-03 with 26 comments and 80 reactions when checked on
  2026-08-22, aggregates compound-command, wildcard, configuration-precedence,
  and deny-rule complaints. Product implication: regex-only “allow command”
  controls are not a credible containment claim; ambiguous shell execution
  must remain INCONCLUSIVE.
- A Reddit thread about recovering a deleted file
  [describes approval fatigue and cumbersome sandbox setup](https://www.reddit.com/r/ClaudeAI/comments/1ru6k1h/claude_and_me_trying_to_recover_a_deleted_file/).
  The post itself was challenged as reconstructed, so it is not incident proof.
  The surrounding approval-fatigue discussion is only a design lead.

## Platform and competition boundary

- GitHub's [enterprise agent control plane](https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/)
  already provides enterprise administration, agent activity, audit filtering,
  and an MCP registry. Building a generic GitHub administration dashboard would
  compete with the platform owner.
- GitHub's current [Copilot hook documentation](https://docs.github.com/en/copilot/concepts/agents/hooks)
  already exposes pre-tool, post-tool, session, subagent, and error events for
  policy and audit integrations. Its [enterprise audit documentation](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/review-audit-logs)
  says local client prompts are not in the enterprise audit log and a custom
  hook-to-logging solution is required. Product implication: ingest vendor hook
  and telemetry streams; do not try to replace each vendor's runtime hook.
- OpenAI's [Codex safety architecture](https://openai.com/index/running-codex-safely/)
  already exports prompts, approvals, tool results, MCP use, and network policy
  events through OpenTelemetry. OpenAI explicitly notes that ordinary security
  logs explain what happened while leaving defenders to reconstruct why and
  what the user intended.
- The IETF individual draft
  [Delegation Receipt Protocol](https://datatracker.ietf.org/doc/draft-nelson-agent-delegation-receipts/04/)
  and its AuthProof implementation address pre-execution user authorization.
  Agent Vigil should interoperate later rather than claiming to invent that
  category.
- MCP firewalls, agent sandboxes, and intent-authorization gateways are already
  crowded. They prevent or broker tool calls. They generally do not bind the
  human's task boundary to an exact code result and independent regression
  evidence at the merge boundary.

## Commercial reference points

These are current vendor-published product surfaces, not proof that Agent Vigil
can win their customers.

- [CodeRabbit pricing](https://www.coderabbit.ai/pricing) places custom RBAC,
  SSO, audit logging, API access, self-hosting, multi-organization support, SLA,
  vendor review, and marketplace procurement in Enterprise. Its public Pro and
  Pro Plus prices were $24 and $48 per user/month billed annually when checked.
- [Qodo pricing](https://www.qodo.ai/pricing/) similarly places SSO/SAML, audit
  logs, governance analytics, BYOK, single-tenant/on-prem deployment, and
  priority support in a negotiated Enterprise tier.

The defensible paid surface is therefore not another generated PR comment. It
is cross-vendor policy history, retained receipts, incident reconstruction,
private deployment, enterprise identity, and procurement support. Pricing and
feature placement show what established vendors charge for; they do not prove
that buyers will pay Agent Vigil.

## Scored product options

Scores are founder hypotheses from 1 (weak) to 5 (strong), not measured market
outcomes.

| Option | Urgency | Agent Vigil adjacency | Defensibility | Distribution | Decision |
|---|---:|---:|---:|---:|---|
| Another AI code reviewer | 3 | 2 | 1 | 2 | Reject |
| Generic MCP firewall | 4 | 2 | 2 | 2 | Reject; crowded and not the current architecture |
| GitHub enterprise dashboard | 3 | 3 | 1 | 2 | Defer; platform owner already ships it |
| Cross-vendor permission-config linter | 4 | 3 | 2 | 4 | Useful future adoption feature |
| **Authority-to-outcome change control** | **5** | **5** | **4** | **4** | **Build now** |
| OS-level agent flight recorder | 5 | 4 | 5 | 2 | Long-term moat; requires endpoint engineering |

## Product decision

Agent Vigil should become a cross-vendor **AI engineering change-control and
incident-evidence layer**:

1. task-scoped human authority before work;
2. agent-native action evidence during work;
3. exact Git and test evidence after work;
4. merge/deploy enforcement from a trusted base policy;
5. portable receipts for incident reconstruction and audit.

v0.11 implements the first authority-to-outcome slice. It does not provide
runtime containment, a hosted control plane, external adoption, or paid proof.

## Commercial hypothesis and gates

The paid product would sell cross-vendor fleet policy, searchable retention,
exceptions, policy history, incident export, SIEM/OTel ingestion, self-hosting,
SSO/RBAC, and support. The open verifier remains the adoption surface.

Do not invest in that hosted product until there is evidence of:

- 10 externally owned repositories;
- 1,000 external receipts;
- five 30-day retained users;
- ten maintainer-accepted contradictions or authority violations;
- three required-check installations;
- two paid written-only pilots and at least one renewal or expansion.

Searches of X did not produce stable, directly inspectable complaint evidence
for this cycle. No X post is used to justify the product decision.
