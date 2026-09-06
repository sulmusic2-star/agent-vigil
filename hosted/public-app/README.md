# Agent Vigil public App

This is the implementation for a centrally operated App, not a claim that the
managed service is ready to buy. The intended customer installs one GitHub App
and selects repositories. They do not deploy a Worker, create a key, or copy
Agent Vigil secrets into a repository.

The App receives signed `pull_request`, `merge_group`, and
`deployment_protection_rule` webhooks, creates the
`Agent Vigil` check on the exact head commit, and dispatches the trusted
`public-app-gate.yml` workflow in the Agent Vigil control repository. Customer
code runs only in the candidate Docker boundary. The App key and webhook
secrets remain in Agent Vigil-operated environments.

The customer App asks for checks write, contents read, pull requests read, and
merge queues read. For deployment protection it also asks for Actions read and
Deployments write, as GitHub requires. It never asks for Actions write or
Contents write.

`GET /health` returns HTTP 200 with `status: ready` only when every check,
deployment, registration, and Durable Object binding is present. An incomplete
deployment returns HTTP 503 and must not receive a GitHub webhook.

## Customer path

1. Install the App and choose repositories.
2. Prepare and review the repository's test configuration. The App has read-only
   access to repository contents: it does **not** create a setup pull request.
   This step still requires the repository owner or an authorized operator.
3. Open a normal code pull request.
4. Read `PASS`, `FAIL`, or `NOT CHECKED`.
5. For deployment control, enable Agent Vigil as a protection rule on the
   selected GitHub environment.

Installation alone does not make this a required check. The repository owner
must configure the ruleset and expected App identity, then prove that a missing
or failed check actually prevents merging. Until that path is tested without
operator assistance, do not describe setup as a complete one-click service.

## Interrupted check deliveries

For PR and merge-queue webhooks, the App saves the job and an alarm in one
Durable Object transaction before returning HTTP 202. The webhook response does
not wait for GitHub API calls. Each API call has a 15-second timeout, including its
response body. This follows [GitHub's webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

- Temporary failures before a remote write can be retried without another commit.
- A lost check-creation response is looked up by commit, delivery and owning App.
  Recovery examines at most 50 matching-name checks. Missing or ambiguous results
  need operator help; the App does not blindly create a replacement.
- A lost workflow-dispatch response is not retried: the workflow may already be
  running. Its existing check remains pending until a result arrives or the
  one-hour deadline is reached.
- A check still unfinished at that deadline is marked `NOT CHECKED` / failure.
  A result observed completed is left alone. This is not an atomic lock against
  a concurrent GitHub update; the late-completion race still needs hosted testing.
- Three consecutive failed operations in a stage stop automatic retries and
  record an operator-help event. A known check that could not be dispatched is
  still watched until its deadline. Records remain for three days.

These recovery paths are not a pager or an operator console. Alerts, authorized
manual recovery, and the response commitment still need to be connected and
tested before anyone buys a managed service. Old `pending` or `failed` deliveries
without a target need a signed GitHub redelivery to supply it; they are reconciled
without redispatching possibly executed work. No new pass result is issued by
the recovery code. Deployment-protection callbacks use their separate existing
flow and are not covered by this queue change.

## Two deployment gates

The operator registers a short-lived, Ed25519-signed authorization produced by
`vigil guard-deploy-authorize`. Registration sends both that authorization and
the separately signed control admission. The Worker verifies both pinned keys,
their linkage, their validity windows, and a transport HMAC before it stores
anything. The authorization names one repository, commit, environment, artifact
digest, and managed-environment digest.

The App approves GitHub's environment gate only when that signed authorization
matches the webhook exactly. Missing, forged, stale, or mismatched authorization
is rejected. The deployment job must then run `vigil guard-deploy-bound-gate`
against the actual downloaded package or installer. The App cannot see those
later bytes, so App approval by itself is not package-byte proof.

Expired authorizations are removed after a 24-hour audit margin. A recorded
deployment decision is retained separately through GitHub.com's three-day
manual webhook-redelivery window, so a replay returns the original result
without calling GitHub a second time. Rejections made without any matching
authorization use the same bounded retention and cleanup schedule.

GitHub custom deployment protection rules are currently in public preview.
Public repositories can use them on all plans. Private and internal repositories
require GitHub Enterprise. This implementation is locally tested but has not
yet approved or rejected a real GitHub-hosted deployment.

Selecting repositories proves installation only. A real App-owned check on an
outside repository, a later repeat check, and a maintainer's decision must be
measured separately.

## Operator boundary

The control account must configure the `agent-vigil-public-app` GitHub
environment and the Worker once. Customers never receive these values:

- `AGENT_VIGIL_PUBLIC_APP_CLIENT_ID` (environment variable)
- `AGENT_VIGIL_CONTROL_APP_ACTOR` (environment variable; the login of the
  separate App that dispatches the central workflow)
- `AGENT_VIGIL_PUBLIC_APP_PRIVATE_KEY` (environment secret)
- `AGENT_VIGIL_PUBLIC_APP_DISPATCH_SECRET` (environment secret)
- Worker secrets `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `WEBHOOK_SECRET`,
  `DISPATCH_SECRET`, `CONTROL_APP_ID`, `CONTROL_APP_PRIVATE_KEY`, and
  `CONTROL_INSTALLATION_ID`, the pinned `DEPLOYMENT_PUBLIC_KEY_PEM` and
  `ADMISSION_PUBLIC_KEY_PEM`, plus `REGISTRATION_SECRET`. The deployment and
  admission signers remain outside the Worker. The separate internal control App has Actions
  permission only on the Agent Vigil control repository; customer installations
  do not grant Agent Vigil Actions write access.

Do not activate the expanded public manifest until hosted tests pass, the workflow is on
the default branch, and one disposable repository demonstrates a real PASS, a
real FAIL, a stale-head `NOT CHECKED`, an authorized deployment, and a rejected
deployment. Activation changes the App's requested permissions and is a separate
operator action.

Staging and production must use separate Worker environments, Durable Object
namespaces, GitHub App credentials, webhook secrets, registration secrets, and
signing keys. Follow [the release-gate runbook](../../docs/AGENT_CONTROL_RELEASE_GATE_RUNBOOK.md).
