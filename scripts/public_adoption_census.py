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
        if owner not in EXCLUDED_OWNERS and WORKFLOW_RE.match(path) and ACTION_RE.search(content):
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
    for row in source.get("references", []):
        repository = str(row.get("repository", ""))
        path = str(row.get("path", ""))
        content = str(row.get("content", ""))
        owner = repository.split("/", 1)[0].lower() if "/" in repository else ""
        external = owner not in EXCLUDED_OWNERS
        workflow = bool(WORKFLOW_RE.match(path))
        exact_action_use = bool(ACTION_RE.search(content))
        state = "configured" if external and workflow and exact_action_use else "reference-only"
        references.append({
            "repository": repository,
            "path": path,
            "external": external,
            "state": state,
            "workflow_runs": row.get("workflow_runs"),
        })
        if state == "configured":
            configured.setdefault(repository, {"paths": [], "workflow_runs_observed": 0, "workflow_runs_unknown": False})
            configured[repository]["paths"].append(path)
            runs = row.get("workflow_runs")
            if runs is None:
                configured[repository]["workflow_runs_unknown"] = True
            else:
                configured[repository]["workflow_runs_observed"] += int(runs)
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
    return {
        "schema_version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "measurement_contract": {
            "reference_only_is_adoption": False,
            "configured_requires_public_workflow_uses_step": True,
            "receipt_count_is_current_public_artifact_inventory_not_lifetime_telemetry": True,
            "required_check_detection": "not observable from the public code-search census",
        },
        "counts": {
            "external_repositories_configured": len(configured),
            "external_repositories_with_workflow_runs_observed": run_observed,
            "currently_listed_external_receipt_artifacts": artifact_count,
            "repositories_with_unknown_artifact_count": len(artifact_unknown),
        },
        "configured_repositories": configured,
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
