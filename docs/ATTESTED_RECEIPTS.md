# Attestation boundaries

The Agent Vigil v0.22.0 release keeps signing authority out of
candidate-executing evidence jobs. A signature can prove the origin and
integrity of a file. It does not
prove that candidate code is correct or that a live repository requires the
check.

## Candidate receipts are not signed in the generated job

`vigil init --attest` and `vigil protect --attest` are disabled. They fail
closed because the generated evidence job checks out and executes candidate
repository code. That job receives no OIDC grant, attestation permission,
write permission, or explicit GitHub token input.

Prepare the credential-free evidence workflow from the public release:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz protect
```

If independent candidate-receipt signing is required, place it in a separately
controlled workflow or service that never checks out or runs candidate code.
That signer must independently bind the exact receipt digest, base, head,
policy, repository, and expected evidence source. Agent Vigil v0.22.0 does not
generate that signer.

## Control Proof signing is separate

The non-candidate Control Proof workflow may use GitHub's short-lived OIDC
identity and Sigstore-backed artifact attestation. Its first job runs planted
challenges against the reviewed Agent Vigil runtime without OIDC. A separate
signer job checks out no repository code, accepts only the bounded proof and
predicate artifact, validates their exact binding, and then receives signing
permission. Neither job checks out or executes a pull-request candidate.

```bash
vigil certify install-action \
  --repo . \
  --action-ref <reviewed-full-commit>
```

Verify one downloaded proof with the currently public v0.22.0 GitHub package:

```bash
npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz \
  verify-control-attestation control-proof.json \
  --repository OWNER/REPOSITORY \
  --signer-workflow OWNER/REPOSITORY/.github/workflows/agent-vigil-control-proof.yml
```

Add `--signer-digest <full-workflow-commit>` when the signer is a separately
controlled reusable workflow. The verifier also checks the proof subject,
content hash, exact source commit, repository, and signer identity. Self-hosted
runners are rejected unless the verifier explicitly accepts one.

This signature proves which workflow signed the proof file. It does not prove
that branch protection requires Agent Vigil, that an administrator cannot
change a ruleset, or that the control covers every detector. See
[Control Proof](CONTROL_PROOF.md).

## Existing full-receipt attestation commands

The CLI still understands the v1 full-receipt predicate and can verify an
already signed receipt. Predicate preparation does not sign anything. The public verification command remains pinned to the immutable v0.22.0 GitHub package:

```bash
vigil attest agent-vigil-report.json \
  --predicate-output agent-vigil-attestation-predicate.json

npx --yes https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.22.0/sulmusic-agent-vigil-0.22.0.tgz \
  verify-attestation agent-vigil-report.json \
  --repository OWNER/REPOSITORY \
  --signer-workflow OWNER/REPOSITORY/.github/workflows/separate-receipt-signer.yml
```

Verification asks GitHub CLI to validate the GitHub/Sigstore signature, then
checks the subject digest and privacy-reduced predicate against the receipt's
exact head, Git tree, policy digest, counts, and decision.

The predicate can expose the receipt digest, exact base and head commits,
policy digest, result, evidence counts, Agent Vigil version, and workflow
identity. It omits source, prompts, transcript text, claim text, file paths,
and test output. The schema is
[`ai-change-receipt-predicate-v1.schema.json`](ai-change-receipt-predicate-v1.schema.json).

GitHub warns that predicate data is controlled by the signing workflow. Protect
or externally control that workflow before treating it as independent approval.
See the
[`gh attestation verify` trust options](https://cli.github.com/manual/gh_attestation_verify)
and GitHub's
[artifact-attestation verification guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations).

The complete hosted boundary is in
[Hosted evidence security contract](HOSTED_SECURITY_CONTRACT.md).
