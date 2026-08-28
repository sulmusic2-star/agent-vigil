# Public PR Receipt

`vigil pr-receipt` observes one public GitHub pull request without changing the
target repository:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz pr-receipt \
  https://github.com/OWNER/REPOSITORY/pull/123 \
  --tool-ref <reviewed-full-Agent-Vigil-commit> \
  --signing-key operator-private.pem \
  --output pr-123.receipt.json
```

The command is intended for the first review conversation, where a repository
owner is willing to inspect a receipt but will not accept an external workflow
commit.

## Network and permission boundary

The pull-request URL parser accepts only an uncredentialed
`https://github.com/<owner>/<repo>/pull/<number>` URL. All network requests go
to fixed `api.github.com` REST endpoints. They are `GET` requests for:

- pull-request metadata;
- formal reviews;
- check-run metadata; and
- legacy commit-status metadata.

The command does not fetch source files or diff contents. It sends no request
body. The normalized receipt retains source-response hashes, byte counts,
status codes, completeness markers, decision counts, exact commit SHAs, and
timestamps. It does not retain response bodies, check logs, review text,
prompts, transcripts, source code, or a GitHub token.

The target repository grants no permission. No workflow, branch, comment,
check, deployment, or other repository write is created.

## Tool and signer identity

`--tool-ref` is required and accepts only a full lowercase Git commit SHA. A
tag or branch cannot identify the verifier used for a receipt.

`--signing-key` is optional. When present, Agent Vigil reads a local
customer-controlled Ed25519 private key, signs only the normalized receipt
hash, and emits the public key plus its SHA-256 key ID. The private key and its
path are not retained or printed. Without the option, the receipt has content
integrity but no signer identity.

GitHub-hosted keyless signing remains a separate mode. This command does not
pretend a local run has GitHub OIDC identity.

## Decision contract

| State | Bounded meaning |
|---|---|
| `CURRENT` | GitHub currently shows a merge, at least one effective formal approval, and completed non-failing selected checks within the freshness window. |
| `HOLD` | Merge, approval, selected check evidence, or source coverage is missing, pending, failing, unknown, or incomplete. |
| `EXPIRED` | The otherwise-current evidence is older than `--max-age-hours`. |
| `REVOKED` | A formal approval exists, but the pull request was later closed without being merged. |

Later reviews by the same account supersede earlier reviews for the decision.
Secondary endpoint errors and incomplete pagination become visible coverage
gaps and `HOLD`; they are not silently dropped.

The alpha does not yet establish required branch-protection checks, effective
deployment permissions, incident linkage, or a complete successor-event
history for a merged change. Use Agent Vigil Continuity with authenticated
repository-owned evidence for those controls.

## Execution is not sufficiency

Every receipt contains this boundary:

> This receipt attests that selected public GitHub events and checks were
> observed. It does not establish that the checks were sufficient, that the
> change is safe, or that deployment is authorized.

Accordingly, `allowsProtectedAction` is always `false` in this public,
read-only alpha—even for `CURRENT`. A repository owner must bind a trusted
policy and an authorization surface before using evidence for deployment.

## Verification

The JSON receipt contains a canonical SHA-256 `receiptHash`. A signed receipt
also contains the Ed25519 algorithm, public key, key ID, and signature. Any
change to the normalized receipt invalidates the content hash and signature.

Verify a saved receipt locally without network access:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz pr-receipt verify pr-123.receipt.json
```

Verification returns `VALID` only when the content hash is valid and, if a
signature is present, the Ed25519 signature and embedded key ID are valid. An
unsigned receipt can pass content-integrity verification, but its signer
remains unpinned. Verification does not change the receipt's bounded claim or
authorize a protected action.

The public contract is
[`public-pr-receipt-v1.schema.json`](public-pr-receipt-v1.schema.json).

Report an outside trial through the
[public receipt feedback form](https://github.com/sulmusic2-star/agent-vigil/issues/new?template=public-pr-receipt-feedback.yml).
The form asks for the version, exit code, and receipt hash. It asks users not
to include credentials, source, prompts, transcripts, review text, or logs.
