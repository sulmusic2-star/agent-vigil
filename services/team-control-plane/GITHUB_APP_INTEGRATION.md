# GitHub App installation identity adapter

This directory now implements the local GitHub App installation identity boundary. It is not deployed, registered with GitHub, or connected to an App account. No installation, repository access, or check-run capability is claimed.

## Inbound lifecycle

`POST /v1/github/app/webhook` reads a bounded raw body and verifies `X-Hub-Signature-256` with the required `GITHUB_WEBHOOK_SECRET` before JSON parsing. It then requires a UUID `X-GitHub-Delivery`, checks the configured numeric `GITHUB_APP_ID`, and accepts only:

- `installation`: `created`, `suspend`, `unsuspend`, `deleted`
- `installation_repositories`: `added`, `removed`

Delivery IDs are globally deduplicated against their raw payload hash. Reuse with different bytes or a different event header is rejected. Older events and different deliveries with the same installation timestamp are rejected as ambiguous.

The webhook cannot create an organization or choose a tenant. A human owner first calls `POST /v1/orgs/{org_id}/github/installation-claim` with the numeric installation ID and stable GitHub account node ID. Installation ID, account node ID, and organization are each one-to-one and cannot be rebound.

Creation, unsuspension, and repository-selection-mode changes enter `pending_reconciliation`. `suspend` and `deleted` immediately deactivate `github-installation:{installation_id}`. The deterministic identity is always a non-privileged `service`/`member`; it cannot become owner, admin, or billing.

## Reconciliation

`POST /v1/github/app/reconciliation` accepts a separately timestamp-signed `github-installation-reconciliation-v1` snapshot from a narrow read-only GitHub adapter. The snapshot must be fresh and agree with the latest pending delivery, App ID, installation ID, account node ID, tenant claim, provider state, repository-selection mode, and complete selected repository node-ID set. Only then does the installation become active and its service membership reactivate.

Keep `GITHUB_RECONCILIATION_HMAC_SECRET` unrelated to the webhook and session secrets. The external adapter—not this Worker—will eventually hold the GitHub App private key, fetch the installation and accessible repositories, and emit the bounded snapshot. No private key or GitHub API call exists here.

## Data minimization

Only numeric App/installation IDs, stable account node ID, opaque repository node IDs, timestamps, state, delivery/reconciliation IDs, and payload hashes persist. The parser deliberately ignores and never stores logins, organization names, repository names/full names, URLs, webhook bodies, source files, diffs, prompts, receipts, canary output, or tokens.

The normalized event and reconciliation contracts live in `schemas/github-installation-event-v1.schema.json` and `schemas/github-installation-reconciliation-v1.schema.json`. D1 state is introduced by `migrations/0003_github_app_installations.sql`.

## External prerequisites

Before deployment: create and security-review the GitHub App; set the exact App ID and high-entropy secrets; pin least-privilege App permissions; register only the two lifecycle events; implement private-key rotation and the read-only reconciliation adapter; define installation recovery/rebinding operations; and test GitHub redelivery, suspension, deletion, and repository-selection changes against a staging D1 database.
