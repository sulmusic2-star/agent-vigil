"""Spec loading, validation, and the top-level/[grader] key rules."""

import json

import pytest

from vigil_probe.spec import SpecError, load_spec


def _write(tmp_path, text, name="spec.toml"):
    (tmp_path / "workspace").mkdir(exist_ok=True)
    p = tmp_path / name
    p.write_text(text)
    return p


def test_minimal_toml_spec(tmp_path):
    spec = load_spec(_write(tmp_path, """
id = "t1"
name = "Task one"
workspace = "./workspace"

[grader]
command = "python -m pytest -q"
pass_criterion = "exit_zero"
"""))
    assert spec.id == "t1" and spec.grader.pass_criterion == "exit_zero"
    assert spec.topology == "same_sandbox"


def test_json_spec(tmp_path):
    spec = load_spec(_write(tmp_path, json.dumps({
        "id": "t2", "workspace": "./workspace",
        "grader": {"command": "true", "pass_criterion": "exit_zero"},
    }), name="spec.json"))
    assert spec.id == "t2"


def test_keys_accepted_at_either_level(tmp_path):
    spec = load_spec(_write(tmp_path, """
id = "t3"
workspace = "./workspace"

[grader]
command = "python -m pytest -q"
pass_criterion = "pytest_log"
reset_paths = ["tests/**"]
"""))
    assert spec.reset_paths == ("tests/**",)


def test_conflicting_key_is_error(tmp_path):
    with pytest.raises(SpecError):
        load_spec(_write(tmp_path, """
id = "t4"
workspace = "./workspace"
reset_paths = ["a/**"]

[grader]
command = "true"
pass_criterion = "exit_zero"
reset_paths = ["b/**"]
"""))


def test_bad_pass_criterion_rejected(tmp_path):
    with pytest.raises(SpecError):
        load_spec(_write(tmp_path, """
id = "t5"
workspace = "./workspace"

[grader]
command = "true"
pass_criterion = "vibes"
"""))


def test_missing_grader_table_rejected(tmp_path):
    with pytest.raises(SpecError):
        load_spec(_write(tmp_path, 'id = "t6"\nworkspace = "./workspace"\n'))


def test_junit_requires_path(tmp_path):
    with pytest.raises(SpecError):
        load_spec(_write(tmp_path, """
id = "t7"
workspace = "./workspace"

[grader]
command = "true"
pass_criterion = "junit_xml"
"""))


def test_missing_workspace_dir_rejected(tmp_path):
    p = tmp_path / "spec.toml"
    p.write_text('id = "t8"\nworkspace = "./nope"\n\n[grader]\ncommand = "true"\npass_criterion = "exit_zero"\n')
    with pytest.raises(SpecError):
        load_spec(p)
