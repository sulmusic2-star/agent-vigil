# Agent Vigil release-gate runbook

This runbook is for the Agent Vigil operator. Repository owners should only see:
install the App, select an environment, and read `APPROVE`, `HOLD`, or `NOT CHECKED`.

## Release boundary

A Worker deployment is not a production authorization. Production requires all
of these to identify the same reviewed source commit:

- the GitHub App manifest and permissions;
- the Worker bundle and Wrangler configuration;
- the control workflow and immutable Action pin;
- the npm/GitHub package and checksum;
- the admission and deployment public keys;
- the disposable-repository live proof.

Never describe App installation, webhook delivery, a unit test, or a registered
authorization as a protected deployment decision.

## Staging and production separation

Use `wrangler deploy --env staging` for staging and the top-level Worker only for
production. The environments must have different:

- GitHub App IDs, private keys, installation IDs, and webhook secrets;
- dispatch and registration secrets;
- admission and deployment signing keys;
- Durable Object namespaces;
- URLs and GitHub environments.

Do not place secrets in `wrangler.jsonc`, repository variables, logs, command
arguments, or candidate jobs. Provision Worker secrets with Wrangler or the
Cloudflare dashboard. Admission and deployment signing should use workload
identity and KMS in production.
Resolve and pin the absolute AWS CLI path in a trusted setup job before checking
out or running candidate code. Do not use a repository-provided executable or
credential profile.

Required Worker secrets and bindings:

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `WEBHOOK_SECRET`;
- `CONTROL_APP_ID`, `CONTROL_APP_PRIVATE_KEY`, `CONTROL_INSTALLATION_ID`;
- `DISPATCH_SECRET`, `REGISTRATION_SECRET`;
- `ADMISSION_PUBLIC_KEY_PEM`, `DEPLOYMENT_PUBLIC_KEY_PEM`;
- `DELIVERY_LEDGER`, `DEPLOYMENT_AUTHORIZATIONS`.

## Deployment order

1. Record the reviewed Git commit and clean working-tree status.
2. Run typecheck, build, full tests, hosted tests, coverage, benchmark gate,
   package smoke, npm audit, CodeQL, and the Wrangler staging dry run.
3. Deploy staging and record the returned deployment version and URL.
4. Check `/health` and inspect structured Worker logs.
5. Install the staging App on one disposable public repository only.
6. Run the live decision matrix below.
7. Exercise rollback to the previous Worker version and repeat `/health`.
8. Restore the reviewed candidate, repeat the matrix, then consider production.
9. Activate production permissions only after the production manifest has been
   compared byte-for-byte with the reviewed manifest.

## Required live matrix

The disposable repository must prove the valid case and every failure at the
layer that owns the relevant fact:

- matching authorization and admission;
- missing registration;
- invalid registration HMAC;
- forged authorization signature;
- forged admission signature;
- wrong repository, commit, or environment;
- wrong artifact or managed-environment digest (registration or byte gate);
- expired evidence;
- replayed webhook delivery (the ledger must return the retained decision and
  must not call GitHub twice);
- GitHub callback failure;
- unavailable Worker or Durable Object;
- protected job presenting different artifact bytes to
  `guard-deploy-bound-gate` (the byte gate must reject before deployment).

GitHub's custom protection callback owns repository, commit, environment,
freshness, and callback availability. Registration owns signature and evidence
linkage. `guard-deploy-bound-gate` owns the downloaded artifact bytes and
managed-environment digest. A release fails if any invalid row is accepted by
its responsible layer; it does not require GitHub's callback to inspect facts
that are available only inside the protected job.

Save the GitHub run URL, webhook delivery ID, Worker deployment version,
authorization hash, admission hash, source SHA, and result for every row. Never
save private keys or secrets.

## Monitoring and incident response

Searchable structured events must distinguish registration rejection, webhook
rejection, callback failure, approval, and rejection. Alert on callback errors,
repeated invalid signatures, sudden rejection-rate changes, and any approval
without a corresponding fresh registration record.

If identity, signing, storage, or callback behavior is uncertain:

1. disable the custom protection rule or roll back only if the replacement gate
   remains fail-closed;
2. revoke or rotate the affected key or secret;
3. reject pending deployments;
4. preserve delivery IDs, deployment versions, and non-secret hashes;
5. reproduce in staging;
6. restore service only from a reviewed immutable commit.

## Release record

For each production release retain:

- source commit, tag, package version, package SHA-256, Worker version;
- App permission diff and event subscriptions;
- public-key IDs and rotation dates;
- validation commands and exact totals;
- live-matrix evidence and rollback evidence;
- known limitations and unresolved findings.
