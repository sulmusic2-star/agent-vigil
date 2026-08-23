# Team control-plane threat model

## Protected assets

Private organization policy, canary metadata, update history, exception and rollback records; organization membership and roles; provider customer/subscription bindings; GitHub installation/account/repository-node bindings; R0 consent, opaque subject, classification, activation, repeat/PQL/offer, and exact-boundary evidence; entitlement state; cash and recognized-MRR ledgers; provider-event chronology; deletion confirmations; and audit history.

The service does not ingest source code, prompts, transcripts, credentials, environment variables, repository names/full names, account logins, private component names, command arguments, full receipts, canary output, email addresses, or organization domains. GitHub webhook bodies are verified and parsed in bounded request memory but are never persisted.

## Trust boundaries

1. A bearer session proves only a signed subject/organization/session tuple. D1 membership is authoritative for role and active status.
2. A Stripe webhook proves only that the configured endpoint secret signed the raw event. It cannot activate access by itself.
3. A reconciliation snapshot proves that a distinct read-only adapter observed current provider state. It must match a stored webhook event and the canonical product catalog before access or revenue changes.
4. Checkout/cancel/refund routes create commands. A separately deployed executor with a mutation-scoped restricted key performs provider mutations. It cannot sign reconciliation snapshots.
5. A separately deployed reconciler has a read-only restricted key and the reconciliation signing secret. Its code issues only Stripe `GET` requests and cannot execute billing commands.
6. D1 is the tenant boundary and commercial ledger. Every private query binds `org_id`; provider customer/subscription identifiers are unique across organizations.
7. A GitHub webhook proves only that the configured webhook secret signed the raw body. Existing owner claims choose tenancy; a distinct read-only reconciliation snapshot is required before an installation service member becomes active.
8. The R0 control, identity-classification, and activity bridges use unrelated secrets. Control pins an immutable release/channel/start boundary; identity can classify only an active reconciled installation; activity can record use or a real-offer presentation only for a currently opted-in eligible subject. None can derive an individual identity from anonymous telemetry.

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
| GitHub installation/account rebound to another tenant | Owner preclaim plus one-to-one unique installation, account-node, and organization constraints | Define manual recovery for legitimate reinstallations |
| GitHub delivery forgery or byte-changing replay | Raw HMAC verification precedes JSON; delivery ID is bound to payload hash and event header | Protect/rotate webhook secret; HTTPS only |
| Stale GitHub lifecycle reactivates access | Older and equal-time ambiguous deliveries fail; suspend/delete immediately deactivate the service member | Read-only adapter must fetch current installation state |
| Unsuspend bypasses reconciliation | Creation, unsuspend, and selection-mode changes remain pending; only a matching separately signed fresh snapshot activates | Keep reconciliation secret separate from App webhook/private key |
| Repository or account names leak | Only stable account node ID and opaque repository node IDs persist; tests include sentinel names and assert absence | Review observability/export changes for accidental raw payload logging |
| Anonymous or synthetic interest satisfies a demand gate | R0 projection reads only Team tenants with active reconciled App identity, external bridge attestation, and human-owner opt-in; anonymous proof-network events are never joined | Coverage remains opt-in and does not represent total installations |
| Activity bridge creates its own external subjects | External/internal/demo/test classification requires a different identity-bridge secret; activity cannot initialize R0 or classify | Audit and secure the external-identity registry and its operator exclusions |
| Release or R0 boundary moves retroactively | One immutable D1 boundary must exactly equal production configuration on every ingest/report | Initialize only after exact reviewed public release and retain the release evidence |
| Reloads manufacture repeat/PQL | At most one activation per subject/UTC day; repeat and PQL require another day inside fixed 60/30-day windows | A compromised activity bridge can still emit false days; protect key and reconcile bridge operations |
| Prepared offer is called a received offer | Offer evidence is accepted only after server-derived PQL and is bound to the canonical $299/month or $2,990/year contract | Bridge must emit only after authenticated UI presentation or provider-confirmed delivery, not an attempt |
| Individual downloads are counted as people | Individual metrics are hard-coded `HOLD`/`UNMEASURABLE` with null denominators | Add reviewed GitHub/OIDC human binding, personal-install reconciliation, and individual opt-in |
| HMAC token split or reidentification | Stable subjects use a dedicated secret and only opaque tokens leave the projection | Key rotation requires an explicit migration; provider/org tables can still link tokens inside D1 |
| Multiple provider accounts impersonate unique companies | Report explicitly marks `sybil_resistant: false` and does not claim legal-company uniqueness | Add buyer/entity dedupe appropriate to the commercial gate |
| GitHub service identity escalates | Deterministic installation identity is constrained to service/member and activated conditionally | Production IdP must mint service sessions only for active D1 membership |
| Billing bypass through policy endpoint | Paid-surface writes require active/grace Team entitlement; gate fails closed | Cache client policy read-only for at most 72 hours if later added |
| Refund/cancel command changes revenue | Commands do not mutate entitlement, cash, or MRR; refund preparation binds a same-tenant confirmed payment; only reconciled provider events mutate ledgers | Refund/legal policy approval before accepting payments |
| Billing key replay changes intent | Idempotency keys are tenant-scoped and reject a different operation or payload | The external adapter must preserve the command idempotency key |
| Forged internal adapter invocation | Service Binding requests carry a five-minute HMAC over the exact body; executor loads the named command from D1 instead of trusting caller-supplied price, mode, provider IDs, or amount | Use unrelated invocation secrets per adapter and rotate them independently |
| Open redirect through Checkout | Caller supplies only the fixed `team_billing_v1` target; executor maps it to two configured HTTPS URLs whose origins must appear in an exact JSON allowlist | Review production return origins before enabling execution |
| Cross-tenant provider mutation | Executor binds command row, tenant, canonical price, checkout intent, billing account, subscription, confirmed cash event, InvoicePayment, PaymentIntent, and Charge before a call | Never add a generic Stripe proxy route |
| Executor forges payment or MRR | Executor lacks the reconciliation HMAC secret; provider acceptance changes only command/checkout-intent status | Deploy executor and reconciler as distinct Workers with distinct keys |
| Reconciler mutates Stripe | Reconciler requires an `rk_` key and its client path issues only `GET`; it has no command-executor signing secret | Configure the Stripe key itself with read-only Event, Subscription, and Refund access |
| Provider API shape drift | Every request pins `Stripe-Version: 2026-07-29.dahlia`; webhook events with another `api_version` are rejected | Upgrade only with fixtures and exact-SHA review |
| Duplicate mutation after timeout | All Stripe `POST`s use a stable tenant-and-command idempotency key; retry count and per-attempt timeout are bounded | Retain command records longer than Stripe's idempotency window |
| Refund event lacks tenant metadata | Accepted refund command stores PaymentIntent, Charge, Refund, amount, and source-payment bindings; `charge.refunded` is accepted only through that binding | Reconciliation still requires a read-only fetch of the exact Refund and Subscription |
| Annual cash mislabeled MRR | Cash ledger and MRR projection are separate; annual net recurring value divides by 12 | Accounting review of discounts, credits, taxes, FX, and recognition |
| Deletion token theft | Random one-time token, stored SHA-256 only, 15-minute expiration, owner role | Add notification and incident response before production |
| Deletion destroys mandated records | Private product data is deleted and access revoked; repository node IDs are removed; retained GitHub account/claimant fields are pseudonymized; minimal billing/audit evidence remains isolated | Set jurisdiction-specific retention and purge schedules |
| Deletion leaves a future charge path | Locally prepared checkout commands are canceled; provider-created checkout or subscription state blocks local deletion | External adapter must cancel/expire the provider object before retry |
| Body memory exhaustion | Streaming bounded reads; 32 KiB normal JSON, 64-256 KiB reconciliation, 256 KiB Stripe webhook, 1 MiB GitHub lifecycle | Queue/bulk strategy if provider payloads outgrow bounds |
| Secret leakage | Secret binding types are declared without values; HMAC use rejects missing/short secrets; errors omit inputs | Install values with Wrangler, then run a secret scanner and exact-SHA review before deploy |

## Fail-closed invariants

- Missing, expired, cross-tenant, or inactive authentication denies access.
- Missing or untrusted entitlement/policy state cannot return required-gate `ALLOW`.
- Webhook, checkout, invoice, or command state never grants access or recognized MRR alone.
- A replay with the same identifier but different bytes is rejected.
- A stale/ambiguous provider event cannot regress entitlement or money projections.
- Provider, tenant, plan, price, currency, customer, subscription, and object mismatches stop reconciliation.
- GitHub App, delivery bytes/header, installation, account node, tenant claim, lifecycle order, and repository-selection mismatches stop processing.
- GitHub installation creation or unsuspension cannot activate a service identity without independent reconciliation.
- R0 events cannot count without exact boundary/config agreement, external attestation, owner opt-in, an active reconciled post-R0 installation, and the correct role-specific bridge signature.
- Anonymous lifecycle evidence and unauthenticated individual identities cannot enter R0 denominators.
- Duplicate-day activation cannot create repeat or PQL; offer evidence cannot precede server-derived PQL.
- Missing adapter flags, secrets, restricted-key mode, price IDs, return origins, or Service Bindings stop before a Stripe call.
- Paid access never changes proof verdict semantics.
