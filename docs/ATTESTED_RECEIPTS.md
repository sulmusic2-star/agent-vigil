# GitHub-attested receipts

An Agent Vigil receipt records what was checked for one exact code change. A
GitHub attestation lets another person verify that the receipt came from a
specific GitHub Actions run and has not been replaced.

It does not prove that the code is correct. It proves the origin and integrity
of the evidence record.

## Install with attestation enabled

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.19.0/sulmusic-agent-vigil-0.19.0.tgz init --attest
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.19.0/sulmusic-agent-vigil-0.19.0.tgz doctor
```

The generated workflow grants these additional permissions:

```yaml
permissions:
  contents: read
  pull-requests: read
  id-token: write
  attestations: write
  artifact-metadata: write
```

It does not grant write access to repository contents.

Private and internal repository attestations require a GitHub plan that supports
them. Fork pull requests do not receive an attestation because GitHub withholds
the signing permissions from untrusted fork workflows.

## Verify a receipt

Download `agent-vigil-report.json` from the workflow artifact, authenticate the
GitHub CLI, then run:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.19.0/sulmusic-agent-vigil-0.19.0.tgz verify-attestation \
  agent-vigil-report.json \
  --repository OWNER/REPOSITORY
```

Agent Vigil asks `gh attestation verify` to verify the GitHub/Sigstore signature.
It then checks that the signed subject digest and privacy-reduced predicate match
the full receipt, exact head SHA, policy digest, counts, and decision.

By default, verification also requires the signer to be
`OWNER/REPOSITORY/.github/workflows/agent-vigil.yml` and rejects attestations
from self-hosted runners. If the calling workflow has a different path, pin it
explicitly:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.19.0/sulmusic-agent-vigil-0.19.0.tgz verify-attestation \
  agent-vigil-report.json \
  --repository OWNER/REPOSITORY \
  --signer-workflow OWNER/REPOSITORY/.github/workflows/custom-vigil.yml
```

Use `--allow-self-hosted` only when the runner itself is inside your trust
boundary.

## Workflow trust limit

The signed predicate is data supplied by the workflow. A person who can replace
that workflow can sign false data under the same repository name and path.
Review and protect changes under `.github/workflows`. Where that risk is not
acceptable, run signing from a separately controlled reusable workflow. Version
0.12.0 does not include that isolated builder.

GitHub CLI gives the same warning in its
[`gh attestation verify` documentation](https://cli.github.com/manual/gh_attestation_verify):
predicate data is controlled by the workflow, so sensitive policy checks should
pin a trusted signer workflow. Agent Vigil does not describe provenance alone as
proof that code is correct.

## What becomes public

For a public repository, the Sigstore transparency log receives:

- the receipt file digest;
- exact base and head SHAs;
- the policy digest;
- PASS, FAIL, or INCONCLUSIVE;
- evidence counts;
- the Agent Vigil version;
- GitHub's workflow identity.

The predicate does not include source code, prompts, transcript text, claim text,
file paths, or test output. The full receipt remains a GitHub Actions artifact
under the repository's retention policy.

The schema is
[`ai-change-receipt-predicate-v1.schema.json`](ai-change-receipt-predicate-v1.schema.json).

## Prepare the predicate without GitHub Actions

```bash
vigil attest agent-vigil-report.json \
  --predicate-output agent-vigil-attestation-predicate.json
```

This command prepares the custom predicate. It does not sign anything by itself.
Signing is performed by GitHub's official
[`actions/attest`](https://github.com/actions/attest) Action. GitHub's
[verification guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations)
documents the `gh attestation verify` trust check used here.
