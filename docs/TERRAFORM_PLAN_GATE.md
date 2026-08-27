# Terraform saved-plan gate

`vigil continuity terraform-plan-gate` verifies a short-lived Continuity Staple
before it asks Terraform to inspect a saved plan. It never runs `terraform
apply`.

```bash
terraform plan -out=tfplan

vigil continuity terraform-plan-gate tfplan \
  --staple continuity-staple.json \
  --terraform-executable "$(command -v terraform)" \
  --public-key continuity-authority-public.pem \
  --expected-receipt-hash "$EXPECTED_RECEIPT_HASH" \
  --expected-head "$EXPECTED_HEAD" \
  --environment production \
  --expected-policy-sha256 "$EXPECTED_POLICY_SHA256" \
  --expected-chain-tip "$EXPECTED_CHAIN_TIP" \
  --minimum-sequence "$MINIMUM_SEQUENCE" \
  --output terraform-plan-authorization.json
```

The gate verifies the staple before invoking Terraform. `HOLD`, `EXPIRED`,
`REVOKED`, or invalid signed evidence therefore stops before `terraform show`.
For `CURRENT`, it:

- refuses a symbolic, empty, oversized, or changing saved plan;
- hashes the exact plan and Terraform executable;
- runs `terraform show -json -no-color` without a shell;
- removes inherited `TF_CLI_ARGS*` overrides;
- accepts only the supported version and action shapes;
- retains counts, versions, and hashes, not raw plan values; and
- rechecks both the plan and executable after inspection.

An allowed result binds the exact plan hash. The trusted apply job must
recompute that hash and apply that exact saved plan immediately. A different or
later plan requires a new gate result. The result is not a signed deployment
permit, does not make network calls itself, and does not prove that the planned
infrastructure is safe.
