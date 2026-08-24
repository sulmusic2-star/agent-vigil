# Proof integrity remediation report

## Outcome and identity

- Outcome: `fixed`
- Scan ID: `d6a51474-3449-46ff-8200-de72118224ec`
- Findings remediated: 2, 5, 6, and 8
- Exact base: `c7ac6e93bf1a73da28edb4cb0c0431209c2df903`
- Implementation commit: `cb10250c9f3b89ac82131b0312389be601a0d00a`
- Branch: `codex/v017-proof-integrity-fix`
- Worktree: `/Users/timsullivan/LocalWorkspaces/agent-vigil-v017-proof-integrity-fix.nosync`

The authoritative scan report is:

`/private/var/folders/6z/r1b_0fp51mzcnhpwf2_xxhw40000gn/T/codex-security-scans-qvNeQg/agent-vigil-r0-v016-integrated.nosync/c7ac6e93bf1a73da28edb4cb0c0431209c2df903_20260824T003134Z_d6uhiq9z/report.md`

Its verified SHA-256 is
`bc8cafd72b0e7d7628479b7db90f9b2220a681629dc88a35f706450566ddf2d0`.
The scan bundle and its manifest/hash tree were not modified. The standard
fix-finding output path would be inside that sealed bundle, so this add-only
repository-local report records the remediation without breaking custody.

## Broken paths, invariants, and preserved behavior

### Finding 2: quarantined evidence counted offline

The raw first-100 ledger flowed directly into the official offline counters;
the validator did not consume the hosted publisher-provenance sidecar. The
invariant is that raw chronology is never gate-eligible alone and an inactive
publisher must contribute no gate credit. Active, included publisher evidence
must remain countable, while publisher status changes must not rewrite the
frozen chronological ledger.

The v2 sidecar is now mandatory. Its anchor SHA-256 binds the exact raw-ledger
bytes and exact provenance-record bytes, and its structure requires exactly one
sequence- and frozen-eligibility-bound publisher record for each raw pair.
Missing, stale, duplicate, incomplete, or mismatched provenance fails closed.
Every suspended or revoked row, whether originally included or excluded, is
reported as `QUARANTINED` with `gateEligible: false`; raw chronology remains
byte-stable.

### Finding 5: corrected SAFE evidence stayed green

A `CORRECT` state reached the badge renderer as the original SAFE entry and was
rendered green. The invariant is that corrected or invalid evidence must never
remain an active SAFE representation on any public surface. Append-only
moderation, a bounded correction pointer, the replacement record, and explicit
`RESTORE` behavior must remain available.

`CORRECT` is now unavailable on direct proof and JSON trust surfaces, remains
absent from search/sitemap views, and returns only a neutral light-grey
`corrected` badge with a replacement link. The badge ETag includes moderation
state. A later explicit `RESTORE` makes the original independently valid record
visible again.

### Finding 6: incomplete and contradictory first-100 data could pass

The offline verdict counted three SAFE rows labeled MATERIAL, ignored 97
missing evaluations, and accepted an excluded row whose inspection had already
started. The invariant is that PASS requires all 100 gate-effective INCLUDED
rows to have exactly one complete, conclusive, coherent evaluation, at least
three material regressions, and zero false-compatible outcomes. Every inclusion
or exclusion decision must be recorded before inspection.

The schema, Worker parser, D1 insert/update guards, and offline validator now
share these states:

- `MATERIAL`: complete SAFE with `falseCompatible: true`, or complete CHANGED
  with `falseCompatible: false`, and at least one permitted consequence.
- `NON_MATERIAL`: complete SAFE or CHANGED, `falseCompatible: false`, and no
  consequences.
- `INCONCLUSIVE`: HOLD, incomplete evidence, `falseCompatible: false`, and no
  consequences.

`inspectionStarted` is always false, including exclusions. Missing or HOLD
evaluations produce `INCOMPLETE_EVALUATIONS`; a quarantined sample below 100
produces `INSUFFICIENT_DISTRIBUTION_VOLUME`; contradictory records are rejected;
and zero false-compatible plus the material threshold is required for PASS.

### Finding 8: hosted and offline component keys differed

The service and D1 trigger keyed `(ecosystem, componentIdentity)`, while the
offline validator keyed only `componentIdentity`. The selected contract is one
exact lowercase ASCII global `componentIdentity`, independent of ecosystem.
This matches the signed registration's single component cap; its deduplication
rule separately names ecosystem when ecosystem is intended to matter.

The Worker, D1 index/trigger/CHECK, both schema copies, offline validator,
interop check, and documentation now use the same key and reject non-canonical
case or characters. Concurrent proposals spanning ecosystems stop at 20.

## Files changed

- Public and frequency service behavior:
  `services/proof-network/src/index.ts`,
  `services/proof-network/src/frequency.ts`
- D1 invariants:
  `services/proof-network/migrations/0001_initial.sql`
- Offline contract and verifier:
  `proof/update-pair-corpus/frequency/validate-first-100.mjs`, both
  `first-100-entry-v1.schema.json` copies, both new
  `first-100-provenance.jsonl` anchors, and `proof/first-100/verify.mjs`
- Behavioral interoperability:
  `services/proof-network/scripts/verify-frequency-interop.mjs`
- Dynamic regressions:
  `services/proof-network/test/worker.test.ts`,
  `test/first-100-registration.test.ts`
- Contract documentation:
  both first-100 READMEs plus the proof-network README and threat model

## Tests and validation artifacts added

- Corrected SAFE direct page/API, search, neutral badge, replacement, and
  RESTORE matrix.
