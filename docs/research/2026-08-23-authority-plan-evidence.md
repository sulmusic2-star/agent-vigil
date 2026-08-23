# Authority Plan evidence review

Observed 2026-08-23. Sources establish problem pressure and a competitive
opening. They do not establish prevalence, purchase intent, product-market fit,
market leadership, or revenue.

## Practitioner evidence

- Anthropic reports that Claude Code users approve 93% of permission prompts,
  which it identifies as approval-fatigue pressure. It also reports a 17%
  false-negative rate on a 52-case set of real overeager actions for the full
  auto-mode pipeline. Anthropic explicitly says that path is not a replacement
  for careful review of high-stakes infrastructure.
  [Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)
- One Claude Code issue author reports 136 allow rules, 31 ask rules, repeated
  prompts, and ineffective compound-command matching. Another reports 238
  individually accumulated permission entries after 17 days of production
  use. These are user reports, not independently reproduced product findings.
  [Issue 30519](https://github.com/anthropics/claude-code/issues/30519)
  [Issue 36959](https://github.com/anthropics/claude-code/issues/36959)
- A Codex issue reports that an explicitly approved bounded plan expanded into
  adjacent files, rules, retries, and resource use without a renewed scope
  decision. This is a user report, not a measured Codex-wide failure rate.
  [Codex issue 36600](https://github.com/openai/codex/issues/36600)
- A GitHub MCP Server feature request says organizations lack centralized
  server and tool allow/deny policy and describes the resulting third-party
  data-governance concern. An MCP discussion separately proposes portable
  per-tool authorization, delegation attenuation, constraints, and audit logs.
  [GitHub MCP issue 1048](https://github.com/github/github-mcp-server/issues/1048)
  [MCP discussion 2498](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2498)

## Standards direction

- NIST is defining identity and authorization requirements for software and AI
  agents, including identification, authorization, auditing, delegation, and
  non-repudiation.
  [NIST NCCoE](https://www.nccoe.nist.gov/projects/software-and-ai-agent-identity-and-authorization)
- OpenID AuthZEN defines subject, action, resource, and context inputs to an
  external policy decision point and now has an MCP binding.
  [AuthZEN](https://openid.github.io/authzen/)
  [MCP binding](https://openid.github.io/authzen/authzen-coaz-mcp-binding-1_0.html)
- The World Economic Forum and Capgemini describe enforceable agent
  authorization, delegation, oversight, and accountability as an adoption
  requirement. Agent Vigil is only aligned with that direction; no conformance
  claim is made.
  [WEF](https://www.weforum.org/publications/ai-agents-in-action-a-playbook-for-trusted-adoption-authorization-and-scaling/)

## Competitive conclusion

Runtime gateways, MCP scanners, red-team platforms, and trace evaluators are
already crowded. The narrower opening is source-control change protection:

```text
cross-vendor discovery
  -> semantic authority diff
  -> policy owned by the trusted base revision
  -> contained behavioral canaries
  -> exact-revision evidence
  -> required merge check
```

The implemented first slice covers repository-declared MCP, Claude Code, and
Codex configuration. It uses control-specific partial orders rather than a
score. Known authority-bearing sections that are not normalized return `HOLD`.
This is harder to copy than a configuration linter only if the corpus,
normalizers, accepted catches, retained installations, and policy integrations
continue accumulating. Code alone is not a durable moat.

## Commercial decision

Decision: `TEST`, not `BUILD AT SCALE`.

The buyer hypothesis is a platform engineering or application-security team
that permits coding agents to call tools or modify repositories. The paid job
is preventing an unreviewed authority expansion from merging, not producing a
security score. A possible 400 customers at $250 per month equals $1.2 million
ARR, but that is arithmetic. No current evidence establishes 400 customers,
the price, retention, or even two paying teams.

The decisive gate remains ten externally owned installations, three
maintainer-accepted catches, three retained required checks after 30 days, and
two written-only paid pilots. Until then, the product is a technically
supported hypothesis.
