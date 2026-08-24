# Proof-network freshness and first-100 integrity remediation report

## Outcome and provenance

- Outcome: `fixed` in the local successor implementation; not released or deployed.
- Sealed scan ID: `a205dca1-f1f7-4182-87aa-f40f571c9962`.
- Findings remediated:
  `csf_00d2a7cc9f575e98e23b4030`,
  `csf_326255bbf9c80a932119ad4b`, and
  `csf_004703302df3adfe21f66228`.
- Exact clean base: `9d08e6fdc3832efa669003446f786966fa290af7`.
- Foundational implementation commit:
  `fb216ce2569b96679fe1021d43821c75c60a5a17`.
- Independent-review follow-up implementation commit:
  `2234444a2144dc7b2692357952b59d731a54b740`.
- Branch: `codex/v017-proof-freshness-fix`.
- Worktree:
  `/Users/timsullivan/LocalWorkspaces/agent-vigil-v017-proof-freshness-fix.nosync`.

The authoritative read-only scan bundle is:

`/private/var/folders/6z/r1b_0fp51mzcnhpwf2_xxhw40000gn/T/codex-security-scans-qs0tNT/agent-vigil-v017-remediation-integrated.nosync/9d08e6fdc3832efa669003446f786966fa290af7_20260824T031549Z_ms9s872j`

Its observed custody hashes are:

- `scan-manifest.json`:
  `d6955c25915a38f55079b80e1ff3bd89fce84fa77e979117a13b25864b46193e`.
- `report.md`:
  `9a2b4429585adcaf56c9df207c9aa69fa16e1cc49dbb0f53936455899daaf255`.
- `findings.json`:
  `6126d4fd6e943dd495496896ed875f3448d6dcaa7494a2f19be4c83f68841aa9`.
- `coverage.json`:
  `00538d39b212ad48b3f16211cbcac40135be2f06826576f2391c27f688daa80e`.

The sealed bundle was not modified. This add-only repository artifact records
the successor remediation without changing the scan, its findings, or its
hash tree.

## Finding dispositions

### `csf_00d2a7cc9f575e98e23b4030` — stale unsigned ACTIVE provenance

Status: fixed.

The former offline gate accepted a static raw-ledger/provenance snapshot with
no independently pinned current moderation state. A retained ACTIVE snapshot
could therefore survive a later publisher revocation.

The successor exports a canonical Ed25519-signed manifest and a separately
signed current-head document under an operator duty that must be distinct from
every publisher and acquisition-adapter key. The current head binds the exact
registration, raw-ledger, provenance, chunk-root, stop-event, moderation
checkpoint, publisher-state digest, and adapter-state digest. The manifest has
an issued time and a five-minute expiry; the verifier uses its actual clock,
allows only five seconds of future skew, and requires the independently
supplied operator public key and current head.

The offline verifier rejects unsigned or partial envelopes, a different
operator key, operator/publisher/adapter key reuse, future or expired
documents, checkpoint rollback, manifest/head disagreement, stale ACTIVE
state against a newer REVOKED head, and any raw/provenance/chunk/state/stop
tamper. A currently ACTIVE publisher with an ACTIVE trusted adapter remains
eligible. A currently SUSPENDED or REVOKED publisher or adapter is quarantined
and contributes no gate credit. Static or expired files cannot produce a gate
PASS. The checked-in empty corpus remains an explicit trusted-head-required,
insufficient-distribution zero state.

### `csf_326255bbf9c80a932119ad4b` — publisher-controlled exclusions

Status: fixed.

The publisher no longer supplies eligibility, exclusion reason, inspection
state, acquisition handle, or a claimed duplicate decision. It submits only a
strictly parsed, authenticated acquisition fact. Before any artifact grant,
the Worker allocates the server handle and sequence and persists the attempt.
An independently registered adapter may attest the exact UNOPENED acquisition
under its versioned Ed25519 key. Adapter event IDs are replay-protected and the
adapter key must be distinct from the publisher and operator duties.

The server derives every eligibility outcome. Missing, invalid, stale,
replayed, or key-conflicting adapter evidence is recorded as a counted,
gate-ineligible pre-inspection exclusion; it is not a way to avoid quota
accounting. Exact duplicate pairs are determined from prior D1 state. The
global component cap is determined by the D1 constraint. A distinct fake
`DUPLICATE_PAIR`, a publisher-selected exclusion, or a post-inspection decision
cannot enter through the strict acquisition contract. An included row can be
evaluated only after the exact server handle receives the separately signed
adapter grant, preserving register-before-acquire ordering.

Independent review found that adapter revocation could win after the
application-level ACTIVE check but before the included-row insert. The D1
guard correctly rejected the inclusion, but the original catch path returned
an error and omitted the chronological attempt. The successor now retries the
same authenticated request, canonical body hash, raw-event hash, server handle,
and request ID exactly once as an adapter-null
`MALFORMED_PREINSPECTION_RECORD` exclusion. The retry still crosses the D1
publisher, sample-closure, global, channel, and per-publisher guards; only a
real bounded refusal can prevent persistence.

The same review found that an idempotent access-grant replay returned before
rechecking current adapter status or grant freshness and repeated the
`ADAPTER_MAY_ACQUIRE_AFTER_GRANT` label. Exact replays now recheck the current
adapter and both the signed request and original-grant five-minute windows. A
still-current replay returns only `HISTORICAL_GRANT_RECEIPT_ONLY`; revoked or
expired replay returns a non-authorizing conflict and never renews acquisition
authority.

### `csf_004703302df3adfe21f66228` — unbounded excluded rows and export

Status: fixed.

