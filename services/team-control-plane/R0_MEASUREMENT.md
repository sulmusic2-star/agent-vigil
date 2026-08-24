# R0 lifecycle measurement boundary

This local-only projection provides bounded organization lifecycle evidence and a fail-closed receiver for a separately authenticated individual lane. Both are disabled in the checked-in configuration, have not been deployed, and contain no external installation, activation, repeat, PQL, offer, payment, or revenue evidence.

It does not promote the proof network's anonymous lifecycle events. Those events remain `UNVERIFIED_TELEMETRY`, `gateEligible: false`, Sybil-susceptible, and excluded from every count here.

## What can count

An organization installation enters the opted-in denominator only after all of these independent facts exist:

1. A Team tenant was created through the authenticated control-plane boundary.
2. Its GitHub App installation was preclaimed by a human owner.
3. A signed GitHub webhook created the installation and a separately signed, fresh reconciliation activated it.
4. A separately permissioned identity bridge attested the installation as `external` using `provider_confirmed_non_operator`. Internal, demo, and test attestations are retained as explicit exclusions.
5. A human owner opted in through the tenant-authenticated consent route.
6. The provider installation time is on or after the immutable R0 start and its App ID matches that boundary.

The service computes a stable HMAC-opaque `morg_...` subject token. Measurement tables and report responses store no repository names, account names, email addresses, source code, receipt bodies, or credentials. The Team service's existing provider adapter state remains separate and subject to its own privacy contract.

Subject classification is chronological. A newer signed identity observation may replace the current classification, but an older observation is rejected without mutation. A different message at the same `observed_at` is ambiguous and rejected even when its classification matches; only replay of the exact same message ID and bytes is idempotent. D1 also enforces the strictly increasing classification timestamp so a concurrent or non-HTTP write cannot roll the projection backward.

An activation is one fresh, signed bridge observation per eligible subject and UTC day. Additional observations on the same day are accepted as idempotent evidence but marked `ignored_duplicate_day`; they cannot manufacture repeat.

- A matured activation cohort contains subjects whose first activation is at least 60 days old.
- Repeat means another activation on a different UTC day within 60 days of first activation.
- PQL means another activation on a different UTC day within 30 days of first activation.
- An offer can count only after the server computes PQL. `team_offer_presented_v1` is bound to `team_v1_299_monthly_2990_annual`: $299/month or $2,990/year for 15 contributors. It must be emitted by the trusted bridge only after an actual authenticated in-product presentation or provider-confirmed delivery of that real Team offer. Preparing an offer, attempting to send it, or creating a billing command is not presentation.
- A matured offered-PQL is one whose counted offer presentation is at least 30 days old.

The sample floor is reported as met only with at least 200 matured activated organizations and 40 matured offered PQLs. The projection does not infer payment, MRR, renewal, or a unique legal company from those counts.

## Immutable R0 boundary

The following deployment values must be non-placeholder and exact before enabling ingestion:

```text
R0_MEASUREMENT_ENABLED=true
R0_MEASUREMENT_RELEASE_VERSION=...
R0_MEASUREMENT_RELEASE_COMMIT_SHA=...  # exact 40-character Git commit
R0_MEASUREMENT_RELEASE_CHANNEL=github_app
R0_MEASUREMENT_ENVIRONMENT=production
R0_MEASUREMENT_RELEASE_PUBLISHED_AT=... # canonical UTC timestamp
R0_MEASUREMENT_STARTED_AT=...           # canonical UTC timestamp, not before publication
GITHUB_APP_ID=...
```

The signed `r0_boundary_v1` bridge message must exactly equal those values. It initializes one immutable D1 record. Every later request fails closed if the stored boundary drifts from deployment configuration. This prevents a later environment edit from silently moving a cohort boundary.

## Signed bridge

`POST /v1/measurement/bridge` accepts `r0-measurement-bridge-v1` messages. The bridge signs the exact raw JSON bytes with:

```text
Agent-Vigil-Measurement-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
signed_payload = "<unix-seconds>.<exact raw body>"
```

Control, identity-classification, activity/offer, and stable-identity operations use four unrelated HMAC secrets of at least 32 UTF-8 bytes:

```text
R0_MEASUREMENT_CONTROL_HMAC_SECRET=...
R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET=...
R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET=...
R0_MEASUREMENT_IDENTITY_HMAC_SECRET=...
```

One shared guard runs before enabled bridge/report body reads, consent or installation-claim mutations, and GitHub webhook/reconciliation ingestion. Organization measurement validates its four measurement secrets together with the Team-session, GitHub-webhook, and GitHub-reconciliation secrets as one seven-duty pairwise set. Enabling the individual lane adds its session and stable-identity secrets, so all nine roles are pairwise distinct. A missing, short, or repeated active value produces one generic configuration error without identifying a duty or secret. `r0_boundary_v1` and report queries require the control key; subject attestations require the identity-bridge key; activations and offer presentations require the activity-bridge key. A holder of the activity key cannot classify a subject as external or move R0. Production deployments must place these duties in separately permissioned components.

