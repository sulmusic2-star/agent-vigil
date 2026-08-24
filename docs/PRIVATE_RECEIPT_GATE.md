# Private transcript, portable receipt, independent gate

This mode keeps the raw coding-agent transcript out of the repository and out
of GitHub Actions. It is designed for repositories that need claim
reconciliation without publishing prompts, source fragments, tool output, or
reasoning traces.

## What crosses the boundary

The committed portable receipt contains:

- SHA-256 identifiers for the full local report, its detailed results, and the
  private transcript;
- exact base commit, code commit, and Git tree;
- canonical trusted-policy hash;
- PASS / FAIL / INCONCLUSIVE counts;
- issuance time; and
- Ed25519 public key, key ID, and signature.

It does not contain transcript text, a transcript path, claim quotes, changed
paths, command output, or detailed rule evidence. Repository names and test
commands may still be visible elsewhere in the repository and workflow.

## Trust split

The local verifier reconciles the private transcript and signs the compact
result. The CI gate then independently verifies:

1. the portable payload hash and signature;
2. the signer key ID against policy loaded from the pull request base commit;
3. the portable policy hash against that same policy;
4. the exact base, code commit, and Git tree;
5. that any commits after the signed code commit change only the configured
   portable receipt path;
6. the trusted policy test command in the clean CI checkout; and
7. verification-weakening and tracked-mutation checks.

This is two-source evidence, not proof of correctness. A signer key available
to the authoring agent is not an independent human attestation. Keep the key
outside the repository and outside the agent's filesystem or tool scope when
that distinction matters. Hardware-backed signing and a hosted App signer are
not implemented.

## One-time setup

Generate an Ed25519 key outside the repository:

```bash
mkdir -p ~/.config/agent-vigil
vigil keygen \
  --private ~/.config/agent-vigil/operator.pem \
  --public ~/.config/agent-vigil/operator.pub
```

`keygen` prints a `sha256:...` key ID. Add it to `.agent-vigil.json`:

```json
{
  "schemaVersion": 1,
  "testCommand": "npm test --silent",
  "strict": true,
  "minVerified": 1,
  "portableReceipt": ".agent-vigil/receipt.json",
  "trustedSignerKeyIds": [
    "sha256:replace-with-keygen-output"
  ]
}
```

Install the Action in receipt mode:

```yaml
name: Agent Vigil
on:
  pull_request:
  merge_group:
    types: [checks_requested]

permissions:
  contents: read

jobs:
  evidence:
    name: Agent Vigil evidence
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
      - uses: sulmusic2-star/agent-vigil@v0.17.0
        with:
          receipt: .agent-vigil/receipt.json
          policy: .agent-vigil.json
          policy-ref: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
          repo: .
          base: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
          head: ${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
```

Merge this setup under ordinary review before requiring the check. The first
setup pull request cannot load a policy that is not yet present in its base.
On a merge queue, Agent Vigil reruns the base-policy tests and integrity checks
against the composed queue head; see [the merge-queue contract](MERGE_QUEUES.md).

## Per-change flow

Commit the code change first. Then run:

```bash
BASE_SHA=$(git merge-base origin/main HEAD)
CODE_SHA=$(git rev-parse HEAD)

vigil /private/path/to/session.jsonl \
  --repo . \
  --base "$BASE_SHA" \
  --head "$CODE_SHA" \
  --policy .agent-vigil.json \
  --policy-ref "$BASE_SHA" \
  --signing-key ~/.config/agent-vigil/operator.pem \
  --portable-output .agent-vigil/receipt.json \
  --strict

git add .agent-vigil/receipt.json
git commit -m "chore: attach Agent Vigil receipt"
git push
```

The final commit is evidence-only. If any other path changes after `CODE_SHA`,
the gate fails and a new receipt is required.

## Local reproduction

```bash
vigil gate .agent-vigil/receipt.json \
  --repo . \
  --base "$BASE_SHA" \
  --head "$(git rev-parse HEAD)" \
  --policy .agent-vigil.json \
  --policy-ref "$BASE_SHA"
```

Exit codes remain `0` PASS, `1` FAIL, and `2` INCONCLUSIVE or configuration
error.
