# Agent Vigil proof network

This is a local, deployment-ready Cloudflare Worker/D1 candidate for signed compatibility proofs. It has **not** been deployed, published, connected to a Cloudflare account, or used by an external installation. All three ingestion lanes are disabled in `wrangler.jsonc`.

## What it serves

- `POST /v1/entries` and `/v1/resolutions`: explicit-consent ingestion of exact-schema, self-verifying Ed25519 records from an active registered publisher key.
- `/`, `/proof/:hash`, and `/resolution/:hash`: safe HTML search and record pages.
- `/api/v1/search`, `/api/v1/entries/:hash`, `/api/v1/resolutions/:hash`, and `/api/v1/badges/:hash`: GET-only public JSON/SVG-adjacent badge data with CORS and bounded cache policy.
- append-only publisher status and moderation state for correction, takedown, revocation, and restoration. Original signed bytes are retained.
- authenticated, opt-in lifecycle ingestion. A server-issued per-installation credential HMAC-binds every exact request. This anonymous lane rejects organization events and labels every receipt/export `UNVERIFIED_TELEMETRY`, `gateEligible: false`, and `sybilSusceptible: true`.
- publisher-authenticated pre-inspection registration and append-only export for the frozen first-100 problem-frequency frame. The frozen JSONL deliberately remains byte-stable; `/api/v1/frequency/first-100-provenance.jsonl` is the required sidecar for publisher key/status and effective quarantine state. The raw ledger is never gate-eligible by itself.

No endpoint accepts source, prompts, transcripts, paths, argv, environment variables, secrets, private repository/organization names, raw canary output, or full receipts. Lifecycle schema validation rejects unknown fields instead of dropping them.

## Local development

Requires Node 20 or newer. These commands mutate only local files/D1 state:

```sh
cd services/proof-network
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm test
npm run check
npm run dev
```

`npm run check` regenerates Worker types, type-checks, runs Miniflare/D1 tests, and performs `wrangler deploy --dry-run`; it does not deploy. Use obvious local-only values in `.dev.vars`. Never reuse production secrets.

To verify interoperability with the separately frozen corpus at commit `cd4c2fbd298fedfb6ac88689006e7be0fdae5755`:

```sh
npm run test:frequency-interop -- --corpus /absolute/path/to/corpus
```

The bound registration is `d0a44ad6-acfc-4542-a5fa-84c68ff37067`; exact registration SHA-256 is `9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da` and exact entry-schema SHA-256 is `b6f090f886d09002163be880adc06c726fafedc81bdb45696ed3e1888f1e7757`.

## Explicit CLI opt-in

The root CLI locally verifies a proof against a separately pinned publisher key before upload:

```sh
vigil upgrade publish compatibility-entry.json \
  --endpoint https://proof.example \
  --public-key publisher.pem \
  --consent-public-proof
```

Anonymous lifecycle registration writes an owner-private credential file. The file contains a secret; do not commit, print, or pass it as an argument:

```sh
vigil upgrade telemetry-register \
  --endpoint https://proof.example \
  --channel apm \
  --run-class EXTERNAL_STANDARD \
  --credential-output .agent-vigil/lifecycle-credential.json \
  --consent-lifecycle

vigil upgrade telemetry lifecycle-event.json \
  --endpoint https://proof.example \
  --credential .agent-vigil/lifecycle-credential.json \
  --consent-lifecycle
```

Telemetry decline or failure never changes an upgrade verdict. Anonymous registration is not organization authentication and cannot satisfy the R0 installation, activation, repeat, PQL, payment, or revenue gates. A future organization lane must use authenticated GitHub App or Team tenancy and a distinct contract.

## Operational boundaries

- Proof and resolution bodies are capped at 512 KiB; lifecycle bodies at 32 KiB; administrative/frequency bodies at 64 KiB.
- Writes have key- or installation-bound rate limits. Anonymous credential registration uses the Cloudflare edge address only as an ephemeral abuse-control key; it is not stored in D1 or analytics.
- Publisher requests and lifecycle HMAC requests have five-minute replay windows plus persistent idempotency keys.
- D1 assigns server receipt time and an autoincrement sequence. Frequency records are stored before evaluation; triggers prevent a concurrent 101st included pair or 21st pair for one component. Revoked/suspended publisher records keep their original sequence but are dynamically quarantined in the provenance sidecar and cannot receive a new evaluation.
- Revoked publisher keys and lifecycle credentials are terminal because reactivation would restore the same compromised secret material. Only a suspended publisher may transition back to active, with an explicit `RESTORED` event. D1 guards the same transition invariants against concurrent administrative writes.
- A public resolution is admitted and served only while the resolution, signer, broken entry, and fixed entry are all active and unmoderated. D1 rechecks referents on insert, and every direct, embedded, search, badge, and sitemap trust representation requires revalidation rather than serving a positive stale cache entry.
- Public pages use escaped values and a restrictive CSP. Public APIs allow cross-origin GET only. Writes never permit browser CORS.
- Logs contain method, fixed route, status, error class, and a random request ID—not query strings, bodies, identifiers, IPs, or secrets.

## Deployment prerequisites (not performed)

1. Create the production D1 database and replace the all-zero placeholder database ID.
2. Allocate unique production rate-limit namespace IDs, including the registration limiter.
3. configure the custom domain/route and intentionally decide whether `workers_dev` stays disabled.
4. Set separate high-entropy Worker secrets: `ADMIN_TOKEN`, `TELEMETRY_HMAC_KEY`, and `LIFECYCLE_ISSUING_KEY`. Define rotation, overlap, and recovery procedures first; rotating the issuing key invalidates existing anonymous installation secrets.
5. Apply `migrations/0001_initial.sql`, verify backup/export restoration, then register the reviewed publisher public key through the admin endpoint.
6. Keep `R0_RELEASED_AT=UNSET`, `RELEASED_CHANNELS=""`, and all ingestion flags false until an independently reviewed external R0 release and channel-specific C0 exist.
7. Complete privacy/security review, abuse/WAF rules, retention/deletion policy, moderation/security contact, observability redaction and sampling review, uptime/status decision, and takedown runbook.
8. Enable proof, lifecycle, and frequency ingestion separately with rollback tests. Never use anonymous lifecycle exports as demand-gate metrics.
9. Independently review and validate the exact post-merge SHA. This directory's local tests do not establish deployment, external adoption, correctness of Cloudflare account settings, or revenue.

## Administration

Administrative routes require a bearer token and are intentionally absent from browser CORS:

- `POST /v1/admin/publishers/register`
- `POST /v1/admin/publishers/status`
- `POST /v1/admin/moderation`
- `POST /v1/admin/lifecycle/installations/status`
- `GET /v1/admin/lifecycle/export`
- `POST /v1/admin/frequency/first-100/evaluations`

Treat lifecycle credentials and exports as sensitive operational data even though raw installation IDs are pseudonymous and event exports replace them with keyed hashes.
