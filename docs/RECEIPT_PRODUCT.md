# Agent Vigil receipt product surfaces

The v0.23.x direction is simple: detection is the free, copyable layer; the
counterparty-accepted receipt is the product. This file records what is concrete
in the OSS CLI and what still requires external authority.

## Free adoption layer

### `vigil watch`

`vigil watch <transcript> --repo . --base <sha> --head <sha>` creates a standard
receipt-v2 from the final agent summary. The gate checks final-summary claims
against the effect ledger:

- changed paths from the exact Git range;
- parsed tool calls and tool results;
- observed test summaries from tool output;
- optional fresh test command output;
- static integrity checks over the diff.

Blocking stop-event rules include:

- `denominator-shrink-4966` for the 4966/4966 vs 4985/4992 class;
- `verification-bypass` for `|| true`;
- `piped-exit-code` for verifier/deploy pipelines without `pipefail`;
- `ci-workflow-edited` for ordinary receipts that edit CI workflows;
- `test-file-deleted`, `test-skip-added`, `test-count-drop`, `assertion-drop`,
  `test-empty-added`, `test-oracle-constant`, and coverage weakening;
- `stop-event-merge-proof`, `stop-event-npm-proof`, and
  `stop-event-deploy-proof` when the final summary claims a merge, live npm
  publication, or deployment without non-narrative ledger proof.

### `vigil counterweight install`

`vigil counterweight install --owner-repo OWNER/REPO --action-sha <sha>` writes:

- `.github/workflows/agent-vigil-counterweight.yml`;
- `.github/agent-vigil-required-check-ruleset.json`;
- `.github/agent-vigil-apply-ruleset.sh`.

The generated ruleset requires the deterministic Agent Vigil status check on the
default branch. With `--apply`, the CLI calls the GitHub Rulesets API to create
the rule. That action requires repository rules administration authority; the
OSS CLI cannot grant itself that authority.

## Paid-layer-ready local exports

### `vigil vault export`

`vigil vault export <receipt.json> --pack soc2|ssdf|pcaob|finra|insurer|all`
creates deterministic local export packs mapping receipt fields to:

- SOC 2 CC8.1 / CC7.2 change-management evidence;
- SSDF PW.7, PW.8, and PS.3 verification/provenance evidence;
- PCAOB review of AI-generated evidence;
- FINRA 3110 full-chain reconstruction;
- insurer represented-process review.

This is not hosted retention. A real Evidence Vault still needs storage,
retention policy, access control, customer/auditor acceptance, SSO, audit logs,
and deletion/legal-hold semantics.

## Destructive and infra action receipts

### `vigil blast-radius`

`vigil blast-radius --intent intent.json --base <sha> --head <sha>` compares the
pre-action declaration to actual effects. The command reports changed paths,
obvious destructive/infra added lines, and whether effects exceed declared path
scope.

This is deliberately an after-proof layer. It should integrate with pre-action
fences such as `destructive_command_guard`; it does not replace the fence.

Example intent:

```json
{
  "operation": "rotate staging worker",
  "declaredScope": {
    "environment": "staging",
    "paths": ["infra/staging/", "workers/staging/"],
    "services": ["staging-worker"]
  },
  "attestedAt": "2026-09-03T00:00:00.000Z"
}
```

## Moat surfaces

### `vigil taxonomy`

The CLI emits the VIGIL-001… taxonomy:

- VIGIL-001 `oracle-echo`;
- VIGIL-002 `test-surface-shrink`;
- VIGIL-003 `skip-or-focus`;
- VIGIL-004 `verifier-bypass`;
- VIGIL-005 `authority-widening`;
- VIGIL-006 `blast-radius-drift`.

### `vigil corpus signature`

`vigil corpus signature <receipt.json> --model <id> --harness <version>` creates
an opt-in anonymized signature from a receipt. It includes rule IDs, taxonomy
IDs, model/harness labels, first-seen timestamp, and a signature hash. It does
not include transcript text, repository paths, file contents, or tool output.

## Attestation boundary

Existing Agent Vigil attestation commands can create in-toto/Sigstore predicates
from receipts and control proofs. The receipt-product work does not by itself
make every new artifact pass `gh attestation verify`; each artifact still needs
a trusted signing workflow and a repository policy that pins the acceptable
signer/workflow.

## Still blocked by external authority

- npm v0.23.4 is staged but not installable until a maintainer approves the npm
  staged package with 2FA.
- GitHub Marketplace submission requires App/publisher account authority and
  listing submission outside the source tree.
- `counterweight install --apply` requires repository rules administration
  authority in the target repository.
- Evidence Vault is only local export generation until hosted retention and
  access-control infrastructure exists.
- Auditor, insurer, customer, SOX, FINRA, and legal acceptance remain human or
  counterparty review gates.
