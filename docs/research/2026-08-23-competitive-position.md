# Agent Vigil competitive position

Observed 2026-08-23. Product pages and repositories describe vendor claims, not independently verified performance.

## The crowded parts of the market

### AI code review

- [Greptile](https://www.greptile.com/pricing) sells repository-aware review for $30 per active developer per month and reserves self-hosting, SSO, GitHub Enterprise, security terms and support for Enterprise.
- [Graphite](https://www.graphite.com/pricing) combines review, an agent, merge queue and team workflow. Its Team plan is $40 per user per month; Enterprise adds SAML, SIEM audit logs, GHES and SLAs.
- [Qodo](https://www.qodo.ai/) combines code review and SDLC governance, with SSO, BYOK and private deployment in Enterprise.
- [CodeRabbit](https://docs.coderabbit.ai/management/roles) has repository review, administrative roles, audit logs and enterprise controls.

Agent Vigil should not become another general reviewer. Those products already have distribution, code indexing and conversational review.

### Agent evaluation and observability

- [AgentAssay](https://github.com/qualixar/agentassay) runs repeated agent trials,
  confidence tests, behavioral fingerprints, mutation operators and framework
  adapters. Its README claims the same statistical confidence at 83% lower
  cost through calibration, adaptive trial budgets and trace-first analysis.
  The repository had 5 stars and 1 fork when checked on 2026-08-23; those
  counts describe current public reach, not technical quality.
- [LangSmith](https://www.langchain.com/pricing) sells traces, evaluation, deployment and enterprise hosting for agents built as applications.

Agent Vigil should accept their evidence formats when practical. Reimplementing a general trace store or statistical laboratory would dilute the product.

### Coding-change verification

- [ProofRun](https://github.com/yebiguo/ProofRun) reruns checks against an exact commit and emits local verification receipts. Its README records an important limitation: a pull request can weaken `.proofrun.yml`; the Action warns but does not block.
- [Agentic OS](https://github.com/KbWen/agentic-os) supplies agent instructions, work logs and CI checks across several coding agents.
- [CodeVetter](https://github.com/Codevetter/codevetter/blob/main/PROJECT_STATUS.md) evaluates coding tasks using executable evidence and a qualified task corpus, initially focused on TypeScript/Node browser and API behavior.

This is Agent Vigil's closest competitive set. A receipt alone is not enough differentiation.

### Native platform controls

- GitHub now provides [local and cloud agent sandboxes](https://github.blog/changelog/2026-06-02-cloud-and-local-sandboxes-for-github-copilot-now-in-public-preview/), enterprise AI policies and detailed [Copilot usage metrics](https://docs.github.com/en/enterprise-cloud%40latest/copilot/reference/copilot-usage-metrics/copilot-usage-metrics).
- GitHub rulesets can [require a status check from a selected GitHub App](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).
- OpenAI describes sandbox policy, identity, OpenTelemetry and compliance logs in [Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/).

Agent Vigil should use these controls as inputs and enforcement points. It should not try to replace a sandbox, SIEM or vendor administration console.

## The product gap

Current products cover pieces of the record:

1. Agent vendors know prompts, tools and token use.
2. GitHub knows pull requests, reviews, checks and merges.
3. CI knows commands and test output.
4. Incident systems know reverts, hotfixes and outages.
5. Review products know findings and comments.

The durable gap is the evidence chain across those systems:

`task authority -> exact candidate -> protected policy -> executed checks -> merge disposition -> cost -> downstream outcome`

GitHub's current Copilot metrics expose adoption, prompts, generated code, accepted code and AI credits. They do not establish that a particular agent-authored change was correctly verified, accepted by a maintainer and still healthy after release.

## Where Agent Vigil can be materially better

### 1. Candidate changes cannot grade themselves

The policy and authority contract come from the pull request base commit. A candidate that edits its tests, workflow or Agent Vigil policy is still judged under the prior trusted policy. Protected paths can require a separate change.

This directly closes ProofRun's documented same-PR policy-weakening limitation.

### 2. Verification and review remain different facts

Agent Vigil records whether commands ran and what they reported. It separately records maintainer disposition and downstream outcome. A green test run does not fabricate human approval, correctness or revenue.

### 3. High-confidence test manipulation blocks; heuristics remain visible

New skips, disabled verification, zeroed coverage gates, lost assertions and reduced test counts are deterministic enough to block under the calibrated Test Integrity Guard. Broader static suspicions remain advisories until a repository calibrates them.

### 4. GitHub-native identity and enforcement

The Action binds the GitHub event's exact base and head, supports `merge_group`, stores the receipt and can be made a required check. A future minimal GitHub App can become the expected ruleset source without moving verification into a proprietary reviewer.

### 5. Upgrade decisions use repository outcomes

Upgrade Guard should compare agent, model, instruction and tool changes against each repository's own tasks. Statistical engines such as AgentAssay can supply trial evidence; Agent Vigil decides whether that evidence satisfies the protected rollout policy and later records what happened after promotion.

### 6. Cost is useful only when joined to progress and outcome

The pain ledger contains repeated reports of context replay, polling, restart storms and expensive loops. Agent Vigil should flag spend without new tool results, changed files or successful checks. Provider-billed, subscription-allocated and user-estimated cost must remain distinct.

### 7. Private by default

Source, prompts and transcripts stay local unless the operator intentionally exports them. CI can receive a compact signed receipt. Hosted reporting should ingest the smallest necessary evidence, not raw sessions.

## Product boundary

Agent Vigil is the independent release gate for agent-authored changes. It does not need to write code, review style, host an agent or replace existing tests. Its job is to prevent an agent, workflow or vendor from declaring its own work safe without evidence.

The current candidate implements the first protected
[Agent Authority Plan](../AUTHORITY_PLAN.md). It shows how a candidate changes
MCP server, tool, network, filesystem, secret-reference, hook, model, sandbox
and approval authority before merge. Snyk Agent Scan already performs broad
cross-agent discovery, so discovery alone is not a viable moat. AgentAssay
already covers stochastic regression. The narrower differentiator is a
base-owned semantic authority diff joined to observed action contracts,
exact-change evidence and downstream outcome.

## Evidence required before stronger market claims

- 10 externally owned repositories configured
- 5 retained for 30 days
- 10 maintainer-accepted catches
- fewer than 1% unexplained incorrect hard verdicts
- 3 repositories requiring the check
- 2 paid written-only pilots

Until those conditions are met, “materially differentiated implementation” is supportable. “Best product” and market leadership are not.