Requests and observations have a five-minute freshness window. `message_id` and exact payload SHA-256 provide idempotency and payload-reuse detection. The API rejects unknown fields. Bridge messages name only an installation ID; organization identity, channel, release, environment, opt-in, App state, and eligibility are resolved from trusted server state. Subject classification is accepted only from this authenticated bridge, never from an organization or anonymous event client.

The same signature boundary protects `POST /v1/measurement/report`, whose request schema is:

```json
{
  "schema_version": "r0-measurement-report-request-v1",
  "query_id": "query_opaque",
  "observed_at": "2026-08-23T00:00:00.000Z"
}
```

Tenant routes are:

- `PUT /v1/orgs/{org_id}/measurement-consent` — human-owner opt-in or withdrawal.
- `GET /v1/orgs/{org_id}/measurement` — owner/admin private state.

Organization privacy export includes consent, opaque subject state, attestations, and events. Confirmed organization deletion removes them before revoking the provider installation and removes organization-scoped measurement and GitHub App audit rows, including `morg_` tokens, classification/basis metadata, installation IDs, and measurement event IDs. A minimal non-identifying deletion-completion audit remains; commercial retention is separate. Opt-out immediately excludes the subject from reports but preserves private evidence until deletion. This means the denominator covers current opt-ins, not all product users, and can change after withdrawal/deletion.

## Individual lane: implemented receiver, deployment HOLD

The individual receiver is enabled only when `R0_INDIVIDUAL_MEASUREMENT_ENABLED=true` and all exact configuration and secret-role checks pass. The checked-in value is `false`, so reports return `HOLD` / `UNMEASURABLE` with `null` denominators. Enabling requires:

```text
INDIVIDUAL_SESSION_ENABLED=true
INDIVIDUAL_SESSION_ISSUER=https://.../       # exact trusted GitHub/OIDC adapter issuer
INDIVIDUAL_SESSION_AUDIENCE=...              # exact control-plane audience
INDIVIDUAL_SESSION_KEY_ID=...
R0_INDIVIDUAL_IDENTITY_HMAC_KEY_ID=...
INDIVIDUAL_SESSION_HMAC_SECRET=...           # secret binding
R0_INDIVIDUAL_IDENTITY_HMAC_SECRET=...       # secret binding
```

An `avindividual_v1` session is limited to 15 minutes, identifies a human, and binds its exact key ID, issuer, audience, and authenticated subject to one stable GitHub account node ID. The user must explicitly opt in and claim a numeric installation ID; the claim body cannot supply an account identity. GitHub's signed webhook must attest `installation.account.type = User`, and a separate fresh reconciliation snapshot must independently confirm the same App, installation, node ID, account type, lifecycle delivery, and selection mode before eligibility.

The identity bridge records chronological external/internal/demo/test classification, signed auth-subject rotation, and provider-confirmed account merge. A stable HMAC-opaque `mind_...` token is persisted at first binding. A merged source becomes inactive and cannot emit new activity. Human mutations are session/action replay-bound; message IDs are exact-byte and cross-lane replay-bound.

`individual_activation_v1` accepts no subject, account, login, IP, repository, or device identity. It names only the personal installation and proves `verifier_outcome=completed`, the exact immutable R0 version and commit, one verdict, and a receipt SHA-256 under the activity-bridge signature. Server state resolves the opted-in external subject. One event per canonical subject and UTC day counts; merged aliases use the earliest `occurred_at` on that day regardless of insertion order. Matured repeat is a second day within 60 days of that true first activation, with the first activation at least 60 days old.

Individual export includes the authenticated bindings and evidence. Privacy routes verify the independently enabled exact session boundary and resolve only an existing node/auth-subject binding; they do not depend on measurement-duty separation, so export and erasure remain available during an unrelated measurement-secret incident. Consent, claims, provider/activity ingestion, identity changes, and reports remain behind the complete duty-separation guard. Confirmed deletion removes the raw node/auth binding, opaque token, personal claim/installation, deliveries, reconciliation, events, bridge evidence, and audit rows; only a non-identifying completion tombstone remains. Download counts, anonymous telemetry, IP/device fingerprints, repository names, and self-asserted identities are never joined.

The receiver alone does not clear deployment HOLD. A real GitHub/OIDC issuer, read-only GitHub reconciliation adapter, operator/demo/test registry, activation bridge, production secrets, staging exercise, and independent exact-SHA review remain external prerequisites. No provider adapter is called by this Worker.

## Coverage and Sybil limits

- Opt-in coverage is intentionally incomplete and is never described as total installations.
- GitHub installation identity prevents casual replay and duplicate counting, but it does not prove unique legal-company identity. A party can create multiple provider accounts or organizations.
- The external classifier must maintain audited operator/demo/test registries and prevent its own accounts from receiving `provider_confirmed_non_operator` attestations.
- The activation bridge is a separate trusted component that must authenticate successful verifier use and offer presentation. This repository implements only its receiving contract.
- Signed authentication-subject rotation and provider-account merge are implemented. Replacing the stable HMAC identity key still requires an explicit reviewed token-migration procedure and must never be done silently.

These limits remain in every report and block any claim that anonymous interest, downloads, prepared offers, or synthetic tenants satisfy an R0 gate.
