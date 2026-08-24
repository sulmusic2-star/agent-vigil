# Continuity Lab

The Continuity Lab shows one narrow behavior: a change that was once approved
can lose permission to deploy when later evidence contradicts that approval.

No account, meeting, email, webhook server, signing key, or production
repository is needed for the demonstration.

## Run it in a fork

1. Fork [Agent Vigil](https://github.com/sulmusic2-star/agent-vigil).
2. Open **Actions** in the fork and enable workflows if GitHub asks.
3. Open **Agent Vigil continuity lab**.
4. Choose **Run workflow**.
5. Open the run after its jobs stop, then read its summary.

Expected result:

| Evidence seen later | Decision | Deployment job |
|---|---|---|
| Verified merge and fresh check | `CURRENT` | Allowed |
| Authenticated revert | `REVOKED` | Stopped |
| Another ordinary green check | `REVOKED` | Still stopped |
| Independent signed repair | `CURRENT` | Allowed again |

The job named **Deployment stays stopped after the revert** should be skipped.
The job named **Independent repair restores permission** should succeed. Both
jobs contain harmless messages; neither deploys software.

## Add the same lab to a test repository

From a reviewed Agent Vigil checkout:

```bash
node dist/cli.js continuity install-action \
  --repo /path/to/test-repository \
  --action-ref <reviewed-full-Agent-Vigil-commit> \
  --self-serve
```

Review and commit the three created files. The lab is ready to run manually.
The production deployment gate remains stopped because its trusted-key lists
are empty and its deployment step is only a placeholder.

## What the lab proves

- the decision sequence is deterministic;
- a recorded revert stops the protected action;
- a later ordinary green check does not erase that stop;
- a signed repair aimed at the exact revocation can restore permission; and
- every event recorded by the lab remains in the retained history.

## What the lab does not prove

- use on a real repository change;
- evidence that every incident was observed;
- that a linked incident was caused by the change;
- protection from a repository administrator who can bypass branch or
  environment rules;
- customer demand, payment, or production adoption.

Production setup and its trust limits are in
[`CONTINUITY.md`](CONTINUITY.md).
