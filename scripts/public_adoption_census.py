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


def calendar_date(value: str, label: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} must be YYYY-MM-DD") from error


def gh_json(endpoint: str, fields: dict[str, str] | None = None) -> dict[str, Any]:
    command = ["gh", "api", "-X", "GET", endpoint]
    for key, value in (fields or {}).items():
        command.extend(["-f", f"{key}={value}"])
    completed = subprocess.run(command, check=True, text=True, capture_output=True)
    return json.loads(completed.stdout)


def workflow_run_evidence(
    full_name: str,
    workflow_name: str,
    window_start: dt.date | None = None,
    window_end: dt.date | None = None,
) -> dict[str, Any]:
    endpoint = f"repos/{full_name}/actions/workflows/{quote(workflow_name)}/runs"
    fields = {"per_page": "100", "page": "1"}
    if window_start is not None and window_end is not None:
        fields["created"] = f"{window_start.isoformat()}..{window_end.isoformat()}"
    newest = gh_json(endpoint, fields)
    total = int(newest.get("total_count", 0))
    newest_runs = newest.get("workflow_runs", []) if isinstance(newest.get("workflow_runs"), list) else []
    oldest_runs = newest_runs
    if total > 100:
        last_page = (total + 99) // 100
        oldest_fields = {**fields, "page": str(last_page)}
        oldest = gh_json(endpoint, oldest_fields)
        oldest_runs = oldest.get("workflow_runs", []) if isinstance(oldest.get("workflow_runs"), list) else []
    sampled = newest_runs + ([] if oldest_runs is newest_runs else oldest_runs)
    timestamps = sorted({str(run.get("created_at")) for run in sampled if run.get("created_at")})
    days = sorted({value[:10] for value in timestamps})
    return {
        "total_count": total,
        "first_observed_at": timestamps[0] if timestamps else None,
        "last_observed_at": timestamps[-1] if timestamps else None,
        "distinct_run_days_sampled": len(days),
        "sample_complete": total <= 100,
        "run_window_start": window_start.isoformat() if window_start is not None else None,
        "run_window_end": window_end.isoformat() if window_end is not None else None,
    }


def live_input(window_start: dt.date | None = None, window_end: dt.date | None = None) -> dict[str, Any]:
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
                evidence = workflow_run_evidence(full_name, workflow_name, window_start, window_end)
                row["workflow_runs"] = evidence["total_count"]
                row["workflow_run_evidence"] = evidence
            except subprocess.CalledProcessError:
                row["workflow_runs"] = None
                row["workflow_run_evidence"] = None
        rows.append(row)
    artifacts: dict[str, int | None] = {}
    for full_name in sorted(repos):
        try:
            response = gh_json(f"repos/{full_name}/actions/artifacts", {"name": "agent-vigil-receipt", "per_page": "1"})
            artifacts[full_name] = int(response.get("total_count", 0))
        except subprocess.CalledProcessError:
            artifacts[full_name] = None
    return {"references": rows, "receipt_artifacts": artifacts}


