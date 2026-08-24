# Agent Vigil Team control plane

This directory contains a local-only Cloudflare Worker/D1 implementation of the smallest Team control plane. It is not deployed, connected to Stripe, registered or connected as a GitHub App, or evidence of a customer, payment, MRR, or revenue.

## Implemented boundary

- HMAC-authenticated organization sessions whose URL tenant and active D1 membership must agree. Token role claims are ignored; roles are loaded from D1.
- Owner/admin/member/billing authorization, last-owner protection, and a hard 15-active-human Team limit.
- Versioned private policy and canary metadata, revision preconditions, required-gate fail-closed status, update history, exception records, rollback records, and audit export.
- Canonical immutable Team prices: `team_monthly_usd_v1` at $299/month and `team_annual_usd_v1` at $2,990/year, each for 15 contributors.
- Checkout, cancellation, and refund **commands**, plus separately deployed Stripe executor and read-only reconciler Workers. D1 permits at most one live checkout/subscription workflow per organization even when callers use different idempotency keys. Both adapter feature flags are checked in as `false`. Command preparation or provider acceptance does not activate access or count as payment, MRR, or revenue.
- Raw-body Stripe webhook HMAC verification, five-minute replay window, event-id idempotency, payload-reuse detection, test/live-mode isolation, canonical price checks, tenant collision checks, and stale/equal-time ordering rejection.
- A second signed reconciliation boundary for a separate read-only provider adapter. Access activates only when a verified provider event and a fresh provider snapshot agree on tenant, customer, subscription, object, plan, and price.
- Separate cash and recognized-MRR ledgers. Annual value is normalized across 12 months; checkout, invoice face value, and cash are never reported as MRR.
- Provider-confirmed failure grace, exact per-Refund and cumulative partial-refund adjustments, period-end cancellation, expiration, privacy export, and two-step private-data deletion. Checkout, billing-command, and deletion-request actors are retained only as organization-scoped HMAC pseudonyms.
- Provider-proof-backed GitHub App installation tenancy with raw webhook HMAC verification, 15-minute single-use creation proofs, expiry/release of abandoned claims, delivery/payload dedupe, opaque repository selection, immediate suspend/delete revocation, and signed reconciliation before creation/unsuspend becomes active.
- A disabled-by-default R0 organization projection plus a separately disabled individual receiver. The individual lane requires a short-lived GitHub/OIDC-bound human session, explicit opt-in, provider-attested `account.type=User`, independent personal-installation reconciliation, exact-release signed verifier activity, stable opaque identity, rotation/merge controls, and complete export/deletion. It reports `HOLD` until those external adapters and exact deployment settings are enabled; anonymous proof-network telemetry is never imported.

Paid access never changes `SAFE`, `CHANGED`, `HOLD`, or fleet decision semantics. When trusted entitlement or policy state is unavailable, the required-gate endpoint returns `BLOCK`; the free local verifier remains separate.

## Local emulator

From this directory:

```bash
npm ci
npm run types
npm run db:migrate:local
npm run db:seed:local
```

Create `.dev.vars` locally (never commit it) with twelve unrelated, randomly generated values of at least 32 bytes:

```text
TEAM_SESSION_HMAC_SECRET=...
COMMERCIAL_ACTOR_HMAC_SECRET=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_RECONCILIATION_HMAC_SECRET=...
GITHUB_WEBHOOK_SECRET=...
GITHUB_RECONCILIATION_HMAC_SECRET=...
R0_MEASUREMENT_CONTROL_HMAC_SECRET=...
R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET=...
R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET=...
R0_MEASUREMENT_IDENTITY_HMAC_SECRET=...
R0_INDIVIDUAL_IDENTITY_HMAC_SECRET=...
INDIVIDUAL_SESSION_HMAC_SECRET=...
```

When organization measurement is enabled, its four measurement secrets and the Team-session, commercial-actor, Stripe-webhook, Stripe-reconciliation, GitHub-webhook, and GitHub-reconciliation secrets form one ten-duty separation set. When the individual lane is enabled, its session and stable-identity secrets join the same set, making all twelve values pairwise distinct. Every value must contain at least 32 UTF-8 bytes. The shared guard runs before enabled bridge/report, consent/claim, commercial mutation, and provider-ingestion work; enabled routes fail closed with a generic configuration error before reading or mutating evidence otherwise.

Individual session authentication has its own deployment boundary: `INDIVIDUAL_SESSION_ENABLED`, the exact `avindividual_v1` schema/key ID, `INDIVIDUAL_SESSION_ISSUER`, `INDIVIDUAL_SESSION_AUDIENCE`, and `INDIVIDUAL_SESSION_HMAC_SECRET`. Privacy export and erasure validate only that boundary and an existing exact node/auth-subject binding, so an unrelated measurement-duty collision cannot strand a data subject. Consent, installation, activity, identity, and report routes still require the complete measurement-duty guard.

Secret names are declared only in `src/env.d.ts`; Wrangler has no supported `secrets.required` configuration field. The HMAC implementation rejects missing or shorter-than-32-byte secrets at runtime, and production values must be installed with Wrangler rather than committed as vars.

Set real Stripe price identifiers and the numeric GitHub App ID in a deployment-specific Wrangler environment before any deployment. The checked-in `CONFIGURE_BEFORE_DEPLOYMENT` values deliberately make provider processing fail closed.