All attempts, including excluded and missing-adapter attempts, consume the same
concurrency-safe D1 budgets. `BEFORE INSERT` triggers serialize and enforce a
1,000-row global cap, 500-row channel/lane cap, 400-row per-publisher cap,
20-row global component cap, and the frozen 100-included-row sample boundary.
Cross-request stop events are unique, append-only records for publisher,
channel, global, and sample exhaustion. Unexpected constraint or persistence
errors fail closed rather than being reclassified as a benign duplicate or
component exclusion.

The public gate export is no longer an unbounded serialization. It emits
operator-signed chunks of at most 100 ordered rows, a signed descriptor for
every chunk, a hash chain and whole-export root, and exact bounded cursor
identity. The offline verifier reconstructs the exact ordered sequence and
rejects chunk omission, duplication, path or record reordering, insertion, and
tampering. D1 before/after snapshot markers bind row counts, maxima,
evaluation/grant counts, authority checkpoints, and stop events; a concurrent
change aborts export rather than signing a mixed snapshot.

## Changed surfaces

- Worker routing and exact request authentication:
  `services/proof-network/src/index.ts`.
- Acquisition, quota, authority, grant, signed-export, and current-head logic:
  `services/proof-network/src/frequency.ts`.
- Concurrency invariants and stop events:
  `services/proof-network/migrations/0002_frequency_integrity.sql`.
- Offline envelope, authority, provenance, quota, and chunk verification:
  `proof/update-pair-corpus/frequency/validate-first-100.mjs`.
- Strict publisher acquisition schema:
  `proof/update-pair-corpus/frequency/first-100-acquisition-v1.schema.json`.
- Hosted/offline interoperability and deterministic adversarial coverage:
  `services/proof-network/scripts/verify-frequency-interop.mjs`,
  `services/proof-network/test/worker.test.ts`, and
  `test/first-100-registration.test.ts`.
- Default-disabled configuration, generated Worker bindings, and trust-boundary
  documentation under `services/proof-network` and the frequency corpus README.

No sealed raw ledger, sealed provenance sidecar, registration, or prior scan
artifact was edited.

## Verification evidence

The following bounded gates passed on the implementation commit:

- `npm run typecheck` at the repository root — PASS.
- `node --check proof/update-pair-corpus/frequency/validate-first-100.mjs` —
  PASS.
- `node --import tsx --test test/first-100-registration.test.ts` — PASS,
  12/12 tests.
- `npm run test:frequency-interop -- --corpus ../../proof/update-pair-corpus`
  from `services/proof-network` — PASS; acquisition schema SHA-256
  `76b6ae1a32ba1fbb011c3c95ebfecfdac036e50e724de6899db2e782636465ea`,
  `compatible: true`, and the empty corpus remained
  `INSUFFICIENT_DISTRIBUTION_VOLUME`.
- `npm test -- --run test/worker.test.ts` from `services/proof-network` — PASS,
  19/19 focused Worker/D1 tests.
- `npm run check` from `services/proof-network` — PASS: Worker types,
  TypeScript, 23/23 Worker/D1 tests, and Wrangler deploy dry-run. The bounded
  bundle was 173.73 KiB, gzip 34.87 KiB; no deployment occurred.
- Fresh local application of D1 migrations `0001` and `0002` — PASS;
  `PRAGMA foreign_key_check` returned no rows and all 15 frequency triggers
  were present.
- `git diff --check` — PASS.

The adversarial matrix includes fresh ACTIVE positive control; current REVOKED
quarantine; stale ACTIVE/new REVOKED mismatch; wrong key; future, expired, and
rollback documents; missing adapter; signed inclusion without a trusted
pre-inspection acquisition; an exact adapter-revocation-before-insert
interleave; duplicate adapter events; the same interleave at a real publisher
cap; fresh, expired, and revoked access-grant replay; after-close and
post-inspection rows; concurrent quota exhaustion; and chunk omit, duplicate,
reorder, and tamper cases. The frequency PASS/FAIL result remains separate
from whether an otherwise valid fresh trust envelope is authorized for
evaluation.

No dependency installation or full root-suite expansion was performed on the
space-constrained host. Exact-lock dependency trees were temporarily reused by
symlink for the bounded gates and the successor symlinks were removed before
commit.

## Independent review

Independent exact-SHA review of
`fb216ce2569b96679fe1021d43821c75c60a5a17` returned NO-GO. It reproduced the
adapter-revocation insert race that omitted a chronological row and the
access-grant replay path that skipped current adapter/freshness checks. Both
paths are changed in `2234444a2144dc7b2692357952b59d731a54b740`, with
deterministic controls described above.

Independent exact-SHA re-review of
`2234444a2144dc7b2692357952b59d731a54b740` remains a required integration
gate. This report does not treat the implementing lane's own review or its
green tests as independent closure evidence.

## Residual external prerequisites

- Generate, store, rotate, and independently pin a production operator
  Ed25519 key. Configure a real non-placeholder operator key ID, and deliver
  the signed current head over a trust channel independent of publisher files.
- Implement and independently review the trusted acquisition adapter that
  registers UNOPENED facts before granting artifact access. Configure its
  separately held key/version and exercise revocation and rotation.
- Apply the migration to the intended D1 environment only after backup/restore
  preparation, configure the production bindings and secrets, and repeat the
  quota, race, export, and restore checks against that environment.
- Repeat complete exact-SHA gates and a fresh sealed security review after this
  successor is combined with the Team remediation.

All proof, lifecycle, and frequency ingestion flags remain disabled by default;
R0 remains `UNSET`, released channels remain empty, and operator/D1 values are
placeholders. No release, publish, deploy, provider mutation, external
activation, adoption, payment, MRR, renewal, or revenue is established by this
remediation.
