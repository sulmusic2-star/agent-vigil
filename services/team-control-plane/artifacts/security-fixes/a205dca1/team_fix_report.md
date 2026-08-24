# Team control-plane fix report

## Evidence boundary

- Sealed scan: `a205dca1-f1f7-4182-87aa-f40f571c9962`
- Findings: `csf_823b4474111629fa0c8f6487` (HIGH) and `csf_eaebd776f6ccf52f4339c24b` (MEDIUM)
- Exact clean base: `9d08e6fdc3832efa669003446f786966fa290af7`
- Exact implementation commit: `2736ca3414a4df23ad858919a6977d77928a7c26`
- Scope: `services/team-control-plane/**` only

This is local remediation evidence. Nothing in this change was deployed or published, and no Stripe or GitHub API was called. The sealed scan bundle was not modified. An independent review must bind the final successor commit after this add-only report is committed; this file does not pre-claim that review result.

## HIGH: immutable billing generations and terminal re-checkout

Migration `0008_billing_generation_and_github_lifecycle.sql` introduces one immutable generation identity for every Team checkout, append-only generation events, one-live-generation enforcement, exact terminal-provider-proof guards, compensation records, and final workflow-integrity receipts. Checkout preparation reserves the next generation only after the preceding generation is both terminal-verified and retired. Checkout completion atomically binds the expected Session, customer, subscription, price, and generation before any billing projection changes.

Only a reconciled `customer.subscription.deleted` event for the exact generation/customer/subscription can terminalize and retire a generation. A refund, including a full refund, adjusts its own cash/MRR history but is not terminal subscription proof and cannot enable a successor checkout. Late invoice, payment-failure, and subscription events remain isolated historical markers. A refund delivered after its generation retires is still an exact financial fact: it appends one provider-refund application, negative cash entry, historical revenue adjustment, generation event, audit, and receipt without changing the current successor account, entitlement, MRR, or provider cursor. Provider customer and subscription collision checks scan immutable generation history, including retired rows.

An authenticated unexpected Checkout completion is identified before business-event chronology can classify it as stale. Every payload-bound Session/subscription pair receives its own immutable compensation row, including different Sessions that name the same provider subscription. The deterministic queue leases, cancels, and verifies each pair independently; non-colliding history and cancellation receipts append to the legitimate expected generation for audit but do not abandon, replace, or retire that generation. Every multi-table secondary effect uses exact generation/provider compare-and-set predicates, affected-row checks, and a terminal integrity receipt so a partially applied batch fails closed.

Migration from v7 is fail closed. Stored provider summaries and executable checkout/cancellation commands receive a legacy generation only when a pre-upgrade provider object plus organization, customer, subscription, internal price, Checkout Session, and intent uniquely resolve to one migrated generation. Provider-less prepared successors receive no marker; a later missing-generation completion is compensated. Eligibility and application receipts preserve exact bridge derivation. A consistent live v7 subscription remains executable/reconcilable; a distinct terminal-old/live-successor workflow becomes retired S1 plus reserved S2 without mixing identities. Ambiguous or unbridgeable live state aborts migration instead of guessing. Runtime accepts provider metadata missing only `billing_generation` solely for this marked exact legacy binding; an explicit wrong generation is never bridged.

Regression coverage includes:

- expired S1 to S2 and fully refunded S1 to S2, with the latter blocked until exact S1 subscription deletion;
- same and changed provider customer IDs across generations;
- late S1 invoice, refund, payment-failure, and subscription deliveries after S2;
- out-of-order and replayed cumulative S1 refunds booked against retired history without changing S2;
- a forced payment-failure interleaving that switches S1 to S2 between pre-read and batch execution;
- forced same-generation newer-payment and newer-subscription cursor wins that roll back the older claimed batch;
- an unexpected extra Session delivered after a newer S2 provider event;
- missing/wrong-generation and same-subscription/different-Session completions drained as separate compensations;
- cross-organization reuse attempts for a customer retained only in retired history;
- cancellation after a full refund while the provider subscription remains bound;
- exact cancellation compensation without corrupting the expected reserved/bound generation;
- populated v7 live, successor, prepared-command, awaiting-event, refund, cancellation, provider-less-successor exclusion, and explicit ambiguous-HOLD upgrades.

## MEDIUM: latest GitHub lifecycle head before claim

The same migration introduces one installation lifecycle head shared by organization and personal lanes, invalidatable provider proofs, durable provider-not-found release rows, and D1 claim/chronology guards. Runtime and D1 use the same explicit action order: newer provider time advances; at the same provider second a terminal action dominates a nonterminal action; a lower-ranked nonterminal cannot clear a terminal head; delivery ID is used only for exact idempotency.

