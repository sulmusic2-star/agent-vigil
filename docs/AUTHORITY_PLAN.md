# Agent Authority Plan

`vigil plan` shows authority changes before an agent-made pull request can
merge. It reads both revisions directly from Git, normalizes supported agent
settings, and returns `PASS`, `FAIL`, or `INCONCLUSIVE`.

```bash
vigil plan --base origin/main --head HEAD
```

Example:

```text
Agent authority plan: BLOCK
Change: 2e94a91e5f64 -> 1a0d6cf8238b

! approval   codex-approval-policy  on-request -> never
  review: approval was weakened
! sandbox    codex-sandbox-mode  workspace-write -> danger-full-access
  review: sandbox protection was weakened
! network    api.stripe.com  + mcp-server
  review: new authority requires review

3 authority change(s), 3 blocking, 0 uncertain
```

The `protect` and maintainer profiles include the same check in the required
pull-request and merge-queue receipt. The full plan stays in the retained JSON
evidence; the pull-request summary lists the blocking items in ordinary terms.

## Supported configuration

The first release reads these repository files:

- `.mcp.json`
- `mcp.json`
- `.cursor/mcp.json`
- `.vscode/mcp.json`
- `.github/mcp.json`
- `.github/copilot/mcp.json`
- `.claude/settings.json`
- `.claude/settings.local.json`
- `.codex/config.toml`

It identifies MCP servers, remote hosts, tool grants and denials, secret
variable or header names, writable paths, hooks, model identifiers, approval
modes, and sandbox settings. It never copies an environment value, bearer
token, header value, URL query, or full hook command into the report.

The adapters follow the public [Claude Code settings examples](https://github.com/anthropics/claude-code/tree/main/examples/settings),
the [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json),
and the [MCP local-server configuration guide](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers).
Formats change. A changed setting this version does not understand makes the
result `INCONCLUSIVE` instead of silently approving it.

## What blocks

The default policy blocks:

- a new or changed MCP server;
- a new network host, writable path, secret reference, hook, or tool grant;
- removal of a tool denial;
- weaker approval or sandbox settings;
- a pinned model replaced by a mutable alias such as `latest`;
- malformed or changed settings the installed adapter cannot interpret.

Removing authority is recorded as a non-blocking advisory. A model change
between two pinned versions is also visible without being described as a
privilege increase.

## Base-owned exceptions

An exception must exist in the base revision before the authority-changing
pull request starts. Put it in `.agent-vigil-authority-plan.json`:

```json
{
  "schemaVersion": 1,
  "approvedAdditions": [
    "authority:AVP006:mcp:mcp.connect:https://api.example.com@sha256:<exact-delta-digest>"
  ],
  "allowUnknownChanges": false
}
```

Each approval binds the rule, platform, action, resource, and complete
structural delta. Copy the entire `approvalKey` from the JSON plan into a
separate policy change, merge that policy first, and then rebase the authority
change so the approval exists in its exact base revision. An
approval for one host does not approve every host, and an approval for one
server identity does not approve a later command change. Editing this file in
the candidate revision cannot approve that candidate because Agent Vigil reads
the policy from the exact base commit.

`allowUnknownChanges` should remain `false`. Setting it to `true` turns unknown
changed settings into advisories, but only when that exception was already in
the base revision.

## Why this exists

Recent public reports show that effective authority is difficult to reason
about across agent products:

- A July Claude Code report says an unanswered approval question continued
  after 60 seconds; the issue drew 143 comments before closing.
  [Issue 73125](https://github.com/anthropics/claude-code/issues/73125)
- Another report says filesystem MCP calls were dropped after the approval gate
  reported success, leaving no server-side call.
  [Issue 79992](https://github.com/anthropics/claude-code/issues/79992)
- A July report describes a model-specific prompt silently overriding the
  user's delegation policy.
  [Issue 80988](https://github.com/anthropics/claude-code/issues/80988)
- Codex users have reported repeated approval prompts under bwrap, Playwright
  MCP, and Full Access mode.
  [Issue 14936](https://github.com/openai/codex/issues/14936),
  [issue 13476](https://github.com/openai/codex/issues/13476), and
  [issue 28988](https://github.com/openai/codex/issues/28988)
- A March report against the official MCP server repository described a GitHub
  write tool whose repository scope was not constrained at the schema level.
  [Issue 3751](https://github.com/modelcontextprotocol/servers/issues/3751)

These are user reports, not confirmed prevalence estimates. They establish a
repeated operational problem: configured permission, presented approval, tool
dispatch, and actual external effect can diverge. Authority Plan covers the
pre-merge configuration change. Agent Vigil's task contract and exact-change
receipt cover observed actions and code evidence. Neither proves that an
unobserved runtime action did not occur.

## Competitive boundary

[AgentAssay](https://github.com/qualixar/agentassay) runs repeated statistical
trials to find stochastic behavior regressions. That is useful and outside this
command's job. Authority Plan answers a different merge-control question:
what new authority does this exact code change grant, and did the trusted base
policy approve it?

The combined product chain is:

`config discovery -> semantic authority diff -> base policy -> observed action contract -> exact-SHA receipt -> required merge check -> downstream outcome`

Only the first three stages are provided by `vigil plan`. The remaining stages
use existing Agent Vigil commands and GitHub workflows. External adoption,
accepted catches, payment, and renewal remain unproven.
