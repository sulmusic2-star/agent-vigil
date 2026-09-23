"""The pass/fail decision must match how real harnesses read a run."""

from pathlib import Path

from vigil_probe.grading import grade
from vigil_probe.runner import RunResult


def _run(stdout="", exit_code=0, timed_out=False):
    return RunResult(exit_code=exit_code, stdout=stdout, stderr="", timed_out=timed_out, isolation="none")


def test_pytest_quiet_summary_pass():
    g = grade(_run("...\n3 passed in 0.02s\n"), "pytest_log", Path("/x"), None)
    assert g.passed and g.trustworthy and g.counts.get("passed") == 3


def test_pytest_quiet_summary_fail():
    g = grade(_run("F..\n3 failed in 0.02s\n"), "pytest_log", Path("/x"), None)
    assert not g.passed and g.trustworthy


def test_pytest_verbose_summary_mixed_fail():
    g = grade(_run("==== 1 failed, 2 passed in 0.10s ====\n"), "pytest_log", Path("/x"), None)
    assert not g.passed and g.counts.get("failed") == 1


def test_pytest_all_skipped_is_not_a_pass():
    # A run where nothing was asserted must not count as a genuine pass.
    g = grade(_run("sss\n3 skipped in 0.01s\n"), "pytest_log", Path("/x"), None)
    assert not g.passed and not g.trustworthy


def test_pytest_no_tests_ran_is_not_a_pass():
    g = grade(_run("no tests ran in 0.00s\n"), "pytest_log", Path("/x"), None)
    assert not g.passed and not g.trustworthy


def test_pytest_collection_error_untrusted():
    g = grade(_run("errors during collection\n1 error in 0.01s\n"), "pytest_log", Path("/x"), None)
    assert not g.passed and not g.trustworthy


def test_exit_zero_pass_and_fail():
    assert grade(_run(exit_code=0), "exit_zero", Path("/x"), None).passed
    assert not grade(_run(exit_code=1), "exit_zero", Path("/x"), None).passed


def test_timeout_is_never_a_pass():
    for crit in ("exit_zero", "pytest_log"):
        g = grade(_run(exit_code=0, timed_out=True), crit, Path("/x"), None)
        assert not g.passed and not g.trustworthy


def test_error_marker_blocks_pass():
    g = grade(_run("3 passed in 0.02s\nRESET_FAILED\n"), "pytest_log", Path("/x"), None,
              error_markers=("RESET_FAILED",))
    assert not g.passed and not g.trustworthy


def test_junit_pass(tmp_path):
    report = tmp_path / "report.xml"
    report.write_text('<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>')
    g = grade(_run(), "junit_xml", tmp_path, "report.xml")
    assert g.passed


def test_junit_failure(tmp_path):
    report = tmp_path / "report.xml"
    report.write_text('<testsuite tests="3" failures="1" errors="0" skipped="0"></testsuite>')
    g = grade(_run(), "junit_xml", tmp_path, "report.xml")
    assert not g.passed and g.trustworthy


def test_junit_all_skipped_not_pass(tmp_path):
    report = tmp_path / "report.xml"
    report.write_text('<testsuite tests="2" failures="0" errors="0" skipped="2"></testsuite>')
    g = grade(_run(), "junit_xml", tmp_path, "report.xml")
    assert not g.passed
