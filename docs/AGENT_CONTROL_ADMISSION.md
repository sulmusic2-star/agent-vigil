# Agent control admission

Agent Vigil can now turn a live coding-agent control drill into a short-lived,
artifact-specific deployment decision.

The human result is deliberately small:

```text
Agent Vigil control admission: APPROVE
Artifact: codex 0.152.0 sha256:...
```

Anything missing, forged, stale, inconclusive, or bound to different bytes is
`HOLD`.

## What is separate

Production use needs six trust roles:

1. **Environment authority** signs the managed profile and policy snapshot.
2. **Challenge authority** issues fresh, one-time allow and deny routes.
3. **Observer** records the external network effects.
4. **Route notary** seals the complete live-host route receipt.
5. **Isolation authority** attests the worker boundary from outside the candidate.
6. **Admission authority** signs the final package decision.

An `APPROVE` decision requires six different key IDs. Do not put any private
key on the candidate worker. The current CLI supports local Ed25519 test keys
and AWS KMS Ed25519 keys for the challenge, observer, and admission roles. KMS
mode requires `--aws-cli` to point to an absolute executable chosen before any
candidate code runs. The child receives only the direct AWS credential and
web-identity variables it needs; profile files, custom CA bundles, metadata
credentials, and unrelated job secrets are not inherited.

## Run the observer off the worker

Start this before the live-host route drill:

```bash
vigil guard-observer \
  --host codex \
  --host-version 0.152.0 \
  --host-executable-sha256 sha256:EXACT_CANDIDATE_DIGEST \
  --managed-environment-sha256 sha256:EXACT_ENVIRONMENT_BINDING_DIGEST \
  --runner-node /usr/local/bin/node \
  --challenge-kms-key alias/agent-vigil-challenge \
  --observer-kms-key alias/agent-vigil-observer \
  --aws-cli /usr/local/bin/aws \
  --public-origin https://observer.example \
  --challenge-output candidate-challenge.dsse.json \
  --observation-output candidate-observation.dsse.json
```

The observer binds the exact host version, executable digest, managed
environment digest, worker Node path, commands, endpoint paths, request body,
and validity window into the signed challenge. It accepts one exact allow
effect. Any deny effect, duplicate, wrong method, wrong body, unexpected path,
or event outside the window makes the observation fail.

Transfer only the signed challenge and pinned public key to the isolated
worker. Run the ordinary managed-environment steps from
[Live-host routing drill](LIVE_HOST_ROUTE.md), adding:

```bash
vigil guard-route \
  --host codex \
  --host-version 0.152.0 \
  --host-executable /exact/path/to/codex \
  --profile-home /exact/path/to/disposable-profile \
  --environment-statement /private/path/environment.json \
  --environment-public-key /trusted/path/environment-public.pem \
  --external-challenge candidate-challenge.dsse.json \
  --challenge-public-key /trusted/path/challenge-public.pem \
  --output candidate-route.json
```

The worker executes the exact signed allow command through the tested hook and
attempts the exact signed deny command. The observer must see one allow request
and no deny request. The route receipt must independently show that the hook
allowed and executed the first command and denied the second.

The route receipt and observer output are not sufficient by themselves. Before
admission, a separately controlled Linux supervisor must sign an isolation
attestation bound to the exact challenge, route receipt, artifact, and managed
environment. A passing attestation states that the candidate ran as a non-root
UID distinct from the monitor, verifier state was monitor-owned and read-only
to the candidate, monitor IPC was authenticated, and candidate egress was
restricted to the observer. Agent Vigil intentionally provides no local
"trust me" command for minting this evidence. The platform operating that
boundary must issue it using an isolation key unavailable to the worker.

Repeat the complete sequence for the current version. Every challenge is
fresh; do not reuse the candidate's paths or nonce for the baseline.

## Seal and decide

Seal both route receipts in the separate route-notary environment, then create
the admission envelope:

