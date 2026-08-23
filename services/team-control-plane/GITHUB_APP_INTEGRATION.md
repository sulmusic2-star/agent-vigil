# GitHub App installation identity boundary

The Team control plane does **not** currently accept GitHub installation identity. This contract is the precise integration seam for the separate GitHub Action/App release lane; it avoids pretending that an App exists or is deployed.

## Required inbound adapter

Create `src/github-app.ts` only after the App lane has an exact GitHub App ID, webhook secret, permission set, and installation data-retention policy. Its raw-body endpoint must:

1. Verify `X-Hub-Signature-256` HMAC SHA-256 using a required Worker secret before JSON parsing.
2. Require and deduplicate `X-GitHub-Delivery` globally. Reuse with a different payload hash is an incident, not a retry.
3. Accept only `installation.created`, `installation.deleted`, `installation.suspend`, `installation.unsuspend`, and `installation_repositories.added|removed`.
4. Bind the numeric GitHub installation ID and stable GitHub account node ID to one internal organization. Login/name is display metadata, never the tenancy key.
5. Treat suspend/delete as immediate authorization revocation. Unsuspend restores eligibility only after a fresh installation fetch/reconciliation.
6. Store selected repository node IDs as opaque identifiers. Repository-selection changes update eligibility but never ingest repository source, names, file contents, diffs, prompts, receipts, or canary output.
7. Reject installation/account rebinding, webhook order regressions, equal-time ambiguity, unrequested organization creation, and events from a different App ID.

## D1 additions

Add a separate migration with:

- `github_installations(installation_id PRIMARY KEY, github_account_node_id UNIQUE, org_id UNIQUE, state, repository_selection, last_event_created_at, last_delivery_id, installed_at, suspended_at, deleted_at)`
- `github_installation_repositories(installation_id, repository_node_id, selected, updated_at, PRIMARY KEY (...))`
- `github_deliveries(delivery_id PRIMARY KEY, event_name, payload_sha256, installation_id, received_at, result)`

Foreign keys use `ON DELETE RESTRICT` for commercial organizations. Installation deletion revokes and tombstones; it does not erase billing ledgers.

## Outbound identity contract

After verified installation reconciliation, the App lane may request a service-account membership for `github-installation:{installation_id}` with `identity_kind=service` and role `member`. It cannot grant owner/admin/billing, mint human sessions, change entitlement, create checkout, or make proof verdicts favorable. Required-check requests include only internal org ID, installation ID, opaque repository node ID, pair token, and receipt hash.

The JSON contract lives in `schemas/github-installation-event-v1.schema.json`. No route, table, installation, App registration, or deployment is claimed by this file.
