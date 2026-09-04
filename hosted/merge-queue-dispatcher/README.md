# Merge-queue dispatcher

This Worker is the external trust boundary for Agent Vigil's merge-queue check.
It accepts only signed GitHub `merge_group` webhooks for the configured
repository and branch, records each GitHub delivery in a Durable Object, mints
a short-lived installation token, and dispatches the workflow stored on
`main`.

It does not run repository code. The dispatched workflow verifies the signed
event identity before it checks out the composed queue commit. Candidate setup
and tests run in the candidate-only Docker boundary without the webhook secret,
dispatch secret, or GitHub App private key.

## Protect the GitHub environment first

Create the `agent-vigil-gate` environment before adding any variable or secret.
Under **Deployment branches and tags**, choose **Selected branches and tags**
and allow only `main`. A same-repository candidate branch must not be able to
request this environment. Required reviewers may add an operator checkpoint,
but they are not a substitute for the `main`-only branch restriction and can
prevent unattended queue checks.

Before storing credentials, run a disposable negative test from a non-`main`
branch whose only job requests `environment: agent-vigil-gate`. Confirm that
GitHub refuses the deployment before any step can read an environment variable
or secret. Remove that test workflow afterward. Do not deploy the Worker or
make its check required if this negative test has not been observed.

## Register the queue App

Register the queue App from
[`github-app-manifest.example.json`](github-app-manifest.example.json), after
replacing the placeholder host with the planned Worker origin. Record the App
ID, generate its private key, and generate a separate random webhook secret of
at least 32 characters. `openssl rand -hex 32` produces a 64-character value;
run it again for each independent secret rather than reusing one value.
The manifest requests the App name `Agent Vigil Gate`, whose expected actor is
`agent-vigil-gate[bot]`. GitHub App names are globally unique, so GitHub may
require another name and slug. If it does, store the exact bot login formed as
`APP-SLUG[bot]` in the protected environment variable
`AGENT_VIGIL_GATE_ACTOR`. The workflow defaults to `agent-vigil-gate[bot]` only
when that variable is absent; it still compares the dispatch actor before any
checkout.

The App needs `Actions: write`, `Checks: write`, `Contents: read`,
`Merge queues: read`, and `Metadata: read`, and subscribes only to `merge_group`.
Limit its installation to the intended repository. Do not enable the webhook
or make its check required yet.

Copy the packaged `.github/workflows/agent-vigil-merge-group.yml` into that
same path on the target repository's `main` branch. In `wrangler.jsonc`, replace
`REPLACE_WITH_OWNER/REPLACE_WITH_REPOSITORY` with that repository's exact
`owner/name`. Keep `WORKFLOW_FILE` equal to the installed workflow filename.
The workflow scopes its short-lived App token to
`${{ github.event.repository.name }}`; do not replace that expression with a
fixed repository name.

## Required secrets

Run every Wrangler command in this guide from the directory that contains the
checked-in `wrangler.jsonc`:

```bash
cd hosted/merge-queue-dispatcher
```

Then set these with `npx --yes wrangler@4.127.1 secret put SECRET_NAME`;
never put their values in this directory:

- `WEBHOOK_SECRET` — the GitHub App webhook secret, at least 32 characters;
- `DISPATCH_SECRET` — a separate random secret of at least 32 characters,
  shared with the
  `agent-vigil-gate` GitHub environment. Store the same value there under the
  workflow's exact secret name,
  `AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET`;
- `GITHUB_APP_ID` — the numeric GitHub App ID; and
- `GITHUB_APP_PRIVATE_KEY` — the unencrypted PKCS#1 key downloaded by GitHub,
  or an unencrypted PKCS#8 private key. The Worker normalizes either format in
  memory; do not convert or retain an extra local copy.

## Verification and deployment

From the package root, run the regression test against the exact Worker and
workflow assets that will be deployed:

```bash
npx --yes tsx@4.23.12 --test test-hosted/merge-queue-dispatcher.test.ts
```

Then deploy from the Worker directory:

```bash
cd hosted/merge-queue-dispatcher
npx --yes wrangler@4.127.1 types
npx --yes wrangler@4.127.1 deploy --dry-run
npx --yes wrangler@4.127.1 deploy
```

Keep the App webhook inactive after deployment. Configure its URL as
`https://DEPLOYED_WORKER/github/merge-group` and put the same webhook secret in
the App and Worker. Before enabling delivery, add the Worker's
`DISPATCH_SECRET` value to the protected `agent-vigil-gate` environment as
`AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET`. The protected environment also needs
the registered queue App's client ID as the variable
`AGENT_VIGIL_GATE_CLIENT_ID`, the exact bot login as the variable
`AGENT_VIGIL_GATE_ACTOR`, and the same private key as the secret
`AGENT_VIGIL_GATE_PRIVATE_KEY`. The Worker receives those credentials under
its own names, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; the Worker still
uses the numeric App ID to request installation tokens. Do not put either
private-key value in repository variables or files. If this environment was
configured before the client-ID migration, replace `AGENT_VIGIL_GATE_APP_ID`
with `AGENT_VIGIL_GATE_CLIENT_ID` before running the workflow.

Only after all three environment credentials are present and the earlier
non-`main` negative test has passed should you enable the App webhook.

Do not make the queue check required until a real signed `checks_requested`
delivery produces `Agent Vigil governed evidence` on the exact queue head and
the packaged regression test still passes without modifying any packaged
Worker or workflow asset.
