#!/usr/bin/env python3
"""Validate consented Agent Vigil adoption evidence and calculate proof gates."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
RECEIPT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
EXCLUDED_OWNERS = {"sulmusic2-star"}
ENTRY_FIELDS = {
    "repository", "ownerConsentUrl", "workflowUrl", "latestRunUrl",
    "firstObservedAt", "lastObservedAt", "currentWorkflowConfigured",
    "verdictsObserved", "receiptHashes", "requiredCheckEvidenceUrl",
    "retentionEvidenceUrl", "maintainerAcceptedContradictions",
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


def https_url(value: Any, label: str, *, github: bool = False) -> str:
    require(isinstance(value, str), f"{label} must be an HTTPS URL")
    parsed = urlparse(value)
    require(parsed.scheme == "https" and bool(parsed.netloc), f"{label} must be an HTTPS URL")
    if github:
        require(parsed.netloc.lower() == "github.com", f"{label} must be a github.com URL")
    return value


def nullable_url(value: Any, label: str) -> str | None:
    if value is None:
        return None
    return https_url(value, label, github=True)


def exact_fields(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be an object")
    missing = fields - set(value)
    extra = set(value) - fields
    require(not missing, f"{label} is missing: {', '.join(sorted(missing))}")
    require(not extra, f"{label} has unknown fields: {', '.join(sorted(extra))}")
    return value


def validate(ledger: dict[str, Any]) -> dict[str, Any]:
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

    for index, raw_entry in enumerate(ledger["entries"]):
        label = f"entries[{index}]"
        entry = exact_fields(raw_entry, ENTRY_FIELDS, label)
        repository = entry["repository"]
        require(isinstance(repository, str) and bool(REPOSITORY_RE.fullmatch(repository)), f"{label}.repository is invalid")
        owner, name = repository.split("/", 1)
        require(owner.lower() not in EXCLUDED_OWNERS, f"{label}.repository is first-party and cannot count")
        require(repository.lower() not in repositories, f"duplicate repository: {repository}")
        repositories.add(repository.lower())

        consent = https_url(entry["ownerConsentUrl"], f"{label}.ownerConsentUrl", github=True)
        workflow = https_url(entry["workflowUrl"], f"{label}.workflowUrl", github=True)
        latest_run = https_url(entry["latestRunUrl"], f"{label}.latestRunUrl", github=True)
        repo_prefix = f"/{owner.lower()}/{name.lower()}/"
        for value, field in ((consent, "ownerConsentUrl"), (workflow, "workflowUrl"), (latest_run, "latestRunUrl")):
            require(repo_prefix in urlparse(value).path.lower(), f"{label}.{field} must refer to {repository}")

        first = timestamp(entry["firstObservedAt"], f"{label}.firstObservedAt")
        last = timestamp(entry["lastObservedAt"], f"{label}.lastObservedAt")
        require(last >= first, f"{label}.lastObservedAt precedes firstObservedAt")
        require(isinstance(entry["currentWorkflowConfigured"], bool), f"{label}.currentWorkflowConfigured must be boolean")
        require(isinstance(entry["verdictsObserved"], int) and not isinstance(entry["verdictsObserved"], bool) and entry["verdictsObserved"] >= 0, f"{label}.verdictsObserved must be a non-negative integer")
        verdicts_observed += entry["verdictsObserved"]
        if entry["currentWorkflowConfigured"]:
            configured_repositories.append(repository)

        entry_receipts = entry["receiptHashes"]
        require(isinstance(entry_receipts, list), f"{label}.receiptHashes must be an array")
        require(len(entry_receipts) <= entry["verdictsObserved"], f"{label}.receiptHashes exceeds verdictsObserved")
        for receipt in entry_receipts:
            require(isinstance(receipt, str) and bool(RECEIPT_RE.fullmatch(receipt)), f"{label}.receiptHashes contains an invalid hash")
            require(receipt not in receipts, f"duplicate receipt hash: {receipt}")
            receipts.add(receipt)

        required_url = nullable_url(entry["requiredCheckEvidenceUrl"], f"{label}.requiredCheckEvidenceUrl")
        retention_url = nullable_url(entry["retentionEvidenceUrl"], f"{label}.retentionEvidenceUrl")
        if required_url is not None:
            require(repo_prefix in urlparse(required_url).path.lower(), f"{label}.requiredCheckEvidenceUrl must refer to {repository}")
            require(entry["currentWorkflowConfigured"], f"{label} cannot claim a required check for a removed workflow")
            required_repositories.append(repository)
        if retention_url is not None:
            require(repo_prefix in urlparse(retention_url).path.lower(), f"{label}.retentionEvidenceUrl must refer to {repository}")
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
            contradiction_url = https_url(contradiction["evidenceUrl"], f"{contradiction_label}.evidenceUrl", github=True)
            require(repo_prefix in urlparse(contradiction_url).path.lower(), f"{contradiction_label}.evidenceUrl must refer to {repository}")
            require(contradiction["disposition"] in CONTRADICTION_DISPOSITIONS, f"{contradiction_label}.disposition is invalid")
            accepted_at = timestamp(contradiction["acceptedAt"], f"{contradiction_label}.acceptedAt")
            require(first <= accepted_at <= last, f"{contradiction_label}.acceptedAt is outside the observation window")

        reports = entry["falseVerdictReports"]
        require(isinstance(reports, list), f"{label}.falseVerdictReports must be an array")
        require(len(reports) <= entry["verdictsObserved"], f"{label}.falseVerdictReports exceeds verdictsObserved")
        for report_index, raw_report in enumerate(reports):
            report_label = f"{label}.falseVerdictReports[{report_index}]"
            report = exact_fields(raw_report, FALSE_VERDICT_FIELDS, report_label)
            report_url = https_url(report["evidenceUrl"], f"{report_label}.evidenceUrl", github=True)
            require(repo_prefix in urlparse(report_url).path.lower(), f"{report_label}.evidenceUrl must refer to {repository}")
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
    return {
        "schemaVersion": 1,
        "source": "consented public evidence only",
        "counts": counts,
        "gates": gates,
        "milestonePassed": all(gates.values()),
        "configuredRepositories": sorted(configured_repositories, key=str.lower),
        "retainedRepositories": sorted(retained_repositories, key=str.lower),
        "requiredCheckRepositories": sorted(required_repositories, key=str.lower),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger", type=Path, default=Path("proof/adoption/ledger.json"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        source = json.loads(args.ledger.read_text())
        result = validate(source)
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
