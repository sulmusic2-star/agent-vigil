#!/usr/bin/env python3
"""Fail-closed public adoption census for Agent Vigil.

The live mode uses GitHub's authenticated API through `gh`. A code reference is
not counted as an installation. A repository becomes `configured` only when a
public workflow contains an Agent Vigil `uses:` step. A receipt is counted only
when GitHub currently lists an artifact named `agent-vigil-receipt` for that
configured external repository.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import re
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import quote

ACTION_RE = re.compile(r"uses:\s*sulmusic2-star/agent-vigil@[^\s#]+", re.I)
EXACT_ACTION_RE = re.compile(r"uses:\s*sulmusic2-star/agent-vigil@[0-9a-f]{40}(?:\s|#|$)", re.I)
CONTINUITY_MODE_RE = re.compile(r"^\s*mode:\s*['\"]?continuity['\"]?\s*(?:#.*)?$", re.I | re.M)
CONTINUITY_LAB_RE = re.compile(r"agent-vigil-continuity-lab/v1", re.I)
KEYLESS_CONTROL_PROOF_RE = re.compile(r"agent-vigil-keyless-control-proof/v1", re.I)
WORKFLOW_RE = re.compile(r"^\.github/workflows/[^/]+\.ya?ml$", re.I)
EXCLUDED_OWNERS = {"sulmusic2-star"}


def gh_json(endpoint: str, fields: dict[str, str] | None = None) -> dict[str, Any]:
    command = ["gh", "api", "-X", "GET", endpoint]
    for key, value in (fields or {}).items():
        command.extend(["-f", f"{key}={value}"])
    completed = subprocess.run(command, check=True, text=True, capture_output=True)
    return json.loads(completed.stdout)


def live_input() -> dict[str, Any]:
    search = gh_json("search/code", {"q": '"sulmusic2-star/agent-vigil"', "per_page": "100"})
    rows: list[dict[str, Any]] = []
    repos: set[str] = set()
    for item in search.get("items", []):
        full_name = item.get("repository", {}).get("full_name", "")
        path = item.get("path", "")
        if not full_name or not path:
            continue
        content_result = gh_json(f"repos/{full_name}/contents/{quote(path, safe='/')}")
        encoded = content_result.get("content", "")
        try:
            content = base64.b64decode(encoded).decode("utf-8", errors="replace")
        except Exception:
            content = ""
        row: dict[str, Any] = {"repository": full_name, "path": path, "content": content}
        owner = full_name.split("/", 1)[0].lower()
        external_workflow = owner not in EXCLUDED_OWNERS and WORKFLOW_RE.match(path)
        if external_workflow and (ACTION_RE.search(content) or CONTINUITY_LAB_RE.search(content)):
            if ACTION_RE.search(content):
                repos.add(full_name)
            workflow_name = Path(path).name
            try:
                runs = gh_json(f"repos/{full_name}/actions/workflows/{quote(workflow_name)}/runs", {"per_page": "1"})
                row["workflow_runs"] = int(runs.get("total_count", 0))
            except subprocess.CalledProcessError:
                row["workflow_runs"] = None
        rows.append(row)
    artifacts: dict[str, int | None] = {}
    for full_name in sorted(repos):
        try:
            response = gh_json(f"repos/{full_name}/actions/artifacts", {"name": "agent-vigil-receipt", "per_page": "1"})
            artifacts[full_name] = int(response.get("total_count", 0))
        except subprocess.CalledProcessError:
            artifacts[full_name] = None
    return {"references": rows, "receipt_artifacts": artifacts}


def classify(source: dict[str, Any]) -> dict[str, Any]:
    references: list[dict[str, Any]] = []
    configured: dict[str, dict[str, Any]] = {}
    continuity_gates: set[str] = set()
    exact_action_repositories: set[str] = set()
    lab_repositories: dict[str, dict[str, Any]] = {}
    keyless_control_proof_repositories: dict[str, dict[str, Any]] = {}
    for row in source.get("references", []):
        repository = str(row.get("repository", ""))
        path = str(row.get("path", ""))
        content = str(row.get("content", ""))
        owner = repository.split("/", 1)[0].lower() if "/" in repository else ""
        external = owner not in EXCLUDED_OWNERS
        workflow = bool(WORKFLOW_RE.match(path))
        exact_action_use = bool(ACTION_RE.search(content))
        exact_commit_use = bool(EXACT_ACTION_RE.search(content))
        continuity_gate = exact_action_use and bool(CONTINUITY_MODE_RE.search(content))
        continuity_lab = bool(CONTINUITY_LAB_RE.search(content))
        keyless_control_proof = exact_commit_use and bool(KEYLESS_CONTROL_PROOF_RE.search(content))
        state = "configured" if external and workflow and exact_action_use else (
            "continuity-lab" if external and workflow and continuity_lab else "reference-only"
        )
        references.append({
            "repository": repository,
            "path": path,
            "external": external,
            "state": state,
            "workflow_runs": row.get("workflow_runs"),
            "exact_commit_action": exact_commit_use,
            "continuity_gate": continuity_gate,
            "keyless_control_proof": keyless_control_proof,
        })
        if state == "configured":
            configured.setdefault(repository, {"paths": [], "workflow_runs_observed": 0, "workflow_runs_unknown": False})
            configured[repository]["paths"].append(path)
            runs = row.get("workflow_runs")
            if runs is None:
                configured[repository]["workflow_runs_unknown"] = True
            else:
                configured[repository]["workflow_runs_observed"] += int(runs)
            if exact_commit_use:
                exact_action_repositories.add(repository)
            if continuity_gate:
                continuity_gates.add(repository)
            if keyless_control_proof:
                keyless_control_proof_repositories.setdefault(repository, {"paths": [], "workflow_runs_observed": 0, "workflow_runs_unknown": False})
                keyless_control_proof_repositories[repository]["paths"].append(path)
                if runs is None:
                    keyless_control_proof_repositories[repository]["workflow_runs_unknown"] = True
                else:
                    keyless_control_proof_repositories[repository]["workflow_runs_observed"] += int(runs)
        elif state == "continuity-lab":
            lab_repositories.setdefault(repository, {"paths": [], "workflow_runs_observed": 0, "workflow_runs_unknown": False})
            lab_repositories[repository]["paths"].append(path)
            runs = row.get("workflow_runs")
            if runs is None:
                lab_repositories[repository]["workflow_runs_unknown"] = True
            else:
                lab_repositories[repository]["workflow_runs_observed"] += int(runs)
    artifact_source = source.get("receipt_artifacts", {})
    artifact_count = 0
    artifact_unknown: list[str] = []
    for repository in configured:
        count = artifact_source.get(repository)
        configured[repository]["currently_listed_receipt_artifacts"] = count
        if count is None:
            artifact_unknown.append(repository)
        else:
            artifact_count += int(count)
    run_observed = sum(1 for value in configured.values() if value["workflow_runs_observed"] > 0)
    repeat_action = sum(1 for value in configured.values() if value["workflow_runs_observed"] >= 2)
    lab_run_observed = sum(1 for value in lab_repositories.values() if value["workflow_runs_observed"] > 0)
    keyless_proof_run_observed = sum(1 for value in keyless_control_proof_repositories.values() if value["workflow_runs_observed"] > 0)
    return {
        "schema_version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "measurement_contract": {
            "reference_only_is_adoption": False,
            "configured_requires_public_workflow_uses_step": True,
            "receipt_count_is_current_public_artifact_inventory_not_lifetime_telemetry": True,
            "required_check_detection": "not observable from the public code-search census",
            "continuity_lab_is_product_exploration_not_production_adoption": True,
            "repeat_use_means_two_or_more_current_workflow_runs_not_two_distinct_days": True,
            "keyless_control_proof_is_signed_product_evidence_not_required_check_or_adoption_by_itself": True,
        },
        "counts": {
            "external_repositories_configured": len(configured),
            "external_repositories_with_workflow_runs_observed": run_observed,
            "currently_listed_external_receipt_artifacts": artifact_count,
            "repositories_with_unknown_artifact_count": len(artifact_unknown),
            "external_repositories_using_exact_commit_action": len(exact_action_repositories),
            "external_repositories_with_continuity_gate": len(continuity_gates),
            "external_repositories_with_repeat_workflow_runs": repeat_action,
            "external_repositories_with_continuity_lab": len(lab_repositories),
            "external_continuity_labs_with_runs_observed": lab_run_observed,
            "external_repositories_with_keyless_control_proof": len(keyless_control_proof_repositories),
            "external_keyless_control_proofs_with_runs_observed": keyless_proof_run_observed,
        },
        "configured_repositories": configured,
        "continuity_lab_repositories": lab_repositories,
        "keyless_control_proof_repositories": keyless_control_proof_repositories,
        "references": references,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, help="Classify a saved input instead of calling GitHub")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    source = json.loads(args.fixture.read_text()) if args.fixture else live_input()
    result = classify(source)
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
