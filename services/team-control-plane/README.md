# Agent Vigil Team control plane

This directory contains a local-only Cloudflare Worker/D1 implementation of the smallest Team control plane. It is not deployed, connected to Stripe, registered or connected as a GitHub App, or evidence of a customer, payment, MRR, or revenue.

## Implemented boundary

- HMAC-authenticated organization sessions whose URL tenant and active D1 membership must agree. Token role claims are ignored; roles are loaded from D1.
- Owner/admin/member/billing authorization, last-owner protection, and a hard 15-active-human Team limit.
- Versioned private policy and canary metadata, revision preconditions, required-gate fail-closed status, update history, exception records, rollback records, and audit export.
- Canonical immutable Team prices: `team_monthly_usd_v1` at $299/month and `team_annual_usd_v1` at $2,990/year, each for 15 contributors.
- Checkout, cancellation, and refund **commands** for an external Stripe adapter. Command preparation does not activate access or count as checkout, payment, MRR, or revenue.
- Raw-body Stripe webhook HMAC verification, five-minute replay window, event-id idempotency, payload-reuse detection, test/live-mode isolation, canonical price checks, tenant collision checks, and stale/equal-time ordering rejection.
- A second signed reconciliation boundary for a separate read-only provider adapter. Access activates only when a verified provider event and a fresh provider snapshot agree on tenant, customer, subscription, object, plan, and price.
- Separate cash and recognized-MRR ledgers. Annual value is normalized across 12 months; checkout, invoice face value, and cash are never reported as MRR.
- Provider-confirmed failure grace, refund adjustments, period-end cancellation, expiration, privacy export, and two-step private-data deletion.
- Claimed GitHub App installation tenancy with raw webhook HMAC verification, delivery/payload dedupe, opaque repository selection, immediate suspend/delete revocation, and signed reconciliation before creation/unsuspend becomes active.

Paid access never changes `SAFE`, `CHANGED`, `HOLD`, or fleet decision semantics. When trusted entitlement or policy state is unavailable, the required-gate endpoint returns `BLOCK`; the free local verifier remains separate.

## Local emulator

From this directory:

```bash
npm ci
npm run types
npm run db:migrate:local
npm run db:seed:local
```

Create `.dev.vars` locally (never commit it) with five unrelated, randomly generated values of at least 32 bytes:

```text
TEAM_SESSION_HMAC_SECRET=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_RECONCILIATION_HMAC_SECRET=...
GITHUB_WEBHOOK_SECRET=...
GITHUB_RECONCILIATION_HMAC_SECRET=...
```

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

Mutating billing routes require `Idempotency-Key`; reuse with another operation or payload is rejected. A refund command must name a provider-confirmed payment event for the same tenant and cannot exceed that payment; the unused-first-subscription reason is accepted only within 14 days of that payment and before material paid-feature use. Privacy deletion cancels locally prepared billing work but blocks when a provider-created checkout or active provider subscription still requires external cancellation. Policy writes require `If-Match: "{base_revision}"` and the same `base_revision` in the body.

## Production prerequisites deliberately not crossed

- Create separate Cloudflare D1 databases for staging and production; replace the zero UUID in `wrangler.jsonc`; configure required secrets with Wrangler; set a production price catalog; and complete a fresh security review.
- Build the narrow adapter that creates Stripe Checkout sessions and performs read-only Stripe API reconciliation. Keep its API key outside this Worker. Register only the six documented webhook event types and pin/test an explicit Stripe API version.
- Register and security-review the GitHub App, least-privilege permissions, private-key rotation, and read-only installation reconciliation adapter. The Worker has no GitHub private key and makes no GitHub API call.
- Add an asynchronous Queue if live webhook volume requires it. Current bounded synchronous D1 processing is intended for the local proof and low-volume pilot only.
- Publish terms, privacy/DPA, tax/VAT, refund, support, invoice/receipt, payment-method-update, chargeback, data-retention, and security-contact operations before accepting money.
- Implement IdP/OIDC session minting and rotation. The service validates sessions but exposes no public session-minting route.
- Exercise the local GitHub App adapter described in `GITHUB_APP_INTEGRATION.md` against a staging App and D1 database; local implementation is not registration, installation, or deployment evidence.

Current Cloudflare implementation choices follow the official [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [generated TypeScript bindings](https://developers.cloudflare.com/workers/languages/typescript/), [D1 transactional batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), and [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/). Stripe behavior follows its official [webhook documentation](https://docs.stripe.com/webhooks); GitHub verification and delivery handling follow its official [signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) and [webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
