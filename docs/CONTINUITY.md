# Agent Vigil continuity

A change can pass every required check and still become unsafe to deploy later.
Agent Vigil continuity keeps the original result and adds later facts such as a
merge, revert, linked incident, expired check, or independently verified repair.

Run the built-in example first:

```bash
vigil continuity demo
```

It shows one change moving through this exact sequence:

1. The original check passes.
2. Authenticated merge evidence and a fresh check allow deployment.
3. An authenticated revert stops deployment.
4. A later ordinary green check does not erase the revert.
5. Independent signed repair evidence allows deployment again.

The result lists all five recorded event types in order.

## See the behavior in GitHub

The repository includes a manual
[`Agent Vigil continuity lab`](../.github/workflows/agent-vigil-continuity-lab.yml).
It uses made-up evidence, has read-only permission, reads no secrets, and never
deploys software.

1. Fork the Agent Vigil repository.
2. Open **Actions** in the fork and enable workflows if GitHub asks.
3. Choose **Agent Vigil continuity lab**, then choose **Run workflow**.
4. Open the run after its jobs stop.

The run should show three jobs:

- **Build the five-step evidence history** succeeds.
- **Deployment stays stopped after the revert** is skipped.
- **Independent repair restores permission** succeeds.

The retained JSON file contains the same five readable decisions as the local
command. This is a product demonstration, not evidence of use on a real change.

## The four results

| Result | Meaning | Deployment |
|---|---|---|
| `CURRENT` | Every required record is present, valid, and recent. | Allowed |
| `HOLD` | A required record is missing or cannot be checked. | Stopped |
| `EXPIRED` | A required record is too old. | Stopped |
| `REVOKED` | Later evidence contradicts the earlier approval. | Stopped |

Only `CURRENT` allows a protected action. This is a policy decision about the
recorded evidence. It is not a claim that the code is free of defects.

## Start a history

```bash
vigil continuity init agent-vigil-report.json \
  --output .agent-vigil/continuity

vigil continuity verify \
  --chain .agent-vigil/continuity \
  --expected-head <exact-reviewed-commit>

vigil continuity status \
  --chain .agent-vigil/continuity \
  --policy .agent-vigil-continuity.json \
  --repo . \
  --policy-ref <exact-base-commit> \
  --expected-head <exact-reviewed-commit> \
  --environment production
```

The policy is read from the exact base commit. A proposed change therefore
cannot weaken the policy used to judge itself. The expected head check also
prevents a valid history for one commit from authorizing another commit.

## Record GitHub outcomes

The first GitHub importer accepts one saved webhook request. It does not scan
repositories and it does not require a GitHub App.

```bash
vigil continuity import-github \
  --chain .agent-vigil/continuity \
  --event webhook-body.json \
  --delivery-id <x-github-delivery-value> \
  --webhook-signature <x-hub-signature-256-value> \
  --webhook-secret-file webhook-secret.txt \
  --signing-key outcome-recorder-private.pem
```

Before writing anything, the importer checks the webhook signature, repository,
full commit IDs, event shape, and exact link to the original change. It accepts:

- a merged pull request whose base and head match the original receipt;
- a push containing an exact revert reference to the original head commit;
- a merged pull request labeled `hotfix` or `emergency-fix` and
  `agent-vigil:<original-full-head-commit>`;
- an issue labeled `incident`, `outage`, or a severity such as `sev-1`, plus
  `agent-vigil:<original-full-head-commit>`.

An incident record means only that the incident was explicitly linked to the
change. It does not claim that the change caused the incident.

The saved event contains hashes and fixed categories. It does not contain the
webhook body, repository name, file path, issue text, secret, or signature
header. Repeating the same delivery returns the existing record. Reusing that
delivery ID with different evidence is rejected.

A valid webhook signature proves that the body matches the configured secret.
It does not prove that the signing secret or the machine holding it was safe.

If the outcome recorder is unavailable, record that gap with an accountable
local signing key:

```bash
vigil continuity import-github \
  --chain .agent-vigil/continuity \
  --unavailable \
  --delivery-id <new-uuid> \
  --observed-at <UTC-time> \
  --signing-key outcome-recorder-private.pem
```

An outage produces `HOLD`. It can never produce `CURRENT`.

### Use the event GitHub Actions already provides

