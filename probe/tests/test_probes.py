"""Every probe must be well-formed: unique id, remediation, and a source."""

from vigil_probe.probes import catalog


def test_ids_unique():
    ids = [p.id for p in catalog(("run_tests.sh",))]
    assert len(ids) == len(set(ids))


def test_every_probe_has_remediation_and_source():
    for p in catalog(("run_tests.sh",)):
        assert p.remediation.strip(), f"{p.id} missing remediation"
        assert p.sources, f"{p.id} missing sources"
        assert p.severity in {"critical", "high", "medium"}


def test_grader_overwrite_only_with_grader_paths():
    without = {p.id for p in catalog(())}
    with_paths = {p.id for p in catalog(("run_tests.sh",))}
    assert "grader-script-overwrite" not in without
    assert "grader-script-overwrite" in with_paths


def test_control_probe_present_and_inverted():
    ids = [p.id for p in catalog(())]
    assert ids[0] == "control-empty"
