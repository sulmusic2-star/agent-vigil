# GitHub App installation identity adapter

This directory now implements the local GitHub App installation identity boundary. It is not deployed, registered with GitHub, or connected to an App account. No installation, repository access, or check-run capability is claimed.

## Inbound lifecycle

`POST /v1/github/app/webhook` reads a bounded raw body and verifies `X-Hub-Signature-256` with the required `GITHUB_WEBHOOK_SECRET` before JSON parsing. It then requires a UUID `X-GitHub-Delivery`, checks the configured numeric `GITHUB_APP_ID`, and accepts only:

- `installation`: `created`, `suspend`, `unsuspend`, `deleted`
- `installation_repositories`: `added`, `removed`

Delivery IDs are globally deduplicated against their raw payload hash. Reuse with different bytes or a different event header is rejected. Older events are rejected. At the same provider second, only an action that advances the shared total order is accepted; terminal actions dominate nonterminal actions, and equal-rank competitors are rejected.

Every lifecycle payload must include the provider-attested installation-account `type` and stable account node ID. Before either claim lane runs, each verified delivery advances one shared per-installation lifecycle head. A correctly signed `installation.created` delivery first creates a 15-minute, single-use proof for that exact delivery, installation, account node, and account type; an unclaimed creation returns `409` without activating anything. For an organization, a human owner then calls `POST /v1/orgs/{org_id}/github/installation-claim` with the numeric installation ID, stable GitHub account node ID, and that provider delivery ID. Replaying the exact signed creation delivery binds the claim only when it is still the latest nonterminal head. The installation ID, account node ID, and organization are one-to-one while that incarnation is current and bound. A provider-confirmed `not_found` release cannot revive the old incarnation; only a later `created` delivery can establish and bind a new one.

The separately gated personal lane accepts only `type=User`. An authenticated human calls `POST /v1/individual/github/installation-claim` with the numeric installation ID and provider delivery ID; the stable account node ID comes from the independently signed GitHub/OIDC session and must exactly match the proof, provider webhook, and reconciliation snapshots. An installation ID cannot exist in both the organization and personal lanes.

Proof consumption and claim insertion are one D1 batch. Expired unused proofs and expired unbound claims are released so an abandoned or hostile preclaim cannot indefinitely deny the legitimate provider-confirmed owner. A proof cannot be reused across lanes or identities, and a bound claim remains durable until the explicit deletion/recovery boundary.

Creation, unsuspension, and repository-selection-mode changes enter `pending_reconciliation`. `suspend` and `deleted` immediately deactivate `github-installation:{installation_id}` and invalidate every older creation proof or unbound claim. Lifecycle ordering uses provider event time plus an explicit action order shared by organization code, personal code, and D1: terminal actions dominate nonterminal actions at the same second, while a delivery ID is used only to recognize exact idempotency. An equal-time nonterminal delivery cannot clear a terminal head. The deterministic identity is always a non-privileged `service`/`member`; it cannot become owner, admin, or billing.

## Reconciliation

`POST /v1/github/app/reconciliation` accepts a separately timestamp-signed `github-installation-reconciliation-v1` snapshot from a narrow read-only GitHub adapter. An `active` snapshot must be fresh and agree with the latest pending delivery, App ID, installation ID, account type and node ID, provider state, repository-selection mode, and complete selected repository node-ID set. Organization snapshots must also agree with the tenant claim. Only then does the installation become active; organization reconciliation reactivates its service membership, while personal reconciliation establishes the independently checked active installation required for individual measurement eligibility. A `not_found` snapshot instead binds the exact current pending head, terminalizes the originating creation proof, rejects all pending deliveries, releases the claim, and records a durable ownership-scoped receipt. An older creation remains unclaimable; only a later provider-created lifecycle head can bind again.

Keep `GITHUB_RECONCILIATION_HMAC_SECRET` unrelated to the webhook and session secrets. The external adapter—not this Worker—will eventually hold the GitHub App private key, fetch the installation and accessible repositories, and emit the bounded snapshot. No private key or GitHub API call exists here.

## Data minimization

Only numeric App/installation IDs, stable account node ID, account type, opaque repository node IDs, timestamps, state, delivery/reconciliation IDs, and payload hashes persist. The parser deliberately ignores and never stores logins, organization names, repository names/full names, URLs, webhook bodies, source files, diffs, prompts, receipts, canary output, or tokens. The personal lane converts the node ID into a stable HMAC-opaque measurement subject and never accepts caller-supplied identity on activity messages.

Privacy export includes lifecycle heads, provider proofs, releases, deliveries, reconciliations, and integrity receipts reachable through the authenticated organization or individual lane, including after a `not_found` release. Confirmed deletion removes that complete inventory before deleting its ownership rows. Individual deletion resolves the complete canonical alias cohort before erasure. Only a non-identifying audit tombstone remains; it cannot be used to recover the installation ID or account node ID.

The normalized event and reconciliation contracts live in `schemas/github-installation-event-v1.schema.json` and `schemas/github-installation-reconciliation-v1.schema.json`; the authenticated personal claim is `schemas/github-personal-installation-claim-v1.schema.json`. Organization D1 state is introduced by `migrations/0003_github_app_installations.sql`; the default-disabled personal lane is introduced by `migrations/0006_individual_measurement_lane.sql`; `migrations/0007_team_integrity_guards.sql` adds proof-backed, expiring, single-use claim enforcement for both lanes; `migrations/0008_billing_generation_and_github_lifecycle.sql` adds the shared lifecycle head and release history.

## External prerequisites

Before deployment: create and security-review the GitHub App; set the exact App ID and high-entropy role-separated secrets; pin least-privilege App permissions; register only the two lifecycle events; implement private-key rotation and the read-only reconciliation adapter with provider-attested account type and stable node ID; define provider-confirmed claim recovery; configure and review the independent human GitHub/OIDC session issuer; and test first-delivery `409`, exact redelivery, proof expiry/release, concurrent claim attempts, suspension, deletion, and repository-selection changes against a staging D1 database. Until those provider-side adapters and exact production configuration exist, individual measurement enablement remains disabled and its report remains `HOLD`/null.
