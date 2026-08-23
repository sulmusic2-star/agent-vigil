# Team control-plane threat model

## Protected assets

Private organization policy, canary metadata, update history, exception and rollback records; organization membership and roles; provider customer/subscription bindings; entitlement state; cash and recognized-MRR ledgers; provider-event chronology; deletion confirmations; and audit history.

The service does not ingest source code, prompts, transcripts, credentials, environment variables, repository names, private component names, command arguments, full receipts, canary output, email addresses, or organization domains.

## Trust boundaries

1. A bearer session proves only a signed subject/organization/session tuple. D1 membership is authoritative for role and active status.
2. A Stripe webhook proves only that the configured endpoint secret signed the raw event. It cannot activate access by itself.
3. A reconciliation snapshot proves that a distinct read-only adapter observed current provider state. It must match a stored webhook event and the canonical product catalog before access or revenue changes.
4. Checkout/cancel/refund routes create commands. An external adapter performs provider mutations; provider-confirmed events plus reconciliation are the authority.
5. D1 is the tenant boundary and commercial ledger. Every private query binds `org_id`; provider customer/subscription identifiers are unique across organizations.

## Material abuse cases and controls

| Threat | Control | Residual prerequisite |
|---|---|---|
| Cross-tenant bearer use | Signed `org_id` must equal the route; active membership is read from D1 | Rotate the IdP/session key and add revocation telemetry |
| Role forgery or admin escalation | Token roles are ignored; only an owner manages privileged roles; privileged identities must be human; last owner cannot be removed | Production IdP onboarding and recovery policy |
| More than 15 Team humans | Atomic membership writes and active-human count reject the 16th | Later contributor-activity accounting must distinguish membership from trailing-30-day use |
| Checkout redirect or invoice activates access | Commands and webhooks cannot entitle; a matching second signed reconciliation is required | Read-only adapter must pin Stripe account and API version |
| Webhook tampering/replay | Raw HMAC SHA-256 verification, five-minute timestamp tolerance, event-id/payload-hash idempotency | Protect and rotate endpoint secret; HTTPS only |
| Out-of-order provider events regress state | Older event timestamps and equal-time/different-ID events are stored as stale and cannot apply | Operator reconciliation runbook for ambiguous provider histories |
| Price/product substitution | Immutable internal IDs, exact configured provider-price match, Team-only tier and 15-seat DB checks | Configure distinct staging/production price IDs |
| Provider ID assigned to two tenants | Unique D1 identifiers plus explicit collision query | Manual incident procedure; never auto-rebind |
| Billing bypass through policy endpoint | Paid-surface writes require active/grace Team entitlement; gate fails closed | Cache client policy read-only for at most 72 hours if later added |
| Refund/cancel command changes revenue | Commands do not mutate entitlement, cash, or MRR; refund preparation binds a same-tenant confirmed payment; only reconciled provider events mutate ledgers | Refund/legal policy approval before accepting payments |
| Billing key replay changes intent | Idempotency keys are tenant-scoped and reject a different operation or payload | The external adapter must preserve the command idempotency key |
| Annual cash mislabeled MRR | Cash ledger and MRR projection are separate; annual net recurring value divides by 12 | Accounting review of discounts, credits, taxes, FX, and recognition |
| Deletion token theft | Random one-time token, stored SHA-256 only, 15-minute expiration, owner role | Add notification and incident response before production |
| Deletion destroys mandated records | Private product data is deleted and access revoked; minimal billing/audit evidence remains isolated | Set jurisdiction-specific retention and purge schedules |
| Deletion leaves a future charge path | Locally prepared checkout commands are canceled; provider-created checkout or subscription state blocks local deletion | External adapter must cancel/expire the provider object before retry |
| Body memory exhaustion | Streaming bounded reads; 32 KiB normal JSON, 64 KiB reconciliation, 256 KiB provider webhook | Queue/bulk strategy if provider payloads outgrow bounds |
| Secret leakage | Secrets are declared as required bindings and absent from source/config; errors omit inputs | Secret scanner and exact-SHA review before deploy |

## Fail-closed invariants

- Missing, expired, cross-tenant, or inactive authentication denies access.
- Missing or untrusted entitlement/policy state cannot return required-gate `ALLOW`.
- Webhook, checkout, invoice, or command state never grants access or recognized MRR alone.
- A replay with the same identifier but different bytes is rejected.
- A stale/ambiguous provider event cannot regress entitlement or money projections.
- Provider, tenant, plan, price, currency, customer, subscription, and object mismatches stop reconciliation.
- Paid access never changes proof verdict semantics.
