# Agent Vigil public App

This is the centrally operated installation path. A repository owner installs
one GitHub App and selects repositories. They do not deploy a Worker, create a
key, or copy Agent Vigil secrets into a repository.

The App receives signed `pull_request` and `merge_group` webhooks, creates the
`Agent Vigil` check on the exact head commit, and dispatches the trusted
`public-app-gate.yml` workflow in the Agent Vigil control repository. Customer
code runs only in the candidate Docker boundary. The App key and webhook
secrets remain in Agent Vigil-operated environments.

The customer App asks for checks write, contents read, pull requests read, and
merge queues read. GitHub requires merge queues read to deliver the
`merge_group` webhook. It does not ask for Actions or contents write.

## Customer path

1. Install the App and choose repositories.
2. Confirm the base-owned test setup in the generated setup pull request.
3. Open a normal code pull request.
4. Read `PASS`, `FAIL`, or `NOT CHECKED`.

Selecting repositories proves installation only. A real App-owned check on an
outside repository, a later repeat check, and a maintainer's decision must be
measured separately.

## Operator boundary

The control account must configure the `agent-vigil-public-app` GitHub
environment and the Worker once. Customers never receive these values:

- `AGENT_VIGIL_PUBLIC_APP_ID` (environment variable)
- `AGENT_VIGIL_PUBLIC_APP_ACTOR` (environment variable)
- `AGENT_VIGIL_PUBLIC_APP_PRIVATE_KEY` (environment secret)
- `AGENT_VIGIL_PUBLIC_APP_DISPATCH_SECRET` (environment secret)
- Worker secrets `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `WEBHOOK_SECRET`,
  `DISPATCH_SECRET`, `CONTROL_APP_ID`, `CONTROL_APP_PRIVATE_KEY`, and
  `CONTROL_INSTALLATION_ID`. The separate internal control App has Actions
  permission only on the Agent Vigil control repository; customer installations
  do not grant Agent Vigil Actions write access.

Do not activate the public manifest until hosted tests pass, the workflow is on
the default branch, and one disposable repository demonstrates a real PASS, a
real FAIL, and a stale-head `NOT CHECKED` result.
