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
  `agent-vigil-gate` GitHub environment;
- `GITHUB_APP_ID` — the numeric GitHub App ID; and
- `GITHUB_APP_PRIVATE_KEY` — an unencrypted PKCS#8 GitHub App private key. If
  GitHub downloads a PKCS#1 key, convert a temporary local copy with
  `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`, upload it as
  a Worker secret, and remove the temporary copies.

The GitHub App needs `Actions: write`, `Checks: write`, `Contents: read`,
`Merge queues: read`, and `Metadata: read`, and must subscribe to `merge_group`
events. The installation must be limited to the intended repository.

## Verification and deployment

```bash
npx --yes wrangler@4.127.1 types
npx --yes wrangler@4.127.1 deploy --dry-run
npx --yes wrangler@4.127.1 deploy
```

After deployment, configure the App webhook URL as
`https://DEPLOYED_WORKER/github/merge-group`, put the same webhook secret in
the App and Worker, and add `DISPATCH_SECRET` to the protected
`agent-vigil-gate` GitHub environment.

Do not make the queue check required until a real signed `checks_requested`
delivery produces `Agent Vigil governed evidence` on the exact queue head and
the negative tests in `test-hosted/merge-queue-dispatcher.test.ts` still pass.
