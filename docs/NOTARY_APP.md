# Agent Vigil Notary App

**State:** runnable verification core and GitHub App contract. No hosted Agent
Vigil Notary service is deployed as part of version 0.21.2.

The Notary App is deliberately narrow. Customer code and test execution stay in
the customer's credential-free runner. A future App must verify an independently
signed receipt and its expected workflow source, then post one check for the
exact commit. Candidate receipt signing is not performed by the generated
v0.21.2 evidence job.

## Decision rule

The check is named `Agent Vigil verified`.

- PASS becomes `success`.
- FAIL becomes `failure`.
- INCONCLUSIVE becomes `action_required`.

INCONCLUSIVE is blocking. It is never converted to GitHub's `neutral`
conclusion, because GitHub may treat a neutral required check as satisfied.

The notary refuses a receipt when:

- the GitHub attestation is invalid;
- the receipt file digest is different;
- the receipt content hash is different;
- the receipt head differs from the webhook head;
- the policy digest differs from the policy loaded from the trusted base;
- the predicate contains a different decision or evidence count.

It also pins the expected signer workflow and rejects self-hosted runners by
default. A customer may allow a self-hosted runner only through an explicit
policy exception.

Pinning a workflow path does not prove that the workflow file itself was
unchanged. Repositories that let a pull request edit the signing workflow need a
separately controlled signing workflow before treating the notary check as a
high-assurance approval.

The App-owned check is also the enforcement boundary GitHub's plain job-name
requirement lacks. A ruleset must restrict the accepted status source to this
installed App, and the App must reject a head, event, or evidence-source
mismatch. No deployed service currently provides that check.

## Minimum GitHub App permissions

- Actions: read
- Checks: read and write
- Contents: read
- Pull requests: read
- Metadata: read

The App does not need repository-content write access, administration access,
deployment access, or secrets access.

An example manifest is in
[`notary-app-manifest.example.json`](notary-app-manifest.example.json). Replace
its placeholder URLs before registering an App.

## Webhook handling

Subscribe to `workflow_run` and `pull_request` events. A production service must:

1. preserve the raw request bytes;
2. verify `X-Hub-Signature-256` before parsing JSON;
3. reject missing or repeated delivery IDs;
4. exchange the App key for a short-lived installation token;
5. retrieve the named receipt artifact from the `workflow_run` event's run ID;
6. load the policy from the pull request base commit;
7. run the notary decision against the exact event head;
8. post the resulting Checks API payload;
9. retain the delivery ID, receipt hash, policy hash, check ID, and timestamps;
10. discard downloaded receipt files after the configured retention step.

The command below exercises the same decision core and emits the Checks API
payload without posting it:

```bash
vigil notary agent-vigil-report.json \
  --repository OWNER/REPOSITORY \
  --head FULL_HEAD_SHA \
  --policy-sha256 sha256:POLICY_DIGEST \
  --signer-workflow OWNER/REPOSITORY/.github/workflows/agent-vigil.yml \
  --output check-run.json
```

Posting the check, operating tenant storage, and registering the public GitHub
App require a deployed HTTPS service, installation credentials, a privacy
policy, and incident-response procedures. Those are deployment gates, not
features hidden inside this release.
