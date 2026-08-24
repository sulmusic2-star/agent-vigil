# Team control-plane fix report

## Evidence boundary

- Sealed scan: `a205dca1-f1f7-4182-87aa-f40f571c9962`
- Findings: `csf_823b4474111629fa0c8f6487` (HIGH) and `csf_eaebd776f6ccf52f4339c24b` (MEDIUM)
- Exact clean base: `9d08e6fdc3832efa669003446f786966fa290af7`
- Exact implementation commit: `5b1f884f44a23a5491eb23b71bdaf00d524ef966`
- Scope: `services/team-control-plane/**` only

This is local remediation evidence. Nothing in this change was deployed or published, and no Stripe or GitHub API was called. The sealed scan bundle was not modified. An independent review must bind the final successor commit after this add-only report is committed; this file does not pre-claim that review result.

## HIGH: immutable billing generations and terminal re-checkout

Migration `0008_billing_generation_and_github_lifecycle.sql` introduces one immutable generation identity for every Team checkout, append-only generation events, one-live-generation enforcement, exact terminal-provider-proof guards, compensation records, and final workflow-integrity receipts. Checkout preparation reserves the next generation only after the preceding generation is both terminal-verified and retired. Checkout completion atomically binds the expected Session, customer, subscription, price, and generation before any billing projection changes.

Only a reconciled `customer.subscription.deleted` event for the exact generation/customer/subscription can terminalize and retire a generation. A refund, including a full refund, adjusts its own cash/MRR history but is not terminal subscription proof and cannot enable a successor checkout. Late invoice, refund, payment-failure, and subscription events remain bound to their historical generation and cannot alter a current successor. Provider customer and subscription collision checks scan immutable generation history, including retired rows.

An authenticated unexpected Checkout completion is identified before business-event chronology can classify it as stale. Every payload-bound Session/subscription pair receives its own immutable compensation row, including different Sessions that name the same provider subscription. The deterministic queue leases, cancels, and verifies each pair independently; non-colliding history and cancellation receipts append to the legitimate expected generation for audit but do not abandon, replace, or retire that generation. Every multi-table secondary effect uses exact generation/provider compare-and-set predicates, affected-row checks, and a terminal integrity receipt so a partially applied batch fails closed.

Migration from v7 is fail closed. Stored provider summaries and executable checkout/cancellation commands receive a legacy generation only when organization, customer, subscription, internal price, Checkout Session, and intent uniquely resolve to one migrated generation. Eligibility and application receipts preserve that derivation. A consistent live v7 subscription remains executable/reconcilable; a distinct terminal-old/live-successor workflow becomes retired S1 plus reserved S2 without mixing identities. Ambiguous or unbridgeable live state aborts migration instead of guessing. Runtime accepts provider metadata missing only `billing_generation` solely for this marked exact legacy binding; an explicit wrong generation is never bridged.

Regression coverage includes:

- expired S1 to S2 and fully refunded S1 to S2, with the latter blocked until exact S1 subscription deletion;
- same and changed provider customer IDs across generations;
- late S1 invoice, refund, payment-failure, and subscription deliveries after S2;
- a forced payment-failure interleaving that switches S1 to S2 between pre-read and batch execution;
- an unexpected extra Session delivered after a newer S2 provider event;
- missing/wrong-generation and same-subscription/different-Session completions drained as separate compensations;
- cross-organization reuse attempts for a customer retained only in retired history;
- cancellation after a full refund while the provider subscription remains bound;
- exact cancellation compensation without corrupting the expected reserved/bound generation;
- populated v7 live, successor, prepared-command, awaiting-event, refund, cancellation, and explicit ambiguous-HOLD upgrades.

## MEDIUM: latest GitHub lifecycle head before claim

The same migration introduces one installation lifecycle head shared by organization and personal lanes, invalidatable provider proofs, durable provider-not-found release rows, and D1 claim/chronology guards. Runtime and D1 use the same explicit action order: newer provider time advances; at the same provider second a terminal action dominates a nonterminal action; a lower-ranked nonterminal cannot clear a terminal head; delivery ID is used only for exact idempotency.

Claim now requires the exact, unexpired, unconsumed creation proof to remain the latest nonterminal lifecycle head. Head/proof mutation and organization service-membership or personal eligibility revocation are statements in the same D1 batch; forced later-statement failures roll the whole lifecycle transition back. Later suspend or delete deliveries invalidate the older creation proof and any unbound claim atomically. Provider `not_found` reconciliation binds the exact current pending head even when a later repository or unsuspend delivery followed creation, accepts an already-invalidated originating proof as historical evidence, rejects every pending delivery for the installation, releases the claim, and records an exact receipt. Only a later provider creation can increment the immutable incarnation and bind again.

Organization and individual export/deletion now inventory lifecycle heads, proofs, deliveries, active and release reconciliations, and integrity receipts. Every retained row is scoped by lane, owner, creation delivery, and immutable incarnation rather than reusable external installation ID alone. A prior owner's export/deletion therefore cannot read or erase a later owner's current incarnation. Released-install ownership remains durable long enough for authenticated export and is removed with the complete reachable inventory during confirmed deletion.

Regression coverage includes both organization and personal lanes for:

- creation followed by suspend/delete before claim and replay;
- creation and terminal delivery in the same provider second;
- forced terminal-batch rollback with no durable head/materialization split;
- suspend, unsuspend, then provider `not_found` with an already-invalidated creation proof;
- creation followed by a later pending repository delivery and provider `not_found`;
- released-install export and confirmed deletion with zero new-table residuals;
- organization A release, later organization B incarnation bind/activation, then A export/deletion isolation;
- later creation C2/C3 as the only proof able to bind after terminal invalidation/release;
- populated v7 organization and personal proof/claim/installation/reconciliation seeding.

## Local gates

All commands ran from `services/team-control-plane` with the checked-in provider flags disabled and a reused local dependency tree. No production or remote D1 target was used.

| Gate | Result |
|---|---|
| Focused GitHub/privacy regressions | 6 passed, 27 unrelated skipped |
| Independent billing-generation regression file | 5 passed |
| Stripe adapter regression file | 12 passed |
| `npm run check` | generated types current; TypeScript green; 5 files / 57 tests passed |
| Fresh local migration | 0001 through 0008 applied successfully |
| `npm run test:migration-0008` | populated v7 live/successor/GitHub fixture upgraded, second apply idempotent, ambiguous binding held with migration rollback |
| JSON schema parse | all 17 service schemas parsed |
| `npm run stripe:executor:dry-run` | green, 75.19 KiB; execution flag remained `false`; no upload |
| `npm run stripe:reconciler:dry-run` | green, 43.69 KiB; reconciliation flag remained `false`; no upload |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `git diff --check` | green |

## External prerequisites and residual risk

This remediation does not prove live provider behavior. Before enabling either adapter, operators still must configure and independently review exact Stripe API/version semantics, restricted-key permissions for exact Session expiration and Subscription cancellation, webhook/reconciler registration, retry/monitoring for unresolved compensation, GitHub App permissions and lifecycle delivery behavior, authoritative `not_found` handling, read-only reconciliation, production D1 migration/backup/rollback, secrets, observability, privacy retention, and the final deployed SHA. Payment, MRR, customer activation, and renewal remain unproven.
