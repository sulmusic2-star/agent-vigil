# Organization control plane: gated design

**State:** design only. No hosted service or GitHub App is deployed in v0.5.0.

The open verifier is the product wedge. A hosted control plane becomes justified
only after external repositories demonstrate that the receipt is useful enough
to require on merges. Building the dashboard before that signal would create
hosting, security, privacy, and support obligations without demand evidence.

## Enforcement path

GitHub rulesets can require a status check and restrict accepted updates to a
specific installed GitHub App. The future Agent Vigil App should therefore own
one check name, `Agent Vigil evidence`, and use these permissions:

- **Checks: read and write** — create and conclude the check run.
- **Contents: read** — read the base policy and resolve exact commits.
- **Metadata: read** — GitHub App baseline permission.
- **Pull requests: read** — identify base/head and annotate the PR.

No administration, issues, members, secrets, deployments, or write-to-code
permission belongs in the default installation.

Reference: [GitHub ruleset status-check source restrictions](https://docs.github.com/en/enterprise-cloud%40latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging).

## Event and trust flow

1. GitHub delivers `pull_request` or `check_suite` to the App.
2. The App records delivery ID and installation ID, validates the webhook
   signature, and deduplicates the event.
3. An isolated runner checks out the exact base and head SHAs.
4. Policy is loaded from the base commit, never from the candidate worktree.
5. The runner obtains an explicit transcript export or a privacy-preserving
   evidence envelope. Absence is INCONCLUSIVE.
6. Agent Vigil runs fresh verification with no repository write token or
   deployment credentials.
7. The service validates receipt schema and hash, signs the receipt with a KMS
   or HSM-backed organization key, stores an append-only record, and posts the
   check conclusion for that exact head SHA.
8. A ruleset accepts that named check only from the Agent Vigil App.

A PASS binds evidence to a change. It does not establish semantic correctness
or adequate requirements. GitHub likewise warns that provenance is not proof
that an artifact is secure: [artifact-attestation limitations](https://docs.github.com/en/actions/concepts/security/artifact-attestations#verifying-artifact-attestations).

## Privacy modes

1. **Local receipt:** repository sends only receipt v2, transcript digest, and
   redacted claim evidence. Lowest data collection; weakest completeness proof.
2. **Ephemeral verification:** encrypted transcript is processed in an isolated
   worker and discarded after receipt creation. Retention event is audited.
3. **Customer-hosted:** runner and storage stay in the customer's cloud or
   network; control plane receives only signed status metadata.
4. **Air-gapped:** offline verifier plus customer-pinned keys and exportable
   policy bundles. No hosted dependency.

Raw transcript retention must never be the default.

## Paid surface

- organization-wide App installation and required-check rollout;
- centrally versioned policy packs and exception approvals;
- receipt retention, search, trend analysis, and vendor/agent comparisons;
- SSO/SAML, RBAC, audit logs, webhooks, and SIEM export;
- customer-managed keys, data residency, single tenant, self-hosted, and
  air-gapped deployment;
- support SLA, security review, MSA, and DPA.

The CLI, Action, receipt schema, and local verification remain open source.

## Build gates

Do not start the hosted implementation until all first-stage evidence exists:

- 10 external repositories have generated receipts;
- 1,000 receipts were generated outside the maintainer's own test fixtures;
- fewer than 1% of reviewed verdicts are unexplained hard false verdicts;
- 20 real contradictions were accepted as useful by maintainers;
- three organizations independently request centralized enforcement;
- two organizations authorize paid written-only pilots.

Do not describe pilots as renewals, revenue, or market validation until there is
separate written and payment evidence. A renewal or scope expansion is the gate
for scaling the hosted product.

## Non-negotiable controls before hosting

- webhook HMAC validation and replay protection;
- installation-scoped tokens with minimum permissions and short lifetimes;
- isolated, disposable execution with resource and network limits;
- no secrets on untrusted fork jobs;
- tenant isolation and encrypted storage;
- KMS/HSM-backed signing keys with rotation and revocation;
- append-only audit events and explicit retention/deletion policy;
- dependency, container, and infrastructure provenance;
- incident response, backup/restore tests, DPA, subprocessors, and security
  contact before accepting enterprise data.