def classify(
    source: dict[str, Any],
    window_start: dt.date | None = None,
    window_end: dt.date | None = None,
) -> dict[str, Any]:
    references: list[dict[str, Any]] = []
    configured: dict[str, dict[str, Any]] = {}
    continuity_gates: set[str] = set()
    exact_action_repositories: set[str] = set()
    lab_repositories: dict[str, dict[str, Any]] = {}
    keyless_control_proof_repositories: dict[str, dict[str, Any]] = {}

    def merge_run_evidence(target: dict[str, Any], row: dict[str, Any]) -> None:
        evidence = row.get("workflow_run_evidence")
        if not isinstance(evidence, dict):
            return
        first = evidence.get("first_observed_at")
        last = evidence.get("last_observed_at")
        if isinstance(first, str):
            current = target.get("first_run_observed_at")
            target["first_run_observed_at"] = min(current, first) if isinstance(current, str) else first
        if isinstance(last, str):
            current = target.get("last_run_observed_at")
            target["last_run_observed_at"] = max(current, last) if isinstance(current, str) else last
        distinct = evidence.get("distinct_run_days_sampled")
        if isinstance(distinct, int) and not isinstance(distinct, bool):
            target["distinct_run_days_sampled"] = max(target.get("distinct_run_days_sampled", 0), distinct)
        sample_complete = evidence.get("sample_complete") is True
        current_complete = target.get("run_sample_complete")
        target["run_sample_complete"] = sample_complete if current_complete is None else bool(current_complete and sample_complete)
    for raw_row in source.get("references", []):
        row = dict(raw_row)
        timestamps = row.get("workflow_run_timestamps")
        if window_start is not None and window_end is not None and isinstance(timestamps, list):
            bounded = sorted({
                value for value in timestamps
                if isinstance(value, str) and window_start.isoformat() <= value[:10] <= window_end.isoformat()
            })
            row["workflow_runs"] = len(bounded)
            row["workflow_run_evidence"] = {
                "total_count": len(bounded),
                "first_observed_at": bounded[0] if bounded else None,
                "last_observed_at": bounded[-1] if bounded else None,
                "distinct_run_days_sampled": len({value[:10] for value in bounded}),
                "sample_complete": True,
                "run_window_start": window_start.isoformat(),
                "run_window_end": window_end.isoformat(),
            }
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
            configured.setdefault(repository, {"paths": [], "workflow_runs_observed": 0, "workflow_runs_unknown": False, "run_sample_complete": None})
            configured[repository]["paths"].append(path)
            runs = row.get("workflow_runs")
            if runs is None:
                configured[repository]["workflow_runs_unknown"] = True
            else:
                configured[repository]["workflow_runs_observed"] += int(runs)
            merge_run_evidence(configured[repository], row)
            if exact_commit_use:
                exact_action_repositories.add(repository)
            if continuity_gate:
                continuity_gates.add(repository)
            if keyless_control_proof:
                keyless_control_proof_repositories.setdefault(repository, {"paths": [], "workflow_runs_observed": 0, "workflow_runs_unknown": False, "run_sample_complete": None})
                keyless_control_proof_repositories[repository]["paths"].append(path)
                if runs is None:
                    keyless_control_proof_repositories[repository]["workflow_runs_unknown"] = True
                else:
                    keyless_control_proof_repositories[repository]["workflow_runs_observed"] += int(runs)
                merge_run_evidence(keyless_control_proof_repositories[repository], row)
        elif state == "continuity-lab":
            lab_repositories.setdefault(repository, {"paths": [], "workflow_runs_observed": 0, "workflow_runs_unknown": False, "run_sample_complete": None})
            lab_repositories[repository]["paths"].append(path)
            runs = row.get("workflow_runs")
            if runs is None:
                lab_repositories[repository]["workflow_runs_unknown"] = True
            else:
                lab_repositories[repository]["workflow_runs_observed"] += int(runs)
            merge_run_evidence(lab_repositories[repository], row)
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
    thirty_day_activity = 0
    for value in configured.values():
        first = value.get("first_run_observed_at")
        last = value.get("last_run_observed_at")
        span = None
        if isinstance(first, str) and isinstance(last, str):
            try:
                start = dt.datetime.fromisoformat(first.replace("Z", "+00:00"))
                end = dt.datetime.fromisoformat(last.replace("Z", "+00:00"))
                span = max(0, (end - start).days)
            except ValueError:
                value["workflow_runs_unknown"] = True
        value["observed_activity_span_days"] = span
        if span is not None and span >= 30:
            thirty_day_activity += 1
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
            "thirty_day_activity_span_is_public_run_timing_not_maintainer_confirmed_retention": True,
            "keyless_control_proof_is_signed_product_evidence_not_required_check_or_adoption_by_itself": True,
            "workflow_run_window": {
                "start": window_start.isoformat() if window_start is not None else None,
                "end": window_end.isoformat() if window_end is not None else None,
                "inclusive": window_start is not None,
            },
        },
        "counts": {
            "external_repositories_configured": len(configured),
            "external_repositories_with_workflow_runs_observed": run_observed,
            "currently_listed_external_receipt_artifacts": artifact_count,
            "repositories_with_unknown_artifact_count": len(artifact_unknown),
            "external_repositories_using_exact_commit_action": len(exact_action_repositories),
            "external_repositories_with_continuity_gate": len(continuity_gates),
            "external_repositories_with_repeat_workflow_runs": repeat_action,
            "external_repositories_with_30_day_activity_span": thirty_day_activity,
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
    parser.add_argument("--run-window-start")
    parser.add_argument("--run-window-end")
    args = parser.parse_args()
    if bool(args.run_window_start) != bool(args.run_window_end):
        parser.error("--run-window-start and --run-window-end must be provided together")
    try:
        window_start = calendar_date(args.run_window_start, "--run-window-start") if args.run_window_start else None
        window_end = calendar_date(args.run_window_end, "--run-window-end") if args.run_window_end else None
    except ValueError as error:
        parser.error(str(error))
    if window_start is not None and window_end is not None and window_end < window_start:
        parser.error("--run-window-end must not precede --run-window-start")
    source = json.loads(args.fixture.read_text()) if args.fixture else live_input(window_start, window_end)
    result = classify(source, window_start, window_end)
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
