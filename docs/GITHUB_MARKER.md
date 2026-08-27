# GitHub continuity marker

The continuity marker is the smallest safe GitHub installation for Agent
Vigil's post-merge authorization model. It creates one harmless file in the
temporary runner directory only when a short-lived Continuity Staple is:

- signed by the pinned Ed25519 authority;
- fresh;
- `CURRENT`;
- bound to the exact reviewed head, original receipt, policy, environment,
  chain tip, and minimum accepted sequence supplied by the workflow.

`HOLD`, `EXPIRED`, `REVOKED`, a malformed staple, a wrong key, or a binding
mismatch stops the job and does not create the marker.

## Five-minute installation drill

1. Copy `examples/github/continuity-marker-smoke.yml` to
   `.github/workflows/agent-vigil-continuity-marker-smoke.yml` in a test
   repository.
2. Replace `REPLACE_WITH_EXACT_COMMIT` with an exact reviewed Agent Vigil
   commit. Do not use a moving tag or branch.
3. Run **Agent Vigil continuity marker smoke** from the Actions tab.
4. Confirm the summary reports `PUBLIC_VECTOR_PASS` and the final step sees the
   harmless `SELF_TEST_PASS` marker.
5. Delete the copied workflow to remove the drill.

The smoke workflow uses Agent Vigil's public test key, a fixed reference time,
and a signed test vector. The action permits this mode only on a manual
`workflow_dispatch` run and reports `SELF_TEST_PASS`, never `CURRENT`. It proves
installation and runner compatibility only. It cannot authorize a real
deployment.

## Production wiring

Use `sulmusic2-star/agent-vigil/github-marker@<exact-commit>` from a trusted
workflow. Supply a newly downloaded staple, your own pinned public key, and
trusted bindings. The marker action:

- refuses `pull_request` because candidate workflow code is not trusted;
- binds `pull_request_target`, `merge_group`, and `workflow_run` to the head in
  the GitHub event payload;
- never checks out or executes candidate repository code;
- performs no network call;
- writes its decision and marker only beneath `RUNNER_TEMP`; and
- emits one stable reason code and one short sentence.

For forked pull requests, keep the workflow on the protected default branch,
download only an independently signed staple, grant no write token, and never
checkout or run the fork. For merge queues, pass the merge-group head rather
than the pull-request head.

The job that uses the marker must be separate from any untrusted build job. A
marker disappears with the runner and does not become durable deployment
permission. A real protected action must verify a newly issued staple in the
same trusted job immediately before acting.

## Removal

Remove the workflow step or delete the copied smoke workflow. The action
creates no repository file, service, webhook, application installation, or
long-lived credential.
