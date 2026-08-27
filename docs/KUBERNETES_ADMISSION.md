# Kubernetes admission gate

The disposable admission lab measures whether the same offline Continuity
Staple verifier can make a fail-closed Kubernetes deployment decision without
a Go rewrite or a hosted service.

The lab creates a single-node k3s cluster, runs two verifier replicas behind a
ClusterIP service, installs one validating webhook, submits harmless
server-side dry runs, measures 50 fresh `CURRENT` decisions, removes every
verifier replica to test an outage, and removes the
webhook, namespaces, cluster, temporary image tag, and fixture directory.
The test workloads use zero replicas and an invalid image name, so no
application container starts.

```bash
npm run build
python3 scripts/kubernetes_admission_lab.py --enforce
```

The protocol is fixed in
`benchmarks/kubernetes-admission-protocol-v1.json`. It requires:

- two ready verifier replicas;
- `failurePolicy: Fail` and a one-second webhook timeout;
- no network call during a decision and a default-deny verifier egress policy;
- `CURRENT` allowed;
- missing, tampered, expired, revoked, and unavailable-verifier cases denied;
- verifier p95 at or below 10 milliseconds; and
- end-to-end p95 at or below 250 milliseconds.

The verifier accepts the signed staple from the
`agent-vigil.dev/continuity-staple` Deployment annotation. It checks the
pinned Ed25519 key and exact receipt, head, environment, policy, chain tip,
and sequence bindings. It logs only the reason code and decision time. The
fixture signing key is deleted before the cluster test begins.

## Measured local result

The 2026-08-26 maintainer run passed all six cases with two ready replicas.
Verifier p95 was 1.2908 ms. End-to-end p95, including `docker exec` and a new
`kubectl` process for every sample, was 134.642 ms. With every verifier replica
removed, the API rejected the deployment dry run in 194.7583 ms. Cleanup
removed the webhook, namespaces, cluster, temporary image tag, cluster image,
and fixture directory.

This is one disposable, single-node macOS measurement. It is not an
independent benchmark, a production-cluster result, an installation, or proof
of demand. The result supports keeping the Node verifier for now. A Go
verifier should be reconsidered only if measured startup, image availability,
or runtime latency blocks a real installation.

## Production work still required

The example server is a measured lab fixture, not a production manifest.
Production use still needs an organization-owned image, separately managed
TLS, pinned configuration delivery, disruption and overload testing, cluster
version coverage, an emergency removal procedure, and a real-host routing
pass. Until those checks exist, deployment remains `HOLD`.