A separate command reads the current workflow event directly. It does not need
a webhook server or webhook secret:

```bash
umask 077
printf '%s' "$AGENT_VIGIL_OUTCOME_PRIVATE_KEY" \
  > "$RUNNER_TEMP/agent-vigil-outcome-private.pem"

vigil continuity import-github-actions \
  --chain .agent-vigil/continuity \
  --signing-key "$RUNNER_TEMP/agent-vigil-outcome-private.pem"
```

The command runs only when GitHub Actions supplies the event file, event name,
and repository identity. It checks all three against the original receipt. It
then applies the same merge, revert, hotfix, and linked-incident rules as the
webhook importer. Repeating the same event does not add a duplicate.

The private signing key identifies the approved outcome-recording workflow. A
production repository must keep that key away from pull-request code and from
the change author when independent evidence is required. Run the import before
checking out or executing untrusted code. Do not place the key in a workflow
that forks can read. If the key is missing or the importer cannot run, record a
signed coverage gap; do not assume the previous approval remains current.

## Add the deployment check

This command creates a conservative policy and a separate GitHub workflow:

```bash
vigil continuity install-action \
  --repo . \
  --action-ref <reviewed-full-Agent-Vigil-commit>
```

To add the manual demonstration at the same time:

```bash
vigil continuity install-action \
  --repo . \
  --action-ref <reviewed-full-Agent-Vigil-commit> \
  --self-serve
```

It creates:

- `.agent-vigil-continuity.json`
- `.github/workflows/agent-vigil-continuity.yml`

`--self-serve` also creates
`.github/workflows/agent-vigil-continuity-lab.yml`. That lab needs no key and
cannot deploy. It gives a repository owner a safe way to see the decision
change before configuring production evidence.

The generated policy starts with empty trusted-key lists. It cannot allow a
deployment until an operator adds the approved root and event signing key IDs,
reviews the files, and commits them. Existing pull-request and merge-queue
workflows are left unchanged.

The workflow downloads an artifact named `agent-vigil-continuity`, checks that
its recorded head equals the selected evidence run's exact head, reads policy
from the recorded base commit, and runs the Action at the full commit supplied
to `--action-ref`. The workflow pins the supporting GitHub Actions to full
commits and does not retain checkout credentials.

The second job runs only when the result is `CURRENT`. It contains a clearly
marked placeholder and does not deploy anything. Replace that placeholder with
a separately reviewed deployment step.

The workflow expects another approved process to upload the continuity history
as the `agent-vigil-continuity` artifact. This version does not host the history,
collect webhooks as a service, or upload that artifact for you.

## Signed records and repairs

Use Ed25519 keys that the change author cannot access when separation matters.
A production policy should require a signed original receipt and signed later
records, then list the allowed key IDs in `trustedRootKeyIds` and
`trustedIssuerKeyIds`.

A revocation stays in the history. It becomes inactive only when the policy
allows repair and a later `remediation_verified` record:

- names the exact revoking event;
- comes from the verification source;
- is signed by an approved independent key;
- contains fresh evidence and a target hash;
- has not expired.

An ordinary green check cannot clear a revocation.

## What is stored

```text
.agent-vigil/continuity/
  receipt.json
  root.json
  tip.json
  events/
    00000001.json
    00000002.json
```

The original receipt remains local. Each later record includes the previous
record's hash, so deletion, replacement, reordering, a reused delivery ID, or a
changed subject makes verification fail. Files are owner-only and new history
entries cannot replace existing entries.

The local tip detects an uncoordinated deletion from the end of the history. An
attacker who can replace the entire directory can also replace an unsigned
history. Require trusted signatures and retain the accepted tip outside that
directory when this risk matters.

## Exit codes

| Result | Exit code |
|---|---:|
| valid history or `CURRENT` | `0` |
| invalid history or `REVOKED` | `1` |
| invalid command or input | `2` |
| `HOLD` | `3` |
| `EXPIRED` | `4` |

## Limits

The result covers only evidence that was recorded. It cannot prove that every
incident was observed, that a linked incident was caused by the change, that an
approved signer told the truth, or that a repository administrator cannot
bypass GitHub protections. The current importer handles one authenticated
webhook request at a time. There is no crawler, hosted collector, or GitHub App.