Mint a one-hour local session after exporting the session secret:

```bash
node scripts/mint-local-session.mjs org_local user_owner
npm run dev
```

`npm run check` regenerates binding/runtime types, verifies the checked-in types, typechecks, and runs the Worker-runtime/D1 suite.

## API summary

Unauthenticated but cryptographically authenticated provider routes:

- `POST /v1/billing/stripe/webhook` — raw Stripe snapshot events with `Stripe-Signature`.
- `POST /v1/billing/stripe/reconciliation` — independently fetched provider snapshots with `Agent-Vigil-Reconciliation-Signature`.
- `POST /v1/github/app/webhook` — raw GitHub installation lifecycle with `X-Hub-Signature-256`.
- `POST /v1/github/app/reconciliation` — independently fetched installation snapshots with `Agent-Vigil-GitHub-Reconciliation-Signature`.
- `POST /v1/measurement/bridge` — signed, fresh, replay-resistant R0 boundary/identity/activation/offer evidence; disabled by default.
- `POST /v1/measurement/report` — signed aggregate bounded-demand projection.

The internal Service Binding request/response contract and adapter deployment split are specified in [`STRIPE_ADAPTERS.md`](./STRIPE_ADAPTERS.md). The executor and reconciler have different entrypoints, invocation secrets, Stripe restricted keys, and permissions.

Public metadata:

- `GET /healthz`
- `GET /v1/catalog`

Bearer-authenticated organization routes under `/v1/orgs/{org_id}`:

- `GET /`, `GET|PUT /policy`, `GET /gate`
- `GET /members`, `PUT /members/{user_id}`
- `GET|POST /history`, `/exceptions`, and `/rollbacks`
- `GET /audit`
- `POST /github/installation-claim`, `GET /github/installation`
- `POST /billing/checkout`, `/billing/cancel`, `/billing/refund`; `GET /billing/commands`, `/billing/ledger`
- `GET /privacy/export`, `POST /privacy/deletion-requests`, `DELETE /privacy/data`
- `PUT /measurement-consent`, `GET /measurement`

GitHub/OIDC-bound individual routes under `/v1/individual`:

- `PUT /measurement-consent`, `GET /measurement`
- `POST /github/installation-claim`, `GET /github/installation`
- `GET /privacy/export`, `POST /privacy/deletion-requests`, `DELETE /privacy/data`

Mutating billing routes require `Idempotency-Key`; reuse with another operation or payload is rejected, while distinct keys still cannot create two live workflows for one organization. A refund command must name a provider-confirmed payment event for the same tenant and cannot exceed that payment. Every reconciled partial refund is bound to its exact Stripe Refund, Charge, PaymentIntent, source payment, amount, and current cumulative Charge total; API-created refunds additionally bind the exact command, while provider-created refunds require one unambiguous previously confirmed source context. The unused-first-subscription reason is accepted only within 14 days of that payment and before material paid-feature use. Privacy deletion atomically closes prepared work and moves provider-created work into compensation. If checkout creation races deletion, the executor expires and verifies the exact hosted Session before recording compensation and never returns its URL; unresolved compensation or an active provider subscription blocks confirmed deletion, and provider events are refused after deletion. Policy writes require `If-Match: "{base_revision}"` and the same `base_revision` in the body.

## Production prerequisites deliberately not crossed

- Create separate Cloudflare D1 databases for staging and production; replace the zero UUID in `wrangler.jsonc`; configure required secrets with Wrangler; set a production price catalog; and complete a fresh security review.
- Create two separately permissioned Stripe restricted keys and two internal Service Bindings, replace all placeholder deployment values, pin the webhook endpoint to `2026-07-29.dahlia`, and enable each adapter only after a fresh exact-SHA review. The checked-in Workers make no provider call while disabled.
- Register and security-review the GitHub App, least-privilege permissions, private-key rotation, and read-only installation reconciliation adapter. The Worker has no GitHub private key and makes no GitHub API call.
- Add an asynchronous Queue if live webhook volume requires it. Current bounded synchronous D1 processing is intended for the local proof and low-volume pilot only.
- Publish terms, privacy/DPA, tax/VAT, refund, support, invoice/receipt, payment-method-update, chargeback, data-retention, and security-contact operations before accepting money.
- Implement IdP/OIDC session minting and rotation. The service validates sessions but exposes no public session-minting route.
- Exercise the local GitHub App adapter described in `GITHUB_APP_INTEGRATION.md` against a staging App and D1 database; local implementation is not registration, installation, or deployment evidence.
- Register and independently review separate GitHub/OIDC session issuer, read-only personal-installation reconciler, identity/activation bridge operations, exact R0 deployment values, stable-key rotation procedure, external/internal/demo/test registries, and offer-delivery evidence before enabling R0 measurement. See [`R0_MEASUREMENT.md`](./R0_MEASUREMENT.md). No checked-in value starts R0.

Current Cloudflare implementation choices follow the official [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [generated TypeScript bindings](https://developers.cloudflare.com/workers/languages/typescript/), [D1 transactional batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), and [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/). Stripe behavior follows its official [webhook documentation](https://docs.stripe.com/webhooks); GitHub verification and delivery handling follow its official [signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) and [webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
