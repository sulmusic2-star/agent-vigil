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

## Required secrets

Set these with `wrangler secret put`; never put their values in this directory:

- `WEBHOOK_SECRET` — the GitHub App webhook secret;
- `DISPATCH_SECRET` — a separate random secret shared with the
  `agent-vigil-gate` GitHub environment. Store the same value there under the
  workflow's exact secret name,
  `AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET`;
- `GITHUB_APP_ID` — the numeric GitHub App ID; and
- `GITHUB_APP_PRIVATE_KEY` — an unencrypted PKCS#8 GitHub App private key. If
  GitHub downloads a PKCS#1 key, convert a temporary local copy with
  `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`, upload it as
  a Worker secret, and remove the temporary copies.

Register the queue App from
[`github-app-manifest.example.json`](github-app-manifest.example.json), after
replacing the placeholder host. The manifest deliberately names the App
`Agent Vigil Gate`, which produces the `agent-vigil-gate[bot]` actor required
by the workflow before checkout. If GitHub assigns a different App slug, stop:
the reviewed workflow actor binding must be changed to that exact slug and
revalidated before deployment.

The App needs `Actions: write`, `Checks: write`, `Contents: read`,
`Merge queues: read`, and `Metadata: read`, and subscribes only to `merge_group`.
The installation must be limited to the intended repository.

## Verification and deployment

```bash
npx --yes wrangler@4.127.1 types
npx --yes wrangler@4.127.1 deploy --dry-run
npx --yes wrangler@4.127.1 deploy
```

After deployment, configure the App webhook URL as
`https://DEPLOYED_WORKER/github/merge-group`, put the same webhook secret in
the App and Worker, and add the Worker's `DISPATCH_SECRET` value to the
protected `agent-vigil-gate` GitHub environment as
`AGENT_VIGIL_MERGE_GROUP_DISPATCH_SECRET`. The protected environment also needs
the registered queue App's numeric ID as the variable
`AGENT_VIGIL_GATE_APP_ID` and the same private key as the secret
`AGENT_VIGIL_GATE_PRIVATE_KEY`. The Worker receives those credentials under
its own names, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; do not put either
private-key value in repository variables or files.

Do not make the queue check required until a real signed `checks_requested`
delivery produces `Agent Vigil governed evidence` on the exact queue head and
the [dispatcher regression tests at reviewed commit
`fb87b3bc5e3bddd4902b14d8fb36c5320cd9068a`](https://github.com/sulmusic2-star/agent-vigil/blob/fb87b3bc5e3bddd4902b14d8fb36c5320cd9068a/test-hosted/merge-queue-dispatcher.test.ts)
still pass. The test imports trusted-workflow source that is intentionally not
part of the npm runtime package, so run it from a clean checkout of that exact
commit:

```bash
git clone https://github.com/sulmusic2-star/agent-vigil.git
cd agent-vigil
git checkout --detach fb87b3bc5e3bddd4902b14d8fb36c5320cd9068a
npm ci --ignore-scripts
node --test --import tsx test-hosted/merge-queue-dispatcher.test.ts
```