- Worker and direct-D1 rejection of contradictory evaluations, with a valid
  CHANGED/MATERIAL control and update-guard coverage.
- Mandatory v2 provenance hashes, one-to-one row binding, suspended/restored/
  revoked included and excluded publisher behavior, and raw-ledger immutability.
- Complete 100-row PASS control; 3-evaluated/97-pending, HOLD, false-compatible,
  contradictory, post-inspection exclusion, after-close row, missing/stale/
  duplicate/incomplete provenance, and publisher-quarantine negative controls.
- Concurrent 20/21 global component boundary across ecosystems, canonical-case
  rejection, and D1 character constraint.
- Fresh migrated D1 foreign-key and integrity checks, schema-copy parity, and
  hosted-export/offline-validator interoperability.

## Ordered verification gates

### 1. Final diff, syntax, types, and build

- `git diff --check` — PASS.
- `npm run typecheck` — PASS.
- `npm --prefix services/proof-network run check` — PASS: generated Worker
  types, TypeScript, 18/18 Worker/D1 tests, and Wrangler deploy dry-run. Bundle:
  131.60 KiB, gzip 27.67 KiB. The command did not deploy.
- Python `Draft202012Validator.check_schema` against both schema copies — PASS.
- Fresh SQLite `:memory:` migration plus `PRAGMA foreign_key_check` and
  `PRAGMA integrity_check` — PASS; foreign-key output empty, integrity `ok`.
- Schema copies and provenance anchors compared byte-for-byte — PASS. Entry
  schema SHA-256:
  `db8311854812f7774b3da7f08b1981fccc2ce4c0fdf1cbc67e0d8e5e29bbd73c`.
- `npm pack --dry-run --json` — PASS; both provenance sidecars and the offline
  validator are included in the package surface.

### 2. Security triggers and alternate malicious inputs

- The sealed base reproducer
  `artifacts/03_validation/reproduce-first100-bypass.mjs` returned
  `FREQUENCY_GATE_PASS` on exact base with three SAFE/MATERIAL/false rows, 97
  missing evaluations, and an inspected exclusion.
- Pointing that exact reproducer at the successor fails before a verdict because
  the mandatory provenance sidecar no longer binds the modified raw ledger.
- `./node_modules/.bin/tsx --test test/first-100-registration.test.ts test/update-pair-corpus.test.ts`
  — PASS, 6/6. This suite recomputes a structurally valid matching sidecar, so it
  also proves the malicious states cannot bypass the fix merely by satisfying
  the digest: incomplete remains incomplete, contradictory SAFE/MATERIAL/false
  is rejected, and post-inspection exclusion is rejected.
- Alternate malicious classes — HOLD/MATERIAL, rows after the frozen 100th,
  stale/duplicate/incomplete provenance, suspended and revoked publishers,
  uppercase/invalid component identity, and cross-ecosystem 21st component —
  all fail closed in the focused matrices.

### 3. Legitimate controls and owning checks

- The complete coherent 100-row fixture with three CHANGED/MATERIAL regressions
  and zero false-compatible outcomes returns `FREQUENCY_GATE_PASS`.
- A coherent SAFE/MATERIAL/true row remains valid input but forces
  `FREQUENCY_GATE_FAIL`, preserving the false-compatible measurement.
- A valid CHANGED/MATERIAL Worker evaluation returns 201; a corrected entry's
  separate replacement remains readable; explicit RESTORE returns the original
  SAFE badge only after moderation state changes.
- `npm --prefix services/proof-network run test:frequency-interop -- --corpus /Users/timsullivan/LocalWorkspaces/agent-vigil-v017-proof-integrity-fix.nosync/proof/update-pair-corpus`
  — PASS, `compatible: true`; the empty frozen corpus remains
  `INSUFFICIENT_DISTRIBUTION_VOLUME`.
- `node proof/first-100/verify.mjs` — PASS, signed registration verified and
  `provenanceBound: true`.
- `node proof/update-pair-corpus/frequency/validate-first-100.mjs` — PASS as a
  validator execution; current empty corpus reports insufficient distribution,
  never PASS.
- `npm run proof:update-pair-corpus` — PASS, 10 durable commitments.
- Root and proof-network `npm audit --audit-level=high` — PASS, zero known
  vulnerabilities.

The original issue no longer reproduces through either the exact stale-sidecar
PoC or a malicious corpus with freshly recomputed binding. Legitimate positive
controls for public replacement/restoration, valid evaluation ingestion,
component boundary 20, active provenance, and a complete 100-row PASS all
remain intact.

## Remaining uncertainty and external blockers

- No full repository-wide test run was attempted in this successor because the
  host had less than 1 GiB free. The owning service's complete check and every
  directly affected root test passed; the final combined candidate still needs
  its independent exact-SHA review and integration gate.
- The sidecar provides SHA-256 content binding and exact structural binding. It
  is a hosted snapshot whose authenticity trust root is the authenticated
  service origin/operator custody; no independent service-side signing key is
  configured in this disabled candidate.
- The separate commercial corpus at
  `/Users/timsullivan/LocalWorkspaces/AgentUpgradeGuardMoney-20260823.nosync/corpus`
  still has the older schema and no v2 sidecar. It was deliberately not mutated
  from this branch and must be ported byte-for-byte after integration.
- Proof, lifecycle, and frequency ingestion remain disabled; R0 is `UNSET`,
  released channels are empty, and the D1 binding is still a placeholder. No
  release, publish, deploy, provider mutation, external activation, adoption,
  payment, or revenue is established by this remediation.
