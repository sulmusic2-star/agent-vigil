#!/usr/bin/env python3
"""Deploy, measure, and remove the disposable Agent Vigil admission lab."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import pathlib
import shutil
import statistics
import subprocess
import tempfile
import time
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
K3S_IMAGE = "rancher/k3s@sha256:728a3d3b688ce0755ddd084d73941a54478bae02c3232b2852b6757f3b884dcb"
NODE_IMAGE = "docker.io/library/node:22-alpine"
NODE_SOURCE_REFERENCE = "node:22-alpine"
NODE_TEMPORARY_REFERENCE = "agent-vigil-node-cache:22-alpine"
CONTROL_NAMESPACE = "agent-vigil-system"
TARGET_NAMESPACE = "agent-vigil-admission-lab"
WEBHOOK_NAME = "agent-vigil-continuity"
SERVICE_NAME = "agent-vigil-continuity"


def command(args: list[str], *, input_text: str | None = None, check: bool = True, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, input=input_text, text=True, capture_output=True, check=check, timeout=timeout)


def docker(*args: str, **kwargs: Any) -> subprocess.CompletedProcess[str]:
    return command(["docker", *args], **kwargs)


def kubectl(container: str, *args: str, input_value: dict[str, Any] | None = None, check: bool = True, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return command(
        ["docker", "exec", "-i", container, "kubectl", *args],
        input_text=None if input_value is None else json.dumps(input_value),
        check=check,
        timeout=timeout,
    )


def apply(container: str, value: dict[str, Any]) -> None:
    kubectl(container, "apply", "-f", "-", input_value=value)


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))]


def summary(values: list[float]) -> dict[str, float | int]:
    return {
        "samples": len(values),
        "minimum": round(min(values), 4),
        "median": round(statistics.median(values), 4),
        "mean": round(statistics.fmean(values), 4),
        "p95": round(percentile(values, 0.95), 4),
        "p99": round(percentile(values, 0.99), 4),
        "maximum": round(max(values), 4),
    }


def namespace(name: str, labels: dict[str, str] | None = None) -> dict[str, Any]:
    return {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": name, "labels": labels or {}}}


def config_map(files: dict[str, pathlib.Path]) -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": SERVICE_NAME, "namespace": CONTROL_NAMESPACE},
        "binaryData": {name: b64(path.read_bytes()) for name, path in files.items()},
    }


def deployment() -> dict[str, Any]:
    labels = {"app": SERVICE_NAME}
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": SERVICE_NAME, "namespace": CONTROL_NAMESPACE},
        "spec": {
            "replicas": 2,
            "selector": {"matchLabels": labels},
            "template": {
                "metadata": {"labels": labels},
                "spec": {
                    "automountServiceAccountToken": False,
                    "securityContext": {"runAsNonRoot": True, "runAsUser": 1000, "runAsGroup": 1000, "fsGroup": 1000, "seccompProfile": {"type": "RuntimeDefault"}},
                    "containers": [{
                        "name": "verifier",
                        "image": NODE_IMAGE,
                        "imagePullPolicy": "Never",
                        "command": ["node", "/app/server.mjs"],
                        "ports": [{"name": "https", "containerPort": 8443}],
                        "env": [
                            {"name": "BINDINGS_PATH", "value": "/app/bindings.json"},
                            {"name": "PUBLIC_KEY_PATH", "value": "/app/authority-public.pem"},
                            {"name": "TLS_CERT_PATH", "value": "/tls/tls.crt"},
                            {"name": "TLS_KEY_PATH", "value": "/tls/tls.key"},
                        ],
                        "readinessProbe": {"httpGet": {"scheme": "HTTPS", "path": "/healthz", "port": "https"}, "periodSeconds": 1, "timeoutSeconds": 1},
                        "livenessProbe": {"httpGet": {"scheme": "HTTPS", "path": "/healthz", "port": "https"}, "periodSeconds": 5, "timeoutSeconds": 1},
                        "resources": {"requests": {"cpu": "10m", "memory": "32Mi"}, "limits": {"cpu": "250m", "memory": "128Mi"}},
                        "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                        "volumeMounts": [
                            {"name": "app", "mountPath": "/app", "readOnly": True},
                            {"name": "tls", "mountPath": "/tls", "readOnly": True},
                        ],
                    }],
                    "volumes": [
                        {"name": "app", "configMap": {"name": SERVICE_NAME, "defaultMode": 0o444}},
                        {"name": "tls", "secret": {"secretName": f"{SERVICE_NAME}-tls", "defaultMode": 0o440}},
                    ],
                },
            },
        },
    }


def service() -> dict[str, Any]:
    return {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {"name": SERVICE_NAME, "namespace": CONTROL_NAMESPACE},
        "spec": {"selector": {"app": SERVICE_NAME}, "ports": [{"name": "https", "port": 443, "targetPort": "https"}]},
    }


def deny_verifier_egress() -> dict[str, Any]:
    return {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": "deny-verifier-egress", "namespace": CONTROL_NAMESPACE},
        "spec": {
            "podSelector": {"matchLabels": {"app": SERVICE_NAME}},
            "policyTypes": ["Egress"],
            "egress": [],
        },
    }


def webhook(ca: bytes) -> dict[str, Any]:
    return {
        "apiVersion": "admissionregistration.k8s.io/v1",
        "kind": "ValidatingWebhookConfiguration",
        "metadata": {"name": WEBHOOK_NAME},
        "webhooks": [{
            "name": "continuity.agent-vigil.dev",
            "admissionReviewVersions": ["v1"],
            "sideEffects": "None",
            "failurePolicy": "Fail",
            "matchPolicy": "Equivalent",
            "timeoutSeconds": 1,
            "namespaceSelector": {"matchExpressions": [{"key": "agent-vigil.dev/control-plane", "operator": "DoesNotExist"}]},
            "clientConfig": {"service": {"namespace": CONTROL_NAMESPACE, "name": SERVICE_NAME, "path": "/validate", "port": 443}, "caBundle": b64(ca)},
            "rules": [{"operations": ["CREATE", "UPDATE"], "apiGroups": ["apps"], "apiVersions": ["v1"], "resources": ["deployments"], "scope": "Namespaced"}],
        }],
    }


def test_deployment(encoded_staple: str | None) -> dict[str, Any]:
    annotations = {} if encoded_staple is None else {"agent-vigil.dev/continuity-staple": encoded_staple}
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"generateName": "admission-canary-", "namespace": TARGET_NAMESPACE, "annotations": annotations},
        "spec": {"replicas": 0, "selector": {"matchLabels": {"app": "admission-canary"}}, "template": {"metadata": {"labels": {"app": "admission-canary"}}, "spec": {"containers": [{"name": "canary", "image": "registry.invalid/never-pulled:fixture"}]}}},
    }


def run_case(container: str, value: dict[str, Any]) -> tuple[int, str, float]:
    started = time.perf_counter()
    result = kubectl(container, "create", "--dry-run=server", "-f", "-", "-o", "name", input_value=value, check=False, timeout=30)
    return result.returncode, result.stderr, (time.perf_counter() - started) * 1000


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", default=str(ROOT / "benchmarks/kubernetes-admission-protocol-v1.json"))
    parser.add_argument("--output", default=str(ROOT / "benchmarks/kubernetes-admission-result-v1.json"))
    parser.add_argument("--enforce", action="store_true")
    args = parser.parse_args()
    protocol = json.loads(pathlib.Path(args.protocol).read_text())
    output = pathlib.Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if not shutil.which("docker") or not shutil.which("openssl"):
        raise RuntimeError("docker and openssl are required")
    if not (ROOT / "dist/continuity-staple.js").is_file():
        raise RuntimeError("run npm run build before the Kubernetes admission lab")

    container = f"agent-vigil-k3s-{int(time.time())}"
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="agent-vigil-kubernetes-admission-"))
    image_preexisting = docker("image", "inspect", K3S_IMAGE, check=False).returncode == 0
    node_temporary_tag_created = False
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "protocol": {"path": str(pathlib.Path(args.protocol).relative_to(ROOT)), "clusterImage": K3S_IMAGE},
        "passed": False,
        "cleanup": {"webhookRemoved": False, "clusterRemoved": False, "newClusterImageRemoved": False},
    }
    try:
        before_free = shutil.disk_usage("/").free
        pull_started = time.perf_counter()
        docker("pull", K3S_IMAGE, timeout=180)
        pull_seconds = time.perf_counter() - pull_started
        cluster_started = time.perf_counter()
        docker(
            "run", "-d", "--name", container, "--privileged", K3S_IMAGE,
            "server", "--disable", "traefik", "--disable", "servicelb", "--disable", "metrics-server", "--disable", "local-storage", "--disable", "coredns",
            timeout=60,
        )
        deadline = time.time() + protocol["budgets"]["clusterReadySecondsMaximum"]
        while time.time() < deadline:
            ready = docker("exec", container, "kubectl", "get", "--raw=/readyz", check=False, timeout=10)
            if ready.returncode == 0 and ready.stdout.strip() == "ok":
                break
            time.sleep(1)
        else:
            raise RuntimeError("disposable Kubernetes API did not become ready")
        cluster_ready_seconds = time.perf_counter() - cluster_started

        import_started = time.perf_counter()
        image_rows = docker("images", "--format", "{{.Repository}}|{{.Tag}}|{{.ID}}").stdout.splitlines()
        node_image_ids = [row.split("|", 2)[2] for row in image_rows if row.startswith("node|22-alpine|")]
        if len(node_image_ids) != 1:
            raise RuntimeError("the cached Node image could not be resolved unambiguously")
        docker("tag", node_image_ids[0], NODE_TEMPORARY_REFERENCE)
        node_temporary_tag_created = True
        saver = subprocess.Popen(["docker", "save", NODE_TEMPORARY_REFERENCE], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert saver.stdout is not None
        importer = subprocess.run(["docker", "exec", "-i", container, "ctr", "images", "import", "-"], stdin=saver.stdout, capture_output=True, timeout=180)
        saver.stdout.close()
        saver_stderr = saver.stderr.read() if saver.stderr else b""
        saver_code = saver.wait(timeout=30)
        if saver_code != 0 or importer.returncode != 0:
            detail = (saver_stderr + importer.stderr).decode("utf8", errors="replace").strip()
            raise RuntimeError(f"cached Node image could not be imported into the disposable cluster: {detail[:300]}")
        tagged = docker(
            "exec", container, "ctr", "images", "tag",
            "docker.io/library/agent-vigil-node-cache:22-alpine", NODE_IMAGE,
            check=False,
        )
        if tagged.returncode != 0:
            raise RuntimeError(f"imported Node image could not be assigned its deployment reference: {tagged.stderr[:300]}")
        image_import_seconds = time.perf_counter() - import_started

        fixture_dir = scratch / "fixture"
        fixture = command([str(ROOT / "node_modules/.bin/tsx"), str(ROOT / "scripts/generate_kubernetes_admission_fixture.ts"), "--output", str(fixture_dir)])
        fixture_summary = json.loads(fixture.stdout)
        cert = scratch / "tls.crt"
        key = scratch / "tls.key"
        dns = f"{SERVICE_NAME}.{CONTROL_NAMESPACE}.svc"
        command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(key), "-out", str(cert), "-subj", f"/CN={dns}", "-addext", f"subjectAltName=DNS:{dns},DNS:{SERVICE_NAME}.{CONTROL_NAMESPACE}.svc.cluster.local"], timeout=30)

        apply(container, namespace(CONTROL_NAMESPACE, {"agent-vigil.dev/control-plane": "true"}))
        apply(container, namespace(TARGET_NAMESPACE))
        apply(container, deny_verifier_egress())
        apply(container, config_map({
            "server.mjs": ROOT / "examples/kubernetes-admission/server.mjs",
            "continuity-staple.mjs": ROOT / "dist/continuity-staple.js",
            "authority-public.pem": fixture_dir / "authority-public.pem",
            "bindings.json": fixture_dir / "bindings.json",
        }))
        apply(container, {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": f"{SERVICE_NAME}-tls", "namespace": CONTROL_NAMESPACE}, "type": "kubernetes.io/tls", "data": {"tls.crt": b64(cert.read_bytes()), "tls.key": b64(key.read_bytes())}})
        apply(container, service())
        verifier_started = time.perf_counter()
        apply(container, deployment())
        kubectl(container, "rollout", "status", f"deployment/{SERVICE_NAME}", "-n", CONTROL_NAMESPACE, "--timeout=180s", timeout=190)
        verifier_ready_seconds = time.perf_counter() - verifier_started
        apply(container, webhook(cert.read_bytes()))

        staples = {name: b64((fixture_dir / f"{name}.staple.json").read_bytes()) for name in ["current", "expired", "revoked", "tampered"]}
        cases: dict[str, dict[str, Any]] = {}
        case_inputs = {
            "fresh_current_allowed": (test_deployment(staples["current"]), True, ""),
            "missing_staple_denied": (test_deployment(None), False, "STAPLE_INVALID"),
            "tampered_staple_denied": (test_deployment(staples["tampered"]), False, "STAPLE_INVALID"),
            "expired_staple_denied": (test_deployment(staples["expired"]), False, "STAPLE_EXPIRED"),
            "revoked_staple_denied": (test_deployment(staples["revoked"]), False, "LATER_EVIDENCE_REVOKED"),
        }
        for name, (payload, expected_allow, expected_reason) in case_inputs.items():
            code, stderr, milliseconds = run_case(container, payload)
            passed = (code == 0) if expected_allow else (code != 0 and expected_reason in stderr)
            cases[name] = {
                "expected": "ALLOW" if expected_allow else "DENY",
                "observedExit": code,
                "observedMessage": stderr.strip()[:300],
                "milliseconds": round(milliseconds, 4),
                "passed": passed,
            }
        result["cases"] = cases

        latency_values: list[float] = []
        for iteration in range(protocol["iterations"]):
            code, stderr, milliseconds = run_case(container, test_deployment(staples["current"]))
            if code != 0:
                raise RuntimeError(f"measured CURRENT admission request {iteration + 1} was denied: {stderr.strip()[:300]}")
            latency_values.append(milliseconds)

        pods = json.loads(kubectl(container, "get", "pods", "-n", CONTROL_NAMESPACE, "-l", f"app={SERVICE_NAME}", "-o", "json").stdout)
        server_values: list[float] = []
        for pod in pods.get("items", []):
            logs = kubectl(container, "logs", pod["metadata"]["name"], "-n", CONTROL_NAMESPACE).stdout
            for line in logs.splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("event") == "admission" and isinstance(entry.get("durationMilliseconds"), (int, float)):
                    server_values.append(float(entry["durationMilliseconds"]))
        if len(server_values) < protocol["iterations"]:
            raise RuntimeError("verifier logs did not contain every measured admission decision")

        end_to_end = summary(latency_values)
        server_latency = summary(server_values)

        outage_started = time.perf_counter()
        kubectl(container, "scale", f"deployment/{SERVICE_NAME}", "--replicas=0", "-n", CONTROL_NAMESPACE)
        kubectl(container, "rollout", "status", f"deployment/{SERVICE_NAME}", "-n", CONTROL_NAMESPACE, "--timeout=60s", timeout=70)
        endpoint_deadline = time.time() + 60
        while time.time() < endpoint_deadline:
            endpoint = json.loads(kubectl(container, "get", "endpoints", SERVICE_NAME, "-n", CONTROL_NAMESPACE, "-o", "json").stdout)
            subsets = endpoint.get("subsets", [])
            remaining = sum(len(item.get("addresses", [])) + len(item.get("notReadyAddresses", [])) for item in subsets)
            remaining_pods = json.loads(kubectl(container, "get", "pods", "-n", CONTROL_NAMESPACE, "-l", f"app={SERVICE_NAME}", "-o", "json").stdout).get("items", [])
            if remaining == 0 and len(remaining_pods) == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("verifier pods or endpoints remained available after the outage drill scaled to zero")
        time.sleep(1.1)
        outage_code, outage_stderr, outage_milliseconds = run_case(container, test_deployment(staples["current"]))
        outage_reason_seen = "failed calling webhook" in outage_stderr or "no endpoints available" in outage_stderr
        cases["verifier_unavailable_denied"] = {
            "expected": "DENY",
            "observedExit": outage_code,
            "observedMessage": outage_stderr.strip()[:300],
            "milliseconds": round(outage_milliseconds, 4),
            "passed": outage_code != 0 and outage_reason_seen,
        }
        outage_total_seconds = time.perf_counter() - outage_started
        budgets = {
            "clusterReadySeconds": {"observed": round(cluster_ready_seconds, 4), "maximum": protocol["budgets"]["clusterReadySecondsMaximum"], "pass": cluster_ready_seconds <= protocol["budgets"]["clusterReadySecondsMaximum"]},
            "verifierReadySeconds": {"observed": round(verifier_ready_seconds, 4), "maximum": protocol["budgets"]["verifierReadySecondsMaximum"], "pass": verifier_ready_seconds <= protocol["budgets"]["verifierReadySecondsMaximum"]},
            "serverP95Milliseconds": {"observed": server_latency["p95"], "maximum": protocol["budgets"]["serverP95MillisecondsMaximum"], "pass": server_latency["p95"] <= protocol["budgets"]["serverP95MillisecondsMaximum"]},
            "endToEndP95Milliseconds": {"observed": end_to_end["p95"], "maximum": protocol["budgets"]["endToEndP95MillisecondsMaximum"], "pass": end_to_end["p95"] <= protocol["budgets"]["endToEndP95MillisecondsMaximum"]},
            "outageDecisionMilliseconds": {"observed": round(outage_milliseconds, 4), "maximum": protocol["budgets"]["outageDecisionMillisecondsMaximum"], "pass": outage_milliseconds <= protocol["budgets"]["outageDecisionMillisecondsMaximum"]},
        }
        result.update({
            "environment": {"dockerServer": docker("version", "--format", "{{.Server.Version}}").stdout.strip(), "nodeImage": NODE_IMAGE, "replicas": len(pods.get("items", [])), "egressPolicy": "DENY"},
            "setup": {"imagePullSeconds": round(pull_seconds, 4), "clusterReadySeconds": round(cluster_ready_seconds, 4), "cachedNodeImportSeconds": round(image_import_seconds, 4), "verifierReadySeconds": round(verifier_ready_seconds, 4), "outageDrillSeconds": round(outage_total_seconds, 4)},
            "fixture": fixture_summary,
            "cases": cases,
            "latencyMilliseconds": {"server": server_latency, "endToEndKubectl": end_to_end},
            "budgets": budgets,
            "disk": {"freeBytesBefore": before_free, "freeBytesBeforeCleanup": shutil.disk_usage("/").free},
            "limits": [
                "This is one maintainer-run single-node disposable k3s measurement on macOS, not an independent or production-cluster benchmark.",
                "The end-to-end measurement includes docker exec and kubectl process overhead.",
                "The lab uses ephemeral synthetic signed evidence and performs server-side dry runs; it does not deploy an application or prove adoption, payment, or revenue.",
            ],
        })
        result["passed"] = all(value["passed"] for value in cases.values()) and all(value["pass"] for value in budgets.values()) and len(pods.get("items", [])) == protocol["verifier"]["replicas"] and fixture_summary.get("privateKeyRetained") is False
    except Exception as error:
        result["error"] = str(error)[:500]
    finally:
        if docker("inspect", container, check=False).returncode == 0:
            deletion = kubectl(container, "delete", "validatingwebhookconfiguration", WEBHOOK_NAME, "--ignore-not-found", check=False, timeout=30)
            result["cleanup"]["webhookRemoved"] = deletion.returncode == 0
            kubectl(container, "delete", "namespace", TARGET_NAMESPACE, CONTROL_NAMESPACE, "--ignore-not-found", "--wait=false", check=False, timeout=30)
            removed = docker("rm", "-f", container, check=False, timeout=60)
            result["cleanup"]["clusterRemoved"] = removed.returncode == 0 and docker("inspect", container, check=False).returncode != 0
        else:
            result["cleanup"]["clusterRemoved"] = True
            result["cleanup"]["webhookRemoved"] = True
        if not image_preexisting:
            removed_image = docker("image", "rm", K3S_IMAGE, check=False, timeout=60)
            result["cleanup"]["newClusterImageRemoved"] = removed_image.returncode == 0 or docker("image", "inspect", K3S_IMAGE, check=False).returncode != 0
        else:
            result["cleanup"]["newClusterImageRemoved"] = False
        if node_temporary_tag_created:
            removed_node_tag = docker("image", "rm", NODE_TEMPORARY_REFERENCE, check=False, timeout=30)
            result["cleanup"]["hostNodeTemporaryTagRemoved"] = removed_node_tag.returncode == 0
        else:
            result["cleanup"]["hostNodeTemporaryTagRemoved"] = True
        result["cleanup"]["scratchRemoved"] = False
        shutil.rmtree(scratch, ignore_errors=True)
        result["cleanup"]["scratchRemoved"] = not scratch.exists()
        result.setdefault("disk", {})["freeBytesAfterCleanup"] = shutil.disk_usage("/").free
        if not all(result["cleanup"].get(name, False) for name in ["webhookRemoved", "clusterRemoved", "scratchRemoved", "hostNodeTemporaryTagRemoved"]):
            result["passed"] = False
        output.write_text(json.dumps(result, indent=2) + "\n")

    print(json.dumps({"passed": result["passed"], "output": str(output), "error": result.get("error"), "cleanup": result["cleanup"]}, indent=2))
    return 1 if args.enforce and not result["passed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
