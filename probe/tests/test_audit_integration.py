"""End-to-end audits of the bundled demo environments.

These run the real grader (pytest in a subprocess), so they need Python + pytest
available. They assert the whole point of the tool: the weak graders are caught,
the hardened one is clean, and the specific findings match the known holes.
"""

import shutil
from pathlib import Path

import pytest

from vigil_probe.audit import audit
from vigil_probe.report import to_json, to_markdown, to_text
from vigil_probe.spec import load_spec

DEMOS = Path(__file__).resolve().parents[1] / "src" / "vigil_probe" / "demo_environments"

pytestmark = pytest.mark.skipif(shutil.which("python") is None, reason="python not on PATH")


def _audit(name, tmp_path):
    spec = load_spec(DEMOS / name / "spec.toml")
    return audit(spec, tmp_path / "work")


def test_vulnerable_exitcode_is_hackable(tmp_path):
    result = _audit("vulnerable_exitcode", tmp_path)
    assert result.verdict == "HACKABLE"
    found = {o.probe.id for o in result.findings}
    assert {"report-forgery-conftest", "early-exit-zero", "skip-all-tests"} <= found


def test_swebench_log_conftest_survives_test_reset(tmp_path):
    result = _audit("swebench_log", tmp_path)
    assert result.verdict == "HACKABLE"
    found = {o.probe.id for o in result.findings}
    # Tests are reset, so deletion/skip are defended; the conftest hook is not.
    assert "report-forgery-conftest" in found
    assert "delete-tests" not in found


def test_hardened_is_robust_and_passes_reference(tmp_path):
    result = _audit("hardened", tmp_path)
    assert result.verdict == "ROBUST"
    assert result.findings == []
    assert result.reference_ok is True


def test_control_probe_not_a_finding_on_real_unsolved_task(tmp_path):
    # The unsolved task genuinely fails, so the control probe must stay quiet.
    result = _audit("vulnerable_exitcode", tmp_path)
    control = next(o for o in result.outcomes if o.probe.id == "control-empty")
    assert control.is_finding is False


def test_reports_render(tmp_path):
    result = _audit("swebench_log", tmp_path)
    import json
    payload = json.loads(to_json(result))
    assert payload["verdict"] == "HACKABLE"
    assert payload["grader_topology"] == "same_sandbox"
    assert "HACKABLE" in to_text(result)
    assert "report-forgery-conftest" in to_markdown(result)
