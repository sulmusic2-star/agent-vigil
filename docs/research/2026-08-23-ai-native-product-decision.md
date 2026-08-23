# AI-native product decision

Observed 2026-08-23. This is a product hypothesis, not evidence of adoption, payment, revenue, or market leadership.

## Decision

**TEST: Agent Vigil Authority Plan**

Agent Vigil should become the protected change-control gate for AI agents:

> Before an agent change merges, show exactly what the agent can newly read,
> write, call, spend, or do without approval, then prove whether the exact
> candidate stayed inside the trusted boundary.

The simplest analogy is `terraform plan` for agent authority. The first useful
surface is a local CLI and required GitHub check, not a hosted dashboard.

Stoa workflow monitoring, generic AI code review, general agent observability,
runtime IAM, and another broad MCP scanner are not the lead product.

## Why this direction

- OpenAI reports enterprise work moving from assistance to delegated execution:
  Codex represented 64% of combined Codex and ChatGPT output tokens among its
  enterprise customers as of June. It also says adoption needs clear
  permissions, governance, and human review.
  [Source](https://openai.com/index/how-enterprises-put-ai-to-work/)
- NIST says commenters widely agreed agents create novel security threats and
  that security concerns are a barrier to adoption.
  [Source](https://www.nist.gov/publications/summary-analysis-responses-request-information-regarding-security-considerations-ai)
- NIST's identity and authority project explicitly calls out agent
  identification, authorization, auditing, non-repudiation, and prompt
  injection controls.
  [Source](https://www.nist.gov/news-events/news/2026/02/new-concept-paper-identity-and-authority-software-agents)
- OWASP recommends least privilege, explicit approval for high-impact actions,
  action-bound approval records, fail-closed policy lookup, adversarial tests,
  and CI release gates.
  [Source](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- MCP authorization and lifecycle changes are becoming more formal and more
  operationally significant. The 2026-07 release candidate adds authorization
  hardening, trace context, security-reviewable tool UI declarations, and a
  redesigned task lifecycle.
  [Source](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)

These sources establish category urgency. They do not prove demand for Agent
Vigil's exact product.

## The gap after competition

The market is not empty:

| Product | What it already covers | Remaining boundary |
|---|---|---|
| [Snyk Agent Scan](https://github.com/snyk/agent-scan) | Discovers and scans MCP servers, skills, and agent configurations | Current posture scanning, not a protected exact-base/exact-head authority plan |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | LLM evaluations, red teaming, and CI | Broad eval platform, not cross-vendor effective-authority change control |
| [Maida](https://github.com/maida-ai/maida) | Trace baselines, tool-path regression, loops, cost, and CI | Runtime behavior regression, not config discovery plus trusted authority delta |
| [mcpdiff](https://github.com/samlader/mcpdiff) | MCP schema and semantic change detection | MCP contracts only, not model, prompt, hook, network, approval, and agent-policy changes |
| [agentguard](https://github.com/yingchen-coding/agentguard) | Static security linting for agent definitions and skills | Definition linting, not exact candidate execution and signed merge evidence |
| [MCP Guard](https://github.com/permission-protocol/mcp-guard) | Runtime MCP allow, block, approval, and receipts | Runtime proxy, not pre-merge authority planning |
| [GitHub Agentic Workflows](https://github.com/github/gh-aw) | Sandboxed, read-only agent workflows and safe outputs | Secures its own workflow system, not a cross-vendor independent gate |

The defensible combination is:

`cross-vendor discovery -> semantic authority diff -> trusted policy -> contained canaries -> exact-SHA receipt -> required merge check`

No reviewed competitor currently demonstrates that full chain. That is a
dated competitive observation, not a permanent moat.

## Product surface

The first command should be:

```bash
vigil plan --base origin/main --head HEAD
```

Example output:

```text
Agent authority plan: BLOCK

+ tool       stripe.refunds.create
+ network    api.stripe.com
~ approval   required -> bypass
~ files      repository -> /Users/*
~ model      pinned gpt-5.4 -> mutable latest
! proof      canonical test command removed

5 authority changes, 3 blocking, exact head abc1234
```

It should discover and normalize, in order:

1. MCP server and tool definitions, schemas, safety annotations, and auth.
2. Claude Code, Codex, Cursor, and GitHub agent configuration.
3. Agent, skill, prompt, hook, and policy files.
4. Model identifiers and mutable aliases.
5. Filesystem, network, secret, token, and external-write scope.
6. Approval, sandbox, and human-review settings.
7. Test, verifier, and workflow changes that could weaken the gate.

The base revision owns policy. A candidate cannot approve its own new authority.
Unknown formats or incomplete evidence return `INCONCLUSIVE` or `HOLD`, never a
green result.

## What is already real

The `0.13.0` candidate already provides substantial reusable machinery:

- exact base/head binding and base-anchored policy
- PASS, FAIL, and INCONCLUSIVE release receipts
- task-scoped authority contracts and observed action classification
- exact-SHA GitHub enforcement and attestation support
- test-integrity and policy-weakening checks
- contained current/candidate Upgrade Guard canaries
- capability-field comparison and SAFE, CHANGED, HOLD decisions
- cross-agent transcript adapters

Verification on 2026-08-23:

- 391 tests passed when the five opt-in Docker tests used the selected local,
  digest-pinned image; the ordinary run passed 386 and skipped those five
- 20 of 20 failure-corpus expectations matched
- public-surface gate passed

This does not yet provide native cross-vendor config discovery or a semantic
authority plan. Those are the product-defining missing pieces.

## Commercial path

Initial buyer: platform engineering, AppSec, and AI infrastructure teams that
allow agents to call tools, modify repositories, or perform external actions.

Initial packaging:

- Open-source CLI and GitHub Action for one repository.
- Team service for organization policy, retained receipts, required-check
  management, and change history.
- Enterprise later for GitHub Enterprise, GitLab, self-hosting, SSO, SIEM
  export, custom policy packs, and support.

Adjacent prices show that teams already pay for agent evaluation and code
control: LangSmith Plus is $39 per seat plus usage, and Greptile is $30 per
active developer plus excess reviews. These prices support testing a paid team
product; they do not establish Agent Vigil's price.

One possible million-dollar arithmetic path is 400 organizations at $250 per
month, or about $1.2 million ARR. That is arithmetic only. There is no evidence
today that 400 organizations will buy this product.

## Validation gate

Do not build a broad hosted platform yet. Build and test one thin slice:

1. `vigil plan` supports MCP plus two coding-agent configuration formats.
2. Run it against 100 real public revisions with planted and natural changes.
3. Measure false blocks separately from missed high-risk changes.
4. Install it in 10 externally owned repositories.
5. Require 3 maintainer-accepted catches and 3 repositories retaining the
   required check for 30 days.
6. Require 2 written-only paid pilots before organization dashboards, runtime
   enforcement, or enterprise integrations.

Stop or reposition if maintainers treat the report as ordinary diff noise, if
native platforms expose an equivalent protected authority plan, or if fewer
than two unrelated teams pay after seeing real catches.

## Honest boundary

This direction is more AI-native and technically defensible than Stoa. The
category has documented urgency and paid adjacent products. The exact wedge
remains unproven, and small direct competitors are arriving quickly. The
correct decision is `TEST`, not `BUILD AT SCALE` and not a public
market-leadership claim.
