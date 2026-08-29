#!/usr/bin/env python3
"""Validate consented Agent Vigil adoption evidence and calculate proof gates."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RECEIPT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
EXCLUDED_OWNERS = {"sulmusic2-star"}
ENTRY_FIELDS = {
    "repository", "ownerConsentUrl", "workflowUrl", "latestRunUrl",
    "firstObservedAt", "lastObservedAt", "currentWorkflowConfigured",
    "verdictsObserved", "receiptHashes", "requiredCheckEvidenceUrl",
    "requiredCheckObservedAt", "retentionEvidenceUrl", "maintainerAcceptedContradictions",
    "falseVerdictReports",
}
CONTRADICTION_FIELDS = {"receiptHash", "evidenceUrl", "disposition", "acceptedAt"}
FALSE_VERDICT_FIELDS = {"evidenceUrl", "status", "reportedAt", "resolvedAt"}
CONTRADICTION_DISPOSITIONS = {"fixed-change", "expected-behavior", "policy-decision", "product-defect"}
FALSE_VERDICT_STATUSES = {"resolved-false-verdict", "expected-behavior", "product-defect", "still-open"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def timestamp(value: Any, label: str) -> dt.datetime:
    require(isinstance(value, str), f"{label} must be an ISO-8601 timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} must be an ISO-8601 timestamp") from error
    require(parsed.tzinfo is not None, f"{label} must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def calendar_date(value: str, label: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} must be YYYY-MM-DD") from error


def https_url(value: Any, label: str, *, github: bool = False) -> str:
    require(isinstance(value, str), f"{label} must be an HTTPS URL")
    parsed = urlparse(value)
    require(parsed.scheme == "https" and bool(parsed.netloc), f"{label} must be an HTTPS URL")
    if github:
        require(parsed.netloc.lower() == "github.com", f"{label} must be a github.com URL")
    return value


def github_repository_url(value: Any, label: str, repository: str) -> str:
    url = https_url(value, label, github=True)
    parsed = urlparse(url)
    segments = parsed.path.split("/")
    owner, name = repository.split("/", 1)
    require(
        len(segments) >= 3
        and segments[0] == ""
        and unquote(segments[1]).lower() == owner.lower()
        and unquote(segments[2]).lower() == name.lower(),
        f"{label} must refer to {repository}",
    )
    return url


def nullable_url(value: Any, label: str, repository: str) -> str | None:
    if value is None:
        return None
    return github_repository_url(value, label, repository)


def exact_fields(
    value: Any,
    fields: set[str],
    label: str,
    *,
    optional: set[str] | None = None,
) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be an object")
    missing = fields - (optional or set()) - set(value)
    extra = set(value) - fields
    require(not missing, f"{label} is missing: {', '.join(sorted(missing))}")
    require(not extra, f"{label} has unknown fields: {', '.join(sorted(extra))}")
    return value


def validate(
    ledger: dict[str, Any],
    window_start: dt.date | None = None,
    window_end: dt.date | None = None,
) -> dict[str, Any]:
    exact_fields(ledger, {"schemaVersion", "entries"}, "ledger")
    require(ledger["schemaVersion"] == 1, "ledger schemaVersion must be 1")
    require(isinstance(ledger["entries"], list), "ledger entries must be an array")

    repositories: set[str] = set()
    receipts: set[str] = set()
    contradiction_receipts: set[str] = set()
    retained_repositories: list[str] = []
    required_repositories: list[str] = []
    configured_repositories: list[str] = []
    verdicts_observed = 0
    false_reports = 0
    unexplained_false_reports = 0
    experiment_configured: list[str] = []
    experiment_seven_day: list[str] = []
    experiment_required: list[str] = []
    experiment_contradictions = 0
    window_start_at = (
        dt.datetime.combine(window_start, dt.time.min, tzinfo=dt.timezone.utc)
        if window_start is not None else None
    )
    window_end_after = (
        dt.datetime.combine(window_end + dt.timedelta(days=1), dt.time.min, tzinfo=dt.timezone.utc)
        if window_end is not None else None
    )

    def observed_in_window(value: dt.datetime) -> bool:
        return (
            window_start_at is not None
            and window_end_after is not None
            and window_start_at <= value < window_end_after
        )

    for index, raw_entry in enumerate(ledger["entries"]):
        label = f"entries[{index}]"
        entry = exact_fields(raw_entry, ENTRY_FIELDS, label, optional={"requiredCheckObservedAt"})
        repository = entry["repository"]
        require(isinstance(repository, str) and bool(REPOSITORY_RE.fullmatch(repository)), f"{label}.repository is invalid")
        owner, name = repository.split("/", 1)
        require(owner.lower() not in EXCLUDED_OWNERS, f"{label}.repository is first-party and cannot count")
        require(repository.lower() not in repositories, f"duplicate repository: {repository}")
        repositories.add(repository.lower())

        github_repository_url(entry["ownerConsentUrl"], f"{label}.ownerConsentUrl", repository)
        github_repository_url(entry["workflowUrl"], f"{label}.workflowUrl", repository)
        github_repository_url(entry["latestRunUrl"], f"{label}.latestRunUrl", repository)

        first = timestamp(entry["firstObservedAt"], f"{label}.firstObservedAt")
        last = timestamp(entry["lastObservedAt"], f"{label}.lastObservedAt")
        require(last >= first, f"{label}.lastObservedAt precedes firstObservedAt")
        require(isinstance(entry["currentWorkflowConfigured"], bool), f"{label}.currentWorkflowConfigured must be boolean")
        require(isinstance(entry["verdictsObserved"], int) and not isinstance(entry["verdictsObserved"], bool) and entry["verdictsObserved"] >= 0, f"{label}.verdictsObserved must be a non-negative integer")
        verdicts_observed += entry["verdictsObserved"]
        if entry["currentWorkflowConfigured"]:
            configured_repositories.append(repository)
        first_in_window = observed_in_window(first)
        if first_in_window and entry["currentWorkflowConfigured"]:
            experiment_configured.append(repository)
            # Count only a real later observation inside the window. Clipping an
            # after-window timestamp to the deadline would invent retention.
            if observed_in_window(last) and last - first >= dt.timedelta(days=7):
                experiment_seven_day.append(repository)

        entry_receipts = entry["receiptHashes"]
        require(isinstance(entry_receipts, list), f"{label}.receiptHashes must be an array")
        require(len(entry_receipts) <= entry["verdictsObserved"], f"{label}.receiptHashes exceeds verdictsObserved")
        for receipt in entry_receipts:
            require(isinstance(receipt, str) and bool(RECEIPT_RE.fullmatch(receipt)), f"{label}.receiptHashes contains an invalid hash")
            require(receipt not in receipts, f"duplicate receipt hash: {receipt}")
            receipts.add(receipt)

        required_url = nullable_url(entry["requiredCheckEvidenceUrl"], f"{label}.requiredCheckEvidenceUrl", repository)
        required_observed_raw = entry.get("requiredCheckObservedAt")
        required_observed = (
            timestamp(required_observed_raw, f"{label}.requiredCheckObservedAt")
            if required_observed_raw is not None else None
        )
        retention_url = nullable_url(entry["retentionEvidenceUrl"], f"{label}.retentionEvidenceUrl", repository)
        if required_url is not None:
            require(entry["currentWorkflowConfigured"], f"{label} cannot claim a required check for a removed workflow")
            if required_observed is not None:
                require(first <= required_observed <= last, f"{label}.requiredCheckObservedAt is outside the observation window")
            required_repositories.append(repository)
            if first_in_window and required_observed is not None and observed_in_window(required_observed):
                experiment_required.append(repository)
        else:
            require(required_observed is None, f"{label}.requiredCheckObservedAt must be null without requiredCheckEvidenceUrl")
        if retention_url is not None:
            require(entry["currentWorkflowConfigured"], f"{label} cannot claim retention for a removed workflow")
            require((last - first).days >= 30, f"{label} retention evidence is less than 30 days after first observation")
            retained_repositories.append(repository)

        contradictions = entry["maintainerAcceptedContradictions"]
        require(isinstance(contradictions, list), f"{label}.maintainerAcceptedContradictions must be an array")
        for contradiction_index, raw_contradiction in enumerate(contradictions):
            contradiction_label = f"{label}.maintainerAcceptedContradictions[{contradiction_index}]"
            contradiction = exact_fields(raw_contradiction, CONTRADICTION_FIELDS, contradiction_label)
            receipt = contradiction["receiptHash"]
            require(isinstance(receipt, str) and bool(RECEIPT_RE.fullmatch(receipt)), f"{contradiction_label}.receiptHash is invalid")
            require(receipt in entry_receipts, f"{contradiction_label}.receiptHash is not retained in this entry")
            require(receipt not in contradiction_receipts, f"duplicate accepted contradiction: {receipt}")
            contradiction_receipts.add(receipt)
            github_repository_url(contradiction["evidenceUrl"], f"{contradiction_label}.evidenceUrl", repository)
            require(contradiction["disposition"] in CONTRADICTION_DISPOSITIONS, f"{contradiction_label}.disposition is invalid")
            accepted_at = timestamp(contradiction["acceptedAt"], f"{contradiction_label}.acceptedAt")
            require(first <= accepted_at <= last, f"{contradiction_label}.acceptedAt is outside the observation window")
            if first_in_window and observed_in_window(accepted_at):
                experiment_contradictions += 1

        reports = entry["falseVerdictReports"]
        require(isinstance(reports, list), f"{label}.falseVerdictReports must be an array")
        require(len(reports) <= entry["verdictsObserved"], f"{label}.falseVerdictReports exceeds verdictsObserved")
        for report_index, raw_report in enumerate(reports):
            report_label = f"{label}.falseVerdictReports[{report_index}]"
            report = exact_fields(raw_report, FALSE_VERDICT_FIELDS, report_label)
            github_repository_url(report["evidenceUrl"], f"{report_label}.evidenceUrl", repository)
            require(report["status"] in FALSE_VERDICT_STATUSES, f"{report_label}.status is invalid")
            reported_at = timestamp(report["reportedAt"], f"{report_label}.reportedAt")
            require(first <= reported_at <= last, f"{report_label}.reportedAt is outside the observation window")
            if report["status"] == "still-open":
                require(report["resolvedAt"] is None, f"{report_label}.resolvedAt must be null while open")
                unexplained_false_reports += 1
            else:
                resolved_at = timestamp(report["resolvedAt"], f"{report_label}.resolvedAt")
                require(resolved_at >= reported_at, f"{report_label}.resolvedAt precedes reportedAt")
            false_reports += 1

    unexplained_rate = (unexplained_false_reports / verdicts_observed) if verdicts_observed else None
    counts = {
        "externalRepositoriesConfigured": len(configured_repositories),
        "uniqueExternalReceiptHashes": len(receipts),
        "maintainersRetainedAfter30Days": len(retained_repositories),
        "maintainerAcceptedContradictions": len(contradiction_receipts),
        "externalRequiredChecks": len(required_repositories),
        "externalVerdictsObserved": verdicts_observed,
        "falseVerdictReports": false_reports,
        "unexplainedFalseVerdictReports": unexplained_false_reports,
        "unexplainedFalseVerdictRate": unexplained_rate,
    }
    gates = {
        "tenExternalRepositories": counts["externalRepositoriesConfigured"] >= 10,
        "oneThousandExternalReceipts": counts["uniqueExternalReceiptHashes"] >= 1000,
        "fiveMaintainersRetained30Days": counts["maintainersRetainedAfter30Days"] >= 5,
        "tenAcceptedContradictions": counts["maintainerAcceptedContradictions"] >= 10,
        "threeRequiredChecks": counts["externalRequiredChecks"] >= 3,
        "underOnePercentUnexplainedFalseVerdicts": unexplained_rate is not None and unexplained_rate < 0.01,
    }
    experiment_counts = {
        "externalRepositoriesConfigured": len(experiment_configured),
        "repositoriesWithSevenDayObservedSpan": len(experiment_seven_day),
        "maintainerAcceptedContradictions": experiment_contradictions,
        "externalRequiredChecks": len(experiment_required),
    }
    return {
        "schemaVersion": 1,
        "source": "consented public evidence only",
        "counts": counts,
        "gates": gates,
        "milestonePassed": all(gates.values()),
        "configuredRepositories": sorted(configured_repositories, key=str.lower),
        "retainedRepositories": sorted(retained_repositories, key=str.lower),
        "requiredCheckRepositories": sorted(required_repositories, key=str.lower),
        "experimentWindow": {
            "start": window_start.isoformat() if window_start is not None else None,
            "end": window_end.isoformat() if window_end is not None else None,
            "inclusive": window_start is not None,
        },
        "experimentCounts": experiment_counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger", type=Path, default=Path("proof/adoption/ledger.json"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--window-start")
    parser.add_argument("--window-end")
    args = parser.parse_args()
    try:
        require(bool(args.window_start) == bool(args.window_end), "--window-start and --window-end must be provided together")
        window_start = calendar_date(args.window_start, "--window-start") if args.window_start else None
        window_end = calendar_date(args.window_end, "--window-end") if args.window_end else None
        require(window_start is None or window_end >= window_start, "--window-end must not precede --window-start")
        source = json.loads(args.ledger.read_text())
        result = validate(source, window_start, window_end)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise SystemExit(f"adoption evidence: FAIL: {error}") from error
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
