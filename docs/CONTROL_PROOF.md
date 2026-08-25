# Control Proof

`vigil prove` checks that the installed Agent Vigil controls still make the
decisions they are supposed to make before you rely on them in a pull request.

```bash
vigil prove --repo . --base HEAD
```

The command clones the selected commit into a temporary local directory. It
does not alter the working repository, push a branch, or call an agent or model
provider. Installed Git and its configuration remain part of the trusted local
environment. In the temporary clone it checks these cases:

1. an unchanged authority surface passes;
2. a new MCP server is blocked;
3. a candidate's attempt to approve its own new authority stays blocked;
4. an unreadable supported authority file stays on hold;
5. a weaker Codex sandbox is blocked; and
6. a newly skipped test is blocked by the calibrated Test Integrity Guard.

The temporary clone must also be removed successfully. The overall result is
`PASS` only when every expected result is observed and cleanup succeeds. Any
unexpected verdict, setup error, or cleanup error returns `HOLD` with exit code
2.

## Receipt

Use `--output` to retain the machine-readable receipt:

```bash
vigil prove --repo . --base HEAD --output .agent-vigil/control-proof.json
```

The receipt records the exact starting commit, the synthetic challenge commits,
expected and actual results, reproduction command, stated limits, and a
SHA-256 digest over that payload. It does not contain application code or test
output.

## What this proves

The receipt proves that this installed Agent Vigil build handled the listed
synthetic changes as expected in a disposable clone.

It does not prove that GitHub branch protection requires Agent Vigil, that an
administrator cannot change a ruleset, that runtime permissions match files in
the repository, or that every detector works. Those controls need separate
evidence. Run Control Proof on a schedule and after changing Agent Vigil,
workflow policy, or agent configuration.

## GitHub Action

The Action can run the same proof on demand or on a schedule:

```yaml
- id: control-proof
  uses: sulmusic2-star/agent-vigil@<reviewed-full-commit>
  with:
    mode: prove
    attest: true
    repo: .
    head: ${{ github.sha }}
```

`attest: true` uses GitHub's short-lived OIDC identity and Sigstore-backed
artifact attestation. No repository signing secret is created. Retain
`steps.control-proof.outputs.report` and
`steps.control-proof.outputs.attestation-bundle` as artifacts. `HOLD` exits 2,
so an unexpected decision or cleanup error fails the job.

Install the weekly and manual workflow:

```bash
vigil certify install-action \
  --repo . \
  --action-ref <reviewed-full-Agent-Vigil-commit>
```

The installer creates `.github/workflows/agent-vigil-control-proof.yml`. It
does not replace an existing file unless `--force` is supplied. The generated
workflow has read-only repository permission plus the three GitHub permissions
needed for attestation, pins all Actions to full commits, does not retain
checkout credentials, and keeps the proof and attestation bundle for 90 days.

Verify one downloaded proof:

```bash
vigil verify-control-attestation control-proof.json \
  --repository OWNER/REPOSITORY \
  --signer-workflow OWNER/REPOSITORY/.github/workflows/agent-vigil-control-proof.yml
```

Add `--signer-digest <full-workflow-commit>` when the signer is a separately
controlled reusable workflow. Verification also pins the proof's source commit
with GitHub CLI's `--source-digest` check and rejects self-hosted runners unless
the verifier explicitly supplies `--allow-self-hosted`.

The attestation establishes which GitHub workflow signed the file. The workflow
can still choose what it signs. Protect the signing workflow from ordinary
candidate changes, or move signing into a separately controlled reusable
workflow and pin that workflow with `--signer-digest`, before treating this as
independent approval.

GitHub documents artifact attestations as available to public repositories on
current plans; private and internal repository use requires GitHub Enterprise
Cloud, and GitHub Enterprise Server is not supported. See
[GitHub's artifact-attestation documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
and the
[`gh attestation verify` trust options](https://cli.github.com/manual/gh_attestation_verify).

The proof feature ships in `v0.15.0`. Keyless proof attestation and the
installer are unreleased until their branch is merged and tagged.

## Seven-day certification status

`vigil certify` turns individual proofs into a private, chain-hashed JSONL
corpus. An organization-owned policy lists its repositories, required check,
allowed control, required planted challenges, and maximum proof age.

```bash
vigil certify record proof.json --organization acme --repository acme/api --required-check "Agent Vigil evidence" --output api-certificate.json
vigil certify add api-certificate.json --corpus acme-control-corpus.jsonl
vigil certify policy --organization acme --repository acme/api --required-check "Agent Vigil evidence" --pack authority --output acme-control-policy.json
vigil certify status --corpus acme-control-corpus.jsonl --policy acme-control-policy.json
```

The default window is 168 hours. Each repository is reported as `FRESH`,
`STALE`, `MISSING`, or `HOLD`; the organization receives `PASS` only when every
listed repository is fresh. The `baseline` pack requires the clean control,
skipped-test block, and cleanup check. The `authority` pack requires all seven
v0.15 challenges.

Corpus entries bind the prior entry hash and reject altered history, duplicate
certificates, inconsistent proof decisions, and control-identity spoofing. Use
one corpus writer at a time and retain the file in organization-controlled
storage. The current adapter verifies Agent Vigil receipt structure and content
hashes. It does not establish who ran the proof, verify a live GitHub ruleset,
or turn local evidence into external adoption.

The repository's `Weekly control proof` workflow runs the authority pack every
Monday and retains its proof, certificate, policy, corpus entry, and status for
90 days. Each run is a self-contained dogfood bundle. Organizations that need a
single historical ledger should append those certificates to durable,
access-controlled corpus storage. The four V1 JSON schemas in `docs/` define
the original interchange contract; unsupported adapters remain fail-closed.

## Signed proofs from other controls

The signed challenge format lets another control report the same small set of
facts without asking Agent Vigil to understand that control's private receipt:

```bash
vigil certify sign proof-payload.json --private-key provider-private.pem --output signed-proof.json
vigil certify record-signed signed-proof.json --public-key provider-public.pem --organization acme --repository acme/api --required-check "Required AI control" --output signed-certificate.json
vigil certify add signed-certificate.json --corpus acme-control-corpus.jsonl
```

The payload names the control, exact source commit, generation time, challenge
decisions, evidence hashes, and stated limits. `record-signed` refuses a signer
that does not match the separately supplied Ed25519 public key. Organization
policies pin the V2 identity as `vendor/product@sha256:...`. A replacement key gets a
different identity and remains on `HOLD` until the organization changes policy.

V1 and V2 entries may share one chain. New readers validate both; V1 files and
hashes are unchanged. The public contracts are
`signed-control-proof-v1.schema.json`, `control-certificate-v2.schema.json`,
and `control-corpus-entry-v2.schema.json`.

This verifies structure, content integrity, signer identity, required challenge
results, and freshness. It does not independently prove a vendor's private
evidence, make the signer trustworthy, or show that a check is required by a
live repository ruleset.

## What keyless signing changes

Keyless signing removes private-key creation, storage, rotation, and recovery
from the installation. GitHub's certificate supplies the repository and
workflow identity, while the custom predicate binds the exact source commit and
control-proof decision. Agent Vigil checks both the signed subject digest and
the proof's own content hash.

It does not create outside adoption. A workflow installed only in an Agent
Vigil-owned repository remains first-party product evidence. An external
repository must voluntarily install and run it before the public adoption
ledger can count that repository.
