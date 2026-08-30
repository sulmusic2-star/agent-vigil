# Task-scoped authority reconciliation

Agent Vigil v0.11 adds a deterministic answer to a narrower question than a
runtime sandbox:

> Did the repository change and the **observed** agent actions stay inside the
> task authority a human issued before the change?

It compares three independently identified inputs:

1. a structured transcript from a supported coding agent;
2. the exact Git `base..head` result;
3. a short-lived authority contract loaded from a trusted Git revision.

The output is a normal Agent Vigil PASS / FAIL / INCONCLUSIVE receipt with JSON,
Markdown, SARIF, a deterministic hash, and optional Ed25519 signing.

## Install the authority profile

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.23.1/sulmusic-agent-vigil-0.23.1.tgz \
  init --profile authority --action-sha <reviewed-full-commit>
```

This creates `.agent-vigil-authority.json`, the ordinary base policy, a private
transcript placeholder, and a GitHub workflow. Review and commit the contract
before opening the code pull request. The generated workflow loads the contract
from the pull request base SHA; the candidate cannot grant itself permission by
widening its worktree copy.

The generated workflow is pull-request-target-only, credential-free, and
limited to the v0.21.2 hosted Node contract. Local reconciliation below runs
with the local process's host privileges and is not a sandbox. See the
[hosted security contract](HOSTED_SECURITY_CONTRACT.md).

Local reconciliation:

```bash
vigil authority /private/session.jsonl \
  --contract .agent-vigil-authority.json \
  --contract-ref "$BASE_SHA" \
  --repo . --base "$BASE_SHA" --head "$HEAD_SHA" \
  --output authority-receipt.json --sarif authority-receipt.sarif
```

## Contract

```json
{
  "schemaVersion": 1,
  "taskId": "SEC-142",
  "allowedChangePaths": ["src/**", "test/**", "docs/**"],
  "deniedChangePaths": [".github/workflows/**", ".env*", "**/*.pem"],
  "allowedActions": [
    "repository_read",
    "repository_write",
    "test_execute",
    "build_execute"
  ],
  "requireCompleteToolResults": true,
  "maxToolCalls": 120,
  "maxFailedToolCalls": 5,
  "maxIdenticalToolCalls": 8,
  "maxConsecutiveFailedToolCalls": 3,
  "maxObservedTokens": 500000,
  "maxTokensWithoutObservedProgress": 100000,
  "expiresAt": "2026-08-23T12:00:00.000Z"
}
```

Supported action classes are:

- `repository_read`, `repository_write`
- `test_execute`, `build_execute`, `dependency_install`
- `network_read`, `credential_access`, `destructive_filesystem`
- `git_commit`, `git_push`, `pull_request_write`
- `release_publish`, `deploy`, `external_write`, `task_create`
- `unknown_effect`

The generated template deliberately excludes installation, credentials,
destructive operations, push, PR mutation, release, deployment, external
writes, and task creation. Adding one is an explicit human policy decision.
Allowing `unknown_effect` still produces INCONCLUSIVE because an unclassified
action is not a meaningful boundary.

## Verdict semantics

**FAIL** includes:

- an exact changed path outside `allowedChangePaths`;
- any path matching `deniedChangePaths`;
- an observed tool call classified into an action outside `allowedActions`;
- an observed tool-call, failed-call, or supported transcript token count above
  its optional predeclared limit;
- an expired authority window.

**INCONCLUSIVE** includes:

- narrative-only evidence with no structured tool calls;
- missing terminal tool results when completeness is required;
- a declared token limit when the transcript adapter exposes no usage evidence;
- an action that cannot be classified safely;
- invalid, unknown, oversized, or traversal-bearing contract input;
- a workspace that does not match the selected head.

**PASS** means the exact Git result stayed within the path boundary, every
structured observed action stayed within the declared classes, terminal tool
results were present, and no blocking evidence gap remained.

## Security boundary

This is an **independent post-execution evidence gate**, not an operating-system
sandbox, network proxy, credential broker, or proof that no unlogged action
occurred. A vendor transcript can omit activity outside its capture surface.
Agent Vigil therefore says “observed actions” throughout the receipt.

Use runtime isolation, scoped credentials, egress controls, and MCP/tool
gateways to prevent actions. Use Agent Vigil to bind the resulting code and
available trajectory to the human-issued task boundary and fail closed when
the evidence cannot support that conclusion.

The optional call and token limits are post-run merge controls. They detect an
over-budget trajectory and can block its receipt; they do not interrupt a live
agent. A real runtime circuit breaker must be enforced by the agent host or a
provider gateway that can stop execution.

The repeated-action detector compares exact normalized observed tool actions;
it does not use a model to guess whether two different commands are
semantically equivalent. The no-progress token guard is deliberately narrower:
it checks whether the entire observed session contains a repository write,
test, build, or commit. It does not claim that every token before or after that
action was productive.
