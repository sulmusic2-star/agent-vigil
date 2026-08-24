# Team control-plane security fix report

## Provenance

- Scan ID: `d6a51474-3449-46ff-8200-de72118224ec`
- Reviewed range: `be3161fb7a85a4d69af6356e6c453ffd72ebac97..c7ac6e93bf1a73da28edb4cb0c0431209c2df903`
- Remediation base: `c7ac6e93bf1a73da28edb4cb0c0431209c2df903`
- Remediation implementation: `32744c40836f5067cad22620f9b890b36b482404`
- Scan manifest SHA-256: `aecb7f160dd4b8f086ef9a47e96fffcf82cf7a57d86f8035961d294db7d8377d`
- Report SHA-256: `bc8cafd72b0e7d7628479b7db90f9b2220a681629dc88a35f706450566ddf2d0`
- Findings SHA-256: `f786ff3b776da5e685ab3514bdf3a8eaba84f7a9c83999436dd356f783e72d7a`
- Coverage SHA-256: `17a06317bfa3d4b0abc5e8e47bb4d8b58ecc8d68fec91cbdf5d02e41c3fe5343`
- Disposition: fixed in the implementation commit and locally validated; not released, published, deployed, or exercised against live providers.

The authoritative scan bundle was read only. This report is an add-only successor artifact and does not replace or mutate the sealed report, findings, manifest, coverage, or SARIF export.

## Finding dispositions

### `csf_965d246bfb8c3c2be687582d` — Distinct checkout keys can create multiple subscriptions for one organization

- Status: fixed.
- Source and sink: concurrent authenticated checkout preparation with distinct idempotency keys could reach multiple hosted Checkout Sessions and subscriptions for one organization.
- Enforced invariant: an organization has at most one live checkout workflow across `prepared`, `executing`, `provider_created`, and `compensating` states. D1 conditionally creates the intent before dependent command/account/audit rows, and a partial unique index is the serialized database boundary.
- Verification: dynamic D1 concurrency proves one `202` and one conflict with one live intent/command; executor lease and affected-row tests prove only the exact winning command can cross the provider boundary.

### `csf_74d4645d674366193bab1755` — Chained individual merges strand data outside export and erasure

- Status: fixed.
- Source and sink: chained or racing merge requests could leave aliases outside the canonical identity used by export and deletion.
- Enforced invariant: every merged identity points directly to one active terminal canonical subject. Merge batches rewrite the complete cohort and its consent, installation, claim, and session state only when the primary canonical transition wins; pending deletion blocks merging. Cycles, stale chronology, nonterminal targets, and concurrent losers fail closed.
- Verification: dynamic A-to-B-to-C, alias export, alias deletion, cycle, chronology, merge concurrency, and merge-versus-deletion tests cover the complete cohort and all individual tables.

### `csf_8b77c413248b42b6bbb01ed7` — Checkout execution can survive organization deletion

- Status: fixed.
- Source and sink: an executor read before deletion could previously create a hosted Session and later expose its URL or permit a stale webhook to restore commercial state.
- Enforced invariant: checkout execution uses exact expiring leases and affected-row checks. Deletion atomically cancels local prepared work and leases provider-created work for compensation. A losing executor expires and verifies the exact hosted Session, records compensation, and never returns its URL. Confirmed deletion is refused while a live subscription or unresolved hosted-charge compensation exists, and D1 triggers reject post-deletion provider events, billing accounts, entitlements, and checkout completion.
- Verification: Worker/D1 race PoCs cover delete-before-create, create-before-delete, losing lease, failed compensation, exact Session expiry, concurrent deletion, and webhook/reconciliation refusal after confirmed deletion.

### `csf_4b95a05d8c83951fc7bb2276` — Refund reconciliation is not bound to the exact provider Refund

- Status: fixed.
- Source and sink: command or charge-wide state could be replayed as a different partial refund into the cash/revenue ledger.
- Enforced invariant: each ledger application has a unique exact Stripe Refund ID and source event, exact amount, Charge, PaymentIntent, source payment, and current provider cumulative amount. API-created Refunds additionally bind one exact accepted command. Provider-created Refunds without command metadata require one unambiguous previously confirmed source context. Local booked refund sums cannot exceed source cash, and replay is idempotent per Refund and event.
- Verification: dynamic tests cover two sequential partial Refunds, out-of-order application, replay, amount/identity mismatch, and one API Refund followed by an independently reconciled out-of-band Refund whose exact provider amount differs from the prior command.

### `csf_3772d66ade89bf559fb7024d` — Organization deletion retains undisclosed raw user identifiers

- Status: fixed.
- Source and sink: authenticated commercial actions persisted raw user IDs in checkout, billing-command, and deletion-request rows that survived or appeared in privacy exports.
- Enforced invariant: new commercial actor fields contain an organization-scoped HMAC pseudonym, legacy commercial actor fields are redacted by migration, exports label the value as a pseudonym, and confirmed deletion scrubs retained request secrets and commercial rows consistently with the documented retention contract.
- Verification: export and deletion tests scan every affected table and assert that raw user IDs are absent while pseudonymous auditability remains.

### `csf_e3915f6bdf0f9fefa9142804` — Unverified GitHub installation claims can squat another tenant's installation

- Status: fixed.
- Source and sink: an authenticated organization or individual could persist an exclusive installation claim before GitHub proved the installation/account tuple.
- Enforced invariant: only a verified signed GitHub `installation.created` delivery mints a short-lived, single-use provider proof for the exact installation ID, account node, and account type. Claim creation, proof consumption, installation binding, membership/session updates, and audit rows are conditionally chained in one D1 batch. Expired or losing claims release cleanly and cannot indefinitely block the legitimate owner.
- Verification: both organization and personal lanes cover preclaim refusal, exact proof binding, replay, mismatch, expiry, release, losing concurrent claims, and legitimate reclaim.

## Direct invariant sibling

Active commercial secret duties are pairwise separated at runtime. The main Worker compares its Team-session, commercial-actor, Stripe-webhook, Stripe-reconciliation, GitHub, and measurement HMAC roles; the executor and reconciler compare every active internal-HMAC/provider-key role in their compartments. Missing, short, or colliding values fail closed before command, webhook, or measurement processing.

## Local verification

- `npm run check`: generated Worker types current; all TypeScript targets passed; 4 test files and 39 tests passed.
- Focused Worker/D1 suites: 2 test files and 25 tests passed after the final refund hardening.
- D1 migrations: fresh local `0001` through `0007` succeeded; repeat application reported no migrations; `PRAGMA integrity_check` returned `ok`; `PRAGMA foreign_key_check` returned no rows.
- Worker builds: main, Stripe executor, and Stripe reconciler each passed `wrangler deploy --dry-run`; no deployment occurred.
- Schemas: all 17 repository `schemas/*.json` documents parsed.
- Dependency audits: service and repository root each reported zero vulnerabilities.
- Bounded review: `git diff --check` passed; changed paths were confined to `services/team-control-plane/**`; secret-like literal scan returned no matches.

## Residual external prerequisites

- Apply migration `0007` to the intended D1 environment before enabling any successor runtime.
- Configure unique production secret values for every documented role, exact Stripe test/live mode and Price IDs, least-privilege executor/read-only keys, the Dahlia-version webhook event set including `refund.created`, and the GitHub App webhook secret/permissions.
- Exercise provider compensation and webhook contracts in a non-production account before live commercial enablement.
- Perform an independent review of the committed exact successor SHA before release.

These are release prerequisites, not evidence of a live deployment, payment path, or commercial activation.
