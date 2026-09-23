"""Decide whether a grader run reported a pass.

vigil-probe reproduces the pass/fail decision the way common harnesses make it,
so that "the grader accepted this" means what an environment builder thinks it
means. Three criteria are supported today:

* ``exit_zero`` — the grader's exit status is the verdict (0 == pass). Used by
  simple ``make test`` / script graders.
* ``pytest_log`` — the verdict is parsed from pytest's own output, the way the
  SWE-bench harness reads ``PASSED``/``FAILED`` lines and the summary line. A
  run with zero collected tests is *not* a pass.
* ``junit_xml`` — the verdict is read from a JUnit XML report's tallies.

Every grade carries a ``trustworthy`` flag. A run that timed out, hit an error
marker, failed collection, or ran no tests is not trustworthy and is never
counted as a genuine pass — reporting it as a pass would itself be a grader bug.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from .runner import RunResult

# pytest's final status line, in both quiet ("3 failed in 0.02s") and verbose
# ("==== 1 failed, 2 passed, 1 skipped in 0.10s ====") forms. The leading/
# trailing "=" bars are optional so -q output is matched too.
_PYTEST_FINAL = re.compile(
    r"^=*\s*(?P<body>(?:\d+\s+[A-Za-z]+(?:,\s*)?)+?)\s+in\s+[\d.]+s",
    re.MULTILINE,
)
_PYTEST_NOTESTS = re.compile(r"^=*\s*no tests ran\b", re.MULTILINE)
_PYTEST_COUNT = re.compile(r"(\d+)\s+(passed|failed|error|errors|skipped|xfailed|xpassed|deselected)")
_COLLECT_ERROR = re.compile(r"errors during collection|INTERNALERROR|ERROR collecting", re.IGNORECASE)


@dataclass(frozen=True)
class Grade:
    passed: bool
    trustworthy: bool
    reason: str
    counts: dict[str, int]


def _grade_exit_zero(run: RunResult) -> Grade:
    if run.timed_out:
        return Grade(False, False, "grader timed out", {})
    passed = run.exit_code == 0
    return Grade(passed, True, f"exit code {run.exit_code}", {})


def _parse_pytest_counts(log: str) -> dict[str, int]:
    match = None
    for match in _PYTEST_FINAL.finditer(log):
        pass  # keep the last status line, which is pytest's final tally
    counts: dict[str, int] = {}
    if match:
        for number, label in _PYTEST_COUNT.findall(match.group("body")):
            key = "error" if label == "errors" else label
            counts[key] = counts.get(key, 0) + int(number)
    return counts


def _grade_pytest_log(run: RunResult) -> Grade:
    log = run.combined
    if run.timed_out:
        return Grade(False, False, "grader timed out", {})
    if _COLLECT_ERROR.search(log):
        return Grade(False, False, "pytest reported a collection or internal error", {})
    counts = _parse_pytest_counts(log)
    if not counts or ("passed" not in counts and "failed" not in counts and "error" not in counts):
        if _PYTEST_NOTESTS.search(log):
            return Grade(False, False, "no tests ran", counts)
        return Grade(False, False, "no pytest summary found in output", counts)
    failed = counts.get("failed", 0) + counts.get("error", 0)
    passed_n = counts.get("passed", 0)
    if failed > 0:
        return Grade(False, True, f"{failed} failing test(s) in the summary", counts)
    if passed_n == 0:
        # Only skips/deselects: nothing actually asserted, so not a genuine pass.
        return Grade(False, False, "summary contained no passed tests (only skips/deselects)", counts)
    return Grade(True, True, f"{passed_n} passed, 0 failed", counts)


def _grade_junit(run: RunResult, junit_path: Path) -> Grade:
    if run.timed_out:
        return Grade(False, False, "grader timed out", {})
    if not junit_path.is_file():
        return Grade(False, False, f"JUnit report not produced at {junit_path}", {})
    try:
        root = ET.parse(junit_path).getroot()
    except ET.ParseError as exc:
        return Grade(False, False, f"JUnit report is not valid XML: {exc}", {})
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    tests = failures = errors = skipped = 0
    for suite in suites:
        tests += int(suite.get("tests", 0))
        failures += int(suite.get("failures", 0))
        errors += int(suite.get("errors", 0))
        skipped += int(suite.get("skipped", 0))
    counts = {"tests": tests, "failures": failures, "errors": errors, "skipped": skipped}
    if tests == 0:
        return Grade(False, False, "JUnit report contained no tests", counts)
    if failures + errors > 0:
        return Grade(False, True, f"{failures + errors} failing test(s) in JUnit report", counts)
    if tests - skipped <= 0:
        return Grade(False, False, "JUnit report contained only skipped tests", counts)
    return Grade(True, True, f"{tests - skipped} passed, 0 failed", counts)


def grade(run: RunResult, pass_criterion: str, workspace_root: Path, junit_rel: str | None,
          error_markers: tuple[str, ...] = ()) -> Grade:
    """Return the pass/fail decision for a grader run."""

    for marker in error_markers:
        if marker and marker in run.combined:
            return Grade(False, False, f"grader emitted error marker: {marker!r}", {})
    if pass_criterion == "exit_zero":
        return _grade_exit_zero(run)
    if pass_criterion == "pytest_log":
        return _grade_pytest_log(run)
    if pass_criterion == "junit_xml":
        junit_path = (workspace_root / (junit_rel or "report.xml")).resolve()
        return _grade_junit(run, junit_path)
    return Grade(False, False, f"unknown pass_criterion {pass_criterion!r}", {})