Claim now requires the exact, unexpired, unconsumed creation proof to remain the latest nonterminal lifecycle head. Head/proof mutation and organization service-membership or personal eligibility revocation are statements in the same D1 batch; forced later-statement failures roll the whole lifecycle transition back. Later suspend or delete deliveries invalidate the older creation proof and any unbound claim atomically. Provider `not_found` reconciliation binds the exact current pending head even when a later repository or unsuspend delivery followed creation, accepts an already-invalidated originating proof as historical evidence, rejects every pending delivery for the installation, releases the claim, and records an exact receipt. Only a later provider creation can increment the immutable incarnation and bind again.

Organization and individual export/deletion now inventory lifecycle heads, proofs, deliveries, active and release reconciliations, and integrity receipts. Every retained row is scoped by lane, owner, creation delivery, and immutable incarnation rather than reusable external installation ID alone. A prior owner's export/deletion therefore cannot read or erase a later owner's current incarnation. Released-install ownership remains durable long enough for authenticated export and is removed with the complete reachable inventory during confirmed deletion.

Personal reconciliation, consent, and signed classification attestation now derive eligibility inside whichever exact D1 batch supplies the final prerequisite. The final receipt proves the path-specific source row, deterministic audit ID, current canonical identity, and the absence of any fully qualifying identity left without eligibility. A forced ignored eligibility update therefore fails the receipt CHECK and rolls back the entire source batch; exact retry succeeds and exact replay remains idempotent. Migration repairs v7 eligibility only from an exact consent mutation, applied attestation bridge, applied reconciliation and source delivery, matching incarnation, and R0 boundary. Unsupported pre-existing eligibility is a migration HOLD, and exact repairs receive a privacy-inventoried backfill receipt.

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
- organization and personal multiple-created v7 histories held without rebinding the materialized creation;
- all three individual final-prerequisite orderings with injected rollback, exact retry/replay, export, and zero-residual deletion.

## Independent-review successor closure

The first exact successor review rejected commit `6673786c71ab44ef849b434333efd3472c9f242d` with six additional release blockers. Exact implementation commit `2736ca3414a4df23ad858919a6977d77928a7c26` closes those six with deterministic regressions:

1. payment and subscription final receipts prove the exact provider cursor became `applied` for the same event and reconciliation inside the batch;
2. privacy deletion's final receipt proves the catch-all prepared-generation abandonment/cancellation state, so a concurrent safe checkout cannot commit a one-time freeze and then produce a post-commit count error;
3. migration 0008 holds organization or personal v7 history with multiple creation proofs and never rewrites the bound materialized creation;
4. retired-generation refunds append exact historical financial records while preserving every current-generation projection and cursor;
5. provider-less prepared v7 successors receive no legacy missing-generation bridge marker; and
6. individual eligibility derivation and its source/audit receipt are atomic across reconciliation, consent, and attestation, including exact migration repair evidence.

This section records implementation evidence only. It does not claim approval of the final report-bearing successor commit; that exact commit still requires a fresh independent review.

## Local gates

All commands ran from `services/team-control-plane` with the checked-in provider flags disabled and a reused local dependency tree. No production or remote D1 target was used.

| Gate | Result |
|---|---|
| Focused individual eligibility/privacy regressions | 13 passed |
| `npm run check` | generated types current; TypeScript green; 5 files / 65 tests passed |
| `npm run test:migration-0008` | populated exact v7 billing/GitHub/eligibility fixture upgraded; second apply idempotent; billing ambiguity, unsupported pre-existing eligibility, and organization/personal multiple-created histories held with migration rollback and original v7 state preserved |
| JSON schema parse | all 17 service schemas parsed |
| `npm run stripe:executor:dry-run` | green, 75.19 KiB; execution flag remained `false`; no upload |
| `npm run stripe:reconciler:dry-run` | green, 43.69 KiB; reconciliation flag remained `false`; no upload |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `git diff --check` | green |

## External prerequisites and residual risk

This remediation does not prove live provider behavior. Before enabling either adapter, operators still must configure and independently review exact Stripe API/version semantics, restricted-key permissions for exact Session expiration and Subscription cancellation, webhook/reconciler registration, retry/monitoring for unresolved compensation, GitHub App permissions and lifecycle delivery behavior, authoritative `not_found` handling, read-only reconciliation, production D1 migration/backup/rollback, secrets, observability, privacy retention, and the final deployed SHA. Payment, MRR, customer activation, and renewal remain unproven.