```bash
vigil guard-admit \
  --current-route current-route.dsse.json \
  --current-challenge current-challenge.dsse.json \
  --current-observation current-observation.dsse.json \
  --current-isolation current-isolation.dsse.json \
  --candidate-route candidate-route.dsse.json \
  --candidate-challenge candidate-challenge.dsse.json \
  --candidate-observation candidate-observation.dsse.json \
  --candidate-isolation candidate-isolation.dsse.json \
  --environment-public-key environment-public.pem \
  --route-public-key route-public.pem \
  --challenge-public-key challenge-public.pem \
  --observer-public-key observer-public.pem \
  --isolation-public-key isolation-public.pem \
  --admission-kms-key alias/agent-vigil-admission \
  --aws-cli /usr/local/bin/aws \
  --output admission.dsse.json
```

Admission recomputes every hash and signature. It pairs each external effect
with its challenge and exact route command, checks the same managed environment
and operating system, compares current and candidate behavior, requires a new
candidate version, and signs only a one-hour decision.

## Put the result in front of deployment

Call the gate from the package-promotion, MDM, internal portal, or deployment
job before it publishes or installs anything:

```bash
vigil guard-deploy-gate \
  --admission admission.dsse.json \
  --admission-public-key /trusted/path/admission-public.pem \
  --artifact ./codex-candidate-package \
  --environment-sha256 sha256:EXACT_ENVIRONMENT_BINDING_DIGEST \
  --host codex \
  --version 0.152.0
```

Exit `0` means the exact file bytes have a currently valid `APPROVE`. Every
other condition exits nonzero. The deploy system must treat a missing command,
timeout, unavailable KMS, missing envelope, and nonzero exit as `HOLD`.

## GitHub deployment protection

`guard-deploy-authorize` narrows one approved admission to one repository,
commit, and GitHub environment. A separate deployment key signs that short-lived
authorization. The public App requires the authorization and its separately
signed admission, verifies both pinned keys and their exact linkage, and
authenticates the registration transport before retaining it.

```bash
vigil guard-deploy-authorize \
  --admission admission.dsse.json \
  --admission-public-key admission-public.pem \
  --repository owner/service \
  --commit-sha 0123456789abcdef0123456789abcdef01234567 \
  --environment production \
  --deployment-kms-key alias/agent-vigil-deployment \
  --aws-cli /usr/local/bin/aws \
  --output deployment-authorization.dsse.json
```

Register the paired evidence from the operator environment. The registration
secret is read from the environment and is not accepted as a command argument:

```bash
AGENT_VIGIL_REGISTRATION_SECRET="$REGISTRATION_SECRET" \
vigil guard-deploy-register \
  --authorization deployment-authorization.dsse.json \
  --deployment-public-key deployment-public.pem \
  --admission admission.dsse.json \
  --admission-public-key admission-public.pem \
  --url https://APP_ORIGIN/deployment/authorizations
```

When a protected job reaches that environment, GitHub sends the App a signed
`deployment_protection_rule` webhook. The App approves only when a current
authorization matches the exact repository, commit, and environment. Otherwise
it rejects the job.

The App decision is the first gate, not proof of the package bytes a later step
will deploy. The protected job must also run `guard-deploy-bound-gate` against
the downloaded package or installer. That second gate reopens both signed
documents and hashes the actual file. Removing it weakens the claim from
"these bytes were admitted" to "this commit and environment were authorized."

```bash
vigil guard-deploy-bound-gate \
  --authorization deployment-authorization.dsse.json \
  --deployment-public-key deployment-public.pem \
  --admission admission.dsse.json \
  --admission-public-key admission-public.pem \
  --repository "$GITHUB_REPOSITORY" \
  --commit-sha "$GITHUB_SHA" \
  --environment production \
  --artifact ./downloaded-candidate-package \
  --environment-sha256 sha256:EXACT_ENVIRONMENT_BINDING_DIGEST
```

GitHub custom deployment protection rules are in public preview. They are
available for public repositories on all plans; private and internal repositories
require GitHub Enterprise. No production deployment has yet exercised this path.

## Proof boundary

The observer independently proves one allowed network effect and the absence
of its deny effect during the signed window. It does not see local operations
that never reach it. Deny-attempt and routing evidence still rely on the
isolated worker, host hook, and route notary. A compromised worker operating
system or collusion among pinned trust roots remains out of scope.

This is a working protocol and gate, not a hosted production service. The
repository tests use a loopback observer and a fake AWS CLI; they do not prove
AWS deployment, MDM integration, external adoption, or commercial demand.
